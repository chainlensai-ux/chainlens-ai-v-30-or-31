// lib/server/coingeckoOnchainOhlcv.ts — SERVER-ONLY CoinGecko on-chain pool OHLCV reader, the primary
// historical candle source for EVM Token Scanner charts (see lib/evmChartCandles.ts).
//
//   GET {https://api.coingecko.com/api/v3 | https://pro-api.coingecko.com/api/v3}
//       /onchain/networks/{network}/pools/{pool}/ohlcv/{minute|hour|day}
//       ?aggregate=&limit=&currency=usd&token=&include_empty_intervals=false
//
// Host and key header (x-cg-demo-api-key by default, x-cg-pro-api-key when COINGECKO_API_TIER=pro)
// come from the one shared resolver the rest of the app uses. This is the ONLY candle-path module
// that reads COINGECKO_API_KEY: it goes into a request header and nowhere else — never into a URL,
// a log line, a return value, or an error message. Callers only ever see { json, httpStatus }.

import { COINGECKO_ONCHAIN_NETWORK, isEvmPoolIdentifier } from '../evmChartCandles.ts'
import { resolveCoingeckoRuntimeConfig } from '../../src/modules/pricingAtTimeEngine/sources/coingecko.ts'

export type CoingeckoOhlcvRequest = { resolution: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }
export type CoingeckoFetchImpl = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>

const TOKEN_RE = /^(base|quote|0x[a-fA-F0-9]{40})$/

/** True only when a key is set and COINGECKO_API_TIER (if set) is valid — otherwise no request is made. */
export function isCoingeckoOnchainConfigured(): boolean {
  const cfg = resolveCoingeckoRuntimeConfig()
  return cfg.keyConfigured && cfg.configurationValid
}

/** CoinGecko on-chain network id for a chain key, or null when this chain is not routed to CoinGecko. */
export function coingeckoOnchainNetwork(chain: string): string | null {
  return COINGECKO_ONCHAIN_NETWORK[chain] ?? null
}

/** Path + query only (no host, no key). `token` is 'base' | 'quote' | a 0x token address. */
export function coingeckoOnchainOhlcvPath(network: string, pool: string, req: CoingeckoOhlcvRequest, token: string, beforeSec?: number | null): string {
  const qs = new URLSearchParams({
    aggregate: String(req.aggregate),
    limit: String(req.limit),
    currency: 'usd',
    token,
    include_empty_intervals: 'false',
  })
  // Historical window cursor (on-demand chart history only): candles strictly before this time.
  if (beforeSec != null && Number.isInteger(beforeSec) && beforeSec > 0) qs.set('before_timestamp', String(beforeSec))
  return `/onchain/networks/${network}/pools/${pool.toLowerCase()}/ohlcv/${req.resolution}?${qs.toString()}`
}

const defaultFetch: CoingeckoFetchImpl = (url, init) =>
  fetch(url, { headers: init.headers, cache: 'no-store', signal: AbortSignal.timeout(5000) })

/**
 * One CoinGecko pool OHLCV read. Returns { json: null, httpStatus: null } without calling out when
 * the chain isn't routed to CoinGecko, the key isn't configured, or the inputs aren't well-formed.
 */
export async function fetchCoingeckoOnchainPoolOhlcv(
  chain: string,
  pool: string,
  req: CoingeckoOhlcvRequest,
  token: string,
  fetchImpl: CoingeckoFetchImpl = defaultFetch,
  beforeSec: number | null = null,
): Promise<{ json: unknown; httpStatus: number | null }> {
  const network = coingeckoOnchainNetwork(chain)
  const cfg = resolveCoingeckoRuntimeConfig()
  const key = process.env.COINGECKO_API_KEY
  if (!network || !key || !cfg.configurationValid || !isEvmPoolIdentifier(pool) || !TOKEN_RE.test(token)) return { json: null, httpStatus: null }
  try {
    const res = await fetchImpl(`${cfg.selectedBaseUrl}${coingeckoOnchainOhlcvPath(network, pool, req, token, beforeSec)}`, {
      headers: { Accept: 'application/json', [cfg.selectedHeaderName]: key },
    })
    return { json: res.ok ? await res.json().catch(() => null) : null, httpStatus: res.status }
  } catch {
    return { json: null, httpStatus: null }
  }
}

// ── Historical ETH/USD (quote pricing for ETH/WETH-paired Uniswap V4 swap candles) ────────────────
// ONE shared rolling series for every V4 scan: /coins/ethereum/market_chart/range over exactly the
// last 24h (a 1-day range ending now, which CoinGecko serves at 5-minute granularity; with the 15-min
// quote tolerance it covers the V4 reader's 24h initial swap window), anchored to a 10-minute slot
// and cached for that slot, so at most one request per 10 minutes per server instance regardless of
// how many V4 tokens are scanned. Returns [ms, usd] points only — never the key, headers or the raw
// body. Older on-demand history windows use fetchCoingeckoEthUsdRange below (hourly granularity).
export const ETH_USD_SERIES_WINDOW_SEC = 24 * 3600
export const ETH_USD_SERIES_SLOT_SEC = 600
/** Native assets whose CoinGecko coin id may be requested (a fixed allow-list — never user input). */
export const NATIVE_USD_COIN_IDS = ['ethereum', 'binancecoin'] as const
export type NativeUsdCoinId = (typeof NATIVE_USD_COIN_IDS)[number]
const nativeUsdSeries = new Map<string, { slot: number; points: Array<[number, number]> | null; httpStatus: number | null }>()

export async function fetchCoingeckoEthUsdRecent(
  timeoutMs: number,
  fetchImpl?: CoingeckoFetchImpl,
  now: () => number = Date.now,
): Promise<{ points: Array<[number, number]> | null; httpStatus: number | null; cacheHit: boolean }> {
  return fetchCoingeckoNativeUsdRecent('ethereum', timeoutMs, fetchImpl, now)
}

/** The same shared, slot-cached 24h series for any allow-listed native coin (ETH, BNB). */
export async function fetchCoingeckoNativeUsdRecent(
  coinId: string,
  timeoutMs: number,
  fetchImpl: CoingeckoFetchImpl = (url, init) => fetch(url, { headers: init.headers, cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, timeoutMs)) }),
  now: () => number = Date.now,
): Promise<{ points: Array<[number, number]> | null; httpStatus: number | null; cacheHit: boolean }> {
  if (!(NATIVE_USD_COIN_IDS as readonly string[]).includes(coinId)) return { points: null, httpStatus: null, cacheHit: false }
  const slot = Math.floor(now() / 1000 / ETH_USD_SERIES_SLOT_SEC) * ETH_USD_SERIES_SLOT_SEC
  const ethUsdSeries = nativeUsdSeries.get(coinId)
  if (ethUsdSeries && ethUsdSeries.slot === slot) return { points: ethUsdSeries.points, httpStatus: ethUsdSeries.httpStatus, cacheHit: true }
  const cfg = resolveCoingeckoRuntimeConfig()
  const key = process.env.COINGECKO_API_KEY
  if (!key || !cfg.configurationValid) return { points: null, httpStatus: null, cacheHit: false }
  let value: { points: Array<[number, number]> | null; httpStatus: number | null }
  try {
    const qs = new URLSearchParams({ vs_currency: 'usd', from: String(slot + ETH_USD_SERIES_SLOT_SEC - ETH_USD_SERIES_WINDOW_SEC), to: String(slot + ETH_USD_SERIES_SLOT_SEC) })
    const res = await fetchImpl(`${cfg.selectedBaseUrl}/coins/${coinId}/market_chart/range?${qs.toString()}`, {
      headers: { Accept: 'application/json', [cfg.selectedHeaderName]: key },
    })
    const json = res.ok ? await res.json().catch(() => null) : null
    const raw = (json as { prices?: unknown } | null)?.prices
    const points = Array.isArray(raw)
      ? raw.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0).sort((a, b) => a[0] - b[0])
      : null
    value = { points: points && points.length > 0 ? points : null, httpStatus: res.status }
  } catch {
    value = { points: null, httpStatus: null }
  }
  nativeUsdSeries.set(coinId, { slot, ...value })
  return { ...value, cacheHit: false }
}

/** Test hook. */
export function resetEthUsdSeriesCache() {
  nativeUsdSeries.clear()
}

// ── Windowed historical ETH/USD (on-demand V4 chart history only) ────────────────────────────────
// One /market_chart/range read per hour-aligned window, fetched only after the user asks for older
// candles. Ranges longer than a day come back at CoinGecko's hourly granularity. Historical points
// are immutable, so a window is cached 6h (a failure 60s); bounded map.
const ETH_RANGE_TTL_MS = 6 * 3_600_000
const ETH_RANGE_FAIL_TTL_MS = 60_000
const ETH_RANGE_CACHE_MAX = 200
const ethUsdRangeCache = new Map<string, { expiresAt: number; points: Array<[number, number]> | null }>()

export async function fetchCoingeckoEthUsdRange(
  fromSec: number,
  toSec: number,
  timeoutMs: number,
  fetchImpl?: CoingeckoFetchImpl,
  now: () => number = Date.now,
): Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }> {
  return fetchCoingeckoNativeUsdRange('ethereum', fromSec, toSec, timeoutMs, fetchImpl, now)
}

/** Windowed hourly <coinId>/USD for an allow-listed native coin (on-demand chart history only). */
export async function fetchCoingeckoNativeUsdRange(
  coinId: string,
  fromSec: number,
  toSec: number,
  timeoutMs: number,
  fetchImpl: CoingeckoFetchImpl = (url, init) => fetch(url, { headers: init.headers, cache: 'no-store', signal: AbortSignal.timeout(Math.max(1, timeoutMs)) }),
  now: () => number = Date.now,
): Promise<{ points: Array<[number, number]> | null; cacheHit: boolean }> {
  const from = Math.floor(fromSec / 3600) * 3600
  const to = Math.ceil(toSec / 3600) * 3600
  if (!(NATIVE_USD_COIN_IDS as readonly string[]).includes(coinId)) return { points: null, cacheHit: false }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { points: null, cacheHit: false }
  const key = `${coinId}:${from}:${to}`
  const hit = ethUsdRangeCache.get(key)
  if (hit && hit.expiresAt > now()) return { points: hit.points, cacheHit: true }
  const cfg = resolveCoingeckoRuntimeConfig()
  const apiKey = process.env.COINGECKO_API_KEY
  if (!apiKey || !cfg.configurationValid) return { points: null, cacheHit: false }
  let points: Array<[number, number]> | null = null
  try {
    const qs = new URLSearchParams({ vs_currency: 'usd', from: String(from), to: String(to) })
    const res = await fetchImpl(`${cfg.selectedBaseUrl}/coins/${coinId}/market_chart/range?${qs.toString()}`, {
      headers: { Accept: 'application/json', [cfg.selectedHeaderName]: apiKey },
    })
    const json = res.ok ? await res.json().catch(() => null) : null
    const raw = (json as { prices?: unknown } | null)?.prices
    const ok = Array.isArray(raw)
      ? raw.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0).sort((a, b) => a[0] - b[0])
      : []
    points = ok.length > 0 ? ok : null
  } catch {
    points = null
  }
  if (ethUsdRangeCache.size >= ETH_RANGE_CACHE_MAX) ethUsdRangeCache.delete(ethUsdRangeCache.keys().next().value!)
  ethUsdRangeCache.set(key, { expiresAt: now() + (points ? ETH_RANGE_TTL_MS : ETH_RANGE_FAIL_TTL_MS), points })
  return { points, cacheHit: false }
}

/** Test hook. */
export function resetEthUsdRangeCache() {
  ethUsdRangeCache.clear()
}
