// lib/server/v4SwapCandlesRpc.ts — Uniswap V4 candles from ON-CHAIN Swap events, for a V4 pool the
// candle providers can't serve by its bytes32 PoolId. Pure math lives in lib/v4SwapCandles.ts.
//
// Scope — only what can be proven:
//  - Base only (PoolManager verified in lib/server/uniswapV4BaseRpc.ts). ETH / BNB have no verified
//    PoolManager here and Robinhood has no fixed block time: explicit v4_chain_not_supported, 0 calls.
//  - Counter asset must be native ETH / WETH (CoinGecko's real historical ETH/USD, one shared cached
//    series) or a USD stablecoin (USDC / USDbC at $1). Anything else: quote_usd_price_unproven.
//  - The latest candle must sit within 3x of the scan's live token price, or the series is rejected.
//
// TIMESTAMPS. A log's own `blockTimestamp` (returned by newer RPC nodes) is exact; when EVERY swap
// log carries one, candles are 5-minute buckets of exact trade times. Otherwise times are inferred
// from the real latest block header and Base's protocol-fixed 2s block interval — no per-block header
// calls — and the series is labelled `inferred_block_time` and bucketed at 15 minutes, never
// presented as exact 5M candles.
//
// BUDGET. Every call (RPC and CoinGecko) counts against the caller's remaining candle-path budget:
//  1 latest header + 1 Initialize read (cached 24h per PoolId) + at most 3 Swap-log pages of 4h,
//  newest first, stopping as soon as 36 real buckets or 3,000 logs are in hand + the shared ETH/USD
//  series only on a cache miss. 8s overall deadline (per-call timeouts are clipped to it), zero
//  retries after an RPC error, reorged (`removed`) logs ignored, per-pool result cache.

import { RPC } from '../rpc.ts'
import { logRpcCall } from './rpcDebug.ts'
import { auditGlobalAlchemyCall } from './globalRpcAudit.ts'
import {
  V4_INITIALIZE_TOPIC0,
  V4_SWAP_TOPIC0,
  buildV4SwapCandles,
  decodeV4Initialize,
  decodeV4Swap,
  nearestPriceAt,
  type RawEvmLog,
  type V4PoolKey,
  type V4Swap,
} from '../v4SwapCandles.ts'
import { closeMatchesLivePrice, type EvmChartPoint } from '../evmChartCandles.ts'

const NATIVE = '0x0000000000000000000000000000000000000000'

type V4ChainConfig = {
  poolManager: string
  blockTimeSec: number
  rpcUrl: () => string
  ethLike: Record<string, number>
  usdStable: Record<string, number>
}

export const V4_SWAP_CHAIN_CONFIG: Readonly<Record<string, V4ChainConfig>> = {
  base: {
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    blockTimeSec: 2,
    rpcUrl: () => RPC.base,
    ethLike: { [NATIVE]: 18, '0x4200000000000000000000000000000000000006': 18 },
    usdStable: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 6 },
  },
}

export const V4_SWAP_PAGE_BLOCKS = 7_200
export const V4_SWAP_MAX_PAGES = 3
export const V4_SWAP_MAX_LOGS = 3_000
export const V4_SWAP_ENOUGH_BUCKETS = 36
export const V4_SWAP_DEADLINE_MS = 8_000
export const V4_SWAP_MAX_CALLS = 6
export const V4_EXACT_INTERVAL_SEC = 300
export const V4_INFERRED_INTERVAL_SEC = 900
const RPC_TIMEOUT_MS = 4_000
const ETH_USD_MAX_GAP_MS = 15 * 60_000
const OK_TTL_MS = 3 * 60_000
const FAIL_TTL_MS = 60_000
const INIT_TTL_MS = 24 * 3_600_000
const INIT_CACHE_MAX = 500

export type V4SwapGapCode =
  | 'v4_chain_not_supported'
  | 'v4_swap_logs_unavailable'
  | 'v4_swap_history_empty'
  | 'quote_usd_price_unproven'
  | 'token_side_unresolved'
  | 'token_identity_unverified'
  | 'call_budget_exhausted'

export type V4TimeResolution = 'exact_log_timestamps' | 'inferred_block_time'

export type V4SwapCandleResult = {
  ok: boolean
  code: V4SwapGapCode | null
  poolManager: string | null
  poolId: string
  tokenCurrencyIndex: 0 | 1 | null
  counterAsset: 'eth' | 'usd_stable' | 'other' | null
  logsFound: number
  tradesUsed: number
  candles: EvmChartPoint[]
  intervalSec: number
  timeResolution: V4TimeResolution | null
  /** Every call this read made (RPC + CoinGecko), all counted against the caller's budget. */
  callsUsed: number
  rpcCalls: number
  providerCalls: number
  pagesFetched: number
  /** Why paging/work stopped early: 'enough_buckets' | 'log_cap' | 'page_cap' | 'deadline' | 'call_budget' | 'rpc_error' | null. */
  budgetStopReason: string | null
  cache: { result: boolean; initialize: boolean; ethUsd: boolean }
}

export type V4SwapDeps = {
  rpc: (method: string, params: unknown[], timeoutMs: number) => Promise<{ result: unknown; error: boolean }>
  /** Shared, cached real ETH/USD series covering the swap window ([ms, usd] ascending). */
  ethUsdSeries: (timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  now?: () => number
}

const resultCache = new Map<string, { expiresAt: number; value: V4SwapCandleResult }>()
const initCache = new Map<string, { expiresAt: number; key: V4PoolKey }>()
export function resetV4SwapCandleCache() {
  resultCache.clear()
  initCache.clear()
}

export function makeV4Rpc(chain: string): V4SwapDeps['rpc'] | null {
  const cfg = V4_SWAP_CHAIN_CONFIG[chain]
  const url = cfg?.rpcUrl()
  if (!cfg || !url) return null
  return async (method, params, timeoutMs) => {
    logRpcCall({ route: 'v4SwapCandles', chain, method })
    if (url.includes('g.alchemy.com')) auditGlobalAlchemyCall(method, { chain, route: 'v4SwapCandles' })
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.max(1, timeoutMs)) })
      if (!res.ok) return { result: null, error: true }
      const json = await res.json() as { result?: unknown; error?: unknown }
      return json.error || json.result === undefined ? { result: null, error: true } : { result: json.result, error: false }
    } catch {
      return { result: null, error: true }
    }
  }
}

const toHex = (n: number) => `0x${Math.max(0, Math.floor(n)).toString(16)}`

export async function loadV4SwapCandles(
  input: { chain: string; poolId: string; token: string; tokenDecimals: number; livePriceUsd: number | null },
  deps: V4SwapDeps,
  /** Calls still allowed on the whole candle path; this read never exceeds min(budget, V4_SWAP_MAX_CALLS). */
  budget: number = V4_SWAP_MAX_CALLS,
): Promise<V4SwapCandleResult> {
  const now = deps.now ?? Date.now
  const poolId = input.poolId.toLowerCase()
  const token = input.token.toLowerCase()
  const cfg = V4_SWAP_CHAIN_CONFIG[input.chain]
  const r: V4SwapCandleResult = {
    ok: false, code: null, poolManager: cfg?.poolManager ?? null, poolId, tokenCurrencyIndex: null, counterAsset: null, logsFound: 0, tradesUsed: 0,
    candles: [], intervalSec: V4_EXACT_INTERVAL_SEC, timeResolution: null, callsUsed: 0, rpcCalls: 0, providerCalls: 0, pagesFetched: 0,
    budgetStopReason: null, cache: { result: false, initialize: false, ethUsd: false },
  }
  const gap = (code: V4SwapGapCode): V4SwapCandleResult => ({ ...r, ok: false, code })
  if (!cfg) return gap('v4_chain_not_supported')
  if (!/^0x[a-f0-9]{64}$/.test(poolId) || !/^0x[a-f0-9]{40}$/.test(token)) return gap('token_side_unresolved')

  const cacheKey = `${input.chain}:${poolId}:${token}`
  const hit = resultCache.get(cacheKey)
  if (hit && hit.expiresAt > now()) return { ...hit.value, callsUsed: 0, rpcCalls: 0, providerCalls: 0, pagesFetched: 0, cache: { ...hit.value.cache, result: true } }
  const done = (v: V4SwapCandleResult) => {
    // A budget stop says nothing about the pool itself — never cache it.
    if (v.code !== 'call_budget_exhausted') resultCache.set(cacheKey, { expiresAt: now() + (v.ok ? OK_TTL_MS : FAIL_TTL_MS), value: v })
    return v
  }
  const cap = Math.min(budget, V4_SWAP_MAX_CALLS)
  const deadline = now() + V4_SWAP_DEADLINE_MS
  const canCall = (): boolean => {
    if (r.callsUsed >= cap) { r.budgetStopReason = 'call_budget'; return false }
    if (now() >= deadline) { r.budgetStopReason = 'deadline'; return false }
    return true
  }
  const rpc = async (method: string, params: unknown[]) => {
    r.callsUsed++
    r.rpcCalls++
    return deps.rpc(method, params, Math.min(RPC_TIMEOUT_MS, Math.max(1, deadline - now())))
  }

  // 1. Latest block number + real timestamp.
  if (!canCall()) return gap('call_budget_exhausted')
  const latestRes = await rpc('eth_getBlockByNumber', ['latest', false])
  const latest = latestRes.result as { number?: string; timestamp?: string } | null
  const latestBlock = latest?.number ? Number(BigInt(latest.number)) : null
  const latestTs = latest?.timestamp ? Number(BigInt(latest.timestamp)) : null
  if (latestRes.error || latestBlock == null || latestTs == null) { r.budgetStopReason = 'rpc_error'; return done(gap('v4_swap_logs_unavailable')) }

  // 2. The pool's own Initialize event (immutable: cached 24h per PoolId).
  let key: V4PoolKey | null = null
  const cachedInit = initCache.get(`${input.chain}:${poolId}`)
  if (cachedInit && cachedInit.expiresAt > now()) {
    key = cachedInit.key
    r.cache.initialize = true
  } else {
    if (!canCall()) return gap('call_budget_exhausted')
    const initRes = await rpc('eth_getLogs', [{ address: cfg.poolManager, topics: [V4_INITIALIZE_TOPIC0, poolId], fromBlock: '0x0', toBlock: toHex(latestBlock) }])
    if (initRes.error || !Array.isArray(initRes.result)) { r.budgetStopReason = 'rpc_error'; return done(gap('v4_swap_logs_unavailable')) }
    key = (initRes.result as RawEvmLog[]).filter((l) => l.removed !== true).map((l) => decodeV4Initialize(l, poolId)).find((k) => k != null) ?? null
    if (!key) return done(gap('v4_swap_logs_unavailable'))
    if (initCache.size >= INIT_CACHE_MAX) initCache.delete(initCache.keys().next().value!)
    initCache.set(`${input.chain}:${poolId}`, { expiresAt: now() + INIT_TTL_MS, key })
  }
  const tokenIsCurrency0 = key.currency0 === token
  if (!tokenIsCurrency0 && key.currency1 !== token) return done(gap('token_side_unresolved'))
  r.tokenCurrencyIndex = tokenIsCurrency0 ? 0 : 1
  const counter = tokenIsCurrency0 ? key.currency1 : key.currency0
  const counterEthDec = cfg.ethLike[counter]
  const counterUsdDec = cfg.usdStable[counter]
  r.counterAsset = counterEthDec != null ? 'eth' : counterUsdDec != null ? 'usd_stable' : 'other'
  if (r.counterAsset === 'other') return done(gap('quote_usd_price_unproven'))
  const counterDecimals = (counterEthDec ?? counterUsdDec)!
  const decimals0 = tokenIsCurrency0 ? input.tokenDecimals : counterDecimals
  const decimals1 = tokenIsCurrency0 ? counterDecimals : input.tokenDecimals

  // 3. Swap logs for exactly this PoolId, newest page first, never before creation; stop early.
  const swaps: Array<V4Swap & { logTimestamp: number | null }> = []
  const buckets = new Set<number>()
  let toBlock = latestBlock
  while (toBlock >= key.initBlock) {
    if (buckets.size >= V4_SWAP_ENOUGH_BUCKETS) { r.budgetStopReason = 'enough_buckets'; break }
    if (swaps.length >= V4_SWAP_MAX_LOGS) { r.budgetStopReason = 'log_cap'; break }
    if (r.pagesFetched >= V4_SWAP_MAX_PAGES) { r.budgetStopReason = 'page_cap'; break }
    // Keep one call in hand for the ETH/USD series (it may not be cached yet).
    if (r.counterAsset === 'eth' && r.callsUsed >= cap - 1) { r.budgetStopReason = 'call_budget'; break }
    if (!canCall()) break
    const fromBlock = Math.max(key.initBlock, toBlock - V4_SWAP_PAGE_BLOCKS + 1)
    r.pagesFetched++
    const page = await rpc('eth_getLogs', [{ address: cfg.poolManager, topics: [V4_SWAP_TOPIC0, poolId], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }])
    if (page.error || !Array.isArray(page.result)) { r.budgetStopReason = 'rpc_error'; break }
    for (const log of page.result as RawEvmLog[]) {
      if (log.removed === true) continue
      const s = decodeV4Swap(log, poolId)
      if (!s) continue
      swaps.push({ ...s, logTimestamp: s.blockTimestamp })
      buckets.add(Math.floor((s.blockTimestamp ?? latestTs - (latestBlock - s.blockNumber) * cfg.blockTimeSec) / V4_EXACT_INTERVAL_SEC))
      if (swaps.length >= V4_SWAP_MAX_LOGS) break
    }
    toBlock = fromBlock - 1
  }
  r.logsFound = swaps.length
  if (swaps.length === 0) {
    if (r.budgetStopReason === 'rpc_error' || r.budgetStopReason === 'deadline') return done(gap('v4_swap_logs_unavailable'))
    if (r.budgetStopReason === 'call_budget') return gap('call_budget_exhausted')
    return done(gap('v4_swap_history_empty'))
  }

  // Exact times only if every swap log carries its own block timestamp; otherwise inferred, 15m.
  const exact = swaps.every((s) => s.logTimestamp != null)
  r.timeResolution = exact ? 'exact_log_timestamps' : 'inferred_block_time'
  r.intervalSec = exact ? V4_EXACT_INTERVAL_SEC : V4_INFERRED_INTERVAL_SEC
  const timed = swaps.map((s) => ({ ...s, timestampSec: exact ? s.logTimestamp! : latestTs - (latestBlock - s.blockNumber) * cfg.blockTimeSec }))

  // 4. Counter-asset USD: $1 stablecoin, or the shared cached real ETH/USD series.
  let counterUsdAt: (tsMs: number) => number | null = () => 1
  if (r.counterAsset === 'eth') {
    if (now() >= deadline) { r.budgetStopReason = 'deadline'; return done(gap('quote_usd_price_unproven')) }
    const eth = await deps.ethUsdSeries(Math.max(1, deadline - now()))
    r.cache.ethUsd = eth.cacheHit
    if (!eth.cacheHit) { r.callsUsed++; r.providerCalls++ }
    if (!eth.points || eth.points.length === 0) return done(gap('quote_usd_price_unproven'))
    const series = eth.points
    counterUsdAt = (tsMs) => nearestPriceAt(series, tsMs, ETH_USD_MAX_GAP_MS)
  }

  // 5. Real-trade OHLCV; at least 2 real buckets; identity checked against the live price.
  const built = buildV4SwapCandles({ swaps: timed, tokenIsCurrency0, decimals0, decimals1, counterUsdAt, intervalSec: r.intervalSec })
  r.tradesUsed = built.tradesUsed
  if (built.candles.length < 2) return done(gap('v4_swap_history_empty'))
  if (!closeMatchesLivePrice(built.candles, input.livePriceUsd)) return done(gap('token_identity_unverified'))
  return done({ ...r, ok: true, code: null, candles: built.candles })
}
