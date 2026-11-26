# SOL Trend Guard

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/onlybountyy-hub/tiny-bot-sol/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/onlybountyy-hub/tiny-bot-sol/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) competition on make.fun. It reads hourly bars for seven Solana assets and decides when to hold each asset vs sit in USDC, aiming for a net PnL above buy-and-hold.

## Strategy

Simple, robust trend-following on hourly closes:

- **Enter** an asset only while its trend is up: fast EMA (10) above slow EMA (30), the slow EMA itself rising over the last 6 bars, and the latest close above the fast EMA (a strength filter against sideways chop).
- **Exit** the whole position when the fast EMA crosses back below the slow EMA; otherwise sit in USDC.
- **Sizing**: equity split evenly across every asset passing the filter, capped at 25% of equity per position, max 10 open positions. No shorts, no leverage.
- **Determinism**: the bot is a pure function of the bars seen so far — no randomness, no clock, no network — so two runs produce byte-identical action logs. Positions still open at the end of the replay are flattened by the harness.

## Files

- `main.ts` — the bot (TypeScript, runs as-is on Node 22).
- `vendor/makefun-bars.ts` — the official `agent-fun/bars-replay/v1` protocol shim from the competition kit.
- `LICENSE` — MIT.

## Local grade

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/tiny-bot-sol-entry --driver process
```
