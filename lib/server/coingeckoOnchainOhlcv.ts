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

import { COINGECKO_ONCHAIN_NETWORK } from '../evmChartCandles.ts'
import { resolveCoingeckoRuntimeConfig } from '../../src/modules/pricingAtTimeEngine/sources/coingecko.ts'

export type CoingeckoOhlcvRequest = { resolution: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }
export type CoingeckoFetchImpl = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>

const POOL_RE = /^0x[a-fA-F0-9]{40}$/
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
export function coingeckoOnchainOhlcvPath(network: string, pool: string, req: CoingeckoOhlcvRequest, token: string): string {
  const qs = new URLSearchParams({
    aggregate: String(req.aggregate),
    limit: String(req.limit),
    currency: 'usd',
    token,
    include_empty_intervals: 'false',
  })
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
): Promise<{ json: unknown; httpStatus: number | null }> {
  const network = coingeckoOnchainNetwork(chain)
  const cfg = resolveCoingeckoRuntimeConfig()
  const key = process.env.COINGECKO_API_KEY
  if (!network || !key || !cfg.configurationValid || !POOL_RE.test(pool) || !TOKEN_RE.test(token)) return { json: null, httpStatus: null }
  try {
    const res = await fetchImpl(`${cfg.selectedBaseUrl}${coingeckoOnchainOhlcvPath(network, pool, req, token)}`, {
      headers: { Accept: 'application/json', [cfg.selectedHeaderName]: key },
    })
    return { json: res.ok ? await res.json().catch(() => null) : null, httpStatus: res.status }
  } catch {
    return { json: null, httpStatus: null }
  }
}
