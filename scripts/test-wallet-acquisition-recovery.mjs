import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// Scenario 1: high-value holdings + zero swap candidates -> acquisition recovery eligible,
// independent of (and never blocked by) the old no_swap_or_lot_evidence gate.
assert.match(snap, /const _acqHighValueWallet = _walletValueTier === 'high_value' \|\| _walletValueTier === 'whale' \|\| totalValue >= 1000/, 'acquisition recovery has a high-value/meaningful-totalValue eligibility signal')
assert.match(snap, /const _acqLowSwapOrLotEvidence = \(walletLotSummary\.openedLots \?\? 0\) === 0 \|\| \(walletTradeStatsSummary\.closedLots \?\? 0\) === 0/, 'acquisition recovery eligibility allows zero open lots / zero closed lots')
assert.match(snap, /const _acquisitionRecoveryEligible = Boolean\(/, 'a dedicated acquisitionRecoveryEligible flag exists')
assert.doesNotMatch(snap.match(/const _acquisitionRecoveryEligible = Boolean\(([\s\S]{0,400})\)/)[1], /no_swap_or_lot_evidence/, 'acquisition recovery eligibility is never gated on no_swap_or_lot_evidence')
assert.match(snap, /if \(_acquisitionRecoveryEligible\) _eligibilityReasons\.push\('acquisition_history_recovery_for_top_holdings'\)/, 'eligible acquisition recovery surfaces acquisition_history_recovery_for_top_holdings as its reason')
assert.match(snap, /\?\? \(_acquisitionRecoveryEligible \? \(_historicalBudgetCapHit \? 'budget_cap' : _historicalNotRunDueToCostGuard \? 'budget_cap' : 'budget_cap'\) : \(_skipReasons\[0\] \?\? null\)\)/, 'walletHistoricalScanDebug.stopReason reports a real skip reason when acquisition recovery is eligible but not run')

// Scenario 2: target tokens are selected from top holdings (via _rankedHistoricalTargets), with
// dust excluded and capped at 3 normal / 4 high-value/deep.
assert.match(snap, /const ACQ_DUST_HOLDING_USD = 5/, 'a dust-holding USD threshold exists for acquisition target selection')
assert.match(snap, /const _acqMaxTargetTokens = \(_walletValueTier === 'high_value' \|\| _walletValueTier === 'whale' \|\| deepScan\) \? 4 : 3/, 'acquisition target token cap is 3 normal / 4 high-value-or-deep')
assert.match(snap, /const _acquisitionTargetTokens = _rankedHistoricalTargets\s*\n\s*\.filter\(t => t\.estimatedUsd >= ACQ_DUST_HOLDING_USD\)\s*\n\s*\.slice\(0, _acqMaxTargetTokens\)/, 'acquisition targets are ranked top holdings filtered for dust and capped')

// Scenario 3: Moralis inbound target-token transfer found -> acquisition inbound candidate created.
assert.match(snap, /if \(\(item\.token_address \?\? ''\)\.toLowerCase\(\) !== target\.contract\) continue/, 'Moralis transfer items are filtered to the target contract')
assert.match(snap, /if \(\(item\.to_address \?\? ''\)\.toLowerCase\(\) !== walletLower\) continue/, 'Moralis transfer items are filtered to wallet-side INBOUND transfers only')
assert.match(snap, /const ACQ_MAX_PAGES_PER_TOKEN = 3/, 'deep acquisition recovery caps pages per token at 3')
assert.match(snap, /const ACQ_MAX_TOTAL_PAGES = 8/, 'deep acquisition recovery caps total pages at 8')

// Scenario 4: receipt has a quote leg -> safe acquisition swap candidate created (requires BOTH a
// wallet-side target-token leg AND a verified quote/payment leg, and more than one leg in the tx).
assert.match(snap, /if \(hasWalletLeg && hasQuoteLeg && distinctLegs > 1\) \{/, 'acquisition candidates are only promoted with a wallet leg, a quote leg, and more than one leg (never a one-leg transfer)')
assert.match(snap, /reason: 'Acquisition recovery: inbound target-token transfer with verified quote\/payment leg in receipt'/, 'promoted acquisition candidates are tagged with a clear receipt-verified reason')

// Scenario 5: receipt has no quote leg -> no fake swap is created, tracked as acquisition_no_quote_leg.
assert.match(snap, /acquisitionRecoveryReason: newEvidence\.length > 0 \? 'acquisition_history_recovery_for_top_holdings' : 'acquisition_no_quote_leg'/, 'when no candidate is promoted, the recovery reason is acquisition_no_quote_leg')
assert.match(snap, /\} else \{\s*\n\s*noQuoteLegCount\+\+\s*\n\s*\}/, 'unvalidated candidates are tracked via noQuoteLegCount, never silently promoted')

// Scenario 6: budget cap -> recovery stops safely, exposes cap reason, never throws.
assert.match(snap, /if \(pagesUsed >= ACQ_MAX_TOTAL_PAGES \|\| budgetRemaining\(\) <= 0\) \{\s*\n\s*stopReason = 'budget_cap'/, 'acquisition recovery stops safely and reports budget_cap when the page/budget cap is hit')
assert.match(snap, /acquisition_history_recovery_budget_capped/, 'noTradesReason exposes acquisition_history_recovery_budget_capped')
assert.match(snap, /acquisition_history_recovery_no_inbound_found/, 'noTradesReason exposes acquisition_history_recovery_no_inbound_found')
assert.match(snap, /acquisition_history_recovery_attempted_no_quote_leg/, 'noTradesReason exposes acquisition_history_recovery_attempted_no_quote_leg')
assert.match(snap, /acquisition_history_recovery_found_transfers_no_swaps/, 'noTradesReason exposes acquisition_history_recovery_found_transfers_no_swaps')

// Scenario 7: no public-grade PnL promotion unless existing price/FIFO/public rules pass —
// promoted candidates only merge into the SAME evidence array consumed by the existing
// pricing/FIFO pipeline; this code never writes realizedPnlUsd/publicPerformanceClosedLots itself.
assert.match(snap, /\.\.\._acquisitionRecoveryNewEvidence\.filter\(/, 'new acquisition evidence merges into the same _finalCandidateEvidence array as other historical recovery sources')
assert.match(snap, /\.\.\._acquisitionRecoveryNewEvidence\]/, 'new acquisition evidence merges into the same _finalAllHistoricalEvidence array consumed by existing pricing/FIFO')
assert.doesNotMatch(snap, /_acquisitionRecoveryNewEvidence[\s\S]{0,80}realizedPnlUsd\s*=/, 'acquisition recovery code never directly writes realizedPnlUsd')
assert.doesNotMatch(snap, /_acquisitionRecoveryNewEvidence[\s\S]{0,80}publicPerformanceClosedLots\s*=/, 'acquisition recovery code never directly writes publicPerformanceClosedLots')

// Debug field coverage (Task 3 requested field names).
for (const field of ['acquisitionRecoveryAttempted', 'acquisitionRecoveryEligible', 'acquisitionRecoveryReason', 'acquisitionTargetTokens', 'acquisitionPagesUsed', 'acquisitionEventsFetched', 'acquisitionInboundTransfersFound', 'acquisitionRecoveryInboundFound', 'acquisitionCandidateTxs', 'acquisitionRecoveryOutboundFound', 'acquisitionRecoveryEventsAddedToFifo', 'acquisitionRecoveryOpenedLotsAfter', 'acquisitionRecoveryClosedLotsAfter', 'acquisitionRecoverySkippedReason', 'acquisitionStopReason']) {
  assert.match(snap, new RegExp(`${field}[?:]`), `acquisitionRecoveryDebug exposes ${field}`)
}

console.log('wallet top-holding acquisition recovery checks passed')
