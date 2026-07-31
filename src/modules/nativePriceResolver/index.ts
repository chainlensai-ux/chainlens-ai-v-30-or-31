// MODULE — nativePriceResolver: ONE shared historical ETH/WETH → USD resolver.
//
// AUDITED ROOT CAUSE (production baseline: 495 pricing requirements, 472 failed, 288 capped by
// maxLookupsPerToken=2, 53 native ETH/WETH requirements with only 4 selected, 51 quote candidates
// failing `missing_verified_native_price`):
//
// ETH's USD price at a given historical instant is a GLOBAL SCALAR. It is the same number for Base
// native ETH, Ethereum native ETH, and canonical WETH on either chain — it does not vary by chain,
// by token contract, by wallet, or by which closed lot happens to need it. Despite that, this
// codebase resolved it through THREE independent paths that never shared a result:
//
//   1. src/pipeline/priceLotsForWallet.ts — derived `historicalNativePrice` by dividing an
//      already-resolved costUsd/proceedsUsd[txHash] slot by the leg amount. That slot only exists if
//      that specific native leg survived MAX_LOOKUPS_PER_TOKEN (2). So ETH's one global price was
//      rationed by a PER-TOKEN CALL CAP it never needed to be subject to: 53 native requirements
//      competed for 2 slots, 4 were selected, and the other 51 quote candidates failed
//      `missing_verified_native_price` — not because ETH's price was unknowable at those timestamps,
//      but because nothing shared the answer.
//   2. src/modules/pricingAtTimeEngine/sources/basedex.ts — its own per-scan `sharedQuoteUsdCache`,
//      hardcoded to Base WETH via the CONTRACT-based CoinGecko endpoint, cleared every scan.
//   3. src/modules/pricingAtTimeEngine/sources/coingecko.ts — its own per-scan `nativeEthHistoryCache`,
//      via the NATIVE-COIN-ID endpoint, keyed `ethereum:DD-MM-YYYY`, also cleared every scan.
//
// Paths 2 and 3 resolve the identical number for the identical day and never share it with each
// other or with path 1. This module is the single resolver all three now go through.
//
// EVIDENCE STANDARD IS UNCHANGED, DISCLOSED — this is the point that matters most. The price this
// module returns comes from exactly the same real sources, at exactly the same real historical
// granularity, that already backed `historicalNativePrice` before this module existed (path 1's
// costUsd slot was itself filled by CoinGecko's daily native history). Nothing here upgrades a
// weaker price into a stronger one, relabels an estimate as verified, or lowers any gate. The only
// thing that changes is that ONE accepted answer is now reused everywhere it applies, instead of
// being recomputed under a cap that could only afford it a handful of times.
//
// NEVER A CURRENT PRICE: this module has no "now" path. Every entry point requires a real historical
// timestamp, and a timestamp that is invalid or in the future is rejected outright (null) rather
// than silently served with a spot price. A current ETH price is never historical proof.

import type { SupportedChain } from '../providerFetchWindow/types'
import { fetchCoingeckoNativeEthPriceDetailed, fetchCoingeckoPriceDetailed } from '../pricingAtTimeEngine/sources/coingecko'

// BUCKET GRANULARITY, DISCLOSED: one UTC calendar day. This is not an arbitrary choice — it is the
// REAL resolution of the primary source (CoinGecko's `/coins/{id}/history` endpoint is documented
// and keyed as `date=DD-MM-YYYY`, one price per coin per calendar day). Bucketing any finer would
// invent precision the underlying data does not have; bucketing any coarser would blur genuinely
// distinct days. Consumers are told the exact distance from their requested instant to the bucket's
// own resolution instant (see `timestampDistanceMs`) so nothing about this approximation is hidden.
export const NATIVE_PRICE_BUCKET_MS = 86_400_000

// HARD CAP, DISCLOSED: the maximum number of DISTINCT day-buckets this process will ever resolve
// live. Reached only by genuinely distinct calendar days that a real closed lot needs — repeats,
// same-day consumers, and anything already in the permanent cache all cost zero. Once exhausted, a
// new bucket fails closed (null), never falls back to a nearby day's price or a current price.
export const MAX_NATIVE_PRICE_LIVE_BUCKETS_PER_PROCESS = 60

// Chains whose NATIVE asset is genuinely ETH, so that one ETH/USD figure is the correct native price
// for them. Explicitly allow-listed, never inferred — `hyperevm` is deliberately absent (its native
// asset is not ETH, and serving it an ETH price would be a fabricated value, not an approximation).
const ETH_NATIVE_CHAINS: ReadonlySet<SupportedChain> = new Set<SupportedChain>(['eth', 'base', 'arbitrum'])

// Canonical WETH contract per ETH-native chain — used ONLY as the fallback source's lookup address.
// Same addresses quoteLegPricing/index.ts already registers; duplicated here deliberately rather
// than imported, because that module's copy is private to its own leg-classification logic and this
// module must not depend on it for a pricing route.
const CANONICAL_WETH_BY_CHAIN: Partial<Record<SupportedChain, string>> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
}

export type NativePriceSource = 'coingecko_native_coin_history' | 'coingecko_weth_contract_history'

export type NativePriceResolution = {
  priceUsd: number
  // Which real source actually produced this accepted price.
  source: NativePriceSource
  // UTC midnight of the day this price is for.
  bucketStartMs: number
  // Real, disclosed distance from the caller's requested instant to `bucketStartMs`. Always in
  // [0, NATIVE_PRICE_BUCKET_MS). Exposed so a consumer can apply its own tolerance rather than
  // trusting an opaque "close enough".
  timestampDistanceMs: number
  // 'verified' — a real historical price, from a real source, for the real day requested. This module
  // never returns any other confidence value: an answer it cannot stand behind is returned as null.
  confidence: 'verified'
  // True when this answer came from the process-lifetime accepted-price cache (zero provider calls).
  servedFromPermanentCache: boolean
  // True when this answer joined an already-in-flight request for the same bucket (zero extra calls).
  coalesced: boolean
}

// PERMANENT CACHE, DISCLOSED — process-lifetime, deliberately NOT cleared per scan (unlike every
// other cache in this pricing stack). A real historical ETH price for a past UTC day is IMMUTABLE:
// there is no correctness reason to ever re-fetch it, and re-fetching is precisely what exhausted
// the rate limit that produced the production baseline's 429s. Only ACCEPTED (finite, positive)
// prices are stored here.
const acceptedPriceByBucket = new Map<number, { priceUsd: number; source: NativePriceSource }>()

// FAILURES ARE NOT CACHED PERMANENTLY, DISCLOSED: a miss is usually transient (a 429, a breaker
// opened by an unrelated call, a timeout) — recording it for the life of the process would convert a
// temporary rate-limit blip into a permanent, self-inflicted blind spot. Failures are remembered for
// THIS SCAN ONLY (so one scan never retries the same doomed bucket), then cleared by
// resetNativePriceResolverForScan().
const failedBucketsThisScan = new Set<number>()

// SINGLEFLIGHT, DISCLOSED: every consumer asking for the same bucket while a request is in flight
// joins that exact promise. Stored before any await, so two same-tick callers can never both fire.
const inFlightByBucket = new Map<number, Promise<NativePriceResolution | null>>()

type ResolverDiagnostics = {
  liveBucketRequests: number
  permanentCacheHits: number
  coalescedHits: number
  acceptedResolutions: number
  failedResolutions: number
  bucketsBlockedByCap: number
  rejectedIneligibleChain: number
  rejectedInvalidTimestamp: number
  distinctBucketsAccepted: number
  sourceCounts: Record<NativePriceSource, number>
}

let diagnostics: ResolverDiagnostics = emptyDiagnostics()

function emptyDiagnostics(): ResolverDiagnostics {
  return {
    liveBucketRequests: 0,
    permanentCacheHits: 0,
    coalescedHits: 0,
    acceptedResolutions: 0,
    failedResolutions: 0,
    bucketsBlockedByCap: 0,
    rejectedIneligibleChain: 0,
    rejectedInvalidTimestamp: 0,
    distinctBucketsAccepted: 0,
    sourceCounts: { coingecko_native_coin_history: 0, coingecko_weth_contract_history: 0 },
  }
}

let liveBucketsThisProcess = 0

// PURE. UTC midnight of the day containing `timestampMs`.
export function nativePriceBucketStart(timestampMs: number): number {
  return Math.floor(timestampMs / NATIVE_PRICE_BUCKET_MS) * NATIVE_PRICE_BUCKET_MS
}

// PURE. True when `chain`'s native asset is genuinely ETH, so an ETH/USD price is the correct answer.
export function isEthNativeChain(chain: SupportedChain): boolean {
  return ETH_NATIVE_CHAINS.has(chain)
}

function isAcceptablePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// Per-scan reset — clears the transient failure memory and this scan's counters. Deliberately does
// NOT clear `acceptedPriceByBucket` (see its own header: past historical prices are immutable, and
// keeping them is the entire point of this module).
export function resetNativePriceResolverForScan(): void {
  failedBucketsThisScan.clear()
  diagnostics = emptyDiagnostics()
}

export function getNativePriceResolverDiagnostics(): ResolverDiagnostics & { permanentCacheSize: number } {
  return { ...diagnostics, sourceCounts: { ...diagnostics.sourceCounts }, permanentCacheSize: acceptedPriceByBucket.size }
}

// TEST-SUPPORT ONLY, DISCLOSED: the permanent cache is intentionally unreachable from production
// code (nothing should ever be able to discard a known-good immutable price mid-run). Tests need a
// clean slate between cases, so this is the one, explicitly-named escape hatch.
export function __resetNativePriceResolverForTest(): void {
  acceptedPriceByBucket.clear()
  failedBucketsThisScan.clear()
  inFlightByBucket.clear()
  diagnostics = emptyDiagnostics()
  liveBucketsThisProcess = 0
}

// TEST-SUPPORT ONLY, DISCLOSED: seeds a known-good accepted price so a test can assert the reuse /
// coalescing / sharing behavior deterministically without a network call. Rejects anything that
// isn't a real, finite, positive price — a test can never seed a fabricated value through this.
export function __seedAcceptedNativePriceForTest(timestampMs: number, priceUsd: number, source: NativePriceSource): void {
  if (!isAcceptablePrice(priceUsd)) throw new Error('__seedAcceptedNativePriceForTest requires a finite positive price')
  acceptedPriceByBucket.set(nativePriceBucketStart(timestampMs), { priceUsd, source })
}

function buildResolution(
  bucketStartMs: number,
  timestampMs: number,
  priceUsd: number,
  source: NativePriceSource,
  flags: { servedFromPermanentCache: boolean; coalesced: boolean },
): NativePriceResolution {
  return {
    priceUsd,
    source,
    bucketStartMs,
    timestampDistanceMs: timestampMs - bucketStartMs,
    confidence: 'verified',
    servedFromPermanentCache: flags.servedFromPermanentCache,
    coalesced: flags.coalesced,
  }
}

// DETERMINISTIC FALLBACK ORDER, DISCLOSED — fixed, never reordered by outcome, never randomized:
//
//   1. CoinGecko native coin history (`/coins/ethereum/history`). The primary, most complete ETH
//      dataset — this is ETH indexed under its own coin id, not derived from a wrapper contract.
//   2. CoinGecko canonical-WETH contract history for the requesting chain. A genuinely independent
//      dataset (contract-derived) that can answer days the coin history misses. 1 WETH ≡ 1 ETH in
//      USD terms, always, so this is the same quantity — not a substitute for a different asset.
//
// Both are real sources already integrated in this codebase; this adds no new provider, no new key,
// and no new endpoint. If BOTH genuinely return nothing, this fails closed with null — it never
// falls through to a neighbouring day, an interpolation, or a current price.
async function resolveLive(chain: SupportedChain, timestampMs: number, bucketStartMs: number): Promise<{ priceUsd: number; source: NativePriceSource } | null> {
  const nativeResult = await fetchCoingeckoNativeEthPriceDetailed(timestampMs)
  if (isAcceptablePrice(nativeResult.priceUsd)) {
    return { priceUsd: nativeResult.priceUsd, source: 'coingecko_native_coin_history' }
  }

  const wethAddress = CANONICAL_WETH_BY_CHAIN[chain]
  if (!wethAddress) return null

  const contractResult = await fetchCoingeckoPriceDetailed(wethAddress, chain, timestampMs)
  if (isAcceptablePrice(contractResult.priceUsd)) {
    return { priceUsd: contractResult.priceUsd, source: 'coingecko_weth_contract_history' }
  }

  // Referenced so the bucket is part of this function's own signature-level contract even when both
  // sources miss — the caller records the failure against exactly this bucket, never a nearby one.
  void bucketStartMs
  return null
}

// THE ONE SHARED ENTRY POINT. Returns a real, accepted historical ETH/USD price for `timestamp`, or
// null. Never throws, never fabricates, never returns a current price, never returns a price for a
// day other than the one requested.
export async function resolveHistoricalNativeUsdPrice(params: {
  chain: SupportedChain
  timestamp: number
  // Real "now" for future-timestamp rejection. Injected so tests are deterministic; defaults to the
  // real clock. This is NOT a pricing input — it can only cause a rejection, never a price.
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
    return buildResolution(bucketStartMs, timestamp, cached.priceUsd, cached.source, { servedFromPermanentCache: true, coalesced: false })
  }

  // This scan already learned this bucket is unavailable — never spend a second call on it.
  if (failedBucketsThisScan.has(bucketStartMs)) return null

  const inFlight = inFlightByBucket.get(bucketStartMs)
  if (inFlight) {
    diagnostics.coalescedHits += 1
    const shared = await inFlight
    if (!shared) return null
    // Rebuilt against THIS caller's own timestamp so `timestampDistanceMs` is honest per consumer —
    // the underlying price and source are the shared ones, unchanged.
    return buildResolution(bucketStartMs, timestamp, shared.priceUsd, shared.source, { servedFromPermanentCache: false, coalesced: true })
  }

  if (liveBucketsThisProcess >= MAX_NATIVE_PRICE_LIVE_BUCKETS_PER_PROCESS) {
    diagnostics.bucketsBlockedByCap += 1
    return null
  }

  liveBucketsThisProcess += 1
  diagnostics.liveBucketRequests += 1

  const live = (async (): Promise<NativePriceResolution | null> => {
    const resolved = await resolveLive(chain, timestamp, bucketStartMs)
    if (!resolved) {
      failedBucketsThisScan.add(bucketStartMs)
      diagnostics.failedResolutions += 1
      return null
    }
    acceptedPriceByBucket.set(bucketStartMs, resolved)
    diagnostics.acceptedResolutions += 1
    diagnostics.distinctBucketsAccepted += 1
    diagnostics.sourceCounts[resolved.source] += 1
    return buildResolution(bucketStartMs, timestamp, resolved.priceUsd, resolved.source, { servedFromPermanentCache: false, coalesced: false })
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
// loop, which cannot await) can read real prices out of a plain Map. Distinct buckets only: 53 native
// requirements clustered across a handful of calendar days cost a handful of calls, not 53. Sequential
// by design — these all hit the same CoinGecko rate-limit bucket, and firing them concurrently is what
// produced the production baseline's 429s.
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
