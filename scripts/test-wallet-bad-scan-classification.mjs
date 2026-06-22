import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// Same-tx balance-delta swap reconstruction (no router label required)
assert.match(snap, /reconstructionMethod\?:\s*'tx_balance_delta'/, 'PnL events can be tagged as tx-balance-delta reconstructed')
assert.match(snap, /Swap-derived from same-tx \$\{cp\.symbol\} quote leg \(no router label needed\)/, 'quote-leg same-tx swap is reconstructed without a router label')
assert.match(snap, /Single-leg derived from same-tx \$\{peer\.symbol\} quote leg \(no router label needed\)/, 'single-leg quote-leg swap is reconstructed without a router label')
assert.match(snap, /isVerifiedNativeQuoteLeg/, 'verified per-chain native quote-leg detection exists')


// MICRO-WALLET-TARGETED-RECOVERY-REGRESSION: once the capped target-token recovery pass actually
// runs for a micro wallet, public/debug labels must describe the attempted-but-unrecovered state
// instead of stale value-tier/no-target skip reasons.
assert.match(snap, /_syntheticTargetExtraRecoveryAttempted[\s\S]*\? 'targeted_recovery_attempted_no_prior_buy_found'/, 'targeted micro recovery attempts report targeted_recovery_attempted_no_prior_buy_found, not wallet_value_below_100')
assert.match(snap, /reason: 'targeted_recovery_attempted_no_prior_buy_found'/, 'wallet recovery recommendation reports the attempted no-prior-buy result')
assert.match(snap, /const syntheticTargetTokens = rankedTargetTokens\.length > 0 \? rankedTargetTokens : _syntheticLotTokenTargets/, 'synthetic lot targets feed recovery recommendation targets when ranked historical targets are empty')
assert.match(snap, /closedLots: 0,[\s\S]*closedLotsForStats: 0,[\s\S]*verifiedClosedLots: 0,[\s\S]*winningClosedLots: 0,[\s\S]*losingClosedLots: 0,[\s\S]*breakEvenClosedLots: 0,/, 'synthetic missing-cost-basis lots are excluded from public closed/break-even trade counts')
assert.match(snap, /syntheticClosedLotsExcluded: _syntheticLotsExcludedFromStatsFinal,/, 'excluded synthetic closed lots remain visible as syntheticClosedLotsExcluded')
assert.match(route, /closedLots: ts\.closedLotsForStats \?\? 0,[\s\S]*winningClosedLots: 0,[\s\S]*losingClosedLots: 0,[\s\S]*breakEvenClosedLots: 0,[\s\S]*publicPnlStatus: 'open_check'/, 'response boundary keeps public closed-trade count at zero for open-check trade stats')
assert.match(route, /snapshot\.dataFreshness = 'live'[\s\S]*snapshot\.cacheAgeSeconds = null/, 'live provider fetches cannot retain top-level cached freshness/cacheAge labels')

const identity = fs.readFileSync('lib/server/walletIdentity.ts', 'utf8')
assert.match(identity, /const nativeExposureAlreadyIncluded = topHoldings\.some/, 'wallet profile detects when ETH/native was already counted as a large-cap holding')
assert.match(identity, /Math\.max\(0, Math\.min\(100, largeCapTokenExposure \+ \(nativeExposureAlreadyIncluded \? 0 : nativeExposurePercent\)\)\)/, 'large-cap/native exposure is clamped to 0-100 and avoids double-counting native ETH')

// PnL quality tiers — no fake $0 PnL, every tier maps to real evidence
assert.match(snap, /pnlQuality\?:\s*'exact_fifo' \| 'exact_fifo_micro_sample' \| 'fifo_with_estimates' \| 'sell_side_only' \| 'open_positions_cost_missing' \| 'activity_only' \| 'no_trade_evidence' \| 'missing_cost_basis'/, 'pnlQuality tier union is present')
assert.match(snap, /_exactFifoEligible = _realClosedLotsCount > 0 && !_missingCostBasisProven/, 'exact FIFO eligibility requires real-backed, non-missing-cost-basis closed lots')
assert.match(snap, /_unmatchedSellsCount > 0 \? 'sell_side_only'/, 'sells without matched buys map to sell_side_only, not open_check')
assert.match(snap, /holdings\.length > 0 && _openedLotsCount > 0 \? 'open_positions_cost_missing'/, 'open positions with no buy map to open_positions_cost_missing')

// Cache/historical label honesty
assert.match(route, /_hadLiveHistoricalCalls/, 'cache-hit recovery checks for actual live provider calls before labeling')
assert.match(route, /'cached_preview_only'/, 'cache hits with zero live calls are labeled cached_preview_only')
assert.match(route, /walletHistoricalRecoveryStatus = 'not_attempted'/, 'cache hits with zero live calls are not labeled attempted')

// PNL-SAFETY-FIX: synthetic-only closed lots must never be reported as fifo_with_estimates,
// and recovery recommendations must not claim closed lots were "already found" from synthetic lots.
assert.match(snap, /_missingCostBasisProven && \(promotedLotSummary\.syntheticClosedLots \?\? 0\) > 0 \? 'missing_cost_basis'/, 'synthetic-only closed lots map to missing_cost_basis, not fifo_with_estimates')
assert.match(snap, /reason: 'missing_cost_basis_synthetic_lots_excluded'/, 'recovery recommendation excludes synthetic-only lots with a clear reason')
assert.match(snap, /if \(_realClosedLotsCount > 0\) \{\s*\n\s*const _hasExcludedLots = \(promotedTradeStatsSummary\.syntheticClosedLotsExcluded \?\? 0\) > 0 \|\| \(promotedTradeStatsSummary\.estimateOnlyClosedLots \?\? 0\) > 0/, 'real-backed closed lots branch keys off whether excluded lots remain')
assert.match(snap, /return \{ recommended: false, mode: historicalAttempted \? 'attempted_light' : 'none', targetTokens, reason: _hasExcludedLots \? 'verified_stats_available_excluded_lots_remain' : 'closed_lots_already_found', estimatedExtraPages: 0 \}/, 'real-backed closed lots keep targets populated and disclose excluded lots remain when public evidence exists')
// HIGH-ACTIVITY-RECON: real-backed lots that produced ZERO public-grade evidence (all excluded)
// must still recommend targeted recovery, not silently report "closed lots already found".
assert.match(snap, /if \(_performanceClosedLotsFinal\.length === 0 && _hasExcludedLots\) \{\s*\n\s*return \{ recommended: true, mode: 'targeted_token_recovery', targetTokens, reason: 'high_activity_excluded_lots_no_public_evidence'/, 'real-backed-but-all-excluded lots keep recommending targeted recovery instead of closed_lots_already_found')
assert.match(snap, /verificationStatus: 'verifiable' \| 'partial' \| 'not_available' \| 'synthetic_cost_basis_missing' \| 'estimate_only_price_flat' \| 'price_independence_missing'/, 'synthetic closed-trade samples get a distinct non-verifiable status')
assert.match(snap, /_sampleEligibleLots = _closedLotsForStatsFinal === 0 \? \[\] : _sampleSourceLots/, 'no closed-trade samples are exposed when every closed lot is synthetic')
assert.match(snap, /verifiedClosedLots\?:\s*number/, 'walletTradeStatsSummary exposes a verified-only closed lot count')

assert.match(ui, /_verifiedClosedLots > 0 && ts\.realizedPnlUsd !== null && ts\.pnlUnavailableReason !== 'missing_cost_basis'/, 'UI trade-evidence-strong gate uses verified closed lots, not raw synthetic closedLots count')

// CACHE-HONESTY-FIX: cached/recovered responses with zero live provider calls must not be
// mislabeled historical_live/attempted, must not recommend recovery, must not claim publicPnlStatus
// ok with no verified closed lots, and must explain a missing swap-reconstruction debug honestly.
assert.match(route, /const liveProviderCalls = recovered\?\.walletScanBudget\?\.creditsUsed \?\? providerCalls/, 'live-call detection uses real provider-call/credit signals, not just pagesAttempted/historicalMs')
assert.match(route, /if \(!providerFetchNeeded\) return false/, 'zero provider calls cannot be classified as a live historical recovery')
assert.match(route, /recovered\.walletHistoricalRecoveryReason = 'cached_snapshot_no_live_historical_calls'/, 'cache hits with zero live calls use the exact cached_snapshot_no_live_historical_calls reason')
assert.match(route, /recovered\.walletRecoveryRecommendation = \{ recommended: false, mode: 'none', targetTokens: \[\], reason: 'cached_snapshot_no_live_recovery', estimatedExtraPages: 0 \}/, 'cache hits with zero live calls force the recovery recommendation to none')
assert.match(snap, /\}\)\)\.filter\(t => t\.estimatedUsd > 0\)/, 'recovery recommendation target tokens drop zero/negative-value candidates')
assert.match(route, /function normalizePublicPnlStatus/, 'a response-boundary safety net re-asserts publicPnlStatus regardless of cache origin')
assert.match(route, /const noVerifiedClosedLots = ts\.status === 'open_check' \|\| \(ts\.closedLotsForStats \?\? 0\) === 0 \|\| \(ts\.verifiedClosedLots \?\? 0\) === 0/, 'open-check/zero-verified-closed-lots cannot emit publicPnlStatus ok')
assert.match(route, /SWAP_RECONSTRUCTION_V1_DEBUG_UNAVAILABLE_FROM_CACHE/, 'cached responses missing swap-reconstruction diagnostics get an honest not_available_from_cached_snapshot placeholder instead of null')
assert.match(route, /swapReconstructionV1Reason: 'not_available_from_cached_snapshot'/, 'placeholder swap-reconstruction debug explains why it is unavailable from cache')

// DUST-FIFO-FIX: verified closed lots that are all dust must not unlock exact_fifo or a
// Rotator/Sniper/Smart Money/Degen personality label.
assert.match(snap, /_exactFifoCleanEligible && _exactFifoIsMeaningful \? 'exact_fifo'/, 'exact_fifo requires economically meaningful closed lots, not just any real-backed closed lot')
assert.match(snap, /: _exactFifoEligible \? 'exact_fifo_micro_sample'/, 'verified dust-only closed lots map to exact_fifo_micro_sample instead of exact_fifo')
assert.match(snap, /_pnlQuality === 'fifo_with_estimates' \? 'verified_fifo_with_synthetic_lots_excluded'\s*\n\s*: _pnlQuality === 'exact_fifo_micro_sample' && _hasOutlierExclusions \? 'outlier_lots_excluded'\s*\n\s*: _pnlQuality === 'exact_fifo_micro_sample' \? 'exact_fifo_but_micro_sample'/, 'pnlQualityReason explains the micro-sample downgrade')
assert.match(snap, /_exactFifoEligible && !_exactFifoIsMeaningful \? 'verified_lots_below_meaningful_threshold'/, 'pnlQualityReason flags verified lots below the meaningful threshold')
assert.match(ui, /q === 'exact_fifo_micro_sample'\) return 'Verified dust trades found, not enough meaningful trade data'/, 'UI shows dust-only verified trades as not-meaningful, not strong exact FIFO performance')

const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
assert.match(intel, /meaningfulClosedLots === 0 \|\| tradeStats\?\.economicSignificance === 'micro_sample'/, 'wallet personality requires meaningful (non-dust) verified closed lots, not just 3+ raw closed lots')
assert.match(intel, /personality: 'Not enough data',\s*\n\s*scores: null,\s*\n\s*summary: 'Verified closed trades exist, but are too small \(dust-sized\) to classify/, 'dust-only verified trades return Not enough data / null scores, not a personality label')

// PNL-OUTLIER-CONSISTENCY-FIX: outlier-quarantined lots (real-backed but abnormal pricing, e.g. the
// STBL 39800% lot) must not let public PnL surfaces (walletLotSummary, walletClosedTradeSamples,
// pnlQuality) contradict the quarantine-safe walletTradeStatsSummary numbers.
assert.match(snap, /function _closedLotKey\(lot: WalletClosedLot\): string \{/, 'a stable closed-lot identity key exists to track which lots were quarantined')
assert.match(snap, /quarantinedLotKeys: string\[\]/, 'buildTradeStatsSummary surfaces which closed lots were quarantined as outliers')
assert.match(snap, /CORTEX excluded \$\{_oq\.quarantinedLots\.length\} abnormal trade lot\$\{_oq\.quarantinedLots\.length !== 1 \? 's' : ''\}\. Public PnL and trade stats use the remaining \$\{_oq\.cleanLots\.length\} verified lot/, 'outlier note explains that public PnL and trade stats both use only the remaining verified lots')
assert.match(snap, /const _quarantinedLotKeySet = new Set\(_quarantinedLotKeys\)/, 'public lot summary re-derivation is keyed off the same quarantined-lot identity set as trade stats')
assert.match(snap, /realizedPnlUsd: promotedTradeStatsSummary\.realizedPnlUsd,\s*\n\s*realizedPnlPercent: promotedTradeStatsSummary\.realizedPnlPercent,/, 'walletLotSummary realized PnL is re-derived from the quarantine-safe trade stats, not raw FIFO lots, once outliers are excluded')
assert.match(snap, /_sampleSourceLotsRaw\.filter\(l => !_quarantinedLotKeySet\.has\(_closedLotKey\(l\)\)\)/, 'closed-trade samples (and walletClosedLotsAll) drop outlier-quarantined lots so they are never shown as normal verified trades')
assert.match(snap, /const _hasOutlierExclusions = _quarantinedLotKeys\.length > 0/, 'pnlQuality computation knows whether any outlier lots were excluded')
assert.match(snap, /_exactFifoCleanEligible && _exactFifoIsMeaningful \? 'exact_fifo'/, 'exact_fifo is never reported when public PnL is based on an outlier-filtered or synthetic-excluded lot set')
assert.match(snap, /_pnlQuality === 'exact_fifo_micro_sample' && _hasOutlierExclusions \? 'outlier_lots_excluded'/, 'pnlQualityReason explains the outlier-exclusion downgrade')
assert.match(ui, /q === 'exact_fifo_micro_sample' && result\.pnlQualityReason === 'outlier_lots_excluded'\) return 'Verified trades found, abnormal-pricing outlier excluded'/, 'UI distinguishes outlier-excluded verified trades from plain dust-only verified trades')

// PNL-SYNTH-FILTER-FIX: a wallet with real-backed FIFO closed lots alongside synthetic
// FIFO-backfilled lots (e.g. 56 real-backed + 57 synthetic) must never report clean exact_fifo,
// must never surface synthetic lots as public verified samples, and must never mix raw and
// real-backed counts in walletTradeStatsSummary.
assert.match(snap, /const _hasSyntheticExclusions = \(promotedLotSummary\.syntheticLotsExcludedFromStats \?\? 0\) > 0/, 'pnlQuality computation knows whether any synthetic lots were excluded from stats')
assert.match(snap, /const _allRawLotsRealBacked = _realClosedLotsCount > 0 && _realClosedLotsCount === \(promotedLotSummary\.closedLots \?\? 0\)/, 'exact_fifo requires every raw closed lot to be real-backed, not just some')
assert.match(snap, /_exactFifoEligible && _exactFifoIsMeaningful && \(_hasSyntheticExclusions \|\| _hasUnknownCostSellLots \|\| _hasFlatEstimateExclusions\) \? 'fifo_with_estimates'/, 'verified real-backed lots alongside excluded synthetic lots map to fifo_with_estimates, not clean exact_fifo')
assert.match(snap, /_pnlQuality === 'fifo_with_estimates' && _hasFlatEstimateExclusions \? 'verified_fifo_with_estimate_lots_excluded'[\s\S]*: _pnlQuality === 'fifo_with_estimates' \? 'verified_fifo_with_synthetic_lots_excluded'/, 'pnlQualityReason explains the synthetic-lot-exclusion downgrade')
assert.match(snap, /const _performanceStatsResult = buildTradeStatsSummary\(_performanceClosedLotsFinal, activityRequested, totalValue\)/, 'public trade stats are recomputed from the performance-grade lot set when synthetic/flat/dust lots exist, not the raw mixed set')
assert.match(snap, /rawClosedLots: _rawClosedLotsFinal,/, 'walletTradeStatsSummary keeps the raw (pre-synthetic-filter) closed-lot count under a distinct rawClosedLots field')
assert.match(snap, /syntheticClosedLotsExcluded: _syntheticLotsExcludedFromStatsFinal,/, 'walletTradeStatsSummary surfaces how many synthetic lots were excluded from the public closedLots count')
assert.match(snap, /const _sampleEligibleLots = _closedLotsForStatsFinal === 0 \? \[\] : _sampleSourceLots\.filter\(_isRealBackedClosedLot\)/, 'public closed-trade samples and walletClosedLotsAll only ever include real-backed lots')
assert.match(snap, /walletSyntheticClosedTradeSamples\?: WalletSnapshot\['walletClosedTradeSamples'\]/, 'synthetic closed-lot samples are kept available debug-only, not on the public sample list')
assert.match(snap, /if \(_p6Integrity\.status === 'invalid' && snapshot\.pnlQuality === 'exact_fifo'\) \{/, 'a hard-invalid pnlIntegrityCheck downgrades an already-assigned exact_fifo tier rather than leaving a contradictory clean-FIFO label')

const routeSrc = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
assert.match(routeSrc, /const recoveryAlreadyFound = snap\?\.walletRecoveryRecommendation\?\.recommended === false/, 'historical-recovery cost guard recognizes when real-backed closed lots were already found')
assert.match(routeSrc, /needsHistorical: !recoveryAlreadyFound && \(/, 'needsHistorical respects recoveryAlreadyFound instead of always firing on historicalStatus === not_requested')
assert.match(routeSrc, /\} else if \(_initialRecoverySignals\.recoveryAlreadyFound\) \{/, 'the default scan path explicitly marks historical recovery not_attempted when closed lots were already found, instead of leaving it unset')
assert.match(routeSrc, /snapshot\.walletHistoricalRecoveryReason = 'closed_lots_already_found'/, 'historical recovery reason uses the non-contradictory closed_lots_already_found label')
assert.match(snap, /_skipReasons\.push\('closed_lots_already_found'\)/, 'the stale already_has_10_closed_lots skip reason is replaced with closed_lots_already_found')



// Wallet Scanner debug/admin fresh scans must bypass every cache/protection layer without
// affecting normal-user cache behavior.
assert.match(routeSrc, /body\?\.bypassCache === true/, 'wallet route accepts bypassCache in the request body')
assert.match(routeSrc, /body\?\.debugFresh === true/, 'wallet route accepts debugFresh in the request body')
assert.match(routeSrc, /debugFreshAllowed = freshRequested && \(debugAllowed \|\| _devBypass \|\| process\.env\.NODE_ENV !== 'production'\)/, 'debugFresh is limited to debug/admin/dev conditions')
assert.match(routeSrc, /const _cacheReadAttempted = !cacheBypassReason/, 'debugFresh/refresh skip memory and persistent cache reads')
assert.match(routeSrc, /_persistentCooldownReadAttempted = !cacheBypassReason && _persistentAvailable/, 'debugFresh skips persistent cooldown reads')
assert.match(routeSrc, /existingInFlight = inFlightKey && !debugFreshAllowed \? walletDeepInFlight\.get\(inFlightKey\) : undefined/, 'debugFresh skips in-flight deep scan dedupe reuse')
assert.match(routeSrc, /providerFetchNeeded: true/, 'live debugFresh responses force providerFetchNeeded true')
assert.match(routeSrc, /cacheHit: false/, 'live debugFresh responses cannot report cacheHit true')
assert.match(routeSrc, /servedFromCacheReason: null/, 'live debugFresh responses do not report a cache serve reason')
assert.match(routeSrc, /blockedLiveFetchReason: null/, 'live debugFresh responses do not report blocked live fetches')
assert.match(routeSrc, /dataFreshness: 'live' as const/, 'debugFresh live scan reports dataFreshness live')
assert.match(routeSrc, /const _cacheWriteAttempted = !noCacheWrite/, 'noCacheWrite prevents cache write attempts')
assert.match(routeSrc, /debug_fresh_no_cache_write/, 'noCacheWrite has an explicit debug cache bypass reason')
assert.match(routeSrc, /debugFreshAllowed && cacheBust \? `:debug:\$\{cacheBust\}` : ''/, 'debug-only cacheBust changes scan keys only when debugFresh is allowed')
assert.match(ui, /Fresh scan \/ bypass cache/, 'wallet scanner shows a fresh scan bypass control')
assert.match(ui, /Do not write cache/, 'wallet scanner shows a no-cache-write control')

// PRICE-INDEPENDENCE-FIX: fake-looking break-even FIFO (entry price === exit price both reused
// from the same non-independent fallback source) must never be treated as verified/decisive PnL.
assert.match(snap, /const CURRENT_PRICE_REUSE_SOURCES = new Set\(\['current_holding_price_open_lot_estimate', 'current_price_fallback_not_used'\]\)/, 'current-price reuse sources are explicitly enumerated')
assert.match(snap, /const FALLBACK_PRICE_REUSE_SOURCES = new Set\(\['historical_price', 'unavailable', 'synthetic', 'fallback'\]\)/, 'fallback price reuse sources are explicitly enumerated')
assert.match(snap, /function computePriceIndependence\(/, 'a price-independence classifier exists for closed lots')
assert.match(snap, /priceIndependenceStatus\?: 'independent_quote_legs' \| 'independent_provider_prices' \| 'mixed_independent' \| 'same_source_flat_estimate' \| 'current_price_reused' \| 'fallback_price_reused' \| 'missing_independent_price' \| 'unknown'/, 'closed lots expose a priceIndependenceStatus tier')
assert.match(snap, /pnlDecisive\?:\s*boolean/, 'closed lots expose a pnlDecisive flag')
assert.match(snap, /pnlDisplayStatus\?:\s*'verified_pnl' \| 'estimate_only_price_flat' \| 'open_check'/, 'closed lots expose a pnlDisplayStatus for UI consumers')
assert.match(snap, /const _priceIndependence = computePriceIndependence\(lot\.priceSource, priceSource, lot\.entryPriceUsd, priceUsd, lot\.openedTxHash, e\.txHash!\)/, 'real FIFO-matched closed lots compute price independence from both legs')
assert.match(snap, /const _synthPriceIndependence = computePriceIndependence\('synthetic', priceSource, priceUsd, priceUsd, e\.txHash!, e\.txHash!\)/, 'synthetic backfilled closed lots are also tagged with price-independence status')

// Trade-stats must not count same-source flat estimates as real break-even wins/losses, and must
// not report a fake "ok" PnL status when every closed lot is a flat estimate.
assert.match(snap, /const _flatEstimateLots = allLots\.filter\(l => l\.pnlDisplayStatus === 'estimate_only_price_flat'\)/, 'trade stats identify same-source flat-price-estimate lots')
assert.match(snap, /const _allLotsFlatEstimate = _flatEstimateLots\.length > 0 && _flatEstimateLots\.length === allLots\.length/, 'trade stats know when every closed lot is a flat estimate')
assert.match(snap, /const breakEven = _statsLots\.filter\(l => Math\.abs\(l\.realizedPnlUsd\) <= BREAK_EVEN_EPSILON\)/, 'breakEvenClosedLots excludes same-source flat estimates')
assert.match(snap, /const _statsLots = _verifiedPnlLots/, 'public trade stats use only verified_pnl lots after price-independence classification')
assert.match(snap, /sampleWarning: 'Closed trades were detected, but entry and exit prices reuse the same non-independent estimate, so PnL and win rate are locked\.'/ , 'an honest sampleWarning explains the flat-estimate-only case')

// verifiedClosedLots must mean real-backed AND independently priced; publicPnlStatus must not be
// "ok" when every real-backed closed lot is a flat estimate.
assert.match(snap, /const _verifiedPnlClosedLotsFinal = _publicLotClassifications\.filter\(x => x\.classification\.verifiedPnlEligible\)\.map\(x => x\.lot\)/, 'verifiedClosedLots excludes same-source flat estimates even when real-backed')
assert.match(snap, /const _allRealBackedLotsFlatEstimate = _closedLotsForStatsFinal > 0 && _verifiedIndependentClosedLotsFinal === 0 && _estimateOnlyClosedLotsFinal\.length > 0/, 'snapshot knows when every real-backed closed lot is a flat estimate')
assert.match(snap, /verifiedClosedLots: _verifiedIndependentClosedLotsFinal,/, 'public verifiedClosedLots is wired to the independent-pricing-filtered count')
assert.match(snap, /publicPnlStatus: _publicPnlStatusFinal,/, 'publicPnlStatus cannot be ok when every real-backed closed lot is a flat estimate')

// walletClosedTradeSamples must not label same-source flat estimates as verifiable.
assert.match(snap, /verificationStatus: 'verifiable' \| 'partial' \| 'not_available' \| 'synthetic_cost_basis_missing' \| 'estimate_only_price_flat' \| 'price_independence_missing'/, 'verificationStatus union includes the new non-verifiable price-independence tiers')
assert.match(snap, /l\.pnlDisplayStatus === 'estimate_only_price_flat' \? 'estimate_only_price_flat'/, 'flat-estimate lots are labeled estimate_only_price_flat, never verifiable')
assert.match(snap, /l\.priceIndependenceStatus === 'missing_independent_price' \? 'price_independence_missing'/, 'lots missing independent evidence on one side are labeled price_independence_missing')


assert.match(snap, /priceIndependenceBreakdown\?: Record<string, number>/, 'debug exposes a priceIndependenceBreakdown')
assert.match(snap, /estimateOnlyClosedLots\?: number/, 'debug exposes estimateOnlyClosedLots')
assert.match(snap, /verifiedPnlClosedLots\?: number/, 'debug exposes verifiedPnlClosedLots')
assert.match(snap, /decisivePnlClosedLots\?: number/, 'debug exposes decisivePnlClosedLots')
assert.match(snap, /flatPriceClosedLotsExcluded\?: number/, 'debug exposes flatPriceClosedLotsExcluded')
assert.match(snap, /flatPriceExclusionReasonCounts\?: Record<string, number>/, 'debug exposes flatPriceExclusionReasonCounts')
assert.match(snap, /sampleFlatPriceExcludedLots\?: WalletSnapshot\['walletClosedTradeSamples'\]/, 'debug exposes sampleFlatPriceExcludedLots')
assert.match(snap, /sampleVerifiedPnlLots\?: WalletSnapshot\['walletClosedTradeSamples'\]/, 'debug exposes sampleVerifiedPnlLots')
assert.match(snap, /publicStatsLotCountBeforePriceIndependence\?: number/, 'debug exposes publicStatsLotCountBeforePriceIndependence')
assert.match(snap, /publicStatsLotCountAfterPriceIndependence\?: number/, 'debug exposes publicStatsLotCountAfterPriceIndependence')
assert.match(snap, /_allRealBackedLotsFlatEstimate \? 'flat_price_estimate_only'/, 'flat-estimate-only wallets receive the flat_price_estimate_only PnL quality reason')
assert.match(snap, /walletClosedLotsAll: _performanceClosedLotsFinal/, 'wallet personality/profile inputs receive only verified_pnl closed lots')



// Public evidence gating regressions for 0x48d4d1d6035326afad16bd061e2620144b2775f1.
assert.match(intel, /personality:\s*'Not enough data'[\s\S]*Public performance sample is too small or partial to classify trading personality/, 'walletPersonality locks to Not enough data when scoreUnlocked is false or public evidence is partial')
assert.match(intel, /classification:\s*'Not enough data'[\s\S]*Bot\/automation read is locked until enough performance-grade trades pass public evidence checks/, 'walletBotScore does not classify semi-automated when scoreUnlocked is false or integrity is invalid')
assert.match(snap, /const winRatePercent = winRateComputed \? \(winning\.length \/ n\) \* 100 : null/, 'winRatePercent is null when sample is below the win-rate threshold')
assert.match(snap, /publicWinRatePercent: _performanceStats\.scoreUnlocked === true \? _performanceStats\.winRatePercent : null/, 'publicWinRatePercent is null when scoreUnlocked is false')
assert.match(snap, /winRatePercent: snapshot\.walletTradeStatsSummary\?\.scoreUnlocked === true \? \(snapshot\.walletTradeStatsSummary\?\.winRatePercent \?\? null\) : null/, 'walletProfileDebug.scoreInputs.winRatePercent is null, not zero, while win rate is locked')
assert.match(snap, /winRateStatus: snapshot\.walletTradeStatsSummary\?\.scoreUnlocked === true[\s\S]*'locked_small_sample'/, 'walletProfileDebug.scoreInputs exposes locked_small_sample for locked win rate')
assert.match(routeSrc, /if \(snap\?\.pnlIntegrityCheck\?\.status === 'invalid'\) return 'partial_invalid_integrity'/, 'pnlCacheQuality is not complete when PnL integrity is invalid')
assert.match(routeSrc, /performanceClosedLots > 0 && performanceClosedLots < 10 \? 'limited_verified_sample' : 'partial_public_performance'/, 'pnlCacheQuality marks limited verified samples instead of complete')
assert.match(routeSrc, /open_lots_tracked_public_pnl_partial/, 'open_lots_tracked_no_closed_trades is not emitted when raw closed lots exist')
assert.match(routeSrc, /_publicBudget\.actualCreditsUsed = _actualCreditsUsed[\s\S]*_publicBudget\.creditsUsed = _actualCreditsUsed/, 'walletScanBudget.actualCreditsUsed equals public creditsUsed and reconciles to apiAudit totalCredits')

// Budget/audit consistency: walletScanBudget.creditsUsed must not silently understate apiAudit.totalCredits.
assert.match(routeSrc, /const _actualCreditsUsed = Number\(snapshot\._diagnostics\?\.apiAudit\?\.totalCredits \?\? _estimatedCreditsUsed\)/, 'walletScanBudget reconciles against the real apiAudit.totalCredits figure')
assert.match(routeSrc, /_publicBudget\.estimatedCreditsUsed = _estimatedCreditsUsed/, 'walletScanBudget exposes the budget-debug estimate distinctly')
assert.match(routeSrc, /_publicBudget\.actualCreditsUsed = _actualCreditsUsed/, 'walletScanBudget exposes the real audited credits distinctly')
assert.match(routeSrc, /_publicBudget\.creditsUsed = _actualCreditsUsed/, 'public creditsUsed reports the real audited credits')
assert.match(routeSrc, /_publicBudget\.hardCapHit = _actualCreditsUsed > _publicBudget\.totalCreditHardCap[\s\S]*_publicBudget\.totalBudgetCapHit = _publicBudget\.hardCapHit/, 'hard budget cap is based on audited credits and surfaced separately from historical phase cap')
assert.match(routeSrc, /_publicBudget\.historicalPhaseCapHit = Boolean\(_scanBudgetDebug\?\.historicalBudgetCapHit\)/, 'historical phase cap is surfaced separately')

// Historical recovery status must not be not_attempted when pages were actually attempted this scan.
assert.match(routeSrc, /const _pagesAttemptedThisScan = Number\(snapshot\.walletHistoricalCoverageSummary\?\.pagesAttempted \?\? 0\)/, 'the recoveryAlreadyFound branch checks whether historical pages were actually attempted this scan')
assert.match(routeSrc, /if \(_historicalRequestedThisScan \|\| _pagesAttemptedThisScan > 0\) \{/, 'not_attempted is never reported once historical coverage was requested or pages were attempted')
assert.match(routeSrc, /payload\.walletHistoricalRecoveryStatus = historicalCapHit \? 'attempted_capped' : 'attempted_light'/, 'historical recovery status reflects attempted pages instead of a contradictory not_attempted label')
assert.match(routeSrc, /payload\?\.walletHistoricalRecoveryReason === 'no_live_provider_calls_cache_hit' && !cacheHit/, 'no_live_provider_calls_cache_hit is stripped unless the response is a true cache hit')
assert.match(ui, /`\$\{tradeClosedLots\} verified trades`/, 'public UI labels trade stats as verified trades, not raw matched lots')

// TRADE-INTEL-V1: trade intelligence unlocks from the broader real-backed lot set even when
// publicPerformanceLots (the strict profit-skill bar) stays small/locked.
assert.match(snap, /const tradeIntelLots = _closedLotsForStatsFinal/, 'tradeIntelLots is derived from the real-backed closed-lot count, not the strict performance set')
assert.match(snap, /const _tradeIntelUnlocked = tradeIntelLots >= 10 \|\| _verifiedIndependentClosedLotsFinal >= 10/, 'trade intelligence unlocks once either tradeIntelLots or verifiedIndependentClosedLots reaches 10')
assert.match(snap, /const _profitSkillUnlocked = _performanceClosedLotsFinal\.length >= 10/, 'profit skill unlock stays gated on the strict performance lot count, separate from trade intel unlock')
assert.match(snap, /'high_speed_rotator' \| 'portfolio_rebalancer' \| 'stable_quote_rotator' \| 'accumulator' \| 'distributor' \| 'mixed_rotator' \| 'not_enough_data'/, 'primaryStyle is restricted to the allowed behavior-style set and never includes sniper')
assert.doesNotMatch(snap, /primaryStyle:[^\n]*'sniper'/, 'primaryStyle never assigns sniper from trade intelligence')
assert.match(snap, /tradeIntelligence,\s*\n\s*walletRecoveryRecommendation: _walletRecoveryRecommendation,/, 'tradeIntelligence object is wired into the snapshot')
assert.match(routeSrc, /tradeIntelligence: \{ status: tradeIntelStatus, tradeIntelLots, reason: tradeIntelReason \}/, 'walletModuleCoverage.tradeIntelligence is wired with status/tradeIntelLots/reason')
assert.match(ui, /Trade Intelligence Read/, 'UI shows the separate Trade Intelligence Read module')

// TRADE-INTEL-WIRING: tradeIntelligence is wired into profile/behavior/module coverage, while
// profit honesty stays strict.
assert.match(identity, /export function readableTradeStyleLabel/, 'a single readable trade-style label helper exists')
assert.match(identity, /high_speed_rotator: 'High-speed rotator'/, 'high_speed_rotator maps to the readable High-speed rotator label')
assert.doesNotMatch(identity, /'[Ss]niper'/, 'profile trade-style labels never output sniper')
assert.match(identity, /const tradeIntelUnlocked = Boolean\(tradeIntel\) && \(tradeIntel!\.status === 'partial' \|\| tradeIntel!\.status === 'ready'\) && \(tradeIntel!\.tradeIntelLots \?\? 0\) >= 10/, 'profile unlocks trading behavior from tradeIntelligence when >=10 behavior lots and partial/ready')
assert.match(identity, /tradingBehavior = tradeIntelStyleLabel/, 'tradingBehavior is set from the tradeIntelligence style label')
assert.match(identity, /tradingConfidence = tradeIntel!\.confidence \?\? tradingConfidence/, 'tradingConfidence uses tradeIntelligence.confidence when unlocked')
assert.match(identity, /Trading style classified from \$\{lots\} verified behavior lots\./, 'profile reasons explain the behavior-lot-derived classification')
// Profit honesty — followability stays Low on near-flat / invalid-integrity / ~zero realized PnL.
assert.match(identity, /const profitNotProven = tradingLockedByPublicPnl \|\| pnlIntegrityStatus === 'invalid' \|\| publicPnlStatus === 'near_flat_verified_sample' \|\| realizedNearZero/, 'profitNotProven gates on integrity invalid / near-flat / ~zero realized PnL')
assert.match(identity, /const followability: WalletProfile\['followability'\] = profitNotProven \? 'Low'/, 'followability stays Low whenever profit is not proven')
assert.match(identity, /Use for behavior\/style read only; profit skill is not proven/, 'nextAction separates behavior read from unproven profit skill')
// Module coverage behavior — never no_activity_data when trade intelligence exists.
assert.match(routeSrc, /tradeIntelStatus === 'ready'\s*\n\s*\? \{ status: 'ready', reason: 'trade_intelligence_ready'/, 'walletModuleCoverage.behavior reports ready/trade_intelligence_ready when trade intelligence is ready')
assert.match(routeSrc, /status: 'partial', reason: 'trade_intelligence_available_profit_skill_limited'/, 'walletModuleCoverage.behavior reports partial/trade_intelligence_available_profit_skill_limited when partial')
// walletBehavior fallback — not unavailable when trade intelligence exists.
assert.match(snap, /source: 'trade_intelligence',\s*\n\s*recentActivitySummary: 'Trade behavior detected from swap\/FIFO evidence\.'/, 'walletBehavior falls back to trade_intelligence source instead of unavailable')
assert.match(snap, /status: 'ok' \| 'partial' \| 'unavailable' \| 'ready'/, 'WalletBehavior status union allows ready')
// Historical recovery reason — provider failure must not claim candidates were priced.
assert.match(routeSrc, /const providerFailed = \(typeof cov\?\.reason === 'string' && \/provider\.\*fail\|attempted_provider_failed\/i\.test\(cov\.reason\)\) \|\| \(pagesAttempted > 0 && normalizedEvents === 0\)/, 'provider-failed scans are detected before claiming priced candidates')
assert.match(routeSrc, /providerFailed\s*\n\s*\? 'historical_provider_failed_or_no_new_closed_lots'\s*\n\s*: pricingRan\s*\n\s*\? 'historical_candidates_priced_no_new_closed_lots'/, 'historical_candidates_priced_no_new_closed_lots is only used when pricing actually ran')
// Budget warnings — compare against the live per-scan target, not a stale hardcoded 5.
assert.match(snap, /if \(_apiTotalCredits > _totalCreditTarget\) _apiWarnings\.push\(`total_credits_\$\{_apiTotalCredits\}_exceeds_target_\$\{_totalCreditTarget\}`\)/, 'total-credit warning uses the live totalCreditTarget')
assert.doesNotMatch(snap, /exceeds_target_5`/, 'no stale hardcoded exceeds_target_5 warning remains')
assert.doesNotMatch(snap, /goldrush_\$\{_grLiveCount\}_calls_expected_4`/, 'no stale hardcoded goldrush expected_4 warning remains')

console.log('wallet bad-scan classification checks passed')
