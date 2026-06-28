import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// The early-exit gate must be computed before the historical pricing/recovery eligibility checks
// it gates, using a strict (zero-initiated, zero-outbound, zero-closed-lots, zero-swap-candidate)
// trigger so it never fires for a wallet with any real trading activity.
assert.match(snap, /const _nonTraderEarlyExit = Boolean\(\s*\n\s*_earlyNonTraderAddressType &&\s*\n\s*!_possibleRelayedTrader &&\s*\n\s*_earlyWalletInitiatedTxCount === 0 &&\s*\n\s*_earlyOutboundCount === 0 &&\s*\n\s*_closedLots\.length === 0 &&\s*\n\s*\(walletSwapSummary\.swapCandidateEvents \?\? 0\) === 0\s*\n\s*\)/, 'non-trader early-exit gate requires zero initiated txs, zero outbound, zero closed lots, zero swap candidates, and no possible-relayed-trader signal')

// RELAYED-TRADER-DETECTION-1: a wallet with high-value holdings plus recovered/unknown-direction
// swap-context evidence must suppress nonTraderEarlyExit instead of being locked as non-trader —
// this is the regression fixture for the 0x4dbb-style wallet (zero wallet-initiated txs, high
// value, recoveredUnknownDirectionEvents>0, recoveredSwapContextTransactions>0, unknownDirectionEvents>20).
assert.match(snap, /const _possibleRelayedTrader = Boolean\(totalValue >= 10000 && _relayedReasons\.length > 0\)/, 'possibleRelayedTrader requires totalValue >= 10000 and at least one relayed-trader signal')
assert.match(snap, /if \(_relayedRecoveredUnknownDirectionEvents > 0\) _relayedReasons\.push\('recovered_unknown_direction_events'\)/, 'relayed-trader detection checks recoveredUnknownDirectionEvents')
assert.match(snap, /if \(_relayedRecoveredSwapContextTransactions > 0\) _relayedReasons\.push\('recovered_swap_context_transactions'\)/, 'relayed-trader detection checks recoveredSwapContextTransactions')
assert.match(snap, /if \(_relayedUnknownDirectionEvents >= 20\) _relayedReasons\.push\('high_unknown_direction_events'\)/, 'relayed-trader detection checks unknownDirectionEvents >= 20')
assert.match(snap, /_noPnlReason = 'relayed_trader_needs_deeper_reconstruction'; _noPnlLabel = 'Trading activity may be routed through contracts\/relayers'/, 'relayed-trader case sets walletNoPnlReason to relayed_trader_needs_deeper_reconstruction, not non_trader_address_type')
assert.match(snap, /walletRelayedTraderDetectionDebug\?:/, 'WalletSnapshot exposes walletRelayedTraderDetectionDebug')
assert.match(snap, /nonTraderEarlyExitSuppressed: Boolean\(_earlyNonTraderAddressType && _possibleRelayedTrader\)/, 'walletRelayedTraderDetectionDebug exposes nonTraderEarlyExitSuppressed')

// Every recovery/pricing eligibility path that could spend provider credits for a non-trader
// wallet must be gated off, including the acquisition-recovery-for-top-holdings path that fires
// even with zero swap/lot evidence (the root cause of the reported credit leak).
for (const gated of ['_historicalEligibleCoreCriteria', '_acquisitionRecoveryEligible']) {
  const re = new RegExp(`const ${gated} = Boolean\\(\\s*\\n\\s*!_nonTraderEarlyExit &&`)
  assert.match(snap, re, `${gated} is gated off for a non-trader early-exit wallet`)
}
for (const gated of ['_noSwapCandidateRecoveryEligible', '_pnlRecoveryV2BaseEligible']) {
  const re = new RegExp(`const ${gated} =\\s*\\n\\s*!_nonTraderEarlyExit &&`)
  assert.match(snap, re, `${gated} is gated off for a non-trader early-exit wallet`)
}

// The defensive safety net forces both historical preview summaries to not_requested for a
// non-trader wallet regardless of what ran above it.
assert.match(snap, /if \(_nonTraderEarlyExit\) \{\s*\n\s*walletHistoricalPricingPreviewSummary\.status = 'not_requested'\s*\n\s*walletHistoricalPricingPreviewSummary\.requested = false/, 'historical pricing preview is forced to not_requested for a non-trader wallet')
assert.match(snap, /walletHistoricalFifoPreviewSummary\.status = 'not_requested'\s*\n\s*walletHistoricalFifoPreviewSummary\.requested = false/, 'historical FIFO preview is forced to not_requested for a non-trader wallet')

// Debug fields are exposed so the manual report and future debugging can confirm the gate fired.
assert.match(snap, /nonTraderEarlyExit: _nonTraderEarlyExit,/, 'walletScanBudgetDebug exposes nonTraderEarlyExit')
assert.match(snap, /nonTraderEarlyExitReason: _nonTraderEarlyExitReason,/, 'walletScanBudgetDebug exposes nonTraderEarlyExitReason')
assert.match(snap, /modulesSkippedForNonTrader: _modulesSkippedForNonTrader,/, 'walletScanBudgetDebug exposes modulesSkippedForNonTrader')
assert.match(snap, /creditsPreventedByNonTraderExit: _creditsPreventedByNonTraderExit,/, 'walletScanBudgetDebug exposes creditsPreventedByNonTraderExit')

// walletLockedPnlRead gives the non-trader case top precedence over the generic integrity-locked
// wording, with the exact required headline/reason text.
assert.match(snap, /'open_check_non_trader'/, 'walletLockedPnlRead status union includes open_check_non_trader')
assert.match(snap, /const _lockedStatus: NonNullable<WalletSnapshot\['walletLockedPnlRead'\]\>\['status'\] = _walletIsContractLikeForPnl\s*\n\s*\? 'open_check_non_trader'/, 'walletLockedPnlRead status checks _walletIsContractLikeForPnl first')
assert.match(snap, /const _lockedHeadline = _walletIsContractLikeForPnl\s*\n\s*\? 'Trader PnL not applicable'/, 'walletLockedPnlRead headline reads "Trader PnL not applicable" for a non-trader wallet')
assert.match(snap, /reason: _walletIsContractLikeForPnl\s*\n\s*\? 'This address does not show wallet-initiated trading activity\.'/, 'walletLockedPnlRead reason matches the required wording for a non-trader wallet')

// _walletIsContractLikeForPnl also covers the early-exit flag, not just the late walletFacts
// classification, so the public-copy override applies even before walletFacts is rebuilt.
assert.match(snap, /const _walletIsContractLikeForPnl = Boolean\(_nonTraderEarlyExit\) \|\| _walletAddressTypeForGate === 'token_contract_like' \|\| _walletAddressTypeForGate === 'treasury_or_distributor_like'/, '_walletIsContractLikeForPnl includes the non-trader early-exit flag')

// route.ts forces walletLoadState to a clean final state for a non-trader wallet instead of
// leaving heavyModulesPending populated when the verdict (PnL not applicable) is already known.
assert.match(route, /const nonTraderEarlyExit = payload\.walletNoPnlReason === 'non_trader_address_type'/, 'route.ts detects the non-trader verdict from walletNoPnlReason')
assert.match(route, /if \(nonTraderEarlyExit\) \{\s*\n\s*stage = 'final'\s*\n\s*finalPnlReady = false\s*\n\s*finalRecoveryReady = true\s*\n\s*finalHeavyModulesPending = \[\]\s*\n\s*\}/, 'route.ts forces stage=final, pnlReady=false, recoveryReady=true, heavyModulesPending=[] for a non-trader wallet')
assert.match(route, /skippedReason: 'non_trader_address_type: trade reconstruction and historical recovery were skipped/, 'route.ts records a skipped-reason note for the non-trader case')

console.log('wallet non-trader early-exit checks passed')
