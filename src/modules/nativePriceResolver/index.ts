// MODULE — nativePriceResolver: ONE shared historical ETH/WETH → USD resolver.
//
// ─── PHASE 1 ORIGINAL ROOT CAUSE (unchanged, still fixed here) ───────────────────────────────────
//
// ETH's USD price at a given historical instant is a GLOBAL SCALAR. It is the same number for Base
// native ETH, Ethereum native ETH, and canonical WETH on either chain — it does not vary by chain,
// by token contract, by wallet, or by which closed lot happens to need it. It was nonetheless
// resolved through three independent paths (priceLotsForWallet's same-tx quote pricing, basedex's
// DEX-ratio quote pricing, coingecko's own native route) that never shared a result, so the one
// scalar was rationed behind MAX_LOOKUPS_PER_TOKEN (2): 53 native requirements competed for 2 slots,
// 4 won, and 51 quote candidates failed `missing_verified_native_price`. This module is the single
// resolver all three go through, with one accepted price per UTC day reused everywhere.
//
// ─── PHASE 1 PRODUCTION FAILURE, AUDITED (this revision) ─────────────────────────────────────────
//
// Production proof after the first Phase 1 deploy: 19 requirement buckets, 25 live bucket requests,
// 0 accepted, 25 failed, 0 prices from the shared resolver, `missing_verified_native_price` still 51,
// CoinGecko native history still returning HTTP 429.
//
// THE DEFECT WAS MINE AND IT WAS STRUCTURAL, NOT INCIDENTAL: the "deterministic fallback chain" I
// shipped was two CoinGecko endpoints. Those are not independent in ANY sense that matters:
//   - same host family and same account,
//   - same COINGECKO_API_KEY and therefore the same quota,
//   - AND — decisively — the same module-level circuit breaker. `fetchCoingeckoNativeEthPriceDetailed`
//     TRIPS `coingeckoCircuitOpen` the instant it sees a 429, and `fetchCoingeckoPriceDetailed`
//     short-circuits on that identical flag before issuing any request at all.
// So the moment source 1 got its first 429, source 2 was guaranteed to return
// `coingecko_circuit_open_after_429` without ever reaching the network. A "fallback" that cannot run
// when the primary fails is not a fallback. That fully accounts for 25 attempted / 0 accepted, and it
// is why every one of the 25 failures is attributable to one exhausted quota rather than to 25
// genuine per-day "no data" answers.
//
// Answering the rest of the audit checklist directly:
//   - CoinGecko demo-key header/endpoint compatibility: correct and not the cause. `demo` selects
//     api.coingecko.com/api/v3 with x-cg-demo-api-key; `pro` selects pro-api with x-cg-pro-api-key
//     (resolveCoingeckoRuntimeConfig). A mismatch yields 401/400, not 429.
//   - `/coins/ethereum/history` date format: correct and not the cause. DD-MM-YYYY is what the
//     endpoint documents and what coingecko.ts builds. A malformed date yields 400, not 429.
//   - WETH contract-history support on Base/Ethereum: real, but irrelevant while the breaker is open,
//     and on the free tier this endpoint is additionally range-limited for older dates — a second
//     reason it cannot be relied on as THE fallback.
//   - Do both fallbacks share one quota: YES. That is the defect.
//   - Coalescing before or after source fallback: coalescing is per BUCKET and wraps the whole source
//     chain, which is correct — it was never the problem. Preserved unchanged.
//   - Process-lifetime cache surviving the worker runtime: it does survive, but it can only retain
//     ACCEPTED prices, and zero were ever accepted — so it had nothing to serve. Also fixed here: the
//     live-bucket cap counter was process-lifetime and never reset, which would have silently
//     throttled a warm worker over time. It is now per-scan (still a hard cap).
//
// ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────────
//
// A genuinely independent verified source is placed FIRST: GoldRush historical pricing. It is already
// configured in this project (GOLDRUSH_API_KEY / COVALENT_API_KEY — this pipeline's PRIMARY price
// source), uses a different host, a different key and a different quota, and has its own separate
// breaker. No new paid dependency is added, and no key handling is duplicated: the resolver is
// HANDED the already-built, already-budgeted GoldRush source function by src/pipeline/index.ts, the
// one place that constructs it. The two CoinGecko endpoints are retained after it as genuine
// last-resort attempts, now correctly reported as sharing a single quota.
//
// ─── GOLDRUSH ALSO CAME BACK EMPTY — GECKOTERMINAL OHLCV ADDED (current revision) ────────────────
//
// Next production proof: GoldRush historical made 25 attempts and returned `goldrush_no_price` 25
// times with 0 successes, while the CoinGecko group remained exhausted with its breaker open.
// Accepted buckets: 0. `missing_verified_native_price` still 51; verified coverage still 10/219.
// So the chain had one source that structurally cannot answer and one group that cannot be reached.
//
// GeckoTerminal daily OHLCV is inserted as source 2 — after GoldRush, BEFORE the CoinGecko group, so
// an exhausted CoinGecko quota can never block it. It is a THIRD independent quota group: different
// host (api.geckoterminal.com), no API key, unaffected by either other provider's rate limit or
// breaker. It reads a fixed, explicitly reviewed allowlist of canonical, highly liquid WETH/stablecoin
// pools and accepts a candle ONLY when its timestamp is exactly the requested UTC day — never a
// dynamically discovered pool, never an adjacent or stale candle. See geckoTerminalEthOhlcv.ts.
//
// EVIDENCE STANDARD IS UNCHANGED: every source here returns a real historical daily USD price from a
// real provider. Nothing is estimated, interpolated, averaged, or relabelled. An answer this module
// cannot stand behind is returned as null.
//
// NEVER A CURRENT PRICE: there is no "now" path. A timestamp that is invalid or in the future is
// rejected outright rather than silently served a spot price.

import type { SupportedChain } from '../providerFetchWindow/types'
import type { PriceSourceFn } from '../pricingAtTimeEngine/types'
import { fetchGeckoTerminalEthUsdForUtcDay, resetGeckoTerminalEthOhlcvForScan } from './geckoTerminalEthOhlcv'
import {
  fetchCoingeckoNativeEthPriceDetailed,
  fetchCoingeckoPriceDetailed,
  isCoingeckoCircuitOpenForTest,
} from '../pricingAtTimeEngine/sources/coingecko'

// BUCKET GRANULARITY, DISCLOSED, UNCHANGED: one UTC calendar day — the REAL resolution of every
// source below (CoinGecko's `/coins/{id}/history` is keyed `date=DD-MM-YYYY`; GoldRush historical
// pricing is queried `from`/`to` on the same calendar day). Bucketing finer would invent precision
// the data does not have. Consumers are told their exact distance from the bucket instant.
export const NATIVE_PRICE_BUCKET_MS = 86_400_000

// HARD CAP, DISCLOSED, PER SCAN: the maximum number of DISTINCT day-buckets this resolver will
// attempt live in one scan. Reached only by genuinely distinct calendar days a real closed lot needs.
// FIXED THIS REVISION: this counter was previously process-lifetime and never reset, so a warm worker
// would have permanently throttled itself after enough scans. Resetting it per scan keeps it a real
// hard cap while removing that silent degradation.
export const MAX_NATIVE_PRICE_LIVE_BUCKETS_PER_SCAN = 60

// Chains whose NATIVE asset is genuinely ETH, so one ETH/USD figure is the correct native price for
// them. Explicitly allow-listed, never inferred — `hyperevm` is deliberately absent (its native asset
// is not ETH; serving it an ETH price would be a fabricated value, not an approximation).
const ETH_NATIVE_CHAINS: ReadonlySet<SupportedChain> = new Set<SupportedChain>(['eth', 'base', 'arbitrum'])

// Canonical WETH contract per ETH-native chain — the lookup address handed to contract-based sources.
const CANONICAL_WETH_BY_CHAIN: Partial<Record<SupportedChain, string>> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
}

export type NativePriceSourceId =
  | 'goldrush_historical'
  | 'geckoterminal_eth_ohlcv'
  | 'coingecko_native_coin_history'
  | 'coingecko_weth_contract_history'

// QUOTA GROUPING, DISCLOSED — the field whose absence caused this revision's production failure. Two
// sources sharing a quota group cannot rescue each other; this makes that explicit in the audit
// output rather than leaving it to be rediscovered from a 429 pattern.
const SOURCE_QUOTA_GROUP: Record<NativePriceSourceId, string> = {
  goldrush_historical: 'goldrush',
  // Different host (api.geckoterminal.com), no API key — a rate-limit bucket entirely separate from
  // both the keyed CoinGecko quota and GoldRush's. This is what makes it a real fallback.
  geckoterminal_eth_ohlcv: 'geckoterminal',
  coingecko_native_coin_history: 'coingecko',
  coingecko_weth_contract_history: 'coingecko',
}

// DETERMINISTIC SOURCE ORDER, DISCLOSED — fixed, never reordered by outcome, never randomized:
//   1. GoldRush historical pricing — independent quota, key and breaker, already configured as this
//      pipeline's primary price source.
//   2. GeckoTerminal daily OHLCV from a fixed, allowlisted canonical WETH/stablecoin pool — a third
//      independent quota group (different host, no key). Placed after GoldRush and BEFORE the
//      CoinGecko group, so an exhausted CoinGecko quota can never block it.
//   3. CoinGecko native coin history — the most complete ETH dataset when its quota is available.
//   4. CoinGecko canonical-WETH contract history — a genuinely different dataset, but same quota as 3.
const SOURCE_ORDER: readonly NativePriceSourceId[] = [
  'goldrush_historical',
  'geckoterminal_eth_ohlcv',
  'coingecko_native_coin_history',
  'coingecko_weth_contract_history',
]

export type NativePriceResolution = {
  priceUsd: number
  source: NativePriceSourceId
  bucketStartMs: number
  // Real, disclosed distance from the caller's requested instant to `bucketStartMs`. Always in
  // [0, NATIVE_PRICE_BUCKET_MS). Exposed so a consumer applies its own tolerance rather than trusting
  // an opaque "close enough".
  timestampDistanceMs: number
  // 'verified' — a real historical price, from a real provider, for the real day requested. This
  // module never returns any other confidence value: an answer it cannot stand behind is null.
  confidence: 'verified'
  servedFromPermanentCache: boolean
  coalesced: boolean
  // PROVENANCE, DISCLOSED — populated when the accepted source is pool-derived (GeckoTerminal), so a
  // consumer or auditor can see exactly which allowlisted venue and which candle backed this price.
  // Null for sources that are not pool-derived; never invented.
  poolAddress: string | null
  candleTimestampMs: number | null
}

// Per-attempt audit record — exactly the fields the audit brief asks for, per bucket AND per source.
export type NativePriceSourceAttempt = {
  bucketDateUtc: string
  bucketStartMs: number
  source: NativePriceSourceId
  quotaGroup: string
  // Endpoint identity WITHOUT any secret — never the key, never a full URL carrying one.
  endpoint: string
  httpStatus: number | null
  responseShape: string | null
  parsedValue: number | null
  rejectionReason: string | null
  // Pool-derived provenance for this attempt (GeckoTerminal only); null otherwise.
  poolAddress: string | null
  poolLabel: string | null
  candleTimestampMs: number | null
  // This resolver deliberately does NOT retry a source within a scan (a 429 is the rate limiter
  // answering definitively; retrying it burns the quota the NEXT bucket needs). Recorded explicitly
  // so "no retry" is visible as a decision rather than looking like an omission.
  retried: false
  // Whether a further source was attempted after this one.
  fallbackRan: boolean
}

function bucketDateUtc(bucketStartMs: number): string {
  return new Date(bucketStartMs).toISOString().slice(0, 10)
}

// PERMANENT CACHE, DISCLOSED — process-lifetime, deliberately NOT cleared per scan. A real historical
// ETH price for a past UTC day is IMMUTABLE: there is no correctness reason to re-fetch it, and
// re-fetching is precisely what exhausts the quota. Only ACCEPTED (finite, positive) prices are here.
type AcceptedBucketPrice = {
  priceUsd: number
  source: NativePriceSourceId
  poolAddress: string | null
  candleTimestampMs: number | null
}

const acceptedPriceByBucket = new Map<number, AcceptedBucketPrice>()

// FAILURES ARE NOT CACHED PERMANENTLY, DISCLOSED: a miss is usually transient (a 429, a breaker
// opened by an unrelated call, a timeout). Recording it for the process lifetime would convert a
// temporary rate-limit blip into a permanent, self-inflicted blind spot. Remembered for THIS SCAN
// only, then cleared by resetNativePriceResolverForScan().
const failedBucketsThisScan = new Set<number>()

// SINGLEFLIGHT, DISCLOSED: consumers asking for the same bucket while a request is in flight join
// that exact promise. Stored before any await, so same-tick callers can never both fire. This wraps
// the WHOLE source chain (not an individual source), so a coalesced consumer receives the final
// resolved outcome including whatever fallback ran — coalescing correctly happens around fallback,
// never inside it.
const inFlightByBucket = new Map<number, Promise<NativePriceResolution | null>>()

type ResolverDiagnostics = {
  bucketsRequested: number
  liveBucketRequests: number
  permanentCacheHits: number
  coalescedHits: number
  acceptedResolutions: number
  failedResolutions: number
  bucketsBlockedByCap: number
  rejectedIneligibleChain: number
  rejectedInvalidTimestamp: number
  sourceAttempts: number
  sourceSuccesses: number
  attemptsBySource: Record<NativePriceSourceId, number>
  successesBySource: Record<NativePriceSourceId, number>
  failureReasonsBySource: Record<NativePriceSourceId, Record<string, number>>
  httpStatusesBySource: Record<NativePriceSourceId, Record<string, number>>
  acceptedBuckets: string[]
  unresolvedBuckets: string[]
  // Which allowlisted pool backed each accepted pool-derived bucket, with its candle timestamp.
  selectedPools: Array<{ bucketDateUtc: string; poolAddress: string; poolLabel: string | null; candleTimestampMs: number | null }>
  // Bounded sample of full per-attempt records, for forensic reading without unbounded log volume.
  attemptLog: NativePriceSourceAttempt[]
}

const MAX_ATTEMPT_LOG_ENTRIES = 40

function emptyBySource<T>(make: () => T): Record<NativePriceSourceId, T> {
  return {
    goldrush_historical: make(),
    geckoterminal_eth_ohlcv: make(),
    coingecko_native_coin_history: make(),
    coingecko_weth_contract_history: make(),
  }
}

function cloneBySource<T>(record: Record<NativePriceSourceId, Record<string, T>>): Record<NativePriceSourceId, Record<string, T>> {
  return {
    goldrush_historical: { ...record.goldrush_historical },
    geckoterminal_eth_ohlcv: { ...record.geckoterminal_eth_ohlcv },
    coingecko_native_coin_history: { ...record.coingecko_native_coin_history },
    coingecko_weth_contract_history: { ...record.coingecko_weth_contract_history },
  }
}

function emptyDiagnostics(): ResolverDiagnostics {
  return {
    bucketsRequested: 0,
    liveBucketRequests: 0,
    permanentCacheHits: 0,
    coalescedHits: 0,
    acceptedResolutions: 0,
    failedResolutions: 0,
    bucketsBlockedByCap: 0,
    rejectedIneligibleChain: 0,
    rejectedInvalidTimestamp: 0,
    sourceAttempts: 0,
    sourceSuccesses: 0,
    attemptsBySource: emptyBySource(() => 0),
    successesBySource: emptyBySource(() => 0),
    failureReasonsBySource: emptyBySource<Record<string, number>>(() => ({})),
    httpStatusesBySource: emptyBySource<Record<string, number>>(() => ({})),
    acceptedBuckets: [],
    unresolvedBuckets: [],
    selectedPools: [],
    attemptLog: [],
  }
}

let diagnostics: ResolverDiagnostics = emptyDiagnostics()
let liveBucketsThisScan = 0

// INDEPENDENT SOURCE INJECTION, DISCLOSED: the GoldRush price function is built exactly once, by
// src/pipeline/index.ts's buildPriceSources() (the only place that reads the key and constructs the
// SDK client), and handed here. The resolver never reads GOLDRUSH_API_KEY, never constructs its own
// client, and never creates a second budget — it reuses the already-budgeted function, so this adds
// no provider budget anywhere outside this module. Null when no real key is configured, in which case
// this source is honestly skipped rather than faked.
let independentNativeSource: PriceSourceFn | null = null

export function registerIndependentNativePriceSource(fn: PriceSourceFn | null): void {
  independentNativeSource = fn
}

// PURE. UTC midnight of the day containing `timestampMs`.
export function nativePriceBucketStart(timestampMs: number): number {
  return Math.floor(timestampMs / NATIVE_PRICE_BUCKET_MS) * NATIVE_PRICE_BUCKET_MS
}

// PURE. True when `chain`'s native asset is genuinely ETH.
export function isEthNativeChain(chain: SupportedChain): boolean {
  return ETH_NATIVE_CHAINS.has(chain)
}

function isAcceptablePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// Per-scan reset — clears transient failure memory, counters and the live-bucket budget. Deliberately
// does NOT clear `acceptedPriceByBucket`: past historical prices are immutable and keeping them is
// the entire point of this module.
export function resetNativePriceResolverForScan(): void {
  failedBucketsThisScan.clear()
  diagnostics = emptyDiagnostics()
  liveBucketsThisScan = 0
  resetGeckoTerminalEthOhlcvForScan()
}

export function getNativePriceResolverDiagnostics(): ResolverDiagnostics & { permanentCacheSize: number } {
  return {
    ...diagnostics,
    attemptsBySource: { ...diagnostics.attemptsBySource },
    successesBySource: { ...diagnostics.successesBySource },
    failureReasonsBySource: cloneBySource(diagnostics.failureReasonsBySource),
    httpStatusesBySource: cloneBySource(diagnostics.httpStatusesBySource),
    selectedPools: [...diagnostics.selectedPools],
    acceptedBuckets: [...diagnostics.acceptedBuckets],
    unresolvedBuckets: [...diagnostics.unresolvedBuckets],
    attemptLog: [...diagnostics.attemptLog],
    permanentCacheSize: acceptedPriceByBucket.size,
  }
}

// TEST-SUPPORT ONLY, DISCLOSED: the permanent cache is intentionally unreachable from production code
// (nothing should be able to discard a known-good immutable price mid-run). Tests need a clean slate.
export function __resetNativePriceResolverForTest(): void {
  acceptedPriceByBucket.clear()
  failedBucketsThisScan.clear()
  inFlightByBucket.clear()
  diagnostics = emptyDiagnostics()
  liveBucketsThisScan = 0
  independentNativeSource = null
  resetGeckoTerminalEthOhlcvForScan()
}

// TEST-SUPPORT ONLY, DISCLOSED: seeds a known-good accepted price so a test can assert reuse /
// coalescing / sharing deterministically without a network call. Rejects anything that is not a real,
// finite, positive price — a fabricated value can never enter the cache through this.
export function __seedAcceptedNativePriceForTest(timestampMs: number, priceUsd: number, source: NativePriceSourceId): void {
  if (!isAcceptablePrice(priceUsd)) throw new Error('__seedAcceptedNativePriceForTest requires a finite positive price')
  acceptedPriceByBucket.set(nativePriceBucketStart(timestampMs), { priceUsd, source, poolAddress: null, candleTimestampMs: null })
}

function buildResolution(
  bucketStartMs: number,
  timestampMs: number,
  accepted: AcceptedBucketPrice,
  flags: { servedFromPermanentCache: boolean; coalesced: boolean },
): NativePriceResolution {
  return {
    priceUsd: accepted.priceUsd,
    source: accepted.source,
    bucketStartMs,
    timestampDistanceMs: timestampMs - bucketStartMs,
    confidence: 'verified',
    servedFromPermanentCache: flags.servedFromPermanentCache,
    coalesced: flags.coalesced,
    poolAddress: accepted.poolAddress,
    candleTimestampMs: accepted.candleTimestampMs,
  }
}

function recordAttempt(attempt: NativePriceSourceAttempt): void {
  diagnostics.sourceAttempts += 1
  diagnostics.attemptsBySource[attempt.source] += 1
  if (attempt.parsedValue != null && attempt.rejectionReason == null) {
    diagnostics.sourceSuccesses += 1
    diagnostics.successesBySource[attempt.source] += 1
  } else if (attempt.rejectionReason) {
    const bucket = diagnostics.failureReasonsBySource[attempt.source]
    bucket[attempt.rejectionReason] = (bucket[attempt.rejectionReason] ?? 0) + 1
  }
  const statusKey = attempt.httpStatus == null ? 'none' : String(attempt.httpStatus)
  const statuses = diagnostics.httpStatusesBySource[attempt.source]
  statuses[statusKey] = (statuses[statusKey] ?? 0) + 1
  if (diagnostics.attemptLog.length < MAX_ATTEMPT_LOG_ENTRIES) diagnostics.attemptLog.push(attempt)
}

type SourceOutcome = {
  priceUsd: number | null
  httpStatus: number | null
  responseShape: string | null
  rejectionReason: string | null
  endpoint: string
  poolAddress?: string | null
  poolLabel?: string | null
  candleTimestampMs?: number | null
}

// SOURCE 2 — GeckoTerminal daily OHLCV from a fixed, allowlisted canonical WETH/stablecoin pool. A
// third independent quota group: different host, no API key, unaffected by a CoinGecko 429 or open
// breaker. See geckoTerminalEthOhlcv.ts for the allowlist, the exact-UTC-day candle requirement, the
// pool-identity check and the per-scan request cap.
async function attemptGeckoTerminal(chain: SupportedChain, timestamp: number, bucketStartMs: number): Promise<SourceOutcome> {
  const result = await fetchGeckoTerminalEthUsdForUtcDay({ chain, timestampMs: timestamp, bucketStartMs })
  return {
    priceUsd: result.priceUsd,
    httpStatus: result.httpStatus,
    responseShape: result.responseShape,
    rejectionReason: result.rejectionReason,
    endpoint: result.endpoint,
    poolAddress: result.poolAddress,
    poolLabel: result.poolLabel,
    candleTimestampMs: result.candleTimestampMs,
  }
}

// SOURCE 1 — GoldRush historical pricing. Genuinely independent quota/key/breaker. Uses the injected,
// already-budgeted function; never constructs a client or reads a key here.
async function attemptGoldrush(chain: SupportedChain, timestamp: number): Promise<SourceOutcome> {
  const endpoint = 'goldrush:PricingService.getTokenPrices(from=to=UTC-day)'
  if (!independentNativeSource) {
    return { priceUsd: null, httpStatus: null, responseShape: null, rejectionReason: 'goldrush_source_not_configured', endpoint }
  }
  const wethAddress = CANONICAL_WETH_BY_CHAIN[chain]
  if (!wethAddress) {
    return { priceUsd: null, httpStatus: null, responseShape: null, rejectionReason: 'no_canonical_weth_for_chain', endpoint }
  }
  try {
    const priceUsd = await independentNativeSource(wethAddress, chain, timestamp)
    if (isAcceptablePrice(priceUsd)) {
      return { priceUsd, httpStatus: null, responseShape: 'sdk_price_number', rejectionReason: null, endpoint }
    }
    // The SDK surfaces no HTTP status; a null here is its own honest "no data / breaker open / error".
    return { priceUsd: null, httpStatus: null, responseShape: 'sdk_null', rejectionReason: 'goldrush_no_price', endpoint }
  } catch {
    return { priceUsd: null, httpStatus: null, responseShape: null, rejectionReason: 'goldrush_threw', endpoint }
  }
}

// SOURCE 2 — CoinGecko native coin history.
async function attemptCoingeckoNative(timestamp: number): Promise<SourceOutcome> {
  const endpoint = 'coingecko:/coins/ethereum/history?date=DD-MM-YYYY'
  const result = await fetchCoingeckoNativeEthPriceDetailed(timestamp)
  const shape = result.diagnostic.responseShapePresent
  if (isAcceptablePrice(result.priceUsd)) {
    return { priceUsd: result.priceUsd, httpStatus: result.diagnostic.httpStatus, responseShape: 'market_data.current_price.usd', rejectionReason: null, endpoint }
  }
  return {
    priceUsd: null,
    httpStatus: result.diagnostic.httpStatus,
    responseShape: `marketData=${shape.marketData},currentPrice=${shape.currentPrice},usd=${shape.usd}`,
    rejectionReason: result.diagnostic.failureReason ?? result.reason ?? 'coingecko_native_no_price',
    endpoint,
  }
}

// SOURCE 3 — CoinGecko canonical-WETH contract history. SAME QUOTA AND SAME BREAKER as source 2 (see
// this module's header): retained as a genuine last resort, never counted on to rescue a 429.
async function attemptCoingeckoWethContract(chain: SupportedChain, timestamp: number): Promise<SourceOutcome> {
  const endpoint = 'coingecko:/coins/{platform}/contract/{weth}/market_chart/range'
  const wethAddress = CANONICAL_WETH_BY_CHAIN[chain]
  if (!wethAddress) {
    return { priceUsd: null, httpStatus: null, responseShape: null, rejectionReason: 'no_canonical_weth_for_chain', endpoint }
  }
  const result = await fetchCoingeckoPriceDetailed(wethAddress, chain, timestamp)
  if (isAcceptablePrice(result.priceUsd)) {
    return { priceUsd: result.priceUsd, httpStatus: null, responseShape: 'prices[][1]', rejectionReason: null, endpoint }
  }
  return { priceUsd: null, httpStatus: null, responseShape: null, rejectionReason: result.reason ?? 'coingecko_contract_no_price', endpoint }
}

async function attemptSource(
  source: NativePriceSourceId,
  chain: SupportedChain,
  timestamp: number,
  bucketStartMs: number,
): Promise<SourceOutcome> {
  if (source === 'goldrush_historical') return attemptGoldrush(chain, timestamp)
  if (source === 'geckoterminal_eth_ohlcv') return attemptGeckoTerminal(chain, timestamp, bucketStartMs)
  if (source === 'coingecko_native_coin_history') return attemptCoingeckoNative(timestamp)
  return attemptCoingeckoWethContract(chain, timestamp)
}

// Runs the deterministic source chain for one bucket, recording a full audit record per attempt.
async function resolveLive(
  chain: SupportedChain,
  timestamp: number,
  bucketStartMs: number,
): Promise<AcceptedBucketPrice | null> {
  const dateUtc = bucketDateUtc(bucketStartMs)
  // Quota groups already known to be exhausted this scan — a second source in the SAME group cannot
  // rescue the first, so it is skipped honestly rather than burning a guaranteed-failing round trip.
  // This is exactly the condition that made the previous revision's "fallback" a no-op.
  const exhaustedQuotaGroups = new Set<string>()
  const pending: NativePriceSourceAttempt[] = []

  for (let i = 0; i < SOURCE_ORDER.length; i += 1) {
    const source = SOURCE_ORDER[i]
    const quotaGroup = SOURCE_QUOTA_GROUP[source]

    let outcome: SourceOutcome
    if (exhaustedQuotaGroups.has(quotaGroup)) {
      outcome = {
        priceUsd: null,
        httpStatus: null,
        responseShape: null,
        rejectionReason: 'skipped_quota_group_already_exhausted',
        endpoint: `${quotaGroup}:skipped`,
      }
    } else if (quotaGroup === 'coingecko' && isCoingeckoCircuitOpenForTest()) {
      // The shared CoinGecko breaker is already open (tripped by this or an unrelated call) — every
      // CoinGecko source will short-circuit anyway. Recorded as a skip so the audit shows a quota
      // problem rather than an ambiguous "no price".
      exhaustedQuotaGroups.add(quotaGroup)
      outcome = {
        priceUsd: null,
        httpStatus: null,
        responseShape: null,
        rejectionReason: 'skipped_coingecko_breaker_open',
        endpoint: 'coingecko:skipped',
      }
    } else {
      outcome = await attemptSource(source, chain, timestamp, bucketStartMs)
      if (outcome.httpStatus === 429 || outcome.rejectionReason === 'coingecko_http_429') {
        exhaustedQuotaGroups.add(quotaGroup)
      }
    }

    pending.push({
      bucketDateUtc: dateUtc,
      bucketStartMs,
      source,
      quotaGroup,
      endpoint: outcome.endpoint,
      httpStatus: outcome.httpStatus,
      responseShape: outcome.responseShape,
      parsedValue: outcome.priceUsd,
      rejectionReason: outcome.rejectionReason,
      poolAddress: outcome.poolAddress ?? null,
      poolLabel: outcome.poolLabel ?? null,
      candleTimestampMs: outcome.candleTimestampMs ?? null,
      retried: false,
      fallbackRan: false,
    })

    if (isAcceptablePrice(outcome.priceUsd)) {
      pending.forEach(recordAttempt)
      if (outcome.poolAddress) {
        diagnostics.selectedPools.push({
          bucketDateUtc: dateUtc,
          poolAddress: outcome.poolAddress,
          poolLabel: outcome.poolLabel ?? null,
          candleTimestampMs: outcome.candleTimestampMs ?? null,
        })
      }
      return {
        priceUsd: outcome.priceUsd,
        source,
        poolAddress: outcome.poolAddress ?? null,
        candleTimestampMs: outcome.candleTimestampMs ?? null,
      }
    }
    // A further source exists and will be attempted — record that on the attempt just made.
    if (i < SOURCE_ORDER.length - 1) pending[pending.length - 1].fallbackRan = true
  }

  pending.forEach(recordAttempt)
  return null
}

// THE ONE SHARED ENTRY POINT. Returns a real, accepted historical ETH/USD price for `timestamp`, or
// null. Never throws, never fabricates, never returns a current price, never returns a price for a
// day other than the one requested.
export async function resolveHistoricalNativeUsdPrice(params: {
  chain: SupportedChain
  timestamp: number
  // Real "now" for future-timestamp rejection. Injected so tests are deterministic; defaults to the
  // real clock. NOT a pricing input — it can only cause a rejection, never produce a price.
  nowMs?: number
}): Promise<NativePriceResolution | null> {
  const { chain, timestamp } = params
  const nowMs = params.nowMs ?? Date.now()

  // FAIL CLOSED ON AN INELIGIBLE CHAIN: a chain whose native asset is not ETH must never be handed an
  // ETH price. That would be a fabricated value, not an approximation.
  if (!isEthNativeChain(chain)) {
    diagnostics.rejectedIneligibleChain += 1
    return null
  }

  // FAIL CLOSED ON A NON-HISTORICAL TIMESTAMP: NaN, non-finite, non-positive, or in the future. A
  // future timestamp has no historical price by definition — answering it would necessarily mean
  // serving a current price as historical proof, which this module exists to prevent.
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > nowMs) {
    diagnostics.rejectedInvalidTimestamp += 1
    return null
  }

  const bucketStartMs = nativePriceBucketStart(timestamp)

  const cached = acceptedPriceByBucket.get(bucketStartMs)
  if (cached) {
    diagnostics.permanentCacheHits += 1
    return buildResolution(bucketStartMs, timestamp, cached, { servedFromPermanentCache: true, coalesced: false })
  }

  // This scan already learned this bucket is unavailable — never spend a second chain of calls on it.
  if (failedBucketsThisScan.has(bucketStartMs)) return null

  // COALESCE AROUND THE WHOLE SOURCE CHAIN, DISCLOSED: joining here means a second consumer receives
  // the FINAL outcome including whatever fallback ran — never a partial, first-source-only answer.
  const inFlight = inFlightByBucket.get(bucketStartMs)
  if (inFlight) {
    diagnostics.coalescedHits += 1
    const shared = await inFlight
    if (!shared) return null
    // Rebuilt against THIS caller's own timestamp so `timestampDistanceMs` stays honest per consumer;
    // the underlying price and source are the shared ones, unchanged.
    return buildResolution(
      bucketStartMs,
      timestamp,
      { priceUsd: shared.priceUsd, source: shared.source, poolAddress: shared.poolAddress, candleTimestampMs: shared.candleTimestampMs },
      { servedFromPermanentCache: false, coalesced: true },
    )
  }

  if (liveBucketsThisScan >= MAX_NATIVE_PRICE_LIVE_BUCKETS_PER_SCAN) {
    diagnostics.bucketsBlockedByCap += 1
    return null
  }

  liveBucketsThisScan += 1
  diagnostics.liveBucketRequests += 1

  const live = (async (): Promise<NativePriceResolution | null> => {
    const resolved = await resolveLive(chain, timestamp, bucketStartMs)
    if (!resolved) {
      failedBucketsThisScan.add(bucketStartMs)
      diagnostics.failedResolutions += 1
      diagnostics.unresolvedBuckets.push(bucketDateUtc(bucketStartMs))
      return null
    }
    acceptedPriceByBucket.set(bucketStartMs, resolved)
    diagnostics.acceptedResolutions += 1
    diagnostics.acceptedBuckets.push(bucketDateUtc(bucketStartMs))
    return buildResolution(bucketStartMs, timestamp, resolved, { servedFromPermanentCache: false, coalesced: false })
  })()

  inFlightByBucket.set(bucketStartMs, live)
  try {
    return await live
  } finally {
    inFlightByBucket.delete(bucketStartMs)
  }
}

// BOUNDED PREFETCH, DISCLOSED — resolves a set of required timestamps into their distinct buckets up
// front, so a SYNCHRONOUS consumer (src/pipeline/priceLotsForWallet.ts's same-tx quote-leg gap-fill
// loop, which cannot await) can read real prices out of a plain Map. Distinct buckets only: many
// requirements clustered across a handful of calendar days cost a handful of resolutions. Sequential
// by design — firing these concurrently is what produced the 429 storm in the first place.
export async function prefetchNativeUsdPrices(params: {
  requirements: ReadonlyArray<{ chain: SupportedChain; timestamp: number }>
  nowMs?: number
}): Promise<Map<number, NativePriceResolution>> {
  const byBucket = new Map<number, NativePriceResolution>()
  const seen = new Set<number>()

  // Deterministic order: earliest bucket first, then chain name — so a capped run always resolves the
  // SAME subset, never a different one depending on iteration accident.
  const ordered = [...params.requirements]
    .filter((r) => Number.isFinite(r.timestamp) && r.timestamp > 0 && isEthNativeChain(r.chain))
    .sort((a, b) => a.timestamp - b.timestamp || a.chain.localeCompare(b.chain))

  for (const requirement of ordered) {
    const bucketStartMs = nativePriceBucketStart(requirement.timestamp)
    if (seen.has(bucketStartMs)) continue
    seen.add(bucketStartMs)
    diagnostics.bucketsRequested += 1
    const resolution = await resolveHistoricalNativeUsdPrice({ chain: requirement.chain, timestamp: requirement.timestamp, nowMs: params.nowMs })
    if (resolution) byBucket.set(bucketStartMs, resolution)
  }

  return byBucket
}

// Reads a prefetched bucket for `timestamp`. PURE — never triggers a call, returns null when the
// bucket genuinely was not resolved.
export function readPrefetchedNativeUsdPrice(
  prefetched: ReadonlyMap<number, NativePriceResolution>,
  timestamp: number,
): NativePriceResolution | null {
  if (!Number.isFinite(timestamp)) return null
  return prefetched.get(nativePriceBucketStart(timestamp)) ?? null
}
