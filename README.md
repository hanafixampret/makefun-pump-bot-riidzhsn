# Tide Runner

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hanafixampret/makefun-pump-bot-riidzhsn/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hanafixampret/makefun-pump-bot-riidzhsn/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Momentum-breakout paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun.

## Strategy

- **Entry:** fresh coins (age ≤ 900 slots) already running hot — price ≥ 5x first-seen, ≥ 60% buy-side volume, ≥ 50 SOL real reserves, ≥ 5 trades. One fixed 0.40 SOL ticket per coin, max 5 open positions.
- **Exits:** sell half at +25%, let the rest ride the trailing stop (arms at +50%, sells on a 12% pullback from peak); hard stop at −15%; sell when a coin stops trading for 1,200 slots; no re-entry for 300 slots after a full exit.
- **Determinism:** every decision is integer math over the harness state — no clock, no randomness, no environment reads — so the two grading executions agree byte for byte.

## Run

`main.ts` runs on Node 22.18+ via the harness (`node main.ts`); `vendor/makefun-bot.ts` is the kit's wire shim.
