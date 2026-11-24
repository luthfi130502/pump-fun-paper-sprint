# Pump.fun Paper Sprint — Confirmed-Momentum Holder

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/luthfi130502/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/luthfi130502/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

An entry for the make.fun bounty
[Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b):
a paper-trading bot for the `agent-fun/replay/v2` harness, replayed on
6 hours of pump.fun market data and ranked by net PnL.

## The strategy

`main.ts` is a confirmed-momentum holder:

- **Entries.** A fresh coin (at most 40 trades old) becomes a candidate
  once its price is up at least 8% from its first sighting, at least 4 of
  its last 5 trades are buys, the latest trade is itself a buy, and the
  curve holds at least 1 SOL of real reserves. The buy is sized to the
  harness's own per-batch cap (1% of real reserves), targeting 0.05 SOL
  and never below the 0.01 SOL guardrail floor. At most 5 open positions.
- **Exits.** Holding is the default: on this replay an explicit sell pays
  the curve fee, the transaction fee and two slots of adverse price
  drift, so the bot sells only on a near-graduation spike (+300% over
  cost), a catastrophe (−35%), or when a position has gone stale — 400
  further trades or 20,000 slots without its curve completing — so the
  slot can be recycled into a fresher coin. Everything else rides to the
  curve's completion or the end of the window.
- **Determinism.** Every decision derives from harness state alone
  (slots, reserves, trade counts): no clock, no randomness, no
  environment or network reads, so the two grading executions produce
  identical action logs.

## Run it

Requires Node 22.18 or later (the grader runs the entry as
`node /bot/main.ts`; the TypeScript runs as-is). The bot speaks the
replay protocol on stdin/stdout through the vendored SDK shim in
`vendor/makefun-bot.ts` (copied from the competition kit's
`sdk/ts/makefun-bot.ts`, as the kit instructs).

## Grade it locally

With the competition kit unpacked beside this repository:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver docker
```

(On a machine without Docker, `--driver process` runs the same bot
unisolated.) The grade prints the dev window's net PnL, fills, drawdown
and whether the guardrails are met: a round trip of at least 0.01 SOL on
at least 20 coins, and a maximum drawdown of 50% or less.

## License

MIT — see [LICENSE](LICENSE).
