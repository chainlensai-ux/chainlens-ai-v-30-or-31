// lib/server/v4SwapCandlesRpc.ts — Uniswap V4 candles from ON-CHAIN Swap events, for a V4 pool the
// candle providers can't serve by its bytes32 PoolId. Pure math lives in lib/v4SwapCandles.ts.
//
// Scope — only what can be proven:
//  - Base only (PoolManager verified in lib/server/uniswapV4BaseRpc.ts). ETH / BNB have no verified
//    PoolManager here and Robinhood has no fixed block time: explicit v4_chain_not_supported, 0 calls.
//  - Counter asset: native ETH / WETH (CoinGecko's real historical ETH/USD, one shared cached series),
//    a USD stablecoin (USDC / USDbC at $1), or — one hop only — any other token whose own USD history
//    is proven by an INDEPENDENT pool pairing it directly with WETH or a verified stable
//    (lib/server/v4QuoteUsd.ts). Otherwise quote_usd_price_unproven. Every trade needs a quote USD
//    point within 15 minutes of it, or that trade is dropped.
//  - The latest candle must sit within 3x of the scan's live token price, or the series is rejected.
//
// TIMESTAMPS. A log's own `blockTimestamp` (returned by newer RPC nodes) is exact; when EVERY swap
// log carries one, candles are 5-minute buckets of exact trade times. Otherwise times are inferred
// from the real latest block header and Base's protocol-fixed 2s block interval — no per-block header
// calls — and the series is labelled `inferred_block_time` and bucketed at 15 minutes, never
// presented as exact 5M candles.
//
// INITIAL WINDOW (every scan). Target: the pool's last 24h — all of it for a pool younger than that —
// never a crawl of older history. Every call (RPC and CoinGecko) counts against the caller's
// remaining candle-path budget: 1 latest header + 1 Initialize read (cached 24h per PoolId) + at most
// 3 Swap-log pages newest first (4h, 8h, 12h = 24h; a busy pool keeps 4h pages) + the shared ETH/USD
// series only on a cache miss. At most 6,000 logs: when that cap is hit the NEWEST logs are kept and
// the oldest, possibly partial, bucket is dropped (never a gap near "now"). 8s overall deadline
// (per-call timeouts are clipped to it), zero retries after an RPC error, reorged (`removed`) logs
// ignored, per-pool result cache.
//
// ON-DEMAND HISTORY (loadV4SwapHistoryWindow — only after the user selects 1H/4H/1D or pans past the
// oldest loaded candle): hourly candles for the same exact PoolId strictly before a `before` cursor.
// Adaptive pages (24h, growing to 4 days while the pool is quiet, shrinking when busy), at most 3 pages
// and 6,000 logs per request, 8 calls, 9s deadline, results cached per window; the response carries
// `hasMore` and the next cursor. Quote USD over the window: USD stable at $1, CoinGecko's hourly
// ETH/USD for that window, or the independent quote pool's hourly candles ending at the window's end —
// each trade within 45 minutes of a real quote point or dropped.

import { RPC } from '../rpc.ts'
import { logRpcCall } from './rpcDebug.ts'
import { auditGlobalAlchemyCall } from './globalRpcAudit.ts'
import {
  V4_INITIALIZE_TOPIC0,
  V4_SWAP_TOPIC0,
  buildV4SwapCandles,
  decodeV4Initialize,
  decodeV4Swap,
  nearestPriceWithGap,
  type RawEvmLog,
  type V4PoolKey,
  type V4Swap,
} from '../v4SwapCandles.ts'
import { closeMatchesLivePrice, type EvmChartPoint } from '../evmChartCandles.ts'
import type { QuoteUsdResult } from './v4QuoteUsd.ts'

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
/** Initial-scan page sizes, newest first: 4h + 8h + 12h = 24h of Base blocks. */
export const V4_SWAP_PAGE_PLAN: ReadonlyArray<number> = [7_200, 14_400, 21_600]
export const V4_SWAP_TARGET_WINDOW_SEC = 24 * 3600
/** A first page this busy keeps later pages at 4h (stays well under the RPC's per-response log limit). */
export const V4_SWAP_BUSY_PAGE_LOGS = 2_000
export const V4_SWAP_MAX_PAGES = 3
export const V4_SWAP_MAX_LOGS = 6_000
export const V4_SWAP_DEADLINE_MS = 8_000
export const V4_SWAP_MAX_CALLS = 7
/** Max distance between a trade and the quote-asset USD point used for it. */
export const QUOTE_USD_MAX_GAP_MS = 15 * 60_000
export const V4_EXACT_INTERVAL_SEC = 300
export const V4_INFERRED_INTERVAL_SEC = 900
const RPC_TIMEOUT_MS = 4_000
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
  counterAsset: 'eth' | 'usd_stable' | 'independent_quote' | 'other' | null
  /** How the pool's other asset was priced in USD (null until the pool key is known). */
  quote: {
    asset: string
    symbol: string | null
    source: 'usd_stable' | 'eth_usd_series' | 'independent_pool' | null
    pool: string | null
    pairedWith: string | null
    evidence: 'verified' | 'unavailable'
    points: number
    maxGapMs: number | null
    reason: string | null
  } | null
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
  /** Why paging stopped: 'target_window' (24h covered) | 'log_cap' | 'page_cap' | 'deadline' | 'call_budget' | 'rpc_error' | null (reached pool creation). */
  budgetStopReason: string | null
  cache: { result: boolean; initialize: boolean; ethUsd: boolean }
}

export type V4SwapDeps = {
  rpc: (method: string, params: unknown[], timeoutMs: number) => Promise<{ result: unknown; error: boolean }>
  /** Shared, cached real ETH/USD series covering the swap window ([ms, usd] ascending). */
  ethUsdSeries: (timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  /** One-hop independent USD history for any other quote token (lib/server/v4QuoteUsd.ts). Absent => unproven. */
  quoteUsd?: (input: { quoteToken: string; scannedToken: string; excludePool: string; anchors: ReadonlySet<string>; budget: number; deadlineMs: number }) => Promise<QuoteUsdResult>
  now?: () => number
}

const resultCache = new Map<string, { expiresAt: number; value: V4SwapCandleResult }>()
const initCache = new Map<string, { expiresAt: number; key: V4PoolKey }>()
const decimalsCache = new Map<string, { expiresAt: number; decimals: number }>()
const headerCache = new Map<string, { expiresAt: number; block: number; ts: number }>()
const historyCache = new Map<string, { expiresAt: number; value: V4HistoryResult }>()
const historyInflight = new Map<string, Promise<V4HistoryResult>>()
export function resetV4SwapCandleCache() {
  resultCache.clear()
  initCache.clear()
  decimalsCache.clear()
  headerCache.clear()
  historyCache.clear()
  historyInflight.clear()
}
const bounded = <K, V>(m: Map<K, V>, max = INIT_CACHE_MAX) => { if (m.size >= max) m.delete(m.keys().next().value!) }

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
    ok: false, code: null, poolManager: cfg?.poolManager ?? null, poolId, tokenCurrencyIndex: null, counterAsset: null, quote: null, logsFound: 0, tradesUsed: 0,
    candles: [], intervalSec: V4_EXACT_INTERVAL_SEC, timeResolution: null, callsUsed: 0, rpcCalls: 0, providerCalls: 0, pagesFetched: 0,
    budgetStopReason: null, cache: { result: false, initialize: false, ethUsd: false },
  }
  const gap = (code: V4SwapGapCode): V4SwapCandleResult => ({ ...r, ok: false, code })
  if (!cfg) return gap('v4_chain_not_supported')
  if (!/^0x[a-f0-9]{64}$/.test(poolId) || !/^0x[a-f0-9]{40}$/.test(token)) return gap('token_side_unresolved')

  // The scan's own resolved decimals are remembered so an on-demand history request needs no extra read.
  if (Number.isInteger(input.tokenDecimals) && input.tokenDecimals >= 0 && input.tokenDecimals <= 36) {
    bounded(decimalsCache)
    decimalsCache.set(`${input.chain}:${token}`, { expiresAt: now() + INIT_TTL_MS, decimals: input.tokenDecimals })
  }
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
    bounded(initCache)
    initCache.set(`${input.chain}:${poolId}`, { expiresAt: now() + INIT_TTL_MS, key })
  }
  const tokenIsCurrency0 = key.currency0 === token
  if (!tokenIsCurrency0 && key.currency1 !== token) return done(gap('token_side_unresolved'))
  r.tokenCurrencyIndex = tokenIsCurrency0 ? 0 : 1
  const counter = tokenIsCurrency0 ? key.currency1 : key.currency0
  const counterEthDec = cfg.ethLike[counter]
  const counterUsdDec = cfg.usdStable[counter]
  r.counterAsset = counterEthDec != null ? 'eth' : counterUsdDec != null ? 'usd_stable' : 'other'
  r.quote = { asset: counter, symbol: counterEthDec != null ? 'ETH' : null, source: counterEthDec != null ? 'eth_usd_series' : counterUsdDec != null ? 'usd_stable' : null, pool: null, pairedWith: null, evidence: counterUsdDec != null ? 'verified' : 'unavailable', points: 0, maxGapMs: null, reason: null }

  // 2b. Any other quote token: resolve its independent USD history FIRST (fail fast, before paging),
  // always leaving at least one call for a swap-log page.
  let quotePoints: Array<[number, number]> | null = null
  let counterDecimals = (counterEthDec ?? counterUsdDec) ?? null
  if (r.counterAsset === 'other') {
    const unproven = (reason: string) => { r.quote = { ...r.quote!, evidence: 'unavailable', reason }; return done(gap('quote_usd_price_unproven')) }
    if (!deps.quoteUsd) return unproven('no_independent_quote_source')
    const q = await deps.quoteUsd({
      quoteToken: counter,
      scannedToken: token,
      excludePool: poolId,
      anchors: new Set([...Object.keys(cfg.ethLike), ...Object.keys(cfg.usdStable)]),
      budget: Math.max(0, cap - r.callsUsed - 1),
      deadlineMs: deadline,
    })
    r.callsUsed += q.callsUsed
    r.providerCalls += q.callsUsed
    r.quote = { ...r.quote!, symbol: q.quoteSymbol, source: 'independent_pool', pool: q.pool, pairedWith: q.pairedWith, points: q.points.length, reason: q.detail }
    if (q.reason === 'call_budget_exhausted') { r.budgetStopReason = 'call_budget'; return gap('call_budget_exhausted') }
    if (!q.ok || q.quoteDecimals == null) return unproven(q.detail ?? 'quote_usd_price_unproven')
    r.counterAsset = 'independent_quote'
    counterDecimals = q.quoteDecimals
    quotePoints = q.points
  }
  if (counterDecimals == null) return done(gap('quote_usd_price_unproven'))
  const decimals0 = tokenIsCurrency0 ? input.tokenDecimals : counterDecimals
  const decimals1 = tokenIsCurrency0 ? counterDecimals : input.tokenDecimals

  // 3. Swap logs for exactly this PoolId, newest page first, never before creation, back to 24h.
  const swaps: Array<V4Swap & { logTimestamp: number | null }> = []
  const targetBlock = latestBlock - Math.floor(V4_SWAP_TARGET_WINDOW_SEC / cfg.blockTimeSec) + 1
  let toBlock = latestBlock
  let busy = false
  let capped = false
  while (toBlock >= key.initBlock) {
    if (toBlock < targetBlock) { r.budgetStopReason = 'target_window'; break }
    if (capped) { r.budgetStopReason = 'log_cap'; break }
    if (r.pagesFetched >= V4_SWAP_MAX_PAGES) { r.budgetStopReason = 'page_cap'; break }
    // Keep one call in hand for the ETH/USD series (it may not be cached yet).
    if (r.counterAsset === 'eth' && r.callsUsed >= cap - 1) { r.budgetStopReason = 'call_budget'; break }
    if (!canCall()) break
    const size = busy ? V4_SWAP_PAGE_BLOCKS : V4_SWAP_PAGE_PLAN[r.pagesFetched] ?? V4_SWAP_PAGE_BLOCKS
    const fromBlock = Math.max(key.initBlock, targetBlock, toBlock - size + 1)
    r.pagesFetched++
    const page = await rpc('eth_getLogs', [{ address: cfg.poolManager, topics: [V4_SWAP_TOPIC0, poolId], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }])
    if (page.error || !Array.isArray(page.result)) { r.budgetStopReason = 'rpc_error'; break }
    const decoded = decodePageNewestFirst(page.result as RawEvmLog[], poolId)
    if (decoded.length >= V4_SWAP_BUSY_PAGE_LOGS) busy = true
    for (const s of decoded) {
      if (swaps.length >= V4_SWAP_MAX_LOGS) { capped = true; break }
      swaps.push({ ...s, logTimestamp: s.blockTimestamp })
    }
    toBlock = fromBlock - 1
  }
  if (!r.budgetStopReason && capped) r.budgetStopReason = 'log_cap'
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
  let timed = swaps.map((s) => ({ ...s, timestampSec: exact ? s.logTimestamp! : latestTs - (latestBlock - s.blockNumber) * cfg.blockTimeSec }))
  // Log cap hit: the oldest kept bucket may be missing earlier trades — drop it rather than show a partial candle.
  if (capped) timed = dropOldestBucket(timed, r.intervalSec)

  // 4. Counter-asset USD: $1 stablecoin, the shared cached ETH/USD series, or the independent quote
  // pool's own history. Each trade uses the closest real point within 15 minutes, or is dropped.
  let maxGapMs = 0
  const fromSeries = (series: ReadonlyArray<readonly [number, number]>) => (tsMs: number) => {
    const hit = nearestPriceWithGap(series, tsMs, QUOTE_USD_MAX_GAP_MS)
    if (!hit) return null
    maxGapMs = Math.max(maxGapMs, hit.gapMs)
    return hit.price
  }
  let counterUsdAt: (tsMs: number) => number | null = () => 1
  if (r.counterAsset === 'eth') {
    if (now() >= deadline) { r.budgetStopReason = 'deadline'; return done(gap('quote_usd_price_unproven')) }
    const eth = await deps.ethUsdSeries(Math.max(1, deadline - now()))
    r.cache.ethUsd = eth.cacheHit
    if (!eth.cacheHit) { r.callsUsed++; r.providerCalls++ }
    if (!eth.points || eth.points.length === 0) { r.quote = { ...r.quote!, evidence: 'unavailable', reason: 'eth_usd_series_unavailable' }; return done(gap('quote_usd_price_unproven')) }
    r.quote = { ...r.quote!, evidence: 'verified', points: eth.points.length }
    counterUsdAt = fromSeries(eth.points)
  } else if (quotePoints) {
    r.quote = { ...r.quote!, evidence: 'verified' }
    counterUsdAt = fromSeries(quotePoints)
  }

  // 5. Real-trade OHLCV; at least 2 real buckets; identity checked against the live price.
  const built = buildV4SwapCandles({ swaps: timed, tokenIsCurrency0, decimals0, decimals1, counterUsdAt, intervalSec: r.intervalSec })
  r.tradesUsed = built.tradesUsed
  r.quote = { ...r.quote!, maxGapMs: r.counterAsset === 'usd_stable' ? null : maxGapMs }
  if (built.tradesUsed === 0 && r.counterAsset !== 'usd_stable') { r.quote = { ...r.quote!, evidence: 'unavailable', reason: 'no_quote_usd_point_within_15m_of_any_trade' }; return done(gap('quote_usd_price_unproven')) }
  if (built.candles.length < 2) return done(gap('v4_swap_history_empty'))
  if (!closeMatchesLivePrice(built.candles, input.livePriceUsd)) return done(gap('token_identity_unverified'))
  return done({ ...r, ok: true, code: null, candles: built.candles })
}

/** A page's swaps for exactly this PoolId, newest first (block desc, logIndex desc), reorged logs ignored. */
function decodePageNewestFirst(logs: ReadonlyArray<RawEvmLog>, poolId: string): V4Swap[] {
  const out: V4Swap[] = []
  for (const log of logs) {
    if (log.removed === true) continue
    const s = decodeV4Swap(log, poolId)
    if (s) out.push(s)
  }
  return out.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
}

function dropOldestBucket<T extends { timestampSec: number }>(timed: ReadonlyArray<T>, intervalSec: number): T[] {
  if (timed.length === 0) return []
  const oldest = Math.min(...timed.map((s) => Math.floor(s.timestampSec / intervalSec)))
  return timed.filter((s) => Math.floor(s.timestampSec / intervalSec) !== oldest)
}

// ── On-demand history window ─────────────────────────────────────────────────────────────────────

export const V4_HISTORY_INTERVAL_SEC = 3600
export const V4_HISTORY_FIRST_PAGE_BLOCKS = 43_200 // 24h
export const V4_HISTORY_MIN_PAGE_BLOCKS = 7_200 // 4h
export const V4_HISTORY_MAX_PAGE_BLOCKS = 172_800 // 4 days
export const V4_HISTORY_MAX_PAGES = 3
export const V4_HISTORY_MAX_LOGS = 6_000
export const V4_HISTORY_MAX_CALLS = 8
export const V4_HISTORY_DEADLINE_MS = 9_000
/** Oldest cursor accepted — bounds how far interactive paging can crawl. */
export const V4_HISTORY_MAX_AGE_SEC = 180 * 86_400
/** Hourly candles priced from hourly quote points: each trade within 45 minutes of a real point, or dropped. */
export const V4_HISTORY_QUOTE_MAX_GAP_MS = 45 * 60_000
const HISTORY_OK_TTL_MS = 15 * 60_000
const HISTORY_FAIL_TTL_MS = 60_000
const HEADER_TTL_MS = 30_000
const QUIET_PAGE_LOGS = 1_500
const BUSY_PAGE_LOGS = 4_000
const DECIMALS_SELECTOR = '0x313ce567'

export type V4HistoryResult = {
  ok: boolean
  code: V4SwapGapCode | 'invalid_request' | null
  poolId: string
  intervalSec: number
  /** Genuine hourly swap candles strictly before `windowEndSec`, ascending. Hours with no trade are absent. */
  candles: EvmChartPoint[]
  /** Older swaps may exist before `nextBeforeSec` (false once the pool's creation block is reached). */
  hasMore: boolean
  /** Cursor for the next (older) request: every block from here up to windowEndSec was read. */
  nextBeforeSec: number | null
  windowEndSec: number
  timeResolution: V4TimeResolution | null
  logsFound: number
  tradesUsed: number
  callsUsed: number
  pagesFetched: number
  stopReason: string | null
  quote: { source: 'usd_stable' | 'eth_usd_series' | 'independent_pool' | null; evidence: 'verified' | 'unavailable'; maxGapMs: number | null; reason: string | null } | null
  cache: { result: boolean; header: boolean; initialize: boolean; decimals: boolean; quote: boolean }
}

export type V4HistoryDeps = {
  rpc: V4SwapDeps['rpc']
  /** Real ETH/USD over [fromSec, toSec] (hourly), cached per window. */
  ethUsdRange?: (fromSec: number, toSec: number, timeoutMs: number) => Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }>
  /** The quote token's independent-pool USD history over [fromSec, toSec] (lib/server/v4QuoteUsd.ts resolveIndependentQuoteUsdWindow). */
  quoteUsdWindow?: (input: { quoteToken: string; scannedToken: string; excludePool: string; anchors: ReadonlySet<string>; fromSec: number; toSec: number; budget: number; deadlineMs: number }) => Promise<QuoteUsdResult>
  now?: () => number
}

/**
 * Older hourly candles for exactly this V4 PoolId, strictly before `beforeSec`. Only ever called from
 * the interactive chart-candles endpoint — never during a scan. Bounded: <= 3 log pages, <= 6,000 logs,
 * <= 8 calls, 9s; cached per (pool, token, hour-aligned cursor); concurrent identical requests share one read.
 */
export async function loadV4SwapHistoryWindow(
  input: { chain: string; poolId: string; token: string; beforeSec: number },
  deps: V4HistoryDeps,
): Promise<V4HistoryResult> {
  const now = deps.now ?? Date.now
  const poolId = String(input.poolId ?? '').toLowerCase()
  const token = String(input.token ?? '').toLowerCase()
  const beforeSec = Math.floor(Number(input.beforeSec) / 3600) * 3600
  const base: V4HistoryResult = {
    ok: false, code: null, poolId, intervalSec: V4_HISTORY_INTERVAL_SEC, candles: [], hasMore: true, nextBeforeSec: null, windowEndSec: beforeSec,
    timeResolution: null, logsFound: 0, tradesUsed: 0, callsUsed: 0, pagesFetched: 0, stopReason: null, quote: null,
    cache: { result: false, header: false, initialize: false, decimals: false, quote: false },
  }
  const cfg = V4_SWAP_CHAIN_CONFIG[input.chain]
  if (!cfg) return { ...base, code: 'v4_chain_not_supported', hasMore: false }
  const nowSec = Math.floor(now() / 1000)
  if (!/^0x[a-f0-9]{64}$/.test(poolId) || !/^0x[a-f0-9]{40}$/.test(token) || !Number.isFinite(beforeSec) || beforeSec > nowSec + 3600 || beforeSec < nowSec - V4_HISTORY_MAX_AGE_SEC) {
    return { ...base, code: 'invalid_request', hasMore: false }
  }
  const key = `${input.chain}:${poolId}:${token}:${beforeSec}`
  const hit = historyCache.get(key)
  if (hit && hit.expiresAt > now()) return { ...hit.value, callsUsed: 0, pagesFetched: 0, cache: { ...hit.value.cache, result: true } }
  const running = historyInflight.get(key)
  if (running) return running
  const p = readHistoryWindow({ chain: input.chain, poolId, token, beforeSec }, cfg, base, deps, now).then((v) => {
    if (v.code !== 'call_budget_exhausted') {
      bounded(historyCache)
      historyCache.set(key, { expiresAt: now() + (v.ok ? HISTORY_OK_TTL_MS : HISTORY_FAIL_TTL_MS), value: v })
    }
    return v
  }).finally(() => historyInflight.delete(key))
  historyInflight.set(key, p)
  return p
}

async function readHistoryWindow(
  input: { chain: string; poolId: string; token: string; beforeSec: number },
  cfg: V4ChainConfig,
  base: V4HistoryResult,
  deps: V4HistoryDeps,
  now: () => number,
): Promise<V4HistoryResult> {
  const { poolId, token, beforeSec } = input
  const r: V4HistoryResult = { ...base, cache: { ...base.cache } }
  const fail = (code: V4SwapGapCode, stopReason: string | null = r.stopReason): V4HistoryResult => ({ ...r, ok: false, code, stopReason })
  const deadline = now() + V4_HISTORY_DEADLINE_MS
  const canCall = (reserve = 0): boolean => {
    if (r.callsUsed + reserve >= V4_HISTORY_MAX_CALLS) { r.stopReason = 'call_budget'; return false }
    if (now() >= deadline) { r.stopReason = 'deadline'; return false }
    return true
  }
  const rpc = async (method: string, params: unknown[]) => {
    r.callsUsed++
    return deps.rpc(method, params, Math.min(RPC_TIMEOUT_MS + 1_000, Math.max(1, deadline - now())))
  }

  // 1. Latest block + real timestamp (shared 30s per chain): maps the time cursor onto Base's fixed 2s blocks.
  let header = headerCache.get(input.chain)
  if (header && header.expiresAt > now()) r.cache.header = true
  else {
    if (!canCall()) return fail('call_budget_exhausted')
    const res = await rpc('eth_getBlockByNumber', ['latest', false])
    const b = res.result as { number?: string; timestamp?: string } | null
    if (res.error || !b?.number || !b?.timestamp) return fail('v4_swap_logs_unavailable', 'rpc_error')
    header = { expiresAt: now() + HEADER_TTL_MS, block: Number(BigInt(b.number)), ts: Number(BigInt(b.timestamp)) }
    headerCache.set(input.chain, header)
  }
  const blockTs = (block: number) => header!.ts - (header!.block - block) * cfg.blockTimeSec

  // 2. Pool key from its own Initialize event (shared 24h cache with the scan).
  let key: V4PoolKey | null = null
  const cachedInit = initCache.get(`${input.chain}:${poolId}`)
  if (cachedInit && cachedInit.expiresAt > now()) { key = cachedInit.key; r.cache.initialize = true }
  else {
    if (!canCall()) return fail('call_budget_exhausted')
    const res = await rpc('eth_getLogs', [{ address: cfg.poolManager, topics: [V4_INITIALIZE_TOPIC0, poolId], fromBlock: '0x0', toBlock: toHex(header.block) }])
    if (res.error || !Array.isArray(res.result)) return fail('v4_swap_logs_unavailable', 'rpc_error')
    key = (res.result as RawEvmLog[]).filter((l) => l.removed !== true).map((l) => decodeV4Initialize(l, poolId)).find((k) => k != null) ?? null
    if (!key) return { ...fail('v4_swap_logs_unavailable'), hasMore: false }
    bounded(initCache)
    initCache.set(`${input.chain}:${poolId}`, { expiresAt: now() + INIT_TTL_MS, key })
  }
  const tokenIsCurrency0 = key.currency0 === token
  if (!tokenIsCurrency0 && key.currency1 !== token) return { ...fail('token_side_unresolved'), hasMore: false }
  const counter = tokenIsCurrency0 ? key.currency1 : key.currency0
  const counterEthDec = cfg.ethLike[counter]
  const counterUsdDec = cfg.usdStable[counter]
  const counterKind: 'eth' | 'usd_stable' | 'other' = counterEthDec != null ? 'eth' : counterUsdDec != null ? 'usd_stable' : 'other'
  if (counterKind === 'eth' && !deps.ethUsdRange) return { ...fail('quote_usd_price_unproven'), quote: { source: 'eth_usd_series', evidence: 'unavailable', maxGapMs: null, reason: 'no_eth_usd_source' } }
  if (counterKind === 'other' && !deps.quoteUsdWindow) return { ...fail('quote_usd_price_unproven'), quote: { source: 'independent_pool', evidence: 'unavailable', maxGapMs: null, reason: 'no_independent_quote_source' } }

  // 3. Scanned-token decimals: the scan's own value when this instance has it, else one decimals() read.
  let tokenDecimals: number | null = token === NATIVE ? 18 : null
  const cachedDec = decimalsCache.get(`${input.chain}:${token}`)
  if (tokenDecimals == null && cachedDec && cachedDec.expiresAt > now()) { tokenDecimals = cachedDec.decimals; r.cache.decimals = true }
  if (tokenDecimals == null) {
    if (!canCall()) return fail('call_budget_exhausted')
    const res = await rpc('eth_call', [{ to: token, data: DECIMALS_SELECTOR }, 'latest'])
    const hex = typeof res.result === 'string' && /^0x[0-9a-f]+$/i.test(res.result) ? Number(BigInt(res.result)) : null
    if (res.error || hex == null || !Number.isInteger(hex) || hex < 0 || hex > 36) return fail('token_side_unresolved', 'decimals_unavailable')
    tokenDecimals = hex
    bounded(decimalsCache)
    decimalsCache.set(`${input.chain}:${token}`, { expiresAt: now() + INIT_TTL_MS, decimals: hex })
  }

  // 4. Swap logs for exactly this PoolId, strictly before the cursor, newest first; adaptive page size.
  const quoteReserve = counterKind === 'usd_stable' ? 0 : counterKind === 'eth' ? 1 : 2
  const cursorBlock = header.block - Math.ceil((header.ts - beforeSec + 1) / cfg.blockTimeSec)
  if (cursorBlock < key.initBlock) return { ...r, ok: true, code: null, hasMore: false, nextBeforeSec: null, stopReason: 'pool_creation' }
  const swaps: V4Swap[] = []
  let toBlock = Math.min(header.block, cursorBlock)
  let size = V4_HISTORY_FIRST_PAGE_BLOCKS
  let capped = false
  let anyPage = false
  while (toBlock >= key.initBlock) {
    if (r.pagesFetched >= V4_HISTORY_MAX_PAGES) { r.stopReason = 'page_cap'; break }
    if (!canCall(quoteReserve)) break
    const fromBlock = Math.max(key.initBlock, toBlock - size + 1)
    r.pagesFetched++
    const page = await rpc('eth_getLogs', [{ address: cfg.poolManager, topics: [V4_SWAP_TOPIC0, poolId], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }])
    if (page.error || !Array.isArray(page.result)) {
      // Too wide for the node (or a transient error): one smaller page next, never a retry loop.
      if (size > V4_HISTORY_MIN_PAGE_BLOCKS) { size = Math.max(V4_HISTORY_MIN_PAGE_BLOCKS, Math.floor(size / 4)); continue }
      r.stopReason = 'rpc_error'
      break
    }
    anyPage = true
    const decoded = decodePageNewestFirst(page.result as RawEvmLog[], poolId)
    for (const s of decoded) {
      if (swaps.length >= V4_HISTORY_MAX_LOGS) { capped = true; break }
      swaps.push(s)
    }
    if (capped) { r.stopReason = 'log_cap'; break }
    toBlock = fromBlock - 1
    size = decoded.length < QUIET_PAGE_LOGS ? Math.min(V4_HISTORY_MAX_PAGE_BLOCKS, size * 2) : decoded.length > BUSY_PAGE_LOGS ? Math.max(V4_HISTORY_MIN_PAGE_BLOCKS, Math.floor(size / 2)) : size
  }
  r.logsFound = swaps.length
  if (!anyPage) return fail(r.stopReason === 'call_budget' ? 'call_budget_exhausted' : 'v4_swap_logs_unavailable')

  // Exact times only if every swap log carries its own block timestamp; otherwise inferred from the header.
  const exact = swaps.length > 0 && swaps.every((s) => s.blockTimestamp != null)
  r.timeResolution = swaps.length === 0 ? null : exact ? 'exact_log_timestamps' : 'inferred_block_time'
  let timed = swaps.map((s) => ({ ...s, timestampSec: exact ? s.blockTimestamp! : blockTs(s.blockNumber) })).filter((s) => s.timestampSec < beforeSec)

  // Cursor: everything from the oldest fully-read block up to the window end is covered. A partial
  // oldest hour (log cap / page boundary) is dropped and re-read by the next request — never shown short.
  const reachedCreation = !capped && toBlock < key.initBlock
  let coveredFromSec: number
  if (capped) {
    const oldestTs = timed.length > 0 ? Math.min(...timed.map((s) => s.timestampSec)) : beforeSec
    coveredFromSec = Math.floor(oldestTs / 3600) * 3600 + 3600
  } else {
    coveredFromSec = reachedCreation ? 0 : Math.ceil(blockTs(toBlock + 1) / 3600) * 3600
  }
  if (!reachedCreation) timed = timed.filter((s) => s.timestampSec >= coveredFromSec)
  r.hasMore = !reachedCreation && coveredFromSec > Math.floor(now() / 1000) - V4_HISTORY_MAX_AGE_SEC
  r.nextBeforeSec = r.hasMore ? Math.min(coveredFromSec, beforeSec - 3600) : null
  if (timed.length === 0) return { ...r, ok: true, code: null, candles: [] }

  // 5. Quote USD over exactly this window.
  const fromSec = Math.min(...timed.map((s) => s.timestampSec))
  const toSec = Math.max(...timed.map((s) => s.timestampSec))
  let counterDecimals: number | null = (counterEthDec ?? counterUsdDec) ?? null
  let series: Array<[number, number]> | null = null
  if (counterKind === 'eth') {
    if (now() >= deadline) return { ...fail('quote_usd_price_unproven', 'deadline'), hasMore: r.hasMore }
    const eth = await deps.ethUsdRange!(fromSec - 3600, toSec + 3600, Math.max(1, deadline - now()))
    if (!eth.cacheHit) r.callsUsed++
    r.cache.quote = eth.cacheHit
    series = eth.points
    r.quote = { source: 'eth_usd_series', evidence: series ? 'verified' : 'unavailable', maxGapMs: null, reason: series ? null : 'eth_usd_series_unavailable' }
  } else if (counterKind === 'other') {
    const q = await deps.quoteUsdWindow!({
      quoteToken: counter, scannedToken: token, excludePool: poolId,
      anchors: new Set([...Object.keys(cfg.ethLike), ...Object.keys(cfg.usdStable)]),
      fromSec: fromSec - 3600, toSec: toSec + 3600,
      budget: Math.max(0, V4_HISTORY_MAX_CALLS - r.callsUsed), deadlineMs: deadline,
    })
    r.callsUsed += q.callsUsed
    r.cache.quote = q.cache.series
    counterDecimals = q.quoteDecimals
    series = q.ok ? q.points : null
    r.quote = { source: 'independent_pool', evidence: series ? 'verified' : 'unavailable', maxGapMs: null, reason: q.detail }
  } else {
    r.quote = { source: 'usd_stable', evidence: 'verified', maxGapMs: null, reason: null }
  }
  if (counterDecimals == null || (counterKind !== 'usd_stable' && (!series || series.length === 0))) return { ...fail('quote_usd_price_unproven'), hasMore: r.hasMore, nextBeforeSec: r.nextBeforeSec }
  let maxGapMs = 0
  const counterUsdAt = !series ? () => 1 : (tsMs: number) => {
    const hitPt = nearestPriceWithGap(series!, tsMs, V4_HISTORY_QUOTE_MAX_GAP_MS)
    if (!hitPt) return null
    maxGapMs = Math.max(maxGapMs, hitPt.gapMs)
    return hitPt.price
  }

  // 6. Genuine hourly OHLCV from real trades only.
  const built = buildV4SwapCandles({
    swaps: timed, tokenIsCurrency0,
    decimals0: tokenIsCurrency0 ? tokenDecimals : counterDecimals,
    decimals1: tokenIsCurrency0 ? counterDecimals : tokenDecimals,
    counterUsdAt, intervalSec: V4_HISTORY_INTERVAL_SEC,
  })
  r.tradesUsed = built.tradesUsed
  r.quote = { ...r.quote!, maxGapMs: counterKind === 'usd_stable' ? null : maxGapMs }
  if (built.tradesUsed === 0 && counterKind !== 'usd_stable') return { ...fail('quote_usd_price_unproven'), quote: { ...r.quote!, evidence: 'unavailable', reason: 'no_quote_usd_point_within_45m_of_any_trade' }, hasMore: r.hasMore, nextBeforeSec: r.nextBeforeSec }
  return { ...r, ok: true, code: null, candles: built.candles }
}
