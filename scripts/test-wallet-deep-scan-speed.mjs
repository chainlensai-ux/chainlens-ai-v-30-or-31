import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// LIVE-SPEED-1: skip gate must be derivable purely from FIFO/evidence shape signals that are
// available BEFORE the pricing/FIFO preview runs (provider-summary status is computed later in
// the function and cannot be checked here) — no sell-direction candidates, no baseline closed
// lots, no synthetic lots, no swap/acquisition recovery eligibility, no admin override.
assert.match(
  snap,
  /const _skipHistoricalPreviewNoSellPath = Boolean\(\s*\n\s*!_adminOverrideUsed &&\s*\n\s*_closedLots\.length === 0 &&\s*\n\s*_syntheticClosedLots\.length === 0 &&\s*\n\s*!_finalCandidateEvidence\.some\(e => e\.direction === 'sell'\) &&\s*\n\s*!_syntheticLotRecoveryTrigger &&\s*\n\s*!_pnlRecoveryV2BaseEligible &&\s*\n\s*!_acquisitionRecoveryEligible &&\s*\n\s*!_noSwapCandidateRecoveryEligible\s*\n\s*\)/,
  'historical preview skip gate is derived from no-sell-path FIFO/evidence shape signals available before the preview runs',
)

// When the gate fires, the live GoldRush historical pricing preview call must not be awaited —
// the ternary short-circuits to a synthetic 'skipped' summary instead of calling buildHistoricalPricingPreview.
assert.match(
  snap,
  /const \{ summary: walletHistoricalPricingPreviewSummary, debug: _historicalPricingPreviewDebug, pricedEvidence: _hcNewPricedEvidence \} =\s*\n\s*_skipHistoricalPreviewNoSellPath\s*\n\s*\? \{ summary: \{ status: 'skipped' as const, requested: false, newSwapCandidateEvents: 0, pricedHistoricalCandidates: 0, unpricedHistoricalCandidates: 0, stableLegPricedEvents: 0, wethLegPricedEvents: 0, historicalPricedEvents: 0, priceAttemptLimitReached: false, readyForHistoricalFifoPreview: false, missing: \['provider_summary_available_no_fifo_sell_path'\], reason: 'provider_summary_available_no_fifo_sell_path' \}, debug: undefined, pricedEvidence: \[\] as WalletTxEvidence\[\] \}\s*\n\s*: _finalCandidateEvidence\.length > 0\s*\n\s*\? await buildHistoricalPricingPreview\(/,
  'pricing preview skip path short-circuits before the await buildHistoricalPricingPreview call (no new GoldRush calls)',
)

// The FIFO preview mirrors the same skip, and never fabricates an added closed lot or promotion eligibility.
assert.match(
  snap,
  /_skipHistoricalPreviewNoSellPath\s*\n\s*\? \{ summary: \{ status: 'skipped' as const, requested: false, baselineClosedLots: _closedLots\.length, previewClosedLots: _closedLots\.length, addedClosedLots: 0, baselineRealizedPnlUsd: walletTradeStatsSummary\.realizedPnlUsd, previewRealizedPnlUsd: walletTradeStatsSummary\.realizedPnlUsd, addedRealizedPnlUsd: 0, baselineRealizedPnlPercent: walletTradeStatsSummary\.realizedPnlPercent \?\? null, previewRealizedPnlPercent: walletTradeStatsSummary\.realizedPnlPercent \?\? null, winningClosedLotsPreview: 0, losingClosedLotsPreview: 0, breakEvenClosedLotsPreview: 0, uniqueTokensPreview: 0, previewConfidence: 'low' as const, readyForHistoricalTradeStatsPreview: false, safeToPromoteToPublicStats: false, missing: \['provider_summary_available_no_fifo_sell_path'\], reason: 'provider_summary_available_no_fifo_sell_path' \}, debug: undefined, previewClosedLots: _closedLots as WalletClosedLot\[\] \}/,
  'FIFO preview skip path leaves safeToPromoteToPublicStats false and addedClosedLots 0 — public PnL/win rate cannot unlock from a skipped preview',
)

// The skip gate must never fire when there is any sell-direction evidence, synthetic lots, existing
// closed lots, or recovery eligibility — i.e. requirement 3's "keep full recovery when it can help".
// This is implied by the AND-of-negatives structure above (already asserted), but re-assert explicitly
// that the recovery-eligibility signals used are the real pre-existing ones, not new stand-ins.
assert.match(snap, /const _syntheticLotRecoveryTrigger = Boolean\(/, 'gate reuses the pre-existing _syntheticLotRecoveryTrigger signal')
assert.match(snap, /_pnlRecoveryV2BaseEligible/, 'gate reuses the pre-existing _pnlRecoveryV2BaseEligible signal')
assert.match(snap, /_acquisitionRecoveryEligible/, 'gate reuses the pre-existing _acquisitionRecoveryEligible signal')
assert.match(snap, /_noSwapCandidateRecoveryEligible/, 'gate reuses the pre-existing _noSwapCandidateRecoveryEligible signal')

// walletHistoricalScanNote takes priority over the other note branches when the gate fires.
assert.match(
  snap,
  /\/\/ Set historical scan note\s*\n\s*if \(_skipHistoricalPreviewNoSellPath\) \{\s*\n\s*snapshot\.walletHistoricalScanNote = 'Provider PnL available\. FIFO reconstruction remains open check; deeper recovery can be run separately if needed\.'/,
  'walletHistoricalScanNote is set to the exact required text when the skip gate fires, ahead of the other note branches',
)

// --- Timing buckets (requirement 1) ---
assert.match(snap, /recoveryEligibilityMs: 0, historicalTargetRankingMs: 0, historicalPricingPreviewMs: 0, historicalFifoPreviewMs: 0, recoveryRecommendationMs: 0/, '_perfWalletTimings carries the five new fine-grained sub-buckets, additive to the existing coarse historicalMs total')
assert.match(snap, /_perfWalletTimings\.historicalTargetRankingMs \+= Date\.now\(\) - _historicalTargetRankingStartedAt/, 'target token ranking is timed')
assert.match(snap, /_perfWalletTimings\.recoveryEligibilityMs \+= Date\.now\(\) - _recoveryEligibilityStartedAt/, 'recovery eligibility calculation is timed')
assert.match(snap, /_perfWalletTimings\.historicalPricingPreviewMs \+= Date\.now\(\) - _historicalPricingPreviewStartedAt/, 'historical pricing preview is timed')
assert.match(snap, /_perfWalletTimings\.historicalFifoPreviewMs \+= Date\.now\(\) - _historicalFifoPreviewStartedAt/, 'historical FIFO preview is timed')
assert.match(snap, /_perfWalletTimings\.recoveryRecommendationMs \+= Date\.now\(\) - _recoveryRecommendationStartedAt/, 'recovery recommendation building is timed')
assert.match(snap, /historicalMs: _perfWalletTimings\.historicalMs,\s*\n\s*recoveryEligibilityMs: _perfWalletTimings\.recoveryEligibilityMs,\s*\n\s*historicalTargetRankingMs: _perfWalletTimings\.historicalTargetRankingMs,\s*\n\s*historicalPricingPreviewMs: _perfWalletTimings\.historicalPricingPreviewMs,\s*\n\s*historicalFifoPreviewMs: _perfWalletTimings\.historicalFifoPreviewMs,\s*\n\s*recoveryRecommendationMs: _perfWalletTimings\.recoveryRecommendationMs,/, 'walletPerformanceDebug exposes all five new sub-buckets alongside the existing coarse historicalMs')

// --- Route-level timing (cacheWriteMs / routeDecorationMs) ---
assert.match(route, /recoveryEligibilityMs: number\s*\n\s*historicalTargetRankingMs: number\s*\n\s*historicalPricingPreviewMs: number\s*\n\s*historicalFifoPreviewMs: number\s*\n\s*recoveryRecommendationMs: number\s*\n\s*routeDecorationMs: number/, 'LegacyWalletDeepScanTiming declares all seven requested debug fields')
assert.match(route, /routeDecorationMs: Math\.max\(0, opts\.routeDecorationMs \?\? 0\),/, 'buildWalletDeepScanTiming exposes routeDecorationMs from opts')
assert.match(route, /cacheWriteMs: Math\.max\(0, cacheWriteMs\),/, 'buildWalletDeepScanTiming still exposes cacheWriteMs (kept awaited, only measured per requirement 4 safe-fallback)')
assert.match(route, /const _routeDecorationMs = Math\.max\(0, Date\.now\(\) - _routeDecorationStartedAt - _cacheWriteMs\)/, 'route-level decoration time is measured between snapshot fetch completion and the final timing attach call, excluding the cache write')
assert.doesNotMatch(route, /walletCache\.set\(cacheKey, \{[^}]*\}\)\s*\)\.catch/, 'cache write is not converted to a fire-and-forget call — stays safely awaited per requirement 4')

console.log('wallet deep-scan live-speed timing and historical-preview skip-gate checks passed')
