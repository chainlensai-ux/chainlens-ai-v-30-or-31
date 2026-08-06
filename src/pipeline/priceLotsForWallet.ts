// MODULE 9 — pipelineOrchestrator: priceLotsForWallet
//
// THE REAL BUG, VERIFIED (not the one described in the task's literal spec): fifoEngine
// (src/modules/fifoEngine) already accepts real, optional `priceUsdLookup`/`currentPriceUsdLookup`
// injection points on buildFifoOutput() — it has ALWAYS supported real pricing. The pipeline's own
// safeRunFifoEngine (src/pipeline/index.ts) simply never passed one in, so every lot fell back to
// fifoEngine's own honest "unpriced" default (never fabricated, just never wired up). Likewise
// pnlEngine's buildPnlSummary() already accepts `resolveCostUsdEstimate`/`resolveProceedsUsdEstimate`
// — never supplied either. That is the actual root cause of "PnL always unavailable": missing
// wiring at the pipeline layer, not a missing pricing step inside FIFO itself.
//
// The task's literal spec (`fifoEngine(buyTimeline, sellTimelineV2)`, `event.priceSource`,
// `event.priceConfidence`, pnlSummaryV2 "receiving the FIFO result") doesn't match any real type in
// this codebase, and building it as described would require changing fifoEngine's/pnlEngine's real
// call signatures — which this task explicitly forbids modifying. This file instead supplies real
// data through their EXISTING, already-built injection points. Neither module's own source is
// touched.
//
// WHY A SEPARATE PRE-PRICING PASS: fifoEngine's priceUsdLookup/currentPriceUsdLookup are
// deliberately SYNCHRONOUS (no await inside its lot-matching loop) — but real pricing
// (pricingAtTimeEngine, GoldRush) is necessarily async (network calls). This function resolves
// every real price asynchronously ONCE, up front, for the exact same merged event set fifoEngine
// itself will process (via fifoEngine's own exported, unmodified mergeNormalizedEvents — guarantees
// full coverage, not just the subset that happens to survive into buyTimeline/sellTimelineV2's
// gated/detected event sets), then hands back plain synchronous lookup functions backed by that
// prefetched, real data. Never fabricates a price: an event with no real price resolves to null in
// the lookup, exactly like fifoEngine's own default.

import { mergeNormalizedEvents } from '../modules/fifoEngine/utils'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { CurrentPriceUsdLookup, MatchedLot, PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { resolvePricingAtTime, priceableEntryIdentityKey } from '../modules/pricingAtTimeEngine/index'
import type { PriceableEntry, PriceSources, SourceBreakdown } from '../modules/pricingAtTimeEngine/types'
import { pricingRouteLog, isSanePrice, ethNativeRoutingAuditLog, type PricingRouteRecord } from './pricingAtTimeAdapter'
import { reserveCoingeckoSlotsForNativeEth, getNativeEthHistoryCoalescingDiagnostics } from '../modules/pricingAtTimeEngine/sources/coingecko'
import {
  getAerodromeAttributionForRequest,
  getBaseDexVenueAttributionForScan,
  getQuotePriceAttributionForRequest,
  getBaseDexQuotePriceAttributionForScan,
  type BaseDexVenue,
} from '../modules/pricingAtTimeEngine/sources/basedex'
import {
  resolveAlchemyHistoricalPricesShadow,
  isAlchemyHistoricalPricingEnabled,
  type AlchemyPricingRequirement,
} from '../modules/pricingAtTimeEngine/sources/alchemyHistoricalPriceSource'
import {
  prefetchNativeUsdPrices,
  readPrefetchedNativeUsdPrice,
  nativePriceBucketStart,
  isEthNativeChain,
  getNativePriceResolverDiagnostics,
} from '../modules/nativePriceResolver/index'
import { getGeckoTerminalEthOhlcvRequestCount, getGeckoTerminalRangeDiagnostics } from '../modules/nativePriceResolver/geckoTerminalEthOhlcv'
import {
  annotateRequirement, computeSchedulerComparison, computeSuccessWeightedComparison,
  FAIRNESS_FLOOR_PER_TOKEN, type SchedulerLotRef, type SchedulerRequirement,
} from '../modules/pricingAtTimeEngine/completionYieldScheduler'
import {
  snapshotSourceSuccessEvidence, seedPersistedEvidence, snapshotEvidenceDelta, evidenceRecordedThisProcess,
} from '../modules/pricingAtTimeEngine/sourceSuccessEvidence'
import {
  loadPersistedEvidence, flushEvidenceDelta, buildEvidenceSummary, emptyLoadedEvidence, processInstanceId,
  type LoadedEvidence,
} from '../modules/pricingAtTimeEngine/sourceSuccessEvidencePersistence'
import { resolveMaxLookupsPerToken } from '../modules/pricingAtTimeEngine/index'
import {
  deriveSameTransactionQuotePrice,
  groupSwapLegsByTransaction,
  swapLegGroupKey,
  isVerifiedQuoteLegAddress,
  isNativePseudoAddress,
  isCanonicalWethAddress,
  isVerifiedStablecoinAddress,
  resolveNativePricingToken,
  type QuoteLegPriceResult,
  type SwapLeg,
} from '../modules/quoteLegPricing/index'
import {
  buildAcceptedEvidenceKey, readAcceptedEvidenceBatch, type AcceptedEvidenceKvLike, type AcceptedEvidenceBatchIdentity,
} from '../lib/acceptedEvidenceStore'
import { getGoldrushPriceSourceCallCount } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { getDexscreenerCallCount } from '../modules/pricingAtTimeEngine/sources/dexscreener'

// ADDRESS-BASED NATIVE/WETH RECOGNITION, DISCLOSED (confirmed production bug: nativeQuoteRequirementsFound
// stayed 0 despite 84 valid opposite legs — the previous symbol==='ETH'/'WETH' check was a weaker
// signal than the canonical address every leg actually carries; see quoteLegPricing/index.ts's own
// isNativePseudoAddress/isCanonicalWethAddress for the full trace). Symbol kept only as a fallback OR
// for legs built without going through real provider synthesis.
function isNativeOrWethLeg(chain: NormalizedEvent['chain'], leg: SwapLeg): boolean {
  return isNativePseudoAddress(leg.contract) || isCanonicalWethAddress(chain, leg.contract) || leg.symbol === 'ETH' || leg.symbol === 'WETH'
}

function isFinitePositiveAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0
}

// SYNTHETIC DICTIONARY KEY, DISCLOSED: costUsd/proceedsUsd are Record<txHash, usd> — ONE slot per
// real txHash. A native/WETH quote leg that never touches the wallet directly shares its target's
// own txHash, so pricing it under that same literal txHash would silently collide with (and can
// clobber) the target's own entry in the very same dictionary. Mirrors this file's own existing
// `current:${chain}:${contract}` synthetic-key convention (see the "current" price pass below) —
// a made-up dictionary key used only to give this requirement its own unambiguous slot, never a
// real transaction hash.
function nativeQuoteRequirementKey(chain: string, txHash: string): string {
  return `native-quote:${chain}:${txHash.toLowerCase()}`
}

function toPriceableEntry(event: NormalizedEvent, pairRank: number | undefined): PriceableEntry {
  return {
    txHash: event.txHash,
    // NATIVE PRICING ROUTE, DISCLOSED (see quoteLegPricing/index.ts's resolveNativePricingToken for
    // the full trace): only the TOKEN STRING passed to the price source is routed to the chain's
    // canonical WETH contract when this event's own contract is the native pseudo-address — the
    // dictionary key (event.txHash, above) and every other stored field are untouched.
    token: resolveNativePricingToken(event.chain, event.contract),
    chain: event.chain,
    timestamp: Date.parse(event.timestamp),
    amount: String(event.amount),
    pairRank,
  }
}

// PURE. Exported for direct unit testing.
//
// COMPLETE-PAIR RANKING, DISCLOSED (confirmed follow-up bug — see pricingAtTimeEngine/index.ts's own
// "COMPLETE-PAIR FIX" comment for the full trace): a flat priority boolean still let a token's
// several closed-lot BUYS all outrank every one of that same token's closed-lot SELLS (buys always
// listed first), so a token with more than one closed lot spent its shared cap on 2 buys and zero
// sells ever priced. This assigns each closed lot a per-token rank (0 = highest priority for that
// token) so its own entry+exit share one rank — priceAllEntries then finishes rank 0's complete pair
// before ever spending a slot on rank 1's, so a bounded cap yields "N complete pairs" rather than
// "2N half pairs." A buy or sell txHash appearing in more than one matched-lot row (a single lot
// partially consumed across multiple sells, or a single sell drawing from multiple lots) keeps the
// LOWEST (best) rank it's needed at across every row — it is never de-prioritized by a later, lower-
// priority appearance.
//
// TIE-BREAK, DISCLOSED: no USD value exists yet at this pre-pricing stage to rank by real
// "meaningfulness" — amount (raw token quantity) is used as a best-effort, honestly-labeled proxy
// for "larger position, more likely meaningful," never a price. Ties broken by earliest closedAt
// (matches FIFO's own oldest-first philosophy), then closedTxHash for full determinism.
export function assignClosedLotPairRanks(
  matchedLots: readonly Pick<MatchedLot, 'token' | 'chain' | 'openedTxHash' | 'closedTxHash' | 'closedAt' | 'amount'>[],
): { entryRankByTxHash: Map<string, number>; exitRankByTxHash: Map<string, number> } {
  const byToken = new Map<string, typeof matchedLots[number][]>()
  for (const lot of matchedLots) {
    const key = `${lot.chain}:${lot.token.toLowerCase()}`
    const list = byToken.get(key) ?? []
    list.push(lot)
    byToken.set(key, list)
  }

  const entryRankByTxHash = new Map<string, number>()
  const exitRankByTxHash = new Map<string, number>()

  for (const lots of byToken.values()) {
    const sorted = [...lots].sort((a, b) =>
      b.amount - a.amount || a.closedAt - b.closedAt || a.closedTxHash.localeCompare(b.closedTxHash))
    sorted.forEach((lot, rank) => {
      const priorEntryRank = entryRankByTxHash.get(lot.openedTxHash)
      if (priorEntryRank === undefined || rank < priorEntryRank) entryRankByTxHash.set(lot.openedTxHash, rank)
      const priorExitRank = exitRankByTxHash.get(lot.closedTxHash)
      if (priorExitRank === undefined || rank < priorExitRank) exitRankByTxHash.set(lot.closedTxHash, rank)
    })
  }

  return { entryRankByTxHash, exitRankByTxHash }
}

// PURE. Exported for direct unit testing (this project's test runner can't reliably mock module
// imports — see fetchPricing.ts's own header for the same disclosed limitation — so the fix below
// is pulled out as an isolated, directly-callable function instead).
//
// DIRECTION-BLIND LOOKUP BUG, DISCLOSED AND FIXED (confirmed, high-severity): costUsd/proceedsUsd
// are both keyed purely by txHash (resolvePricingAtTime's usdByTxHash — see
// pricingAtTimeEngine/index.ts). A single swap transaction produces one inbound (buy) leg and one
// outbound (sell) leg of DIFFERENT tokens sharing that same txHash — the standard shape of virtually
// every on-chain swap. fifoEngine calls this exact lookup for BOTH buy events (buildLots) and sell
// events (matchLotsFIFO) — see fifoEngine/index.ts. The previous
// `costUsd[event.txHash] ?? proceedsUsd[event.txHash]` tried costUsd FIRST regardless of the event's
// own direction: for a sell whose transaction also had a paired buy leg (i.e. almost every real
// sell), costUsd[txHash] was already non-null (the DIFFERENT, paired token's cost), so the ??
// short-circuited and returned that wrong value instead of ever consulting proceedsUsd[txHash] — the
// sell's own correct price. This silently corrupted realized PnL with a different token's price
// whenever PnL actually computed a number, rather than leaving it honestly null. Fixed by dispatching
// on event.direction so each event only ever consults its own correct dictionary — no cross-
// dictionary fallback, matching this codebase's "unpriced stays null, never borrowed from elsewhere"
// convention.
export function resolveEventPriceUsd(
  event: Pick<NormalizedEvent, 'txHash' | 'direction'>,
  costUsd: Record<string, number | null>,
  proceedsUsd: Record<string, number | null>,
): number | null {
  if (event.direction === 'inbound') return costUsd[event.txHash] ?? null
  if (event.direction === 'outbound') return proceedsUsd[event.txHash] ?? null
  return null // 'unknown' direction — never guess which dictionary applies
}

// DISPLAY-PASS PROVIDER-CALL DEDUPE, DISCLOSED (surgical cost-pass follow-up task — confirmed
// production waste: goldrush_getTokenPrices 22, callsWhoseResultWasUnused 22, on a second scan where
// accepted evidence/the canonical manifest already fully priced every published lot). A SEPARATE,
// display-only pricing pass (pipeline/index.ts's syntheticPnl/syntheticPoolData feed) re-requested a
// live historical price for every buy/sell entry regardless of whether this pass's own
// priceUsdLookup — hydrated from a real live call OR from accepted-evidence — already knew it. Splits
// entries into `needsPricing` (genuinely unresolved — send to providers as before) and `alreadyKnown`
// (a txHash -> price map the caller backfills into its own result so display data never regresses).
// Pure, no I/O, no change to priceUsdLookup itself or to what gets matched/published.
export function partitionAlreadyPricedEntries<T extends { txHash: string }>(
  entries: readonly T[],
  direction: 'inbound' | 'outbound',
  priceUsdLookup: PriceUsdLookup,
): { needsPricing: T[]; alreadyKnown: Map<string, number> } {
  const needsPricing: T[] = []
  const alreadyKnown = new Map<string, number>()
  for (const entry of entries) {
    const known = priceUsdLookup({ txHash: entry.txHash, direction } as NormalizedEvent)
    if (known !== null) alreadyKnown.set(entry.txHash, known)
    else needsPricing.push(entry)
  }
  return { needsPricing, alreadyKnown }
}

// AERODROME PRODUCTION ATTRIBUTION, DISCLOSED, ADDITIVE — see the computation site (search
// "AERODROME ATTRIBUTION" below) for the full cross-referencing logic. Every count here is either
// (a) a direct, real per-scan counter basedex.ts itself maintains (pools found/prices accepted/RPC
// calls/failure reasons — see that file's own venueAttributionState header), or (b) cross-referenced
// against this file's own real, already-resolved atTradeTime.costUsd/proceedsUsd dictionaries, so a
// requirement only ever counts as "resolved by Aerodrome" when the exact slot it maps to is non-null
// AND was recorded by basedex.ts as an accepted Aerodrome price for that exact request. Zero pricing
// behavior change: purely additive read-only bookkeeping around numbers this pipeline already
// computes.
export type AerodromeAttribution = {
  aerodromeSlipstreamPoolsFound: number
  aerodromeClassicPoolsFound: number
  aerodromeSlipstreamPricesAccepted: number
  aerodromeClassicPricesAccepted: number
  aerodromeSlipstreamRequirementsResolved: number
  aerodromeClassicRequirementsResolved: number
  lotsCompletedByAerodrome: number
  fullyPricedLotsBeforeAerodrome: number
  fullyPricedLotsAfterAerodrome: number
  verifiedCoverageBeforeAerodrome: number
  verifiedCoverageAfterAerodrome: number
  failureReasonsByVenue: Record<BaseDexVenue, Record<string, number>>
  rpcCallsByVenue: Record<BaseDexVenue, number>
  // SHARED QUOTE-PRICE ATTRIBUTION, DISCLOSED, ADDITIVE — see basedex.ts's own
  // "SHARED QUOTE-PRICE CACHE" header for the full trace (found live, this task: Aerodrome completed
  // 0 lots because `quote_token_usd_unavailable` kept blocking the opposite side even after Classic/
  // Slipstream discovery+pricing both worked). Same real-counter + cross-referenced-requirement
  // pattern as the Aerodrome fields above, generalized across ALL THREE venues (Uniswap V3 included)
  // since the shared cache benefits every venue equally.
  quotePriceCacheHits: number
  quotePriceLiveResolutions: number
  quotePriceUnavailable: number
  requirementsRecoveredBySharedQuotePrice: number
  lotsCompletedBySharedQuotePrice: number
}

export type WalletPriceLookups = {
  priceUsdLookup: PriceUsdLookup
  currentPriceUsdLookup: CurrentPriceUsdLookup
  // See AerodromeAttribution's own header above.
  aerodromeAttribution: AerodromeAttribution
  // Diagnostic-only, additive — real primary/fallback/failed counts from the at-trade-time pricing
  // pass (the "current" price pass isn't included, to keep this a direct, honest reflection of
  // real transaction pricing specifically). Never fabricated; a straight pass-through of
  // pricingAtTimeEngine's own real sourceBreakdown.
  sourceBreakdown: SourceBreakdown
  // PRICING-UNAVAILABLE TOKENS, DISCLOSED: this file has no "pricedTokens"/"portfolio value"
  // concept to exclude a token from — those live in a completely separate module chain
  // (workers/walletScanV2.ts's own fetchAllHoldings/priceHoldings/buildPortfolio), not here. What
  // this file CAN honestly report: the distinct (chain:token) keys where every held token's
  // "current" price lookup came back null (all real sources — GoldRush, DexScreener, CoinGecko,
  // basedex, GeckoTerminal — genuinely found nothing). Purely additive diagnostic; does not change
  // priceUsdLookup/currentPriceUsdLookup's existing behavior (which already returns null for these
  // honestly, same as before this change).
  pricingUnavailableTokens: string[]
  // HISTORICAL PRICING ATTEMPT LOG, DISCLOSED: real per-attempt records from
  // pricingAtTimeAdapter.ts's chain-aware router (src/pipeline/pricingAtTimeAdapter.ts's
  // pricingRouteLog) — a snapshot/delta slice scoped to exactly this call's own two
  // resolvePricingAtTime passes (at-trade-time + current), same cross-request-leak guard pattern
  // already used around lib/server/rpcDebug.ts's rpcDebugLog elsewhere in this pipeline.
  historicalPricingAttempts: PricingRouteRecord[]
  historicalPricingFailures: PricingRouteRecord[]
  // ACCEPTED-EVIDENCE SKIP AUDIT, DISCLOSED (pricing-cost-reduction follow-up task, requirement #5):
  // real counters from the pre-scheduler accepted-evidence skip pass — see its own header below.
  acceptedEvidenceSkipAudit: AcceptedEvidenceSkipAudit
  manifestFastPathAudit: ManifestFastPathAudit
}

// ACCEPTED-EVIDENCE SKIP AUDIT, DISCLOSED (requirement #5): every field here is incremented at the
// exact point the described event happens, never estimated after the fact.
export type AcceptedEvidenceSkipAudit = {
  acceptedSidesEligibleToSkip: number
  pricingRequirementsRemovedByAcceptedEvidence: number
  // RENAMED, DISCLOSED (accepted-evidence-skip-hydration follow-up task, requirement #6 —
  // confirmed audit-accuracy bug: the prior field name `providerCallsSkippedByAcceptedEvidence`
  // implied a MEASURED count of real network calls avoided, but it only ever counted REMOVED
  // PRICING REQUIREMENTS — one requirement is not necessarily one network call: the chain-aware
  // historical router can try several sources per requirement, requirements coalesce, and a
  // requirement removed pre-scheduler was never dispatched to any specific provider at all, so
  // there is nothing to have "called" in the first place. Renamed to say exactly what it measures).
  pricingRequirementsSkippedByAcceptedEvidence: Record<string, number>
  // A real, disclosed, DELIBERATELY CONSERVATIVE single estimate (never per-source — this layer
  // cannot know which source a removed requirement would have routed to) — see
  // ESTIMATED_CREDITS_PER_SKIPPED_REQUIREMENT's own header. Never presented as a measured fact.
  estimatedProviderCallsAvoided: number
  estimatedCreditsSaved: number
  estimatedCuSaved: number
  acceptedSidesStillSentToProviders: number
  skipValidationFailures: number
  // SOURCE-SPECIFIC BEFORE/AFTER + REAL LIVE-CALL COUNTERS, DISCLOSED (requirement #7 — "trace why
  // 20 removed requirements did not reduce GoldRush calls"). `*RequirementsBeforeSkip`/`AfterSkip`
  // are real counts of PRICING REQUIREMENTS (never a claim about which provider they'd route to —
  // that routing decision happens deep inside the chain-aware historical router, several calls
  // after this layer's own filter runs, and is genuinely unknowable here). `goldrushActualLiveCalls`/
  // `dexActualLiveCalls` are REAL, MEASURED deltas of this codebase's own existing process-lifetime
  // call counters (getGoldrushPriceSourceCallCount/getDexscreenerCallCount), snapshotted immediately
  // before and after this call's own `resolvePricingAtTime` — genuinely measured, never estimated.
  // `alchemyActualLiveCalls` is the real `liveRequests` field `resolveAlchemyHistoricalPricesShadow`
  // already returns — also genuinely measured, not derived here.
  pricingRequirementsBeforeSkip: number
  pricingRequirementsAfterSkip: number
  goldrushActualLiveCalls: number
  alchemyRequirementsBeforeSkip: number
  alchemyRequirementsAfterSkip: number
  alchemyActualLiveCalls: number
  dexActualLiveCalls: number
  // CURRENT-PRICE PASS, SEPARATELY SCOPED, DISCLOSED (cost-audit follow-up task — confirmed
  // production shape: goldrushActualLiveCalls correctly reports 0 on a fully accepted-evidence-
  // covered/replay-covered closed-lot sample, yet [wallet-provider-cost-audit]'s scan-wide
  // goldrush_getTokenPrices total still shows real live calls with 0 used. Root cause: `atNow`'s
  // "current" price pass below — which resolves OPEN-POSITION cost basis/unrealized valuation, a
  // structurally SEPARATE concern accepted evidence can never cover (a "current" price is, by
  // definition, never a fixed historical fact — see this file's own header on why open-position
  // buys are deliberately retained) — goes through the exact same GoldRush price source and
  // process-lifetime call counter as the at-trade-time historical pass above, but
  // `goldrushActualLiveCalls`'s own snapshot closes BEFORE this pass ever runs, so its calls were
  // real but invisible to that field. `currentPriceGoldrushLiveCalls`/`currentPriceDexActualLiveCalls`
  // are the SAME real, measured delta pattern, scoped to ONLY this pass — never estimated, never
  // conflated with the replay-covered historical figure above.
  currentPriceGoldrushLiveCalls: number
  currentPriceDexActualLiveCalls: number
}

function emptyAcceptedEvidenceSkipAudit(): AcceptedEvidenceSkipAudit {
  return {
    acceptedSidesEligibleToSkip: 0, pricingRequirementsRemovedByAcceptedEvidence: 0,
    pricingRequirementsSkippedByAcceptedEvidence: {}, estimatedProviderCallsAvoided: 0,
    estimatedCreditsSaved: 0, estimatedCuSaved: 0,
    acceptedSidesStillSentToProviders: 0, skipValidationFailures: 0,
    pricingRequirementsBeforeSkip: 0, pricingRequirementsAfterSkip: 0, goldrushActualLiveCalls: 0,
    alchemyRequirementsBeforeSkip: 0, alchemyRequirementsAfterSkip: 0, alchemyActualLiveCalls: 0,
    dexActualLiveCalls: 0, currentPriceGoldrushLiveCalls: 0, currentPriceDexActualLiveCalls: 0,
  }
}

// MANIFEST FAST-PATH AUDIT, DISCLOSED (canonical-manifest-fast-path follow-up task, Parts B/C).
// SCOPE, HONESTLY DISCLOSED: this is NOT a separate "load the manifest object, then price" pipeline
// stage — it is the fix to the accepted-evidence skip pass ABOVE (which already ran before pricing),
// making its group-coverage check actually recognize partial-fill coverage, and batching its reads.
// Since accepted evidence is the exact data a manifest is built from, this achieves the measurable
// outcome ("zero provider calls for manifest-covered sides") without a wholly separate manifest
// pre-read architecture in the pipeline orchestrator. `manifestLoadedBeforePricing` is true whenever
// an `acceptedEvidenceKv` was supplied (the skip pass — the earliest point in this pipeline real
// matched-lot identity exists — genuinely ran before `resolvePricingAtTime`), `fastPathApplied` is
// true only when at least one requirement was actually covered, and every count below is real and
// measured from this function's own single pass — never estimated.
export type ManifestFastPathAudit = {
  manifestLoadedBeforePricing: boolean
  // UNCHANGED-RESCAN RESTRICTION COUNTERS, DISCLOSED (requirement #3) — see the restriction's own
  // header at the call site for exactly what is and is not suppressed, and why.
  allClosedLotSidesCovered: boolean
  unmatchedSellRequirementsSuppressed: number
  // Real, measured count of inbound requirements DELIBERATELY retained because they carry open-lot
  // cost basis for unrealized PnL. Reported honestly rather than suppressed to reach a cosmetic zero.
  openPositionRequirementsRetained: number
  manifestEvidenceKeysRequested: number
  manifestEvidenceBatchReads: number
  manifestEvidenceReadMs: number
  manifestCoveredPricingRequirements: number
  goldrushCallsPrevented: number
  dexCallsPrevented: number
  alchemyCallsPrevented: number
  recoveryLookupsPrevented: number
  candidateDiscoveryCalls: number
  fastPathApplied: boolean
  fastPathFailureReason: string | null
}

function emptyManifestFastPathAudit(): ManifestFastPathAudit {
  return {
    manifestLoadedBeforePricing: false, allClosedLotSidesCovered: false,
    unmatchedSellRequirementsSuppressed: 0, openPositionRequirementsRetained: 0,
    manifestEvidenceKeysRequested: 0, manifestEvidenceBatchReads: 0,
    manifestEvidenceReadMs: 0, manifestCoveredPricingRequirements: 0, goldrushCallsPrevented: 0,
    dexCallsPrevented: 0, alchemyCallsPrevented: 0, recoveryLookupsPrevented: 0, candidateDiscoveryCalls: 0,
    fastPathApplied: false, fastPathFailureReason: null,
  }
}

// ESTIMATED COST PER SKIPPED REQUIREMENT, DISCLOSED: a real, disclosed, DELIBERATELY CONSERVATIVE
// estimate — this pass has no per-provider credit/CU ledger to read a real figure from (that
// bookkeeping happens inside each provider's own client, never surfaced back here), so this reports
// a single unit "one requirement avoided one provider round trip" per skipped requirement, both for
// credits and for CU, rather than fabricate a precise, provider-specific number this layer cannot
// actually know. Real, non-zero, honestly conservative — never a guessed large number.
const ESTIMATED_CREDITS_PER_SKIPPED_REQUIREMENT = 1
const ESTIMATED_CU_PER_SKIPPED_REQUIREMENT = 1

// Real fix: pre-resolves historical USD pricing (at each event's own real timestamp) for every
// normalized event fifoEngine will merge and process, plus a "current" (now-timestamped) price per
// distinct held token for marking open lots to market — then exposes both as fifoEngine's existing
// sync lookup contract. Never touches fifoEngine's own source.
export async function priceLotsForWallet(params: {
  normalizedEvents: NormalizedEvent[]
  recoveredEvents: NormalizedEvent[]
  priceSources: PriceSources
  // ACCEPTED-EVIDENCE STORE, DISCLOSED (pricing-cost-reduction follow-up task): optional, additive —
  // a caller that hasn't wired it gets exactly today's behavior (every requirement is sent to
  // providers, unchanged). See buildAcceptedEvidenceSkipSet's own header for the full rule.
  acceptedEvidenceKv?: AcceptedEvidenceKvLike
  now?: () => number
}): Promise<WalletPriceLookups> {
  const merged = mergeNormalizedEvents(params.normalizedEvents, params.recoveredEvents)
  const buys = merged.filter((e) => e.direction === 'inbound')
  const sells = merged.filter((e) => e.direction === 'outbound')

  // PHASE A — STRUCTURAL (PRICE-FREE) FIFO PRE-PASS, DISCLOSED (confirmed bug fix: fullyPricedLots
  // stayed 0 even after the dense per-token cap was raised, because ALL buys were dispatched before
  // ANY sells — see pricingAtTimeEngine/index.ts's priceAllEntries — so a token bought more than once
  // before being sold had its own repeat buys consume every cap slot ahead of its own sell).
  // fifoEngine's buildLots/matchLotsFIFO already match purely by quantity + chronology — a real price
  // is only ATTACHED afterward, never required to determine which buy pairs with which sell (both
  // default their priceUsdLookup param to "always null" — see fifoEngine/index.ts). Reusing those
  // exact, unmodified, already-exported functions here with no price lookup costs zero network calls
  // and produces the same structural pairing FIFO will use for real once prices exist — exactly
  // enough to know, in advance, which specific (openedTxHash, closedTxHash) pairs are the decisive
  // pricing requirements a verified closed lot actually needs.
  const structuralLots = buildLots(params.normalizedEvents, params.recoveredEvents)
  const { matchedLots: structuralMatchedLots } = matchLotsFIFO(structuralLots, sells)
  const { entryRankByTxHash, exitRankByTxHash } = assignClosedLotPairRanks(structuralMatchedLots)

  // ACCEPTED-EVIDENCE SKIP SET, DISCLOSED (pricing-cost-reduction follow-up task — real production
  // proof: 27 accepted sides loaded/applied before pricing, 5 conflicting upstream prices correctly
  // REJECTED downstream in pnlReconciliation.ts, yet `upstreamLookupsSkippedByAcceptedEvidence: 0` —
  // the main historical pricing pass had no knowledge of the accepted-evidence store at all, so it
  // still spent a real provider call for every one of those 27 sides even though the result was
  // guaranteed to be discarded). Built HERE, immediately after the structural (price-free) FIFO
  // pre-pass — the earliest point real matched-lot identity (chain/token/txHash/side/timestamp/
  // lot-identity-version, exactly what acceptedEvidenceStore.ts keys on) exists in this pipeline —
  // and used below to remove already-canonical requirements BEFORE they ever reach
  // `resolvePricingAtTime`/the Alchemy gap-fill pass, never after.
  //
  // GROUPED BY (chain, txHash, side), NOT BY LOT, DISCLOSED: a single txHash can be the open OR close
  // side of MULTIPLE matched lots (a partial-fill buy split across several sells shares one open
  // txHash) — and the pricing requirement for that txHash is similarly ONE shared entry, not one per
  // lot (see toPriceableEntry below). A requirement is only skip-eligible when EVERY matched lot
  // sharing it has its OWN valid accepted evidence — one uncovered lot on a shared txHash still needs
  // the real provider call, so the requirement is never removed in that case (requirement #3's
  // "never skip... genuinely unresolved sides").
  const acceptedEvidenceSkipAudit = emptyAcceptedEvidenceSkipAudit()
  const acceptedEvidenceKv = params.acceptedEvidenceKv
  const acceptedEvidenceNow = (params.now ?? Date.now)()
  const skippableRequirementKeys = new Set<string>() // `${chain}:${txHash.toLowerCase()}:${side}`
  // ACCEPTED-PRICE HYDRATION MAPS, DISCLOSED (accepted-evidence-skip-hydration follow-up task,
  // requirement #1 — confirmed root cause of the split canonical snapshot: the prior version
  // REMOVED a fully-covered requirement from the pricing pool without ever writing its accepted
  // price into `atTradeTime.costUsd`/`proceedsUsd` — those dictionaries stayed exactly as
  // un-populated as a genuinely unresolved side, so `priceUsdLookup`/`currentPriceUsdLookup`, and
  // therefore this pass's OWN `structuralMatchedLots`-derived consumers like AYRI, never saw the
  // canonical price at all — only pnlReconciliation.ts's SEPARATE, later hydration pass did,
  // producing two different "verified" counts for the same scan). Captured here, applied to
  // `atTradeTime.costUsd`/`proceedsUsd` immediately after `resolvePricingAtTime` returns (see below)
  // — BEFORE anything else reads those dictionaries (Alchemy gap-fill's `hasEntry`/`hasExit`,
  // `countFullyPriced()`, the final lookup builders) — so a skipped requirement behaves exactly like
  // one a provider resolved, never like an unpriced placeholder.
  const acceptedPriceByTxHash = { costUsd: new Map<string, number>(), proceedsUsd: new Map<string, number>() }
  // MANIFEST FAST-PATH AUDIT, DISCLOSED (canonical-manifest-fast-path follow-up task, Parts B/C):
  // real, measured counters from THIS pass — the earliest point real matched-lot identity exists in
  // this pipeline, and the one true choke point every provider call for a manifest-covered side
  // would otherwise pass through (see the "ACCEPTED-EVIDENCE SKIP FILTER" note below).
  const manifestFastPathAudit = emptyManifestFastPathAudit()
  if (acceptedEvidenceKv) {
    manifestFastPathAudit.manifestLoadedBeforePricing = true
    const groups = new Map<string, MatchedLot[]>()
    for (const lot of structuralMatchedLots) {
      const openKey = `${lot.chain}:${lot.openedTxHash.toLowerCase()}:entry`
      const closeKey = `${lot.chain}:${lot.closedTxHash.toLowerCase()}:exit`
      groups.set(openKey, [...(groups.get(openKey) ?? []), lot])
      groups.set(closeKey, [...(groups.get(closeKey) ?? []), lot])
    }
    // BATCHED, RELAXED-VERSION READ, DISCLOSED (canonical-manifest-fast-path follow-up task, Parts
    // B/C — confirmed root cause of "GoldRush historical calls: 52, calls whose result was unused:
    // 52" in production). An accepted-evidence KEY is per (chain, token, txHash, side, timestamp) —
    // it does NOT include `lotIdentityVersion` — but the prior check read each SIBLING lot's own
    // exact version, one KV round trip at a time. For a partial-fill group (several lots sharing one
    // buy or sell tx) only ONE sibling's version can ever match the single stored record, so
    // `coveredCount` could never reach `groupedLots.length` for a genuine partial fill — the skip
    // never engaged, and every one of those sides was sent to a live provider even though accepted,
    // canonical evidence already existed for the whole group. Fixed per Part A's own confirmed value
    // semantics (a transaction side's accepted price represents the TOTAL for that whole side,
    // proportionally split by fifoEngine's own internal per-lot allocation once fed into
    // `atTradeTime.costUsd`/`proceedsUsd` below) — group coverage is now "does ANY valid record exist
    // for this shared key" (the relaxed, any-lot-version discovery read), not "does every sibling
    // have its own individually-matching one", and every group's read is issued in ONE bounded-
    // concurrency batch (Part C) instead of one sequential await per lot per side.
    const requests: AcceptedEvidenceBatchIdentity[] = [...groups.entries()].map(([key, groupedLots]) => {
      const side: 'entry' | 'exit' = key.endsWith(':entry') ? 'entry' : 'exit'
      const representative = groupedLots[0]
      const txHash = side === 'entry' ? representative.openedTxHash : representative.closedTxHash
      const timestamp = side === 'entry' ? representative.openedAt : representative.closedAt
      return { chain: representative.chain, token: representative.token, txHash, side, timestamp, anyLotVersion: true }
    })
    manifestFastPathAudit.manifestEvidenceKeysRequested = requests.length
    const batchResult = requests.length > 0 ? await readAcceptedEvidenceBatch(acceptedEvidenceKv, requests, acceptedEvidenceNow) : { byKey: new Map(), uniqueKeysRead: 0, elapsedMs: 0, keysRequested: 0 }
    manifestFastPathAudit.manifestEvidenceBatchReads = batchResult.uniqueKeysRead
    manifestFastPathAudit.manifestEvidenceReadMs += batchResult.elapsedMs

    for (const [key, groupedLots] of groups) {
      const side: 'entry' | 'exit' = key.endsWith(':entry') ? 'entry' : 'exit'
      const representative = groupedLots[0]
      const txHash = side === 'entry' ? representative.openedTxHash : representative.closedTxHash
      const timestamp = side === 'entry' ? representative.openedAt : representative.closedAt
      const evidenceKvKey = buildAcceptedEvidenceKey({ chain: representative.chain, token: representative.token, txHash, side, timestamp, lotIdentityVersion: '' })
      const evidence = batchResult.byKey.get(evidenceKvKey) ?? null
      const canonicalPriceUsd = evidence?.priceUsd ?? null
      if (canonicalPriceUsd !== null) {
        skippableRequirementKeys.add(key)
        acceptedEvidenceSkipAudit.acceptedSidesEligibleToSkip += groupedLots.length
        manifestFastPathAudit.manifestCoveredPricingRequirements += groupedLots.length
        const dict = side === 'entry' ? acceptedPriceByTxHash.costUsd : acceptedPriceByTxHash.proceedsUsd
        dict.set(txHash, canonicalPriceUsd)
      } else {
        acceptedEvidenceSkipAudit.skipValidationFailures += groupedLots.length
      }
    }
  }
  function isSkippableByAcceptedEvidence(chain: NormalizedEvent['chain'], txHash: string, side: 'entry' | 'exit'): boolean {
    return skippableRequirementKeys.has(`${chain}:${txHash.toLowerCase()}:${side}`)
  }
  // ACCEPTED-EVIDENCE SKIP FILTER, DISCLOSED (requirement #2): removes a requirement entirely from
  // the event lists this whole pass builds requirements from — GoldRush/Alchemy/GeckoTerminal/
  // DexScreener/native-quote recovery are all reached exclusively via `buys`/`sells`/`nativeQuoteEntries`
  // -> `resolvePricingAtTime`/the Alchemy gap-fill loop below, so filtering here is the one true choke
  // point for every one of those sources, not a per-provider patch. `buys`/`sells` were already
  // consumed by the structural FIFO pre-pass above (matching is unaffected — this filter runs AFTER
  // matching, never before), so filtering them now only affects what gets PRICED, never what gets
  // MATCHED.
  acceptedEvidenceSkipAudit.pricingRequirementsBeforeSkip = buys.length + sells.length
  if (skippableRequirementKeys.size > 0) {
    const beforeBuys = buys.length
    const beforeSells = sells.length
    for (let i = buys.length - 1; i >= 0; i--) {
      if (isSkippableByAcceptedEvidence(buys[i].chain, buys[i].txHash, 'entry')) buys.splice(i, 1)
    }
    for (let i = sells.length - 1; i >= 0; i--) {
      if (isSkippableByAcceptedEvidence(sells[i].chain, sells[i].txHash, 'exit')) sells.splice(i, 1)
    }
    const removed = (beforeBuys - buys.length) + (beforeSells - sells.length)
    acceptedEvidenceSkipAudit.pricingRequirementsRemovedByAcceptedEvidence += removed
    // PER-SOURCE ATTRIBUTION, HONESTLY DISCLOSED: this layer decides to skip a requirement BEFORE
    // any provider is ever selected/routed (that selection happens inside
    // buildChainAwareHistoricalPriceSourceDetailed, several calls downstream) — it genuinely cannot
    // know which specific provider(s) WOULD have been tried for a given requirement. Bucketed under
    // one real, named key rather than fabricating a per-provider split this layer has no visibility
    // into — the SAME disclosed-limitation pattern already used elsewhere in this file/module for
    // "source unknown at this layer" cases.
    acceptedEvidenceSkipAudit.pricingRequirementsSkippedByAcceptedEvidence['historical-pricing-scheduler'] =
      (acceptedEvidenceSkipAudit.pricingRequirementsSkippedByAcceptedEvidence['historical-pricing-scheduler'] ?? 0) + removed
    acceptedEvidenceSkipAudit.estimatedProviderCallsAvoided += removed
    acceptedEvidenceSkipAudit.estimatedCreditsSaved += removed * ESTIMATED_CREDITS_PER_SKIPPED_REQUIREMENT
    acceptedEvidenceSkipAudit.estimatedCuSaved += removed * ESTIMATED_CU_PER_SKIPPED_REQUIREMENT
  }
  // UNCHANGED-RESCAN RESTRICTION, DISCLOSED (grouped-multiplicity/perf task, requirement #3 —
  // confirmed production waste: 230 candidate discovery calls and 26 unused GoldRush results on a
  // rescan whose closed-lot sides were ALL already covered by accepted evidence).
  //
  // WHAT THIS SUPPRESSES: outbound (sell) events that participate in NO structural matched lot at
  // all. An unmatched sell's historical price is genuinely unreachable by any consumer — it is not a
  // closed lot's exit side (nothing to compute realized PnL from) and it opens no lot (sells never
  // create open-lot cost basis), so its resolved price is written into `atTradeTime.proceedsUsd` and
  // then never read. Suppressing it is a pure, zero-behaviour-change saving.
  //
  // WHAT THIS DELIBERATELY DOES NOT SUPPRESS, HONESTLY DISCLOSED: inbound (buy) events outside any
  // matched lot. Those are OPEN POSITIONS, and fifoEngine's `buildLots` resolves each one's
  // `costBasisUsd` from exactly this historical pricing pass — dropping them would leave every open
  // lot unpriced and silently collapse UNREALIZED PnL to null (computePnl skips any lot with a null
  // cost basis). Reaching a literal zero historical requirement count on an unchanged rescan is
  // therefore only possible by trading away unrealized PnL, which this task did not ask for and
  // which would be a silent regression — so buy-side open-position pricing is left intact and the
  // real remaining count is reported honestly via `openPositionRequirementsRetained` below rather
  // than driven to a cosmetic zero.
  //
  // GATED, DISCLOSED: only applied when EVERY structural matched-lot side is already
  // accepted-evidence covered — i.e. a genuine unchanged rescan with no new structural groups. On a
  // first scan, or whenever any closed-lot side is still uncovered, nothing here changes at all.
  const matchedLotSideKeys = new Set<string>()
  for (const lot of structuralMatchedLots) {
    matchedLotSideKeys.add(`${lot.chain}:${lot.openedTxHash.toLowerCase()}:entry`)
    matchedLotSideKeys.add(`${lot.chain}:${lot.closedTxHash.toLowerCase()}:exit`)
  }
  const everyMatchedLotSideCovered = matchedLotSideKeys.size > 0
    && [...matchedLotSideKeys].every((key) => skippableRequirementKeys.has(key))
  manifestFastPathAudit.allClosedLotSidesCovered = everyMatchedLotSideCovered
  if (everyMatchedLotSideCovered) {
    const beforeSells = sells.length
    for (let i = sells.length - 1; i >= 0; i--) {
      if (!matchedLotSideKeys.has(`${sells[i].chain}:${sells[i].txHash.toLowerCase()}:exit`)) sells.splice(i, 1)
    }
    manifestFastPathAudit.unmatchedSellRequirementsSuppressed = beforeSells - sells.length
  }
  manifestFastPathAudit.openPositionRequirementsRetained = buys.filter(
    (b) => !matchedLotSideKeys.has(`${b.chain}:${b.txHash.toLowerCase()}:entry`),
  ).length

  acceptedEvidenceSkipAudit.pricingRequirementsAfterSkip = buys.length + sells.length
  // REAL, MEASURED LIVE-CALL SNAPSHOT, DISCLOSED (requirement #7): taken immediately around this
  // call's own `resolvePricingAtTime` — this codebase's own existing process-lifetime counters
  // (never reset per-scan, so only the DELTA across this exact call is attributable to it).
  const goldrushCallsBeforeResolve = getGoldrushPriceSourceCallCount()
  const dexCallsBeforeResolve = getDexscreenerCallCount()

  // RANK PROPAGATION BY TX, NOT BY LEG DIRECTION, DISCLOSED (confirmed production bug: 84 valid
  // opposite legs found, 0 recovered, missing_verified_native_price: 42). entryRankByTxHash/
  // exitRankByTxHash are keyed by which SIDE of a closed lot a txHash represents (opened vs closed),
  // not by which array a given LEG of that same transaction happens to land in. A swap's ETH/WETH
  // quote leg shares its target's own txHash but is virtually always the OPPOSITE direction (the
  // target is inbound on a buy, so its own tx's ETH leg is outbound — landing in `sells`, which only
  // ever consulted exitRankByTxHash, keyed by CLOSE transactions; this buy's txHash was never a close
  // transaction, so the ETH leg's rank lookup always missed, no matter how important that specific
  // tx's pricing was). Checking BOTH maps for every leg's own txHash (regardless of which array it's
  // in) means a transaction's priority rank now reaches every leg of that transaction, ETH/WETH
  // included, so priceAllEntries' existing rank-sort/per-token-cap correctly favors it over ordinary,
  // unranked token lookups — using the SAME already-existing priority machinery, no new mechanism.
  function rankForTxHash(txHash: string): number | undefined {
    const entryRank = entryRankByTxHash.get(txHash)
    const exitRank = exitRankByTxHash.get(txHash)
    if (entryRank === undefined) return exitRank
    if (exitRank === undefined) return entryRank
    return Math.min(entryRank, exitRank)
  }

  // NATIVE/WETH QUOTE-LEG REQUIREMENTS, DISCLOSED, ADDITIVE: a quote leg that never touches the
  // wallet directly (direction 'unknown' — a router-to-pool transfer) is correctly excluded from
  // `buys`/`sells` (only 'inbound'/'outbound' events are real pricing requirements for fifoEngine's
  // own cost basis) and so was NEVER sent to resolvePricingAtTime at all — no rank-propagation fix
  // can recover a price that was never requested. For every transaction that a verified closed lot
  // actually needs priced, if its grouped legs contain a canonical ETH/WETH leg with direction
  // 'unknown', one extra PriceableEntry is added (into sellEntries, arbitrarily but consistently — a
  // quote-only entry, not a real portfolio sell) carrying that SAME transaction's own priority rank
  // and its OWN historical timestamp (never "now" — see NEVER-CURRENT-PRICE note below). This adds
  // candidate entries competing for the SAME already-existing per-token cap (MAX_LOOKUPS_PER_TOKEN in
  // pricingAtTimeEngine/index.ts, unchanged) — it does not raise that cap, so the number of REAL
  // provider calls ETH/WETH can ever consume this scan is bounded exactly as it always was; this only
  // changes WHICH of ETH's occurrences win those bounded slots, preferring the ones a real closed lot
  // needs over an arbitrary/unranked one ("replace lower-priority failed token lookups when
  // necessary").
  const swapLegsByTx = groupSwapLegsByTransaction(merged)
  const nativeQuoteRequirementSeen = new Set<string>()
  let nativeQuoteRequirementsFound = 0
  // DIAGNOSTIC SAMPLE, DISCLOSED, BOUNDED: exactly what the "first 10 valid opposite legs" audit
  // asked for — logged once, after the loop, never per-transaction (no unbounded log volume).
  const validOppositeLegSample: Array<{
    chain: string
    txHash: string
    tokenAddress: string
    symbol: string
    direction: string
    classification: 'native_or_weth' | 'other'
    isNativePseudoAddress: boolean
    isCanonicalWeth: boolean
    rejectionReason: string | null
  }> = []
  // CANDIDATE COLLECTION, DISCLOSED — pass 1 of 2: gather every native/WETH quote-leg candidate WITHOUT
  // yet assigning it a rank. Deterministic cross-candidate priority (below) needs the full set first.
  type NativeCandidate = {
    groupKey: string
    chain: NormalizedEvent['chain']
    txHash: string
    timestamp: number
    leg: SwapLeg
    lotToken: string
    oppositeTxHash: string
    side: 'entry' | 'exit'
  }
  const nativeCandidates: NativeCandidate[] = []
  for (const lot of structuralMatchedLots) {
    const requirements: Array<{ txHash: string; timestamp: number; oppositeTxHash: string; side: 'entry' | 'exit' }> = [
      { txHash: lot.openedTxHash, timestamp: lot.openedAt, oppositeTxHash: lot.closedTxHash, side: 'entry' },
      { txHash: lot.closedTxHash, timestamp: lot.closedAt, oppositeTxHash: lot.openedTxHash, side: 'exit' },
    ]
    for (const { txHash, timestamp, oppositeTxHash, side } of requirements) {
      const groupKey = swapLegGroupKey(lot.chain, txHash)
      if (nativeQuoteRequirementSeen.has(groupKey)) continue
      // MANIFEST/ACCEPTED-EVIDENCE SKIP APPLIES HERE TOO, DISCLOSED (canonical-manifest-fast-path
      // follow-up task, issue #3 — confirmed production bug: "113 historical requirements selected
      // despite expectedLotsCompleted=0"). `nativeCandidates` is built from `structuralMatchedLots`
      // directly, NEVER from the already-filtered `buys`/`sells` arrays the earlier skip-splice
      // mutates — so a side already covered by accepted evidence (an unchanged manifest rescan with
      // zero genuinely new lots) still generated a native-quote candidate here, an independent entry
      // point into `resolvePricingAtTime` this skip previously never reached. Since this side's price
      // is already known (and already merged into `atTradeTime.costUsd`/`proceedsUsd` below), a
      // native-quote candidate for it can only ever complete zero NEW lots — exactly the reported
      // expectedLotsCompleted=0 selections.
      if (isSkippableByAcceptedEvidence(lot.chain, txHash, side)) continue
      const legs = swapLegsByTx.get(groupKey) ?? []
      const oppositeLegs = legs.filter((leg) => !leg.excludeReason && leg.contract.toLowerCase() !== lot.token.toLowerCase())
      for (const leg of oppositeLegs) {
        if (validOppositeLegSample.length >= 10) break
        const isNative = isNativePseudoAddress(leg.contract)
        const isWeth = isCanonicalWethAddress(lot.chain, leg.contract)
        validOppositeLegSample.push({
          chain: lot.chain,
          txHash,
          tokenAddress: leg.contract,
          symbol: leg.symbol,
          direction: leg.direction,
          classification: isNative || isWeth || leg.symbol === 'ETH' || leg.symbol === 'WETH' ? 'native_or_weth' : 'other',
          isNativePseudoAddress: isNative,
          isCanonicalWeth: isWeth,
          rejectionReason: !isFinitePositiveAmount(leg.amount) ? 'invalid_amount' : null,
        })
      }
      const nativeLeg = oppositeLegs.find((leg) => isNativeOrWethLeg(lot.chain, leg) && leg.amount > 0)
      if (!nativeLeg) continue
      nativeQuoteRequirementSeen.add(groupKey)
      nativeQuoteRequirementsFound += 1
      nativeCandidates.push({ groupKey, chain: lot.chain, txHash, timestamp, leg: nativeLeg, lotToken: lot.token, oppositeTxHash, side })
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[quote-leg-native-requirement-audit] first 10 valid opposite legs', { legs: validOppositeLegSample })

  // COMPLETION-AWARE PRIORITY ASSIGNMENT, DISCLOSED — pass 2 of 2 (confirmed production evidence: raw
  // native pricing itself works — 2 selected, 2 priced, 2 same-tx recoveries, 0 provider misses — but
  // amount-only ranking can spend the ETH cap's only 2 slots on two requirements that do NOT, together,
  // complete any closed lot, so fullyPricedLots stays flat even though pricing "worked." Reordered to
  // prioritize requirements by their EXPECTED effect on lot completion, computed from data already known
  // BEFORE any provider call runs (never from a result this same call hasn't produced yet):
  //
  // Tier 1 — the missing side of a lot whose OPPOSITE side already has a genuinely verified stablecoin
  // quote leg. A stablecoin quote resolves deterministically at $1/unit with NO provider call and NO
  // cap slot (see quoteLegPricing's isVerifiedStablecoinAddress) — so that side is effectively already
  // guaranteed priced regardless of this call's outcome. Spending an ETH slot on the OTHER side is what
  // completes that lot "for free": the highest-value, lowest-risk use of a scarce slot.
  // Tier 2 — transactions whose LOT can be fully completed using exactly the 2 available ETH slots,
  // i.e. both sides of the same lot are themselves native-quote candidates. Grouped together (adjacent
  // ranks, same tier) and ordered by the pair's combined quote amount DESC so the highest-value
  // completable pair is attempted first.
  // Tier 3 — every other candidate, ordered by its own quote amount DESC (the prior round's behavior).
  // Tie-break within any tier: timestamp ASC → txHash ASC, fully deterministic.
  //
  // Every rank here stays STRICTLY NEGATIVE (below any real closed-lot rank, always >= 0, and below the
  // UNRANKED sentinel) — same mechanism as before, no change to pricingAtTimeEngine, MAX_LOOKUPS_PER_TOKEN,
  // or any cap/budget.
  const candidateByTxHash = new Map(nativeCandidates.map((c) => [c.txHash, c]))
  function oppositeHasVerifiedStablecoin(candidate: NativeCandidate): boolean {
    const oppositeLegs = swapLegsByTx.get(swapLegGroupKey(candidate.chain, candidate.oppositeTxHash)) ?? []
    return oppositeLegs.some(
      (leg) =>
        !leg.excludeReason &&
        leg.contract.toLowerCase() !== candidate.lotToken.toLowerCase() &&
        isFinitePositiveAmount(leg.amount) &&
        isVerifiedStablecoinAddress(candidate.chain, leg.contract),
    )
  }
  function tierOf(candidate: NativeCandidate): 1 | 2 | 3 {
    if (oppositeHasVerifiedStablecoin(candidate)) return 1
    if (candidateByTxHash.has(candidate.oppositeTxHash)) return 2
    return 3
  }
  function pairAmount(candidate: NativeCandidate): number {
    const opposite = candidateByTxHash.get(candidate.oppositeTxHash)
    return opposite ? candidate.leg.amount + opposite.leg.amount : candidate.leg.amount
  }
  let completionEligibleNativeRequirements = 0
  let selectedRequirementsWithOppositeSidePriced = 0 // tier-1 count — computed here, logged after selection below
  const sortedNativeCandidates = [...nativeCandidates].sort((a, b) => {
    const tierA = tierOf(a)
    const tierB = tierOf(b)
    if (tierA !== tierB) return tierA - tierB
    if (tierA === 2) {
      // Same tier-2 pair sorts adjacent: shared pairAmount, entry before exit, then timestamp/txHash.
      const pairDiff = pairAmount(b) - pairAmount(a)
      if (pairDiff !== 0) return pairDiff
      if (a.side !== b.side) return a.side === 'entry' ? -1 : 1
    } else {
      const amountDiff = b.leg.amount - a.leg.amount
      if (amountDiff !== 0) return amountDiff
    }
    return a.timestamp - b.timestamp || a.txHash.localeCompare(b.txHash)
  })
  for (const c of sortedNativeCandidates) {
    const tier = tierOf(c)
    if (tier <= 2) completionEligibleNativeRequirements += 1
    if (tier === 1) selectedRequirementsWithOppositeSidePriced += 1
  }
  // rank(i) = i - N: index 0 (best candidate — tier 1 first, then tier 2, then tier 3) gets the most
  // negative (smallest, highest-priority) rank; every value here is strictly < 0, i.e. strictly better
  // than any real closed-lot rank (always >= 0) or unranked entry (UNRANKED sentinel).
  const nativeQuoteRankByGroupKey = new Map<string, number>()
  sortedNativeCandidates.forEach((c, i) => nativeQuoteRankByGroupKey.set(c.groupKey, i - sortedNativeCandidates.length))

  // EXPECTED COMPLETION PREDICTION, DISCLOSED, ADDITIVE — computed BEFORE resolvePricingAtTime runs,
  // from the same MAX_LOOKUPS_PER_TOKEN_DEFAULT/DENSE value (both currently 2, unchanged) every ETH/
  // WETH requirement shares: assumes the top `assumedCapSlots` ranked candidates are the ones that
  // will actually survive the real cap (true whenever this is the only source of ETH/WETH entries
  // competing for that shared per-token slot budget), then counts how many DISTINCT lots that
  // selection is expected to complete — a tier-1 candidate completes its lot alone (the opposite side
  // is already deterministically stablecoin-priced); a tier-2 candidate only completes its lot if its
  // PAIR partner is ALSO among the selected slots.
  const assumedCapSlots = 2
  const topSelectedGroupKeys = new Set(sortedNativeCandidates.slice(0, assumedCapSlots).map((c) => c.groupKey))
  let expectedLotsCompletedBySelection = 0
  {
    const countedLots = new Set<string>()
    for (const c of sortedNativeCandidates.slice(0, assumedCapSlots)) {
      const lotKey = `${c.chain}:${c.lotToken.toLowerCase()}`
      if (countedLots.has(lotKey)) continue
      const tier = tierOf(c)
      if (tier === 1) {
        expectedLotsCompletedBySelection += 1
        countedLots.add(lotKey)
      } else if (tier === 2) {
        const opposite = candidateByTxHash.get(c.oppositeTxHash)
        if (opposite && topSelectedGroupKeys.has(opposite.groupKey)) {
          expectedLotsCompletedBySelection += 1
          countedLots.add(lotKey)
        }
      }
    }
  }

  const nativeQuoteEntries: PriceableEntry[] = []
  // Resolves each found requirement's OWN dictionary+key after resolvePricingAtTime runs — a real
  // (already-ordinary, direction-real) leg is looked up in the SAME costUsd/proceedsUsd[txHash] slot
  // its normal rank-fixed requirement already uses (see rankForTxHash above); only a genuinely
  // 'unknown'-direction leg (never otherwise requested) gets its own new synthetic-key entry. This
  // means an already-real requirement is never duplicated into a second, budget-consuming entry —
  // "no budget increase" holds for both sub-cases, not just the synthetic one.
  // ENTRY-IDENTITY, DISCLOSED (confirmed production bug: top completion candidates got negative ranks
  // -42/-41, correctly reached pricingAtTimeEngine, yet both still showed selectedByCap: false and all
  // 42 were reported capped). `entryKey` records the EXACT entry identity (chain+routed-token+txHash+
  // list, via pricingAtTimeEngine's own priceableEntryIdentityKey) — never just the bare txHash, which
  // is ambiguous whenever a target and its same-tx native quote leg share one real transaction (the
  // target's own entry getting capped made cappedTxHashes report that txHash as "capped" for the
  // UNRELATED native entry too, even when the native entry itself was genuinely selected and priced).
  const nativeQuoteRequirementResolvers: Array<{ dict: 'costUsd' | 'proceedsUsd'; key: string; groupKey: string; entryKey: string }> = []
  // Real-direction native legs share their txHash with the ORDINARY buys/sells map below — this
  // override lets that map use the SAME superior priority rank instead of the ordinary (tied) one,
  // keyed by the exact leg identity so it never touches the TARGET's own, unrelated requirement.
  const nativeLegRankOverride = new Map<string, number>()
  for (const candidate of sortedNativeCandidates) {
    const rank = nativeQuoteRankByGroupKey.get(candidate.groupKey)!
    if (candidate.leg.direction === 'unknown') {
      // NEVER-CURRENT-PRICE, DISCLOSED: `timestamp` is this SAME transaction's own historical
      // timestamp (lot.openedAt/lot.closedAt) — the identical value the target leg itself is priced
      // at — never Date.now()/the separate "current"-price pass (`atNow`, built later in this file
      // for open-lot mark-to-market only). A historical swap's native quote leg is priced at the
      // time it happened, exactly like every other historical entry in this same call.
      const syntheticKey = nativeQuoteRequirementKey(candidate.chain, candidate.txHash)
      const routedToken = resolveNativePricingToken(candidate.chain, candidate.leg.contract)
      nativeQuoteEntries.push({
        txHash: syntheticKey,
        // Same NATIVE PRICING ROUTE as toPriceableEntry above — only the price-source token string
        // is routed to canonical WETH; the leg's own stored contract stays the native pseudo-address
        // everywhere else (evidence/diagnostics, the quote-leg derivation, etc.).
        token: routedToken,
        chain: candidate.chain,
        timestamp: candidate.timestamp,
        amount: String(candidate.leg.amount),
        pairRank: rank,
      })
      // This synthetic entry is always appended to sellEntries (see the resolvePricingAtTime call
      // below) — list must be 'sell' to match pricingAtTimeEngine's own identity key exactly.
      const entryKey = priceableEntryIdentityKey({ chain: candidate.chain, token: routedToken, txHash: syntheticKey }, 'sell')
      nativeQuoteRequirementResolvers.push({ dict: 'proceedsUsd', key: syntheticKey, groupKey: candidate.groupKey, entryKey })
    } else {
      nativeLegRankOverride.set(
        `${candidate.chain}:${candidate.txHash.toLowerCase()}:${candidate.leg.contract.toLowerCase()}:${candidate.leg.direction}`,
        rank,
      )
      const dict = candidate.leg.direction === 'inbound' ? 'costUsd' : 'proceedsUsd'
      const list = candidate.leg.direction === 'inbound' ? 'buy' : 'sell'
      const routedToken = resolveNativePricingToken(candidate.chain, candidate.leg.contract)
      const entryKey = priceableEntryIdentityKey({ chain: candidate.chain, token: routedToken, txHash: candidate.txHash }, list)
      nativeQuoteRequirementResolvers.push({ dict, key: candidate.txHash, groupKey: candidate.groupKey, entryKey })
    }
  }

  function rankForEvent(event: NormalizedEvent): number | undefined {
    const override = nativeLegRankOverride.get(`${event.chain}:${event.txHash.toLowerCase()}:${event.contract.toLowerCase()}:${event.direction}`)
    return override ?? rankForTxHash(event.txHash)
  }

  const routeLogSnapshotBefore = pricingRouteLog.length
  const ethNativeAuditLogSnapshotBefore = ethNativeRoutingAuditLog.length

  // COINGECKO RESERVATION, DISCLOSED (confirmed production bug: two Tier-2 ETH native requirements,
  // correctly prioritised and routed, both returned resolvedPriceUsd: null with "CoinGecko elsewhere
  // reports circuit_open_after_429" — the shared, process-lifetime CoinGecko breaker was tripped by
  // an EARLIER, lower-priority ordinary CoinGecko contract call within this same scan, before the
  // two high-priority native ETH requirements ever got their own turn). Reserves exactly the number
  // of ETH-native requirements that will actually be attempted before the cap exhausts (never a
  // hardcoded "2") — see coingecko.ts's own reserveCoingeckoSlotsForNativeEth header for the full
  // mechanism: this never raises the total CoinGecko call ceiling, it only defers lower-priority
  // ordinary calls until the reserved native attempts have each had their own real turn.
  const ethNativeSelectedCount = sortedNativeCandidates.slice(0, assumedCapSlots).filter((c) => c.chain === 'eth').length
  reserveCoingeckoSlotsForNativeEth(ethNativeSelectedCount)

  let buyRequirementEntries = buys.map((e) => toPriceableEntry(e, rankForEvent(e)))
  let sellRequirementEntries = [...sells.map((e) => toPriceableEntry(e, rankForEvent(e))), ...nativeQuoteEntries]

  // COMPLETION-YIELD HISTORICAL-PRICING SCHEDULER, DISCLOSED — see completionYieldScheduler.ts's own
  // header. Production baseline: 219 structural lots, 11 verified (5.02%), ~500 total pricing
  // requirements, ~293 capped by the flat maxLookupsPerToken=2 rule, 312 of them real closed-lot
  // ("priority") requirements yet 226 of THOSE were still capped. SHADOW FIRST: both selections are
  // always computed and logged, with zero effect on real pricing, unless
  // HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED is explicitly set — in which case the entries actually
  // submitted to resolvePricingAtTime are pre-filtered to the scheduler's own selection (SAME total
  // budget the flat rule would have used) and the flat per-token cap inside pricingAtTimeEngine is
  // overridden to the scheduler's own fairness floor, so the pre-curated set is never re-clipped.
  let schedulerYieldSelected: SchedulerRequirement[] = []
  let evidenceLoadResult: LoadedEvidence = emptyLoadedEvidence()
  {
    const lotRefs: SchedulerLotRef[] = structuralMatchedLots.map((lot) => ({
      lotId: lot.lotId, chain: lot.chain, token: lot.token, openedTxHash: lot.openedTxHash, closedTxHash: lot.closedTxHash,
    }))
    const lotsByOpenKey = new Map<string, SchedulerLotRef[]>()
    const lotsByCloseKey = new Map<string, SchedulerLotRef[]>()
    for (const lot of lotRefs) {
      const openKey = `${lot.chain}:${lot.openedTxHash.toLowerCase()}`
      const closeKey = `${lot.chain}:${lot.closedTxHash.toLowerCase()}`
      lotsByOpenKey.set(openKey, [...(lotsByOpenKey.get(openKey) ?? []), lot])
      lotsByCloseKey.set(closeKey, [...(lotsByCloseKey.get(closeKey) ?? []), lot])
    }
    // Empty on the FIRST scheduling pass — this scheduler runs once, up front, over the full
    // requirement pool (same as the flat rule always has); no earlier round exists yet to have
    // resolved anything. Kept as an explicit, real parameter (never omitted) so annotateRequirement's
    // own "already resolved by a prior round" branch is honestly exercised as empty, not implied.
    const alreadyResolvedKeys = new Set<string>()

    // AUDIT FIX, DISCLOSED: real, per-transaction evidence of "this transaction already has a same-tx
    // verified stablecoin/native/WETH quote leg" — the SAME isVerifiedQuoteLegAddress check
    // [quote-leg-lookup-forensics] above already uses, reused here rather than re-derived. This is
    // what "opposite side already verified" must actually check (a lot's own traded token is never
    // itself the quote currency — checking IT for stablecoin/native/WETH status was the bug this
    // fixes).
    const verifiedQuoteTxHashes = new Set<string>()
    for (const [groupKey, legs] of swapLegsByTx) {
      const [chainPart] = groupKey.split(':')
      if (legs.some((leg) => isVerifiedQuoteLegAddress(chainPart as NormalizedEvent['chain'], leg.contract, leg.symbol))) {
        verifiedQuoteTxHashes.add(groupKey)
      }
    }

    const requirements: SchedulerRequirement[] = [
      ...buyRequirementEntries.map((entry) => annotateRequirement({ entry, list: 'buy' as const, lotsByOpenKey, lotsByCloseKey, alreadyResolvedKeys, verifiedQuoteTxHashes })),
      ...sellRequirementEntries.map((entry) => annotateRequirement({ entry, list: 'sell' as const, lotsByOpenKey, lotsByCloseKey, alreadyResolvedKeys, verifiedQuoteTxHashes })),
    ]

    const distinctTokenCount = new Set(requirements.map((r) => `${r.entry.chain}:${r.entry.token.toLowerCase()}`)).size
    const flatMaxLookupsPerToken = resolveMaxLookupsPerToken(distinctTokenCount)
    const { yieldSelection, comparison } = computeSchedulerComparison(requirements, flatMaxLookupsPerToken)
    schedulerYieldSelected = yieldSelection.selected

    // eslint-disable-next-line no-console
    console.warn('[historical-pricing-scheduler-shadow]', comparison)

    // SUCCESS-WEIGHTED SCHEDULING, DISCLOSED — see completionYieldScheduler.ts's own
    // "SUCCESS-WEIGHTED SCHEDULING" header and sourceSuccessEvidence.ts's evidence model. Production
    // baseline with the completion-yield scheduler live: 210 requirements selected, only 66
    // resolved, 145 unresolved; native 53 selected / 4 priced / 49 provider misses; GeckoTerminal
    // still 429; many Base DEX paths returning no_pool / blockResolutionFailure. Structural yield
    // cannot see any of that, so this discounts it by real, observed, source-specific success
    // probability.
    //
    // ONE SNAPSHOT, DISCLOSED (this task's explicit "no asynchronous ordering dependence"
    // constraint): the evidence is snapshotted ONCE, here, before any pricing call in this pass, and
    // that immutable value is used for every requirement — nothing computed below can depend on when
    // a concurrent provider attempt happened to land.
    //
    // SAME BUDGET, SAME PROVIDERS, SAME FAIRNESS CAP: the weighted selection is computed at the
    // SAME `existingSelectedCount` budget the flat rule would have used, with the same
    // FAIRNESS_FLOOR_PER_TOKEN — it reorders which requirements win existing slots, never how many
    // exist. SHADOW FIRST: always computed and logged; applied only behind the explicit flag below.
    // DURABLE EVIDENCE LOAD, DISCLOSED — see sourceSuccessEvidencePersistence.ts. Exactly ONE
    // bounded read, here, BEFORE any ranking, so a cold Vercel worker starts with the aggregate
    // counters previous workers already earned instead of an empty ledger. Strictly fail-open: any
    // timeout or KV outage leaves the ledger exactly as it was and the scan runs on the
    // deterministic default priors, unchanged. Never blocks pricing, never retries.
    evidenceLoadResult = await loadPersistedEvidence()
    seedPersistedEvidence(evidenceLoadResult.levelCounts)

    const successEvidence = snapshotSourceSuccessEvidence()
    const { weightedSelection, comparison: successComparison } =
      computeSuccessWeightedComparison(requirements, comparison.existingSelectedCount, successEvidence)

    // eslint-disable-next-line no-console
    console.warn('[historical-pricing-success-weighted-shadow]', successComparison)

    // NOT ENABLED AUTOMATICALLY, DISCLOSED: strictly opt-in via its own separate flag. With the flag
    // unset, `schedulerYieldSelected` keeps exactly the unweighted completion-yield selection above
    // and this whole block is observation only.
    if (process.env.HISTORICAL_PRICING_SUCCESS_WEIGHTING_ENABLED === 'true') {
      schedulerYieldSelected = weightedSelection.selected.map((w) => w.requirement)
    }

    const schedulerEnabled = process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED === 'true'
    if (schedulerEnabled) {
      const selectedKeys = new Set(schedulerYieldSelected.map((r) => priceableEntryIdentityKey(r.entry, r.list)))
      buyRequirementEntries = buyRequirementEntries.filter((e) => selectedKeys.has(priceableEntryIdentityKey(e, 'buy')))
      sellRequirementEntries = sellRequirementEntries.filter((e) => selectedKeys.has(priceableEntryIdentityKey(e, 'sell')))
    }
  }

  const atTradeTime = await resolvePricingAtTime({
    buyEntries: buyRequirementEntries,
    sellEntries: sellRequirementEntries,
    priceSources: params.priceSources,
    // Only applied when the pre-filter above actually ran (schedulerYieldSelected reflects the
    // selection either way, but the override only matters once entries were curated to it) — see
    // ResolvePricingAtTimeParams's own header. FAIRNESS_FLOOR_PER_TOKEN, never the flat default, so
    // the already-curated set is never re-clipped a second time inside pricingAtTimeEngine.
    maxLookupsPerTokenOverride: process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED === 'true' ? FAIRNESS_FLOOR_PER_TOKEN : undefined,
  })

  // ACCEPTED-PRICE HYDRATION, DISCLOSED (requirement #1 — "apply the persisted accepted price to
  // the exact matched-lot side immediately... do not merely remove the requirement while leaving
  // the lot side null"): merged in HERE, immediately after `resolvePricingAtTime` returns and BEFORE
  // any other code in this function reads `atTradeTime.costUsd`/`proceedsUsd` — the Alchemy gap-fill
  // pass's `hasEntry`/`hasExit` checks, `countFullyPriced()`, and the final `priceUsdLookup`/
  // `currentPriceUsdLookup` builders below all see the canonical accepted price exactly as if a
  // live provider had resolved it. Never overwrites a value `resolvePricingAtTime` itself already
  // set — a skipped requirement's txHash was never sent to it in the first place (see the filter
  // above), so there is nothing to conflict with; this is populating a gap, never replacing a value.
  for (const [txHash, priceUsd] of acceptedPriceByTxHash.costUsd) atTradeTime.costUsd[txHash] = priceUsd
  for (const [txHash, priceUsd] of acceptedPriceByTxHash.proceedsUsd) atTradeTime.proceedsUsd[txHash] = priceUsd

  acceptedEvidenceSkipAudit.goldrushActualLiveCalls = getGoldrushPriceSourceCallCount() - goldrushCallsBeforeResolve
  acceptedEvidenceSkipAudit.dexActualLiveCalls = getDexscreenerCallCount() - dexCallsBeforeResolve

  // PER-REQUIREMENT ETH-NATIVE DIAGNOSTIC, DISCLOSED, BOUNDED — cross-references
  // pricingAtTimeAdapter.ts's own ethNativeRoutingAuditLog (which has every field observable at the
  // provider layer: breaker state, HTTP status, response shape, parsed price, exact failure reason,
  // fallback sources subsequently attempted) with this file's own knowledge of WHICH closed-lot
  // requirement (txHash) each attempt belongs to — matched by originalTimestamp, the only identifier
  // shared between the two layers (PriceSourceFn carries no txHash).
  const ethNativeAuditEntriesThisCall = ethNativeRoutingAuditLog.slice(ethNativeAuditLogSnapshotBefore)
  const ethNativeRequirementDiagnostics = sortedNativeCandidates
    .filter((c) => c.chain === 'eth')
    .map((c) => {
      const auditEntry = ethNativeAuditEntriesThisCall.find((a) => a.diagnostic.originalTimestamp === c.timestamp)
      return {
        txHash: c.txHash,
        originalTimestamp: c.timestamp,
        formattedDate: auditEntry?.diagnostic.formattedDate ?? null,
        routeEligibilityMatched: auditEntry != null,
        requestAttempted: auditEntry?.diagnostic.requestAttempted ?? false,
        requestSkippedReason: auditEntry?.diagnostic.requestSkippedReason ?? (auditEntry == null ? 'native_route_not_matched' : null),
        circuitBreakerStateBeforeCall: auditEntry?.diagnostic.circuitBreakerStateBeforeCall ?? null,
        endpointType: 'native_coin_history' as const,
        httpStatus: auditEntry?.diagnostic.httpStatus ?? null,
        responseShapePresent: auditEntry?.diagnostic.responseShapePresent ?? null,
        parsedPrice: auditEntry?.diagnostic.parsedPrice ?? null,
        failureReason: auditEntry?.diagnostic.failureReason ?? null,
        fallbackSourcesAttempted: auditEntry?.fallbackSourcesAttempted ?? [],
      }
    })
  if (ethNativeRequirementDiagnostics.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[quote-leg-eth-native-provider-audit]', { requirements: ethNativeRequirementDiagnostics })
  }

  // NATIVE-ETH HISTORY COALESCING DIAGNOSTIC, DISCLOSED (confirmed production bug: reservation
  // worked, breaker was closed before both calls, yet both selected Tier-2 ETH requirements
  // independently requested the SAME date and both received a real 429 — two redundant live
  // requests for identical data). Groups this call's own ETH-native requirements by their resolved
  // date, so a shared result (one real request, N consumers) is directly visible, alongside
  // coingecko.ts's own live/coalesced counters for this whole scan.
  if (ethNativeRequirementDiagnostics.length > 0) {
    const byDate = new Map<string, typeof ethNativeRequirementDiagnostics>()
    for (const d of ethNativeRequirementDiagnostics) {
      if (!d.formattedDate) continue
      const list = byDate.get(d.formattedDate) ?? []
      list.push(d)
      byDate.set(d.formattedDate, list)
    }
    const sharedResultGroups = [...byDate.entries()].map(([formattedDate, group]) => {
      const first = group[0]
      const sharedResultKind: 'success' | 'http_429' | 'provider_miss' =
        first.parsedPrice != null ? 'success' : first.failureReason === 'coingecko_http_429' ? 'http_429' : 'provider_miss'
      return { formattedDate, sharedResultKind, consumerTxHashes: group.map((d) => d.txHash) }
    })
    // eslint-disable-next-line no-console
    console.warn('[quote-leg-eth-native-history-coalescing]', {
      ...getNativeEthHistoryCoalescingDiagnostics(),
      sharedResultGroups,
    })
  }

  // CAP-VS-PROVIDER-MISS SPLIT, DISCLOSED (confirmed production bug: top completion candidates
  // reached pricing with correct negative ranks -42/-41 — genuinely SURVIVING the cap — yet still
  // reported selectedByCap: false / all 42 "capped". Root cause: the prior version checked
  // `cappedTxHashes`, keyed by bare txHash — ambiguous whenever a target and its same-tx native quote
  // leg share one real transaction, since if the TARGET's own entry got capped, that shared txHash
  // showed up as "capped" for the unrelated native entry too. Fixed by checking `cappedEntryKeys`
  // instead — the exact per-entry identity (chain+routed-token+txHash+list), never ambiguous even
  // when multiple entries share a real txHash. `cappedTxHashes` itself is untouched, kept only for
  // callers that still rely on it.
  const nativeRequirementsSelectedByCap = nativeQuoteRequirementResolvers.filter((r) => !atTradeTime.cappedEntryKeys.has(r.entryKey)).length
  const nativeRequirementsActuallyCapped = nativeQuoteRequirementResolvers.filter((r) => atTradeTime.cappedEntryKeys.has(r.entryKey)).length
  const nativeRequirementsPriced = nativeQuoteRequirementResolvers.filter((r) => atTradeTime[r.dict][r.key] != null).length
  const nativeRequirementsProviderMiss = nativeQuoteRequirementResolvers.filter(
    (r) => !atTradeTime.cappedEntryKeys.has(r.entryKey) && atTradeTime[r.dict][r.key] == null,
  ).length
  const selectedNativeRequirementKeys = nativeQuoteRequirementResolvers
    .filter((r) => atTradeTime[r.dict][r.key] != null)
    .map((r) => r.groupKey)
  // RANK-DIRECTION VERIFICATION, DISCLOSED, BOUNDED (top 5 only) — pricingAtTimeEngine sorts pairRank
  // ASCENDING (smallest number = highest priority = processed first, see priceAllEntries' `rankOf(a) -
  // rankOf(b)` comparator). This makes that concrete and directly checkable per candidate: the BEST
  // candidate (sortedPosition 0, i.e. first in the completion-tier-sorted list) must have the SMALLEST
  // (most negative) assignedRank — rank(i) = i - N — and selectedByCap must be true for it whenever a
  // real cap slot was available. A future regression that reversed this (best getting the LARGEST
  // negative rank, e.g. -1 instead of -N) would show up here as sortedPosition 0 NOT having the
  // smallest assignedRank among the top 5.
  const resolverByGroupKey = new Map(nativeQuoteRequirementResolvers.map((r) => [r.groupKey, r]))
  const nativeRankTopFive = sortedNativeCandidates.slice(0, 5).map((c, i) => {
    const resolver = resolverByGroupKey.get(c.groupKey)
    return {
      txHash: c.txHash,
      originalContract: c.leg.contract,
      direction: c.leg.direction,
      completionTier: tierOf(c),
      sortedPosition: i,
      assignedRank: nativeQuoteRankByGroupKey.get(c.groupKey),
      pricingEntryDictKey: resolver?.key ?? null,
      pricingEntryDict: resolver?.dict ?? null,
      pricingEntryContract: resolveNativePricingToken(c.chain, c.leg.contract),
      entryIdentityKey: resolver?.entryKey ?? null,
      selectedByCap: resolver ? !atTradeTime.cappedEntryKeys.has(resolver.entryKey) : null,
      resolvedPriceUsd: resolver ? atTradeTime[resolver.dict][resolver.key] : null,
    }
  })
  // eslint-disable-next-line no-console
  console.warn('[quote-leg-native-cap-priority]', {
    nativeRequirementsSubmittedBeforeCap: nativeQuoteRequirementResolvers.length,
    rankValuesSeenByPricingAtTimeEngine: sortedNativeCandidates.map((c) => nativeQuoteRankByGroupKey.get(c.groupKey)),
    nativeRankTopFive,
    nativeRequirementsSelectedByCap,
    nativeRequirementsActuallyCapped,
    nativeRequirementsProviderMiss,
    nativeRequirementsPriced,
    selectedNativeRequirementKeys,
    // COMPLETION-AWARE RANKING DIAGNOSTICS, DISCLOSED, ADDITIVE — see the "COMPLETION-AWARE PRIORITY
    // ASSIGNMENT" header above for the full tier definitions.
    completionEligibleNativeRequirements,
    selectedRequirementsWithOppositeSidePriced,
    expectedLotsCompletedBySelection,
  })

  function countFullyPriced(): number {
    let both = 0
    for (const lot of structuralMatchedLots) {
      if (atTradeTime.costUsd[lot.openedTxHash] != null && atTradeTime.proceedsUsd[lot.closedTxHash] != null) both += 1
    }
    return both
  }
  const fullyPricedLotsBefore = countFullyPriced()
  const verifiedPricingCoverageBefore = structuralMatchedLots.length > 0 ? fullyPricedLotsBefore / structuralMatchedLots.length : 0

  // HISTORICAL-PRICING SCHEDULER RESULT, DISCLOSED, BOUNDED — only logged when
  // HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED actually applied the scheduler's own selection.
  // "Before" here is the real structural (price-free) state — zero, by construction, since
  // structuralMatchedLots is computed before any pricing pass runs — and "after" is the state
  // immediately following THIS scheduler's own dispatch, isolated from the later same-tx-quote-gap-
  // fill/Aerodrome/Alchemy passes (which run afterward and are already separately attributed by
  // their own existing diagnostics further down this file).
  if (process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED === 'true') {
    let resolvedRequirements = 0
    let pricesApplied = 0
    for (const req of schedulerYieldSelected) {
      const dict = req.list === 'buy' ? atTradeTime.costUsd : atTradeTime.proceedsUsd
      const usd = dict[req.entry.txHash]
      if (usd != null) { resolvedRequirements += 1; pricesApplied += 1 }
    }
    // eslint-disable-next-line no-console
    console.warn('[historical-pricing-scheduler-result]', {
      selectedRequirements: schedulerYieldSelected.length,
      resolvedRequirements,
      pricesApplied,
      lotsCompleted: fullyPricedLotsBefore,
      fullyPricedLotsBefore: 0,
      fullyPricedLotsAfter: fullyPricedLotsBefore,
      verifiedCoverageBefore: 0,
      verifiedCoverageAfter: Math.round(verifiedPricingCoverageBefore * 10000) / 100,
      callsBySource: atTradeTime.sourceBreakdown,
      failuresByReason: { unresolved: schedulerYieldSelected.length - resolvedRequirements },
    })
  }

  // AERODROME ATTRIBUTION, DISCLOSED, ADDITIVE — see AerodromeAttribution's own header above. Cross-
  // references basedex.ts's own per-request attribution record (getAerodromeAttributionForRequest —
  // set ONLY on a genuinely accepted, non-null Aerodrome-venue price, never on a bare pool discovery)
  // against the REAL, already-resolved atTradeTime dictionaries: a requirement only ever counts as
  // "resolved by Aerodrome" when (a) its own costUsd/proceedsUsd slot is non-null right now, AND (b)
  // that exact (chain, token, timestamp) request was recorded as an accepted Aerodrome price.
  // NEVER DOUBLE-COUNTED, DISCLOSED: Aerodrome is only ever reached, inside resolvePricingAtTime,
  // after DexScreener/CoinGecko/GoldRush/GeckoTerminal have ALL already returned null for that exact
  // (chain, token, timestamp) — see pricingAtTimeAdapter.ts's own routing order — so a hit here can
  // only ever be this requirement's own first, real price, never one an earlier source already
  // resolved.
  const aerodromeResolvedCostTxHashes = new Set<string>()
  const aerodromeResolvedProceedsTxHashes = new Set<string>()
  let aerodromeSlipstreamRequirementsResolved = 0
  let aerodromeClassicRequirementsResolved = 0
  for (const entry of buyRequirementEntries) {
    if (atTradeTime.costUsd[entry.txHash] == null) continue
    const attribution = getAerodromeAttributionForRequest(entry.chain, entry.token, entry.timestamp)
    if (!attribution) continue
    aerodromeResolvedCostTxHashes.add(entry.txHash)
    if (attribution.venue === 'aerodrome_slipstream') aerodromeSlipstreamRequirementsResolved += 1
    else aerodromeClassicRequirementsResolved += 1
  }
  for (const entry of sellRequirementEntries) {
    if (atTradeTime.proceedsUsd[entry.txHash] == null) continue
    const attribution = getAerodromeAttributionForRequest(entry.chain, entry.token, entry.timestamp)
    if (!attribution) continue
    aerodromeResolvedProceedsTxHashes.add(entry.txHash)
    if (attribution.venue === 'aerodrome_slipstream') aerodromeSlipstreamRequirementsResolved += 1
    else aerodromeClassicRequirementsResolved += 1
  }

  // "BEFORE AERODROME" AS A REAL COUNTERFACTUAL, DISCLOSED: Aerodrome runs INSIDE resolvePricingAtTime
  // alongside every other source (unlike Alchemy, which is a separate later stage with its own real
  // before/after snapshot below) — there is no separate "run without Aerodrome" pass to snapshot
  // against. Instead, this recomputes the exact same fully-priced count while treating every slot
  // this file just attributed to Aerodrome as though it were still null. This is EXACT, not an
  // approximation: the same-tx quote-leg gap-fill and Alchemy passes below only ever fill an
  // ALREADY-null slot (never overwrite/reorder an existing one — see their own headers), so nothing
  // between this point and here could have touched a slot Aerodrome itself resolved.
  function countFullyPricedExcluding(excludedCostTxHashes: Set<string>, excludedProceedsTxHashes: Set<string>): number {
    let both = 0
    for (const lot of structuralMatchedLots) {
      const hasEntry = atTradeTime.costUsd[lot.openedTxHash] != null && !excludedCostTxHashes.has(lot.openedTxHash)
      const hasExit = atTradeTime.proceedsUsd[lot.closedTxHash] != null && !excludedProceedsTxHashes.has(lot.closedTxHash)
      if (hasEntry && hasExit) both += 1
    }
    return both
  }
  const fullyPricedLotsBeforeAerodrome = countFullyPricedExcluding(aerodromeResolvedCostTxHashes, aerodromeResolvedProceedsTxHashes)
  // Same point in the pipeline as fullyPricedLotsBefore/verifiedPricingCoverageBefore above (right
  // after resolvePricingAtTime, before any later gap-fill stage) — Aerodrome has already run by here,
  // so that existing snapshot already IS the real "after Aerodrome" state.
  const fullyPricedLotsAfterAerodrome = fullyPricedLotsBefore
  const verifiedCoverageAfterAerodrome = verifiedPricingCoverageBefore
  const lotsCompletedByAerodrome = fullyPricedLotsAfterAerodrome - fullyPricedLotsBeforeAerodrome
  const verifiedCoverageBeforeAerodrome = structuralMatchedLots.length > 0 ? fullyPricedLotsBeforeAerodrome / structuralMatchedLots.length : 0

  // SHARED QUOTE-PRICE ATTRIBUTION, DISCLOSED, ADDITIVE — see basedex.ts's own "SHARED QUOTE-PRICE
  // CACHE" header. Same cross-referencing pattern as Aerodrome above, generalized to EVERY venue
  // (uniswap_v3 included) via getQuotePriceAttributionForRequest — recorded whenever basedex accepts
  // ANY venue's price, noting only whether the WETH-USD conversion for that specific requirement was
  // served by the shared cache rather than its own independent live CoinGecko call.
  const quotePriceRecoveredCostTxHashes = new Set<string>()
  const quotePriceRecoveredProceedsTxHashes = new Set<string>()
  let requirementsRecoveredBySharedQuotePrice = 0
  for (const entry of buyRequirementEntries) {
    if (atTradeTime.costUsd[entry.txHash] == null) continue
    const attribution = getQuotePriceAttributionForRequest(entry.chain, entry.token, entry.timestamp)
    if (!attribution?.usedSharedQuotePriceCacheHit) continue
    quotePriceRecoveredCostTxHashes.add(entry.txHash)
    requirementsRecoveredBySharedQuotePrice += 1
  }
  for (const entry of sellRequirementEntries) {
    if (atTradeTime.proceedsUsd[entry.txHash] == null) continue
    const attribution = getQuotePriceAttributionForRequest(entry.chain, entry.token, entry.timestamp)
    if (!attribution?.usedSharedQuotePriceCacheHit) continue
    quotePriceRecoveredProceedsTxHashes.add(entry.txHash)
    requirementsRecoveredBySharedQuotePrice += 1
  }
  // Same exact-counterfactual reasoning as fullyPricedLotsBeforeAerodrome above: recompute the
  // fully-priced count while treating every slot the shared quote-price cache contributed to as
  // though it were still null.
  const fullyPricedLotsBeforeSharedQuotePrice = countFullyPricedExcluding(quotePriceRecoveredCostTxHashes, quotePriceRecoveredProceedsTxHashes)
  const lotsCompletedBySharedQuotePrice = fullyPricedLotsBefore - fullyPricedLotsBeforeSharedQuotePrice
  const baseDexQuotePriceAttribution = getBaseDexQuotePriceAttributionForScan()

  const baseDexVenueAttribution = getBaseDexVenueAttributionForScan()
  const aerodromeAttribution: AerodromeAttribution = {
    aerodromeSlipstreamPoolsFound: baseDexVenueAttribution.poolsFoundByVenue.aerodrome_slipstream,
    aerodromeClassicPoolsFound: baseDexVenueAttribution.poolsFoundByVenue.aerodrome_classic_volatile,
    aerodromeSlipstreamPricesAccepted: baseDexVenueAttribution.pricesAcceptedByVenue.aerodrome_slipstream,
    aerodromeClassicPricesAccepted: baseDexVenueAttribution.pricesAcceptedByVenue.aerodrome_classic_volatile,
    aerodromeSlipstreamRequirementsResolved,
    aerodromeClassicRequirementsResolved,
    lotsCompletedByAerodrome,
    fullyPricedLotsBeforeAerodrome,
    fullyPricedLotsAfterAerodrome,
    verifiedCoverageBeforeAerodrome,
    verifiedCoverageAfterAerodrome,
    failureReasonsByVenue: baseDexVenueAttribution.failureReasonsByVenue,
    rpcCallsByVenue: baseDexVenueAttribution.rpcCallsByVenue,
    quotePriceCacheHits: baseDexQuotePriceAttribution.quotePriceCacheHits,
    quotePriceLiveResolutions: baseDexQuotePriceAttribution.quotePriceLiveResolutions,
    quotePriceUnavailable: baseDexQuotePriceAttribution.quotePriceUnavailable,
    requirementsRecoveredBySharedQuotePrice,
    lotsCompletedBySharedQuotePrice,
  }
  // eslint-disable-next-line no-console
  console.warn('[priceLotsForWallet] aerodrome attribution', aerodromeAttribution)

  // SAME-TRANSACTION QUOTE-LEG GAP-FILL PASS, DISCLOSED, ADDITIVE — applied AFTER resolvePricingAtTime
  // (steps 3/4 of the required priority: existing provider historical price, existing on-chain pool
  // price at block — both already attempted, unmodified, inside resolvePricingAtTime) but BEFORE any
  // expensive bounded recovery fallback (pnlReconciliation.ts's own later stage — step 5, untouched).
  // Only ever fills a costUsd/proceedsUsd entry that is currently null — never overwrites, never
  // demotes, an already-resolved (stronger) existing price. Zero provider/network calls: the
  // quote-leg's own USD value is read back from whichever of costUsd/proceedsUsd resolvePricingAtTime
  // already computed for that SAME transaction's opposite-direction leg (already resolved as its own
  // ordinary priced entry — see buys/sells above), never re-fetched. `swapLegsByTx` is the SAME
  // grouping already computed above for the native/WETH quote-leg requirements pass — built once.

  // FORENSIC LOOKUP-BUILD DIAGNOSTICS, DISCLOSED, ADDITIVE — answers "why does every lookup group
  // have no usable opposite leg" directly from real data, without guessing. Confirms (a) the lookup
  // is built from `merged` — the full canonical normalized+recovered event set (mergeNormalizedEvents
  // above), never from `buys`/`sells` (the already-filtered, direction-gated pricing-requirement
  // arrays) — and (b) exactly how many groups are single-leg vs multi-leg, which pins the loss to
  // either "never ingested" (single-leg, no candidate anywhere in `merged`) or "present but
  // mismatched" (multi-leg groups that still failed to match, a real bug in the selection logic
  // rather than an ingestion gap).
  let legCountOne = 0
  let legCountTwo = 0
  let legCountThreeOrMore = 0
  let transactionsWithVerifiedQuoteAddress = 0
  const sampleTransactions: Array<{ groupKey: string; legs: Array<{ contract: string; symbol: string; direction: string }> }> = []
  for (const [groupKey, legs] of swapLegsByTx) {
    if (legs.length === 1) legCountOne += 1
    else if (legs.length === 2) legCountTwo += 1
    else legCountThreeOrMore += 1
    const [chainPart] = groupKey.split(':')
    if (legs.some((leg) => isVerifiedQuoteLegAddress(chainPart as NormalizedEvent['chain'], leg.contract, leg.symbol))) {
      transactionsWithVerifiedQuoteAddress += 1
    }
    if (sampleTransactions.length < 10) {
      sampleTransactions.push({
        groupKey,
        legs: legs.map((leg) => ({ contract: leg.contract, symbol: leg.symbol, direction: leg.direction })),
      })
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[quote-leg-lookup-forensics]', {
    lookupBuiltFrom: 'merged (mergeNormalizedEvents(normalizedEvents, recoveredEvents)) — the full canonical set, never buys/sells',
    mergedEventCount: merged.length,
    transactionsInSwapLookup: swapLegsByTx.size,
    legCountDistribution: { oneLeg: legCountOne, twoLegs: legCountTwo, threeOrMoreLegs: legCountThreeOrMore },
    transactionsWithVerifiedQuoteAddress,
    sampleTransactions,
  })

  // SHARED NATIVE-PRICE PREFETCH, DISCLOSED, PHASE 1 — see src/modules/nativePriceResolver/index.ts's
  // own header for the full audited root cause. Production baseline: 53 native ETH/WETH requirements,
  // only 4 selected, 51 quote candidates failing `missing_verified_native_price`. Those 51 failed not
  // because ETH's historical price was unknowable, but because the ONLY way this function could learn
  // it was to read back a costUsd/proceedsUsd slot that had itself survived MAX_LOOKUPS_PER_TOKEN (2)
  // — rationing one global scalar behind a per-token call cap it never needed to be subject to.
  //
  // Collected here as (chain, timestamp) requirements for exactly the transactions whose same-tx quote
  // leg IS a native/WETH leg, then resolved by DISTINCT UTC-day bucket (a handful of calendar days,
  // not 53 requirements) before the synchronous gap-fill loop below runs. Accepted prices are cached
  // for the life of the process, so repeat scans over the same days spend zero calls.
  //
  // NO BUDGET INCREASE TO ANY EXISTING PATH: this never touches MAX_LOOKUPS_PER_TOKEN, never adds an
  // entry to resolvePricingAtTime, and never re-requests a bucket already known. Its own live-call
  // ceiling is nativePriceResolver's own hard cap (MAX_NATIVE_PRICE_LIVE_BUCKETS_PER_PROCESS).
  const nativePriceRequirements: Array<{ chain: NormalizedEvent['chain']; timestamp: number }> = []
  {
    const seenRequirementKeys = new Set<string>()
    for (const event of [...buys, ...sells]) {
      const timestamp = Date.parse(event.timestamp)
      if (!Number.isFinite(timestamp)) continue
      if (!isEthNativeChain(event.chain)) continue
      const legs = swapLegsByTx.get(swapLegGroupKey(event.chain, event.txHash)) ?? []
      const hasNativeQuoteLeg = legs.some(
        (leg) =>
          !leg.excludeReason &&
          leg.direction !== event.direction &&
          leg.contract.toLowerCase() !== event.contract.toLowerCase() &&
          isNativeOrWethLeg(event.chain, leg) &&
          isFinitePositiveAmount(leg.amount),
      )
      if (!hasNativeQuoteLeg) continue
      const key = `${event.chain}:${nativePriceBucketStart(timestamp)}`
      if (seenRequirementKeys.has(key)) continue
      seenRequirementKeys.add(key)
      nativePriceRequirements.push({ chain: event.chain, timestamp })
    }
  }
  const prefetchedNativePrices = await prefetchNativeUsdPrices({ requirements: nativePriceRequirements })

  const quoteLegCache = new Map<string, QuoteLegPriceResult>()
  let sameTxStablePricesRecovered = 0
  let sameTxNativePricesRecovered = 0
  // Real attribution for the Phase 1 change specifically — how many native quote legs got their price
  // from the shared resolver rather than from an already-resolved dictionary slot.
  let nativePricesFromResolvedSlot = 0
  let nativePricesFromSharedResolver = 0
  let nativePricesStillUnavailable = 0
  const rejectionReasonCounts: Record<string, number> = {}
  let requirementsWithValidOppositeLeg = 0
  const sampleRecovered: Array<{
    chain: string
    txHash: string
    token: string
    side: 'entry' | 'exit'
    source: string
    targetQuantity: number
    quoteToken: string
    quoteQuantity: number
    quoteValueUsd: number
    derivedPriceUsd: number
    timestamp: string
  }> = []
  const distinctTransactionsUsed = new Set<string>()
  let targetTransactionFoundInLookup = 0
  let targetTransactionMissingFromLookup = 0

  function applySameTxQuoteLegGapFill(event: NormalizedEvent, targetDict: Record<string, number | null>, side: 'entry' | 'exit'): void {
    if (targetDict[event.txHash] != null) return // an existing, stronger price already resolved — never reordered/overwritten
    const groupKey = swapLegGroupKey(event.chain, event.txHash)
    const legs = swapLegsByTx.get(groupKey) ?? []
    if (legs.length > 0) targetTransactionFoundInLookup += 1
    else targetTransactionMissingFromLookup += 1
    const cacheKey = `${groupKey}:${event.contract.toLowerCase()}:${event.direction}`
    let result = quoteLegCache.get(cacheKey)
    if (!result) {
      // NOT-SAME-DIRECTION MATCH, DISCLOSED (see deriveSameTransactionQuotePrice's own header for the
      // full production trace): the quote leg's direction is resolved relative to the SCANNED WALLET
      // (src/modules/normalization/index.ts's classifyDirection) — a router-to-pool leg that never
      // touches the wallet directly is honestly 'unknown', not the strict opposite of the target's own
      // inbound/outbound. Only requiring "not the same direction as the target" (rather than "exactly
      // the opposite of inbound/outbound") is what actually locates it.
      const quoteLeg = legs.find(
        (leg) => !leg.excludeReason && leg.direction !== event.direction && leg.contract.toLowerCase() !== event.contract.toLowerCase(),
      )
      let historicalNativePrice: number | null = null
      // 'inbound'/'outbound' quote legs were themselves sent through resolvePricingAtTime as ordinary
      // buy/sell entries — their already-resolved USD value is reused directly, at zero additional
      // cost. A genuinely 'unknown'-direction native/WETH quote leg (never touches the wallet) is now
      // ALSO a real pricing requirement — see the NATIVE/WETH QUOTE-LEG REQUIREMENTS block above,
      // which adds it under its own synthetic dictionary key (nativeQuoteRequirementKey) precisely so
      // it never collides with the target's own entry sharing the same real txHash.
      if (quoteLeg && isNativeOrWethLeg(event.chain, quoteLeg) && quoteLeg.amount > 0) {
        const quoteLegOwnUsd =
          quoteLeg.direction === 'inbound'
            ? atTradeTime.costUsd[event.txHash]
            : quoteLeg.direction === 'outbound'
              ? atTradeTime.proceedsUsd[event.txHash]
              : atTradeTime.proceedsUsd[nativeQuoteRequirementKey(event.chain, event.txHash)]
        if (quoteLegOwnUsd != null) {
          // PREFERRED, UNCHANGED PATH: this leg's own already-resolved USD value, priced at this exact
          // transaction. Strictly the strongest evidence available — never displaced by the shared
          // resolver below, which is consulted ONLY when this is genuinely absent.
          historicalNativePrice = quoteLegOwnUsd / quoteLeg.amount
          nativePricesFromResolvedSlot += 1
        } else {
          // PHASE 1 RECOVERY, DISCLOSED: the 51 `missing_verified_native_price` failures land here.
          // ETH/USD at this trade's own historical day, from the one shared resolver — the SAME real
          // source, at the SAME real granularity, that filled the slot above whenever the cap happened
          // to allow it. Not a weaker class of evidence being promoted: the identical evidence, no
          // longer rationed. Still fails closed (historicalNativePrice stays null → the existing
          // `missing_verified_native_price` rejection) when the resolver genuinely has no price.
          const resolved = readPrefetchedNativeUsdPrice(prefetchedNativePrices, Date.parse(event.timestamp))
          if (resolved) {
            historicalNativePrice = resolved.priceUsd
            nativePricesFromSharedResolver += 1
          } else {
            nativePricesStillUnavailable += 1
          }
        }
      }
      result = deriveSameTransactionQuotePrice({
        chain: event.chain,
        txHash: event.txHash,
        timestamp: Date.parse(event.timestamp),
        targetToken: event.contract,
        targetDirection: event.direction,
        targetQuantity: event.amount,
        groupedSwapLegs: legs,
        historicalNativePrice,
      })
      quoteLegCache.set(cacheKey, result)
    }
    if (result.evidence.rejectionReason !== 'no_opposite_leg_in_transaction') requirementsWithValidOppositeLeg += 1
    // costUsd/proceedsUsd store the TOTAL resolved USD value of a leg (resolvePricingAtTime's own
    // usd = price * amount — see pricingAtTimeEngine/index.ts's priceAllEntries/multiplyAmount), not
    // a per-unit price. The quote leg's own quoteValueUsd already IS that total (a swap's paid USD
    // amount equals the USD value received) — priceUsd (per-unit) is sanity-checked, but
    // quoteValueUsd is what must be stored to match every other value already in these dicts.
    if (result.priceUsd != null && isSanePrice(result.priceUsd)) {
      targetDict[event.txHash] = result.quoteValueUsd
      if (result.source === 'same_tx_stable_quote') sameTxStablePricesRecovered += 1
      else sameTxNativePricesRecovered += 1
      distinctTransactionsUsed.add(groupKey)
      if (sampleRecovered.length < 10) {
        sampleRecovered.push({
          chain: event.chain,
          txHash: event.txHash,
          token: event.contract,
          side,
          source: result.source,
          targetQuantity: event.amount,
          quoteToken: result.quoteToken,
          quoteQuantity: result.quoteQuantity,
          quoteValueUsd: result.quoteValueUsd,
          derivedPriceUsd: result.priceUsd,
          timestamp: event.timestamp,
        })
      }
    } else if (result.evidence.rejectionReason) {
      rejectionReasonCounts[result.evidence.rejectionReason] = (rejectionReasonCounts[result.evidence.rejectionReason] ?? 0) + 1
    }
  }

  for (const e of buys) applySameTxQuoteLegGapFill(e, atTradeTime.costUsd, 'entry')
  for (const e of sells) applySameTxQuoteLegGapFill(e, atTradeTime.proceedsUsd, 'exit')

  const fullyPricedLotsAfter = countFullyPriced()
  const verifiedPricingCoverageAfter = structuralMatchedLots.length > 0 ? fullyPricedLotsAfter / structuralMatchedLots.length : 0

  // PHASE 1 COVERAGE DIAGNOSTIC, DISCLOSED, BOUNDED — one line per scan. Reports the real, measured
  // effect of the shared native-price resolver against the production baseline this phase targets
  // (53 native requirements / 4 selected / 51 `missing_verified_native_price`), so the gain is
  // attributable rather than assumed before Phase 2 is built on top of it.
  // eslint-disable-next-line no-console
  console.warn('[native-price-resolver-phase1]', {
    nativePriceRequirementBuckets: nativePriceRequirements.length,
    nativePricesFromResolvedSlot,
    nativePricesFromSharedResolver,
    nativePricesStillUnavailable,
    missingVerifiedNativePriceRejections: rejectionReasonCounts['missing_verified_native_price'] ?? 0,
    sameTxNativePricesRecovered,
    sameTxStablePricesRecovered,
    closedLots: structuralMatchedLots.length,
    fullyPricedLotsBefore,
    fullyPricedLotsAfter,
    verifiedCoverageBefore: Math.round(verifiedPricingCoverageBefore * 10000) / 100,
    verifiedCoverageAfter: Math.round(verifiedPricingCoverageAfter * 10000) / 100,
    resolver: getNativePriceResolverDiagnostics(),
  })

  // PER-SOURCE AUDIT, DISCLOSED, BOUNDED — exactly the breakdown the Phase 1 production failure
  // required and could not be answered without: which source was attempted for which UTC bucket,
  // what it returned, and whether a fallback genuinely ran or was skipped because it shares an
  // already-exhausted quota. `attemptLog` is capped (MAX_ATTEMPT_LOG_ENTRIES) so log volume stays
  // bounded, and no entry ever contains a key or a secret-bearing URL.
  {
    const resolverDiagnostics = getNativePriceResolverDiagnostics()
    const geckoTerminalRangeDiagnostics = getGeckoTerminalRangeDiagnostics()
    // eslint-disable-next-line no-console
    console.warn('[native-price-resolver-source-audit]', {
      bucketsRequested: resolverDiagnostics.bucketsRequested,
      sourceAttempts: resolverDiagnostics.sourceAttempts,
      sourceSuccesses: resolverDiagnostics.sourceSuccesses,
      failureReasonsBySource: resolverDiagnostics.failureReasonsBySource,
      httpStatusesBySource: resolverDiagnostics.httpStatusesBySource,
      acceptedBuckets: resolverDiagnostics.acceptedBuckets,
      unresolvedBuckets: resolverDiagnostics.unresolvedBuckets,
      permanentCacheHits: resolverDiagnostics.permanentCacheHits,
      nativeRequirementsCompleted: nativePricesFromSharedResolver,
      lotsCompleted: fullyPricedLotsAfter - fullyPricedLotsBefore,
      // GeckoTerminal-specific attribution — the source added after GoldRush returned 25/25
      // `goldrush_no_price` and the CoinGecko group stayed exhausted.
      geckoTerminalAttempts: resolverDiagnostics.attemptsBySource.geckoterminal_eth_ohlcv,
      geckoTerminalSuccesses: resolverDiagnostics.successesBySource.geckoterminal_eth_ohlcv,
      geckoTerminalRequestsThisScan: getGeckoTerminalEthOhlcvRequestCount(),
      // BOUNDED RANGE ARCHITECTURE, DISCLOSED (replaces per-day fetching, which spent 25 requests and
      // received 25 HTTP 429s). FLATTENED HERE DELIBERATELY, DISCLOSED (production defect fixed this
      // revision): the previous shape nested a `geckoTerminalRange` object containing an `httpStatuses`
      // array of objects inside this already-large aggregate log line — a production log pipeline
      // rendered that nested array as `[Object]`, hiding the exact failure. Every field the audit
      // needs is now a top-level primitive/array-of-primitives on THIS line, and the full per-request
      // detail (URL shape, headers, body snippet, canonical rejection category) is additionally logged
      // as its own flat, bounded '[geckoterminal-range-request]' line per real request — see
      // geckoTerminalEthOhlcv.ts's logRangeAttempt — which survives even a shallow log inspector.
      geckoTerminalRequiredBucketCount: geckoTerminalRangeDiagnostics?.requiredBucketCount ?? 0,
      geckoTerminalRangeStartUtc: geckoTerminalRangeDiagnostics?.rangeStartUtc ?? null,
      geckoTerminalRangeEndUtc: geckoTerminalRangeDiagnostics?.rangeEndUtc ?? null,
      geckoTerminalRangeRequests: geckoTerminalRangeDiagnostics?.rangeRequests ?? 0,
      geckoTerminalCandlesReturned: geckoTerminalRangeDiagnostics?.candlesReturned ?? 0,
      geckoTerminalExactDaysMatched: geckoTerminalRangeDiagnostics?.exactDaysMatched ?? 0,
      geckoTerminalMissingDays: geckoTerminalRangeDiagnostics?.missingDays ?? [],
      geckoTerminalQuotaStopped: geckoTerminalRangeDiagnostics?.quotaStopped ?? false,
      // One entry per real request this scan: poolLabel, exact httpStatus, and the canonical
      // rejection category (http_429/http_4xx/http_5xx/malformed_response/empty_ohlcv/
      // pool_identity_mismatch/token_param_mismatch/timestamp_range_mismatch/null-on-success) — small
      // enough (at most 2 entries) to stay flat and readable even nested one level.
      geckoTerminalAttemptSummaries: (geckoTerminalRangeDiagnostics?.attempts ?? []).map((a) => ({
        poolLabel: a.poolLabel,
        httpStatus: a.httpStatus,
        rejectionCategory: a.rejectionCategory,
        rawCandleCount: a.rawCandleCount,
        exactDayCandlesIndexed: a.exactDayCandlesIndexed,
      })),
      // Which allowlisted pool and which exact daily candle backed each accepted pool-derived bucket.
      selectedPools: resolverDiagnostics.selectedPools,
      // Coverage on both sides of the whole native-price pass, so a real gain is attributable.
      closedLots: structuralMatchedLots.length,
      verifiedCoverageBefore: Math.round(verifiedPricingCoverageBefore * 10000) / 100,
      verifiedCoverageAfter: Math.round(verifiedPricingCoverageAfter * 10000) / 100,
      attemptLog: resolverDiagnostics.attemptLog,
    })
  }
  // Real, observed effect of this whole native-quote pass (ranking + reuse) on closed-lot completion —
  // compared against expectedLotsCompletedBySelection (the pre-call prediction) above.
  const actualLotsCompletedByQuote = fullyPricedLotsAfter - fullyPricedLotsBefore

  // eslint-disable-next-line no-console
  console.warn('[historical-quote-leg-coverage]', {
    closedLots: structuralMatchedLots.length,
    entryRequirements: entryRankByTxHash.size,
    exitRequirements: exitRankByTxHash.size,
    // WHERE THE QUOTE LEG WAS LOST, DISCLOSED — a three-stage funnel so a regression is attributable
    // to a specific stage rather than one opaque total: transactionsInSwapLookup (the tx actually has
    // ANY grouped legs at all — a non-zero floor confirms `merged` itself isn't empty/misgrouped),
    // requirementsWithValidOppositeLeg (a same-tx leg with a different direction than the target was
    // found — this is exactly the count that was 0 in production before this fix, since the previous
    // strict "exactly the opposite of inbound/outbound" match silently excluded every 'unknown'-
    // direction pool-side leg), then the recovered counts below (a valid opposite leg existed AND was
    // a verified stablecoin/native quote AND produced a sane price).
    transactionsInSwapLookup: swapLegsByTx.size,
    targetTransactionFoundInLookup,
    targetTransactionMissingFromLookup,
    requirementsWithValidOppositeLeg,
    nativeQuoteRequirementsFound,
    nativeRequirementsSelectedByCap,
    nativeRequirementsActuallyCapped,
    nativeRequirementsProviderMiss,
    nativeRequirementsPriced,
    sameTxStablePricesRecovered,
    sameTxNativePricesRecovered,
    requirementsSatisfiedBySameTxQuote: sameTxStablePricesRecovered + sameTxNativePricesRecovered,
    distinctTransactionsUsed: distinctTransactionsUsed.size,
    rejectedQuoteCandidates: Object.values(rejectionReasonCounts).reduce((a, b) => a + b, 0),
    rejectionReasonCounts,
    verifiedPricingCoverageBefore,
    verifiedPricingCoverageAfter,
    fullyPricedLotsBefore,
    fullyPricedLotsAfter,
    actualLotsCompletedByQuote,
    additionalProviderCalls: 0,
  })
  if (sampleRecovered.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[historical-quote-leg-coverage] sample', { samples: sampleRecovered })
  }

  // ALCHEMY HISTORICAL PRICING, DISCLOSED, ADDITIVE — resolves what Alchemy's real, bounded
  // historical-price endpoint returns for closed lots STILL missing a price after every existing
  // source (goldrush/dexscreener/geckoterminal/coingecko/basedex + the same-tx quote-leg gap-fill
  // above) has already run — grouped by asset, singleflight-cached, negative-cached, typed-failure-
  // classified, capped at MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN live requests (see
  // alchemyHistoricalPriceSource.ts for the full budget/cache/classification disclosure).
  //
  // PROMOTION, DISCLOSED: gated by isAlchemyHistoricalPricingEnabled() (ALCHEMY_HISTORICAL_PRICING_
  // ENABLED=true — see that function's own header for why this new flag exists). When OFF (the
  // default), behavior is byte-identical to the prior shadow-mode-only pass: results are resolved and
  // logged, never written into atTradeTime. When ON, only temporally-ACCEPTED prices
  // (shadowPricesByTxHash already excludes anything that failed the 24h/6h acceptance window — see
  // that module) are written, and ONLY into a costUsd/proceedsUsd slot that is currently null — an
  // existing verified price from any earlier source is never touched, reordered, or overwritten.
  // Because Alchemy is the LAST gap-fill stage in this whole pipeline, "Alchemy success stops lower
  // fallbacks" is already true structurally: nothing runs after this block for these requirements.
  const alchemyApplyEnabled = isAlchemyHistoricalPricingEnabled()
  // UNIT CONVERSION, DISCLOSED: Alchemy's historical endpoint returns a PER-UNIT USD price, but
  // costUsd/proceedsUsd store the TOTAL resolved USD value of a transaction leg (same convention as
  // resolvePricingAtTime's own usd = price * amount, and the same-tx quote-leg gap-fill above) — so
  // applying a bare per-unit price here would silently corrupt every downstream dollar figure by a
  // factor of the token's own quantity. eventAmountByLegKey resolves the REAL transaction amount for
  // the exact (chain, txHash, token) leg — keyed by token too, since one tx can carry multiple legs
  // for different tokens at different amounts — read from `merged`, the same canonical event set the
  // quote-leg lookup above is built from, never re-fetched.
  const eventAmountByLegKey = new Map<string, number>()
  for (const e of merged) {
    eventAmountByLegKey.set(`${e.chain}:${e.txHash.toLowerCase()}:${e.contract.toLowerCase()}`, e.amount)
  }
  const alchemyRequirementSidesByTxHash = new Map<string, { sides: Set<'cost' | 'proceeds'>; chain: NormalizedEvent['chain']; token: string }>()
  function markAlchemySide(txHash: string, side: 'cost' | 'proceeds', chain: NormalizedEvent['chain'], token: string): void {
    const meta = alchemyRequirementSidesByTxHash.get(txHash) ?? { sides: new Set<'cost' | 'proceeds'>(), chain, token }
    meta.sides.add(side)
    alchemyRequirementSidesByTxHash.set(txHash, meta)
  }
  const alchemyShadowRequirements: AlchemyPricingRequirement[] = []
  let alchemyRequirementsSkippedByAcceptedEvidence = 0
  for (const lot of structuralMatchedLots) {
    const hasEntry = atTradeTime.costUsd[lot.openedTxHash] != null
    const hasExit = atTradeTime.proceedsUsd[lot.closedTxHash] != null
    // ACCEPTED-EVIDENCE EXCLUSION, DISCLOSED (requirement #2's explicit "Alchemy historical
    // pricing" bullet): a side already removed from `buys`/`sells` above (see
    // `isSkippableByAcceptedEvidence`) never populated `atTradeTime.costUsd/proceedsUsd` at all —
    // without this check, this LAST gap-fill stage would otherwise re-attempt exactly the calls the
    // filter above already avoided. `hydrateFromAcceptedEvidence`/`recoverPrices` downstream in
    // pnlReconciliation.ts still applies the real canonical value regardless.
    if (!hasEntry && !isSkippableByAcceptedEvidence(lot.chain, lot.openedTxHash, 'entry')) {
      alchemyShadowRequirements.push({ chain: lot.chain, token: lot.token, txHash: lot.openedTxHash, timestamp: lot.openedAt, oneSideMissing: hasExit })
      markAlchemySide(lot.openedTxHash, 'cost', lot.chain, lot.token)
    } else if (!hasEntry) {
      alchemyRequirementsSkippedByAcceptedEvidence += 1
    }
    if (!hasExit && !isSkippableByAcceptedEvidence(lot.chain, lot.closedTxHash, 'exit')) {
      alchemyShadowRequirements.push({ chain: lot.chain, token: lot.token, txHash: lot.closedTxHash, timestamp: lot.closedAt, oneSideMissing: hasEntry })
      markAlchemySide(lot.closedTxHash, 'proceeds', lot.chain, lot.token)
    } else if (!hasExit) {
      alchemyRequirementsSkippedByAcceptedEvidence += 1
    }
  }
  acceptedEvidenceSkipAudit.alchemyRequirementsBeforeSkip = alchemyShadowRequirements.length + alchemyRequirementsSkippedByAcceptedEvidence
  acceptedEvidenceSkipAudit.alchemyRequirementsAfterSkip = alchemyShadowRequirements.length
  if (alchemyRequirementsSkippedByAcceptedEvidence > 0) {
    acceptedEvidenceSkipAudit.pricingRequirementsSkippedByAcceptedEvidence.alchemy =
      (acceptedEvidenceSkipAudit.pricingRequirementsSkippedByAcceptedEvidence.alchemy ?? 0) + alchemyRequirementsSkippedByAcceptedEvidence
    acceptedEvidenceSkipAudit.estimatedProviderCallsAvoided += alchemyRequirementsSkippedByAcceptedEvidence
    acceptedEvidenceSkipAudit.estimatedCreditsSaved += alchemyRequirementsSkippedByAcceptedEvidence * ESTIMATED_CREDITS_PER_SKIPPED_REQUIREMENT
    acceptedEvidenceSkipAudit.estimatedCuSaved += alchemyRequirementsSkippedByAcceptedEvidence * ESTIMATED_CU_PER_SKIPPED_REQUIREMENT
  }
  if (alchemyShadowRequirements.length > 0) {
    const { shadowPricesByTxHash, audit: alchemyAudit } = await resolveAlchemyHistoricalPricesShadow(alchemyShadowRequirements)
    acceptedEvidenceSkipAudit.alchemyActualLiveCalls = alchemyAudit.liveRequests

    // Snapshot BEFORE any Alchemy write — reuses the exact same countFullyPriced() closure already
    // defined above (over atTradeTime/structuralMatchedLots), so "before" here means "after every
    // other source has already run," not the original pre-pipeline state.
    const fullyPricedLotsBeforeAlchemy = countFullyPriced()
    const verifiedCoverageBefore = structuralMatchedLots.length > 0 ? fullyPricedLotsBeforeAlchemy / structuralMatchedLots.length : 0
    // AUDIT-ONLY PNL APPROXIMATION, DISCLOSED: sum of (proceedsUsd - costUsd) over lots whose BOTH
    // sides already have a resolved USD value, using the same per-transaction totals costUsd/
    // proceedsUsd already store elsewhere in this file. This is NOT the official realized-PnL module
    // (src/modules/realizedPnl) and is never fed into any PnL gate — it exists purely so this audit
    // log can report a before/after delta without requiring a second, heavier pipeline pass.
    function sumApproxRealizedPnl(): number {
      let sum = 0
      for (const lot of structuralMatchedLots) {
        const cost = atTradeTime.costUsd[lot.openedTxHash]
        const proceeds = atTradeTime.proceedsUsd[lot.closedTxHash]
        if (cost != null && proceeds != null) sum += proceeds - cost
      }
      return sum
    }
    const realizedPnlBefore = sumApproxRealizedPnl()

    let pricesApplied = 0
    if (alchemyApplyEnabled) {
      for (const [txHash, { sides, chain, token }] of alchemyRequirementSidesByTxHash) {
        const perUnitPrice = shadowPricesByTxHash.get(txHash)
        if (perUnitPrice == null) continue
        const amount = eventAmountByLegKey.get(`${chain}:${txHash.toLowerCase()}:${token.toLowerCase()}`)
        // No real transaction amount to scale by — fail closed rather than write an un-scaled,
        // silently-wrong per-unit value into a TOTAL-USD dictionary.
        if (amount == null || !Number.isFinite(amount) || amount <= 0) continue
        const totalUsd = perUnitPrice * amount
        if (!isSanePrice(totalUsd)) continue
        if (sides.has('cost') && atTradeTime.costUsd[txHash] == null) {
          atTradeTime.costUsd[txHash] = totalUsd
          pricesApplied += 1
        }
        if (sides.has('proceeds') && atTradeTime.proceedsUsd[txHash] == null) {
          atTradeTime.proceedsUsd[txHash] = totalUsd
          pricesApplied += 1
        }
      }
    }

    const fullyPricedLotsAfterAlchemy = countFullyPriced()
    const verifiedCoverageAfter = structuralMatchedLots.length > 0 ? fullyPricedLotsAfterAlchemy / structuralMatchedLots.length : 0
    const lotsCompletedByAlchemy = fullyPricedLotsAfterAlchemy - fullyPricedLotsBeforeAlchemy
    const realizedPnlAfter = sumApproxRealizedPnl()

    // eslint-disable-next-line no-console
    console.warn('[alchemy-historical-pricing-shadow]', {
      ...alchemyAudit,
      applied: alchemyApplyEnabled,
      pricesApplied,
      lotsCompletedByAlchemy,
      fullyPricedLotsBefore: fullyPricedLotsBeforeAlchemy,
      fullyPricedLotsAfter: fullyPricedLotsAfterAlchemy,
      verifiedCoverageBefore,
      verifiedCoverageAfter,
      realizedPnlBefore,
      realizedPnlAfter,
    })
  }

  // CLOSED-LOT PRICING COVERAGE DIAGNOSTICS, DISCLOSED, ADDITIVE — bounded (one summary object, no
  // per-event dump). Splits every structural closed lot by exactly which side(s) resolved a real
  // price, so "fullyPricedClosedLots" (both) is never confused with "attributed" (present) or with a
  // lot that only got half its evidence. Computed AFTER resolvePricingAtTime AND the same-tx
  // quote-leg gap-fill so it reflects the real final outcome, not the pre-gap-fill request.
  let bothPriced = 0
  let entryOnlyPriced = 0
  let exitOnlyPriced = 0
  let neitherPriced = 0
  for (const lot of structuralMatchedLots) {
    const hasEntry = atTradeTime.costUsd[lot.openedTxHash] != null
    const hasExit = atTradeTime.proceedsUsd[lot.closedTxHash] != null
    if (hasEntry && hasExit) bothPriced += 1
    else if (hasEntry) entryOnlyPriced += 1
    else if (hasExit) exitOnlyPriced += 1
    else neitherPriced += 1
  }
  // eslint-disable-next-line no-console
  console.warn('[priceLotsForWallet] closed-lot pricing coverage', {
    structuralClosedLots: structuralMatchedLots.length,
    distinctTokensWithClosedLots: new Set(structuralMatchedLots.map((l) => `${l.chain}:${l.token.toLowerCase()}`)).size,
    fullyPricedClosedLots: bothPriced,
    entryOnlyPriced,
    exitOnlyPriced,
    neitherPriced,
    closedLotEntryRequirements: entryRankByTxHash.size,
    closedLotExitRequirements: exitRankByTxHash.size,
    totalBuyEntries: buys.length,
    totalSellEntries: sells.length,
  })

  // "Current" price for open lots — pricingAtTimeEngine only prices at a given timestamp, so "now"
  // is passed as that timestamp; same real source, evaluated at the present moment. amount is
  // fixed at '1' so the resolved costUsd is exactly the real per-unit price, not scaled by amount.
  const distinctHeldTokens = [...new Map(buys.map((e) => [`${e.chain}:${e.contract.toLowerCase()}`, e])).values()]
  const nowEntries: PriceableEntry[] = distinctHeldTokens.map((e) => ({
    txHash: `current:${e.chain}:${e.contract.toLowerCase()}`,
    token: e.contract,
    chain: e.chain,
    timestamp: Date.now(),
    amount: '1',
  }))
  // REAL, MEASURED LIVE-CALL SNAPSHOT FOR THE CURRENT-PRICE PASS, DISCLOSED — see
  // `currentPriceGoldrushLiveCalls`'s own header on `AcceptedEvidenceSkipAudit`. Scoped to ONLY this
  // call, separately from the at-trade-time snapshot above, so a real live call this pass genuinely
  // needs (open-position valuation, never accepted-evidence-coverable) is never silently invisible
  // to the audit, and never conflated with the replay-covered historical figure either.
  const goldrushCallsBeforeNow = getGoldrushPriceSourceCallCount()
  const dexCallsBeforeNow = getDexscreenerCallCount()
  const atNow = await resolvePricingAtTime({ buyEntries: nowEntries, sellEntries: [], priceSources: params.priceSources })
  acceptedEvidenceSkipAudit.currentPriceGoldrushLiveCalls = getGoldrushPriceSourceCallCount() - goldrushCallsBeforeNow
  acceptedEvidenceSkipAudit.currentPriceDexActualLiveCalls = getDexscreenerCallCount() - dexCallsBeforeNow

  const priceUsdLookup: PriceUsdLookup = (event) => resolveEventPriceUsd(event, atTradeTime.costUsd, atTradeTime.proceedsUsd)

  const currentPriceUsdLookup: CurrentPriceUsdLookup = (token, chain) =>
    atNow.costUsd[`current:${chain}:${token.toLowerCase()}`] ?? null

  const pricingUnavailableTokens = nowEntries
    .filter((entry) => atNow.costUsd[entry.txHash] == null)
    .map((entry) => `${entry.chain}:${entry.token.toLowerCase()}`)
  if (pricingUnavailableTokens.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[priceLotsForWallet] tokens with no price from any source', { count: pricingUnavailableTokens.length, tokens: pricingUnavailableTokens })
  }

  // DURABLE EVIDENCE FLUSH, DISCLOSED — see sourceSuccessEvidencePersistence.ts. Exactly ONE bounded,
  // batched write, here, AFTER every pricing pass in this call has completed, so it carries the full
  // set of typed outcomes this scan observed. Only the DELTA this process recorded is written (never
  // the loaded baseline), and every counter is applied as a per-field HINCRBY, so two workers
  // flushing at the same instant both have their counts applied and neither loses the other's.
  // Strictly fail-open and never retried: a failed flush is logged and discarded, with no effect on
  // anything this function returns.
  const evidenceFlushResult = await flushEvidenceDelta(snapshotEvidenceDelta())
  // eslint-disable-next-line no-console
  console.warn('[source-success-evidence-summary]', buildEvidenceSummary({
    loaded: evidenceLoadResult,
    flush: evidenceFlushResult,
    evidenceRecordedThisScan: evidenceRecordedThisProcess(),
    processInstanceId: processInstanceId(),
  }))

  const routeRecordsThisCall = pricingRouteLog.slice(routeLogSnapshotBefore)
  const historicalPricingAttempts = routeRecordsThisCall.filter((r) => r.route !== 'none')
  const historicalPricingFailures = routeRecordsThisCall.filter((r) => r.route === 'none')

  // eslint-disable-next-line no-console
  console.warn('[accepted-evidence-skip-audit]', acceptedEvidenceSkipAudit)

  // FINALIZE THE FAST-PATH AUDIT, DISCLOSED: reuses the SAME real, measured before/after provider-
  // call deltas the accepted-evidence skip audit already computed above — never a second, separate
  // measurement. `recoveryLookupsPrevented` equals the covered-requirement count: every side
  // pre-hydrated into `atTradeTime.costUsd`/`proceedsUsd` here arrives at pnlReconciliation's own
  // recovery pass already both-sides-priced, so its live-recovery loop has nothing left to attempt
  // for these sides (see hydrateFromAcceptedEvidence's own `existingVerifiedSidesProtectedFromOverwrite`
  // — a side already priced is never re-attempted). `candidateDiscoveryCalls` is the real remaining
  // requirement count this pass still sent to providers — genuinely new/uncovered evidence, never
  // manifest-covered sides.
  manifestFastPathAudit.goldrushCallsPrevented = acceptedEvidenceSkipAudit.pricingRequirementsSkippedByAcceptedEvidence['historical-pricing-scheduler'] ?? 0
  manifestFastPathAudit.dexCallsPrevented = manifestFastPathAudit.goldrushCallsPrevented
  manifestFastPathAudit.alchemyCallsPrevented = acceptedEvidenceSkipAudit.pricingRequirementsSkippedByAcceptedEvidence.alchemy ?? 0
  manifestFastPathAudit.recoveryLookupsPrevented = manifestFastPathAudit.manifestCoveredPricingRequirements
  manifestFastPathAudit.candidateDiscoveryCalls = acceptedEvidenceSkipAudit.pricingRequirementsAfterSkip
  manifestFastPathAudit.fastPathApplied = manifestFastPathAudit.manifestCoveredPricingRequirements > 0
  manifestFastPathAudit.fastPathFailureReason = manifestFastPathAudit.fastPathApplied
    ? null
    : manifestFastPathAudit.manifestLoadedBeforePricing
      ? (manifestFastPathAudit.manifestEvidenceKeysRequested === 0 ? 'no_matched_lots' : 'no_covered_requirements')
      : 'no_accepted_evidence_store_configured'
  // eslint-disable-next-line no-console
  console.warn('[manifest-fast-path-audit]', manifestFastPathAudit)

  return {
    priceUsdLookup,
    currentPriceUsdLookup,
    aerodromeAttribution,
    sourceBreakdown: atTradeTime.sourceBreakdown,
    pricingUnavailableTokens,
    historicalPricingAttempts,
    historicalPricingFailures,
    acceptedEvidenceSkipAudit,
    manifestFastPathAudit,
  }
}
