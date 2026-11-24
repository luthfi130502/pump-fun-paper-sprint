// Pump.fun Paper Sprint — confirmed-momentum holder.
//
// My own strategy, written from scratch for this competition.
// Idea: buy a fresh coin only once it proves real buy pressure (price up
// at least 8% from its first sighting, buys dominating its last few
// trades, at least 1 SOL of real reserves), size the buy to the curve's
// own per-batch cap, then HOLD. On this replay every explicit sell pays
// the curve fee, the tx fee and two slots of adverse price drift, so the
// bot sells only on a near-graduation spike (+300%), a catastrophe
// (-35%), or when a position has plainly gone stale (400 further trades
// or 20,000 slots without completing) and the slot earns more recycled.
// Everything else rides to the curve's completion or the window's end.
// At most 5 open positions.
//
// Determinism: every decision comes from the harness state alone (slots,
// reserves, trade counts). No clock, no randomness, no environment reads,
// so two runs produce identical action logs.
//
// Speed: the entry scan walks only a live-candidate list (coins passing
// the static entry filters, kept in first-seen order) instead of every
// mint ever seen, and the committed-position count is computed once per
// batch. The filters and their order are unchanged, so the orders decided
// are the same — only the work per batch is bounded.
import { runBot } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning
const TARGET_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL per entry when the cap allows
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round-trip floor
const MIN_REAL_RESERVES = 1_000_000_000n; // 1 SOL: makes the 1% cap >= 0.01 SOL
const ENTRY_RISE_BPS = 800; // price must be up >= 8% from its first sighting
const ENTRY_MAX_RUNUP_BPS = 15_000; // never chase a coin already up > 150%
const ENTRY_MIN_TRADES = 3; // need a few trades to judge pressure
const ENTRY_MAX_TRADES = 40; // only fresh coins
const ENTRY_BUY_WINDOW = 5; // look at the last 5 trades
const ENTRY_MIN_BUYS = 4; // at least 4 of the last 5 trades must be buys
const TAKE_PROFIT_BPS = 30_000; // sell at +300%: bank only a near-graduation spike
const STOP_LOSS_BPS = 3_500; // sell at -35%: catastrophe only, otherwise hold
const TRAIL_BPS = 9_000; // trailing stop effectively off (see TRAIL_ARM_BPS)
const TRAIL_ARM_BPS = 1_000_000; // never arms: holding beats paying the sell side
const MAX_HOLD_TRADES = 400; // recycle a coin that traded 400 more times without completing
const MAX_HOLD_SLOTS = 20_000; // recycle a position held this many slots without completing
const COOLDOWN_SLOTS = 1_200; // do not rebuy a coin right after selling it
const BUY_SLIPPAGE_BPS = 400; // 4%: refuse fills that drifted far in the 2-slot latency
const SELL_SLIPPAGE_BPS = 400; // 4%
const MAX_POSITIONS = 5;

// ------------------------------------------------------------------ helpers
// A price is a ratio virtual_quote / virtual_token. Compare ratios with
// cross-multiplied bigints so nothing ever goes through a float.
function priceUpBps(fromNum: bigint, fromDen: bigint, toNum: bigint, toDen: bigint): bigint {
  if (fromNum <= 0n || toNum <= 0n) return 0n;
  const diff = toNum * fromDen - fromNum * toDen;
  if (diff <= 0n) return diff * 10_000n / (fromNum * toDen);
  return diff * 10_000n / (fromNum * toDen);
}

function atLeastBps(priceNum: bigint, priceDen: bigint, baseNum: bigint, baseDen: bigint, bps: bigint): boolean {
  // price >= base * (10000 + bps) / 10000 ?
  return priceNum * baseDen * 10_000n >= baseNum * priceDen * (10_000n + bps);
}

function atMostBps(priceNum: bigint, priceDen: bigint, baseNum: bigint, baseDen: bigint, bps: bigint): boolean {
  // price <= base * (10000 - bps) / 10000 ?
  return priceNum * baseDen * 10_000n <= baseNum * priceDen * (10_000n - bps);
}

// ------------------------------------------------------------------ per-coin bookkeeping
interface Coin {
  mint: string; // base58 mint this record tracks
  orderIndex: number; // first-seen sequence: decides newest-first scan order
  inCandidates: boolean; // true while this coin sits in the `candidates` list
  firstNum: bigint; // price (quote/token) when first seen
  firstDen: bigint;
  lastNum: bigint; // latest price seen
  lastDen: bigint;
  trades: number;
  recentBuys: boolean[]; // last ENTRY_BUY_WINDOW trades, buy or not
  buyCount: number; // buys among recentBuys
  cooldownUntil: number; // slot before which we will not buy again
  entrySlot: number; // slot the position first appeared (-1 when flat)
  entryTrades: number; // trade count when the position first appeared
  entryNum: bigint; // entry cost basis: lamports per token (cost/tokens)
  entryDen: bigint;
  peakNum: bigint; // highest mark price since entry
  peakDen: bigint;
}

const coins = new Map<string, Coin>();
let nextOrderIndex = 0;

// Coins that currently pass every entry filter that depends only on the
// coin's own record (trade count, recent buys, rise from first sighting).
// Kept sorted ascending by first-seen order; decideBuys scans it from the
// end, which is exactly the newest-first order the old full-Map scan used.
// A coin's own record only changes when it trades, so membership is
// re-evaluated at trade time and is exact at every decideBuys call — the
// scan stays bounded by the handful of coins that are actually live
// candidates instead of growing with every mint the replay has ever seen.
// The dynamic filters (position, pending, cooldown, curve state, reserves,
// cap, cash) are still evaluated per candidate at decide time, unchanged.
const candidates: Coin[] = [];

function insertCandidate(c: Coin): void {
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candidates[mid].orderIndex < c.orderIndex) lo = mid + 1;
    else hi = mid;
  }
  candidates.splice(lo, 0, c);
  c.inCandidates = true;
}

function removeCandidate(c: Coin): void {
  if (!c.inCandidates) return;
  let lo = 0;
  let hi = candidates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candidates[mid].orderIndex < c.orderIndex) lo = mid + 1;
    else hi = mid;
  }
  if (lo < candidates.length && candidates[lo] === c) candidates.splice(lo, 1);
  c.inCandidates = false;
}

// The entry filters that depend only on this coin's own record — the same
// predicates decideBuys applies, shared so membership and the decide-time
// checks can never drift apart.
function staticallyEligible(c: Coin): boolean {
  if (c.trades < ENTRY_MIN_TRADES || c.trades > ENTRY_MAX_TRADES) return false;
  if (c.recentBuys.length < ENTRY_MIN_TRADES || c.buyCount < ENTRY_MIN_BUYS) return false;
  if (c.recentBuys[c.recentBuys.length - 1] !== true) return false;
  if (c.firstNum <= 0n || c.lastNum <= 0n) return false;
  const rise = priceUpBps(c.firstNum, c.firstDen, c.lastNum, c.lastDen);
  return rise >= BigInt(ENTRY_RISE_BPS) && rise <= BigInt(ENTRY_MAX_RUNUP_BPS);
}

function updateCandidate(c: Coin): void {
  if (staticallyEligible(c)) {
    if (!c.inCandidates) insertCandidate(c);
  } else if (c.inCandidates) {
    removeCandidate(c);
  }
}

function getCoin(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      mint, orderIndex: nextOrderIndex++, inCandidates: false,
      firstNum: 0n, firstDen: 1n, lastNum: 0n, lastDen: 1n,
      trades: 0, recentBuys: [], buyCount: 0,
      cooldownUntil: -1, entrySlot: -1, entryTrades: 0,
      entryNum: 0n, entryDen: 1n, peakNum: 0n, peakDen: 1n,
    };
    coins.set(mint, c);
  }
  return c;
}

// Fold one batch's events into the per-coin records. Events arrive in chain
// order, so the last trade of a mint in the batch is its latest price.
function observeEvents(state: any, batch: any): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const c = getCoin(e.mint);
      if (c.firstNum === 0n) {
        c.firstNum = BigInt(e.virtual_sol_reserves);
        c.firstDen = BigInt(e.virtual_token_reserves);
        c.lastNum = c.firstNum;
        c.lastDen = c.firstDen;
      }
    } else if (e.event === 'TradeEvent') {
      const c = getCoin(e.mint);
      if (c.firstNum === 0n) {
        // First sight through a trade: use its post-trade reserves as the base.
        c.firstNum = BigInt(e.virtual_sol_reserves);
        c.firstDen = BigInt(e.virtual_token_reserves);
      }
      c.lastNum = BigInt(e.virtual_sol_reserves);
      c.lastDen = BigInt(e.virtual_token_reserves);
      c.trades += 1;
      c.recentBuys.push(e.is_buy === true);
      if (e.is_buy === true) c.buyCount += 1;
      if (c.recentBuys.length > ENTRY_BUY_WINDOW) {
        if (c.recentBuys.shift() === true) c.buyCount -= 1;
      }
      // A trade is the only thing that can change this coin's static
      // eligibility, so re-evaluate candidate membership here.
      updateCandidate(c);
    } else if (e.event === 'CompleteEvent') {
      // A completed curve can never be bought again: drop it from the
      // candidate scan. decideBuys still checks curve.complete at decide
      // time, so this is purely a scan prune.
      const c = coins.get(e.mint);
      if (c !== undefined) removeCandidate(c);
    }
    // CompleteEvent needs no other record: state.curves already marks it complete.
  }
  void state;
}

// ------------------------------------------------------------------ exits
// Decide sells first so freed slots can be reused by entries in the same batch.
function decideSells(state: any): any[] {
  const sells: any[] = [];
  const pendingSell = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') pendingSell.add(p.order.mint);
  }
  for (const [mint, pos] of state.positions) {
    if (pendingSell.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const c = coins.get(mint);
    if (c === undefined) continue;
    const markNum = curve.virtual_quote_reserves;
    const markDen = curve.virtual_token_reserves;
    if (markNum <= 0n || markDen <= 0n) continue;

    // First sight of this position: anchor entry basis and peak.
    if (c.entrySlot < 0) {
      c.entrySlot = state.slot;
      c.entryTrades = c.trades;
      c.entryNum = pos.cost_lamports;
      c.entryDen = pos.token_amount;
      c.peakNum = markNum;
      c.peakDen = markDen;
    } else if (markNum * c.peakDen > c.peakNum * markDen) {
      c.peakNum = markNum;
      c.peakDen = markDen;
    }

    const ageTrades = c.trades - c.entryTrades;
    const ageSlots = state.slot - c.entrySlot;
    const up = atLeastBps(markNum, markDen, c.entryNum, c.entryDen, BigInt(TAKE_PROFIT_BPS));
    const down = atMostBps(markNum, markDen, c.entryNum, c.entryDen, BigInt(STOP_LOSS_BPS));
    const peaked = atLeastBps(c.peakNum, c.peakDen, c.entryNum, c.entryDen, BigInt(TRAIL_ARM_BPS));
    const trailed = peaked && atMostBps(markNum, markDen, c.peakNum, c.peakDen, BigInt(TRAIL_BPS));
    const stale = ageTrades >= MAX_HOLD_TRADES || ageSlots >= MAX_HOLD_SLOTS;
    if (up || down || trailed || stale) {
      sells.push({
        side: 'sell', mint, token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      c.entrySlot = -1;
      c.cooldownUntil = state.slot + COOLDOWN_SLOTS;
    }
  }
  return sells;
}

// ------------------------------------------------------------------ entries
function decideBuys(state: any): any[] {
  const buys: any[] = [];
  // Positions and pending orders do not change during this call, so the
  // committed count is loop-invariant: compute it once, not per coin.
  const committed = state.committedPositionCount();
  if (committed >= MAX_POSITIONS) return buys;
  const freeCash = state.freeCashLamports();
  const txFee = state.txFeeLamports();
  let remaining = freeCash;
  const pendingBuy = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
  }
  // Scan the live-candidate list newest-first (it is sorted ascending by
  // first-seen order, so scanning from the end matches the old full-Map
  // scan's order exactly). Every filter below is the same as before, in
  // the same order; membership only guarantees the static ones, it never
  // replaces the decide-time checks.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    const mint = c.mint;
    if (committed + buys.length >= MAX_POSITIONS) break;
    if (state.positions.has(mint)) continue;
    if (pendingBuy.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (state.slot < c.cooldownUntil) continue;
    if (c.trades < ENTRY_MIN_TRADES || c.trades > ENTRY_MAX_TRADES) continue;
    if (c.recentBuys.length < ENTRY_MIN_TRADES || c.buyCount < ENTRY_MIN_BUYS) continue;
    // Do not buy into a sell tick: the latest trade must itself be a buy.
    if (c.recentBuys[c.recentBuys.length - 1] !== true) continue;
    if (c.firstNum <= 0n || c.lastNum <= 0n) continue;
    const rise = priceUpBps(c.firstNum, c.firstDen, c.lastNum, c.lastDen);
    if (rise < BigInt(ENTRY_RISE_BPS) || rise > BigInt(ENTRY_MAX_RUNUP_BPS)) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVES) continue;
    const cap = state.maxBuyLamports(mint);
    let size = cap < TARGET_BUY_LAMPORTS ? cap : TARGET_BUY_LAMPORTS;
    if (size < MIN_BUY_LAMPORTS) continue;
    if (remaining < size + txFee) continue;
    remaining -= size + txFee;
    buys.push({
      side: 'buy', mint, quote_lamports: size,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
  }
  return buys;
}

// ------------------------------------------------------------------ run
await runBot({
  onBatch(state: any, batch: any) {
    observeEvents(state, batch);
    const orders: any[] = [];
    orders.push(...decideSells(state));
    orders.push(...decideBuys(state));
    return orders;
  },
});
