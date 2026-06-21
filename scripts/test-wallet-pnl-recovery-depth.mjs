import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')
const route = fs.readFileSync('app/api/wallet/route.ts', 'utf8')

// dataFreshness must reflect this route's own cacheHit outcome, not an internal provider cache hit
assert.match(route, /snapshot\.dataFreshness = 'live'/, 'live (non-persistent-cache) responses force dataFreshness to live regardless of internal provider cache hits')

// Targeted recovery recommendation — reuses existing ranked targets, no new provider calls
assert.match(snap, /walletRecoveryRecommendation\?:\s*\{/, 'walletRecoveryRecommendation type is present')
assert.match(snap, /_rankedHistoricalTargets\.slice\(0, 3\)\.map/, 'recovery recommendation targets the top 3 ranked tokens by value')
assert.match(snap, /mode: 'targeted_token_recovery'/, 'recovery recommendation uses targeted_token_recovery mode')
assert.match(snap, /estimatedExtraPages: Math\.min\(2, targetTokens\.length\)/, 'recovery recommendation caps estimated extra pages')

// Dedup guard: balance-delta promotion never double-promotes an event already a swap candidate
assert.match(snap, /if \(e\.swapDetection\?\.isSwapCandidate\) continue/, 'already-classified swap candidates are skipped, avoiding duplicate FIFO events')
assert.match(snap, /existingSwapKeys\.has\(eventKey\)/, 'single-leg promotion dedupes against existing swap-candidate keys by tx+contract+direction')

// UI copy
assert.match(ui, /Verified trade evidence/, 'UI shows public-safe verified trade evidence label')
assert.match(ui, /Public-safe FIFO read/, 'UI shows Public-safe FIFO read label')
assert.match(ui, /Sell found — buy cost missing/, 'UI shows sell-side-only label')
assert.match(ui, /Open position — cost basis missing/, 'UI shows open-positions-cost-missing label')
assert.match(ui, /Activity found — no matched trade yet/, 'UI shows activity-only label')
assert.match(ui, /Targeted recovery recommended/, 'UI shows targeted recovery recommendation')
assert.match(ui, /does not fake profit/, 'UI explains PnL is only shown from matched lots, never faked')

// PNL-RECOVERY-V2-BASE: synthetic lots must never count as recovery success — only a real-backed
// closed-lot count can gate the Base FIFO coverage recovery mechanism.
assert.match(snap, /_realBackedClosedLotsCountEarly === 0 &&\s*\n\s*walletSwapSummary\.swapCandidateEvents > 0/, 'base FIFO coverage trigger uses real-backed closed lot count, not raw closedLots')
assert.match(snap, /_realBackedClosedLotsCountEarly > 0 \? 'already_has_closed_lots'/, 'already_has_closed_lots skip reason uses real-backed closed lot count, not raw closedLots')
assert.doesNotMatch(snap, /walletLotSummary\.closedLots === 0 &&\s*\n\s*walletSwapSummary\.swapCandidateEvents > 0/, 'base FIFO coverage trigger no longer gates on raw closedLots === 0')
assert.doesNotMatch(snap, /walletLotSummary\.closedLots > 0 \? 'already_has_closed_lots'/, 'already_has_closed_lots skip reason no longer gates on raw closedLots > 0')

// Wallet PnL Recovery V2 (Base): receipt-level reconstruction, gated on synthetic lots present and
// zero real-backed closed lots, strictly capped, reusing existing tx hashes (no new provider spam).
assert.match(snap, /function buildWalletPnlRecoveryV2Base\(/, 'buildWalletPnlRecoveryV2Base function exists')
assert.match(snap, /export type WalletPnlRecoveryV2Debug = \{/, 'WalletPnlRecoveryV2Debug type exists')
for (const field of [
  'attempted', 'reason', 'targetTokens', 'candidateTxCount', 'receiptsFetched', 'decodedTransferLogs',
  'walletTokenInLegs', 'walletTokenOutLegs', 'quoteInLegs', 'quoteOutLegs', 'realBuyEventsBuilt',
  'realSellEventsBuilt', 'priorBuysRecovered', 'closedLotsBefore', 'closedLotsAfter',
  'realClosedLotsBefore', 'realClosedLotsAfter', 'syntheticLotsBefore', 'syntheticLotsAfter',
  'stoppedReason', 'sampleRecoveredBuys', 'sampleRecoveredSells', 'sampleRejectedTxs',
]) {
  assert.match(snap, new RegExp(`${field}[?:]`), `WalletPnlRecoveryV2Debug includes ${field}`)
}
assert.match(snap, /_pnlRecoveryV2BaseEligible =\s*\n\s*_baseReconChainOk &&\s*\n\s*_syntheticClosedLots\.length > 0 &&\s*\n\s*_realBackedClosedLotsCountForV2 === 0/, 'Recovery V2 remains eligible whenever realClosedLots=0 and syntheticClosedLots>0')
assert.match(snap, /targetTokens = targetTokenContracts\.slice\(0, 2\)/, 'Recovery V2 caps target tokens to 2')
assert.match(snap, /\.slice\(0, Math\.max\(0, maxReceipts\)\)/, 'Recovery V2 caps receipt fetches to the passed maxReceipts budget')
assert.match(snap, /debug\.priorBuysRecovered > 0\) \{ debug\.stoppedReason = 'real_buy_found'; break \}/, 'Recovery V2 stops immediately once a real prior buy is reconstructed')
assert.match(snap, /walletPnlRecoveryV2Debug,/, 'walletPnlRecoveryV2Debug is wired into the diagnostics output')

// Stale-label fixes
assert.match(snap, /_anyTargetedRecoveryAttempted = _syntheticTargetExtraRecoveryAttempted \|\| walletPnlRecoveryV2Debug\.attempted/, 'syntheticRecoverySkippedReason no longer falls back to the stale wallet_value_below_100 reason once targeted recovery has attempted')
assert.match(snap, /_anyTargetedRecoveryAttempted\s*\n\s*\? 'targeted_recovery_attempted_no_prior_buy_found'/, 'Recovery V2 attempts are folded into the same targeted_recovery_attempted_no_prior_buy_found label as the existing targeted extra-page mechanism')
assert.match(snap, /syntheticTargetTokens = rankedTargetTokens\.length > 0 \? rankedTargetTokens : _syntheticLotTokenTargets\.slice\(0, 3\)/, 'walletRecoveryRecommendation falls back to synthetic lot target tokens instead of reporting no_useful_token_contracts when one exists')

console.log('wallet PnL recovery depth checks passed')
