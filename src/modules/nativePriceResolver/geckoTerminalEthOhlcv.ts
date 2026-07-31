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
// ─── PER-DAY FETCHING WAS THE WRONG SHAPE (current revision) ─────────────────────────────────────
//
// Production proof: 25 GeckoTerminal OHLCV requests, ALL HTTP 429, acceptedBuckets 0, lotsCompleted
// 0. The source itself was correct; its REQUEST ARCHITECTURE was not. GeckoTerminal's free tier is
// roughly 30 requests/minute with no key, and one request per required UTC day meant a scan needing
// 25 distinct days spent 25 requests to fetch what is, in reality, ONE contiguous daily series from
// ONE pool. The endpoint has always accepted a `limit`, so the entire window can be retrieved in a
// single call and indexed locally.
//
// This module now fetches a bounded RANGE covering the earliest through latest required day, indexes
// the returned candles by exact UTC day, and answers every bucket from that one response. Hard cap:
// 2 requests per scan — the allowlisted Ethereum pool first, and the allowlisted Base pool only as a
// second INDEPENDENT POOL fallback (a different venue, not a retry of the same one). Sequential, no
// burst concurrency, no retries. A 429 stops the GeckoTerminal quota group for the rest of the scan.
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

export type GeckoTerminalCandleHit = {
  priceUsd: number
  poolAddress: string
  poolLabel: string
  candleTimestampMs: number
}

export type GeckoTerminalRangeDiagnostics = {
  requiredBucketCount: number
  rangeStartUtc: string | null
  rangeEndUtc: string | null
  rangeRequests: number
  candlesReturned: number
  exactDaysMatched: number
  missingDays: string[]
  httpStatuses: Array<{ poolLabel: string; status: number | null; rejectionReason: string | null }>
  quotaStopped: boolean
}

type OhlcvResponse = {
  data?: { attributes?: { ohlcv_list?: unknown } }
  meta?: { base?: { address?: string; symbol?: string }; quote?: { address?: string; symbol?: string } }
}

// HARD CAP, DISCLOSED: at most two real GeckoTerminal requests per scan — one per allowlisted pool,
// and only because they are genuinely DIFFERENT venues on different networks. The second is never a
// retry of the first.
export const MAX_GECKOTERMINAL_RANGE_REQUESTS_PER_SCAN = 2

// GeckoTerminal's documented maximum candles per OHLCV response.
const MAX_CANDLES_PER_REQUEST = 1000

const DAY_MS = 86_400_000

// REQUEST-SCOPED RANGE INDEX, DISCLOSED: the single fetched series, keyed by exact UTC-day bucket
// start. Every consumer this scan reads from this one index, so a day costs zero additional requests
// no matter how many lots need it. Cleared per scan (the ACCEPTED-day cache that must outlive a scan
// lives in the resolver, not here — see index.ts's acceptedPriceByBucket).
let rangeIndexThisScan = new Map<number, GeckoTerminalCandleHit>()
let rangeRequestsThisScan = 0
let rangePrimedThisScan = false
// QUOTA STOP, DISCLOSED: set on the first HTTP 429. Once set, no further GeckoTerminal request is
// made this scan — the rate limiter has answered definitively and spending the remaining budget would
// only produce more 429s.
let quotaStoppedThisScan = false
let lastRangeDiagnostics: GeckoTerminalRangeDiagnostics | null = null

export function resetGeckoTerminalEthOhlcvForScan(): void {
  rangeIndexThisScan = new Map()
  rangeRequestsThisScan = 0
  rangePrimedThisScan = false
  quotaStoppedThisScan = false
  lastRangeDiagnostics = null
}

export function getGeckoTerminalEthOhlcvRequestCount(): number {
  return rangeRequestsThisScan
}

export function getGeckoTerminalRangeDiagnostics(): GeckoTerminalRangeDiagnostics | null {
  return lastRangeDiagnostics ? { ...lastRangeDiagnostics, missingDays: [...lastRangeDiagnostics.missingDays], httpStatuses: [...lastRangeDiagnostics.httpStatuses] } : null
}

export function isGeckoTerminalQuotaStopped(): boolean {
  return quotaStoppedThisScan
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function utcDay(bucketStartMs: number): string {
  return new Date(bucketStartMs).toISOString().slice(0, 10)
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

type RangeFetchOutcome = {
  candlesReturned: number
  indexed: number
  httpStatus: number | null
  rejectionReason: string | null
}

// Fetches ONE bounded daily range from ONE allowlisted pool and indexes every structurally sound,
// plausible candle by its exact UTC day. Never retries. Never substitutes an adjacent day: indexing
// is by the candle's own timestamp, so a bucket with no candle simply has no entry.
async function fetchRangeFromPool(
  pool: AllowlistedEthPool,
  earliestBucketMs: number,
  latestBucketMs: number,
): Promise<RangeFetchOutcome> {
  // One candle per day inclusive, plus a small margin so the boundary days are certainly covered,
  // clamped to the endpoint's documented maximum.
  const dayspan = Math.floor((latestBucketMs - earliestBucketMs) / DAY_MS) + 1
  const limit = Math.min(MAX_CANDLES_PER_REQUEST, Math.max(1, dayspan + 2))
  // Anchored one day past the latest required day so that day's own closed candle is included.
  const beforeTimestampSec = Math.floor(latestBucketMs / 1000) + 86_400 * 2

  const url =
    `https://api.geckoterminal.com/api/v2/networks/${pool.network}/pools/${pool.poolAddress}/ohlcv/day` +
    `?before_timestamp=${beforeTimestampSec}&limit=${limit}&currency=usd&token=${pool.wethAddress}`

  rangeRequestsThisScan += 1

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    return { candlesReturned: 0, indexed: 0, httpStatus: null, rejectionReason: `geckoterminal_fetch_error:${err instanceof Error ? err.name : 'unknown'}` }
  }

  if (res.status === 429) {
    // QUOTA STOP: the rate limiter has answered definitively. No further request this scan.
    quotaStoppedThisScan = true
    return { candlesReturned: 0, indexed: 0, httpStatus: 429, rejectionReason: 'geckoterminal_http_429' }
  }
  if (!res.ok) {
    return { candlesReturned: 0, indexed: 0, httpStatus: res.status, rejectionReason: `geckoterminal_http_${res.status}` }
  }

  let body: OhlcvResponse
  try {
    body = (await res.json()) as OhlcvResponse
  } catch {
    return { candlesReturned: 0, indexed: 0, httpStatus: res.status, rejectionReason: 'geckoterminal_unparseable_json' }
  }

  // POOL IDENTITY VERIFICATION, DISCLOSED, UNCHANGED: when the response carries token metadata, the
  // allowlisted WETH address MUST appear on one side of the returned pair, or nothing from this
  // response is trusted. Absence of metadata is not a failure (identity already rests on the fixed
  // allowlist); a MISMATCH is.
  const metaAddresses = [body.meta?.base?.address, body.meta?.quote?.address]
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.toLowerCase())
  if (metaAddresses.length > 0 && !metaAddresses.includes(pool.wethAddress.toLowerCase())) {
    return { candlesReturned: 0, indexed: 0, httpStatus: res.status, rejectionReason: 'pool_identity_mismatch' }
  }

  const rawList = body.data?.attributes?.ohlcv_list
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { candlesReturned: 0, indexed: 0, httpStatus: res.status, rejectionReason: 'geckoterminal_no_candles' }
  }

  let indexed = 0
  for (const row of rawList) {
    const parsed = parseCandleRow(row)
    if (!parsed) continue
    // EXACT UTC-DAY INDEXING, DISCLOSED: a candle is filed under its OWN day only. Nothing is
    // interpolated, carried forward, or nearest-matched — a day absent from the series stays absent.
    const candleMs = parsed.timestampSec * 1000
    if (candleMs % DAY_MS !== 0) continue // not a UTC-day-aligned daily candle — never trusted
    // PLAUSIBILITY GUARD, unchanged: rejects a category error (e.g. the ~$1 stablecoin side); never
    // clamps or adjusts.
    if (parsed.close < MIN_PLAUSIBLE_ETH_USD || parsed.close > MAX_PLAUSIBLE_ETH_USD) continue
    if (rangeIndexThisScan.has(candleMs)) continue // first accepted pool wins, deterministically
    rangeIndexThisScan.set(candleMs, {
      priceUsd: parsed.close,
      poolAddress: pool.poolAddress,
      poolLabel: pool.label,
      candleTimestampMs: candleMs,
    })
    indexed += 1
  }

  return { candlesReturned: rawList.length, indexed, httpStatus: res.status, rejectionReason: null }
}

// PRIMES the request-scoped range index for every required UTC-day bucket, using at most
// MAX_GECKOTERMINAL_RANGE_REQUESTS_PER_SCAN sequential requests. Called once per scan by the
// resolver's prefetch; safe to call again (it is a no-op once primed).
export async function primeGeckoTerminalRangeForBuckets(requiredBucketStartsMs: readonly number[]): Promise<GeckoTerminalRangeDiagnostics> {
  const required = [...new Set(requiredBucketStartsMs)].filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b)

  if (rangePrimedThisScan || required.length === 0) {
    const diagnostics: GeckoTerminalRangeDiagnostics = lastRangeDiagnostics ?? {
      requiredBucketCount: required.length,
      rangeStartUtc: null,
      rangeEndUtc: null,
      rangeRequests: rangeRequestsThisScan,
      candlesReturned: 0,
      exactDaysMatched: 0,
      missingDays: [],
      httpStatuses: [],
      quotaStopped: quotaStoppedThisScan,
    }
    return diagnostics
  }

  rangePrimedThisScan = true

  const earliest = required[0]
  const latest = required[required.length - 1]
  const httpStatuses: GeckoTerminalRangeDiagnostics['httpStatuses'] = []
  let candlesReturned = 0

  // SEQUENTIAL, DISCLOSED: the Ethereum pool first (the deepest ETH/USD venue), then the Base pool
  // only if days are still missing. Never concurrent — burst concurrency against a keyless, per-minute
  // limit is what produced the 429 storm this revision replaces.
  for (const pool of ALLOWLISTED_ETH_USD_POOLS) {
    if (rangeRequestsThisScan >= MAX_GECKOTERMINAL_RANGE_REQUESTS_PER_SCAN) break
    if (quotaStoppedThisScan) break
    const stillMissing = required.filter((bucket) => !rangeIndexThisScan.has(bucket))
    if (stillMissing.length === 0) break

    const outcome = await fetchRangeFromPool(pool, earliest, latest)
    candlesReturned += outcome.candlesReturned
    httpStatuses.push({ poolLabel: pool.label, status: outcome.httpStatus, rejectionReason: outcome.rejectionReason })
  }

  const missing = required.filter((bucket) => !rangeIndexThisScan.has(bucket))

  lastRangeDiagnostics = {
    requiredBucketCount: required.length,
    rangeStartUtc: utcDay(earliest),
    rangeEndUtc: utcDay(latest),
    rangeRequests: rangeRequestsThisScan,
    candlesReturned,
    exactDaysMatched: required.length - missing.length,
    // Bounded so log volume stays sane on a wide window.
    missingDays: missing.slice(0, 20).map(utcDay),
    httpStatuses,
    quotaStopped: quotaStoppedThisScan,
  }
  return lastRangeDiagnostics
}

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

// Resolves one UTC day from the ALREADY-PRIMED, request-scoped range index. PURE with respect to the
// network: this never issues a request — all fetching happens once, in primeGeckoTerminalRangeForBuckets.
// Fails closed when the day is genuinely absent from the fetched series; an adjacent or stale candle
// is never substituted, because the index is keyed by the candle's own exact UTC day.
export function readGeckoTerminalEthUsdForUtcDay(params: {
  chain: SupportedChain
  bucketStartMs: number
}): GeckoTerminalEthOhlcvResult {
  const endpoint = 'geckoterminal:/networks/{network}/pools/{pool}/ohlcv/day?token={weth}&currency=usd (range, indexed)'
  const base = {
    httpStatus: null,
    responseShape: null as string | null,
    poolAddress: null as string | null,
    poolLabel: null as string | null,
    candleTimestampMs: null as number | null,
    endpoint,
  }

  if (!isEthNativeGeckoChain(params.chain)) {
    return { ...base, priceUsd: null, rejectionReason: 'unsupported_network_for_geckoterminal' }
  }

  if (quotaStoppedThisScan && rangeIndexThisScan.size === 0) {
    return { ...base, priceUsd: null, rejectionReason: 'geckoterminal_quota_stopped_this_scan' }
  }

  const hit = rangeIndexThisScan.get(params.bucketStartMs)
  if (!hit) {
    return {
      ...base,
      priceUsd: null,
      responseShape: `indexed_days=${rangeIndexThisScan.size}`,
      rejectionReason: rangePrimedThisScan ? 'geckoterminal_no_candle_for_requested_utc_day' : 'geckoterminal_range_not_primed',
    }
  }

  return {
    priceUsd: hit.priceUsd,
    httpStatus: 200,
    responseShape: 'ohlcv_list[close]',
    rejectionReason: null,
    poolAddress: hit.poolAddress,
    poolLabel: hit.poolLabel,
    candleTimestampMs: hit.candleTimestampMs,
    endpoint,
  }
}

// Chains for which an ETH/USD series can be sourced at all. The RANGE is fetched from allowlisted
// pools on eth/base; any ETH-native chain may READ the resulting day, since one accepted ETH/USD day
// is chain-independent.
function isEthNativeGeckoChain(chain: SupportedChain): boolean {
  return chain === 'eth' || chain === 'base' || chain === 'arbitrum'
}

// TEST-SUPPORT ONLY, DISCLOSED: seeds the request-scoped range index so a test can exercise the read
// path without a network call. Rejects a non-price, so a fabricated value cannot be seeded.
export function __seedGeckoTerminalRangeForTest(bucketStartMs: number, hit: GeckoTerminalCandleHit): void {
  if (!isFinitePositive(hit.priceUsd)) throw new Error('__seedGeckoTerminalRangeForTest requires a finite positive price')
  rangeIndexThisScan.set(bucketStartMs, hit)
  rangePrimedThisScan = true
}
