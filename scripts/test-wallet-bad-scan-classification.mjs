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
assert.match(snap, /if \(_realClosedLotsCount > 0\) \{\s*\n\s*return \{ recommended: false, mode: 'none', targetTokens: \[\], reason: 'closed_lots_already_found'/, 'closed_lots_already_found is only returned when real-backed closed lots exist')
assert.match(snap, /verificationStatus: 'verifiable' \| 'partial' \| 'not_available' \| 'synthetic_cost_basis_missing'/, 'synthetic closed-trade samples get a distinct non-verifiable status')
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
assert.match(snap, /_exactFifoEligible && _exactFifoIsMeaningful && \(_hasSyntheticExclusions \|\| _hasUnknownCostSellLots\) \? 'fifo_with_estimates'/, 'verified real-backed lots alongside excluded synthetic lots map to fifo_with_estimates, not clean exact_fifo')
assert.match(snap, /_pnlQuality === 'fifo_with_estimates' \? 'verified_fifo_with_synthetic_lots_excluded'/, 'pnlQualityReason explains the synthetic-lot-exclusion downgrade')
assert.match(snap, /const _realBackedStats = buildTradeStatsSummary\(_realBackedClosedLotsFinal, activityRequested, totalValue\)/, 'public trade stats are recomputed from the real-backed-only lot set when synthetic lots exist, not the raw mixed set')
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

console.log('wallet bad-scan classification checks passed')
