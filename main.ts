// Tide Runner: momentum-breakout bot for the pump.fun replay harness.
// Buys only fresh coins already running hot, one fixed-size ticket per coin,
// and exits on staged take-profits, a trailing stop, a hard stop, or
// staleness. Every decision is integer math over the harness state: no clock,
// no randomness, no environment reads, so the two grading executions agree.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const BUY_LAMPORTS = 400_000_000n;
const MIN_BUY_LAMPORTS = 100_000_000n;
const CASH_BUFFER_LAMPORTS = 10_000_000n;
const MAX_POSITIONS = 5;
const MAX_AGE_SLOTS = 900;
const MIN_TRADES = 5;
const ENTRY_MULT = 5n;
const MIN_REAL_QUOTE = 50_000_000_000n;
const MIN_BUY_SHARE = 60n;
const TAKE_HALF_AT = 125n;
const TAKE_REST_AT = 10000n;
const TRAIL_ARM_AT = 150n;
const TRAIL_KEEP_PCT = 88n;
const STOP_AT = 85n;
const STALE_SLOTS = 1200;
const COOLDOWN_SLOTS = 300;
const SLIPPAGE_BPS = 500;

interface CoinStat {
  firstVq: bigint;
  firstVt: bigint;
  firstSlot: number;
  buyVol: bigint;
  sellVol: bigint;
  trades: number;
  lastSlot: number;
}

interface HeldStat {
  halfSold: boolean;
  peakPct: bigint;
}

const coins = new Map<string, CoinStat>();
const held = new Map<string, HeldStat>();
const closedAt = new Map<string, number>();

function observe(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!coins.has(e.mint)) {
        coins.set(e.mint, {
          firstVq: BigInt(e.virtual_quote_reserves),
          firstVt: BigInt(e.virtual_token_reserves),
          firstSlot: e.slot,
          buyVol: 0n,
          sellVol: 0n,
          trades: 0,
          lastSlot: e.slot,
        });
      }
    } else if (e.event === 'TradeEvent') {
      let s = coins.get(e.mint);
      if (s === undefined) {
        s = {
          firstVq: BigInt(e.virtual_quote_reserves),
          firstVt: BigInt(e.virtual_token_reserves),
          firstSlot: e.slot,
          buyVol: 0n,
          sellVol: 0n,
          trades: 0,
          lastSlot: e.slot,
        };
        coins.set(e.mint, s);
      }
      if (e.is_buy) s.buyVol += BigInt(e.sol_amount);
      else s.sellVol += BigInt(e.sol_amount);
      s.trades += 1;
      s.lastSlot = e.slot;
    }
  }
}

/** Current price as a percent of the position's cost basis (100 = breakeven). */
function positionPct(vq: bigint, vt: bigint, tokens: bigint, cost: bigint): bigint {
  if (vt === 0n || cost === 0n) return 0n;
  return (vq * tokens * 100n) / (vt * cost);
}

/** Current price as a whole multiple of the coin's first-seen price. */
function entryMultiple(vq: bigint, vt: bigint, s: CoinStat): bigint {
  if (vt === 0n || s.firstVq === 0n) return 0n;
  return (vq * s.firstVt) / (vt * s.firstVq);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    observe(batch);
    const orders: OrderInput[] = [];
    const pendingBuy = new Set<string>();
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
      else pendingSell.add(p.order.mint);
    }
    for (const m of held.keys()) {
      if (!state.positions.has(m)) held.delete(m);
    }

    // 1. Manage open positions: exits first.
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tokens = holding.token_amount;
      const cost = holding.cost_lamports;
      if (tokens === 0n || cost === 0n) continue;
      const pct = positionPct(curve.virtual_quote_reserves, curve.virtual_token_reserves, tokens, cost);
      const h = held.get(mint) ?? { halfSold: false, peakPct: 0n };
      if (pct > h.peakPct) h.peakPct = pct;
      const stat = coins.get(mint);
      const stale = stat !== undefined && batch.slot - stat.lastSlot >= STALE_SLOTS;
      let action: 'none' | 'half' | 'all' = 'none';
      if (pct <= STOP_AT || pct >= TAKE_REST_AT || stale) action = 'all';
      else if (pct >= TAKE_HALF_AT && !h.halfSold) action = 'half';
      else if (h.peakPct >= TRAIL_ARM_AT && pct * 100n < h.peakPct * TRAIL_KEEP_PCT) action = 'all';
      if (action === 'all') {
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SLIPPAGE_BPS });
        held.delete(mint);
        closedAt.set(mint, batch.slot);
      } else if (action === 'half') {
        const half = tokens / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: SLIPPAGE_BPS });
          h.halfSold = true;
          held.set(mint, h);
        }
      } else {
        held.set(mint, h);
      }
    }

    // 2. Hunt fresh breakouts among this batch's coins.
    let buysSent = 0;
    let reserved = 0n;
    if (orders.length < 16) {
      const seen = new Set<string>();
      for (const e of batch.events) {
        if (orders.length >= 16) break;
        if (e.event === 'CompleteEvent') continue;
        const mint = e.mint;
        if (seen.has(mint)) continue;
        seen.add(mint);
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const closed = closedAt.get(mint);
        if (closed !== undefined && batch.slot - closed < COOLDOWN_SLOTS) continue;
        if (state.committedPositionCount() + buysSent >= MAX_POSITIONS) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const s = coins.get(mint);
        if (s === undefined) continue;
        if (batch.slot - s.firstSlot > MAX_AGE_SLOTS) continue;
        if (s.trades < MIN_TRADES) continue;
        if (entryMultiple(curve.virtual_quote_reserves, curve.virtual_token_reserves, s) < ENTRY_MULT) continue;
        if (curve.real_quote_reserves < MIN_REAL_QUOTE) continue;
        const vol = s.buyVol + s.sellVol;
        if (vol === 0n || s.buyVol * 100n < MIN_BUY_SHARE * vol) continue;
        const cap = state.maxBuyLamports(mint);
        const afford = state.freeCashLamports() - CASH_BUFFER_LAMPORTS - reserved;
        let size = BUY_LAMPORTS;
        if (size > cap) size = cap;
        if (size > afford) size = afford;
        if (size < MIN_BUY_LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
        buysSent += 1;
        reserved += size + state.txFeeLamports();
      }
    }
    return orders;
  },
});
