// lib/server/chartCandlesOnDemand.ts — real 5M candles, fetched ONLY when a user selects 5M.
//
// ON-DEMAND 5M, DISCLOSED (requested: "fetch 5M ON DEMAND only when the user selects 5M" — never
// derived from 15M, never added to every scan). A normal token scan makes zero 5M requests. When
// the user clicks 5M, GET /api/token/chart-candles calls loadOnDemandCandles, which:
//   1. accepts only an EVM chain the chart pipeline supports and 0x addresses;
//   2. prices the SCANNED token's side of the SAME pool the scan's 15m candles came from. The side
//      is taken from the scan's own verified result when this server instance still holds it
//      (rememberVerifiedChartPool); otherwise it is re-proven from the pool's own base/quote ids with
//      one pool read. The client-supplied pool is never trusted for the side;
//   3. reads minute aggregate 5 x 288 rows (24h) for that proven side from CoinGecko's on-chain pool
//      OHLCV first (when the chain is routed to CoinGecko and a key is configured); only when that
//      read fails or returns no usable rows does it make the same read against GeckoTerminal. Both
//      support minute aggregates 1/5/15. Never derived from 15m;
//   4. caches by chain + token + pool + timeframe and de-duplicates concurrent identical requests.
// Hard cap: 3 provider calls per request (GeckoTerminal side verification only on a verification-
// cache miss, CoinGecko once, GeckoTerminal OHLCV only after a CoinGecko failure), 0 on a cache hit.

import {
  COINGECKO_ONCHAIN_NETWORK,
  EVM_CHART_NETWORK,
  candleFailureMessage,
  classifyOhlcvResponse,
  resolveEvmPoolTokenSide,
  type CandleFailureCode,
  type CandleProvider,
  type EvmChartPoint,
} from '../evmChartCandles.ts'

export const ON_DEMAND_CHAINS = ['eth', 'base', 'bnb', 'robinhood'] as const
export type OnDemandChain = (typeof ON_DEMAND_CHAINS)[number]

export const ON_DEMAND_TIMEFRAMES = {
  '5m': { resolution: 'minute' as const, aggregate: 5, limit: 288, intervalSec: 300 },
}
export type OnDemandTimeframe = keyof typeof ON_DEMAND_TIMEFRAMES

export const ON_DEMAND_MAX_PROVIDER_CALLS = 3
const RESULT_TTL_MS = 60_000
const RATE_LIMITED_TTL_MS = 30_000
const VERIFIED_POOL_TTL_MS = 30 * 60_000

export type OnDemandResult =
  | { ok: true; timeframe: OnDemandTimeframe; intervalSec: number; points: EvmChartPoint[]; source: CandleProvider }
  | { ok: false; timeframe: OnDemandTimeframe | null; code: CandleFailureCode | 'invalid_request'; message: string }

export type FetchJson = (url: string) => Promise<{ json: unknown; httpStatus: number | null }>
/** CoinGecko on-chain pool OHLCV reader (lib/server/coingeckoOnchainOhlcv.ts); `side` is proven. */
export type FetchCoingeckoOhlcv = (
  chain: string,
  pool: string,
  req: { resolution: 'minute' | 'hour' | 'day'; aggregate: number; limit: number },
  side: 'base' | 'quote',
) => Promise<{ json: unknown; httpStatus: number | null }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

const verifiedPools = new Map<string, { side: 'base' | 'quote'; expiresAt: number }>()
const resultCache = new Map<string, { value: OnDemandResult; expiresAt: number }>()
const inFlight = new Map<string, Promise<{ result: OnDemandResult; providerCalls: number }>>()

const poolKey = (chain: string, token: string, pool: string) => `${chain}:${token.toLowerCase()}:${pool.toLowerCase()}`

/** Called by the scan route when its pool OHLCV succeeded with a proven side. */
export function rememberVerifiedChartPool(chain: string, token: string, pool: string, side: 'base' | 'quote', now = Date.now()) {
  verifiedPools.set(poolKey(chain, token, pool), { side, expiresAt: now + VERIFIED_POOL_TTL_MS })
}

/** Test hook — clears all in-memory state. */
export function resetOnDemandCandleState() {
  verifiedPools.clear()
  resultCache.clear()
  inFlight.clear()
}

function fail(timeframe: OnDemandTimeframe | null, code: CandleFailureCode | 'invalid_request', message?: string): OnDemandResult {
  return { ok: false, timeframe, code, message: message ?? (code === 'invalid_request' ? 'Invalid chart request.' : candleFailureMessage(code)) }
}

export function isOnDemandChain(v: string | null): v is OnDemandChain {
  return v != null && (ON_DEMAND_CHAINS as readonly string[]).includes(v)
}

export async function loadOnDemandCandles(
  params: { chain: string | null; token: string | null; pool: string | null; timeframe: string | null },
  fetchJson: FetchJson,
  opts: { baseUrl?: string; now?: () => number; fetchCoingecko?: FetchCoingeckoOhlcv } = {},
): Promise<{ result: OnDemandResult; providerCalls: number; cacheHit: boolean }> {
  const now = opts.now ?? Date.now
  const timeframe = params.timeframe && params.timeframe in ON_DEMAND_TIMEFRAMES ? (params.timeframe as OnDemandTimeframe) : null
  if (!timeframe) return { result: fail(null, 'invalid_request', 'Unsupported chart timeframe.'), providerCalls: 0, cacheHit: false }
  if (!isOnDemandChain(params.chain)) return { result: fail(timeframe, 'network_not_supported'), providerCalls: 0, cacheHit: false }
  const token = params.token ?? ''
  const pool = params.pool ?? ''
  if (!ADDRESS_RE.test(token) || !ADDRESS_RE.test(pool)) return { result: fail(timeframe, 'invalid_request'), providerCalls: 0, cacheHit: false }
  const chain = params.chain
  const network = EVM_CHART_NETWORK[chain]
  if (!network) return { result: fail(timeframe, 'network_not_supported'), providerCalls: 0, cacheHit: false }

  const key = `${poolKey(chain, token, pool)}:${timeframe}`
  const cached = resultCache.get(key)
  if (cached && cached.expiresAt > now()) return { result: cached.value, providerCalls: 0, cacheHit: true }
  const pending = inFlight.get(key)
  if (pending) {
    const shared = await pending
    return { result: shared.result, providerCalls: 0, cacheHit: true }
  }

  const base = (opts.baseUrl ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
  const work = (async (): Promise<{ result: OnDemandResult; providerCalls: number }> => {
    let calls = 0
    const tf = ON_DEMAND_TIMEFRAMES[timeframe]
    let side: 'base' | 'quote' | null = null
    const remembered = verifiedPools.get(poolKey(chain, token, pool))
    if (remembered && remembered.expiresAt > now()) side = remembered.side
    else {
      calls++
      const poolRes = await fetchJson(`${base}/api/v2/networks/${network}/pools/${pool.toLowerCase()}`)
      if (poolRes.httpStatus === 429) return { result: fail(timeframe, 'provider_rate_limited'), providerCalls: calls }
      if (poolRes.httpStatus === 404) return { result: fail(timeframe, 'pool_not_indexed'), providerCalls: calls }
      if (poolRes.httpStatus == null || poolRes.httpStatus < 200 || poolRes.httpStatus >= 300) return { result: fail(timeframe, 'provider_http_error'), providerCalls: calls }
      const data = (poolRes.json as { data?: unknown } | null)?.data
      if (!data || typeof data !== 'object') return { result: fail(timeframe, 'provider_schema_invalid'), providerCalls: calls }
      side = resolveEvmPoolTokenSide(data as Record<string, unknown>, token, network)
      if (!side) return { result: fail(timeframe, 'token_side_unresolved'), providerCalls: calls }
      rememberVerifiedChartPool(chain, token, pool, side, now())
    }
    if (opts.fetchCoingecko && COINGECKO_ONCHAIN_NETWORK[chain]) {
      calls++
      const cg = await opts.fetchCoingecko(chain, pool.toLowerCase(), { resolution: tf.resolution, aggregate: tf.aggregate, limit: tf.limit }, side)
      const cgOut = classifyOhlcvResponse('pool', cg.httpStatus, cg.json)
      if (cgOut.code === 'ok') return { result: { ok: true, timeframe, intervalSec: tf.intervalSec, points: cgOut.normalized.points, source: 'coingecko_onchain' }, providerCalls: calls }
    }
    if (calls >= ON_DEMAND_MAX_PROVIDER_CALLS) return { result: fail(timeframe, 'call_budget_exhausted'), providerCalls: calls }
    calls++
    const url = `${base}/api/v2/networks/${network}/pools/${pool.toLowerCase()}/ohlcv/${tf.resolution}?aggregate=${tf.aggregate}&limit=${tf.limit}&currency=usd&token=${side}`
    const raw = await fetchJson(url)
    const { code, normalized } = classifyOhlcvResponse('pool', raw.httpStatus, raw.json)
    if (code !== 'ok') return { result: fail(timeframe, code), providerCalls: calls }
    return { result: { ok: true, timeframe, intervalSec: tf.intervalSec, points: normalized.points, source: 'geckoterminal' }, providerCalls: calls }
  })()
  inFlight.set(key, work)
  try {
    const out = await work
    const ttl = !out.result.ok && out.result.code === 'provider_rate_limited' ? RATE_LIMITED_TTL_MS : RESULT_TTL_MS
    resultCache.set(key, { value: out.result, expiresAt: now() + ttl })
    return { ...out, cacheHit: false }
  } finally {
    inFlight.delete(key)
  }
}
