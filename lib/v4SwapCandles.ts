// lib/v4SwapCandles.ts — pure Uniswap V4 swap-event candle math (no I/O). The RPC side lives in
// lib/server/v4SwapCandlesRpc.ts.
//
// Used only when the candle providers can't serve a bytes32 V4 PoolId. Every candle is built from
// real on-chain swaps of ONE pool: open = first trade price, high = max, low = min, close = last,
// volume = sum of real trade volume. Buckets with no trade are never created, nothing is
// interpolated, and a trade whose USD value can't be proven is dropped, not guessed.
//
// Price: the pool's post-swap sqrtPriceX96 (the price every Swap event reports), converted with the
// exact decimals of both currencies:  price(currency0 in currency1) = (sqrtPriceX96 / 2^96)^2 *
// 10^(dec0 - dec1). The scanned token's side is currency0 or currency1 from the pool's own
// Initialize event — never a guess — and its price in the counter asset is inverted only when the
// token really is currency1.

import { decodeEventLog, toEventSelector, type Hex } from 'viem'
import type { EvmChartPoint } from './evmChartCandles.ts'

export const V4_POOL_MANAGER_ABI = [
  {
    type: 'event',
    name: 'Initialize',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'currency0', type: 'address', indexed: true },
      { name: 'currency1', type: 'address', indexed: true },
      { name: 'fee', type: 'uint24', indexed: false },
      { name: 'tickSpacing', type: 'int24', indexed: false },
      { name: 'hooks', type: 'address', indexed: false },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
      { name: 'tick', type: 'int24', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount0', type: 'int128', indexed: false },
      { name: 'amount1', type: 'int128', indexed: false },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
      { name: 'liquidity', type: 'uint128', indexed: false },
      { name: 'tick', type: 'int24', indexed: false },
      { name: 'fee', type: 'uint24', indexed: false },
    ],
  },
] as const

export const V4_INITIALIZE_TOPIC0 = toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
export const V4_SWAP_TOPIC0 = toEventSelector('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')

export const V4_SWAP_CANDLE_INTERVAL_SEC = 300
const Q96 = 2 ** 96

export type RawEvmLog = { address?: string; topics: string[]; data: string; blockNumber?: string | null; logIndex?: string | null; blockTimestamp?: string | null; removed?: boolean }

export type V4PoolKey = { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; initBlock: number }
export type V4Swap = { blockNumber: number; logIndex: number; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; blockTimestamp: number | null }

const hexToNum = (v: string | null | undefined): number | null => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? Number(BigInt(v)) : null)

/** The pool's key from its own Initialize event, only if the event is for exactly this PoolId. */
export function decodeV4Initialize(log: RawEvmLog, poolId: string): V4PoolKey | null {
  if ((log.topics[0] ?? '').toLowerCase() !== V4_INITIALIZE_TOPIC0 || (log.topics[1] ?? '').toLowerCase() !== poolId.toLowerCase()) return null
  try {
    const d = decodeEventLog({ abi: V4_POOL_MANAGER_ABI, eventName: 'Initialize', topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex })
    const initBlock = hexToNum(log.blockNumber)
    if (initBlock == null) return null
    return { currency0: d.args.currency0.toLowerCase(), currency1: d.args.currency1.toLowerCase(), fee: d.args.fee, tickSpacing: d.args.tickSpacing, hooks: d.args.hooks.toLowerCase(), initBlock }
  } catch {
    return null
  }
}

/** One Swap event, only if it belongs to exactly this PoolId (another pool on the same PoolManager never leaks in). */
export function decodeV4Swap(log: RawEvmLog, poolId: string): V4Swap | null {
  if ((log.topics[0] ?? '').toLowerCase() !== V4_SWAP_TOPIC0 || (log.topics[1] ?? '').toLowerCase() !== poolId.toLowerCase()) return null
  const blockNumber = hexToNum(log.blockNumber)
  const logIndex = hexToNum(log.logIndex) ?? 0
  if (blockNumber == null) return null
  try {
    const d = decodeEventLog({ abi: V4_POOL_MANAGER_ABI, eventName: 'Swap', topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex })
    if (d.args.sqrtPriceX96 <= BigInt(0)) return null
    return { blockNumber, logIndex, amount0: d.args.amount0, amount1: d.args.amount1, sqrtPriceX96: d.args.sqrtPriceX96, blockTimestamp: hexToNum(log.blockTimestamp) }
  } catch {
    return null
  }
}

/** Scanned-token price in units of the counter currency after a swap. */
export function v4TokenPriceInCounter(sqrtPriceX96: bigint, tokenIsCurrency0: boolean, decimals0: number, decimals1: number): number | null {
  const s = Number(sqrtPriceX96) / Q96
  const price0in1 = s * s * 10 ** (decimals0 - decimals1)
  if (!Number.isFinite(price0in1) || price0in1 <= 0) return null
  const p = tokenIsCurrency0 ? price0in1 : 1 / price0in1
  return Number.isFinite(p) && p > 0 ? p : null
}

/**
 * Real swaps -> OHLCV buckets (default 5m). `counterUsdAt(tsMs)` returns the counter asset's USD
 * price at that moment, or null when it can't be proven (that trade is then dropped). Volume is the
 * absolute counter-currency amount of each trade, in USD.
 */
export function buildV4SwapCandles(input: {
  swaps: ReadonlyArray<V4Swap & { timestampSec: number }>
  tokenIsCurrency0: boolean
  decimals0: number
  decimals1: number
  counterUsdAt: (tsMs: number) => number | null
  intervalSec?: number
}): { candles: EvmChartPoint[]; tradesUsed: number; tradesDropped: number } {
  const interval = input.intervalSec ?? V4_SWAP_CANDLE_INTERVAL_SEC
  const counterDecimals = input.tokenIsCurrency0 ? input.decimals1 : input.decimals0
  const ordered = [...input.swaps].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>()
  let used = 0
  let dropped = 0
  for (const s of ordered) {
    const inCounter = v4TokenPriceInCounter(s.sqrtPriceX96, input.tokenIsCurrency0, input.decimals0, input.decimals1)
    const counterUsd = input.counterUsdAt(s.timestampSec * 1000)
    if (inCounter == null || counterUsd == null || !(counterUsd > 0)) { dropped++; continue }
    const price = inCounter * counterUsd
    if (!Number.isFinite(price) || price <= 0) { dropped++; continue }
    const counterRaw = input.tokenIsCurrency0 ? s.amount1 : s.amount0
    const counterAbs = Number(counterRaw < BigInt(0) ? -counterRaw : counterRaw) / 10 ** counterDecimals
    const volUsd = Number.isFinite(counterAbs) ? counterAbs * counterUsd : 0
    const key = Math.floor(s.timestampSec / interval) * interval
    const b = buckets.get(key)
    if (!b) buckets.set(key, { open: price, high: price, low: price, close: price, volume: volUsd })
    else { b.high = Math.max(b.high, price); b.low = Math.min(b.low, price); b.close = price; b.volume += volUsd }
    used++
  }
  const candles = [...buckets.entries()].sort(([a], [b]) => a - b).map(([t, b]) => ({
    timestamp: new Date(t * 1000).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume > 0 ? b.volume : null, priceUsd: b.close,
  }))
  return { candles, tradesUsed: used, tradesDropped: dropped }
}

/** The real point nearest `tsMs` within `maxGapMs` ([ms, usd], ascending series), and its exact distance. */
export function nearestPriceWithGap(series: ReadonlyArray<readonly [number, number]>, tsMs: number, maxGapMs: number): { price: number; gapMs: number } | null {
  if (series.length === 0) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (series[mid][0] < tsMs) lo = mid + 1
    else hi = mid
  }
  let best = series[lo]
  if (lo > 0 && Math.abs(series[lo - 1][0] - tsMs) < Math.abs(best[0] - tsMs)) best = series[lo - 1]
  const gapMs = Math.abs(best[0] - tsMs)
  return gapMs <= maxGapMs && best[1] > 0 ? { price: best[1], gapMs } : null
}

/** Nearest-point lookup in a real price series ([ms, usd], ascending), within `maxGapMs`; null otherwise. */
export function nearestPriceAt(series: ReadonlyArray<readonly [number, number]>, tsMs: number, maxGapMs: number): number | null {
  return nearestPriceWithGap(series, tsMs, maxGapMs)?.price ?? null
}
