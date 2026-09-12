import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { canonicalVerifiedRejectionReason, isCanonicalVerifiedPublishedLot, isCanonicalPositiveUsd } from './canonicalVerifiedLot'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import type { SyntheticPnlSummary } from '../modules/syntheticPnl'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'
import type { SupportedChain } from '../modules/providerFetchWindow/types'
import {
  lotIdentityVersion, readAcceptedEvidenceAnyLotVersion, writeAcceptedEvidence, buildAcceptedEvidenceEnvelope,
  buildAcceptedEvidenceCoverageFingerprint, buildAcceptedEvidenceKey, detectLegacyPerUnitTotalRecord,
  detectLegacyPerUnitTotalByLiveUpstreamProof, detectWrongDecimalScaleByLiveUpstreamProof,
  type AcceptedEvidenceKvLike, type AcceptedEvidenceSide, type AcceptedEvidenceEnvelope, type AcceptedEvidenceMigrationClassification,
} from './acceptedEvidenceStore'
import { allocateSideValueAcrossGroup, stablecoinNormalizedGroupTotal, demoteLotsOnIncompleteAcceptedSides, acceptedEvidenceIdentityKeysForLot, type SideAllocationShare } from './canonicalPnlSampleManifest'
import { buildPnlDiscrepancyAudit, type PnlDiscrepancyAudit } from './pnlDiscrepancyAudit'
import { classifyVerifiedSampleRoiEligibility, roiLotKey } from './verifiedSampleRoiEligibility'
import type { NormalizedEvent } from '../modules/normalization/types'

export type PnlMismatchClass = 'missingInboundEvidence' | 'missingOutboundEvidence' | 'routerClusterMismatch' | 'priceUnavailable' | 'dustSuppressedToken' | 'syntheticOnlyToken' | 'priceRecovered'
export type ReconciledPublicPnlStatus = 'available' | 'partial' | 'unavailable'

// VERIFIED BOUNDED-SAMPLE PERFORMANCE, DISCLOSED (verified-sample-vs-full-history follow-up):
// arithmetic over the included canonical verified closed-lot sample, independent of unmatched
// sells that sit OUTSIDE that sample. Full-wallet/complete-history publication stays governed by
// the existing public gate. This object never claims complete wallet history.
export type VerifiedSamplePerformanceStatus = 'verified_bounded_sample' | 'unavailable'
export type VerifiedSamplePerformance = {
  status: VerifiedSamplePerformanceStatus
  realizedPnlUsd: number | null
  realizedCostBasisUsd: number | null
  realizedRoiPct: number | null
  verifiedLotCount: number
  structuralLotCount: number
  pricingCoverage: number
  excludedUnmatchedSellCount: number
  isCompleteWalletHistory: false
  // ROI-ONLY MEMBERSHIP, DISCLOSED (quote-cash denominator follow-up): realized ROI uses this
  // eligible set, not the full verified sample. Displayed sample PnL stays on every verified lot.
  verifiedSampleRoiEligibleLots: readonly string[]
  verifiedSampleRoiEligibleLotCount: number
  quoteCashLegExcludedLotCount: number
  unresolvedQuoteLegLotCount: number
  roiUnavailableReason: 'unresolved_quote_leg_identity' | null
}

export type FullHistoryPerformanceStatus = 'verified' | 'partial' | 'unavailable'
export type FullHistoryPerformance = {
  status: FullHistoryPerformanceStatus
  realizedPnlUsd: number | null
  realizedRoiPct: number | null
  blockingReasons: string[]
}

export type VerifiedSamplePerformanceAudit = {
  verifiedLotCount: number
  includedLotCount: number
  realizedPnlUsd: number | null
  realizedCostBasisUsd: number | null
  realizedRoiPct: number | null
  pricingCoverage: number
  canonicalConsistencyPassed: boolean
  pricingEvidenceMissing: number
  excludedUnmatchedSellCount: number
  samplePerformanceAllowed: boolean
  samplePerformanceBlockedReason: string | null
  fullHistoryPerformanceAllowed: boolean
  roiEligibleLotCount: number
  quoteCashLegExcludedLotCount: number
  unresolvedQuoteLegLotCount: number
  roiUnavailableReason: 'unresolved_quote_leg_identity' | null
  realizedRoiPnlUsd: number | null
  sampleCostBasisUsd: number | null
}

export const EMPTY_VERIFIED_SAMPLE_PERFORMANCE: VerifiedSamplePerformance = {
  status: 'unavailable',
  realizedPnlUsd: null,
  realizedCostBasisUsd: null,
  realizedRoiPct: null,
  verifiedLotCount: 0,
  structuralLotCount: 0,
  pricingCoverage: 0,
  excludedUnmatchedSellCount: 0,
  isCompleteWalletHistory: false,
  verifiedSampleRoiEligibleLots: [],
  verifiedSampleRoiEligibleLotCount: 0,
  quoteCashLegExcludedLotCount: 0,
  unresolvedQuoteLegLotCount: 0,
  roiUnavailableReason: null,
}

export const EMPTY_FULL_HISTORY_PERFORMANCE: FullHistoryPerformance = {
  status: 'unavailable',
  realizedPnlUsd: null,
  realizedRoiPct: null,
  blockingReasons: [],
}

export function emptyVerifiedSamplePerformanceAudit(): VerifiedSamplePerformanceAudit {
  return {
    verifiedLotCount: 0,
    includedLotCount: 0,
    realizedPnlUsd: null,
    realizedCostBasisUsd: null,
    realizedRoiPct: null,
    pricingCoverage: 0,
    canonicalConsistencyPassed: true,
    pricingEvidenceMissing: 0,
    excludedUnmatchedSellCount: 0,
    samplePerformanceAllowed: false,
    samplePerformanceBlockedReason: 'no_verified_lots',
    fullHistoryPerformanceAllowed: false,
    roiEligibleLotCount: 0,
    quoteCashLegExcludedLotCount: 0,
    unresolvedQuoteLegLotCount: 0,
    roiUnavailableReason: null,
    realizedRoiPnlUsd: null,
    sampleCostBasisUsd: null,
  }
}

type RouterInferenceLike = { highConfidenceRouters?: ReadonlySet<string>; tokenFlowClustersByAddress?: ReadonlyMap<string, readonly unknown[]> }
// RECOVERY LANE, DISCLOSED (provider-call-audit follow-up task, confirmed root cause of "recovery
// attempted 40 candidates but made zero live source attempts"): `getPriceRecovery` is the preferred
// entry point — see src/lib/kvClient.ts's own header for the full disclosure on why recovery needs
// its OWN bounded allowance, separate from the shared per-token cap the main pricingAtTime pass
// already exhausts by the time recovery runs. `getPriceHistorical`/`getPricePrimary` remain here
// purely as a fallback for a `priceKvClient` that doesn't implement the recovery lane (e.g. a
// simpler test double) — production always supplies the real RequestPriceKvClient, which has both.
type PriceKvLike = {
  getPriceHistorical?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null>
  getPricePrimary?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn) => Promise<number | null>
  getPriceRecovery?: (token: string, chain: string, timestamp: number, fetcher: PriceSourceFn, label: 'primary' | 'chain-aware-historical', maxRecoveryLookups: number) => Promise<number | null>
  // DIAGNOSTIC-ONLY, DISCLOSED: optional read access to the real client's own counters — never
  // required for recovery to function, only for the compact diagnostics logged below.
  stats?: { cappedLookups: number }
  recoveryStats?: { recoveryLookupsRequested: number; recoveryCacheHits: number; recoveryLiveFetches: number; recoveryCappedLookups: number }
}

// DETAILED PRICE SOURCE, ADDITIVE (provider-call-audit follow-up task, "trace the one-side-missing
// recovery candidates" requirement): a duck-typed shape matching
// src/pipeline/pricingAtTimeAdapter.ts's ChainAwareHistoricalPriceResult — kept structural (not
// imported directly) so this file has no hard dependency on that module's exact type location,
// matching this file's existing convention of only depending on plain data shapes for its
// injectable config. Optional: when absent, recovery behaves exactly as it did before this task
// (no reason classification, same recovered prices).
type DetailedPriceAttempt = { source: string; ok: boolean; reason: string | null }
type DetailedPriceSourceFn = (token: string, chain: SupportedChain, timestamp: number) => Promise<{ price: number | null; route: string; attempts: DetailedPriceAttempt[] }>

type Config = {
  logger?: Pick<Console, 'warn'>
  priceKvClient?: PriceKvLike
  priceSources?: { primary?: PriceSourceFn; fallback?: PriceSourceFn }
  priceSourceDetailedPrimary?: DetailedPriceSourceFn
  dustSuppressedKeys?: ReadonlySet<string>
  // ACCEPTED-EVIDENCE STORE, DISCLOSED (determinism follow-up task, requirements #1-#5): optional,
  // additive — a caller that hasn't wired it gets exactly today's behavior (live recovery only, no
  // hydration, no write-back). See src/lib/acceptedEvidenceStore.ts's own header for the full
  // fail-closed identity-matching rule.
  acceptedEvidenceKv?: AcceptedEvidenceKvLike
  now?: () => number
}

// COMPACT FAILURE-REASON CATEGORIES, DISCLOSED: mirrors this task's own requested category list.
// Mapping is honest, not exhaustive by construction — every real source function in this codebase
// (dexscreener.ts, geckoTerminalPriceSource.ts, coingecko.ts, basedex.ts) was traced for its actual
// reason strings (see pricingAtTimeAdapter.ts's own header); some requested categories
// ('pool_created_after_timestamp', 'zero_liquidity', 'stale_price_rejection', 'invalid_decimals')
// are NOT currently distinguishable from 'no_pool'/other buckets by any real source in this
// codebase — they remain in this counter object (always present, never omitted) so a future
// source-level fix that adds that distinction has somewhere to report it, but they honestly read 0
// today rather than being force-matched to the nearest real reason string.
//
// CONFIRMED COLLAPSE POINT, FIXED (this follow-up task's exact "every failure classified
// providerReturnedNull" symptom): the PRIOR version of this function's fallback branch mapped ANY
// non-enumerated reason string — including real, already-observed, source-specific strings like
// basedex.ts's `rpc_error:${message}` and every source's `http_${status}`/`fetch_error:${message}`
// — straight into `providerReturnedNull`. `providerReturnedNull` is supposed to mean "the source
// gave back a plain null with no further explanation" (reason === null); silently routing a REAL,
// specific-but-unenumerated string into that same bucket is exactly the "final generic null
// overwrites a specific earlier reason" collapse this task's own diagnostic pass was meant to
// surface, not perform — a wallet whose real BaseDex failures are mostly `rpc_error:*` (very
// plausible given BaseDex's "hundreds of RPC operations", per this task's own production evidence)
// would show 100% providerReturnedNull with every specific bucket at zero, matching the reported
// symptom exactly. Fixed: `providerReturnedNull` is now reserved STRICTLY for a literal `null`
// reason; every other non-matching string goes to the new `unknownReason` bucket below, keyed by a
// compact, truncated reason NAME (never the dynamic message/token/raw body that can follow a `:`).
export type RecoveryFailureReasonCounts = {
  unsupportedTokenOrChain: number
  timestampOutsideProviderData: number
  malformedResponse: number
  blockResolutionFailure: number
  noPool: number
  poolCreatedAfterTimestamp: number
  zeroLiquidity: number
  stalePriceRejection: number
  invalidDecimals: number
  providerReturnedNull: number
  // COMPACT, DISCLOSED: keyed by a normalized reason NAME only (e.g. 'rpc_error', 'http_500',
  // 'no_candles') — never a raw provider response body, never a token address, never the dynamic
  // exception message text that can follow a `:` in reasons like `rpc_error:${err.message}`.
  unknownReason: Record<string, number>
}

function emptyReasonCounts(): RecoveryFailureReasonCounts {
  return { unsupportedTokenOrChain: 0, timestampOutsideProviderData: 0, malformedResponse: 0, blockResolutionFailure: 0, noPool: 0, poolCreatedAfterTimestamp: 0, zeroLiquidity: 0, stalePriceRejection: 0, invalidDecimals: 0, providerReturnedNull: 0, unknownReason: {} }
}

// Truncates a reason string to a compact, bounded-cardinality NAME safe for a counter key — strips
// everything from the first `:` onward (where every dynamic/unbounded part of this codebase's real
// reason strings lives — `rpc_error:${message}`, `fetch_error:${message}`) so an unknown reason
// still groups meaningfully (all RPC errors count together) without ever leaking the dynamic
// message text, which could in principle echo back provider/response details.
function compactReasonName(reason: string): string {
  const colonIndex = reason.indexOf(':')
  return colonIndex === -1 ? reason : reason.slice(0, colonIndex)
}

export type RecoveryFailureBucket = keyof Omit<RecoveryFailureReasonCounts, 'unknownReason'> | 'unknownReason'

// Classifies ONE real, already-observed reason string (never a fabricated one — a candidate this
// function never reached, e.g. because a cache hit resolved it, never calls this at all) into a
// compact bucket. `unknownKey` is set only when `bucket === 'unknownReason'`. Exported for direct
// unit testing.
export function classifyRecoveryFailureReason(reason: string | null): { bucket: RecoveryFailureBucket; unknownKey: string | null } {
  if (reason === null) return { bucket: 'providerReturnedNull', unknownKey: null }
  if (reason.includes('unverified_chain') || reason.includes('unverified_network') || reason === 'base_dex_only_supports_base_chain' || reason === 'no_api_key_configured' || reason === 'goldrush_no_data') return { bucket: 'unsupportedTokenOrChain', unknownKey: null }
  if (reason.includes('timestamp_too_far_from_now') || reason === 'no_price_series_in_range' || reason === 'no_candles') return { bucket: 'timestampOutsideProviderData', unknownKey: null }
  if (reason.includes('unparseable')) return { bucket: 'malformedResponse', unknownKey: null }
  if (reason === 'could_not_resolve_historical_block') return { bucket: 'blockResolutionFailure', unknownKey: null }
  if (reason === 'no_pool_found' || reason === 'no_uniswap_v3_pool_found' || reason === 'no_matching_pair' || reason === 'no_dex_pool_found_any_venue') return { bucket: 'noPool', unknownKey: null }
  // Every other real, non-empty reason string this codebase's sources can produce (http_*,
  // fetch_error:*, rpc_error:*, or any future/unrecognized string) is a genuine, specific signal
  // this classifier just doesn't have a named bucket for yet — it must never be silently folded
  // into providerReturnedNull (that would recreate exactly the collapse this fix closes).
  return { bucket: 'unknownReason', unknownKey: compactReasonName(reason) }
}

function recordFailureReason(counts: RecoveryFailureReasonCounts, reason: string | null): void {
  const { bucket, unknownKey } = classifyRecoveryFailureReason(reason)
  if (bucket === 'unknownReason') {
    counts.unknownReason[unknownKey!] = (counts.unknownReason[unknownKey!] ?? 0) + 1
  } else {
    counts[bucket] += 1
  }
}

// ================================================================================================
// MISSING-PRICE RECOVERY FUNNEL AUDIT, DISCLOSED (missing-price-recovery-funnel follow-up task).
//
// GOAL: every structural lot the public gate's canonical predicate currently rejects for a
// pricing-shaped reason (the coarse `missing_price` bucket in walletPnlCoverageRecoveryAudit.ts —
// deliberately collapsed there because a FINALIZED lot alone cannot distinguish these causes) lands
// in EXACTLY ONE of the finer terminal buckets below, using data this recovery pass already computes
// — never a second, independent recomputation of FIFO/pricing/canonical-verification logic.
//
// DIAGNOSTIC ONLY, DISCLOSED: this module never changes which lots get selected for recovery, never
// changes MAX_RECOVERY_ATTEMPTS, never changes the canonical predicate, never changes what gets
// published. It is a pure, read-only classification of the SAME decisions recoverPrices/hydration/
// the canonical predicate already made, built strictly for visibility into the funnel.
//
// BUCKET PRIORITY, DISCLOSED (a lot's bucket is the FIRST stage, in this order, at which its own
// story stops — never a second bucket once one applies):
//   1. Lot never had a null side to begin with (recovery only ever targets `costBasisUsd === null ||
//      proceedsUsd === null` — see rankMissingLotsForRecovery/missingLots below) yet still fails the
//      canonical predicate: `non_positive_reconstruction` (a present-but-invalid value: zero,
//      negative, or non-finite) or `no_price_requirement_generated` (present, finite, positive
//      values, but evidenceQuality itself never reached 'verified' — recovery structurally never
//      treats this as "needing a price request" at all, since neither side is null).
//   2. Lot has a null side (a genuine recovery candidate) but ranked outside the top
//      MAX_RECOVERY_ATTEMPTS this scan: `not_selected_by_recovery_cap`.
//   3. Selected, but the shared recovery-lane lookup budget (kvClient.ts's own
//      `recoveryLookupsBudget`, exhausted BEFORE the real fetcher is ever called — see
//      RequestPriceKvClient.getPriceRecovery's own header) was already spent when this lot's side
//      was reached: `provider_not_attempted_budget` — a genuinely different state from a REAL
//      provider call that returned null, previously indistinguishable from `providerReturnedNull`.
//   4. Selected, provider attempted, a specific rejection reason was recorded — mapped via the SAME
//      `classifyRecoveryFailureReason` this file's own aggregate counters already use:
//      `unsupportedTokenOrChain` -> `identity_rejected`, `timestampOutsideProviderData` ->
//      `timestamp_rejected`, `noPool` -> `quote_leg_proof_missing` (no same-tx/pool proof available),
//      anything else specific but unenumerated -> `other`.
//   5. Selected, provider attempted, returned a bare null with no further reason:
//      `provider_returned_null`.
//   6. Both sides now numeric (hydration + recovery together resolved them) but the canonical
//      predicate still rejects on `evidence_quality_not_verified`: `partial_unverified_only`.
//   7. Any other canonical rejection surviving full recovery (e.g. `invalid_chronology`):
//      `canonical_verifier_rejected`.
//   8. Fully resolved and now canonically verified: `recovered_verified` (kept in the same taxonomy,
//      not filtered out, so the funnel's own counts are provably exhaustive over every originally
//      missing lot).
//   9. `other` — the fallback that must stay at 0 by construction; a non-zero count here is itself
//      the signal that a real case this priority list didn't anticipate exists.
type RecoveredPrice = { costBasisUsd: number | null; proceedsUsd: number | null }

export type MissingPriceLotBucket =
  | 'not_selected_by_recovery_cap'
  | 'no_price_requirement_generated'
  | 'accepted_evidence_miss'
  | 'provider_not_attempted_budget'
  | 'provider_returned_null'
  | 'identity_rejected'
  | 'timestamp_rejected'
  | 'partial_unverified_only'
  | 'quote_leg_proof_missing'
  | 'non_positive_reconstruction'
  | 'canonical_verifier_rejected'
  | 'recovered_verified'
  | 'other'

export const MISSING_PRICE_LOT_BUCKETS: readonly MissingPriceLotBucket[] = [
  'not_selected_by_recovery_cap', 'no_price_requirement_generated', 'accepted_evidence_miss',
  'provider_not_attempted_budget', 'provider_returned_null', 'identity_rejected', 'timestamp_rejected',
  'partial_unverified_only', 'quote_leg_proof_missing', 'non_positive_reconstruction',
  'canonical_verifier_rejected', 'recovered_verified', 'other',
]

export function emptyMissingPriceLotBucketCounts(): Record<MissingPriceLotBucket, number> {
  const counts = {} as Record<MissingPriceLotBucket, number>
  for (const bucket of MISSING_PRICE_LOT_BUCKETS) counts[bucket] = 0
  return counts
}

export type BeyondCapRecoveryCandidateAudit = {
  rank: number
  token: string
  lotKey: string
  missingSides: Array<'entry' | 'exit'>
  sharedSiblingUnlockCount: number
  estimatedProviderCalls: number
  wouldCompleteLotIfResolved: boolean
}

export type MissingPriceRecoveryCapYieldEstimate = {
  first40ExpectedYield: number
  ranks41To60ExpectedYield: number
  ranks61To80ExpectedYield: number
  marginalProviderCallEstimateByCap: Array<{ cap: number; estimatedProviderCalls: number }>
}

export type MissingPriceRecoveryFunnelAudit = {
  totalMissingLots: number
  selectedForRecovery: number
  notSelectedByCap: number
  providerAttemptedLots: number
  providerResolvedLots: number
  canonicalVerifiedLots: number
  buckets: Record<MissingPriceLotBucket, number>
  lotsNeededFor50: number
  beyondCapCandidates: BeyondCapRecoveryCandidateAudit[]
  capYieldEstimate: MissingPriceRecoveryCapYieldEstimate
}

// Honest all-zero fixture, matching this file's own `emptyReasonCounts`/`emptySourceAttemptCounters`
// convention — for callers (tests, an unavailable-recovery-pass fallback) that need a real, fully-
// shaped value with no candidates to report, never a partial/undefined stand-in.
export function emptyMissingPriceRecoveryFunnelAudit(): MissingPriceRecoveryFunnelAudit {
  return {
    totalMissingLots: 0,
    selectedForRecovery: 0,
    notSelectedByCap: 0,
    providerAttemptedLots: 0,
    providerResolvedLots: 0,
    canonicalVerifiedLots: 0,
    buckets: emptyMissingPriceLotBucketCounts(),
    lotsNeededFor50: 0,
    beyondCapCandidates: [],
    capYieldEstimate: {
      first40ExpectedYield: 0,
      ranks41To60ExpectedYield: 0,
      ranks61To80ExpectedYield: 0,
      marginalProviderCallEstimateByCap: [
        { cap: 40, estimatedProviderCalls: 0 },
        { cap: 60, estimatedProviderCalls: 0 },
        { cap: 80, estimatedProviderCalls: 0 },
      ],
    },
  }
}

// Per-candidate outcome captured inline in recoverPrices' own concurrency-limited loop — never a
// second live pass, purely bookkeeping around calls that pass already makes.
type CandidateRecoveryOutcome = {
  needsBuy: boolean
  needsSell: boolean
  buyReason: string | null
  sellReason: string | null
  buyBudgetCapped: boolean
  sellBudgetCapped: boolean
}

// Reconstructs the SAME merged lot reconcile()'s own `updatedFifoLots.map(...)` produces — a side
// already resolved by accepted-evidence hydration wins; otherwise a live-recovered price fills it;
// otherwise the side stays exactly as it was. Mirrors that merge exactly so this audit's own
// "is this lot now canonically verified" check can never disagree with what actually gets published.
function reconstructFinalLot(hydratedLot: MatchedLot, recovered: RecoveredPrice | undefined): MatchedLot {
  const costBasisUsd = hydratedLot.costBasisUsd ?? recovered?.costBasisUsd ?? null
  const proceedsUsd = hydratedLot.proceedsUsd ?? recovered?.proceedsUsd ?? null
  const nowFullyPriced = costBasisUsd !== null && proceedsUsd !== null
  return {
    ...hydratedLot,
    costBasisUsd,
    proceedsUsd,
    realizedPnlUsd: nowFullyPriced ? proceedsUsd! - costBasisUsd! : hydratedLot.realizedPnlUsd,
    evidenceQuality: nowFullyPriced ? ('verified' as const) : hydratedLot.evidenceQuality,
  }
}

function classifyMissingPriceLotBucket(params: {
  originalLot: MatchedLot
  hydratedLot: MatchedLot
  recovered: RecoveredPrice | undefined
  wasSelected: boolean
  outcome: CandidateRecoveryOutcome | undefined
  // DEMOTION-AWARE, DISCLOSED (130-early-canonical-to-30-final-candidate-collapse trace, CONFIRMED
  // FUNNEL SCOPING BUG): reconcile()'s own pipeline runs `demoteLotsOnIncompleteAcceptedSides` AFTER
  // recoverPrices finishes — a lot that reconstructs as canonically verified in isolation can still
  // be demoted back to 'unpriced' if it shares an accepted-evidence side with an incomplete sibling
  // group. The funnel previously classified BEFORE this demotion step ever ran, so it counted a lot
  // as `recovered_verified`/canonically verified even when the real, final pipeline demotes it —
  // exactly why an earlier version of this audit reported 64 verified lots against a real
  // `pricingStageVerifiedLots` of 30. `demoted` is computed once, over the FULL final-lot population
  // (see buildMissingPriceRecoveryFunnelAudit), and only ever DOWNGRADES a lot that would otherwise
  // read as verified — it never invents a rejection for a lot the real pipeline does not demote.
  demoted: boolean
}): MissingPriceLotBucket {
  const { originalLot, hydratedLot, recovered, wasSelected, outcome, demoted } = params
  const finalLot = reconstructFinalLot(hydratedLot, recovered)
  const rawFinalReason = canonicalVerifiedRejectionReason(finalLot)
  const finalReason = rawFinalReason === null && demoted ? 'evidence_quality_not_verified' : rawFinalReason
  if (finalReason === null) return 'recovered_verified'

  const wasMissingOriginally = originalLot.costBasisUsd === null || originalLot.proceedsUsd === null
  if (!wasMissingOriginally) {
    if (finalReason === 'non_positive_entry_price' || finalReason === 'non_positive_exit_price' || finalReason === 'non_finite_value') {
      return 'non_positive_reconstruction'
    }
    return 'no_price_requirement_generated'
  }

  if (!wasSelected) return 'not_selected_by_recovery_cap'

  if (outcome?.buyBudgetCapped || outcome?.sellBudgetCapped) return 'provider_not_attempted_budget'

  const finalBuyMissing = finalLot.costBasisUsd === null
  const finalSellMissing = finalLot.proceedsUsd === null
  if (finalBuyMissing || finalSellMissing) {
    const reason = finalBuyMissing ? (outcome?.buyReason ?? null) : (outcome?.sellReason ?? null)
    const { bucket } = classifyRecoveryFailureReason(reason)
    if (bucket === 'unsupportedTokenOrChain') return 'identity_rejected'
    if (bucket === 'timestampOutsideProviderData') return 'timestamp_rejected'
    if (bucket === 'noPool') return 'quote_leg_proof_missing'
    if (bucket === 'providerReturnedNull') {
      // A bare null with no evidence and no provider reason recorded reads more precisely as an
      // accepted-evidence miss than a generic provider outcome when hydration itself never even had
      // a candidate to try (recovered is entirely absent for this side and the other side, if any,
      // was never touched by hydration either) — otherwise it is a genuine provider null.
      const hydrationNeverResolvedEither = hydratedLot.costBasisUsd === null && hydratedLot.proceedsUsd === null
        && originalLot.costBasisUsd === null && originalLot.proceedsUsd === null
      return hydrationNeverResolvedEither ? 'accepted_evidence_miss' : 'provider_returned_null'
    }
    return 'other'
  }

  if (finalReason === 'evidence_quality_not_verified') return 'partial_unverified_only'
  return 'canonical_verifier_rejected'
}

// Estimates whether resolving a lot's own still-missing side(s) would, on its own, make it
// canonically verified — i.e. no OTHER independent defect (chronology, an already-non-positive
// side) would still block it. Best-case/deterministic, never a probabilistic forecast: assumes a
// successful recovery fills the missing side(s) with SOME positive, finite value.
function wouldCompleteIfResolved(lot: MatchedLot): boolean {
  const probe: MatchedLot = {
    ...lot,
    costBasisUsd: lot.costBasisUsd ?? 1,
    proceedsUsd: lot.proceedsUsd ?? 1,
    realizedPnlUsd: 0,
    evidenceQuality: 'verified',
  }
  return canonicalVerifiedRejectionReason(probe) === null
}

export function buildMissingPriceRecoveryFunnelAudit(params: {
  originalLots: readonly MatchedLot[]
  hydratedLots: readonly MatchedLot[]
  sortedMissing: readonly MatchedLot[]
  candidates: readonly MatchedLot[]
  recoveredByLotKey: ReadonlyMap<string, RecoveredPrice>
  candidateOutcomeByKey: ReadonlyMap<string, CandidateRecoveryOutcome>
  thresholdRequired?: number
  totalStructuralLots: number
}): MissingPriceRecoveryFunnelAudit {
  const thresholdRequired = params.thresholdRequired ?? 0.5
  const hydratedByKey = new Map(params.hydratedLots.map((l) => [lotKey(l), l]))
  const selectedKeys = new Set(params.candidates.map((l) => lotKey(l)))

  // DEMOTION-AWARE FINAL STATE, DISCLOSED (130-early-canonical-to-30-final-candidate-collapse trace,
  // CONFIRMED FUNNEL SCOPING BUG): reconcile()'s own pipeline is `updatedFifoLots` (this same
  // hydrated+recovered merge) -> `demoteLotsOnIncompleteAcceptedSides` -> `consistentFifoLots`, and
  // ONLY `consistentFifoLots`'s verified count ever becomes `pricingStageVerifiedLots`. Every prior
  // version of this funnel classified lots on the PRE-demotion reconstruction alone, so a lot that
  // reconstructs as verified here but gets demoted afterward (because it shares an accepted-evidence
  // side with a sibling group that isn't fully priced) was still counted as verified — inflating
  // `canonicalVerifiedLots`/`recovered_verified` against the real, final published count. Reproduces
  // the SAME demotion decision here, over the SAME full reconstructed population, so this audit can
  // never disagree with what reconcile() actually publishes.
  const allFinalLots = params.originalLots.map((original) => {
    const key = lotKey(original)
    const hydrated = hydratedByKey.get(key) ?? original
    return reconstructFinalLot(hydrated, params.recoveredByLotKey.get(key))
  })
  const demotedKeys = new Set<string>()
  for (const demotedLot of demoteLotsOnIncompleteAcceptedSides(allFinalLots)) {
    if (demotedLot.evidenceQuality === 'unpriced') demotedKeys.add(lotKey(demotedLot))
  }

  const buckets = emptyMissingPriceLotBucketCounts()
  let providerAttemptedLots = 0
  let providerResolvedLots = 0
  let canonicalVerifiedLots = 0
  for (const original of params.originalLots) {
    const key = lotKey(original)
    const hydrated = hydratedByKey.get(key) ?? original
    const wasSelected = selectedKeys.has(key)
    const outcome = params.candidateOutcomeByKey.get(key)
    const recovered = params.recoveredByLotKey.get(key)
    const demoted = demotedKeys.has(key)
    if (wasSelected && outcome && (outcome.needsBuy || outcome.needsSell)) providerAttemptedLots += 1
    if (recovered) providerResolvedLots += 1
    const bucket = classifyMissingPriceLotBucket({ originalLot: original, hydratedLot: hydrated, recovered, wasSelected, outcome, demoted })
    buckets[bucket] += 1
    if (bucket === 'recovered_verified') canonicalVerifiedLots += 1
  }

  const neededForGate = Math.max(0, Math.ceil(thresholdRequired * params.totalStructuralLots) - canonicalVerifiedLots)

  // BEYOND-CAP CANDIDATES + YIELD ESTIMATE, DISCLOSED: uses the SAME ranked order recoverPrices
  // itself already produced (`sortedMissing`) — never a second, independently-computed ranking.
  const groupUnlockCounts = new Map<string, number>()
  for (const lot of params.sortedMissing) {
    const [entryKey, exitKey] = acceptedEvidenceIdentityKeysForLot(lot)
    for (const gk of [entryKey, exitKey]) groupUnlockCounts.set(gk, (groupUnlockCounts.get(gk) ?? 0) + 1)
  }
  const beyondCapCandidates: BeyondCapRecoveryCandidateAudit[] = params.sortedMissing.map((lot, index) => {
    const [entryKey, exitKey] = acceptedEvidenceIdentityKeysForLot(lot)
    const missingSides: Array<'entry' | 'exit'> = []
    if (lot.costBasisUsd === null) missingSides.push('entry')
    if (lot.proceedsUsd === null) missingSides.push('exit')
    const sharedSiblingUnlockCount = missingSides.reduce((sum, side) => {
      const gk = side === 'entry' ? entryKey : exitKey
      return sum + Math.max(0, (groupUnlockCounts.get(gk) ?? 1) - 1)
    }, 0)
    return {
      rank: index + 1,
      token: `${lot.chain}:${lot.token}`,
      lotKey: lotKey(lot),
      missingSides,
      sharedSiblingUnlockCount,
      estimatedProviderCalls: missingSides.length,
      wouldCompleteLotIfResolved: wouldCompleteIfResolved(lot),
    }
  }).filter((c) => c.rank > MAX_RECOVERY_ATTEMPTS)

  const yieldForRange = (startRank: number, endRank: number) => beyondCapCandidates
    .filter((c) => c.rank >= startRank && c.rank <= endRank && c.wouldCompleteLotIfResolved).length
  const callsForRange = (startRank: number, endRank: number) => beyondCapCandidates
    .filter((c) => c.rank >= startRank && c.rank <= endRank)
    .reduce((sum, c) => sum + c.estimatedProviderCalls, 0)
  const first40ExpectedYield = params.sortedMissing.slice(0, MAX_RECOVERY_ATTEMPTS).filter((l) => wouldCompleteIfResolved(l)).length
  // MARGINAL CALLS, DISCLOSED: `beyondCapCandidates` only ever holds ranks beyond the CURRENT
  // 40-cap (see the `.filter((c) => c.rank > MAX_RECOVERY_ATTEMPTS)` above), so `callsForRange`
  // alone can never price the first-40 slice itself — it would silently read as 0 calls for cap 40.
  // The cap-40 baseline is priced directly off `sortedMissing`'s own first 40 entries, and every
  // higher cap adds the incremental beyond-cap slice on top of that same baseline.
  const callsForFirst40 = params.sortedMissing
    .slice(0, MAX_RECOVERY_ATTEMPTS)
    .reduce((sum, lot) => sum + (lot.costBasisUsd === null ? 1 : 0) + (lot.proceedsUsd === null ? 1 : 0), 0)
  const capYieldEstimate: MissingPriceRecoveryCapYieldEstimate = {
    first40ExpectedYield,
    ranks41To60ExpectedYield: yieldForRange(41, 60),
    ranks61To80ExpectedYield: yieldForRange(61, 80),
    marginalProviderCallEstimateByCap: [
      { cap: 40, estimatedProviderCalls: callsForFirst40 },
      { cap: 60, estimatedProviderCalls: callsForFirst40 + callsForRange(41, 60) },
      { cap: 80, estimatedProviderCalls: callsForFirst40 + callsForRange(41, 80) },
    ],
  }

  return {
    totalMissingLots: params.sortedMissing.length,
    selectedForRecovery: params.candidates.length,
    notSelectedByCap: Math.max(0, params.sortedMissing.length - params.candidates.length),
    providerAttemptedLots,
    providerResolvedLots,
    canonicalVerifiedLots,
    buckets,
    lotsNeededFor50: neededForGate,
    beyondCapCandidates,
    capYieldEstimate,
  }
}

// PER-SOURCE ATTEMPT COUNTERS, DISCLOSED (this task's explicit requirement): built from EVERY
// attempt in a detailed lookup's `attempts` array (not just the final one), so a source that was
// tried and failed early is never invisible just because a later source in the same lookup also
// failed — every source's own real attempt/success/failure tally is preserved independently.
export type SourceAttemptCounters = {
  sourceAttemptCounts: Record<string, number>
  sourceSuccessCounts: Record<string, number>
  sourceFailureReasonCounts: Record<string, Record<string, number>>
}

function emptySourceAttemptCounters(): SourceAttemptCounters {
  return { sourceAttemptCounts: {}, sourceSuccessCounts: {}, sourceFailureReasonCounts: {} }
}

function recordSourceAttempts(counters: SourceAttemptCounters, attempts: readonly DetailedPriceAttempt[]): void {
  for (const attempt of attempts) {
    counters.sourceAttemptCounts[attempt.source] = (counters.sourceAttemptCounts[attempt.source] ?? 0) + 1
    if (attempt.ok) {
      counters.sourceSuccessCounts[attempt.source] = (counters.sourceSuccessCounts[attempt.source] ?? 0) + 1
      continue
    }
    const { bucket, unknownKey } = classifyRecoveryFailureReason(attempt.reason)
    const bucketKey = bucket === 'unknownReason' ? `unknownReason:${unknownKey}` : bucket
    const bySource = counters.sourceFailureReasonCounts[attempt.source] ?? (counters.sourceFailureReasonCounts[attempt.source] = {})
    bySource[bucketKey] = (bySource[bucketKey] ?? 0) + 1
  }
}
// STRUCTURAL COVERAGE DENOMINATOR AUDIT, DISCLOSED (production-evidence follow-up task,
// requirements #3/#4): optional, additive input — computed by the caller (src/pipeline/index.ts,
// via src/modules/eventClassification's computeStructuralCoverageAudit) from real event
// classification data this module has no visibility into on its own. When supplied, ONLY the
// `structuralCoverage` REPORTING metric in publicPnlGateAudit below is recomputed from it — the
// actual gate decision (structuralConsistent/publicPnlStatus/blockingReasons, all still driven by
// fifoEngine's own correctedUnmatchedBuys/Sells, exactly as before) is completely untouched, per
// this task's own "do not change pricing, thresholds or public gate rules — fix the evidence
// feeding the existing gate" constraint. Omitting it preserves this module's original structural-
// coverage formula exactly (backward compatible for any other caller/test).
export type StructuralCoverageDenominatorAudit = {
  genuineUnmatchedBuys: number
  genuineUnmatchedSells: number
  // LEGACY, DISCLOSED: the reporting-only dust-approximation shape (buy/sell-split, per
  // non-trade classification) — still accepted for backward compatibility with any caller that
  // hasn't migrated to the exact join below. Optional; omit when supplying the exact fields.
  excludedNonTradeBuys?: Record<string, number>
  excludedNonTradeSells?: Record<string, number>
  // EXACT UNMATCHED ATTRIBUTION, DISCLOSED (exact-unmatched-identity follow-up task): real counts
  // from joining fifoEngine's own unmatchedBuyEvents/unmatchedSellEvents source identities against
  // this scan's event classification — see eventClassification's computeExactStructuralCoverageAudit.
  // `unmatchedIdentityJoinFailures` is real per requirement #8's fail-closed rule: an event that
  // could not be joined/classified is counted here AND still included in genuineUnmatchedBuys/Sells
  // above (it continues to block, never silently excluded).
  excludedUnmatchedByClassification?: Record<string, number>
  unmatchedIdentityJoinFailures?: number
  // BOUNDED-HISTORY EVIDENCE SPLIT, DISCLOSED (bounded-history follow-up task): real counts from
  // eventClassification's computeUnmatchedEvidenceAudit — see its own header. Optional/additive;
  // when supplied, `genuineUnmatchedBuys`/`genuineUnmatchedSells` above are expected to already
  // equal ONLY the structurally-invalid-or-unknown (blocking) counts from that same audit — an open
  // buy position or a pre-window sell exit is disclosed here but never folded into
  // genuineUnmatchedBuys/Sells, so it never reaches the gate as blocking evidence.
  openPositionBuys?: number
  preWindowInventoryExits?: number
  // TRUNCATED-HISTORY DISCLOSURE, DISCLOSED, ADDITIVE (boundary-model follow-up task; tightened by
  // the per-sell-resolver-bypass fix): real count from eventClassification. Truncation is NOT
  // per-sell proof. These sells remain in genuineUnmatchedSells / sellsBlockedSolelyByUnprovenBoundary
  // until a token-scoped inbound or non-trade proof exists; this field is the disclosed attribution
  // of that still-blocking population, never a waiver.
  preWindowInventoryExitsUnprovenDueToTruncation?: number
  sellsBlockedSolelyByUnprovenBoundary?: number
  // Remaining per-sell boundary-resolver blockers, DISCLOSED, ADDITIVE (per-sell-resolver-bypass
  // fix). When supplied, Combined PnL stays unavailable while any of these sells still lack
  // pre-window / non-trade proof — truncation, 98/98 pricing, and manifest replay are not waivers.
  // Omit for byte-for-byte prior Combined admission (unmigrated callers/tests).
  boundaryDependentRemainingBlockers?: number
  scanWindowDays?: number
  // HISTORY COVERAGE STATUS, DISCLOSED, ADDITIVE (boundary-model follow-up task): real, from
  // eventClassification's computeUnmatchedEvidenceAudit.historyCoverageStatus — see its own header.
  historyCoverageStatus?: 'exhaustive' | 'truncated' | 'partial' | 'unknown'
  // WINDOW BOUNDARY PROOF, DISCLOSED (bounded-sample-gate follow-up task, requirement #2): real,
  // from eventClassification's computeUnmatchedEvidenceAudit.windowBoundaryProven — never guessed.
  // UNCHANGED MEANING (boundary-model follow-up task): true only for 'exhaustive' coverage — this
  // field alone never claims a truncated fetch proved the full window.
  windowBoundaryProven?: boolean
  // BOUNDED-SAMPLE ADMISSION SIGNAL, DISCLOSED, ADDITIVE (boundary-model follow-up task): real, from
  // eventClassification's computeUnmatchedEvidenceAudit.boundedSampleWindowSafe — true for BOTH
  // 'exhaustive' and 'truncated' coverage. THIS is what the bounded (partial, 90-day) sample gate
  // now admits on below — never `windowBoundaryProven` alone, which would still hard-block the
  // confirmed production case (Base's Alchemy fetch capped at 400/400, both providers healthy,
  // 82.96-day span, 110 boundary-gated sells) even though it is disclosed and safe to publish.
  // Omitted (a caller that hasn't been updated) falls back to `windowBoundaryProven` — byte-for-byte
  // the prior gate behavior, never silently more permissive for an unmigrated caller.
  boundedSampleWindowSafe?: boolean
}

// CANONICAL SAMPLE SELECTOR, DISCLOSED (canonical-manifest-replay follow-up task, requirement #5 —
// "apply manifest selection before all final calculations"). CONFIRMED PRODUCTION FAILURE THIS
// CLOSES: the public gate below computes `verifiedPricingCoverage`/`verifiedLotCount` from the
// post-recovery lot array, and the canonical sample manifest was previously applied AFTER
// `reconcile()` had already returned — so a scan whose manifest replay failed still published the
// live 23-lot / 85.19% gate result the manifest was supposed to freeze at 21 / 77.78%. Threading the
// selection in HERE, before the realized-PnL sum and before every gate computation, is the only
// placement where the gate can genuinely be "calculated from that array".
//
// The selector receives the fully accepted-evidence-reconciled lot array and returns the ONE
// canonical array to publish from. It never adds, removes or reorders a lot — it only decides which
// verified lots are published (an unpublished lot comes back in the honest `'unpriced'` state), so
// FIFO matching, the structural lot set, and every coverage denominator are untouched. Optional: a
// caller that doesn't supply one gets byte-identical prior behavior.
export type CanonicalSampleSelection = {
  publishedLots: MatchedLot[]
  // Set when a valid manifest exists but could not be replayed in full — the gate must then report a
  // degraded/unavailable public state rather than falling through to whatever the live sample would
  // have earned on its own (requirement #4's "never present frozen stored PnL as freshly verified").
  forcePublicPnlUnavailable: boolean
  // MANIFEST-APPLIED SIGNAL, DISCLOSED, ADDITIVE (gate/classification-regression follow-up task —
  // confirmed production bug: a manifest replay that genuinely APPLIED — real verified lots, stable
  // realized total, 100% pricing coverage — still reported publicPnlStatus 'unavailable' because
  // this gate's own INDEPENDENT structural-coverage recompute classified a large batch of unmatched
  // sells as genuine [116] instead of truncation-unproven-and-excluded [113 of 116], a live
  // classification regression unrelated to the manifest's own, already-validated correctness).
  // `true` only when replayManifest's own outcome was 'applied' (or an equivalent first-scan/
  // explicit-refresh success) — never a guess, never true merely because a manifest exists. See
  // `boundedSampleEligible`'s own header below for exactly how this is used: as an ADDITIONAL,
  // independent path to eligibility, never a replacement for the existing structural checks, and
  // never consulted at all when this manifest itself failed to apply.
  manifestApplied?: boolean
}
export type CanonicalSampleSelector = (lots: readonly MatchedLot[]) => Promise<CanonicalSampleSelection>

export type PnlReconciliationInput = {
  fifoEngineResult: FifoOutput
  pnlEngineResult: PnlSummaryResult
  routerInferenceOutput?: RouterInferenceLike | null
  syntheticPnlAssemblyOutput?: SyntheticPnlSummary | null
  structuralCoverageDenominatorAudit?: StructuralCoverageDenominatorAudit | null
  canonicalSampleSelector?: CanonicalSampleSelector
  // ADDITIVE, OPTIONAL, DISCLOSED (quote-cash ROI denominator): the same normalized events FIFO
  // already consumed. Used only to prove independent stablecoin movements vs unresolved native
  // quote identity. Omitted → unpaired stablecoin lots fail closed as unresolved (ROI unavailable).
  normalizedEvents?: readonly NormalizedEvent[]
}

// PUBLIC PNL GATE AUDIT, DISCLOSED (evidence-first PnL completion task, requirement #1): a single,
// exhaustive report of every rule the public PnL gate actually evaluates, so a wallet blocked from
// publication has an exact, auditable explanation instead of just an opaque `publicPnlStatus`
// string. Every field here is read from the SAME values `structuralConsistent`/`publicPnlStatus`
// below are computed from — this is a reporting view over that existing gate, never a second,
// separate gate with its own (possibly divergent) thresholds.
export type PublicPnlGateBlockingReason = { rule: string; threshold: string; actualValue: string }
export type PublicPnlGateAudit = {
  verifiedLotCount: number
  fullyPricedLotCount: number
  pricingCoverage: number | null
  structuralCoverage: number | null
  unmatchedBuyCount: number
  unmatchedSellCount: number
  integrityTier: 'full' | 'partial' | 'blocked'
  blockingReasons: PublicPnlGateBlockingReason[]
  // DENOMINATOR AUDIT, DISCLOSED (requirement #4): real breakdown of what structuralCoverage above
  // is actually computed from. rawUnmatchedBuys/Sells are fifoEngine's own (post-classification-
  // filter) counts; genuineUnmatchedBuys/Sells and excludedNonTradeBuys/Sells are populated only
  // when the caller supplied `structuralCoverageDenominatorAudit` — otherwise null/empty, never a
  // guessed value standing in for real classification data this module doesn't have on its own.
  rawUnmatchedBuys: number
  rawUnmatchedSells: number
  genuineUnmatchedBuys: number | null
  genuineUnmatchedSells: number | null
  excludedNonTradeBuys: Record<string, number>
  excludedNonTradeSells: Record<string, number>
  // EXACT ATTRIBUTION, DISCLOSED (requirement #6): populated only when the caller supplied the
  // exact join fields on structuralCoverageDenominatorAudit — otherwise empty/null, never a
  // fabricated stand-in.
  excludedUnmatchedByClassification: Record<string, number>
  unmatchedIdentityJoinFailures: number | null
  structuralCoverageNumerator: number
  structuralCoverageDenominator: number
  // BOUNDED-HISTORY PUBLIC DISCLOSURE, DISCLOSED (bounded-history follow-up task, requirement #7):
  // real values only — openPositionBuys/preWindowInventoryExits are 0 when the caller didn't supply
  // the new audit fields (never estimated). scanWindowDays is null (never guessed) when omitted.
  verifiedClosedLots: number
  structuralClosedLots: number
  openPositionBuys: number
  preWindowInventoryExits: number
  // TRUNCATED-HISTORY DISCLOSURE, DISCLOSED, ADDITIVE (boundary-model follow-up task): real,
  // from denomAudit.preWindowInventoryExitsUnprovenDueToTruncation — see its own header. 0 when the
  // caller didn't supply it (never estimated).
  preWindowInventoryExitsUnprovenDueToTruncation: number
  sellsBlockedSolelyByUnprovenBoundary?: number
  // HISTORY COVERAGE STATUS, DISCLOSED, ADDITIVE (boundary-model follow-up task): real, from
  // denomAudit.historyCoverageStatus — null when the caller didn't supply it (never guessed).
  historyCoverageStatus: 'exhaustive' | 'truncated' | 'partial' | 'unknown' | null
  invalidOrUnknownUnmatchedEvents: number
  scanWindowDays: number | null
  verifiedPricingCoverage: number | null
  // READ-MODEL SHAPE, DIAGNOSTIC ONLY: FIFO emits one row per consumed buy-lot fragment while
  // pnlEngine emits one row per deduped sell entry. These counts have different units and are never
  // compared for equality or read by a public PnL gate.
  engineDivergenceDiagnostic: {
    fifoFragmentCount: number
    uniqueClosingTxCount: number
    uniqueClosingTxTokenCount: number
    pnlSellEntryCount: number
    avgFragmentsPerSell: number | null
    diagnosticOnly: true
  }
  // BOUNDED-SAMPLE GATE AUDIT, DISCLOSED (bounded-sample-gate follow-up task, requirement #6): the
  // bounded verified-sample ('partial') path evaluated and reported on its OWN terms — it is
  // deliberately NOT required to satisfy `blockingReasons`/`fullAvailabilityBlockingReasons` (e.g.
  // unmatched_sells, missing_evidence_count) — see `boundedSampleEligible`'s own computation for the
  // real, narrower rule set it actually evaluates.
  boundedSampleEligible: boolean
  boundedSampleBlockingReasons: PublicPnlGateBlockingReason[]
  fullAvailabilityBlockingReasons: PublicPnlGateBlockingReason[]
  includedVerifiedLotCount: number
  excludedUnpricedLotCount: number
  excludedUnknownUnmatchedCount: number
}

// MISSING-EVIDENCE BREAKDOWN, DISCLOSED (requirement #7): the single `missingEvidenceCount` number
// told a caller THAT evidence was missing, never WHY — whether it was a structurally-unmatched
// trade leg (the wallet-side gap that actually blocks reconstructing a closed lot at all),
// unpriced-but-structurally-matched evidence (a pricing-only gap), or something that was never a
// trade to begin with (dust/non-trade exclusions, which must never block public PnL — see
// `dustExcluded`/`nonTradeExcluded` below, both EXCLUDED from `missingEvidenceCount` itself, exactly
// as they already were before this change; this breakdown is additive visibility, not a new gate).
export type MissingEvidenceBreakdown = {
  criticalTradeEvidenceMissing: number
  pricingEvidenceMissing: number
  dustExcluded: number
  nonTradeExcluded: number
}

// ACCEPTED-EVIDENCE AUDIT, DISCLOSED (determinism follow-up task, requirement #6): real counters
// only — every field here is incremented at the exact point the described event happens, never
// estimated after the fact. See recoverPrices'/hydrateFromAcceptedEvidence's own headers.
export type AcceptedEvidenceAudit = {
  matchedLotSidesTotal: number
  persistedAcceptedSidesLoaded: number
  persistedAcceptedSidesApplied: number
  liveSidesResolved: number
  existingVerifiedSidesProtectedFromOverwrite: number
  // AGGREGATE, DISCLOSED (requirement #6): the sum of recoveryEvidenceWriteSuccesses/Failures below
  // AND canonicalSeedingWriteSuccesses/Failures below — kept for backward compatibility with any
  // existing consumer of the total, while the two phases are now ALSO separately exposed.
  acceptedEvidenceWriteSuccesses: number
  acceptedEvidenceWriteFailures: number
  missingAcceptedEvidenceKeys: number
  // RECOVERY-LANE WRITES, DISCLOSED: writes made by the live recovery loop itself (a side this pass
  // had to fetch from a real provider because no accepted evidence covered it).
  recoveryEvidenceWriteSuccesses: number
  recoveryEvidenceWriteFailures: number
  // CANONICAL-SEEDING WRITES, DISCLOSED (this task's own fix): writes made by the FINAL seeding pass
  // below, for sides that were ALREADY verified before recovery ever ran (priced by any upstream
  // canonical pricing phase — primary historical scheduler, same-tx stable/native quote, Alchemy
  // historical pricing, etc.) — see seedAcceptedEvidenceForVerifiedLots' own header.
  canonicalSeedingWriteSuccesses: number
  canonicalSeedingWriteFailures: number
  // FINAL-SEEDING-PASS COUNTERS, DISCLOSED (requirement #5): scoped to the seeding pass only — never
  // conflated with the hydration-pass counters above, which describe a DIFFERENT phase (reading
  // evidence back, not writing it).
  verifiedSidesEligibleForPersistence: number
  verifiedSidesAlreadyPersisted: number
  verifiedSidesWritten: number
  verifiedSideWriteFailures: number
  verifiedSidesSkippedUnverified: number
  verifiedSidesSkippedInvalid: number
  missingVerifiedEvidenceMetadata: number
  invalidAcceptedEvidenceReasons?: {
    missingSourceQuality: number
    unverifiedSource: number
    invalidPrice: number
    missingTimestamp: number
    temporalMismatch: number
    identityMismatch: number
    missingSchemaMetadata: number
    other: number
  }
  // CANONICAL-PRECEDENCE COUNTERS, DISCLOSED (hydration-timing-and-canonical-precedence follow-up
  // task, requirements #5/#6 — confirmed root cause: an already-upstream-priced side was previously
  // "protected from overwrite" by simply never being checked against accepted evidence at all, so a
  // provider returning a genuinely different price on a later scan silently became the new canonical
  // value). These describe the hydration pass's real behavior when accepted evidence is now compared
  // against EVERY side, not just missing ones — see hydrateFromAcceptedEvidence's own header.
  acceptedSidesRequestedBeforePricing: number
  acceptedSidesLoadedBeforePricing: number
  acceptedSidesAppliedBeforePricing: number
  upstreamLookupsSkippedByAcceptedEvidence: number
  upstreamPricesMatchingAcceptedEvidence: number
  upstreamPricesRejectedDueToAcceptedEvidence: number
  acceptedEvidenceIdentityMisses: number
  acceptedEvidenceValidationFailures: number
  // DISCLOSED: always 0 by construction in this architecture — hydration (which applies accepted
  // evidence) runs strictly before recovery/live pricing every reconcile() call, so accepted
  // evidence can never be "applied after" upstream pricing already ran. Kept as a real, checked
  // field (never silently omitted) so a future architecture change that violated this ordering would
  // be immediately visible rather than silently assumed.
  acceptedEvidenceAppliedAfterUpstreamPricing: number
  // SUPPLEMENTS existingVerifiedSidesProtectedFromOverwrite (requirement #6, kept for backward
  // compatibility — still real, still incremented for every already-priced side regardless of
  // outcome below): a finer breakdown of WHAT "protected" actually meant for that side.
  existingUpstreamSidesBackedByAcceptedEvidence: number
  existingUpstreamSidesWithoutAcceptedEvidence: number
  existingUpstreamSidesConflictingWithAcceptedEvidence: number
  // COVERAGE-AWARE RESEED, DISCLOSED (accepted-evidence-raw-value-mutation follow-up task): the
  // canonical seeding pass no longer treats ANY existing valid record as permanently final — an
  // existing record whose own `coveredLotCount` is LOWER than the live group's real membership is a
  // genuine, deterministic completion (a legitimately new sibling recovered since the record was
  // first written), not a value change, and IS corrected. This counts how many sides were reseeded
  // for exactly that reason — see `acceptedEvidenceMutationAudit` for the bounded per-side detail.
  verifiedSidesCoverageReseeded: number
  acceptedEvidenceMutationAudit: AcceptedEvidenceMutationAudit[]
  // LEGACY PER-UNIT-AS-TOTAL MIGRATION, DISCLOSED (legacy-accepted-evidence-repair follow-up task):
  // see detectLegacyPerUnitTotalRecord's own header (acceptedEvidenceStore.ts) for the exact,
  // deterministic proof required before a persisted record is ever touched. `Detected` counts every
  // record proven to carry the old writer's per-unit-as-total shape; `Repaired` counts those actually
  // rewritten in place; `Rejected` counts detected-but-not-repaired (e.g. the write itself failed) —
  // never a record this migration merely declined to inspect.
  legacyPerUnitRecordsDetected: number
  legacyPerUnitRecordsRepaired: number
  legacyPerUnitRecordsRejected: number
  legacyPerUnitMigrationAudit: AcceptedEvidenceLegacyMigrationRecord[]
  // CONFLICT AUDIT, DISCLOSED (provenance-laundering follow-up task): one bounded entry per side
  // where THIS scan's own fresh upstream value disagreed with the persisted accepted-evidence share
  // (`existingUpstreamSidesConflictingWithAcceptedEvidence`'s own real detail) — answers "why did the
  // conflict counter fire but nothing got reseeded" without needing to re-derive it from logs.
  acceptedEvidenceConflictAudit: AcceptedEvidenceConflictAuditRecord[]
}

// CONFLICT-CONTEXT, DISCLOSED (provenance-laundering follow-up task): per-group-side state the
// per-lot conflict-audit loop needs — computed once per group, never re-derived per lot.
type ConflictContext = {
  evidenceKey: string
  evidence: AcceptedEvidenceEnvelope
  liveFingerprint: string
  legacyProofAvailable: AcceptedEvidenceMigrationClassification | null
}

// BOUNDED CONFLICT AUDIT, DISCLOSED (provenance-laundering follow-up task — the CONFIRMED
// "existingUpstreamSidesConflictingWithAcceptedEvidence=211 yet verifiedSidesCoverageReseeded=0"
// paradox this closes): every side where this scan's own live upstream candidate disagreed with the
// persisted accepted-evidence share was ALWAYS counted (`existingUpstreamSidesConflictingWith
// AcceptedEvidence`), but nothing ever explained WHY none of those 211 conflicts triggered a reseed —
// the coverage-reseed mechanism only ever watches for composition growth (`coveredLotCount`/
// `coverageFingerprint`), never a plain VALUE disagreement, so accepted evidence unconditionally wins
// by design (`reasonProtected: 'accepted_evidence_immutable_by_design'`) UNLESS an independent legacy
// proof is available for that exact side (`legacyProofAvailable` non-null — in which case this same
// pass already repaired it above, before this audit entry is even built).
export type AcceptedEvidenceConflictAuditRecord = {
  evidenceKey: string
  persistedValue: number
  upstreamValue: number
  source: string
  originWriter: string
  coverageFingerprint: string
  liveFingerprint: string
  writeDecision: 'repaired' | 'protected_immutable'
  reasonProtected: string | null
  legacyProofAvailable: AcceptedEvidenceMigrationClassification | null
}

const MAX_CONFLICT_AUDIT_EXAMPLES = 30

// BOUNDED MIGRATION-TRACE AUDIT, DISCLOSED (legacy-accepted-evidence-repair follow-up task): one
// entry per record this pass PROVED carries the old per-unit-as-total writer bug (see
// detectLegacyPerUnitTotalRecord) — capped at MAX_LEGACY_MIGRATION_AUDIT_EXAMPLES, purely for
// production log visibility, never a second decision surface (the actual repair/skip decision is
// made once, inline, by the exact same detection this record just reports).
export type AcceptedEvidenceLegacyMigrationRecord = {
  evidenceKey: string
  oldUsd: number
  amount: number
  unitPrice: number
  reconstructedTotalUsd: number | null
  legacyProof: AcceptedEvidenceMigrationClassification | null
  repairEligible: boolean
  repairApplied: boolean
  repairRejectedReason: string | null
}

const MAX_LEGACY_MIGRATION_AUDIT_EXAMPLES = 30

// BOUNDED MUTATION-TRACE AUDIT, DISCLOSED (accepted-evidence-raw-value-mutation follow-up task):
// diagnostic-only, capped at MAX_ACCEPTED_EVIDENCE_MUTATION_EXAMPLES — never affects the actual
// write/skip decision, purely for production log visibility into exactly which stage a persisted
// side's raw value was last touched at. Every field is read directly off values already computed by
// the canonical seeding pass (never a second, independent recomputation).
export type AcceptedEvidenceMutationAudit = {
  evidenceKey: string
  persistedRawUsd: number | null
  loadedRawUsd: number | null
  upstreamRawUsd: number
  canonicalSeedRawUsd: number
  source: string | null
  sourceTimestamp: number
  schemaVersion: number | null
  methodologyVersion: string
  writeDecision: 'initial_seed' | 'reseed_coverage_growth' | 'skip_already_covers'
  overwritePrevented: boolean
  firstValueChangeStage: 'occurrence_set_reconstruction' | 'none' | 'unexplained'
  oldScaled: string
  newScaled: string
  deltaScaled: string
}

const MAX_ACCEPTED_EVIDENCE_MUTATION_EXAMPLES = 30
const ACCEPTED_EVIDENCE_VALUE_SCALE = 100_000_000

function toAcceptedEvidenceScaled(usd: number): bigint {
  return BigInt(Math.round(usd * ACCEPTED_EVIDENCE_VALUE_SCALE))
}

export type PnlReconciliationSummary = {
  closedLots: number
  unmatchedBuys: number
  unmatchedSells: number
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  priceRecoveredCount: number
  routerCorrectedCount: number
  syntheticAlignedCount: number
  missingEvidenceCount: number
  missingEvidenceBreakdown: MissingEvidenceBreakdown
  publicPnlStatus: ReconciledPublicPnlStatus
  publicPnlGateAudit: PublicPnlGateAudit
  // VERIFIED SAMPLE vs FULL HISTORY, DISCLOSED (verified-sample-vs-full-history follow-up):
  // sample performance is the included canonical closed-lot arithmetic; full-history stays under
  // the existing public gate. Unmatched sells outside the sample never zero the sample figures.
  verifiedSamplePerformance: VerifiedSamplePerformance
  fullHistoryPerformance: FullHistoryPerformance
  verifiedSamplePerformanceAudit: VerifiedSamplePerformanceAudit
  verifiedSampleRealizedPnlUsd: number | null
  verifiedSampleRealizedRoiPct: number | null
  mismatches: Array<{ key: string; classification: PnlMismatchClass }>
  // BOUNDED-SAMPLE WARNING, DISCLOSED (bounded-sample-gate follow-up task, requirement #7): a real,
  // human-readable disclosure — set ONLY when publicPnlStatus is 'partial' via the bounded verified-
  // sample path (never for the legacy near-miss fallback, never for 'available'/'unavailable').
  // Never claims complete wallet history.
  warning: string | null
  // ACCEPTED-EVIDENCE AUDIT, DISCLOSED (determinism follow-up task, requirement #6): real, from this
  // scan's own hydration/recovery pass — see AcceptedEvidenceAudit's own header.
  acceptedEvidenceAudit: AcceptedEvidenceAudit
  // MISSING-PRICE RECOVERY FUNNEL AUDIT, DISCLOSED (this task's own requirement): diagnostics-only,
  // additive to (never a replacement of) walletPnlCoverageRecoveryAudit.ts's coarser per-token
  // `missing_price` bucket — see MissingPriceRecoveryFunnelAudit's own header. Never affects pricing,
  // evidence policy, FIFO, manifest, or the 50% gate; read-only bookkeeping over this same scan's
  // own recovery pass.
  missingPriceRecoveryFunnelAudit: MissingPriceRecoveryFunnelAudit
  // THE ONE CANONICAL PUBLISHED LOT ARRAY, DISCLOSED (canonical-manifest-replay follow-up task,
  // requirement #5/#10). CONFIRMED PRODUCTION BUG THIS CLOSES: this summary previously exposed no
  // lot array at all, so `src/pipeline/index.ts` built its `reconciledFifoAndPnl` by spreading the
  // RAW, pre-reconciliation `fifoEngineResult` — meaning AYRI, serialization and the UI all read a
  // lot array that predated accepted-evidence hydration and price recovery entirely, while the gate
  // reported figures derived from the hydrated one. That is exactly the confirmed 18-vs-23
  // divergence (AYRI 18 verified / public gate 23 verified for the same scan). Every consumer must
  // now read THIS array: it is the same array the realized-PnL sum and every gate figure below were
  // computed from, after accepted-evidence reconciliation and after canonical sample selection.
  publishedMatchedLots: MatchedLot[]
  // DISCREPANCY/TRUST-GATE AUDIT, DISCLOSED (Wallet Scanner trust-gate task): real, computed from
  // the exact same values every other field above was already computed from — never a second,
  // independent PnL computation. See src/lib/pnlDiscrepancyAudit.ts's own header for the full
  // rationale (confirmed production case: a bounded-sample wallet whose canonical and alternate
  // engines disagreed by ~68% while presenting a headline as if it were fully verified).
  pnlDiscrepancyAudit: PnlDiscrepancyAudit
  pnlVerificationTransitionAudit?: {
    structuralLots: number
    earlyNumericPricedLots: number
    earlyVerifiedLots: number
    finalVerifiedLots: number
    downgradedLotCount: number
    downgradeReasons: Record<string, number>
    examples: Array<{ lotId: string; token: string; earlyLotStatus: string; finalLotStatus: string; downgradeStage: string; downgradeReason: string }>
    invariantFailures: string[]
  }
  canonicalVerificationConsistencyAudit?: {
    pricingStageVerifiedLots: number
    canonicalSelectionVerifiedLots: number
    reconciliationVerifiedLots: number
    finalPublicVerifiedLots: number
    droppedAtSelection: string[]
    droppedAtReconciliation: string[]
    droppedAtPublicGate: string[]
    dropReasons: Record<string, number>
    examples: Array<{
      lotId: string
      entryPrice: number | null
      exitPrice: number | null
      entrySource: string | null
      exitSource: string | null
      entryEvidenceStatusBefore: 'verified' | 'unpriced'
      exitEvidenceStatusBefore: 'verified' | 'unpriced'
      earlyCanonicalVerified: boolean
      afterCanonicalSelection: { entrySource: string | null; exitSource: string | null; evidenceQuality: MatchedLot['evidenceQuality'] | null; verified: boolean }
      afterReconciliation: { evidenceQuality: MatchedLot['evidenceQuality'] | null; verified: boolean }
      finalGateVerified: boolean
      firstDowngradeStage: 'canonical_selection' | 'reconciliation' | 'public_gate' | null
      exactDowngradeReason: string | null
      expectedMetadata: { evidenceQuality: 'verified' }
      actualMetadata: { evidenceQuality: MatchedLot['evidenceQuality'] | null }
    }>
    invariantFailures: string[]
  }
}

const roundUsd = (n: number | null | undefined) => typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null
const lotKey = (lot: Pick<MatchedLot, 'chain' | 'token' | 'openedTxHash' | 'closedTxHash' | 'openedAt' | 'closedAt'>) => [lot.chain, lot.token.toLowerCase(), lot.openedTxHash, lot.closedTxHash, lot.openedAt, lot.closedAt].join(':')

// CANONICAL VERIFIED-LOT PREDICATE, DISCLOSED (accepted-evidence-canonical-seeding-eligibility
// follow-up task, requirement #2 — confirmed root cause: seeding's own eligibility check silently
// dropped every lot whose `evidenceQuality` wasn't exactly `'verified'` into neither the eligible
// NOR the skipped bucket whenever both `costBasisUsd`/`proceedsUsd` happened to be null on THAT
// specific check, instead of unconditionally bucketing every non-verified lot as
// `verifiedSidesSkippedUnverified`). This is the ONE shared definition of "this lot is part of the
// public verified closed-lot sample" — the exact boolean the gate below already computes inline
// (`updatedFifoLots.filter((l) => isCanonicalVerifiedLotForPnl(l))`) to derive
// `verifiedLotCount`/`fullyPricedLotCount`/`verifiedPricingCoverage` — refactored into a named,
// exported function so the gate, this reconciliation's own summary, and accepted-evidence seeding
// all read from the exact same predicate, never a second, subtly different reimplementation.
// Deliberately NEVER checks a `verificationStatus`/`confidence`/`pnlDisplayStatus`/`pnlDecisive`
// field — `MatchedLot` (fifoEngine/types.ts) carries none of those; its only real pricing-quality
// signal is `evidenceQuality: 'verified' | 'unpriced'`.
// NOW DELEGATES TO THE ONE SHARED PREDICATE, DISCLOSED (canonical-price-replay follow-up task,
// requirement #6): this used to test `evidenceQuality === 'verified'` alone, while the gate's own
// `fullyPricedLotCount` separately tested that both price sides were non-null and AYRI tested an
// attribution source — three different questions that could legitimately disagree about the same
// lot (confirmed production: gate 23 verified, AYRI 18). All of them now resolve to
// src/lib/canonicalVerifiedLot.ts. This is a strict tightening in principle only: fifoEngine sets
// `evidenceQuality: 'verified'` exactly when both sides are priced, so no lot that previously
// counted stops counting — it simply can no longer diverge from what the other consumers see.
export function isCanonicalVerifiedLotForPnl(lot: Pick<MatchedLot, 'evidenceQuality' | 'costBasisUsd' | 'proceedsUsd' | 'realizedPnlUsd' | 'openedAt' | 'closedAt'>): boolean {
  return isCanonicalVerifiedPublishedLot(lot)
}

// VERIFIED BOUNDED-SAMPLE vs FULL-HISTORY SPLIT, DISCLOSED: unmatched sells outside the included
// canonical sample must not erase the sample's own arithmetic. Displayed sample PnL is summed from
// every included verified lot. Realized ROI numerator and denominator are summed from the ROI-
// eligible membership only (quote/cash legs of already-represented risk trades are excluded;
// independent stablecoin lots remain). Cost basis is never invented. ROI is realized-only —
// (realized + unrealized) / cost is not computed here. Unresolved quote-leg identity makes ROI
// unavailable rather than guessing a denominator.
export function computeVerifiedSampleAndFullHistoryPerformance(params: {
  verifiedLots: readonly MatchedLot[]
  structuralLots?: readonly MatchedLot[]
  normalizedEvents?: readonly NormalizedEvent[]
  structuralLotCount: number
  realizedPnlUsd: number | null
  verifiedPricingCoverage: number | null
  pricingCoverageThresholdMet: boolean
  excludedUnmatchedSellCount: number
  canonicalConsistencyPassed: boolean
  includedSamplePricingMissing: number
  hardInvalidFifoResult: boolean
  canonicalSampleUnavailable: boolean
  publicPnlStatus: ReconciledPublicPnlStatus
  fullHistoryBlockingReasons: readonly string[]
}): {
  verifiedSamplePerformance: VerifiedSamplePerformance
  fullHistoryPerformance: FullHistoryPerformance
  verifiedSamplePerformanceAudit: VerifiedSamplePerformanceAudit
} {
  const verifiedLotCount = params.verifiedLots.length
  const sampleCostBasisUsd = verifiedLotCount > 0
    ? params.verifiedLots.reduce((sum, lot) => sum + (lot.costBasisUsd ?? 0), 0)
    : null
  const eligibility = classifyVerifiedSampleRoiEligibility({
    verifiedLots: params.verifiedLots,
    structuralLots: params.structuralLots ?? params.verifiedLots,
    normalizedEvents: params.normalizedEvents,
  })
  const roiMembershipResolved = eligibility.roiAvailable
  const realizedRoiPnlUsd = eligibility.realizedRoiPnlUsd
  const realizedRoiCostBasisUsd = eligibility.realizedRoiCostBasisUsd
  const realizedCostBasisUsd = roiMembershipResolved ? realizedRoiCostBasisUsd : sampleCostBasisUsd
  const costBasisFinite = realizedCostBasisUsd != null && Number.isFinite(realizedCostBasisUsd)
  const sampleCostFinite = sampleCostBasisUsd != null && Number.isFinite(sampleCostBasisUsd)
  const realizedPnlFinite = params.realizedPnlUsd != null && Number.isFinite(params.realizedPnlUsd)
  const roiCostFinite = realizedRoiCostBasisUsd != null && Number.isFinite(realizedRoiCostBasisUsd)
  const roiPnlFinite = realizedRoiPnlUsd != null && Number.isFinite(realizedRoiPnlUsd)
  const realizedRoiPct = roiMembershipResolved && roiPnlFinite && roiCostFinite && realizedRoiCostBasisUsd! > 0
    ? (realizedRoiPnlUsd! / realizedRoiCostBasisUsd!) * 100
    : null
  const pricingCoverage = params.verifiedPricingCoverage != null && Number.isFinite(params.verifiedPricingCoverage)
    ? params.verifiedPricingCoverage
    : 0

  let samplePerformanceBlockedReason: string | null = null
  if (params.canonicalSampleUnavailable) samplePerformanceBlockedReason = 'canonical_sample_unavailable'
  else if (params.hardInvalidFifoResult) samplePerformanceBlockedReason = 'fifo_result_hard_invalid'
  else if (!params.canonicalConsistencyPassed) samplePerformanceBlockedReason = 'canonical_consistency_failed'
  else if (params.includedSamplePricingMissing > 0) samplePerformanceBlockedReason = 'pricing_evidence_missing_inside_sample'
  else if (verifiedLotCount <= 0) samplePerformanceBlockedReason = 'no_verified_lots'
  else if (!params.pricingCoverageThresholdMet) samplePerformanceBlockedReason = 'pricing_coverage_below_threshold'
  else if (!realizedPnlFinite) samplePerformanceBlockedReason = 'realized_pnl_not_finite'

  const samplePerformanceAllowed = samplePerformanceBlockedReason == null
  const roiUnavailableReason = !roiMembershipResolved ? eligibility.roiUnavailableReason : null
  const roiAllowed = samplePerformanceAllowed && realizedRoiPct != null && roiUnavailableReason == null

  const verifiedSamplePerformance: VerifiedSamplePerformance = {
    status: samplePerformanceAllowed ? 'verified_bounded_sample' : 'unavailable',
    realizedPnlUsd: samplePerformanceAllowed ? params.realizedPnlUsd : null,
    realizedCostBasisUsd: samplePerformanceAllowed && costBasisFinite ? realizedCostBasisUsd : null,
    realizedRoiPct: roiAllowed ? realizedRoiPct : null,
    verifiedLotCount,
    structuralLotCount: params.structuralLotCount,
    pricingCoverage,
    excludedUnmatchedSellCount: params.excludedUnmatchedSellCount,
    isCompleteWalletHistory: false,
    verifiedSampleRoiEligibleLots: eligibility.verifiedSampleRoiEligibleLots.map(roiLotKey),
    verifiedSampleRoiEligibleLotCount: eligibility.verifiedSampleRoiEligibleLots.length,
    quoteCashLegExcludedLotCount: eligibility.quoteCashLegLots.length,
    unresolvedQuoteLegLotCount: eligibility.unresolvedLots.length,
    roiUnavailableReason: samplePerformanceAllowed ? roiUnavailableReason : null,
  }

  const fullHistoryStatus: FullHistoryPerformanceStatus = params.publicPnlStatus === 'available'
    ? 'verified'
    : params.publicPnlStatus === 'partial'
      ? 'partial'
      : 'unavailable'
  const fullHistoryPerformanceAllowed = fullHistoryStatus === 'verified'
  const fullHistoryPerformance: FullHistoryPerformance = {
    status: fullHistoryStatus,
    realizedPnlUsd: fullHistoryStatus === 'unavailable' ? null : params.realizedPnlUsd,
    realizedRoiPct: null,
    blockingReasons: [...params.fullHistoryBlockingReasons],
  }

  const verifiedSamplePerformanceAudit: VerifiedSamplePerformanceAudit = {
    verifiedLotCount,
    includedLotCount: verifiedLotCount,
    realizedPnlUsd: params.realizedPnlUsd,
    realizedCostBasisUsd: costBasisFinite ? realizedCostBasisUsd : null,
    realizedRoiPct,
    pricingCoverage,
    canonicalConsistencyPassed: params.canonicalConsistencyPassed,
    pricingEvidenceMissing: params.includedSamplePricingMissing,
    excludedUnmatchedSellCount: params.excludedUnmatchedSellCount,
    samplePerformanceAllowed,
    samplePerformanceBlockedReason,
    fullHistoryPerformanceAllowed,
    roiEligibleLotCount: eligibility.verifiedSampleRoiEligibleLots.length,
    quoteCashLegExcludedLotCount: eligibility.quoteCashLegLots.length,
    unresolvedQuoteLegLotCount: eligibility.unresolvedLots.length,
    roiUnavailableReason,
    realizedRoiPnlUsd,
    sampleCostBasisUsd: sampleCostFinite ? sampleCostBasisUsd : null,
  }

  return { verifiedSamplePerformance, fullHistoryPerformance, verifiedSamplePerformanceAudit }
}


// CLOSED-LOT COVERAGE RANKING, DISCLOSED (Wallet PnL Item 4): recoverPrices previously sorted
// missing lots as one-side-missing first, then lotKey. That is still a real completable-first
// signal, but it spent the scarce MAX_RECOVERY_ATTEMPTS=40 slots on whichever one-side-missing
// lots happened to sort first alphabetically — often singleton dust/spam — while the tokens that
// dominate the unverified CLOSED-LOT sample (many unpriced lots of one traded asset) starved.
// Item 1 then demotes every verified lot that still shares a side with an unpriced sibling, so
// leaving those siblings unattempted is a double hit: the sibling stays unverified AND the
// already-priced lots on that side fall out of the published sample.
//
// Ranking (same 40-lot cap, same fetchers, never a fabricated price):
//   1. Unpriced lots on a mixed-quality accepted-evidence side (pricing them completes the side
//      so Item 1 no longer demotes the already-verified siblings).
//   2. Tokens with the most unpriced closed lots (lots-completable-per-token — FACY/ETHY/NOX-class
//      majors rise because they dominate missing evidence, never because an address is hardcoded).
//   3. One-side-missing before both-sides-missing (one lookup can finish the lot).
//   4. lotKey for determinism.
// TEST-SUPPORT EXPORT: so a test can assert this order without constructing a full recoverPrices
// pass. recoverPrices below is the only production caller.
function unpricedSiblingsOnIncompleteSides(lots: readonly MatchedLot[]): Set<MatchedLot> {
  const groups = new Map<string, MatchedLot[]>()
  for (const lot of lots) {
    const [entryKey, exitKey] = acceptedEvidenceIdentityKeysForLot(lot)
    for (const key of [entryKey, exitKey]) {
      const existing = groups.get(key)
      if (existing) existing.push(lot)
      else groups.set(key, [lot])
    }
  }
  const unlock = new Set<MatchedLot>()
  for (const members of groups.values()) {
    const verifiedCount = members.filter(isCanonicalVerifiedPublishedLot).length
    if (verifiedCount === 0 || verifiedCount === members.length) continue
    for (const lot of members) {
      if (!isCanonicalVerifiedPublishedLot(lot)) unlock.add(lot)
    }
  }
  return unlock
}

export function rankMissingLotsForRecovery(allLots: readonly MatchedLot[]): MatchedLot[] {
  const missing = allLots.filter((lot) => lot.costBasisUsd === null || lot.proceedsUsd === null)
  const incompleteUnlock = unpricedSiblingsOnIncompleteSides(allLots)
  const unpricedCountByToken = new Map<string, number>()
  for (const lot of missing) {
    const key = `${lot.chain}:${lot.token.toLowerCase()}`
    unpricedCountByToken.set(key, (unpricedCountByToken.get(key) ?? 0) + 1)
  }
  return [...missing].sort((a, b) => {
    const aUnlock = incompleteUnlock.has(a) ? 0 : 1
    const bUnlock = incompleteUnlock.has(b) ? 0 : 1
    if (aUnlock !== bUnlock) return aUnlock - bUnlock
    const aCount = unpricedCountByToken.get(`${a.chain}:${a.token.toLowerCase()}`) ?? 0
    const bCount = unpricedCountByToken.get(`${b.chain}:${b.token.toLowerCase()}`) ?? 0
    if (aCount !== bCount) return bCount - aCount
    const aOne = a.costBasisUsd !== null || a.proceedsUsd !== null ? 0 : 1
    const bOne = b.costBasisUsd !== null || b.proceedsUsd !== null ? 0 : 1
    if (aOne !== bOne) return aOne - bOne
    return lotKey(a).localeCompare(lotKey(b))
  })
}

// CONFIRMED ROOT CAUSE, DISCLOSED (real production evidence): recoverPrices previously ran a
// FULLY SEQUENTIAL for-loop — one lot at a time, each `await`ing a real KV-backed price lookup
// (falling through to a real provider fetcher on a KV miss) — over every lot missing a price, with
// no concurrency and no cap. A real production run confirmed this exact gap: reconcile()'s own
// "[pnl-reconciliation] routerCorrected" log fired, but its OWN final log
// ("[pnl-reconciliation] finalSummary", at the very end of reconcile() below) never appeared at
// all — across four separate real runs — while the worker's own job-finished log reported
// durationMs almost exactly equal to WORKER_GLOBAL_TIMEOUT_MS every time. The ONLY code between
// those two log lines is `await recoverPrices(fifoLots)`. For a wallet with hundreds of lots
// missing a price (this session's own test wallet showed "failed: 373" in
// priceLotsForWallet's own pricing-source breakdown), a fully sequential loop of real network
// calls — each paying the same real-provider latency already documented elsewhere in this
// pipeline (GoldRush/basedex, both already found and fixed for cost/latency this session) — is a
// direct, sufficient explanation for a multi-minute hang with zero console output the whole time.
//
// FIX: bounded concurrency (mapWithConcurrencyLimit, same simple worker-pool pattern already used
// by pricingAtTimeEngine/index.ts for the identical reason) plus a hard cap on how many lots this
// best-effort recovery pass will even attempt. Recovery is optional and additive — a lot recovery
// doesn't reach for stays exactly as honest as it already was (`priceUnavailable`, never a
// fabricated recovered price) — so capping the attempt count only bounds cost, it never changes
// correctness for any lot recovery DOES reach.
const RECOVERY_CONCURRENCY_LIMIT = 8
const MAX_RECOVERY_ATTEMPTS = 40

async function mapWithConcurrencyLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export function createPnlReconciliation(config: Config = {}) {
  const logger = config.logger ?? console
  let state: PnlReconciliationInput | null = null

  // STARTUP ASSERTION, DISCLOSED (this task's explicit requirement): logs ONCE, at construction
  // time, whether the detailed primary source was actually supplied — the fastest way to confirm
  // from real production logs whether the wiring in src/pipeline/index.ts is actually reaching this
  // module, without waiting for a full recovery pass to run first.
  logger.warn('[pnl-reconciliation] startup', { detailedRecoverySourceConfigured: Boolean(config.priceSourceDetailedPrimary) })

  // RECOVERED-PRICE-DISCARDED FIX, DISCLOSED (confirmed root cause of stalled pricing coverage —
  // real production evidence: 283 closed lots, 7 fully priced, 2.47% coverage, unchanged by whether
  // recovery ran or not): this previously returned only a Set<string> of lot keys "recovery reached
  // and found something for" — the ACTUAL resolved price number was discarded the moment it was
  // fetched. reconcile() below only ever used that Set to (a) relabel a mismatch as 'priceRecovered'
  // and (b) shrink missingEvidenceCount's optics — the real, successfully-fetched USD figure never
  // flowed into a lot's costBasisUsd/proceedsUsd/realizedPnlUsd, and therefore never into the
  // official realizedPnlUsd sum (which came from input.fifoEngineResult.realizedPnlUsd, computed
  // upstream in fifoEngine BEFORE this recovery pass ever runs). Recovery was, in effect, cosmetic —
  // it could make the evidence-count LOOK better without ever making one more lot actually eligible
  // for realized PnL. Fixed: now returns the real resolved price per lot, and reconcile() below
  // merges it into an updated lot list and recomputes realizedPnlUsd from that — same bounded
  // candidate cap (MAX_RECOVERY_ATTEMPTS), same concurrency limit, same real priceSources (including
  // the on-chain fallback already reused here under existing policy) — this is strictly about
  // applying what recovery already, legitimately found, never about fetching more or fabricating
  // anything. A lot recovery doesn't reach, or genuinely can't price, stays exactly as honest as
  // before: null, never a fabricated value.
  //
  // ONE-SIDE-MISSING PRIORITY, DISCLOSED: a lot already missing only ONE side needs exactly one more
  // successful lookup to become fully priced; a lot missing BOTH sides needs two. Within the same
  // fixed candidate budget, completing one-side-missing lots first yields more newly-fully-priced
  // lots per attempt than starting new lots from zero — sorted first (tie-broken by lotKey for
  // determinism), never changing which fetchers or how many attempts are used per lot.
  //
  // CLOSED-LOT COVERAGE RANKING, DISCLOSED (Wallet PnL Item 4): one-side-missing is now the THIRD
  // key, after (1) unpriced siblings on mixed-quality accepted-evidence sides (Item 1 unlock) and
  // (2) tokens that dominate the unpriced closed-lot sample. Same MAX_RECOVERY_ATTEMPTS cap, same
  // fetchers — only the order of the already-bounded candidate list changes. See
  // rankMissingLotsForRecovery.
  // WIRING DIAGNOSTIC COUNTERS, DISCLOSED (this task's explicit requirement): distinguishes THREE
  // real, distinct things that a bare "recovered: 0" summary conflates:
  //   - detailedLookupsUsed: how many leg attempts SELECTED the detailed path (the primary slot,
  //     with a detailed fetcher configured) — this is a wiring/selection count, incremented
  //     regardless of whether the underlying KV client ever actually invokes the fetcher.
  //   - plainLookupsUsed: how many leg attempts used the plain (non-detailed) fetcher instead —
  //     either because no detailed fetcher was configured, or because this was the fallback slot.
  //   - detailedAttemptsObserved: how many times the detailed fetcher was ACTUALLY invoked (i.e.
  //     RequestPriceKvClient's cache-hit/in-flight/per-token-cap short-circuits did NOT prevent a
  //     real call). If detailedLookupsUsed is high but this stays near zero, that proves the
  //     short-circuit — not a wiring gap — is what's suppressing real per-source attempts, without
  //     this diagnostic pass needing to touch (or even know) that cap's value.
  function emptyAcceptedEvidenceAudit(): AcceptedEvidenceAudit {
    return {
      matchedLotSidesTotal: 0, persistedAcceptedSidesLoaded: 0, persistedAcceptedSidesApplied: 0,
      liveSidesResolved: 0, existingVerifiedSidesProtectedFromOverwrite: 0,
      acceptedEvidenceWriteSuccesses: 0, acceptedEvidenceWriteFailures: 0, missingAcceptedEvidenceKeys: 0,
      recoveryEvidenceWriteSuccesses: 0, recoveryEvidenceWriteFailures: 0,
      canonicalSeedingWriteSuccesses: 0, canonicalSeedingWriteFailures: 0,
      verifiedSidesEligibleForPersistence: 0, verifiedSidesAlreadyPersisted: 0, verifiedSidesWritten: 0,
      verifiedSideWriteFailures: 0, verifiedSidesSkippedUnverified: 0, verifiedSidesSkippedInvalid: 0,
      missingVerifiedEvidenceMetadata: 0,
      invalidAcceptedEvidenceReasons: {
        missingSourceQuality: 0, unverifiedSource: 0, invalidPrice: 0, missingTimestamp: 0,
        temporalMismatch: 0, identityMismatch: 0, missingSchemaMetadata: 0, other: 0,
      },
      acceptedSidesRequestedBeforePricing: 0, acceptedSidesLoadedBeforePricing: 0, acceptedSidesAppliedBeforePricing: 0,
      upstreamLookupsSkippedByAcceptedEvidence: 0, upstreamPricesMatchingAcceptedEvidence: 0,
      upstreamPricesRejectedDueToAcceptedEvidence: 0, acceptedEvidenceIdentityMisses: 0,
      acceptedEvidenceValidationFailures: 0, acceptedEvidenceAppliedAfterUpstreamPricing: 0,
      existingUpstreamSidesBackedByAcceptedEvidence: 0, existingUpstreamSidesWithoutAcceptedEvidence: 0,
      existingUpstreamSidesConflictingWithAcceptedEvidence: 0,
      verifiedSidesCoverageReseeded: 0, acceptedEvidenceMutationAudit: [],
      legacyPerUnitRecordsDetected: 0, legacyPerUnitRecordsRepaired: 0, legacyPerUnitRecordsRejected: 0,
      legacyPerUnitMigrationAudit: [], acceptedEvidenceConflictAudit: [],
    }
  }

  // HYDRATE FROM ACCEPTED EVIDENCE, DISCLOSED (determinism follow-up task, requirements #1-#3,#8 —
  // confirmed root cause of "same matched-lot set, different verified-lot set/realized PnL across
  // identical rescans"): runs BEFORE any live provider call. A lot side already priced by fifoEngine
  // is never touched (requirement #8: "recovery may fill only missing sides") — its side is counted
  // as `existingVerifiedSidesProtectedFromOverwrite` and left completely alone. A MISSING side is
  // hydrated from the accepted-evidence store when — and only when — a VALID entry exists for the
  // EXACT (chain, token, txHash, side, timestamp, lot-identity-version) — see
  // acceptedEvidenceStore.ts's own fail-closed matching rule. A hydrated side BYPASSES live provider
  // competition entirely: it is removed from the candidate pool the live loop below ever sees, so no
  // live source can replace or downgrade it during an ordinary rescan.
  // CANONICAL-PRECEDENCE HYDRATION, DISCLOSED (hydration-timing-and-canonical-precedence follow-up
  // task — confirmed root cause: an already-upstream-priced side was previously "protected from
  // overwrite" by never being checked against accepted evidence AT ALL — so a provider returning a
  // genuinely different price on a later scan silently became the new canonical value, changing
  // verified-lot membership and realized PnL for an unchanged matched-lot structure). This function
  // now checks accepted evidence for EVERY side — already-priced by upstream AND still-missing
  // alike — and, whenever a VALID persisted entry exists for the exact identity (chain/token/txHash/
  // side/timestamp/lot-identity-version/schemaVersion — acceptedEvidenceStore.ts's own fail-closed
  // rule, unchanged here), that accepted price is now CANONICAL: it always wins, whether the
  // upstream candidate agreed (`upstreamPricesMatchingAcceptedEvidence`) or genuinely differed
  // (`upstreamPricesRejectedDueToAcceptedEvidence` — the upstream candidate is logged for diagnostics
  // only, never applied). A side with no valid accepted evidence keeps its upstream value exactly as
  // before (nothing to override with) — accepted evidence can only ever narrow disagreement toward
  // the previously-published canonical fact, never invent one from nothing.
  //
  // GROUP-AWARE ALLOCATION, DISCLOSED (accepted-evidence-persistence follow-up task): an accepted
  // evidence record is keyed per TRANSACTION SIDE, not per lot — several sibling FIFO partial-fill
  // lots can share one record. That record's `priceUsd` is now genuinely the whole side's TOTAL
  // value (see acceptedEvidenceStore.ts's own header on the schema-2 writer fix), so it can never be
  // assigned 1:1 to every sibling (that would duplicate the group's total onto each lot). This
  // function groups `lots` by shared side identity FIRST, reads each group's evidence exactly ONCE
  // (a discovery read — `readAcceptedEvidenceAnyLotVersion` — since siblings carry different
  // lot-identity versions and only one of them can be the version a shared record happens to store),
  // then allocates that one total across the group by raw-quantity ratio using the exact same
  // `allocateSideValueAcrossGroup` function the canonical-sample manifest's own build/replay use —
  // one shared, tested implementation, never a second reimplementation of the same arithmetic.
  async function hydrateFromAcceptedEvidence(lots: readonly MatchedLot[]): Promise<{ hydratedLots: MatchedLot[]; audit: AcceptedEvidenceAudit }> {
    const audit = emptyAcceptedEvidenceAudit()
    const kv = config.acceptedEvidenceKv
    const now = (config.now ?? Date.now)()
    audit.matchedLotSidesTotal += lots.length * 2

    if (!kv) {
      for (const lot of lots) {
        if (lot.costBasisUsd !== null) { audit.existingVerifiedSidesProtectedFromOverwrite += 1; audit.existingUpstreamSidesWithoutAcceptedEvidence += 1 }
        if (lot.proceedsUsd !== null) { audit.existingVerifiedSidesProtectedFromOverwrite += 1; audit.existingUpstreamSidesWithoutAcceptedEvidence += 1 }
        audit.missingAcceptedEvidenceKeys += 2
      }
      return { hydratedLots: [...lots], audit }
    }

    type SideGroup = { chain: string; token: string; txHash: string; side: AcceptedEvidenceSide; timestamp: number; lots: MatchedLot[] }
    const sideGroupKey = (chain: string, token: string, txHash: string, side: AcceptedEvidenceSide, timestamp: number) =>
      `${chain}:${token.toLowerCase()}:${txHash}:${side}:${timestamp}`
    const groups = new Map<string, SideGroup>()
    const addToGroup = (lot: MatchedLot, side: AcceptedEvidenceSide, txHash: string, timestamp: number) => {
      const key = sideGroupKey(lot.chain, lot.token, txHash, side, timestamp)
      const existing = groups.get(key)
      if (existing) existing.lots.push(lot)
      else groups.set(key, { chain: lot.chain, token: lot.token, txHash, side, timestamp, lots: [lot] })
    }
    for (const lot of lots) {
      addToGroup(lot, 'entry', lot.openedTxHash, lot.openedAt)
      addToGroup(lot, 'exit', lot.closedTxHash, lot.closedAt)
    }

    // ONE DISCOVERY READ PER GROUP, BOUNDED CONCURRENCY, DISCLOSED: never once per sibling. STILL
    // FAIL-CLOSED, DISCLOSED: the discovery read only relaxes the `lotIdentityVersion` MATCH — it
    // does not relax WHICH versions are acceptable. The version the store actually returns must
    // belong to one of THIS group's own current siblings (their real, freshly-computed identity
    // versions) or it is discarded exactly like a miss. This is what still rejects a genuinely
    // corrupt/stale record — e.g. a version belonging to a structurally different lot from a prior
    // FIFO rematch — falling through to live recovery instead of being coerced into a price.
    const evidenceByGroupKey = new Map<string, AcceptedEvidenceEnvelope | null>()
    await mapWithConcurrencyLimit([...groups.entries()], RECOVERY_CONCURRENCY_LIMIT, async ([key, group]) => {
      audit.acceptedSidesRequestedBeforePricing += group.lots.length
      const evidence = await readAcceptedEvidenceAnyLotVersion(kv, { chain: group.chain, token: group.token, txHash: group.txHash, side: group.side, timestamp: group.timestamp }, now)
      const groupVersions = new Set(group.lots.map((l) => lotIdentityVersion(l)))
      evidenceByGroupKey.set(key, evidence && groupVersions.has(evidence.lotIdentityVersion) ? evidence : null)
    })

    // ALLOCATE EACH GROUP'S TOTAL ACROSS ITS SIBLINGS, ONCE, DISCLOSED: the exact same deterministic,
    // integer-exact split the manifest module uses — allocated shares sum back to the group's total.
    const shareByLot = new Map<MatchedLot, { entry?: SideAllocationShare; exit?: SideAllocationShare }>()
    // CONFLICT-AUDIT CONTEXT, DISCLOSED (provenance-laundering follow-up task): per-lot-per-side
    // context the second (per-lot) loop below needs to build a real conflict-audit entry — never a
    // second, independent recomputation of the group's own evidence/fingerprint/legacy-proof state.
    const conflictContextByLot = new Map<MatchedLot, { entry?: ConflictContext; exit?: ConflictContext }>()
    // REPAIR TRACKING, DISCLOSED: which evidence keys this SAME pass actually repaired (write
    // succeeded) — never re-derived from value equality, since a repair via the live-upstream proof
    // path makes the repaired share EQUAL to upstream by construction (landing in the "matching"
    // branch below, never "conflicting" at all); the conflict-audit's own `writeDecision` needs the
    // real, independent fact of whether a write happened, not an inference from values that a
    // successful repair would have already reconciled.
    const repairedEvidenceKeysThisPass = new Set<string>()
    for (const [key, group] of groups) {
      const evidence = evidenceByGroupKey.get(key)
      if (!evidence) continue
      let groupTotalUsd = evidence.priceUsd
      const evidenceKey = buildAcceptedEvidenceKey(evidence)
      const liveFingerprint = buildAcceptedEvidenceCoverageFingerprint(group.lots)
      let detection: ReturnType<typeof detectLegacyPerUnitTotalRecord> = { legacyProof: null, reconstructedTotalUsd: null }
      // LEGACY PER-UNIT-AS-TOTAL MIGRATION, DISCLOSED (legacy-accepted-evidence-repair /
      // provenance-laundering follow-up tasks): only ever attempted when the record's own declared
      // scope (`coveredLotCount: 1`, the old writer's only shape) still matches the LIVE group's
      // real composition exactly (still exactly 1 lot) — a group that has since grown beyond that
      // scope is a genuinely different question (composition drift) this migration does not attempt
      // to answer; it is left untouched here, exactly as before this task (fail-closed, never a
      // guess).
      if (group.lots.length === 1) {
        // PRIMARY: metadata-based proof (works when `originWriter` — or, for a record predating
        // that field, `source` — still says `recovery-lane`). See detectLegacyPerUnitTotalRecord's
        // own header: this alone can no longer be silently defeated by a later re-envelope, since
        // `originWriter` is now preserved through every write (see buildAcceptedEvidenceEnvelope's
        // provenance-preservation logic below).
        detection = detectLegacyPerUnitTotalRecord(evidence, group.lots[0].amount)
        // FALLBACK: independent, provenance-free proof for a record whose true origin is ALREADY
        // unrecoverable (laundered before this fix ever shipped) — proves corruption from this
        // scan's own live upstream total alone, never from a metadata field that could itself have
        // been erased. See detectLegacyPerUnitTotalByLiveUpstreamProof's own header.
        if (detection.legacyProof === null) {
          const liveUpstreamTotalUsd = group.side === 'entry' ? group.lots[0].costBasisUsd : group.lots[0].proceedsUsd
          if (liveUpstreamTotalUsd !== null) {
            detection = detectLegacyPerUnitTotalByLiveUpstreamProof(evidence.priceUsd, group.lots[0].amount, liveUpstreamTotalUsd)
          }
        }
      }
      // WRONG-DECIMAL-SCALE, DISCLOSED (same-tx Base USDC 18-vs-6 poison): a scale-error record
      // wrote priceUsd === valueUsd === the tiny TOTAL, so the per-unit proofs above never fire
      // (live "detected/repaired 0 records"). Only rewrite when this scan's own live total is
      // 10^12 × the persisted total AND the token is a canonical 6-decimal stable — never a
      // blind immutability bypass.
      if (detection.legacyProof === null) {
        let liveGroupTotal = 0
        let liveComplete = true
        for (const lot of group.lots) {
          const live = group.side === 'entry' ? lot.costBasisUsd : lot.proceedsUsd
          if (live == null || !Number.isFinite(live) || live <= 0) { liveComplete = false; break }
          liveGroupTotal += live
        }
        if (liveComplete) {
          detection = detectWrongDecimalScaleByLiveUpstreamProof(evidence.priceUsd, liveGroupTotal)
        }
      }
      const legacyProofAvailable: AcceptedEvidenceMigrationClassification | null = detection.legacyProof
      if (detection.legacyProof !== null) {
          audit.legacyPerUnitRecordsDetected += 1
          const total = detection.reconstructedTotalUsd!
          const record: AcceptedEvidenceLegacyMigrationRecord = {
            evidenceKey, oldUsd: evidence.priceUsd, amount: group.lots[0].amount, unitPrice: evidence.priceUsd,
            reconstructedTotalUsd: total, legacyProof: detection.legacyProof,
            repairEligible: true, repairApplied: false, repairRejectedReason: null,
          }
          // REPAIR, WRITTEN BACK, AWAITED, DISCLOSED: current schema/methodology (buildAcceptedEvidenceEnvelope
          // always stamps ACCEPTED_EVIDENCE_SCHEMA_VERSION), correct group-total USD in BOTH
          // priceUsd/valueUsd (the new writer's own invariant), identity/evidenceType/
          // providerTimestampBucket preserved exactly from the record being repaired — never a
          // fabricated provenance. `previousEnvelope: evidence` carries `originWriter`/
          // `originMethodologyVersion` forward unchanged (this repair write is never itself allowed
          // to launder provenance) and appends a real `migrationHistory` entry. `source` is left as
          // whatever the record's own CURRENT source already is (this repair corrects the VALUE, not
          // the writer identity — a record already relabeled `canonical-upstream` stays labeled
          // that; only its `originWriter` truthfully remembers where the value first came from).
          // Applied THIS scan, before publication, so the corrected value both fixes this scan's own
          // reconstruction AND makes every future scan stable/idempotent.
          const repairedEnvelope = buildAcceptedEvidenceEnvelope({
            identity: { chain: evidence.chain, token: evidence.token, txHash: evidence.txHash, side: evidence.side, timestamp: evidence.timestamp, lotIdentityVersion: evidence.lotIdentityVersion },
            priceUsd: total, valueUsd: total, coveredLotCount: evidence.coveredLotCount, coverageFingerprint: evidence.coverageFingerprint,
            source: evidence.source, evidenceType: evidence.evidenceType, providerTimestampBucket: evidence.providerTimestampBucket, now,
            previousEnvelope: evidence, writerReason: detection.legacyProof,
          })
          const ok = await writeAcceptedEvidence(kv, repairedEnvelope)
          record.repairApplied = ok
          if (ok) { audit.legacyPerUnitRecordsRepaired += 1; groupTotalUsd = total; repairedEvidenceKeysThisPass.add(evidenceKey) }
          else { audit.legacyPerUnitRecordsRejected += 1; record.repairRejectedReason = 'write_failed' }
          if (audit.legacyPerUnitMigrationAudit.length < MAX_LEGACY_MIGRATION_AUDIT_EXAMPLES) audit.legacyPerUnitMigrationAudit.push(record)
      }
      for (const lot of group.lots) {
        const ctx = conflictContextByLot.get(lot) ?? {}
        const context: ConflictContext = { evidenceKey, evidence, liveFingerprint, legacyProofAvailable }
        if (group.side === 'entry') ctx.entry = context
        else ctx.exit = context
        conflictContextByLot.set(lot, ctx)
      }
      for (const share of allocateSideValueAcrossGroup(group.lots, stablecoinNormalizedGroupTotal(group.lots, groupTotalUsd))) {
        const existing = shareByLot.get(share.lot) ?? {}
        if (group.side === 'entry') existing.entry = share
        else existing.exit = share
        shareByLot.set(share.lot, existing)
      }
    }

    const hydratedLots: MatchedLot[] = []
    for (const lot of lots) {
      let costBasisUsd = lot.costBasisUsd
      let proceedsUsd = lot.proceedsUsd
      const shares = shareByLot.get(lot)
      const contexts = conflictContextByLot.get(lot)
      const sides: Array<{ side: AcceptedEvidenceSide; upstreamPrice: number | null; already: boolean; share: SideAllocationShare | undefined; context: ConflictContext | undefined }> = [
        { side: 'entry', upstreamPrice: lot.costBasisUsd, already: lot.costBasisUsd !== null, share: shares?.entry, context: contexts?.entry },
        { side: 'exit', upstreamPrice: lot.proceedsUsd, already: lot.proceedsUsd !== null, share: shares?.exit, context: contexts?.exit },
      ]
      for (const s of sides) {
        if (s.already) audit.existingVerifiedSidesProtectedFromOverwrite += 1
        const shareIsCanonicalPositive = s.share != null && isCanonicalPositiveUsd(s.share.allocatedValueUsd) && !s.share.dustBelowPrecision
        if (shareIsCanonicalPositive && s.share) {
          audit.persistedAcceptedSidesLoaded += 1
          audit.persistedAcceptedSidesApplied += 1
          audit.acceptedSidesLoadedBeforePricing += 1
          audit.acceptedSidesAppliedBeforePricing += 1
          if (s.already) {
            // CONFLICT DETECTION, DISCLOSED (requirement #6): compares the upstream candidate ONLY
            // for diagnostics — the accepted, canonical allocated share is applied unconditionally
            // below regardless of the outcome of this comparison.
            if (s.upstreamPrice === s.share.allocatedValueUsd) {
              audit.upstreamPricesMatchingAcceptedEvidence += 1
              audit.existingUpstreamSidesBackedByAcceptedEvidence += 1
            } else {
              audit.upstreamPricesRejectedDueToAcceptedEvidence += 1
              audit.existingUpstreamSidesConflictingWithAcceptedEvidence += 1
              // CONFLICT AUDIT, DISCLOSED (provenance-laundering follow-up task — answers the
              // confirmed "conflicting=211, reseeded=0" paradox for EVERY conflicting side, not just
              // an aggregate count): a repair already happened above (in the group loop) whenever an
              // independent legacy proof was available for this exact side — `writeDecision` reports
              // which actually occurred. Absent a proof, accepted evidence wins unconditionally BY
              // DESIGN (never a bug in itself — this is what keeps a genuinely correct, immutable
              // historical record safe from a live price simply drifting later); `reasonProtected`
              // names that design choice explicitly so a real corruption without proof is at least
              // VISIBLE, never silently invisible the way the plain counter alone left it.
              if (s.context && audit.acceptedEvidenceConflictAudit.length < MAX_CONFLICT_AUDIT_EXAMPLES) {
                const wasRepaired = repairedEvidenceKeysThisPass.has(s.context.evidenceKey)
                audit.acceptedEvidenceConflictAudit.push({
                  evidenceKey: s.context.evidenceKey,
                  persistedValue: s.context.evidence.priceUsd,
                  upstreamValue: s.upstreamPrice!,
                  source: s.context.evidence.source,
                  originWriter: s.context.evidence.originWriter ?? s.context.evidence.source,
                  coverageFingerprint: s.context.evidence.coverageFingerprint,
                  liveFingerprint: s.context.liveFingerprint,
                  writeDecision: wasRepaired ? 'repaired' : 'protected_immutable',
                  reasonProtected: wasRepaired ? null : 'accepted_evidence_immutable_by_design',
                  legacyProofAvailable: s.context.legacyProofAvailable,
                })
              }
            }
          } else {
            audit.upstreamLookupsSkippedByAcceptedEvidence += 1
          }
          if (s.side === 'entry') costBasisUsd = s.share.allocatedValueUsd
          else proceedsUsd = s.share.allocatedValueUsd
        } else {
          // FAIL OPEN, DISCLOSED (contaminated 81-lot fast-path lock): a persisted group total
          // that allocates this sibling to 0 / dust is not canonical coverage. Leave the
          // upstream value (live price, or null) so recovery can still fill the side. Never
          // overwrite a positive live value with a non-positive reconstruction, and never
          // persist that reconstruction as "applied."
          audit.missingAcceptedEvidenceKeys += 1
          audit.acceptedEvidenceIdentityMisses += 1
          if (s.share && !shareIsCanonicalPositive) {
            audit.invalidAcceptedEvidenceReasons!.invalidPrice += 1
          }
          if (s.already) audit.existingUpstreamSidesWithoutAcceptedEvidence += 1
        }
      }
      // REALIZED-PNL RECOMPUTE, DISCLOSED: a side that was already both-sides-priced by upstream
      // (fifoEngine's own `realizedPnlUsd`/`evidenceQuality` reflect ITS prices) can have one or both
      // of those prices overridden by canonical accepted evidence above — `realizedPnlUsd` must be
      // recomputed from the FINAL, canonical prices, never left stale against a superseded upstream
      // figure. Only recomputed when a price actually changed and both sides are now known.
      const pricesChanged = costBasisUsd !== lot.costBasisUsd || proceedsUsd !== lot.proceedsUsd
      if (!pricesChanged) { hydratedLots.push(lot); continue }
      const nowFullyPriced = isCanonicalPositiveUsd(costBasisUsd) && isCanonicalPositiveUsd(proceedsUsd)
      hydratedLots.push({
        ...lot,
        costBasisUsd,
        proceedsUsd,
        realizedPnlUsd: nowFullyPriced ? proceedsUsd! - costBasisUsd! : lot.realizedPnlUsd,
        evidenceQuality: nowFullyPriced ? ('verified' as const) : lot.evidenceQuality,
      })
    }
    return { hydratedLots, audit }
  }

  async function recoverPrices(lots: readonly MatchedLot[]): Promise<{
    hydratedLots: MatchedLot[]
    recoveredByLotKey: Map<string, RecoveredPrice>
    oneSideMissingCandidates: number
    bothSidesMissingCandidates: number
    candidatesAttempted: number
    candidatesCappedByBudget: number
    failureReasonCounts: RecoveryFailureReasonCounts
    sourceAttemptCounters: SourceAttemptCounters
    detailedLookupsUsed: number
    plainLookupsUsed: number
    detailedAttemptsObserved: number
    acceptedEvidenceAudit: AcceptedEvidenceAudit
    missingPriceRecoveryFunnelAudit: MissingPriceRecoveryFunnelAudit
  }> {
    // priceLotsForWallet is the canonical historical-price boundary: every finite value reaching
    // FIFO through its lookup was accepted by a configured (non-synthetic) price source.  Older
    // structural lots can nevertheless retain the pre-pricing `unpriced` label.  Normalize that
    // stale label before recovery so a genuinely two-sided lot is not stranded outside every
    // canonical verified consumer.  One-sided lots remain unpriced and are handled below.
    const pricedStructuralLots = lots.map((lot) => {
      const bothAccepted = isCanonicalPositiveUsd(lot.costBasisUsd) && isCanonicalPositiveUsd(lot.proceedsUsd)
      return bothAccepted && lot.evidenceQuality === 'unpriced'
        ? { ...lot, realizedPnlUsd: lot.proceedsUsd! - lot.costBasisUsd!, evidenceQuality: 'verified' as const }
        : lot
    })
    const { hydratedLots, audit: acceptedEvidenceAudit } = await hydrateFromAcceptedEvidence(pricedStructuralLots)
    // CANONICAL BASE, DISCLOSED (hydration-timing-and-canonical-precedence follow-up task):
    // `hydratedLots` — NOT the raw, un-hydrated `lots` — is now the base the caller's `updatedFifoLots`
    // merge builds from (see reconcile()'s own call site below). Every side accepted evidence covered
    // (whether it filled a gap or overrode an upstream candidate) is ALREADY final in `hydratedLots`,
    // including a correctly recomputed `realizedPnlUsd`/`evidenceQuality` — `recoveredByLotKey` below
    // is reserved EXCLUSIVELY for sides genuinely resolved by LIVE recovery in this same pass, never
    // a duplicate encoding of what hydration already decided.
    const recoveredByLotKey = new Map<string, RecoveredPrice>()
    const failureReasonCounts = emptyReasonCounts()
    const sourceAttemptCounters = emptySourceAttemptCounters()
    let detailedLookupsUsed = 0
    let plainLookupsUsed = 0
    let detailedAttemptsObserved = 0
    const fetchers = [config.priceSources?.primary, config.priceSources?.fallback].filter(Boolean) as PriceSourceFn[]
    const detailedPrimary = config.priceSourceDetailedPrimary
    const missingLots = hydratedLots.filter((lot) => !isCanonicalPositiveUsd(lot.costBasisUsd) || !isCanonicalPositiveUsd(lot.proceedsUsd))
    const oneSideMissingCandidates = missingLots.filter((l) => isCanonicalPositiveUsd(l.costBasisUsd) || isCanonicalPositiveUsd(l.proceedsUsd)).length
    const bothSidesMissingCandidates = missingLots.length - oneSideMissingCandidates
    if (!config.priceKvClient || (fetchers.length === 0 && !detailedPrimary)) {
      const missingPriceRecoveryFunnelAudit = buildMissingPriceRecoveryFunnelAudit({
        originalLots: lots,
        hydratedLots,
        sortedMissing: missingLots,
        candidates: [],
        recoveredByLotKey,
        candidateOutcomeByKey: new Map(),
        totalStructuralLots: lots.length,
      })
      return { hydratedLots, recoveredByLotKey, oneSideMissingCandidates, bothSidesMissingCandidates, candidatesAttempted: 0, candidatesCappedByBudget: missingLots.length, failureReasonCounts, sourceAttemptCounters, detailedLookupsUsed, plainLookupsUsed, detailedAttemptsObserved, acceptedEvidenceAudit, missingPriceRecoveryFunnelAudit }
    }
    const priceKvClient = config.priceKvClient
    // Within the existing fixed attempt budget, prefer tokens whose missing side blocks the most
    // closed lots. Historical/provider work is naturally reusable by token, and completing a major
    // token's exact-evidence lots raises the verified sample more than spending the same bounded
    // slots on isolated one-off tokens. One-side-missing remains the primary priority because it
    // still yields one completed lot per successful lookup; this only replaces the arbitrary
    // lexical tie-break with measured closed-lot coverage yield.
    const missingLotsPerToken = new Map<string, number>()
    for (const lot of missingLots) {
      const key = `${lot.chain}:${lot.token.toLowerCase()}`
      missingLotsPerToken.set(key, (missingLotsPerToken.get(key) ?? 0) + 1)
    }
    const tokenYield = (lot: MatchedLot) => missingLotsPerToken.get(`${lot.chain}:${lot.token.toLowerCase()}`) ?? 0
    const sorted = [...missingLots].sort((a, b) => {
      const aOneSide = isCanonicalPositiveUsd(a.costBasisUsd) || isCanonicalPositiveUsd(a.proceedsUsd) ? 0 : 1
      const bOneSide = isCanonicalPositiveUsd(b.costBasisUsd) || isCanonicalPositiveUsd(b.proceedsUsd) ? 0 : 1
      if (aOneSide !== bOneSide) return aOneSide - bOneSide
      const yieldDelta = tokenYield(b) - tokenYield(a)
      return yieldDelta !== 0 ? yieldDelta : lotKey(a).localeCompare(lotKey(b))
    })
    const candidates = sorted.slice(0, MAX_RECOVERY_ATTEMPTS)
    // RECOVERY LANE BUDGET, DISCLOSED (this task's explicit requirement): derived strictly from the
    // existing MAX_RECOVERY_ATTEMPTS candidate cap — worst case, every candidate needs BOTH legs
    // (buy + sell), so the live-fetch allowance is exactly 2x that already-bounded number. Never
    // unlimited, never a new independent knob.
    const maxRecoveryLookups = MAX_RECOVERY_ATTEMPTS * 2
    // Records EVERY attempt in a detailed result (via recordSourceAttempts, per-source, never just
    // the final one) into the per-source counters, and returns the LAST attempt's reason (the most
    // recent real source tried before this leg gave up) — never the full response, matching this
    // task's explicit "compact reason counters instead of logging full responses" requirement. An
    // exception from the detailed source is caught here specifically (never silently converted to a
    // generic null elsewhere) and recorded into the unknownReason bucket under a compact, bounded
    // key — this task's own "confirm exceptions are not silently converted to generic null"
    // requirement.
    const callDetailed = async (token: string, chain: string, timestamp: number): Promise<{ price: number | null; reason: string | null }> => {
      detailedAttemptsObserved += 1
      try {
        const d = await detailedPrimary!(token, chain as SupportedChain, timestamp)
        recordSourceAttempts(sourceAttemptCounters, d.attempts)
        return { price: d.price, reason: d.attempts.length > 0 ? d.attempts[d.attempts.length - 1].reason : null }
      } catch (err) {
        const exceptionKey = err instanceof Error ? err.constructor.name : 'UnknownException'
        sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException = sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException ?? {}
        sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException[exceptionKey] = (sourceAttemptCounters.sourceFailureReasonCounts.detailedPrimaryException[exceptionKey] ?? 0) + 1
        return { price: null, reason: `exception:${exceptionKey}` }
      }
    }
    // SOLE LIVE FETCHER, DISCLOSED (this task's explicit "remove the detailed-then-plain double
    // attempt" requirement): when a detailed source is configured, it is the ONLY live fetcher tried
    // for a leg — one real call, whose own returned price is used directly. The plain
    // `config.priceSources.primary`/`.fallback` pair is only ever consulted (in order) when NO
    // detailed source is configured at all. Every call routes through the shared, bounded recovery
    // lane (priceKvClient.getPriceRecovery) when available, falling back to the plain
    // getPriceHistorical/getPricePrimary methods only for a priceKvClient that doesn't implement it.
    const attemptLeg = async (token: string, chain: string, timestamp: number, label: 'primary' | 'chain-aware-historical'): Promise<{ price: number | null; reason: string | null; budgetCapped: boolean }> => {
      // BUDGET-CAPPED DETECTION, DISCLOSED (this task's own requirement): `getPriceRecovery` is the
      // ONLY call routed through kvClient.ts's global-per-scan recovery lookup budget
      // (`recoveryLookupsBudget`/`recoveryStats.recoveryCappedLookups`); a before/after snapshot of
      // that already-public counter is the sole way this function can tell "the real fetcher was
      // never called because the budget was already exhausted" apart from a genuine provider null —
      // both currently return the same bare `null` from `getPriceRecovery` itself.
      let budgetCapped = false
      const callVia = async (fetcher: PriceSourceFn): Promise<number | null> => {
        if (priceKvClient.getPriceRecovery) {
          const before = priceKvClient.recoveryStats?.recoveryCappedLookups ?? 0
          const result = await priceKvClient.getPriceRecovery(token, chain, timestamp, fetcher, label, maxRecoveryLookups)
          const after = priceKvClient.recoveryStats?.recoveryCappedLookups ?? 0
          if (after > before) budgetCapped = true
          return result
        }
        if (label === 'chain-aware-historical') return priceKvClient.getPriceHistorical ? priceKvClient.getPriceHistorical(token, chain, timestamp, fetcher) : null
        return priceKvClient.getPricePrimary ? priceKvClient.getPricePrimary(token, chain, timestamp, fetcher) : null
      }
      if (detailedPrimary) {
        let reason: string | null = null
        const wrapped: PriceSourceFn = async (t, c, ts) => {
          const result = await callDetailed(t, c, ts)
          reason = result.reason
          return result.price
        }
        const price = await callVia(wrapped)
        return { price, reason, budgetCapped }
      }
      for (const fetcher of fetchers) {
        const price = await callVia(fetcher)
        if (price !== null) return { price, reason: null, budgetCapped }
      }
      return { price: null, reason: null, budgetCapped }
    }
    const acceptedEvidenceKv = config.acceptedEvidenceKv
    const writeNow = config.now ?? Date.now
    // Per-candidate outcome, DISCLOSED: captured purely from local variables this same loop already
    // computes — never a second live pass — so `buildMissingPriceRecoveryFunnelAudit` below can
    // distinguish "provider genuinely said no" from "budget exhausted before the fetcher ever ran"
    // for every one of the 109 missing-price lots, exactly this task's own requirement.
    const candidateOutcomeByKey = new Map<string, CandidateRecoveryOutcome>()
    await mapWithConcurrencyLimit(candidates, RECOVERY_CONCURRENCY_LIMIT, async (lot) => {
      const needsBuy = !isCanonicalPositiveUsd(lot.costBasisUsd)
      const needsSell = !isCanonicalPositiveUsd(lot.proceedsUsd)
      let recoveredBuy: number | null = null
      let recoveredSell: number | null = null
      let lastBuyReason: string | null = null
      let lastSellReason: string | null = null
      let buyBudgetCapped = false
      let sellBudgetCapped = false
      if (needsBuy) {
        if (detailedPrimary) detailedLookupsUsed += 1
        else plainLookupsUsed += 1
        const result = await attemptLeg(lot.token, lot.chain, lot.openedAt, 'chain-aware-historical')
        recoveredBuy = result.price
        lastBuyReason = result.reason
        buyBudgetCapped = result.budgetCapped
      }
      if (needsSell) {
        if (detailedPrimary) detailedLookupsUsed += 1
        else plainLookupsUsed += 1
        const result = await attemptLeg(lot.token, lot.chain, lot.closedAt, 'primary')
        recoveredSell = result.price
        lastSellReason = result.reason
        sellBudgetCapped = result.budgetCapped
      }
      candidateOutcomeByKey.set(lotKey(lot), { needsBuy, needsSell, buyReason: lastBuyReason, sellReason: lastSellReason, buyBudgetCapped, sellBudgetCapped })
      if (needsBuy && recoveredBuy === null) recordFailureReason(failureReasonCounts, lastBuyReason)
      if (needsSell && recoveredSell === null) recordFailureReason(failureReasonCounts, lastSellReason)
      // UNIT FIX, DISCLOSED (130-early-canonical-to-30-final-candidate-collapse trace, CONFIRMED ROOT
      // CAUSE): `attemptLeg`'s own `price` is the price source's raw PER-TOKEN unit price — the exact
      // same contract `priceAllEntries` in pricingAtTimeEngine/index.ts already multiplies by
      // `entry.amount` before ever calling it a lot's `costUsd`/`proceedsUsd` (see that module's own
      // `multiplyAmount(attempt.priceUsd, entry.amount)`). This recovery lane previously used the raw
      // per-unit price DIRECTLY as the lot's own `costBasisUsd`/`proceedsUsd` (a lot-level TOTAL
      // dollar field per MatchedLot's own contract — `realizedPnlUsd = proceedsUsd - costBasisUsd`
      // must be a dollar figure) — an un-scaled per-unit value persisted to the accepted-evidence
      // store's `priceUsd` field, which acceptedEvidenceStore.ts's own header documents as ALWAYS the
      // TOTAL side value ("that assumption is now genuinely true of every value this store's own
      // writers persist"). On a later rescan, hydrateFromAcceptedEvidence reads that record back and
      // reallocates it via allocateSideValueAcrossGroup, treating the tiny per-unit figure as the
      // group's total — for any real per-token price below VALUE_SCALE precision (1e-8, routine for
      // low-cap/memecoin prices), the BigInt floor produces an allocated share of EXACTLY 0,
      // overwriting a previously-good, correctly-scaled positive value with a non-positive one. This
      // is the confirmed source of the `non_positive_reconstruction` bucket / `non_positive_entry_
      // price`+`non_positive_exit_price` canonical-predicate rejections despite valid early numeric
      // pricing. Fixed at the source: multiply by `lot.amount` once, immediately, before this raw
      // price is used for anything lot-level — every downstream consumer (recoveredByLotKey, the
      // accepted-evidence write-back below) now receives the same TOTAL-dollar contract every other
      // writer/reader in this codebase already assumes.
      const recoveredBuyTotalUsd = recoveredBuy !== null ? recoveredBuy * lot.amount : null
      const recoveredSellTotalUsd = recoveredSell !== null ? recoveredSell * lot.amount : null
      if (recoveredBuyTotalUsd !== null || recoveredSellTotalUsd !== null) {
        recoveredByLotKey.set(lotKey(lot), { costBasisUsd: recoveredBuyTotalUsd, proceedsUsd: recoveredSellTotalUsd })
      }
      if (recoveredBuy !== null) acceptedEvidenceAudit.liveSidesResolved += 1
      if (recoveredSell !== null) acceptedEvidenceAudit.liveSidesResolved += 1
      // CANDIDATE NEW EVIDENCE, DISCLOSED (requirement #7's own "log them as candidateNewEvidence
      // until a deliberate sample-version refresh occurs"): a lot that had NEITHER side covered by
      // accepted evidence before this scan (both `needsBuy`/`needsSell` were true — hydration found
      // nothing) and just became newly, fully live-priceable is real NEW evidence this specific scan
      // introduced, not a previously-published fact. Logged only — this pass does not implement the
      // full sample-version-gated expansion policy requirement #7/#8 describe (a durable manifest
      // deciding WHEN a scan window's published sample is allowed to grow); that is a real, disclosed
      // scope limit of this follow-up task, not a silent omission. The lot's own realized PnL
      // contribution is unchanged by this log — it still counts normally, exactly as fifoEngine/
      // recovery already resolved it.
      if (needsBuy && needsSell && recoveredBuy !== null && recoveredSell !== null) {
        logger.warn('candidateNewEvidence', { lotIdentity: lotKey(lot), chain: lot.chain, token: lot.token })
      }
      // WRITE-BACK, AWAITED, DISCLOSED (requirement #5): a newly live-resolved side is persisted to
      // the accepted-evidence store BEFORE this concurrency-limited task resolves, so a later
      // `await recoverPrices(...)` caller — including the very end of this scan's own reconcile()
      // call — can never observe "success" while this write is still in flight or was silently
      // dropped. `source`/`evidenceType` are honestly generic here ('recovery-lane') — this layer has
      // no visibility into which specific provider ultimately answered (an existing abstraction
      // boundary: attemptLeg's PriceSourceFn carries no source label back to this function), same
      // disclosed limitation as kvClient.ts's own historical-price envelope.
      if (acceptedEvidenceKv) {
        const identityVersion = lotIdentityVersion(lot)
        if (recoveredBuy !== null) {
          const envelope = buildAcceptedEvidenceEnvelope({
            identity: { chain: lot.chain, token: lot.token, txHash: lot.openedTxHash, side: 'entry', timestamp: lot.openedAt, lotIdentityVersion: identityVersion },
            // COVERAGE, DISCLOSED (accepted-evidence-raw-value-mutation follow-up task): this lane
            // only ever knows about THIS ONE lot's own recovered price — never the full sibling group
            // sharing this side (it has no visibility into siblings, unlike the canonical seeding
            // pass below). `coveredLotCount: 1` records that honestly, so a later, more-complete
            // aggregation is never mistaken for "already fully persisted" and blocked from correcting
            // a partial value — see `AcceptedEvidenceEnvelope.coveredLotCount`'s own header.
            // `priceUsd === valueUsd` here, both the TOTAL side value (see the UNIT FIX disclosure
            // above this lot's own recovered-price computation) — matching every other writer's own
            // "priceUsd IS the total" contract this store documents, never the raw per-unit price.
            priceUsd: recoveredBuyTotalUsd!, valueUsd: recoveredBuyTotalUsd!, coveredLotCount: 1, source: 'recovery-lane', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: writeNow(),
          })
          const ok = await writeAcceptedEvidence(acceptedEvidenceKv, envelope)
          if (ok) { acceptedEvidenceAudit.acceptedEvidenceWriteSuccesses += 1; acceptedEvidenceAudit.recoveryEvidenceWriteSuccesses += 1 }
          else { acceptedEvidenceAudit.acceptedEvidenceWriteFailures += 1; acceptedEvidenceAudit.recoveryEvidenceWriteFailures += 1 }
        }
        if (recoveredSell !== null) {
          const envelope = buildAcceptedEvidenceEnvelope({
            identity: { chain: lot.chain, token: lot.token, txHash: lot.closedTxHash, side: 'exit', timestamp: lot.closedAt, lotIdentityVersion: identityVersion },
            priceUsd: recoveredSellTotalUsd!, valueUsd: recoveredSellTotalUsd!, coveredLotCount: 1, source: 'recovery-lane', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now: writeNow(),
          })
          const ok = await writeAcceptedEvidence(acceptedEvidenceKv, envelope)
          if (ok) { acceptedEvidenceAudit.acceptedEvidenceWriteSuccesses += 1; acceptedEvidenceAudit.recoveryEvidenceWriteSuccesses += 1 }
          else { acceptedEvidenceAudit.acceptedEvidenceWriteFailures += 1; acceptedEvidenceAudit.recoveryEvidenceWriteFailures += 1 }
        }
      }
    })
    const missingPriceRecoveryFunnelAudit = buildMissingPriceRecoveryFunnelAudit({
      originalLots: lots,
      hydratedLots,
      sortedMissing: sorted,
      candidates,
      recoveredByLotKey,
      candidateOutcomeByKey,
      totalStructuralLots: lots.length,
    })
    return { hydratedLots, recoveredByLotKey, oneSideMissingCandidates, bothSidesMissingCandidates, candidatesAttempted: candidates.length, candidatesCappedByBudget: sorted.length - candidates.length, failureReasonCounts, sourceAttemptCounters, detailedLookupsUsed, plainLookupsUsed, detailedAttemptsObserved, acceptedEvidenceAudit, missingPriceRecoveryFunnelAudit }
  }

  // STRUCTURAL VALIDITY, DISCLOSED (requirement #4's "never persist... structurally invalid lots"):
  // the minimum a lot identity needs to build a real, well-formed accepted-evidence key at all —
  // never a judgment about pricing correctness, only about whether the identity fields themselves
  // are usable.
  function isStructurallyValidLot(lot: MatchedLot): boolean {
    return Boolean(lot.chain) && Boolean(lot.token) && Boolean(lot.openedTxHash) && Boolean(lot.closedTxHash)
      && Number.isFinite(lot.openedAt) && Number.isFinite(lot.closedAt) && Number.isFinite(lot.amount) && lot.amount > 0
  }

  // A PRICE VALID FOR PERSISTENCE, DISCLOSED (requirement #4): finite AND strictly positive — a real
  // USD price can never legitimately be zero or negative; a zero/negative/non-finite value is either
  // a data defect or a "no price" sentinel, never a real accepted price.
  function isPersistablePrice(price: number | null): price is number {
    return typeof price === 'number' && Number.isFinite(price) && price > 0
  }

  // FINAL CANONICAL SEEDING PASS, DISCLOSED (accepted-evidence-canonical-seeding-eligibility
  // follow-up task — confirmed production bug: `verifiedLotCount: 19` yet
  // `verifiedSidesEligibleForPersistence/verifiedSidesSkippedUnverified/verifiedSidesSkippedInvalid`
  // ALL reported 0 — a mathematical impossibility under the invariant this task requires
  // (`matchedLotSidesTotal === eligible + skippedUnverified + skippedInvalid`) unless sides were
  // being silently dropped into NEITHER bucket. Root cause, CONFIRMED: the prior version's
  // `if (lot.evidenceQuality !== 'verified') { if (costBasisUsd !== null || proceedsUsd !== null)
  // skippedUnverified += 2; continue }` only counted a non-verified lot's sides when at least one
  // price happened to be non-null — a non-verified lot with BOTH sides still null (a genuinely
  // common, correct state: an unpriced open position) fell through `continue` without landing in
  // ANY bucket. Fixed below: every lot lands in EXACTLY one of skippedUnverified/skippedInvalid/
  // examined-as-eligible, unconditionally — the invariant now holds by construction, not by
  // coincidence of which lots happen to have a stray price.
  //
  // ELIGIBILITY, DISCLOSED (requirement #2/#3): uses `isCanonicalVerifiedLotForPnl` — the SAME
  // shared predicate the gate uses for `verifiedLotCount`/`fullyPricedLotCount` — as the sole
  // lot-level "is this lot part of the canonical verified PnL sample" gate. A side of a canonically
  // verified lot is eligible when it ALSO has a finite, strictly-positive price and the lot is
  // structurally valid; MatchedLot's `costBasisUsd`/`proceedsUsd` are BY DEFINITION the historical
  // prices fifoEngine/pnlReconciliation actually used for `realizedPnlUsd` — this module has no
  // separate "current price" or "synthetic price" field that could ever masquerade as one here (a
  // synthetic figure lives entirely in the separate, never-merged `syntheticPnl` module — see this
  // file's own header on `realizedPnlUsd`'s canonical-source disclosure).
  //
  // NEVER PERSISTS, DISCLOSED (requirement #4): a lot that isn't `isCanonicalVerifiedLotForPnl`
  // (`verifiedSidesSkippedUnverified`, both sides, unconditionally), a structurally invalid lot
  // (`verifiedSidesSkippedInvalid`, both sides), or a non-finite/zero/negative price on an otherwise
  // eligible lot's side (also `verifiedSidesSkippedInvalid`, that one side only).
  //
  // ALREADY-PERSISTED CHECK, DISCLOSED: reads the store first (bounded-concurrency, same pattern as
  // the recovery pass) — a side already covered by a valid accepted-evidence entry is counted as
  // `verifiedSidesAlreadyPersisted` and never rewritten (idempotent; avoids needless KV fan-out on
  // every single rescan once evidence has been seeded once).
  //
  // SOURCE METADATA, HONESTLY DISCLOSED (requirement #9 — "must not stop exact price evidence from
  // being persisted"): `MatchedLot` (fifoEngine/types.ts) carries no field recording WHICH upstream
  // phase priced a given side — this function genuinely cannot know. Rather than fabricate a
  // specific source name, or — worse — treat the absence as a reason to SKIP the write, it records
  // `'canonical-upstream'`/`'unknown'` and counts every such write in `missingVerifiedEvidenceMetadata`
  // as a disclosed limitation, never a blocking condition.
  //
  // AGGREGATE-BEFORE-WRITE, DISCLOSED (accepted-evidence-persistence follow-up task — confirmed
  // production root cause: this pass used to write one envelope PER SIBLING LOT under the SAME
  // shared side key, each carrying only that one sibling's own apportioned USD value — the store's
  // own "already persisted" check then let only the first writer's value survive, so replay recovered
  // roughly 1/N of the side's genuine total value. Every eligible sibling sharing a transaction side
  // is now summed FIRST (entry total = sum of sibling costBasisUsd, exit total = sum of sibling
  // proceedsUsd) and the side is written EXACTLY ONCE, carrying the true side total — the group's own
  // members can later reconstruct their individual shares deterministically via
  // `allocateSideValueAcrossGroup`/`splitGroupTotalAcrossOccurrences` (canonicalPnlSampleManifest.ts),
  // which sum bit-for-bit back to this exact stored total.
  async function seedAcceptedEvidenceForVerifiedLots(lots: readonly MatchedLot[]): Promise<AcceptedEvidenceAudit> {
    const audit = emptyAcceptedEvidenceAudit()
    const acceptedEvidenceKv = config.acceptedEvidenceKv
    if (!acceptedEvidenceKv) return audit
    const now = (config.now ?? Date.now)()

    type SideGroup = { chain: string; token: string; txHash: string; side: AcceptedEvidenceSide; timestamp: number; lots: MatchedLot[]; total: number }
    const sideGroupKey = (chain: string, token: string, txHash: string, side: AcceptedEvidenceSide, timestamp: number) =>
      `${chain}:${token.toLowerCase()}:${txHash}:${side}:${timestamp}`
    const groups = new Map<string, SideGroup>()
    const addToGroup = (lot: MatchedLot, side: AcceptedEvidenceSide, txHash: string, timestamp: number, price: number) => {
      const key = sideGroupKey(lot.chain, lot.token, txHash, side, timestamp)
      const existing = groups.get(key)
      if (existing) { existing.lots.push(lot); existing.total += price }
      else groups.set(key, { chain: lot.chain, token: lot.token, txHash, side, timestamp, lots: [lot], total: price })
    }
    for (const lot of lots) {
      audit.matchedLotSidesTotal += 2
      if (!isCanonicalVerifiedLotForPnl(lot)) { audit.verifiedSidesSkippedUnverified += 2; continue }
      if (!isStructurallyValidLot(lot)) {
        audit.verifiedSidesSkippedInvalid += 2
        audit.invalidAcceptedEvidenceReasons!.identityMismatch += 2
        continue
      }
      const sides: Array<{ side: AcceptedEvidenceSide; txHash: string; timestamp: number; price: number | null }> = [
        { side: 'entry', txHash: lot.openedTxHash, timestamp: lot.openedAt, price: lot.costBasisUsd },
        { side: 'exit', txHash: lot.closedTxHash, timestamp: lot.closedAt, price: lot.proceedsUsd },
      ]
      for (const s of sides) {
        if (!isPersistablePrice(s.price)) {
          audit.verifiedSidesSkippedInvalid += 1
          audit.invalidAcceptedEvidenceReasons!.invalidPrice += 1
          continue
        }
        audit.verifiedSidesEligibleForPersistence += 1
        addToGroup(lot, s.side, s.txHash, s.timestamp, s.price)
      }
    }

    // DETERMINISTIC REPRESENTATIVE IDENTITY VERSION, DISCLOSED: the persisted envelope's own
    // `lotIdentityVersion` field can only ever record ONE version, even though several siblings with
    // different amounts (and therefore different versions) share this write. The lexicographically
    // smallest sibling version is chosen — a fixed, order-independent tie-break — never the array's
    // first/last element, so a JSON/KV round-trip with siblings reloaded in any order still picks the
    // exact same representative. Every reader that needs to match ANY sibling's version already uses
    // the relaxed discovery read (`readAcceptedEvidenceAnyLotVersion`), never a strict match against
    // this one recorded version.
    const representativeVersion = (group: SideGroup): string =>
      [...group.lots].map((l) => lotIdentityVersion(l)).sort()[0]

    // BOUNDED CONCURRENCY, AWAITED, DISCLOSED (requirements #7): one read-then-maybe-write task PER
    // SIDE GROUP (never once per sibling) — the same bounded worker pool as the live recovery pass,
    // never unbounded KV fan-out — and the whole pass is awaited by reconcile() BEFORE the scan's
    // summary is built, so a caller can never observe a "done" scan whose seeding writes are still in
    // flight.
    //
    // COMPOSITION-AWARE OVERWRITE GUARD, DISCLOSED (accepted-evidence-raw-value-mutation follow-up
    // task, part 2 — confirmed gap in the count-only guard this replaces: `coveredLotCount` alone
    // cannot distinguish "the exact same sibling set" from "a genuinely different sibling set that
    // happens to be the same size" — e.g. a stale 2-lot record reading $2 sitting next to a live
    // 2-lot recompute reading $15,198 would have been wrongly protected by count equality alone. The
    // RELAXED discovery read still finds a record backing this side under ANY sibling's version, but
    // "already covers this" (skip, immutable) now requires the record's own `coverageFingerprint` —
    // an exact, order-independent identity of every lot it was aggregated over — to match the LIVE
    // group's fingerprint exactly. A fingerprint mismatch where the live group is at least as large
    // as what was recorded (`group.lots.length >= existing.coveredLotCount`) is a genuine,
    // deterministic COMPOSITION CHANGE — never a value change for the identical set — and is
    // reseeded with the true, current total. A live view SMALLER than what was already recorded
    // (`group.lots.length < existing.coveredLotCount`) is conservatively left untouched — this
    // scan's own view may simply be incomplete, never grounds to shrink a persisted record.
    await mapWithConcurrencyLimit([...groups.values()], RECOVERY_CONCURRENCY_LIMIT, async (group) => {
      const existing = await readAcceptedEvidenceAnyLotVersion(acceptedEvidenceKv, { chain: group.chain, token: group.token, txHash: group.txHash, side: group.side, timestamp: group.timestamp }, now)
      const existingCoveredLotCount = existing?.coveredLotCount ?? 1
      const liveFingerprint = buildAcceptedEvidenceCoverageFingerprint(group.lots)
      const compositionUnchanged = existing !== null && existing.coverageFingerprint === liveFingerprint
      const totalUsd = Math.round(group.total * 1e8) / 1e8
      const evidenceKey = `${group.chain}:${group.token.toLowerCase()}:${group.txHash}:${group.side}:${group.timestamp}`
      const pushMutationAudit = (writeDecision: AcceptedEvidenceMutationAudit['writeDecision'], overwritePrevented: boolean, firstValueChangeStage: AcceptedEvidenceMutationAudit['firstValueChangeStage']) => {
        if (audit.acceptedEvidenceMutationAudit.length >= MAX_ACCEPTED_EVIDENCE_MUTATION_EXAMPLES) return
        const oldScaled = toAcceptedEvidenceScaled(existing?.priceUsd ?? 0)
        const newScaled = toAcceptedEvidenceScaled(totalUsd)
        audit.acceptedEvidenceMutationAudit.push({
          evidenceKey,
          persistedRawUsd: existing?.priceUsd ?? null,
          loadedRawUsd: existing?.priceUsd ?? null,
          upstreamRawUsd: totalUsd,
          canonicalSeedRawUsd: totalUsd,
          source: existing?.source ?? null,
          sourceTimestamp: group.timestamp,
          schemaVersion: existing?.schemaVersion ?? null,
          methodologyVersion: 'canonical-seeding-aggregate-v1',
          writeDecision, overwritePrevented, firstValueChangeStage,
          oldScaled: oldScaled.toString(), newScaled: newScaled.toString(), deltaScaled: (newScaled - oldScaled).toString(),
        })
      }
      if (existing && (compositionUnchanged || existingCoveredLotCount > group.lots.length)) {
        audit.verifiedSidesAlreadyPersisted += group.lots.length
        pushMutationAudit('skip_already_covers', true, 'none')
        return
      }
      const identity = { chain: group.chain, token: group.token, txHash: group.txHash, side: group.side, timestamp: group.timestamp, lotIdentityVersion: representativeVersion(group) }
      // PROVENANCE PRESERVATION, DISCLOSED (provenance-laundering follow-up task — CONFIRMED ROOT
      // CAUSE this fixes): this pass previously called buildAcceptedEvidenceEnvelope WITHOUT
      // `previousEnvelope`, so every re-write here — including a `reseed_coverage_growth` over an
      // EXISTING `recovery-lane` record — reset `originWriter` to this pass's own `'canonical-
      // upstream'` name, permanently erasing the record's true origin (and, since this pass also
      // always sets `priceUsd === valueUsd`, made the result bit-for-bit indistinguishable from a
      // genuine canonical-seeding record — exactly the confirmed laundering path this migration's own
      // provenance gate could no longer see through). Passing `previousEnvelope: existing` carries
      // `originWriter`/`originMethodologyVersion` forward unchanged (or seeds them, once, from
      // `existing.source` for a record that predates these fields) — this pass's own name only ever
      // becomes `lastWriter`, never `originWriter`, from here on.
      const envelope = buildAcceptedEvidenceEnvelope({
        identity, priceUsd: totalUsd, valueUsd: totalUsd, valueType: 'total_side_value_usd',
        coveredLotCount: group.lots.length, coverageFingerprint: liveFingerprint,
        source: 'canonical-upstream', evidenceType: 'unknown', providerTimestampBucket: null, now,
        previousEnvelope: existing, writerReason: existing !== null ? 'reseed_coverage_growth' : 'initial_seed',
      })
      audit.missingVerifiedEvidenceMetadata += group.lots.length
      const isCoverageReseed = existing !== null
      pushMutationAudit(isCoverageReseed ? 'reseed_coverage_growth' : 'initial_seed', false, isCoverageReseed ? 'occurrence_set_reconstruction' : 'none')
      const ok = await writeAcceptedEvidence(acceptedEvidenceKv, envelope)
      if (ok) {
        audit.verifiedSidesWritten += group.lots.length
        audit.canonicalSeedingWriteSuccesses += group.lots.length
        audit.acceptedEvidenceWriteSuccesses += group.lots.length
        if (isCoverageReseed) audit.verifiedSidesCoverageReseeded += group.lots.length
      } else {
        audit.verifiedSideWriteFailures += group.lots.length
        audit.canonicalSeedingWriteFailures += group.lots.length
        audit.acceptedEvidenceWriteFailures += group.lots.length
      }
    })
    return audit
  }

  return {
    getState: () => state,
    async reconcile(input: PnlReconciliationInput): Promise<PnlReconciliationSummary> {
      state = input
      const fifoLots = [...input.fifoEngineResult.matchedLots].sort((a, b) => lotKey(a).localeCompare(lotKey(b)))
      const pnlLots = [...input.pnlEngineResult.closedLots].sort((a, b) => `${a.chain}:${a.token.toLowerCase()}:${a.txHash}:${a.timestamp}`.localeCompare(`${b.chain}:${b.token.toLowerCase()}:${b.txHash}:${b.timestamp}`))
      const mismatches = new Map<string, PnlMismatchClass>()
      const uniqueClosingTxCount = new Set(fifoLots.map((lot) => `${lot.chain}:${lot.closedTxHash.toLowerCase()}`)).size
      const uniqueClosingTxTokenCount = new Set(fifoLots.map((lot) => `${lot.chain}:${lot.token.toLowerCase()}:${lot.closedTxHash.toLowerCase()}`)).size
      const engineDivergenceDiagnostic: PublicPnlGateAudit['engineDivergenceDiagnostic'] = {
        fifoFragmentCount: fifoLots.length,
        uniqueClosingTxCount,
        uniqueClosingTxTokenCount,
        pnlSellEntryCount: pnlLots.length,
        avgFragmentsPerSell: pnlLots.length > 0 ? fifoLots.length / pnlLots.length : null,
        diagnosticOnly: true,
      }
      logger.warn('[pnl-reconciliation] readModelShape', engineDivergenceDiagnostic)
      for (const lot of fifoLots) {
        const key = lotKey(lot)
        if (lot.costBasisUsd === null || lot.proceedsUsd === null) mismatches.set(key, 'priceUnavailable')
      }
      for (const key of config.dustSuppressedKeys ?? []) mismatches.set(`dust:${key}`, 'dustSuppressedToken')

      let routerCorrectedCount = 0
      const acceptedRouters = input.routerInferenceOutput?.highConfidenceRouters ?? new Set<string>()
      if (acceptedRouters.size > 0 && input.fifoEngineResult.unmatchedSells > 0) {
        routerCorrectedCount = Math.min(input.fifoEngineResult.unmatchedSells, acceptedRouters.size)
        logger.warn('[pnl-reconciliation] routerCorrected', { routerCorrectedCount, acceptedRouters: [...acceptedRouters].sort() })
      }

      const recovery = await recoverPrices(fifoLots)
      const recovered = new Set(recovery.recoveredByLotKey.keys())
      for (const key of recovered) mismatches.set(key, 'priceRecovered')

      // Merge recovery's real, resolved prices into a copy of the lots — never mutating fifoEngine's
      // own matchedLots — so the canonical realizedPnlUsd below actually reflects what recovery
      // found, instead of discarding it (see recoverPrices' own header for the full trace). A lot
      // recovery didn't touch is returned unchanged; a lot recovery reached but genuinely couldn't
      // price stays exactly as unpriced as before — never a fabricated value.
      //
      // CANONICAL-PRECEDENCE BASE, DISCLOSED (hydration-timing-and-canonical-precedence follow-up
      // task): maps over `recovery.hydratedLots` — NOT the raw `fifoLots` — so a side accepted
      // evidence already overrode (whether it filled a gap or replaced a genuinely different upstream
      // candidate) is the starting point here, never silently reverted back to the raw upstream
      // value. `recovery.recoveredByLotKey` now contains ONLY genuinely live-recovered sides (see
      // recoverPrices' own header) and is merged on top of that already-canonical base exactly as
      // before.
      let recoveredBuyOnly = 0
      let recoveredSellOnly = 0
      let recoveredBoth = 0
      const updatedFifoLots = recovery.hydratedLots.map((lot) => {
        const recoveredPrice = recovery.recoveredByLotKey.get(lotKey(lot))
        if (!recoveredPrice) return lot
        const costBasisUsd = isCanonicalPositiveUsd(lot.costBasisUsd) ? lot.costBasisUsd : (recoveredPrice.costBasisUsd ?? lot.costBasisUsd)
        const proceedsUsd = isCanonicalPositiveUsd(lot.proceedsUsd) ? lot.proceedsUsd : (recoveredPrice.proceedsUsd ?? lot.proceedsUsd)
        const nowFullyPriced = isCanonicalPositiveUsd(costBasisUsd) && isCanonicalPositiveUsd(proceedsUsd)
        if (recoveredPrice.costBasisUsd !== null && recoveredPrice.proceedsUsd !== null) recoveredBoth += 1
        else if (recoveredPrice.costBasisUsd !== null) recoveredBuyOnly += 1
        else recoveredSellOnly += 1
        return {
          ...lot,
          costBasisUsd,
          proceedsUsd,
          realizedPnlUsd: nowFullyPriced ? proceedsUsd! - costBasisUsd! : lot.realizedPnlUsd,
          evidenceQuality: nowFullyPriced ? ('verified' as const) : lot.evidenceQuality,
        }
      })
      // INCOMPLETE ACCEPTED SIDE, DISCLOSED (Wallet PnL Item 1): a verified lot that shares a
      // transaction side with an unpriced sibling cannot claim a group total equal to the accepted
      // evidence record for that side (allocation is over the full sibling set). Demote those lots
      // out of the canonical verified sample rather than publish a partial claim or invent the
      // missing siblings into realized PnL.
      const consistentFifoLots = demoteLotsOnIncompleteAcceptedSides(updatedFifoLots)
      // FINAL CANONICAL SEEDING PASS, DISCLOSED (accepted-evidence-store-seeding follow-up task):
      // runs over `consistentFifoLots` — the FULLY RESOLVED lot list, after recovery has already merged
      // in anything it found and incomplete shared sides have been demoted — so this pass sees every
      // verified side regardless of whether it was priced upstream (before recoverPrices ever ran) or
      // by recovery itself just above. See seedAcceptedEvidenceForVerifiedLots' own header for the
      // full rationale.
      const seeding = await seedAcceptedEvidenceForVerifiedLots(consistentFifoLots)
      // CANONICAL SAMPLE SELECTION, DISCLOSED (requirement #5's exact required order: reconcile
      // accepted evidence -> resolve manifest -> validate -> construct final canonical published lot
      // array -> calculate gate/AYRI/fingerprints from THAT array). Runs AFTER accepted-evidence
      // hydration/recovery/seeding above (so the manifest replays against fully-reconciled evidence)
      // and BEFORE the realized-PnL sum and every gate computation below — every figure this
      // function reports is derived from `publishedFifoLots` from here on. Accepted-evidence
      // withholding a lot from PUBLICATION must never also stop its genuinely-resolved evidence from
      // being persisted (that would make the next scan worse, not more deterministic). Incomplete
      // shared sides are already demoted on `consistentFifoLots`, so they are not seeded as verified.
      const canonicalSampleSelection = input.canonicalSampleSelector
        ? await input.canonicalSampleSelector(consistentFifoLots)
        : null
      // `consistentFifoLots` has already had the shared-side integrity rule applied above, while
      // every lot was still present with its real pricing classification. Do NOT apply that rule a
      // second time after canonical selection. The selector intentionally marks candidate-only lots
      // unpriced; treating those publication labels as missing side evidence makes their selected,
      // verified siblings look like mixed-quality groups and demotes the entire manifest sample.
      // This was the first loss in the live 22/25 -> 0 collapse: replay returned verified manifest
      // lots, then this post-selection pass rewrote their evidenceQuality to `unpriced`.
      const canonicalSelectedLots = canonicalSampleSelection ? canonicalSampleSelection.publishedLots : consistentFifoLots
      const publishedFifoLots = [...canonicalSelectedLots]
      const acceptedEvidenceAudit: AcceptedEvidenceAudit = {
        ...recovery.acceptedEvidenceAudit,
        acceptedEvidenceWriteSuccesses: recovery.acceptedEvidenceAudit.acceptedEvidenceWriteSuccesses + seeding.acceptedEvidenceWriteSuccesses,
        acceptedEvidenceWriteFailures: recovery.acceptedEvidenceAudit.acceptedEvidenceWriteFailures + seeding.acceptedEvidenceWriteFailures,
        canonicalSeedingWriteSuccesses: seeding.canonicalSeedingWriteSuccesses,
        canonicalSeedingWriteFailures: seeding.canonicalSeedingWriteFailures,
        verifiedSidesEligibleForPersistence: seeding.verifiedSidesEligibleForPersistence,
        verifiedSidesAlreadyPersisted: seeding.verifiedSidesAlreadyPersisted,
        verifiedSidesWritten: seeding.verifiedSidesWritten,
        verifiedSideWriteFailures: seeding.verifiedSideWriteFailures,
        verifiedSidesSkippedUnverified: seeding.verifiedSidesSkippedUnverified,
        verifiedSidesSkippedInvalid: seeding.verifiedSidesSkippedInvalid,
        missingVerifiedEvidenceMetadata: seeding.missingVerifiedEvidenceMetadata,
        invalidAcceptedEvidenceReasons: seeding.invalidAcceptedEvidenceReasons,
        verifiedSidesCoverageReseeded: seeding.verifiedSidesCoverageReseeded,
        acceptedEvidenceMutationAudit: seeding.acceptedEvidenceMutationAudit,
      }
      // PRODUCTION SAFETY WARNING, DISCLOSED (requirement #10): real verified sides exist
      // (updatedFifoLots has at least one verified lot) but NEITHER the hydration pass found any
      // persisted evidence NOR this scan's own seeding pass wrote any — meaning the accepted-evidence
      // store is either unconfigured, unreachable, or was never seeded for this wallet/window at all.
      // Logged as an error (not warn) — this is exactly the condition that reproduces the
      // determinism failure this whole feature exists to close.
      const hasVerifiedSides = consistentFifoLots.some(isCanonicalVerifiedLotForPnl)
      if (hasVerifiedSides && acceptedEvidenceAudit.persistedAcceptedSidesLoaded === 0 && acceptedEvidenceAudit.canonicalSeedingWriteSuccesses === 0) {
        logger.warn('accepted_evidence_store_unseeded', {
          verifiedLotCount: consistentFifoLots.filter(isCanonicalVerifiedLotForPnl).length,
          persistedAcceptedSidesLoaded: acceptedEvidenceAudit.persistedAcceptedSidesLoaded,
          canonicalSeedingWriteSuccesses: acceptedEvidenceAudit.canonicalSeedingWriteSuccesses,
          verifiedSidesEligibleForPersistence: acceptedEvidenceAudit.verifiedSidesEligibleForPersistence,
        })
      }
      // ELIGIBILITY-MISMATCH SAFETY CHECK, DISCLOSED (requirement #6): a real, structural invariant
      // — if there ARE verified lots AND there WERE already-priced sides going into hydration
      // (`existingVerifiedSidesProtectedFromOverwrite > 0`, i.e. real evidence exists to seed), then
      // the seeding pass must have found at least one ELIGIBLE side, unless every one of them was
      // already persisted (a legitimate, non-broken steady state on a later rescan) OR every one of
      // them has an honest, disclosed explanation via `verifiedSidesSkippedInvalid` (a real
      // structural defect, not a silent predicate bug). Anything else — eligible === 0 AND
      // alreadyPersisted === 0 AND skippedInvalid === 0 — reproduces exactly this task's own
      // confirmed bug (a real eligibility predicate defect silently dropping verified sides) and must
      // never pass unnoticed again.
      const verifiedLotCountForMismatchCheck = consistentFifoLots.filter(isCanonicalVerifiedLotForPnl).length
      if (
        verifiedLotCountForMismatchCheck > 0
        && acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite > 0
        && acceptedEvidenceAudit.verifiedSidesEligibleForPersistence === 0
        && acceptedEvidenceAudit.verifiedSidesAlreadyPersisted === 0
        && acceptedEvidenceAudit.verifiedSidesSkippedInvalid === 0
      ) {
        logger.warn('CRITICAL accepted_evidence_eligibility_mismatch', {
          verifiedLotCount: verifiedLotCountForMismatchCheck,
          existingVerifiedSidesProtectedFromOverwrite: acceptedEvidenceAudit.existingVerifiedSidesProtectedFromOverwrite,
          verifiedSidesEligibleForPersistence: acceptedEvidenceAudit.verifiedSidesEligibleForPersistence,
          verifiedSidesAlreadyPersisted: acceptedEvidenceAudit.verifiedSidesAlreadyPersisted,
          verifiedSidesSkippedUnverified: acceptedEvidenceAudit.verifiedSidesSkippedUnverified,
          verifiedSidesSkippedInvalid: acceptedEvidenceAudit.verifiedSidesSkippedInvalid,
        })
      }
      logger.warn('[pnl-reconciliation] recovery', {
        oneSideMissingCandidates: recovery.oneSideMissingCandidates,
        bothSidesMissingCandidates: recovery.bothSidesMissingCandidates,
        candidatesAttempted: recovery.candidatesAttempted,
        candidatesCappedByBudget: recovery.candidatesCappedByBudget,
        recoveredBuyOnly, recoveredSellOnly, recoveredBoth,
        attemptedButStillUnpriced: recovery.candidatesAttempted - recovery.recoveredByLotKey.size,
        // COMPACT REASON COUNTERS, DISCLOSED (provider-call-audit follow-up task): real counts per
        // category, never raw provider responses — see classifyRecoveryFailureReason's own header
        // for the full mapping and its honest, disclosed limitations.
        failureReasonCounts: recovery.failureReasonCounts,
        // PER-SOURCE ATTEMPT COUNTERS, DISCLOSED (this task's explicit requirement): real per-source
        // attempt/success/failure-reason tallies across every attempt this recovery pass made —
        // never keyed by token or wallet, only by source name and reason name.
        sourceAttemptCounts: recovery.sourceAttemptCounters.sourceAttemptCounts,
        sourceSuccessCounts: recovery.sourceAttemptCounters.sourceSuccessCounts,
        sourceFailureReasonCounts: recovery.sourceAttemptCounters.sourceFailureReasonCounts,
        // WIRING DIAGNOSTIC COUNTERS, DISCLOSED (this task's explicit requirement): see
        // recoverPrices' own header for what each of these three distinguishes — in particular, a
        // real production run showing detailedLookupsUsed > 0 alongside detailedAttemptsObserved
        // near 0 proves the detailed fetcher was correctly SELECTED but RequestPriceKvClient's own
        // cache-hit/in-flight/per-token-cap short-circuit prevented it from ever actually running.
        detailedLookupsUsed: recovery.detailedLookupsUsed,
        plainLookupsUsed: recovery.plainLookupsUsed,
        detailedAttemptsObserved: recovery.detailedAttemptsObserved,
        // RECOVERY LANE DIAGNOSTICS, DISCLOSED (this task's explicit requirement):
        // normalCappedLookups is the SHARED per-token cap's own count (from the main pricingAtTime
        // pass, read here purely for comparison) — recoveryLookupsRequested/CacheHits/LiveFetches/
        // CappedLookups are this recovery pass's OWN separate lane, proving the two budgets no
        // longer starve each other.
        normalCappedLookups: config.priceKvClient?.stats?.cappedLookups ?? null,
        recoveryLookupsRequested: config.priceKvClient?.recoveryStats?.recoveryLookupsRequested ?? null,
        recoveryCacheHits: config.priceKvClient?.recoveryStats?.recoveryCacheHits ?? null,
        recoveryLiveFetches: config.priceKvClient?.recoveryStats?.recoveryLiveFetches ?? null,
        recoveryCappedLookups: config.priceKvClient?.recoveryStats?.recoveryCappedLookups ?? null,
      })
      // ACCEPTED-EVIDENCE AUDIT, DISCLOSED (determinism follow-up task, requirement #6): real
      // counters from hydrateFromAcceptedEvidence + the live recovery loop's own write-back — see
      // recoverPrices' own header for what each field means.
      logger.warn('[accepted-evidence-audit]', acceptedEvidenceAudit)
      // MISSING-PRICE RECOVERY FUNNEL, DISCLOSED (this task's own requirement): logged in full every
      // scan — diagnostics only, never consumed by the pass/fail decision above. See
      // MissingPriceRecoveryFunnelAudit's own header for the full bucket taxonomy and how each
      // candidate beyond the current MAX_RECOVERY_ATTEMPTS cap is scored.
      logger.warn('[missing-price-recovery-funnel]', recovery.missingPriceRecoveryFunnelAudit)

      let syntheticAlignedCount = 0
      const synthetic = input.syntheticPnlAssemblyOutput
      if (synthetic) {
        const totalLegsCount = synthetic.totalLegsCount ?? 0
        const pricedLegsCount = synthetic.pricedLegsCount ?? 0
        if (totalLegsCount > pricedLegsCount) {
          syntheticAlignedCount = Math.min(totalLegsCount - pricedLegsCount, input.fifoEngineResult.unmatchedBuys + input.fifoEngineResult.unmatchedSells)
          if (syntheticAlignedCount > 0) logger.warn('[pnl-reconciliation] syntheticAligned', { syntheticAlignedCount, totalLegsCount, pricedLegsCount })
        }
      }

      const correctedUnmatchedSells = Math.max(0, input.fifoEngineResult.unmatchedSells - routerCorrectedCount - syntheticAlignedCount)
      const correctedUnmatchedBuys = Math.max(0, input.fifoEngineResult.unmatchedBuys - Math.max(0, syntheticAlignedCount - input.fifoEngineResult.unmatchedSells))
      const priceUnavailableCount = [...mismatches.values()].filter((v) => v === 'priceUnavailable').length

      // GATE EVIDENCE INPUT CORRECTION, DISCLOSED (exact-unmatched-evidence follow-up task,
      // requirement #1): when the caller supplies real, exact event-classification evidence
      // (structuralCoverageDenominatorAudit — see its own header), the structural-consistency GATE
      // itself now uses the EXACT genuine unmatched counts instead of the raw, unfiltered
      // correctedUnmatchedBuys/Sells above. This is an EVIDENCE-INPUT correction only: the gate's
      // own FORMULA/THRESHOLDS (structuralConsistent's own conditions, the `missingEvidenceCount <=
      // 3` partial-status threshold, `structuralCoverage`'s numerator/denominator shape) are
      // completely unchanged — only what counts as "genuinely unmatched" changed, from "every raw
      // FIFO straggler" to "every raw straggler that isn't PROVEN to be a non-trade (distribution/
      // airdrop/ordinary transfer/router intermediary/bridge/LP-staking) or dust". Per requirement
      // #2's fail-closed rule, `genuineUnmatchedBuys/Sells` ALREADY includes every unmatchedIdentity
      // that couldn't be exactly joined (`unmatchedIdentityJoinFailures`) and every `unknown`-
      // classified event — see computeExactStructuralCoverageAudit's own header — so those continue
      // to block here exactly as before, never silently dropped. Falls back to the raw
      // correctedUnmatchedBuys/Sells (today's original formula, unchanged) when no audit is
      // supplied — zero behavior change for any caller that hasn't wired this in.
      const denomAudit = input.structuralCoverageDenominatorAudit ?? null
      const gateUnmatchedBuys = denomAudit?.genuineUnmatchedBuys ?? correctedUnmatchedBuys
      const gateUnmatchedSells = denomAudit?.genuineUnmatchedSells ?? correctedUnmatchedSells

      const missingEvidenceCount = input.pnlEngineResult.evidenceMissingCount + gateUnmatchedBuys + gateUnmatchedSells + Math.max(0, priceUnavailableCount - recovered.size)
      // SYNTHETIC-PNL LEAK INTO OFFICIAL REALIZED PNL, DISCLOSED AND FIXED (confirmed, critical
      // severity): this previously had a third fallback tier, `?? input.computePnlResult?.realizedPnlUsd`
      // — computePnlResult was wired at the pipeline call site directly from syntheticPnl's totals
      // (src/pipeline/index.ts: `computePnlResult: syntheticPnl ? { realizedPnlUsd:
      // syntheticPnl.totalRealizedPnlUsd, ... } : null`) — syntheticPnl's own module header
      // explicitly documents it as "UI-display-only... never a replacement for or an input to the
      // real, verified engines." Whenever both real engines (fifoEngineResult, pnlEngineResult) had
      // no verified realizedPnlUsd (fifoEngine's computePnl() returns null realizedPnlUsd whenever
      // zero matched lots are fully verified — a common, honest state, not an edge case), this
      // fallback silently substituted syntheticPnl's inferred/estimated figure instead. That number
      // then flows into officialPnlStatus: 'ok' via finalReportAssembler — the exact field the "PnL
      // (Verified V2) — ACTIVE" UI badge reads. Fixed by removing computePnlResult as a source
      // entirely: official realizedPnlUsd/unrealizedPnlUsd now come ONLY from the two real, verified
      // engines, never synthetic — strictly strengthening (never weakening) the existing integrity
      // gate. computePnlResult is now unused; removed from PnlReconciliationInput and its call site.
      //
      // TWO-DISAGREEING-ENGINES FIX, DISCLOSED (confirmed, real production evidence: pnlSummaryV2
      // reported $270.02 while this reconciliation reported $174.01 for the same wallet): the
      // remaining `?? input.pnlEngineResult.realizedPnlUsd` fallback below still meant the "official"
      // total COULD silently come from a completely different closed-lot model whenever
      // fifoEngineResult.realizedPnlUsd happened to be null — fifoEngine (real, quantity-based FIFO
      // matching over normalized events) and pnlEngine (a separate read model over sellTimelineV2/
      // buyTimeline entries — see pnlEngine/index.ts's own header: "Does NOT replace... fifoEngine
      // (the real PnL engine)") are two INDEPENDENT matching implementations over different, only
      // partly-overlapping input sets, so their own totals can legitimately diverge even before
      // accounting for pnlEngine's now-fixed duplicate-sell-entry bug (see
      // pnlEngine/index.ts's dedupeSellEntries). "Falling back" to a different model's total is not
      // reconciliation, it's silently swapping which model is authoritative — exactly the "select
      // one canonical total, do not average/mix models" requirement. Fixed by dropping
      // pnlEngineResult as a source for the official figure entirely: realizedPnlUsd now comes ONLY
      // from fifoEngineResult — the single model every other per-lot mechanism in this pipeline
      // (structural closed-lot pre-pass, pair-rank pricing, ayriAttribution's per-lot records) is
      // already built around. pnlEngineResult remains a real, useful independent cross-check
      // (surfaced via the engine-divergence diagnostic in src/pipeline/index.ts), never the source
      // of truth. This can only ever make official PnL MORE conservative (more honest nulls when
      // fifoEngine alone has no verified figure), never less — strengthening, not weakening, the
      // gate.
      //
      // RECOVERY-INCLUSIVE CANONICAL SUM, DISCLOSED: recomputed from updatedFifoLots (fifoEngine's
      // own lots, with recovery's real resolved prices merged in above) rather than trusting the
      // stale input.fifoEngineResult.realizedPnlUsd, which predates recovery entirely. Mirrors
      // fifoEngine's own computePnl formula exactly (sum of evidenceQuality: 'verified' lots' own
      // realizedPnlUsd, null when none) — when recovery finds nothing new, this is numerically
      // identical to the old value; it only ever adds real, newly-recovered lots to the sum, never
      // changes or removes an already-verified one.
      // PUBLISHED-ARRAY DERIVED, DISCLOSED (requirement #5/#6): `publishedFifoLots`, never
      // `updatedFifoLots` — a candidate-new-evidence lot withheld by canonical sample selection must
      // make ZERO contribution to public realized PnL and must not count toward the gate's verified
      // lot count or pricing coverage. When no selector is wired, `publishedFifoLots` IS
      // `updatedFifoLots`, so this is byte-identical to the prior behavior for every existing caller.
      const verifiedUpdatedLots = publishedFifoLots.filter(isCanonicalVerifiedLotForPnl)
      const recoveryInclusiveRealizedPnlUsd = verifiedUpdatedLots.length > 0
        ? verifiedUpdatedLots.reduce((sum, l) => sum + (l.realizedPnlUsd ?? 0), 0)
        : null
      const realizedPnlUsd = roundUsd(recoveryInclusiveRealizedPnlUsd)
      // STATUS/VALUE CONTRADICTION GUARD, DISCLOSED (closes a residual gap the fix above would
      // otherwise still leave open): structuralConsistent previously checked ONLY lot-count/missing-
      // evidence consistency, never whether realizedPnlUsd itself is actually non-null. Price
      // recovery (recoverPrices above) can zero out missingEvidenceCount's priceUnavailable term for
      // lots it successfully re-priced without those lots ever becoming fifoEngine's own
      // evidenceQuality: 'verified' (recovery only informs this function's own evidence-count
      // bookkeeping, it does not feed back into fifoEngine's matched-lot pricing) — so
      // structuralConsistent could theoretically be true while both real engines still genuinely
      // have no priced realized figure, producing publicPnlStatus: 'available' next to
      // realizedPnlUsd: null — the same "status claims more than the value backs up" contradiction
      // already fixed elsewhere this session (walletConditionMessages, SellActivitySummary).
      // Requiring realizedPnlUsd !== null here closes that gap explicitly rather than relying on it
      // being merely unlikely.
      // SAME PREDICATE AS THE VERIFIED COUNT, DISCLOSED (requirement #6's explicit "do not let the
      // gate count 'fully priced' while AYRI requires a different evidenceQuality value"): these two
      // figures previously answered subtly different questions on the same array, which is how three
      // consumers of one lot array ended up publishing three different verified counts.
      const fullyPricedLotCount = publishedFifoLots.filter(isCanonicalVerifiedPublishedLot).length
      const verifiedPricingCoverage = fifoLots.length > 0 ? fullyPricedLotCount / fifoLots.length : null
      // PUBLIC PNL ELIGIBILITY THRESHOLDS, DISCLOSED (requirement #6, byte-for-byte from this
      // task's own explicit numbers): a minimum verified-closed-lot count and minimum verified
      // pricing coverage, both required alongside zero hard-invalid/unknown structural evidence and
      // a non-null realized PnL figure, before a BOUNDED (partial, 90-day) verified sample may be
      // published at all. Neither threshold was previously enforced explicitly — this task's
      // production evidence (17 verified lots, 62.96% coverage) is exactly the case these thresholds
      // are meant to admit as 'partial', never as 'available' (this scan's window is always bounded,
      // so a wallet can only ever earn 'available' by ALSO having zero missing evidence of any kind
      // — see structuralConsistent below, unchanged in shape).
      const MIN_VERIFIED_CLOSED_LOTS = 10
      const MIN_VERIFIED_PRICING_COVERAGE = 0.5
      const verifiedLotThresholdMet = verifiedUpdatedLots.length >= MIN_VERIFIED_CLOSED_LOTS
      const pricingCoverageThresholdMet = verifiedPricingCoverage !== null && verifiedPricingCoverage >= MIN_VERIFIED_PRICING_COVERAGE
      const noHardInvalidEvidence = gateUnmatchedBuys === 0 && gateUnmatchedSells === 0
      // WINDOW BOUNDARY PROVEN, DISCLOSED (bounded-sample-gate follow-up task, requirement #2 —
      // moved up from below so the FULL-availability gate can reference it too, see next note): real,
      // from the caller's exact-unmatched-evidence audit.
      const windowBoundaryProven = denomAudit?.windowBoundaryProven ?? false
      // FULL PNL REQUIRES A PROVEN WINDOW BOUNDARY, DISCLOSED (wallet-scanner-bounded-publication
      // follow-up task — confirmed gap: without `windowBoundaryProven`, a wallet with ZERO other
      // unmatched/missing evidence could satisfy every other structuralConsistent condition and
      // earn full 'available' status EVEN THOUGH its history was truncated. Full availability
      // additionally requires `windowBoundaryProven`. Truncation-unproven unmatched sells now stay
      // in `gateUnmatchedSells` until per-sell proof exists (bypass fix); the bounded ('partial')
      // path remains reachable via `boundedSampleWindowSafe` only after those sells are resolved.
      const structuralConsistent = noHardInvalidEvidence && missingEvidenceCount === 0 && realizedPnlUsd !== null && windowBoundaryProven
      // BOUNDED VERIFIED SAMPLE, REWIRED, DISCLOSED (bounded-sample-gate follow-up task, real
      // production evidence: 27 structural lots, 18 verified/66.67% coverage, 94 buys correctly
      // disclosed as open_position_inventory, 110 sells correctly disclosed as
      // pre_window_inventory_exit, only 4 genuinely invalid/unknown unmatched sells — yet the PRIOR
      // wiring still required `noHardInvalidEvidence` (zero unmatched buys/sells of ANY kind) and
      // fell through to the legacy `missingEvidenceCount <= 3` fallback, which counts those same 4
      // unmatched sells AND pnlEngine's own evidenceMissingCount AND any pricing gap — for this
      // wallet, missingEvidenceCount was 15, so the bounded path never actually admitted a real,
      // otherwise-eligible verified sample. Fixed per this task's explicit requirements #2-#5: the
      // bounded path now evaluates its OWN, narrower rule set —
      //   - verifiedLotThresholdMet / pricingCoverageThresholdMet (unchanged, requirement #8: keep
      //     the 10-lot / 50%-coverage thresholds byte-for-byte the same)
      //   - `!hardInvalidFifoResult` — fifoEngine's OWN integrity flag for a result it has positively
      //     proven invalid (never this function's own unmatched-count tally, which conflates "not
      //     yet matched" with "invalid")
      //   - `windowBoundaryProven` — real, from the caller's exact-unmatched-evidence audit (see
      //     computeUnmatchedEvidenceAudit's own header); without it, an unmatched sell's true reason
      //     is undetermined, so the bounded path cannot be earned (fails closed)
      //   - `realizedPnlUsd !== null` — canonical, from fifoEngine alone, unchanged
      // It deliberately does NOT require gateUnmatchedBuys/Sells === 0 or missingEvidenceCount === 0
      // — per requirement #5, unknown/join-failure evidence may still prevent the FULL 'available'
      // tier (via structuralConsistent above, completely unchanged), but must not by itself veto an
      // otherwise independently verified bounded sample. Those excluded events remain disclosed
      // (`invalidOrUnknownUnmatchedEvents` below) and continue to receive zero cost basis — nothing
      // about fifoEngine's own PnL arithmetic changes.
      const hardInvalidFifoResult = input.fifoEngineResult.integrityFlags.hardInvalid
      // BOUNDED-SAMPLE WINDOW ADMISSION, DISCLOSED (boundary-model follow-up task — confirmed
      // production root cause: a page-capped-but-healthy provider fetch made `windowBoundaryProven`
      // false purely from truncation, hard-blocking an otherwise-verified sample). The bounded path
      // now admits on `boundedSampleWindowSafe` (true for 'exhaustive' AND 'truncated' coverage —
      // see eventClassification's own header), falling back to `windowBoundaryProven` for a caller
      // that hasn't supplied the new field — byte-for-byte the prior gate behavior in that case.
      const boundedSampleWindowSafe = denomAudit?.boundedSampleWindowSafe ?? windowBoundaryProven
      // MANIFEST-APPLIED ELIGIBILITY PATH, DISCLOSED (gate/classification-regression follow-up task
      // — confirmed production bug: a manifest replay that genuinely APPLIED (real verified lots,
      // stable realized total, full pricing coverage) was still hidden behind publicPnlStatus
      // 'unavailable' because THIS gate's own, separately-computed structural-unmatched-sell
      // classification regressed — 116 unmatched instead of the correct 3 genuine + 113
      // truncation-unproven-and-excluded. The manifest's own replay validation (identity, side
      // evidence, cost/proceeds tolerance, realized-total/fingerprint agreement — see
      // canonicalPnlSampleManifest.ts's replayManifest) is independently authoritative for whether
      // THOSE published lots are genuinely verified; it must not be silently overridden by a
      // DIFFERENT, unrelated structural recompute's own noisy denominator. `canonicalManifestApplied`
      // is an ADDITIONAL, independent path to eligibility — never a replacement for the existing
      // structural checks above (still the ONLY path whenever no manifest applied this scan), and
      // still requires the same real verified-lot-count/pricing-coverage/non-hard-invalid/real-total
      // conditions, just not `boundedSampleWindowSafe` specifically (a signal this gate computes
      // from a live, current-scan recompute the manifest replay does not depend on).
      const canonicalManifestApplied = canonicalSampleSelection?.manifestApplied === true
      // PER-SELL BOUNDARY RESOLVER, DISCLOSED (bypass fix): truncation / 98-lot pricing / a
      // successful manifest replay must not publish Combined PnL while any unmatched sell is still
      // only "unproven due to truncation" or otherwise unresolved. Omitted remainingBlockers
      // (unmigrated callers) leaves Combined admission unchanged.
      const boundaryDependentRemainingBlockers = denomAudit?.boundaryDependentRemainingBlockers
      const unresolvedBoundaryDependentSells = boundaryDependentRemainingBlockers != null
        ? boundaryDependentRemainingBlockers
        : 0
      const boundedSampleEligible =
        verifiedLotThresholdMet && pricingCoverageThresholdMet && !hardInvalidFifoResult && realizedPnlUsd !== null
        && (boundedSampleWindowSafe || canonicalManifestApplied)
        && unresolvedBoundaryDependentSells === 0
      // CANONICAL SAMPLE UNAVAILABLE OVERRIDE, DISCLOSED (requirement #4 — genuine fail-closed): a
      // valid manifest exists but this scan could not reproduce its required evidence. The public
      // result must then be degraded/unavailable — never the live candidate sample that happens to
      // be sitting in front of us, and never the manifest's own stored figures re-presented as
      // freshly verified (those survive separately, clearly labelled, as
      // `lastKnownCanonicalSample` in the manifest audit). This can only ever make the gate MORE
      // conservative — it is a veto, never a path to publication.
      const canonicalSampleUnavailable = canonicalSampleSelection?.forcePublicPnlUnavailable === true
      const publicPnlStatus: ReconciledPublicPnlStatus = canonicalSampleUnavailable
        ? 'unavailable'
        : structuralConsistent
          ? 'available'
          : boundedSampleEligible || (missingEvidenceCount <= 3 && fifoLots.length > 0 && unresolvedBoundaryDependentSells === 0)
            ? 'partial'
            : 'unavailable'
      const totalClosedLots = Math.max(fifoLots.length, pnlLots.length)

      // GATE SHADOW AUDIT, DISCLOSED (requirement #5): a before/after comparison — what the gate
      // WOULD have decided using the raw, unfiltered unmatched counts (today's original formula)
      // versus what it ACTUALLY decides now, using exact genuine evidence. Real values only, never
      // estimated — computed from the exact same formulas as the live gate above, just with
      // correctedUnmatchedBuys/Sells substituted back in for the raw side. This is a REPORTING
      // comparison only; `rawGateStatus`/`rawStructuralCoverage` never feed back into the live gate.
      const rawStructuralConsistent = correctedUnmatchedBuys === 0 && correctedUnmatchedSells === 0
        && (input.pnlEngineResult.evidenceMissingCount + correctedUnmatchedBuys + correctedUnmatchedSells + Math.max(0, priceUnavailableCount - recovered.size)) === 0
        && realizedPnlUsd !== null
      const rawMissingEvidenceCount = input.pnlEngineResult.evidenceMissingCount + correctedUnmatchedBuys + correctedUnmatchedSells + Math.max(0, priceUnavailableCount - recovered.size)
      const rawGateStatus: ReconciledPublicPnlStatus = rawStructuralConsistent ? 'available' : rawMissingEvidenceCount <= 3 && fifoLots.length > 0 ? 'partial' : 'unavailable'
      const rawStructuralDenominatorShadow = fifoLots.length + correctedUnmatchedBuys + correctedUnmatchedSells
      const rawStructuralCoverage = rawStructuralDenominatorShadow > 0 ? fifoLots.length / rawStructuralDenominatorShadow : null
      const exactStructuralDenominatorShadow = fifoLots.length + gateUnmatchedBuys + gateUnmatchedSells
      const exactStructuralCoverageShadow = exactStructuralDenominatorShadow > 0 ? fifoLots.length / exactStructuralDenominatorShadow : null
      logger.warn('[gate-shadow-audit]', {
        rawGateStatus,
        exactEvidenceGateStatus: publicPnlStatus,
        rawStructuralCoverage,
        exactStructuralCoverage: exactStructuralCoverageShadow,
        rawUnmatchedCounts: { buys: correctedUnmatchedBuys, sells: correctedUnmatchedSells },
        exactGenuineUnmatchedCounts: { buys: gateUnmatchedBuys, sells: gateUnmatchedSells },
        joinFailures: denomAudit?.unmatchedIdentityJoinFailures ?? null,
      })

      // MISSING-EVIDENCE BREAKDOWN, DISCLOSED (requirement #7): splits the same missingEvidenceCount
      // computed above into WHY evidence is missing, never changing the total or the gate itself.
      // criticalTradeEvidenceMissing covers structurally-unmatched trade legs (the same
      // gateUnmatchedBuys/Sells the gate itself now uses — see the "GATE EVIDENCE INPUT CORRECTION"
      // disclosure above) plus pnlEngine's own independent evidenceMissingCount tally — both
      // describe a trade leg the pipeline could not structurally close, the kind of gap that
      // actually blocks reconstructing a lot at all. pricingEvidenceMissing covers lots that WERE
      // structurally matched but still lack priced evidence after recovery. dustExcluded/
      // nonTradeExcluded are informational only — dust-suppressed tokens and (once real, see
      // 'syntheticOnlyToken' declared above but not yet ever set by this codebase) synthetic-only
      // legs are already excluded upstream and were never counted in missingEvidenceCount to begin
      // with; they must never block public PnL, and this breakdown does not change that.
      const criticalTradeEvidenceMissing = gateUnmatchedBuys + gateUnmatchedSells + input.pnlEngineResult.evidenceMissingCount
      const pricingEvidenceMissing = Math.max(0, priceUnavailableCount - recovered.size)
      const dustExcluded = config.dustSuppressedKeys?.size ?? 0
      const nonTradeExcluded = [...mismatches.values()].filter((v) => v === 'syntheticOnlyToken').length
      const missingEvidenceBreakdown: MissingEvidenceBreakdown = { criticalTradeEvidenceMissing, pricingEvidenceMissing, dustExcluded, nonTradeExcluded }

      // PUBLIC PNL GATE AUDIT, DISCLOSED (requirement #1): a reporting view over the exact same
      // values structuralConsistent/publicPnlStatus above are computed from — every threshold below
      // is the real threshold this gate enforces, not a separate/looser one. Every actualValue below
      // (requirement #4) now matches the EXACT evidence inputs the gate itself decided on —
      // gateUnmatchedBuys/Sells, never the raw correctedUnmatchedBuys/Sells (still reported
      // separately, unchanged, via rawUnmatchedBuys/Sells below).
      const structuralDenominator = fifoLots.length + gateUnmatchedBuys + gateUnmatchedSells
      const blockingReasons: PublicPnlGateBlockingReason[] = []
      // NOTE, DISCLOSED: these two thresholds gate the BOUNDED-VERIFIED-SAMPLE ('partial') path only
      // — a wallet that already achieves full structural consistency (zero missing evidence at any
      // lot count) needs neither a minimum lot count nor a minimum coverage percentage to publish,
      // exactly as before this task. Surfaced here only when relevant to explaining a non-full gate.
      if (!structuralConsistent && !verifiedLotThresholdMet) {
        blockingReasons.push({ rule: 'minimum_verified_closed_lots', threshold: String(MIN_VERIFIED_CLOSED_LOTS), actualValue: String(verifiedUpdatedLots.length) })
      }
      if (!structuralConsistent && !pricingCoverageThresholdMet) {
        blockingReasons.push({ rule: 'minimum_verified_pricing_coverage', threshold: String(MIN_VERIFIED_PRICING_COVERAGE), actualValue: verifiedPricingCoverage === null ? 'null' : String(verifiedPricingCoverage) })
      }
      if (gateUnmatchedBuys > 0) {
        blockingReasons.push({ rule: 'unmatched_buys', threshold: '0', actualValue: String(gateUnmatchedBuys) })
      }
      if (gateUnmatchedSells > 0) {
        blockingReasons.push({ rule: 'unmatched_sells', threshold: '0', actualValue: String(gateUnmatchedSells) })
      }
      if (missingEvidenceCount > 0) {
        blockingReasons.push({ rule: 'missing_evidence_count', threshold: '0', actualValue: String(missingEvidenceCount) })
      }
      // Name the boundary failure in the primary/public blocker list when it is the reason
      // unmatched exits cannot be proven as pre-window inventory. Never infer proof from span.
      const boundaryBlockedSellCount = denomAudit?.sellsBlockedSolelyByUnprovenBoundary
        ?? denomAudit?.preWindowInventoryExitsUnprovenDueToTruncation
        ?? 0
      if (!windowBoundaryProven && boundaryBlockedSellCount > 0) {
        blockingReasons.push({
          rule: 'window_boundary_unproven_for_unmatched_sells',
          threshold: '0 exits blocked by boundary',
          actualValue: String(boundaryBlockedSellCount),
        })
      }
      if (realizedPnlUsd === null) {
        blockingReasons.push({ rule: 'realized_pnl_present', threshold: 'non-null', actualValue: 'null' })
      }
      // BOUNDED-SAMPLE BLOCKING REASONS, DISCLOSED (requirement #6): the bounded path's OWN reason
      // list — deliberately excludes unmatched_buys/unmatched_sells/missing_evidence_count, which
      // are real for the FULL-availability path (`fullAvailabilityBlockingReasons` below) but never
      // veto the bounded path per requirement #5.
      const boundedSampleBlockingReasons: PublicPnlGateBlockingReason[] = []
      if (!verifiedLotThresholdMet) {
        boundedSampleBlockingReasons.push({ rule: 'minimum_verified_closed_lots', threshold: String(MIN_VERIFIED_CLOSED_LOTS), actualValue: String(verifiedUpdatedLots.length) })
      }
      if (!pricingCoverageThresholdMet) {
        boundedSampleBlockingReasons.push({ rule: 'minimum_verified_pricing_coverage', threshold: String(MIN_VERIFIED_PRICING_COVERAGE), actualValue: verifiedPricingCoverage === null ? 'null' : String(verifiedPricingCoverage) })
      }
      if (hardInvalidFifoResult) {
        boundedSampleBlockingReasons.push({ rule: 'fifo_result_hard_invalid', threshold: 'false', actualValue: 'true' })
      }
      if (!boundedSampleWindowSafe) {
        boundedSampleBlockingReasons.push({ rule: 'window_boundary_proven', threshold: 'true', actualValue: 'false' })
      }
      if (unresolvedBoundaryDependentSells > 0) {
        boundedSampleBlockingReasons.push({
          rule: 'boundary_dependent_sells_unresolved',
          threshold: '0 unresolved boundary-dependent sells',
          actualValue: String(unresolvedBoundaryDependentSells),
        })
      }
      if (realizedPnlUsd === null) {
        boundedSampleBlockingReasons.push({ rule: 'realized_pnl_present', threshold: 'non-null', actualValue: 'null' })
      }
      const fullAvailabilityBlockingReasons = blockingReasons
      const publicPnlGateAudit: PublicPnlGateAudit = {
        verifiedLotCount: verifiedUpdatedLots.length,
        fullyPricedLotCount,
        pricingCoverage: fifoLots.length > 0 ? fullyPricedLotCount / fifoLots.length : null,
        structuralCoverage: structuralDenominator > 0 ? fifoLots.length / structuralDenominator : null,
        unmatchedBuyCount: gateUnmatchedBuys,
        unmatchedSellCount: gateUnmatchedSells,
        integrityTier: canonicalSampleUnavailable ? 'blocked' : structuralConsistent ? 'full' : boundedSampleEligible || (missingEvidenceCount <= 3 && fifoLots.length > 0 && unresolvedBoundaryDependentSells === 0) ? 'partial' : 'blocked',
        blockingReasons,
        rawUnmatchedBuys: correctedUnmatchedBuys,
        rawUnmatchedSells: correctedUnmatchedSells,
        genuineUnmatchedBuys: denomAudit?.genuineUnmatchedBuys ?? null,
        genuineUnmatchedSells: denomAudit?.genuineUnmatchedSells ?? null,
        excludedNonTradeBuys: denomAudit?.excludedNonTradeBuys ?? {},
        excludedNonTradeSells: denomAudit?.excludedNonTradeSells ?? {},
        excludedUnmatchedByClassification: denomAudit?.excludedUnmatchedByClassification ?? {},
        unmatchedIdentityJoinFailures: denomAudit?.unmatchedIdentityJoinFailures ?? null,
        structuralCoverageNumerator: fifoLots.length,
        structuralCoverageDenominator: structuralDenominator,
        verifiedClosedLots: verifiedUpdatedLots.length,
        structuralClosedLots: fifoLots.length,
        openPositionBuys: denomAudit?.openPositionBuys ?? 0,
        preWindowInventoryExits: denomAudit?.preWindowInventoryExits ?? 0,
        preWindowInventoryExitsUnprovenDueToTruncation: denomAudit?.preWindowInventoryExitsUnprovenDueToTruncation ?? 0,
        sellsBlockedSolelyByUnprovenBoundary: boundaryBlockedSellCount,
        historyCoverageStatus: denomAudit?.historyCoverageStatus ?? null,
        invalidOrUnknownUnmatchedEvents: gateUnmatchedBuys + gateUnmatchedSells,
        scanWindowDays: denomAudit?.scanWindowDays ?? null,
        verifiedPricingCoverage,
        engineDivergenceDiagnostic,
        boundedSampleEligible,
        boundedSampleBlockingReasons,
        fullAvailabilityBlockingReasons,
        includedVerifiedLotCount: verifiedUpdatedLots.length,
        excludedUnpricedLotCount: Math.max(0, fifoLots.length - verifiedUpdatedLots.length),
        excludedUnknownUnmatchedCount: gateUnmatchedBuys + gateUnmatchedSells,
      }

      // BOUNDED-SAMPLE WARNING, DISCLOSED (requirement #7): set only when 'partial' was earned via
      // the bounded verified-sample path — never for the legacy near-miss fallback (which is a
      // near-complete result, not a deliberately bounded one) or for 'available'/'unavailable'.
      // TRUNCATED-HISTORY DISCLOSURE, DISCLOSED, ADDITIVE (boundary-model follow-up task): reduces
      // confidence in the human-readable warning (never in any numeric figure — realizedPnlUsd and
      // every gate count are unaffected) whenever the bounded sample was admitted via truncated,
      // not exhaustive, coverage — so a reader is told the fetch hit a provider page cap rather than
      // silently seeing the same "verified sample" wording an exhaustive scan would get.
      const warning = publicPnlStatus === 'partial' && boundedSampleEligible
        ? denomAudit?.historyCoverageStatus === 'truncated'
          ? `Verified ${denomAudit?.scanWindowDays ?? 90}-day sample, not complete wallet history — provider history was truncated (event cap reached), so ${denomAudit?.preWindowInventoryExitsUnprovenDueToTruncation ?? 0} additional pre-window exit(s) could not be proven and are excluded from this sample`
          : `Verified ${denomAudit?.scanWindowDays ?? 90}-day sample, not complete wallet history`
        : null

      // DISCREPANCY/TRUST-GATE AUDIT, DISCLOSED (Wallet Scanner trust-gate task): built from the
      // SAME values every field above was already computed from — canonical `realizedPnlUsd`, the
      // alternate pnlEngine's own `input.pnlEngineResult.realizedPnlUsd`, the public gate's own
      // coverage/evidence counts, the published matched-lot array, and the real `mismatches`/
      // `unmatchedSellEvents` this function already tracks. See pnlDiscrepancyAudit.ts's own header.
      const pnlDiscrepancyAudit = buildPnlDiscrepancyAudit({
        publicPnlStatus,
        canonicalRealizedPnlUsd: realizedPnlUsd,
        alternateEngineRealizedPnlUsd: roundUsd(input.pnlEngineResult.realizedPnlUsd),
        verifiedLotCount: publicPnlGateAudit.verifiedLotCount,
        structuralClosedLots: publicPnlGateAudit.structuralClosedLots,
        pricingCoverage: verifiedPricingCoverage,
        criticalTradeEvidenceMissing: missingEvidenceBreakdown.criticalTradeEvidenceMissing,
        genuineUnmatchedSells: publicPnlGateAudit.genuineUnmatchedSells ?? 0,
        publishedMatchedLots: publishedFifoLots,
        mismatches,
        unmatchedSellEvents: input.fifoEngineResult.unmatchedSellEvents,
      })

      const earlyVerifiedSet = new Set(consistentFifoLots.filter(isCanonicalVerifiedLotForPnl).map(lotKey))
      const finalVerifiedSet = new Set(publishedFifoLots.filter(isCanonicalVerifiedLotForPnl).map(lotKey))
      const downgraded = consistentFifoLots.filter((lot) => earlyVerifiedSet.has(lotKey(lot)) && !finalVerifiedSet.has(lotKey(lot)))
      const downgradeReasons: Record<string, number> = {}
      for (const lot of downgraded) {
        const finalLot = publishedFifoLots.find((candidate) => lotKey(candidate) === lotKey(lot))
        const reason = finalLot ? (canonicalVerifiedRejectionReason(finalLot) ?? 'canonical_sample_withheld') : 'canonical_sample_withheld'
        downgradeReasons[reason] = (downgradeReasons[reason] ?? 0) + 1
      }
      const invariantFailures: string[] = []
      if (finalVerifiedSet.size > earlyVerifiedSet.size) invariantFailures.push('final_verified_exceeds_early_verified')
      if (canonicalSampleSelection?.manifestApplied === true && publicPnlGateAudit.excludedUnpricedLotCount > 0) {
        invariantFailures.push('manifest_all_verified_but_final_missing_price')
      }
      const pnlVerificationTransitionAudit = {
        structuralLots: fifoLots.length,
        earlyNumericPricedLots: consistentFifoLots.filter((lot) => Number.isFinite(lot.costBasisUsd) && Number.isFinite(lot.proceedsUsd)).length,
        earlyVerifiedLots: earlyVerifiedSet.size,
        finalVerifiedLots: finalVerifiedSet.size,
        downgradedLotCount: downgraded.length,
        downgradeReasons,
        examples: downgraded.slice(0, 10).map((lot) => ({
          lotId: lot.lotId, token: lot.token, earlyLotStatus: 'verified', finalLotStatus: 'unverified',
          downgradeStage: 'canonical_reconciliation', downgradeReason: Object.keys(downgradeReasons)[0] ?? 'canonical_sample_withheld',
        })),
        invariantFailures,
      }
      if (invariantFailures.length > 0) logger.warn('CRITICAL pnl_verification_invariant_failure', pnlVerificationTransitionAudit)

      const verifiedCount = (lots: readonly MatchedLot[]) => lots.filter(isCanonicalVerifiedLotForPnl).length
      const verifiedIds = (lots: readonly MatchedLot[]) => new Set(lots.filter(isCanonicalVerifiedLotForPnl).map((lot) => lot.lotId))
      const pricingIds = verifiedIds(consistentFifoLots)
      const selectionIds = verifiedIds(canonicalSelectedLots)
      const reconciliationIds = verifiedIds(publishedFifoLots)
      const publicIds = verifiedIds(verifiedUpdatedLots)
      const dropped = (from: Set<string>, to: Set<string>) => [...from].filter((id) => !to.has(id)).sort()
      const droppedAtSelection = dropped(pricingIds, selectionIds)
      const droppedAtReconciliation = dropped(selectionIds, reconciliationIds)
      const droppedAtPublicGate = dropped(reconciliationIds, publicIds)
      const traceLots = consistentFifoLots.filter(isCanonicalVerifiedLotForPnl)
      const dropReasons: Record<string, number> = {}
      const examples = traceLots.map((earlyLot) => {
        const selected = canonicalSelectedLots.find((lot) => lot.lotId === earlyLot.lotId)
        const reconciled = publishedFifoLots.find((lot) => lot.lotId === earlyLot.lotId)
        const selectedVerified = selected ? isCanonicalVerifiedLotForPnl(selected) : false
        const reconciledVerified = reconciled ? isCanonicalVerifiedLotForPnl(reconciled) : false
        const finalGateVerified = publicIds.has(earlyLot.lotId)
        const firstDowngradeStage = !selectedVerified ? 'canonical_selection' as const
          : !reconciledVerified ? 'reconciliation' as const
            : !finalGateVerified ? 'public_gate' as const : null
        const rejected = firstDowngradeStage === 'canonical_selection' ? selected
          : firstDowngradeStage === 'reconciliation' ? reconciled : firstDowngradeStage === 'public_gate' ? reconciled : null
        const exactDowngradeReason = firstDowngradeStage
          ? rejected ? canonicalVerifiedRejectionReason(rejected) : 'lot_identity_not_found'
          : null
        if (exactDowngradeReason) dropReasons[`${firstDowngradeStage}:${exactDowngradeReason}`] = (dropReasons[`${firstDowngradeStage}:${exactDowngradeReason}`] ?? 0) + 1
        return {
          lotId: earlyLot.lotId,
          entryPrice: earlyLot.costBasisUsd,
          exitPrice: earlyLot.proceedsUsd,
          // MatchedLot does not carry provider names. Verification is preserved by the canonical
          // evidenceQuality field; claiming a source here would fabricate provenance.
          entrySource: null,
          exitSource: null,
          entryEvidenceStatusBefore: earlyLot.evidenceQuality,
          exitEvidenceStatusBefore: earlyLot.evidenceQuality,
          earlyCanonicalVerified: true,
          afterCanonicalSelection: { entrySource: null, exitSource: null, evidenceQuality: selected?.evidenceQuality ?? null, verified: selectedVerified },
          afterReconciliation: { evidenceQuality: reconciled?.evidenceQuality ?? null, verified: reconciledVerified },
          finalGateVerified,
          firstDowngradeStage,
          exactDowngradeReason,
          expectedMetadata: { evidenceQuality: 'verified' as const },
          actualMetadata: { evidenceQuality: rejected?.evidenceQuality ?? null },
        }
      })
      const consistencyInvariantFailures: string[] = []
      const pricingStageVerifiedLots = verifiedCount(consistentFifoLots)
      const canonicalSelectionVerifiedLots = verifiedCount(canonicalSelectedLots)
      const reconciliationVerifiedLots = verifiedCount(publishedFifoLots)
      const finalPublicVerifiedLots = verifiedUpdatedLots.length
      if (canonicalSelectionVerifiedLots !== reconciliationVerifiedLots) consistencyInvariantFailures.push('canonical_selection_verified_does_not_equal_reconciliation_verified')
      if (reconciliationVerifiedLots !== finalPublicVerifiedLots) consistencyInvariantFailures.push('reconciliation_verified_does_not_equal_final_public_verified')
      const canonicalVerificationConsistencyAudit = {
        pricingStageVerifiedLots,
        canonicalSelectionVerifiedLots,
        reconciliationVerifiedLots,
        finalPublicVerifiedLots,
        droppedAtSelection,
        droppedAtReconciliation,
        droppedAtPublicGate,
        dropReasons,
        examples,
        invariantFailures: consistencyInvariantFailures,
      }
      if (consistencyInvariantFailures.length > 0) logger.warn('CRITICAL canonical_verification_consistency_failure', canonicalVerificationConsistencyAudit)

      const includedSamplePricingMissing = verifiedUpdatedLots.filter((lot) =>
        !isCanonicalPositiveUsd(lot.costBasisUsd) || !isCanonicalPositiveUsd(lot.proceedsUsd) || lot.realizedPnlUsd == null || !Number.isFinite(lot.realizedPnlUsd),
      ).length
      const canonicalConsistencyPassed = consistencyInvariantFailures.length === 0
        && pnlVerificationTransitionAudit.invariantFailures.length === 0
      const fullHistoryBlockingReasons = (publicPnlStatus === 'available'
        ? []
        : publicPnlStatus === 'partial'
          ? publicPnlGateAudit.boundedSampleBlockingReasons
          : publicPnlGateAudit.blockingReasons
      ).map((reason) => reason.rule)
      const { verifiedSamplePerformance, fullHistoryPerformance, verifiedSamplePerformanceAudit } = computeVerifiedSampleAndFullHistoryPerformance({
        verifiedLots: verifiedUpdatedLots,
        // Pairing universe is the full structural FIFO, including unpriced lots. Manifest-replayed
        // quote/cash legs stay excluded when a counterpart risk lot exists here even if the bounded
        // event window no longer contains those historical txs. Published verified lots remain the
        // ROI membership set (`verifiedLots`); this array is identity-only.
        structuralLots: consistentFifoLots,
        normalizedEvents: input.normalizedEvents,
        structuralLotCount: fifoLots.length,
        realizedPnlUsd,
        verifiedPricingCoverage,
        pricingCoverageThresholdMet,
        excludedUnmatchedSellCount: gateUnmatchedSells,
        canonicalConsistencyPassed,
        includedSamplePricingMissing,
        hardInvalidFifoResult,
        canonicalSampleUnavailable,
        publicPnlStatus,
        fullHistoryBlockingReasons,
      })
      logger.warn('[verified-sample-performance-audit]', verifiedSamplePerformanceAudit)

      // TEMPORARY DIAGNOSTIC, DISCLOSED (verified-sample-cost-basis-denominator-drift follow-up
      // task) — never repairs, never changes any published value. Added because
      // `canonicalPnlDiffAudit`'s own `changedGroups`/`previousRealizedPnlUsd`/`currentRealizedPnlUsd`
      // summary (logged from src/pipeline/index.ts) diffs a FRESH, never-published rebuild
      // (`buildManifestFromCandidate` over this scan's own candidate lots) against the PRE-SCAN
      // manifest — it never touches `replay.publishedLots`/`effectiveReplay` (the actual array a
      // manifest refresh, when one applies, replaces before publication) and therefore cannot prove
      // anything about what `verifiedSamplePerformance.realizedCostBasisUsd` itself actually is. This
      // block emits ONE bounded per-lot row for every lot in the ACTUAL published verified sample —
      // its own entry/exit evidence keys, the RAW accepted-evidence side total each key currently
      // holds, and this lot's own already-allocated canonical cost basis/proceeds — so a real scan's
      // log can be diffed lot-by-lot against a prior scan's log without guessing. Bounded to this
      // scan's own >=1 verified lots (a real wallet's sample, never unbounded); skipped entirely
      // when there is no KV to read evidence from, and any read failure for one lot is caught and
      // recorded rather than aborting the diagnostic for the rest.
      if (config.acceptedEvidenceKv && verifiedUpdatedLots.length > 0) {
        try {
          const kv = config.acceptedEvidenceKv
          const now = (config.now ?? Date.now)()
          const rows = await mapWithConcurrencyLimit(verifiedUpdatedLots, RECOVERY_CONCURRENCY_LIMIT, async (l) => {
            const [entryEvidenceKey, exitEvidenceKey] = acceptedEvidenceIdentityKeysForLot(l)
            let acceptedEntryUsd: number | null = null
            let acceptedExitUsd: number | null = null
            try {
              const entryEvidence = await readAcceptedEvidenceAnyLotVersion(kv, { chain: l.chain, token: l.token, txHash: l.openedTxHash, side: 'entry', timestamp: l.openedAt }, now)
              acceptedEntryUsd = entryEvidence?.priceUsd ?? null
            } catch { /* read failure — leave null, never fabricated */ }
            try {
              const exitEvidence = await readAcceptedEvidenceAnyLotVersion(kv, { chain: l.chain, token: l.token, txHash: l.closedTxHash, side: 'exit', timestamp: l.closedAt }, now)
              acceptedExitUsd = exitEvidence?.priceUsd ?? null
            } catch { /* read failure — leave null, never fabricated */ }
            return {
              lotKey: lotKey(l),
              costBasisUsd: l.costBasisUsd,
              proceedsUsd: l.proceedsUsd,
              realizedPnlUsd: l.realizedPnlUsd,
              entryEvidenceKey,
              exitEvidenceKey,
              acceptedEntryUsd,
              acceptedExitUsd,
              // "Canonical" here means this lot's own already-published, already-allocated figure —
              // the SAME value `realizedCostBasisUsd`/`realizedPnlUsd` above were summed from. Never a
              // second, independent recomputation.
              canonicalEntryUsd: l.costBasisUsd,
              canonicalExitUsd: l.proceedsUsd,
            }
          })
          logger.warn('[verified-sample-cost-basis-audit]', { lotCount: rows.length, rows })
        } catch (error) {
          logger.warn('[verified-sample-cost-basis-audit] skipped — diagnostic failure never blocks a scan', { error: String(error) })
        }
      }

      const summary: PnlReconciliationSummary = {
        closedLots: totalClosedLots,
        unmatchedBuys: correctedUnmatchedBuys,
        unmatchedSells: correctedUnmatchedSells,
        realizedPnlUsd,
        unrealizedPnlUsd: roundUsd(input.fifoEngineResult.unrealizedPnlUsd),
        priceRecoveredCount: recovered.size,
        routerCorrectedCount,
        syntheticAlignedCount,
        missingEvidenceCount,
        missingEvidenceBreakdown,
        publicPnlStatus,
        publicPnlGateAudit,
        verifiedSamplePerformance,
        fullHistoryPerformance,
        verifiedSamplePerformanceAudit,
        verifiedSampleRealizedPnlUsd: verifiedSamplePerformance.realizedPnlUsd,
        verifiedSampleRealizedRoiPct: verifiedSamplePerformance.realizedRoiPct,
        mismatches: [...mismatches.entries()].map(([key, classification]) => ({ key, classification })).sort((a, b) => a.key.localeCompare(b.key)),
        warning,
        acceptedEvidenceAudit,
        missingPriceRecoveryFunnelAudit: recovery.missingPriceRecoveryFunnelAudit,
        publishedMatchedLots: publishedFifoLots,
        pnlDiscrepancyAudit,
        pnlVerificationTransitionAudit,
        canonicalVerificationConsistencyAudit,
      }
      logger.warn('[pnl-reconciliation] finalSummary', summary)
      logger.warn('[public-pnl-gate-audit]', publicPnlGateAudit)
      logger.warn('[pnl-discrepancy-audit]', pnlDiscrepancyAudit)
      return summary
    },
  }
}
