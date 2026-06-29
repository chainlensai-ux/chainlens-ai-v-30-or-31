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

// --- LIVE-SPEED-3: early no-sell-path skip gate prevents the acquisition-recovery Moralis fetch ---
assert.match(
  snap,
  /const _earlySkipHistoricalPreviewNoSellPath = shouldSkipHistoricalPreviewForNoSellPath\(\{\s*\n\s*adminOverrideUsed: _adminOverrideUsed,\s*\n\s*closedLotsCount: _closedLots\.length,\s*\n\s*syntheticClosedLotsCount: _syntheticClosedLots\.length,\s*\n\s*unmatchedSells: _lotEngineDebug\.unmatchedSells \?\? 0,\s*\n\s*candidateEvidence: _swapEvidenceWithDetection,\s*\n\s*\}\)/,
  'early no-sell-path skip gate is computed before target ranking, using only pre-recovery evidence',
)
assert.match(
  snap,
  /const _acquisitionRecoveryEligible = Boolean\(\s*\n\s*!_nonTraderEarlyExit &&\s*\n\s*!_earlySkipHistoricalPreviewNoSellPath &&/,
  'acquisition recovery eligibility is gated off for no-sell-path wallets, before the Moralis fetch runs',
)
assert.match(
  snap,
  /if \(_earlySkipHistoricalPreviewNoSellPath && !_nonTraderEarlyExit\) _skipReasons\.push\('no_sell_path_acquisition_recovery_skipped'\)/,
  'skip reason is surfaced in debug when the early gate fires',
)
assert.match(
  snap,
  /acquisitionRecoveryReason: _acquisitionRecoveryEligible \? 'not_run' : _earlySkipHistoricalPreviewNoSellPath \? 'no_sell_path_acquisition_recovery_skipped' : 'not_eligible_for_acquisition_recovery',/,
  'acquisitionRecoveryReason distinguishes the no-sell-path skip from generic ineligibility',
)

// --- LIVE-SPEED-3: Moralis holdings timeout/race, only when Zerion/GoldRush fallback is usable ---
assert.match(
  snap,
  /const MORALIS_WALLET_HOLDINGS_TIMEOUT_MS = Number\(process\.env\.MORALIS_WALLET_HOLDINGS_TIMEOUT_MS\) \|\| 2500/,
  'Moralis wallet holdings timeout is env-overridable, defaulting to 2500ms',
)
assert.match(
  snap,
  /const _moralisHoldingsTimeoutRaceEligible = _zerionValueUsable \|\| _zerionPositionsUsable/,
  'timeout race is gated on the canonical Zerion usability flags, not on the post-dust-filter holdings array (which can read empty even when Zerion succeeded)',
)
assert.match(
  snap,
  /const _mbRes = await Promise\.race\(\[_mbPromise, _timeoutPromise\]\)/,
  'Moralis holdings fetch is raced against the timeout instead of always being awaited directly',
)
assert.doesNotMatch(
  snap,
  /_mbPromise\.then\([^)]*\)\.catch\(\(\) => \{\}\)[^]*?_mbPromise\.then/,
  'timed-out Moralis call is not retried — only the single in-flight promise is ever tracked',
)
assert.match(
  snap,
  /timeoutMs: _moralisHoldingsTimeoutRaceEligible \? MORALIS_WALLET_HOLDINGS_TIMEOUT_MS : null,\s*\n\s*timedOut: _moralisHoldingsTimedOut,/,
  'moralisUsage debug exposes timeoutMs/timedOut — the timeout is never hidden from debug',
)
assert.match(
  snap,
  /fallbackReason: _moralisHoldingsTimedOut \? 'moralis_timeout_zerion_goldrush_fallback_used' : _selectedReasonForRouting,/,
  'providerFallback.fallbackReason reflects the timeout-specific reason when it fires',
)
assert.match(
  snap,
  /if \(_moralisHoldingsTimedOut\) _apiWarnings\.push\('moralis_holdings_timeout_fallback_used'\)/,
  'a real apiAudit.warnings entry is added when the Moralis holdings timeout fires',
)
// Provider PnL summary (fetchMoralisProfitabilitySummary) uses a separate code path and is untouched.
assert.doesNotMatch(
  snap,
  /fetchMoralisProfitabilitySummary[^\n]*MORALIS_WALLET_HOLDINGS_TIMEOUT_MS/,
  'the holdings timeout does not touch the Provider PnL summary call',
)

// --- LIVE-SPEED-4: honest, scoped duration metric + timeout actually unblocks the response ---

// durationMs must be scoped to the Moralis holdings fetch phase itself (started right where
// eligibility is computed, measured right after the Promise.allSettled resolves) rather than
// Date.now() - startedAt (full scan elapsed time), which kept reporting large numbers even once
// the timeout had already engaged and stopped blocking the response.
assert.match(snap, /const _moralisHoldingsStartedAt = Date\.now\(\)/, 'a dedicated start timestamp is captured for the Moralis holdings fetch phase')
assert.match(
  snap,
  /_moralisHoldingsDurationMs = Date\.now\(\) - _moralisHoldingsStartedAt/,
  'Moralis holdings duration is measured from its own dedicated start timestamp, immediately after the allSettled call resolves',
)
assert.match(snap, /durationMs: _moralisHoldingsDurationMs,/, 'moralisUsage.durationMs reports the scoped fetch-phase duration, not the full scan elapsed time')
assert.doesNotMatch(snap, /durationMs: Date\.now\(\) - startedAt,/, 'the old full-scan-elapsed duration measurement is removed')

// The timeout branch must resolve and let the per-chain async function return WITHOUT awaiting the
// real (slow) Moralis promise — only a fire-and-forget .then() touches it afterwards, so the
// Promise.allSettled() driving _moralisHoldingsDurationMs can never be held open by the real call.
const _raceBlock = snap.slice(snap.indexOf('const _timeoutPromise = new Promise<MoralisFetchResult>'), snap.indexOf('_moralisHoldingsDurationMs = Date.now()'))
assert.match(_raceBlock, /const _mbRes = await Promise\.race\(\[_mbPromise, _timeoutPromise\]\)/, 'the per-chain result comes from the race, not a direct await of the real Moralis promise')
assert.doesNotMatch(_raceBlock, /await _mbPromise(?!\.then)/, 'the real Moralis promise is never directly awaited inside the race-eligible branch — only raced or fire-and-forget .then()-chained')

console.log('wallet live-speed pass: early no-sell skip + Moralis holdings timeout checks passed')

// --- PNL-RECOVERY-EXCL-FIX-1: raw closed lots must not block recovery when those lots carry no ---
// --- public-grade performance evidence (synthetic / estimate-only / flat-price / integrity-invalid) ---

// Phase 5C's "real backed" filter must also exclude flat/estimate-only lots — previously only
// synthetic/backfilled/zero-coverage lots were excluded, so a wallet whose only matched lots were
// estimate-only (this task's ETH wallet shape: rawMatchedClosedLots=11, publicPerformanceClosedLots=0,
// estimateOnlyClosedLots=8) still read as "real backed" and silently skipped Phase 5C recovery as
// already_has_closed_lots.
assert.match(
  snap,
  /l\.pnlDisplayStatus !== 'estimate_only_price_flat' &&\s*\n\s*\(l\.coveragePercent \?\? 100\) !== 0/,
  'the early real-backed-closed-lot filter excludes estimate-only/flat-price lots, not just synthetic ones',
)

// The synthetic-recovery skip reason must never resolve to closed_lots_already_found (or the
// equally-stale coverage_above_threshold) when recovery is actually still needed — it must report
// the honest budget/hard-cap blocker, or a generic "needs a real prior buy" reason, instead.
assert.match(
  snap,
  /_syntheticRecoverySkipReasonFallback = Boolean\(_hardCapReachedAtPhase\)\s*\n\s*\? 'hard_cap_reached'\s*\n\s*: \(_skipReasons\.includes\('budget_remaining_too_low'\) \|\| _skipReasons\.includes\('broad_pass_budget_zeroed_by_cost_guard'\)\)\s*\n\s*\? 'budget_remaining_too_low'\s*\n\s*: 'synthetic_lots_need_real_prior_buy'/,
  'synthetic recovery skip reason maps to hard_cap_reached / budget_remaining_too_low / synthetic_lots_need_real_prior_buy, never the stale closed_lots_already_found',
)
assert.doesNotMatch(
  snap,
  /: !_runHistoricalCoverage\s*\n\s*\? \(_skipReasons\[0\]/,
  'the synthetic recovery skip reason no longer falls back to the raw, possibly-stale _skipReasons[0] value',
)

// walletRecoveryRecommendation must expose recoverable/recoveryBlockedReason honestly when the
// high-activity excluded-lots case is hit but the credit hard cap already prevented the next pass.
assert.match(
  snap,
  /reason: 'high_activity_excluded_lots_no_public_evidence', estimatedExtraPages: _hardCapHitFinal[\s\S]{0,80}recoverable: true, recoveryBlockedReason: _recoveryBlockedReasonHonest/,
  'walletRecoveryRecommendation reports recoverable:true with an honest reservation-outcome block reason, not a bare not-recoverable result',
)
assert.match(
  snap,
  /recoverable\?: boolean[\s\S]{0,400}recoveryBlockedReason\?: 'recovery_budget_reserved_but_provider_unavailable' \| 'recovery_budget_reserved_but_no_targets' \| 'recovery_budget_reserved_but_no_pages_allowed' \| 'hard_cap_reached_before_reservation' \| null/,
  'walletRecoveryRecommendation type declares the recoverable/recoveryBlockedReason fields with the four honest reservation-outcome reasons',
)
assert.doesNotMatch(
  snap,
  /recoveryBlockedReason: 'hard_cap_reached_after_pricing'/,
  'hard_cap_reached_after_pricing must never be assigned — it is retired in favor of the four honest reservation-outcome reasons',
)

// walletPnlBlockerSummary must treat a budget-capped-but-recommended recovery as recoverable, and
// must never say "No action available" while walletRecoveryRecommendation.recommended is true.
assert.match(
  snap,
  /_blockerRecoverableViaTargetedRecovery = Boolean\(snapshot\.walletRecoveryRecommendation\?\.recommended\)/,
  'walletPnlBlockerSummary.recoverable is fed by the already-computed walletRecoveryRecommendation signal',
)
assert.match(
  snap,
  /_blockerBudgetCappedRecovery\s*\n\s*\? `Recovery available, but this scan hit the cost cap before deeper buy-leg recovery could run\. Next action: run targeted recovery for \$\{_blockerTargetTokenSymbols\.join\(' and '\) \|\| 'the affected tokens'\}\.`/,
  'walletPnlBlockerSummary.nextAction uses the honest cost-cap copy instead of "not recoverable" when budget blocked an otherwise-recommended recovery',
)

console.log('wallet pnl-recovery-exclusion pass: raw closed lots no longer block recovery checks passed')

// BUDGET-RESERVATION-FIX-1 / MORALIS-LEAK-FIX-1 checks.

// 1. Recovery budget must be reserved before the broad pricing/historical pass spends the shared pool.
assert.match(
  snap,
  /const _recoveryReservedCredits = _recoveryReservationNeeded\s*\n\s*\? Math\.max\(0, Math\.min\(2, _syntheticLotTokenTargets\.length, _sharedHistoricalBudgetRemaining\(\)\)\)/,
  'recovery budget is reserved from the shared historical pool before the broad pass computes its own page allowance',
)
assert.match(
  snap,
  /const _historicalPhaseBudget = Math\.max\(0, Math\.min\(6, _sharedHistoricalBudgetRemainingForBroadPass\(\)\)\)/,
  'the broad pass page budget reads from the reservation-aware view of the shared pool, not the raw remaining credits',
)

// 2. Credits used must never exceed totalCreditHardCap — the broad historical pass fans pages out
// per chain (2x), so the non-admin page allowance must divide the remaining pool by the chain count.
assert.match(
  snap,
  /Math\.min\(clampedMaxHistoricalPages, _defaultPagesByTier, _historicalPhaseBudget, Math\.floor\(_sharedHistoricalBudgetRemainingForBroadPass\(\) \/ 2\)\)/,
  'non-admin broad-pass page allowance accounts for the per-chain (2x) fan-out so total credits used cannot exceed the hard cap',
)

// 3. walletScanBudgetDebug exposes the six new reservation fields.
for (const field of [
  'recoveryBudgetReserved: _recoveryBudgetReserved',
  'recoveryReservedCredits: _recoveryReservedCredits',
  'recoveryReservationReason: _recoveryReservationReason',
  'pricingCreditsReducedForRecovery: _recoveryReservedCredits',
  'targetedRecoveryAttemptedBeforeHardCap: _targetedRecoveryAttemptedBeforeHardCap',
  'hardCapPreventedAfterReservation: _hardCapPreventedAfterReservation',
]) {
  assert.ok(snap.includes(field), `walletScanBudgetDebug must expose ${field.split(':')[0].trim()}`)
}

// 4. walletMoralisHardGateDebug exposes the three new transfer-leak fields and the type declarations
// for them, distinct from the existing moralisTransfersBlockedBecauseGoldrushUsable field.
for (const field of [
  'transfersBlockedBecauseGoldRushUsable: boolean',
  'transferLeakPath: string | null',
  'moralisTransferAttemptsBlocked: number',
]) {
  assert.ok(snap.includes(field), `walletMoralisHardGateDebug type must declare ${field.split(':')[0].trim()}`)
}

// 5. _shouldRunBaseFifoCoverage (Phase 5C) must never trigger when GoldRush activity is already usable.
assert.match(
  snap,
  /!_bfcFallbackBlocked &&\s*\n\s*!_goldrushActivityUsableForMoralisGate\s*\n\s*\)/,
  'Phase 5C base-FIFO-coverage gate is blocked when GoldRush activity is already usable, closing the Moralis transfer leak',
)

// 6. MORALIS-MISSING-BUY-RECOVERY is capped to 1 page per target token unless an admin override exists.
assert.match(
  snap,
  /const _moralisHistoricalMaxPagesPerToken = _adminOverrideUsed \? 2 : 1/,
  'targeted synthetic-lot recovery is capped to 1 page per target token unless an admin override exists',
)

// 7. The blocker-summary headline must read "behavior lots" (not "verified behavior lots") and must
// be sourced from tradeIntelLots, not the gated _verifiedIndependentClosedLotsFinal count.
assert.match(
  snap,
  /`Trade intelligence is ready: \$\{tradeIntelLots\} behavior lots detected\. Public PnL is locked because \$\{_blockerReasons\.join\('; '\)\}\.`/,
  'walletPnlBlockerSummary headline reads tradeIntelLots behavior lots, not verified behavior lots gated by _verifiedIndependentClosedLotsFinal',
)
assert.doesNotMatch(
  snap,
  /Trade intelligence is ready: \$\{_verifiedIndependentClosedLotsFinal\} verified behavior lots detected/,
  'the stale verified-behavior-lots headline copy must be fully replaced',
)

console.log('wallet budget-reservation and moralis-transfer-leak fix checks passed')
