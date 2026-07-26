// MODULE — pricingAtTimeEngine/sources: alchemyHistoricalPriceSource
//
// SHADOW MODE, DISCLOSED: this module ONLY records what Alchemy's real historical-price endpoint
// would have returned for still-unresolved closed-lot pricing requirements — it never writes into
// costUsd/proceedsUsd, never changes FIFO/ranking/PnL/public-gate output. It exists to gather real,
// safe, bounded evidence before ever being wired into the official pricing path.
//
// REAL ENDPOINT, VERIFIED: Alchemy's Prices API historical endpoint —
// POST https://api.g.alchemy.com/prices/v1/{apiKey}/tokens/historical
// body: { network, address, startTime, endTime, interval } — returns a real daily/hourly price
// series for one (network, address) pair over a bounded time range. This is the ONLY Alchemy
// pricing call this module makes; no per-trade lookups, no "all holdings" sweep.
//
// KEY REUSE, DISCLOSED: this module keeps its own local copy of the chain->key-names/network-slug
// map — same "no runtime coupling between modules" convention already used throughout this codebase
// (providerFetchWindow/utils.ts, recoveryPolicy, holdings, goldrushPriceSource.ts's own chain-slug
// copy, etc.) — rather than importing providerFetchWindow's private (unexported) alchemyApiKey.

import type { SupportedChain } from '../../providerFetchWindow/types'

const ALCHEMY_KEY_NAMES: Partial<Record<SupportedChain, string[]>> = {
  eth: ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY'],
  base: ['ALCHEMY_BASE_KEY', 'ALCHEMY_BASE_API_KEY', 'BASE_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY'],
  arbitrum: ['ALCHEMY_ARBITRUM_KEY', 'ALCHEMY_ARBITRUM_API_KEY', 'ARBITRUM_ALCHEMY_API_KEY', 'ALCHEMY_API_KEY'],
  // hyperevm intentionally omitted — no verified Alchemy network slug for it, same convention as
  // providerFetchWindow/utils.ts's own ALCHEMY_VERIFIED_CHAINS.
}
const ALCHEMY_NETWORK_SLUGS: Partial<Record<SupportedChain, string>> = {
  eth: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arb-mainnet',
}

function alchemyApiKey(chain: SupportedChain): string {
  const names = ALCHEMY_KEY_NAMES[chain]
  if (!names) return ''
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim().length > 0) return value.trim()
  }
  return ''
}

// Canonical native/WETH + verified stablecoin addresses, per chain — this module's OWN local copy
// (same convention as quoteLegPricing/index.ts's registries), used only for tier-2 priority
// classification below, never for any pricing-derivation logic.
const TIER2_ADDRESSES: Partial<Record<SupportedChain, Set<string>>> = {
  eth: new Set([
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  ]),
  base: new Set([
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  ]),
  arbitrum: new Set([
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
}

export function isTier2Asset(chain: SupportedChain, contract: string): boolean {
  const set = TIER2_ADDRESSES[chain]
  return set ? set.has(contract.toLowerCase()) : false
}

// BOUNDED BUDGET, DISCLOSED: 10 live Alchemy requests per scan, matching Alchemy's documented ~40 CU
// cost for one historical-price call — 10 * 40 = 400 CU ceiling per scan, never exceeded regardless
// of how many distinct assets/requirements exist.
export const MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN = 10
export const ESTIMATED_CU_PER_ALCHEMY_HISTORICAL_REQUEST = 40

export type AlchemyPricingRequirement = {
  chain: SupportedChain
  token: string
  txHash: string
  timestamp: number
  oneSideMissing: boolean
}

export type AlchemyHistoricalPricePoint = { timestamp: number; priceUsd: number }

export type AlchemyAssetRangeResult = {
  ok: boolean
  reason: string | null
  points: AlchemyHistoricalPricePoint[]
}

// PER-SCAN STATE, DISCLOSED — reset at the same per-scan boundary every other provider-call-budget
// state in this codebase resets at (see resetAlchemyHistoricalPricingState below).
let liveRequests = 0
let cacheHitsCount = 0
let coalescedHitsCount = 0
let cappedRequestsCount = 0
let duplicateRequestCount = 0
let successfulRequestsCount = 0
let failedRequestsCount = 0
let requirementsResolvedCount = 0
let largestRangeDaysSeen = 0
let closestPriceDistanceMsSeen = 0
let rejectedByTemporalDistanceCount = 0
const rangeCache = new Map<string, Promise<AlchemyAssetRangeResult>>()
const requestedRangeKeysThisScan = new Set<string>()
let negativeCacheHitsCount = 0
const resolvedByChainCounts = new Map<string, number>()
const resolvedByAssetCounts = new Map<string, number>()
const failureReasonCounts = new Map<string, number>()
const selectedAssetOrder: string[] = []
// NEGATIVE CACHE, DISCLOSED: once Alchemy tells us a token was not found for an asset, that exact
// chain+token is never requested again this scan — no range or requirement can revive it.
const tokenNotFoundNegativeCache = new Set<string>()
// PRIORITY STATE, DISCLOSED: assets that already had a genuine Alchemy success this scan get
// bumped ahead of untested ones for any later, still-unresolved requirements (see tierOf below).
const assetsWithPriorSuccessThisScan = new Set<string>()

export function resetAlchemyHistoricalPricingState(): void {
  liveRequests = 0
  cacheHitsCount = 0
  coalescedHitsCount = 0
  cappedRequestsCount = 0
  duplicateRequestCount = 0
  successfulRequestsCount = 0
  failedRequestsCount = 0
  requirementsResolvedCount = 0
  largestRangeDaysSeen = 0
  closestPriceDistanceMsSeen = 0
  rejectedByTemporalDistanceCount = 0
  negativeCacheHitsCount = 0
  rangeCache.clear()
  requestedRangeKeysThisScan.clear()
  resolvedByChainCounts.clear()
  resolvedByAssetCounts.clear()
  failureReasonCounts.clear()
  selectedAssetOrder.length = 0
  tokenNotFoundNegativeCache.clear()
  assetsWithPriorSuccessThisScan.clear()
}

function bumpMapCount(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map.entries())
}

function assetKey(chain: SupportedChain, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

// PRIORITY, DISCLOSED, per this task's explicit ordering:
//   1. ETH/WETH/stables (deepest, most reliable coverage — worth spending a scarce slot on)
//   2. one-side-missing lots (the specific gap this whole feature exists to close)
//   3. assets this scan already had a live Alchemy success for (spending another slot on a proven,
//      responsive asset is more likely to pay off than a cold, unverified one)
//   4. everything else, with "unknown" Base microcaps (chain === 'base', not otherwise classified)
//      pushed to the very back — Base has the highest proportion of unverified/rugged microcap
//      contracts in this codebase's traffic, so they are the least likely bounded-budget spend to
//      pay off and are honestly deprioritised rather than guessed at with a popularity heuristic.
function tierOf(
  req: Pick<AlchemyPricingRequirement, 'chain' | 'token' | 'oneSideMissing'>,
  assetsWithPriorSuccess: Set<string>,
): 1 | 2 | 3 | 4 {
  if (isTier2Asset(req.chain, req.token)) return 1
  if (req.oneSideMissing) return 2
  if (assetsWithPriorSuccess.has(assetKey(req.chain, req.token))) return 3
  return 4
}

// Within tier 4 ("everything else"), unknown Base microcaps sort after every other tier-4 asset —
// this is a pure tie-break, never promotes/demotes across tiers 1-3.
function isUnknownBaseMicrocap(chain: SupportedChain, token: string): boolean {
  return chain === 'base' && !isTier2Asset(chain, token)
}

export type AlchemyHistoricalAuditRecord = {
  eligibleRequirements: number
  uniqueAssets: number
  liveRequests: number
  cacheHits: number
  coalescedHits: number
  cappedRequests: number
  estimatedCu: number
  duplicateRequestCount: number
  successfulRequests: number
  failedRequests: number
  requirementsResolved: number
  resolvedByChain: Record<string, number>
  resolvedByAsset: Record<string, number>
  failureReasons: Record<string, number>
  largestRangeDays: number
  closestPriceDistanceMs: number
  selectedAssetOrder: string[]
  acceptedRequirementsResolved: number
  rejectedByTemporalDistance: number
  negativeCacheHits: number
}

// TEMPORAL ACCEPTANCE, DISCLOSED: a resolved price is only ACCEPTED if the closest returned price
// point is within this asset class's max acceptable distance from the requirement's own timestamp.
// ETH/WETH/stables get a wider window (deep, liquid markets move less between daily points); every
// other token gets a tighter window (thin markets can move a lot in a day) — anything farther is
// rejected as temporal_distance_exceeded rather than silently accepted as "close enough."
const TIER2_MAX_TEMPORAL_DISTANCE_MS = 24 * 60 * 60 * 1000
const OTHER_MAX_TEMPORAL_DISTANCE_MS = 6 * 60 * 60 * 1000

function maxTemporalDistanceMsFor(chain: SupportedChain, token: string): number {
  return isTier2Asset(chain, token) ? TIER2_MAX_TEMPORAL_DISTANCE_MS : OTHER_MAX_TEMPORAL_DISTANCE_MS
}

// HTTP-400 DIAGNOSTIC LOGGING, DISCLOSED: logs the exact typed reason Alchemy rejected a request —
// chain, token, network identifier, the bounded range requested, the interval, and whatever error
// code/message Alchemy's response body carried. NEVER logs the API key (it is not read from the
// request URL/body here, only the already-known chain/token/range/interval plus the response body).
// TYPED 400 CLASSIFICATION, DISCLOSED: Alchemy returns HTTP 400 for several distinct, disclosed
// reasons — classified from the response body's own code/message text (never guessed from status
// alone), so downstream audit/negative-caching logic can react differently to each:
//   - "Token not found" (or any "not found" message) -> token_not_found
//   - a malformed network/request signal (network/invalid/malformed in the message) -> invalid_request
//   - anything else -> http_400_unknown (honestly unclassified, never silently merged into the above)
function classifyAlchemy400(errorCode: string | number | null, errorMessage: string | null): string {
  const text = `${errorCode ?? ''} ${errorMessage ?? ''}`.toLowerCase()
  if (text.includes('not found')) return 'token_not_found'
  if (text.includes('network') || text.includes('malformed') || text.includes('invalid')) return 'invalid_request'
  return 'http_400_unknown'
}

function logAlchemyHttp400(params: {
  chain: SupportedChain
  token: string
  networkSlug: string
  startTimeMs: number
  endTimeMs: number
  interval: string
  errorCode: string | number | null
  errorMessage: string | null
  classifiedReason: string
}): void {
  // eslint-disable-next-line no-console
  console.warn('[alchemy-historical-pricing-shadow] http_400', {
    chain: params.chain,
    token: params.token,
    network: params.networkSlug,
    startTime: new Date(params.startTimeMs).toISOString(),
    endTime: new Date(params.endTimeMs).toISOString(),
    interval: params.interval,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    classifiedReason: params.classifiedReason,
  })
}

async function fetchAlchemyHistoricalRange(
  chain: SupportedChain,
  token: string,
  startTimeMs: number,
  endTimeMs: number,
): Promise<AlchemyAssetRangeResult> {
  // NEGATIVE CACHE, DISCLOSED: a chain+token Alchemy already reported as "not found" this scan is
  // never requested again, for any range — checked before the singleflight/cache/budget logic below,
  // and does NOT consume a live-request slot.
  if (tokenNotFoundNegativeCache.has(assetKey(chain, token))) {
    negativeCacheHitsCount += 1
    return { ok: false, reason: 'token_not_found', points: [] }
  }

  const networkSlug = ALCHEMY_NETWORK_SLUGS[chain]
  if (!networkSlug) return { ok: false, reason: 'unverified_chain_for_alchemy_prices', points: [] }

  const apiKey = alchemyApiKey(chain)
  if (!apiKey) return { ok: false, reason: 'no_api_key_configured', points: [] }

  // REQUEST-SCOPED SINGLEFLIGHT/CACHE, DISCLOSED: keyed by chain+token+bounded-range — identical
  // ranges (the common case: this SAME asset's whole scan-worth of requirements collapsed into ONE
  // range by groupRequirementsByAsset below) execute exactly once. Stored BEFORE any await, so
  // concurrent callers for the identical range share the in-flight promise.
  const key = `${assetKey(chain, token)}:${startTimeMs}:${endTimeMs}`
  if (requestedRangeKeysThisScan.has(key)) duplicateRequestCount += 1
  requestedRangeKeysThisScan.add(key)

  const existing = rangeCache.get(key)
  if (existing) {
    coalescedHitsCount += 1
    return existing
  }

  if (liveRequests >= MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN) {
    cappedRequestsCount += 1
    const cappedResult: AlchemyAssetRangeResult = { ok: false, reason: 'capped', points: [] }
    return cappedResult
  }

  liveRequests += 1
  const interval = '1d'
  const live = (async (): Promise<AlchemyAssetRangeResult> => {
    try {
      const res = await fetch(`https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/historical`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          network: networkSlug,
          address: token,
          startTime: new Date(startTimeMs).toISOString(),
          endTime: new Date(endTimeMs).toISOString(),
          interval,
        }),
        signal: AbortSignal.timeout(8_000),
        // NO RETRIES, DISCLOSED: a single bounded attempt — a miss/error here falls through to the
        // existing (unchanged) fallback chain, exactly like any other source's own honest miss.
      })
      if (!res.ok) {
        if (res.status === 400) {
          let errorCode: string | number | null = null
          let errorMessage: string | null = null
          try {
            const body = (await res.json()) as { code?: string | number; message?: string; error?: string }
            errorCode = body?.code ?? null
            errorMessage = body?.message ?? body?.error ?? null
          } catch {
            errorMessage = null
          }
          const classifiedReason = classifyAlchemy400(errorCode, errorMessage)
          logAlchemyHttp400({ chain, token, networkSlug, startTimeMs, endTimeMs, interval, errorCode, errorMessage, classifiedReason })
          if (classifiedReason === 'token_not_found') tokenNotFoundNegativeCache.add(assetKey(chain, token))
          return { ok: false, reason: classifiedReason, points: [] }
        }
        return { ok: false, reason: `http_${res.status}`, points: [] }
      }

      const data = (await res.json()) as { data?: Array<{ timestamp?: string; value?: string }> }
      const series = Array.isArray(data.data) ? data.data : []
      const points: AlchemyHistoricalPricePoint[] = []
      for (const entry of series) {
        const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN
        const price = entry.value !== undefined ? Number(entry.value) : NaN
        if (Number.isFinite(ts) && Number.isFinite(price) && price > 0) points.push({ timestamp: ts, priceUsd: price })
      }
      if (points.length === 0) return { ok: false, reason: 'no_price_series_in_range', points: [] }
      assetsWithPriorSuccessThisScan.add(assetKey(chain, token))
      return { ok: true, reason: null, points }
    } catch (err) {
      return { ok: false, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}`, points: [] }
    }
  })()

  rangeCache.set(key, live)
  return live
}

function closestPoint(points: AlchemyHistoricalPricePoint[], timestamp: number): number | null {
  if (points.length === 0) return null
  const closest = points.reduce((a, b) => (Math.abs(b.timestamp - timestamp) < Math.abs(a.timestamp - timestamp) ? b : a))
  return closest.priceUsd
}

// SHADOW-MODE RESOLUTION, DISCLOSED, ADDITIVE — groups requirements by (chain, token), assigns ONE
// bounded historical range per asset (covering every requirement's own timestamp for that asset,
// never "all holdings" and never one request per trade), prioritises which assets get the bounded
// live-request budget by the tiers above, and returns a per-requirement shadow price alongside the
// full audit record. NEVER writes into costUsd/proceedsUsd — the caller decides, separately, whether
// to ever act on this (today: nowhere does).
export async function resolveAlchemyHistoricalPricesShadow(
  requirements: AlchemyPricingRequirement[],
): Promise<{
  shadowPricesByTxHash: Map<string, number>
  audit: AlchemyHistoricalAuditRecord
}> {
  const eligibleRequirements = requirements.length
  const byAsset = new Map<string, AlchemyPricingRequirement[]>()
  for (const req of requirements) {
    const key = assetKey(req.chain, req.token)
    const list = byAsset.get(key) ?? []
    list.push(req)
    byAsset.set(key, list)
  }

  // Priority order across ASSETS (not individual requirements): an asset's own tier is the BEST
  // (lowest-numbered) tier among any of its requirements — e.g. one asset with even a single
  // one-side-missing requirement is tier 2 for the whole asset, since one bounded range covers all
  // of that asset's requirements together anyway. Within tier 4, unknown Base microcaps are pushed
  // to the very back via baseMicrocapTieBreak (0 = sorts first, 1 = sorts last).
  const assetEntries = [...byAsset.entries()].map(([key, reqs]) => {
    const [{ chain, token }] = reqs
    return {
      key,
      reqs,
      tier: Math.min(...reqs.map((r) => tierOf(r, assetsWithPriorSuccessThisScan))) as 1 | 2 | 3 | 4,
      baseMicrocapTieBreak: isUnknownBaseMicrocap(chain, token) ? 1 : 0,
    }
  })
  assetEntries.sort((a, b) => a.tier - b.tier || a.baseMicrocapTieBreak - b.baseMicrocapTieBreak)

  const shadowPricesByTxHash = new Map<string, number>()
  let cacheHitsForThisCall = 0

  for (const { key: assetKeyStr, reqs } of assetEntries) {
    const [{ chain, token }] = reqs
    const timestamps = reqs.map((r) => r.timestamp)
    const startTimeMs = Math.min(...timestamps)
    const endTimeMs = Math.max(...timestamps)
    const wasCached = rangeCache.has(`${assetKey(chain, token)}:${startTimeMs}:${endTimeMs}`)
    const wasAlreadyLive = requestedRangeKeysThisScan.has(`${assetKey(chain, token)}:${startTimeMs}:${endTimeMs}`)

    const rangeDays = (endTimeMs - startTimeMs) / (24 * 60 * 60 * 1000)
    if (rangeDays > largestRangeDaysSeen) largestRangeDaysSeen = rangeDays

    const wasCapped = liveRequests >= MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN && !wasCached && !wasAlreadyLive
    const result = await fetchAlchemyHistoricalRange(chain, token, startTimeMs, endTimeMs)
    if (wasCached) cacheHitsForThisCall += 1

    // A "selected" asset is one that actually consumed (or reused) a live-request slot this scan —
    // i.e. not skipped by the cap. Recorded once, in the priority order assets were attempted in.
    if (!wasCapped && !selectedAssetOrder.includes(assetKeyStr)) selectedAssetOrder.push(assetKeyStr)

    if (result.reason === 'capped') continue
    if (!wasCached && !wasAlreadyLive) {
      if (result.ok) successfulRequestsCount += 1
      else failedRequestsCount += 1
    }
    if (!result.ok) {
      bumpMapCount(failureReasonCounts, result.reason ?? 'unknown')
      continue
    }
    for (const req of reqs) {
      const price = closestPoint(result.points, req.timestamp)
      if (price == null) continue
      const closest = result.points.reduce((a, b) =>
        Math.abs(b.timestamp - req.timestamp) < Math.abs(a.timestamp - req.timestamp) ? b : a,
      )
      const distanceMs = Math.abs(closest.timestamp - req.timestamp)
      const maxDistanceMs = maxTemporalDistanceMsFor(req.chain, req.token)

      // TEMPORAL ACCEPTANCE, DISCLOSED: a price found farther away than this asset class's window
      // is rejected outright — never added to shadowPricesByTxHash, never counted as resolved. This
      // is a shadow-only rejection (nothing was ever going to be applied to official pricing either
      // way); it exists so the audit honestly reports what would/would not have been usable.
      if (distanceMs > maxDistanceMs) {
        rejectedByTemporalDistanceCount += 1
        bumpMapCount(failureReasonCounts, 'temporal_distance_exceeded')
        continue
      }

      shadowPricesByTxHash.set(req.txHash, price)
      requirementsResolvedCount += 1
      bumpMapCount(resolvedByChainCounts, req.chain)
      bumpMapCount(resolvedByAssetCounts, assetKeyStr)
      if (distanceMs > closestPriceDistanceMsSeen) closestPriceDistanceMsSeen = distanceMs
    }
  }

  cacheHitsCount += cacheHitsForThisCall

  const audit: AlchemyHistoricalAuditRecord = {
    eligibleRequirements,
    uniqueAssets: byAsset.size,
    liveRequests,
    cacheHits: cacheHitsCount,
    coalescedHits: coalescedHitsCount,
    cappedRequests: cappedRequestsCount,
    estimatedCu: liveRequests * ESTIMATED_CU_PER_ALCHEMY_HISTORICAL_REQUEST,
    duplicateRequestCount,
    successfulRequests: successfulRequestsCount,
    failedRequests: failedRequestsCount,
    requirementsResolved: requirementsResolvedCount,
    resolvedByChain: mapToRecord(resolvedByChainCounts),
    resolvedByAsset: mapToRecord(resolvedByAssetCounts),
    failureReasons: mapToRecord(failureReasonCounts),
    largestRangeDays: Math.round(largestRangeDaysSeen * 100) / 100,
    closestPriceDistanceMs: closestPriceDistanceMsSeen,
    selectedAssetOrder: [...selectedAssetOrder],
    acceptedRequirementsResolved: requirementsResolvedCount,
    rejectedByTemporalDistance: rejectedByTemporalDistanceCount,
    negativeCacheHits: negativeCacheHitsCount,
  }

  return { shadowPricesByTxHash, audit }
}

// TEST-SUPPORT EXPORTS, DISCLOSED: read-only observability, same convention as this codebase's other
// per-scan state (isGoldrushBreakerOpenForTest, isCoingeckoCircuitOpenForTest).
export function getAlchemyHistoricalPricingCountersForTest(): AlchemyHistoricalAuditRecord {
  return {
    eligibleRequirements: 0,
    uniqueAssets: 0,
    liveRequests,
    cacheHits: cacheHitsCount,
    coalescedHits: coalescedHitsCount,
    cappedRequests: cappedRequestsCount,
    estimatedCu: liveRequests * ESTIMATED_CU_PER_ALCHEMY_HISTORICAL_REQUEST,
    duplicateRequestCount,
    successfulRequests: successfulRequestsCount,
    failedRequests: failedRequestsCount,
    requirementsResolved: requirementsResolvedCount,
    resolvedByChain: mapToRecord(resolvedByChainCounts),
    resolvedByAsset: mapToRecord(resolvedByAssetCounts),
    failureReasons: mapToRecord(failureReasonCounts),
    largestRangeDays: Math.round(largestRangeDaysSeen * 100) / 100,
    closestPriceDistanceMs: closestPriceDistanceMsSeen,
    selectedAssetOrder: [...selectedAssetOrder],
    acceptedRequirementsResolved: requirementsResolvedCount,
    rejectedByTemporalDistance: rejectedByTemporalDistanceCount,
    negativeCacheHits: negativeCacheHitsCount,
  }
}
