// SOL Trend Guard — a tiny paper-trading bot for agent-fun/bars-replay/v1.
//
// Strategy (written from the competition brief, in prose):
//   Trend-following on hourly bars. For each of the seven Solana assets we keep
//   a fast and a slow exponential moving average of the close price. We hold an
//   asset only while its trend is up — fast EMA above slow EMA, the slow EMA
//   itself rising over the last few bars, and the latest close above the fast
//   EMA (a strength filter that keeps us out of sideways chop). A buy needs
//   the up signal to persist for ENTRY_CONFIRM_BARS consecutive bars, so a
//   one-bar cross in chop never opens a position; exits are not delayed.
//   When the fast EMA crosses back below the slow EMA we exit the whole
//   position and sit in USDC. Capital is split evenly across every asset that passes the filter,
//   never more than 25% of equity in one position, never more than 10 open
//   positions, never short, never leveraged. Positions are exited on trend
//   reversal; whatever is still open at the end of the replay is flattened
//   by the harness itself (the bot cannot know the final bar in advance).
//
//   Everything here is a pure function of the bars received so far: no
//   randomness, no clock, no network, no environment. Two runs on the same
//   data therefore produce byte-identical action logs.
//
// Parameters (tuned on the dev window; chosen for a clear margin over
// buy-and-hold with enough trades to clear the 8-trade guardrail on a
// 72-bar final window):
//   FAST = 10, SLOW = 30, SLOPE_LOOKBACK = 6, ENTRY_CONFIRM_BARS = 3.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// --- strategy parameters -------------------------------------------------
const FAST_PERIOD = 10;
const SLOW_PERIOD = 30;
const SLOPE_LOOKBACK = 6; // slow EMA must be higher than it was this many bars ago
const ENTRY_CONFIRM_BARS = 3; // up signal must persist this many bars before a buy
const MAX_SLIPPAGE_BPS = 100;
const TOP_UP_TOLERANCE_NUM = 98; // only top up while value < 98% of target
const TOP_UP_TOLERANCE_DEN = 100;

// --- per-symbol trend state ----------------------------------------------
interface Trend {
  closes: number; // bars seen
  emaFast: number;
  emaSlow: number;
  slowHistory: number[]; // slow EMA values, most recent last
  upStreak: number; // consecutive bars the up signal has held
}

const trends = new Map<string, Trend>();

function emaUpdate(prev: number, price: number, period: number): number {
  const k = 2 / (period + 1);
  return price * k + prev * (1 - k);
}

function trendSignal(t: Trend, close: number): 1 | 0 | null {
  const rising =
    t.slowHistory.length > SLOPE_LOOKBACK &&
    t.emaSlow > t.slowHistory[t.slowHistory.length - 1 - SLOPE_LOOKBACK];
  const up = t.emaFast > t.emaSlow && rising && close > t.emaFast;
  if (up) return 1;
  if (t.emaFast < t.emaSlow) return 0;
  return null; // trend unclear: hold whatever we hold, open nothing new
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1. Fold this batch's closes into the EMAs (warm-up bars included:
    //    they build history even though trading on them is closed).
    for (const bar of batch.bars) {
      const sym = state.symbols.get(bar.symbol);
      if (sym === undefined) continue;
      const close = Number(bar.c) / 10 ** sym.price_scale;
      let t = trends.get(bar.symbol);
      if (t === undefined) {
        t = { closes: 0, emaFast: close, emaSlow: close, slowHistory: [close], upStreak: 0 };
        trends.set(bar.symbol, t);
      }
      t.closes += 1;
      t.emaFast = emaUpdate(t.emaFast, close, FAST_PERIOD);
      t.emaSlow = emaUpdate(t.emaSlow, close, SLOW_PERIOD);
      t.slowHistory.push(t.emaSlow);
      if (t.slowHistory.length > SLOPE_LOOKBACK + 1) t.slowHistory.shift();
    }

    if (state.warmingUp) return [];

    // 2. Signals, in a fixed symbol order so the reply is deterministic.
    //    A raw up signal only becomes a buy after it has persisted for
    //    ENTRY_CONFIRM_BARS consecutive bars: a one-bar EMA cross in chop
    //    is a whipsaw that pays the round-trip fee and exits at a loss, so
    //    the first bar of a cross is treated as "unclear" for entries.
    //    Exits are never delayed — a down signal acts the bar it appears.
    const symbols = [...state.symbols.keys()].sort();
    const signals = new Map<string, 1 | 0 | null>();
    for (const symbol of symbols) {
      const t = trends.get(symbol);
      const close = state.close(symbol);
      const raw = t === undefined || close === null ? null : trendSignal(t, Number(close) / 10 ** (state.symbols.get(symbol)?.price_scale ?? 0));
      if (t !== undefined) t.upStreak = raw === 1 ? t.upStreak + 1 : 0;
      signals.set(symbol, raw === 1 && (t?.upStreak ?? 0) < ENTRY_CONFIRM_BARS ? null : raw);
    }

    const orders: OrderInput[] = [];

    // 3. Exits first: sell the whole position wherever the trend turned down.
    for (const symbol of symbols) {
      if (signals.get(symbol) !== 0) continue;
      const pos = state.positions.get(symbol);
      if (pos === undefined || pos.qty <= 0n) continue;
      orders.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    // 4. Entries: split equity evenly across every asset signalling up,
    //    capped at 25% of equity per position (the harness cap) and at the
    //    cash actually on hand — a sell's proceeds never fund a buy in the
    //    same reply, so buys are sized from state.cash.
    const wanted = symbols.filter((s) => signals.get(s) === 1);
    if (wanted.length > 0) {
      const equity = state.equity;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      let cashLeft = state.cash;
      for (const symbol of wanted) {
        if (cashLeft <= 0n) break;
        const target = equity / BigInt(wanted.length);
        const held = state.positions.get(symbol);
        const current = held === undefined ? 0n : state.value(symbol, held.qty);
        const topUpAt = (target * BigInt(TOP_UP_TOLERANCE_NUM)) / BigInt(TOP_UP_TOLERANCE_DEN);
        if (current >= topUpAt) continue;
        let spend = target - current;
        const room = state.weightRoom(symbol);
        if (spend > room) spend = room;
        if (spend > cashLeft) spend = cashLeft;
        if (spend < minNotional) continue;
        orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cashLeft -= spend;
      }
    }

    return orders;
  },
});
