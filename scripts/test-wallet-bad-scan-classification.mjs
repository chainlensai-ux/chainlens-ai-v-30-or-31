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
assert.match(snap, /_exactFifoEligible && _exactFifoIsMeaningful \? 'exact_fifo'/, 'exact_fifo requires economically meaningful closed lots, not just any real-backed closed lot')
assert.match(snap, /: _exactFifoEligible \? 'exact_fifo_micro_sample'/, 'verified dust-only closed lots map to exact_fifo_micro_sample instead of exact_fifo')
assert.match(snap, /_pnlQuality === 'exact_fifo_micro_sample' \? 'exact_fifo_but_micro_sample'/, 'pnlQualityReason explains the micro-sample downgrade')
assert.match(snap, /_exactFifoEligible && !_exactFifoIsMeaningful \? 'verified_lots_below_meaningful_threshold'/, 'pnlQualityReason flags verified lots below the meaningful threshold')
assert.match(ui, /q === 'exact_fifo_micro_sample'\) return 'Verified dust trades found, not enough meaningful trade data'/, 'UI shows dust-only verified trades as not-meaningful, not strong exact FIFO performance')

const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
assert.match(intel, /meaningfulClosedLots === 0 \|\| tradeStats\?\.economicSignificance === 'micro_sample'/, 'wallet personality requires meaningful (non-dust) verified closed lots, not just 3+ raw closed lots')
assert.match(intel, /personality: 'Not enough data',\s*\n\s*scores: null,\s*\n\s*summary: 'Verified closed trades exist, but are too small \(dust-sized\) to classify/, 'dust-only verified trades return Not enough data / null scores, not a personality label')

console.log('wallet bad-scan classification checks passed')
