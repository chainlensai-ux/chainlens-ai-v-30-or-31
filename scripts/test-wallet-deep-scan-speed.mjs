import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// LIVE-SPEED-2: skip gate is a dedicated helper, derivable purely from FIFO/evidence shape signals
// available BEFORE the pricing/FIFO preview runs (provider-summary status is computed later in the
// function and cannot be checked here) — no sell-direction candidates, no unmatched sells, no
// baseline closed lots, no synthetic lots, no admin override. Buy/acquisition/top-holding recovery
// eligibility flags must NOT be part of the gate — a buy-only preview can never create a closed lot
// regardless of how many buy-side recovery flags are set.
assert.match(
  snap,
  /function shouldSkipHistoricalPreviewForNoSellPath\(input: \{\s*\n\s*adminOverrideUsed: boolean\s*\n\s*closedLotsCount: number\s*\n\s*syntheticClosedLotsCount: number\s*\n\s*unmatchedSells: number\s*\n\s*candidateEvidence: WalletTxEvidence\[\]\s*\n\s*\}\): boolean \{\s*\n\s*return Boolean\(\s*\n\s*!input\.adminOverrideUsed &&\s*\n\s*input\.closedLotsCount === 0 &&\s*\n\s*input\.syntheticClosedLotsCount === 0 &&\s*\n\s*input\.unmatchedSells === 0 &&\s*\n\s*!input\.candidateEvidence\.some\(e => e\.direction === 'sell'\)\s*\n\s*\)\s*\n\s*\}/,
  'shouldSkipHistoricalPreviewForNoSellPath helper checks only no-sell-path FIFO/evidence shape signals',
)

assert.match(
  snap,
  /const _skipHistoricalPreviewNoSellPath = shouldSkipHistoricalPreviewForNoSellPath\(\{\s*\n\s*adminOverrideUsed: _adminOverrideUsed,\s*\n\s*closedLotsCount: _closedLots\.length,\s*\n\s*syntheticClosedLotsCount: _syntheticClosedLots\.length,\s*\n\s*unmatchedSells: _lotEngineDebug\.unmatchedSells \?\? 0,\s*\n\s*candidateEvidence: _finalCandidateEvidence,\s*\n\s*\}\)/,
  'gate call site passes admin override, closed/synthetic lot counts, unmatched sells, and final candidate evidence',
)

// Buy/acquisition/swap recovery eligibility flags must NOT gate the skip (requirement: do not let
// these alone prevent skip). They may still appear elsewhere in the file (the recovery mechanisms
// themselves are unchanged), but never as part of the skip-gate call site.
const _gateCallSite = snap.slice(snap.indexOf('const _skipHistoricalPreviewNoSellPath = shouldSkipHistoricalPreviewForNoSellPath({'), snap.indexOf('const _skippedHistoricalPreviewDebugReasons'))
assert.doesNotMatch(_gateCallSite, /_syntheticLotRecoveryTrigger/, 'gate call site does not reference _syntheticLotRecoveryTrigger')
assert.doesNotMatch(_gateCallSite, /_pnlRecoveryV2BaseEligible/, 'gate call site does not reference _pnlRecoveryV2BaseEligible')
assert.doesNotMatch(_gateCallSite, /_acquisitionRecoveryEligible/, 'gate call site does not reference _acquisitionRecoveryEligible')
assert.doesNotMatch(_gateCallSite, /_noSwapCandidateRecoveryEligible/, 'gate call site does not reference _noSwapCandidateRecoveryEligible')

// When the gate fires, the live GoldRush historical pricing preview call must not be awaited —
// the ternary short-circuits to a synthetic 'skipped' summary instead of calling buildHistoricalPricingPreview.
// The debug object is now fully populated (requested: false, priceAttempts: 0, reasons set) instead
// of `debug: undefined`, so `_debug.walletHistoricalPricingPreviewDebug.requested`/`.reasons` are visible.
assert.match(
  snap,
  /const \{ summary: walletHistoricalPricingPreviewSummary, debug: _historicalPricingPreviewDebug, pricedEvidence: _hcNewPricedEvidence \} =\s*\n\s*_skipHistoricalPreviewNoSellPath\s*\n\s*\? \{ summary: \{ status: 'skipped' as const, requested: false, newSwapCandidateEvents: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, readyForHistoricalFifoPreview: false, missing: \['provider_summary_available_no_fifo_sell_path'\], reason: 'provider_summary_available_no_fifo_sell_path' \}, debug: \{ requested: false, newSwapCandidateEvents: 0, priceAttempts: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, samplePricedHistoricalCandidates: \[\], sampleUnpricedHistoricalCandidates: \[\], skippedReasons: _skippedHistoricalPreviewDebugReasons, reasons: _skippedHistoricalPreviewDebugReasons \}, pricedEvidence: \[\] as WalletTxEvidence\[\] \}\s*\n\s*: _finalCandidateEvidence\.length > 0\s*\n\s*\? await buildHistoricalPricingPreview\(/,
  'pricing preview skip path short-circuits before the await buildHistoricalPricingPreview call, and exposes requested:false/reasons via a populated debug object (no new GoldRush calls)',
)
assert.match(
  snap,
  /const _skippedHistoricalPreviewDebugReasons = \['provider_summary_available_no_fifo_sell_path'\]/,
  'skip reasons constant used by both the summary and debug object is defined once',
)

// The FIFO preview mirrors the same skip, and never fabricates an added closed lot or promotion eligibility.
assert.match(
  snap,
  /_skipHistoricalPreviewNoSellPath\s*\n\s*\? \{ summary: \{ status: 'skipped' as const, requested: false, baselineClosedLots: _closedLots\.length, previewClosedLots: _closedLots\.length, addedClosedLots: 0, baselineRealizedPnlUsd: walletTradeStatsSummary\.realizedPnlUsd, previewRealizedPnlUsd: walletTradeStatsSummary\.realizedPnlUsd, addedRealizedPnlUsd: 0, baselineRealizedPnlPercent: walletTradeStatsSummary\.realizedPnlPercent \?\? null, previewRealizedPnlPercent: walletTradeStatsSummary\.realizedPnlPercent \?\? null, winningClosedLotsPreview: 0, losingClosedLotsPreview: 0, breakEvenClosedLotsPreview: 0, uniqueTokensPreview: 0, previewConfidence: 'low' as const, readyForHistoricalTradeStatsPreview: false, safeToPromoteToPublicStats: false, missing: \['provider_summary_available_no_fifo_sell_path'\], reason: 'provider_summary_available_no_fifo_sell_path' \}, debug: undefined, previewClosedLots: _closedLots as WalletClosedLot\[\] \}/,
  'FIFO preview skip path leaves safeToPromoteToPublicStats false and addedClosedLots 0 — public PnL/win rate cannot unlock from a skipped preview',
)

// Requirement 2 ("do not skip when recovery can help"): the gate's four real blockers are exactly
// unmatchedSells / closedLotsCount / syntheticClosedLotsCount / sell-direction candidateEvidence —
// already proven by the helper-definition assertion above. The buy-side eligibility flags
// (_pnlRecoveryV2BaseEligible, _acquisitionRecoveryEligible, _noSwapCandidateRecoveryEligible,
// _syntheticLotRecoveryTrigger) still exist elsewhere in the file (their recovery mechanisms are
// unchanged — only their effect on the gate was removed), so assert they're still defined for the
// recovery itself, just not referenced at the gate call site (already proven above).
assert.match(snap, /const _syntheticLotRecoveryTrigger = Boolean\(/, '_syntheticLotRecoveryTrigger recovery signal still exists (unaffected, no longer gates the skip)')
assert.match(snap, /const _pnlRecoveryV2BaseEligible/, '_pnlRecoveryV2BaseEligible recovery signal still exists (unaffected, no longer gates the skip)')
assert.match(snap, /const _acquisitionRecoveryEligible = Boolean\(/, '_acquisitionRecoveryEligible recovery signal still exists (unaffected, no longer gates the skip)')

// walletHistoricalScanNote takes priority over the other note branches when the gate fires.
assert.match(
  snap,
  /\/\/ Set historical scan note\s*\n\s*if \(_skipHistoricalPreviewNoSellPath\) \{\s*\n\s*snapshot\.walletHistoricalScanNote = 'Provider PnL available\. FIFO reconstruction remains open check; deeper recovery can be run separately if needed\.'/,
  'walletHistoricalScanNote is set to the exact required text when the skip gate fires, ahead of the other note branches',
)

// --- Timing buckets (requirement 1) ---
assert.match(snap, /recoveryEligibilityMs: 0, historicalTargetRankingMs: 0, historicalPricingPreviewMs: 0, historicalFifoPreviewMs: 0, recoveryRecommendationMs: 0/, '_perfWalletTimings carries the five first-pass fine-grained sub-buckets, additive to the existing coarse historicalMs total')
assert.match(snap, /_perfWalletTimings\.historicalTargetRankingMs \+= Date\.now\(\) - _historicalTargetRankingStartedAt/, 'target token ranking is timed')
assert.match(snap, /_perfWalletTimings\.recoveryEligibilityMs \+= Date\.now\(\) - _recoveryEligibilityStartedAt/, 'recovery eligibility calculation is timed')
assert.match(snap, /_perfWalletTimings\.historicalPricingPreviewMs \+= Date\.now\(\) - _historicalPricingPreviewStartedAt/, 'historical pricing preview is timed')
assert.match(snap, /_perfWalletTimings\.historicalFifoPreviewMs \+= Date\.now\(\) - _historicalFifoPreviewStartedAt/, 'historical FIFO preview is timed')
assert.match(snap, /_perfWalletTimings\.recoveryRecommendationMs \+= Date\.now\(\) - _recoveryRecommendationStartedAt/, 'recovery recommendation building is timed')

// --- Timing buckets (requirement 3: the previously-unaccounted ~6.2s inside recoveryMs) ---
assert.match(snap, /recoveryPrecheckMs: 0, recoverySkipGateMs: 0, recoveryDebugBuildMs: 0, historicalScanDebugBuildMs: 0, historicalCandidateSummaryMs: 0, historicalPreviewPrepMs: 0, syntheticRecoveryDebugMs: 0, recoveryPostProcessingMs: 0/, '_perfWalletTimings carries all eight new fine-grained recovery sub-buckets')
assert.match(snap, /_perfWalletTimings\.recoveryPrecheckMs \+= Date\.now\(\) - _recoveryPrecheckStartedAt/, 'broad-pass historical coverage fetch is timed')
assert.match(snap, /_perfWalletTimings\.historicalCandidateSummaryMs \+= Date\.now\(\) - _historicalCandidateSummaryStartedAt/, 'Phase 6B historical candidate comparison is timed')
assert.match(snap, /_perfWalletTimings\.syntheticRecoveryDebugMs \+= Date\.now\(\) - _syntheticRecoveryDebugStartedAt/, 'synthetic-target/pnlRecoveryV2/Moralis-historical recovery block is timed')
assert.match(snap, /_perfWalletTimings\.historicalPreviewPrepMs \+= Date\.now\(\) - _historicalPreviewPrepStartedAt/, 'acquisition-recovery + final candidate-evidence merge is timed')
assert.match(snap, /_perfWalletTimings\.recoverySkipGateMs \+= Date\.now\(\) - _recoverySkipGateStartedAt/, 'the skip-gate call itself is timed')
assert.match(snap, /_perfWalletTimings\.recoveryDebugBuildMs \+= Date\.now\(\) - _recoveryDebugBuildStartedAt/, 'post-preview pnlRecoveryV2 debug enrichment + promotion decision is timed')
assert.match(snap, /_perfWalletTimings\.recoveryPostProcessingMs \+= Date\.now\(\) - _recoveryPostProcessingStartedAt/, 'post-preview recovery post-processing is timed')
assert.match(snap, /_perfWalletTimings\.historicalScanDebugBuildMs \+= Date\.now\(\) - _historicalScanDebugBuildStartedAt/, 'walletHistoricalScanDebug construction is timed')

// recoveryUnaccountedMs is computed from only the in-window buckets (excludes the three buckets
// timed outside the historicalMs window: recoveryDebugBuildMs, recoveryPostProcessingMs,
// historicalScanDebugBuildMs), and is clamped non-negative.
assert.match(
  snap,
  /_perfWalletTimings\.recoveryUnaccountedMs \+= Math\.max\(0, \(Date\.now\(\) - _historicalStartedAt\) - \(\s*\n\s*_perfWalletTimings\.recoveryPrecheckMs \+\s*\n\s*_perfWalletTimings\.historicalCandidateSummaryMs \+\s*\n\s*_perfWalletTimings\.syntheticRecoveryDebugMs \+\s*\n\s*_perfWalletTimings\.historicalPreviewPrepMs \+\s*\n\s*_perfWalletTimings\.recoverySkipGateMs \+\s*\n\s*_perfWalletTimings\.historicalPricingPreviewMs \+\s*\n\s*_perfWalletTimings\.historicalFifoPreviewMs\s*\n\s*\)\)/,
  'recoveryUnaccountedMs sums only the in-window recovery sub-buckets, clamped non-negative',
)

assert.match(
  snap,
  /recoveryRecommendationMs: _perfWalletTimings\.recoveryRecommendationMs,\s*\n\s*recoveryPrecheckMs: _perfWalletTimings\.recoveryPrecheckMs,\s*\n\s*recoverySkipGateMs: _perfWalletTimings\.recoverySkipGateMs,\s*\n\s*recoveryDebugBuildMs: _perfWalletTimings\.recoveryDebugBuildMs,\s*\n\s*historicalScanDebugBuildMs: _perfWalletTimings\.historicalScanDebugBuildMs,\s*\n\s*historicalCandidateSummaryMs: _perfWalletTimings\.historicalCandidateSummaryMs,\s*\n\s*historicalPreviewPrepMs: _perfWalletTimings\.historicalPreviewPrepMs,\s*\n\s*syntheticRecoveryDebugMs: _perfWalletTimings\.syntheticRecoveryDebugMs,\s*\n\s*recoveryPostProcessingMs: _perfWalletTimings\.recoveryPostProcessingMs,\s*\n\s*recoveryUnaccountedMs: _perfWalletTimings\.recoveryUnaccountedMs,/,
  'walletPerformanceDebug exposes all nine new fields alongside the existing coarse historicalMs',
)

// --- Route-level timing (cacheWriteMs / routeDecorationMs / nine new recovery sub-buckets) ---
assert.match(route, /recoveryEligibilityMs: number\s*\n\s*historicalTargetRankingMs: number\s*\n\s*historicalPricingPreviewMs: number\s*\n\s*historicalFifoPreviewMs: number\s*\n\s*recoveryRecommendationMs: number\s*\n\s*routeDecorationMs: number\s*\n\s*recoveryPrecheckMs: number\s*\n\s*recoverySkipGateMs: number\s*\n\s*recoveryDebugBuildMs: number\s*\n\s*historicalScanDebugBuildMs: number\s*\n\s*historicalCandidateSummaryMs: number\s*\n\s*historicalPreviewPrepMs: number\s*\n\s*syntheticRecoveryDebugMs: number\s*\n\s*recoveryPostProcessingMs: number\s*\n\s*recoveryUnaccountedMs: number/, 'LegacyWalletDeepScanTiming declares all sixteen requested debug fields')
assert.match(route, /routeDecorationMs: Math\.max\(0, opts\.routeDecorationMs \?\? 0\),/, 'buildWalletDeepScanTiming exposes routeDecorationMs from opts')
assert.match(route, /cacheWriteMs: Math\.max\(0, cacheWriteMs\),/, 'buildWalletDeepScanTiming still exposes cacheWriteMs (kept awaited, only measured per requirement 4 safe-fallback)')
assert.match(route, /const _routeDecorationMs = Math\.max\(0, Date\.now\(\) - _routeDecorationStartedAt - _cacheWriteMs\)/, 'route-level decoration time is measured between snapshot fetch completion and the final timing attach call, excluding the cache write')
assert.doesNotMatch(route, /walletCache\.set\(cacheKey, \{[^}]*\}\)\s*\)\.catch/, 'cache write is not converted to a fire-and-forget call — stays safely awaited per requirement 4')
assert.match(route, /recoveryUnaccountedMs: Math\.max\(0, Number\(perf\?\.recoveryUnaccountedMs \?\? 0\) \|\| 0\),/, 'buildWalletDeepScanTiming surfaces recoveryUnaccountedMs from the snapshot perf debug')
assert.match(route, /recoveryUnaccountedMs: timing\.recoveryUnaccountedMs \}/, 'attachWalletDeepScanTiming surfaces recoveryUnaccountedMs on the public payload.walletDeepScanTiming')

console.log('wallet deep-scan live-speed timing and historical-preview skip-gate checks passed')
