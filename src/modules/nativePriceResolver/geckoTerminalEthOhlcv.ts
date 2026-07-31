// MODULE — nativePriceResolver/geckoTerminalEthOhlcv
//
// An INDEPENDENT historical ETH/USD source, added after production proved the two prior sources
// cannot answer: GoldRush historical returned 25 attempts / 25 `goldrush_no_price` / 0 successes, and
// the CoinGecko quota group was already exhausted with its breaker open. Accepted buckets: 0.
//
// WHY GECKOTERMINAL IS GENUINELY INDEPENDENT (the property the first Phase 1 revision got wrong by
// falling back from CoinGecko to CoinGecko): different host (api.geckoterminal.com), no API key, and
// therefore a rate-limit bucket entirely separate from api.coingecko.com's keyed quota and separate
// from GoldRush's. A CoinGecko 429 or an open CoinGecko breaker has no effect on this source, and
// this module deliberately never consults either.
//
// WHAT IT READS: the real, documented endpoint
//   GET /api/v2/networks/{network}/pools/{pool}/ohlcv/day?before_timestamp={sec}&limit={n}
//       &currency=usd&token={weth}
// whose `ohlcv_list` rows are [unixSeconds, open, high, low, close, volume]. `token={weth}` is a real
// documented parameter and is passed EXPLICITLY rather than relying on which side of the pair
// GeckoTerminal happens to label "base" — on a USDC/WETH pool the base side is USDC, and reading it
// would yield ~$1 instead of ETH's price. This removes that ambiguity at the request level rather
// than trying to detect it afterwards.
//
// NO DYNAMIC POOL DISCOVERY, DISCLOSED — this is the central safety property. The existing
// src/pipeline/providers/geckoTerminalPriceSource.ts resolves a token's "top pool" dynamically and
// then takes the CLOSEST candle to the requested time. Neither behaviour is acceptable for evidence
// that will back a verified lot: a dynamically-chosen pool is an unverified venue, and a closest
// candle can silently be a different day. This module instead uses a fixed, explicitly reviewed
// allowlist of canonical, highly liquid WETH/stablecoin pools, and accepts a candle ONLY when its
// timestamp is exactly the requested UTC day. Anything else fails closed.
//
// NEVER A CURRENT PRICE: `before_timestamp` anchors the series to the requested historical day, and
// the exact-day check rejects anything else — including today's candle. There is no "now" path.

import type { SupportedChain } from '../providerFetchWindow/types'

const GECKOTERMINAL_NETWORK_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth',
  base: 'base',
}

// CANONICAL POOL ALLOWLIST, DISCLOSED — fixed, reviewed, never discovered at runtime. Each entry is a
// long-established, highly liquid WETH/USD-stablecoin pool on its chain. `wethAddress` is the token
// whose USD price is explicitly requested from the OHLCV endpoint, so the returned series is ETH's
// price and never the stablecoin side's ~$1.
export type AllowlistedEthPool = {
  chain: SupportedChain
  network: string
  poolAddress: string
  wethAddress: string
  label: string
}

export const ALLOWLISTED_ETH_USD_POOLS: readonly AllowlistedEthPool[] = [
  {
    chain: 'eth',
    network: 'eth',
    // Uniswap V3 USDC/WETH 0.05% — the reference ETH/USD venue on Ethereum mainnet.
    poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    wethAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    label: 'uniswap_v3_usdc_weth_005_eth',
  },
  {
    chain: 'base',
    network: 'base',
    // Uniswap V3 WETH/USDC 0.05% on Base — the reference ETH/USD venue on Base.
    poolAddress: '0xd0b53d9277642d899df5c87a3966a349a798f224',
    wethAddress: '0x4200000000000000000000000000000000000006',
    label: 'uniswap_v3_weth_usdc_005_base',
  },
]

// PURE. The allowlisted pool for a chain, or null when that chain has no reviewed pool. Arbitrum is
// deliberately absent: no pool has been reviewed for it here, and dynamically finding one would be
// exactly the unverified-venue behaviour this module exists to avoid. Arbitrum consumers are still
// served correctly, because one accepted ETH/USD day is chain-independent — see the resolver's own
// permanent cache, which an Ethereum or Base resolution populates for every ETH-native chain.
export function allowlistedPoolForChain(chain: SupportedChain): AllowlistedEthPool | null {
  return ALLOWLISTED_ETH_USD_POOLS.find((pool) => pool.chain === chain) ?? null
}

// HARD PER-SCAN CAP, DISCLOSED: the maximum number of real GeckoTerminal OHLCV requests this source
// will make in one scan. No retries anywhere in this module — a failure is returned as-is and the
// bucket is recorded as unavailable for the scan.
export const MAX_GECKOTERMINAL_OHLCV_REQUESTS_PER_SCAN = 30

const DAY_SECONDS = 86_400

// PLAUSIBILITY GUARD, DISCLOSED — a fail-closed bound, NOT an estimate and never used to adjust,
// clamp or synthesize a value. Its only job is to reject a structurally wrong read: if a response
// ever yielded the stablecoin side of the pair (~$1) instead of ETH, or an obviously corrupt figure,
// that must become an honest failure rather than a "verified" price off by three orders of magnitude.
// The band is deliberately very wide so it can only ever catch a category error, never shape a real
// price.
const MIN_PLAUSIBLE_ETH_USD = 10
const MAX_PLAUSIBLE_ETH_USD = 1_000_000

export type GeckoTerminalEthOhlcvResult = {
  priceUsd: number | null
  httpStatus: number | null
  responseShape: string | null
  rejectionReason: string | null
  poolAddress: string | null
  poolLabel: string | null
  candleTimestampMs: number | null
  endpoint: string
}

type OhlcvResponse = {
  data?: { attributes?: { ohlcv_list?: unknown } }
  meta?: { base?: { address?: string; symbol?: string }; quote?: { address?: string; symbol?: string } }
}

let ohlcvRequestsThisScan = 0

export function resetGeckoTerminalEthOhlcvForScan(): void {
  ohlcvRequestsThisScan = 0
}

export function getGeckoTerminalEthOhlcvRequestCount(): number {
  return ohlcvRequestsThisScan
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// PURE. Validates one raw ohlcv_list row and returns its [timestampSec, close] when structurally
// sound. Exported for direct unit testing.
export function parseCandleRow(row: unknown): { timestampSec: number; close: number } | null {
  if (!Array.isArray(row) || row.length < 5) return null
  const timestampSec = row[0]
  const close = row[4]
  if (typeof timestampSec !== 'number' || !Number.isFinite(timestampSec) || timestampSec <= 0) return null
  if (!isFinitePositive(close)) return null
  return { timestampSec, close }
}

// Fetches the daily candle for the UTC day containing `timestampMs` from the chain's allowlisted
// pool. Fails closed on: an unsupported chain, no allowlisted pool, an exhausted per-scan cap, a
// non-200 response, a malformed body, a pool-identity mismatch, a missing candle for that exact day,
// or an implausible value. Never retries, never substitutes an adjacent day, never uses a current
// price.
export async function fetchGeckoTerminalEthUsdForUtcDay(params: {
  chain: SupportedChain
  timestampMs: number
  bucketStartMs: number
}): Promise<GeckoTerminalEthOhlcvResult> {
  const { chain, bucketStartMs } = params
  const endpoint = 'geckoterminal:/networks/{network}/pools/{pool}/ohlcv/day?token={weth}&currency=usd'
  const base: Omit<GeckoTerminalEthOhlcvResult, 'priceUsd' | 'rejectionReason'> = {
    httpStatus: null,
    responseShape: null,
    poolAddress: null,
    poolLabel: null,
    candleTimestampMs: null,
    endpoint,
  }

  const network = GECKOTERMINAL_NETWORK_IDS[chain]
  if (!network) return { ...base, priceUsd: null, rejectionReason: 'unsupported_network_for_geckoterminal' }

  const pool = allowlistedPoolForChain(chain)
  if (!pool) return { ...base, priceUsd: null, rejectionReason: 'no_allowlisted_pool_for_chain' }

  const withPool = { ...base, poolAddress: pool.poolAddress, poolLabel: pool.label }

  if (ohlcvRequestsThisScan >= MAX_GECKOTERMINAL_OHLCV_REQUESTS_PER_SCAN) {
    return { ...withPool, priceUsd: null, rejectionReason: 'geckoterminal_scan_request_cap_reached' }
  }

  const bucketStartSec = Math.floor(bucketStartMs / 1000)
  // Anchored one day PAST the target day's start so the target day's own closed candle is included in
  // the returned window. `limit=3` keeps the payload minimal while tolerating the endpoint returning
  // the series anchored slightly differently — the exact-day match below is what actually selects.
  const beforeTimestampSec = bucketStartSec + DAY_SECONDS * 2
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool.poolAddress}/ohlcv/day` +
    `?before_timestamp=${beforeTimestampSec}&limit=3&currency=usd&token=${pool.wethAddress}`

  ohlcvRequestsThisScan += 1

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
  } catch (err) {
    // NO RETRY, DISCLOSED: returned as a failure immediately. The resolver records the bucket as
    // unavailable for this scan only, so a later scan may legitimately try again.
    return { ...withPool, priceUsd: null, rejectionReason: `geckoterminal_fetch_error:${err instanceof Error ? err.name : 'unknown'}` }
  }

  const withStatus = { ...withPool, httpStatus: res.status }
  if (!res.ok) return { ...withStatus, priceUsd: null, rejectionReason: `geckoterminal_http_${res.status}` }

  let body: OhlcvResponse
  try {
    body = (await res.json()) as OhlcvResponse
  } catch {
    return { ...withStatus, priceUsd: null, responseShape: 'unparseable_json', rejectionReason: 'geckoterminal_unparseable_json' }
  }

  // POOL IDENTITY VERIFICATION, DISCLOSED: when the response carries token metadata, the allowlisted
  // WETH address MUST appear on one side of the returned pair. This catches a wrong/redirected pool
  // before its numbers are ever trusted. When metadata is absent, identity still rests on the fixed
  // allowlist above (the pool address was never discovered dynamically), so absence alone is not
  // treated as a failure — a MISMATCH is.
  const metaAddresses = [body.meta?.base?.address, body.meta?.quote?.address]
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.toLowerCase())
  if (metaAddresses.length > 0 && !metaAddresses.includes(pool.wethAddress.toLowerCase())) {
    return { ...withStatus, priceUsd: null, responseShape: 'meta_present', rejectionReason: 'pool_identity_mismatch' }
  }

  const rawList = body.data?.attributes?.ohlcv_list
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { ...withStatus, priceUsd: null, responseShape: 'ohlcv_list_missing_or_empty', rejectionReason: 'geckoterminal_no_candles' }
  }

  const parsed = rawList.map(parseCandleRow).filter((c): c is { timestampSec: number; close: number } => c !== null)
  if (parsed.length === 0) {
    return { ...withStatus, priceUsd: null, responseShape: 'ohlcv_list_rows_malformed', rejectionReason: 'geckoterminal_malformed_candles' }
  }

  // EXACT UTC-DAY MATCH ONLY, DISCLOSED: the candle's own timestamp must be the requested day's start.
  // An adjacent or stale candle is NEVER substituted — that would silently price a trade with a
  // different day's ETH price while still labelling it verified.
  const exact = parsed.find((candle) => candle.timestampSec === bucketStartSec)
  if (!exact) {
    return {
      ...withStatus,
      priceUsd: null,
      responseShape: `candles=${parsed.length}`,
      rejectionReason: 'geckoterminal_no_candle_for_requested_utc_day',
    }
  }

  const withCandle = { ...withStatus, candleTimestampMs: exact.timestampSec * 1000, responseShape: 'ohlcv_list[close]' }

  if (exact.close < MIN_PLAUSIBLE_ETH_USD || exact.close > MAX_PLAUSIBLE_ETH_USD) {
    // See MIN/MAX_PLAUSIBLE_ETH_USD above — a category-error guard, failing closed rather than
    // adjusting anything.
    return { ...withCandle, priceUsd: null, rejectionReason: 'geckoterminal_implausible_eth_price' }
  }

  return { ...withCandle, priceUsd: exact.close, rejectionReason: null }
}
