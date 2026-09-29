// lib/server/v4QuoteUsd.ts — independent historical USD evidence for a Uniswap V4 pool's OTHER asset
// when it is neither ETH/WETH nor a verified USD stablecoin (e.g. BANKAT / BNKR: BNKR/USD over time).
//
// ONE conversion hop only:  scannedTokenUsd(t) = scannedTokenPerQuote(t) × quoteUsd(t)
// where quoteUsd(t) comes from a DIFFERENT, ordinary (20-byte address) pool of the quote token paired
// directly with WETH or a verified USD stablecoin, read as that pool's own genuine historical USD
// candles (token side verified). Never the V4 pool being priced, never a pool that also contains the
// scanned token (its quote price would be derived from the scanned token itself), never a quote pool
// paired with some third token (no TOKEN -> A -> B -> USD chains), never a current price backfilled
// over history.
//
// Cost: 1 pool-discovery read (cached 24h per chain + quote token) + 1 historical candle read (cached
// per 10-minute slot per chain + quote token, shared across scans). Warm: 0 calls.
// On-demand chart history (resolveIndependentQuoteUsdWindow): the SAME discovery + one hourly candle
// read of that pool ending at the window's end (before_timestamp), cached per window.

import { EVM_POOL_ADDRESS_RE, classifyOhlcvResponse, coingeckoMetaTokenSide } from '../evmChartCandles.ts'

export const QUOTE_POOL_MIN_LIQUIDITY_USD = 25_000
export const QUOTE_SERIES_SLOT_SEC = 600
export const QUOTE_SERIES_REQUEST = { resolution: 'minute' as const, aggregate: 5, limit: 290 } // 24h10m of 5m candles (the V4 reader's 24h window)
/** On-demand history windows: hourly candles of the same independent pool, ending at the window's end. */
export const QUOTE_HISTORY_MAX_HOURS = 400
const DISCOVERY_TTL_MS = 24 * 3_600_000
const DISCOVERY_FAIL_TTL_MS = 10 * 60_000
const CACHE_MAX = 500

export type QuotePoolChoice = { pool: string; side: 'base' | 'quote'; pairedWith: string; quoteSymbol: string | null; quoteDecimals: number; liquidityUsd: number }

export type QuoteUsdResult = {
  ok: boolean
  reason: 'quote_usd_price_unproven' | 'call_budget_exhausted' | null
  /** Why the quote lane failed, in detail (for debug). */
  detail: string | null
  quoteSymbol: string | null
  quoteDecimals: number | null
  pool: string | null
  pairedWith: string | null
  points: Array<[number, number]>
  callsUsed: number
  cache: { discovery: boolean; series: boolean }
}

export type QuoteUsdDeps = {
  /** GeckoTerminal-shaped `/networks/{net}/tokens/{token}/pools?include=base_token,quote_token`. */
  fetchTokenPools: (chain: string, token: string, timeoutMs: number) => Promise<{ json: unknown; httpStatus: number | null }>
  /** A pool's genuine historical USD candles for `side` (minute / 5 / 290). */
  fetchPoolUsdOhlcv: (chain: string, pool: string, side: 'base' | 'quote', timeoutMs: number) => Promise<{ json: unknown; httpStatus: number | null }>
  now?: () => number
}

export type QuoteUsdWindowDeps = {
  fetchTokenPools: QuoteUsdDeps['fetchTokenPools']
  /** A pool's genuine hourly USD candles for `side`, `limit` rows strictly before `beforeSec`. */
  fetchPoolUsdOhlcvBefore: (chain: string, pool: string, side: 'base' | 'quote', req: { resolution: 'hour'; aggregate: 1; limit: number }, beforeSec: number, timeoutMs: number) => Promise<{ json: unknown; httpStatus: number | null }>
  now?: () => number
}

const discoveryCache = new Map<string, { expiresAt: number; value: QuotePoolChoice | null; detail: string | null }>()
const seriesCache = new Map<string, { slot: number; points: Array<[number, number]> | null; detail: string | null }>()
const windowCache = new Map<string, { expiresAt: number; points: Array<[number, number]> | null; detail: string | null }>()
const WINDOW_TTL_MS = 6 * 3_600_000
const WINDOW_FAIL_TTL_MS = 60_000
export function resetQuoteUsdCache() {
  discoveryCache.clear()
  seriesCache.clear()
  windowCache.clear()
}
const bounded = <K, V>(m: Map<K, V>) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!) }

const idAddress = (id: unknown): string | null => {
  const s = String(id ?? '')
  const hex = (s.includes('_') ? s.slice(s.indexOf('_') + 1) : s).toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(hex) ? hex : null
}

/**
 * Picks the most liquid ordinary pool that pairs `quoteToken` DIRECTLY with one of `anchors` (WETH /
 * verified USD stables), on a verified side, excluding the V4 pool being priced and any pool that
 * contains the scanned token. Pure — exported for tests.
 */
export function selectIndependentQuotePool(json: unknown, input: { quoteToken: string; scannedToken: string; excludePool: string; anchors: ReadonlySet<string> }): { choice: QuotePoolChoice | null; detail: string | null } {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { choice: null, detail: 'quote_pool_discovery_schema_invalid' }
  const included = (json as { included?: unknown } | null)?.included
  const tokenAttrs = new Map<string, Record<string, unknown>>()
  if (Array.isArray(included)) for (const inc of included as Array<Record<string, unknown>>) if (inc?.type === 'token') tokenAttrs.set(String(inc.id ?? '').toLowerCase(), (inc.attributes ?? {}) as Record<string, unknown>)
  const quote = input.quoteToken.toLowerCase()
  const scanned = input.scannedToken.toLowerCase()
  const exclude = input.excludePool.toLowerCase()
  let best: QuotePoolChoice | null = null
  let sawAny = false
  for (const p of data as Array<Record<string, unknown>>) {
    const attrs = (p.attributes ?? {}) as Record<string, unknown>
    const address = typeof attrs.address === 'string' ? attrs.address.toLowerCase() : null
    const fromId = idAddress(p.id)
    // Ordinary 20-byte pool only, whose id and address agree (no pool-id / PoolManager ambiguity).
    if (!address || !EVM_POOL_ADDRESS_RE.test(address) || fromId !== address || address === exclude) continue
    const rel = (p.relationships ?? {}) as Record<string, { data?: { id?: unknown } }>
    const baseId = String(rel.base_token?.data?.id ?? '').toLowerCase()
    const quoteId = String(rel.quote_token?.data?.id ?? '').toLowerCase()
    const baseAddr = idAddress(baseId)
    const quoteAddr = idAddress(quoteId)
    if (!baseAddr || !quoteAddr) continue
    const side: 'base' | 'quote' | null = baseAddr === quote ? 'base' : quoteAddr === quote ? 'quote' : null
    if (!side) continue
    sawAny = true
    const other = side === 'base' ? quoteAddr : baseAddr
    if (other === scanned || !input.anchors.has(other)) continue
    const liq = Number(attrs.reserve_in_usd)
    if (!Number.isFinite(liq) || liq < QUOTE_POOL_MIN_LIQUIDITY_USD) continue
    const qAttrs = tokenAttrs.get(side === 'base' ? baseId : quoteId) ?? {}
    const dec = Number(qAttrs.decimals)
    if (!Number.isInteger(dec) || dec < 0 || dec > 36) continue
    if (!best || liq > best.liquidityUsd) best = { pool: address, side, pairedWith: other, quoteSymbol: typeof qAttrs.symbol === 'string' ? qAttrs.symbol : null, quoteDecimals: dec, liquidityUsd: liq }
  }
  return { choice: best, detail: best ? null : sawAny ? 'no_independent_quote_pool_with_eth_or_stable_liquidity' : 'no_quote_token_pool_found' }
}

/** Genuine historical USD points ([bucket end ms, close]) from a pool's candles, only if its meta (when present) agrees on the side. */
export function quoteSeriesFromCandles(json: unknown, httpStatus: number | null, quoteToken: string, side: 'base' | 'quote', intervalSec: number): { points: Array<[number, number]> | null; detail: string | null } {
  const { code, normalized } = classifyOhlcvResponse('pool', httpStatus, json)
  if (code !== 'ok') return { points: null, detail: `quote_series_${code}` }
  if ((json as { meta?: unknown } | null)?.meta && coingeckoMetaTokenSide(json, quoteToken) !== side) return { points: null, detail: 'quote_series_side_mismatch' }
  return { points: normalized.points.map((p) => [Date.parse(p.timestamp) + intervalSec * 1000, p.close] as [number, number]), detail: null }
}

export async function resolveIndependentQuoteUsd(
  input: { chain: string; quoteToken: string; scannedToken: string; excludePool: string; anchors: ReadonlySet<string>; budget: number; deadlineMs: number },
  deps: QuoteUsdDeps,
): Promise<QuoteUsdResult> {
  const now = deps.now ?? Date.now
  const quote = input.quoteToken.toLowerCase()
  const out: QuoteUsdResult = { ok: false, reason: 'quote_usd_price_unproven', detail: null, quoteSymbol: null, quoteDecimals: null, pool: null, pairedWith: null, points: [], callsUsed: 0, cache: { discovery: false, series: false } }
  const timeout = () => Math.max(1, input.deadlineMs - now())
  const canCall = () => out.callsUsed < input.budget && now() < input.deadlineMs

  // 1. Independent quote pool (cached 24h; a failed discovery is cached 10 min).
  const found = await discoverQuotePool(input, deps.fetchTokenPools, out, canCall, timeout, now)
  if (!found) return out.reason === 'call_budget_exhausted' ? out : { ...out, reason: 'quote_usd_price_unproven' }
  const choice = found
  Object.assign(out, { quoteSymbol: choice.quoteSymbol, quoteDecimals: choice.quoteDecimals, pool: choice.pool, pairedWith: choice.pairedWith })

  // 2. That pool's genuine historical USD candles (one read per 10-minute slot, shared).
  const slot = Math.floor(now() / 1000 / QUOTE_SERIES_SLOT_SEC) * QUOTE_SERIES_SLOT_SEC
  const sKey = `${input.chain}:${quote}:${choice.pool}`
  const s = seriesCache.get(sKey)
  let points: Array<[number, number]> | null
  if (s && s.slot === slot) {
    out.cache.series = true
    points = s.points
    out.detail = s.detail
  } else {
    if (!canCall()) return { ...out, reason: 'call_budget_exhausted', detail: 'call_budget' }
    out.callsUsed++
    const res = await deps.fetchPoolUsdOhlcv(input.chain, choice.pool, choice.side, timeout())
    const series = quoteSeriesFromCandles(res.json, res.httpStatus, quote, choice.side, QUOTE_SERIES_REQUEST.aggregate * 60)
    points = series.points
    out.detail = series.detail
    bounded(seriesCache)
    seriesCache.set(sKey, { slot, points, detail: series.detail })
  }
  if (!points || points.length < 2) return { ...out, detail: out.detail ?? 'quote_series_too_short' }
  return { ...out, ok: true, reason: null, detail: null, points }
}

type DiscoveryInput = { chain: string; quoteToken: string; scannedToken: string; excludePool: string; anchors: ReadonlySet<string> }

/** Cached independent-pool discovery shared by the live and the windowed lanes. Mutates `out` (calls, cache, detail, reason). */
async function discoverQuotePool(
  input: DiscoveryInput,
  fetchTokenPools: QuoteUsdDeps['fetchTokenPools'],
  out: QuoteUsdResult,
  canCall: () => boolean,
  timeout: () => number,
  now: () => number,
): Promise<QuotePoolChoice | null> {
  const quote = input.quoteToken.toLowerCase()
  const dKey = `${input.chain}:${quote}:${input.scannedToken.toLowerCase()}:${input.excludePool.toLowerCase()}`
  const d = discoveryCache.get(dKey)
  if (d && d.expiresAt > now()) {
    out.cache.discovery = true
    if (!d.value) out.detail = d.detail
    return d.value
  }
  if (!canCall()) { out.reason = 'call_budget_exhausted'; out.detail = 'call_budget'; return null }
  out.callsUsed++
  const res = await fetchTokenPools(input.chain, quote, timeout())
  const sel = res.httpStatus != null && res.httpStatus >= 200 && res.httpStatus < 300
    ? selectIndependentQuotePool(res.json, { quoteToken: quote, scannedToken: input.scannedToken, excludePool: input.excludePool, anchors: input.anchors })
    : { choice: null, detail: `quote_pool_discovery_http_${res.httpStatus ?? 'error'}` }
  bounded(discoveryCache)
  discoveryCache.set(dKey, { expiresAt: now() + (sel.choice ? DISCOVERY_TTL_MS : DISCOVERY_FAIL_TTL_MS), value: sel.choice, detail: sel.detail })
  if (!sel.choice) out.detail = sel.detail
  return sel.choice
}

/**
 * On-demand chart history: the quote token's genuine USD history over [fromSec, toSec] from the SAME
 * independent pool (hourly candles ending at the window's end). Called only after the user asks for
 * older candles. Cost: discovery (usually cached) + 1 candle read per window (cached 6h).
 */
export async function resolveIndependentQuoteUsdWindow(
  input: DiscoveryInput & { fromSec: number; toSec: number; budget: number; deadlineMs: number },
  deps: QuoteUsdWindowDeps,
): Promise<QuoteUsdResult> {
  const now = deps.now ?? Date.now
  const out: QuoteUsdResult = { ok: false, reason: 'quote_usd_price_unproven', detail: null, quoteSymbol: null, quoteDecimals: null, pool: null, pairedWith: null, points: [], callsUsed: 0, cache: { discovery: false, series: false } }
  const timeout = () => Math.max(1, input.deadlineMs - now())
  const canCall = () => out.callsUsed < input.budget && now() < input.deadlineMs
  const choice = await discoverQuotePool(input, deps.fetchTokenPools, out, canCall, timeout, now)
  if (!choice) return out.reason === 'call_budget_exhausted' ? out : { ...out, reason: 'quote_usd_price_unproven' }
  Object.assign(out, { quoteSymbol: choice.quoteSymbol, quoteDecimals: choice.quoteDecimals, pool: choice.pool, pairedWith: choice.pairedWith })

  const beforeSec = Math.ceil(input.toSec / 3600) * 3600
  const fromSec = Math.floor(input.fromSec / 3600) * 3600
  const limit = Math.min(QUOTE_HISTORY_MAX_HOURS, Math.max(2, (beforeSec - fromSec) / 3600 + 1))
  const wKey = `${input.chain}:${input.quoteToken.toLowerCase()}:${choice.pool}:${beforeSec}:${limit}`
  const w = windowCache.get(wKey)
  let points: Array<[number, number]> | null
  if (w && w.expiresAt > now()) {
    out.cache.series = true
    points = w.points
    out.detail = w.detail
  } else {
    if (!canCall()) return { ...out, reason: 'call_budget_exhausted', detail: 'call_budget' }
    out.callsUsed++
    const res = await deps.fetchPoolUsdOhlcvBefore(input.chain, choice.pool, choice.side, { resolution: 'hour', aggregate: 1, limit }, beforeSec, timeout())
    const series = quoteSeriesFromCandles(res.json, res.httpStatus, input.quoteToken.toLowerCase(), choice.side, 3600)
    points = series.points
    out.detail = series.detail
    bounded(windowCache)
    windowCache.set(wKey, { expiresAt: now() + (points ? WINDOW_TTL_MS : WINDOW_FAIL_TTL_MS), points, detail: series.detail })
  }
  if (!points || points.length < 2) return { ...out, detail: out.detail ?? 'quote_series_too_short' }
  return { ...out, ok: true, reason: null, detail: null, points }
}
