import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// ACTIVITY-ATTRIBUTION: "evidence collected for reconstruction" must be separated from "wallet-side
// activity". The evidence summary exposes both, derived from event.direction (unknown = context-only
// log the wallet is not directly the from/to of).
assert.match(snap, /const walletSideEvents = _dedupedEvents\.filter\(e => e\.direction !== 'unknown'\)\.length/, 'wallet-side events = events the scanned wallet is directly the from/to of (direction !== unknown)')
assert.match(snap, /const reconstructionContextEvents = totalEvents - walletSideEvents/, 'context-only events are the complement of wallet-side events')
for (const field of ['totalEvidenceEvents:', 'walletSideEvents,', 'reconstructionContextEvents,', 'unknownContextEvents:', 'totalRawLogs:']) {
  assert.match(snap, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `walletEvidenceSummary exposes ${field}`)
}

// A separate, wallet-side-only public activity summary is built and attached to the snapshot.
assert.match(snap, /walletActivitySummary\?:\s*\{/, 'walletActivitySummary type is declared')
assert.match(snap, /walletSideEvents: inboundCount \+ outboundCount/, 'walletActivitySummary.walletSideEvents counts only buy/sell (wallet-side) events')
assert.match(snap, /if \(txEvs\.some\(e => e\.direction !== 'unknown'\)\) _walletSideTxCount\+\+/, 'walletSideTransactions counts only txns with at least one wallet-side leg')
for (const field of ['walletInitiatedTransactions:', 'receivedCount:', 'sentCount:', 'swapLikeWalletTransactions:', 'transferOnlyWalletTransactions:', 'claimOrAirdropLikeWalletTransactions:', 'trueActivityWindowDays:', 'firstWalletSideActivityAt:', 'lastWalletSideActivityAt:']) {
  assert.match(snap, new RegExp(field), `walletActivitySummary exposes ${field}`)
}
assert.match(snap, /walletActivitySummary: _walletActivitySummary,/, 'walletActivitySummary is attached to the snapshot output')

// TRIGGER: high-activity detection must use wallet-side activity OR swap candidates — never total
// evidence events alone. A context-only-busy wallet is classified evidence_context_only and never
// labeled high wallet activity.
assert.match(snap, /const _reconHasGenuineWalletActivity = _reconWalletSideEvents >= 100 \|\| _reconWalletSideTxns >= 50/, 'genuine activity gate uses wallet-side events/txns')
assert.match(snap, /const _reconHasHighSwapCandidates = _reconSwapCandidateEvents >= 50/, 'swap candidate gate uses >= 50 swap candidates')
assert.match(snap, /_reconHasGenuineWalletActivity \? 'wallet_side_activity'\s*\n\s*: _reconHasHighSwapCandidates \? 'swap_candidates'\s*\n\s*: _reconEvidenceEvents >= 500 \? 'evidence_context_only'/, 'highActivityReason distinguishes wallet activity, swap candidates, and context-only')
// The trigger Boolean must NOT depend on total evidence events.
assert.match(snap, /const _highActivityPoorReconstruction = Boolean\(\s*\n\s*\(_reconHasGenuineWalletActivity \|\| _reconHasHighSwapCandidates\) &&/, 'highActivityPoorReconstruction triggers on wallet-side activity or swap candidates only')
// evidence_context_only alone must never satisfy the trigger (it is not in the trigger expression).
assert.doesNotMatch(snap, /_highActivityPoorReconstruction = Boolean\([\s\S]{0,160}_reconEvidenceEvents >= 500/, 'total evidence events alone can never trigger high activity')

// The budget expansion (extra provider pages) is also gated on wallet-side activity, never total evidence.
assert.match(snap, /_earlyHighActivityPoorReconstruction = Boolean\(\s*\n\s*\(\(walletEvidenceSummary\.walletSideEvents \?\? 0\) >= 100 \|\| walletSwapSummary\.swapCandidateEvents >= 50\)/, 'budget expansion proxy uses wallet-side events, not total evidence events')

// UI: public Activity Summary shows wallet-side activity and discloses context-only logs separately,
// with a "high reconstruction context, limited direct wallet activity" note when evidence >> wallet-side.
assert.match(ui, /public Activity Summary shows WALLET-SIDE activity/, 'UI Activity Summary is wallet-side based')
assert.match(ui, /'Wallet-side transfers', String\(walletSide\)/, 'UI Activity Summary shows wallet-side transfers')
assert.match(ui, /evidence events indexed for reconstruction · .*context-only log/, 'UI discloses evidence vs context-only logs')
assert.match(ui, /High reconstruction context, limited direct wallet activity\./, 'UI shows the context-heavy warning copy')
assert.match(ui, /Evidence indexed/, 'UI activity row is relabeled from "Activity indexed" to "Evidence indexed"')
assert.doesNotMatch(ui, /fontFamily: 'var\(--font-inter, Inter, sans-serif\)' \}\}>Activity indexed<\/span>/, 'the misleading "Activity indexed" label for total transfer events is gone')

console.log('wallet activity attribution checks passed')
