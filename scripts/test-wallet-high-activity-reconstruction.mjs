import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const ui = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// HIGH-ACTIVITY-RECON-1: an early, budget-time proxy for the "heavy activity, thin reconstruction"
// failure mode drives ONLY a small, hard-capped page expansion — never FIFO/PnL/scoring.
assert.match(snap, /const _earlyHighActivityPoorReconstruction = Boolean\(\s*\n\s*\(walletEvidenceSummary\.totalEvents >= 500 \|\| walletSwapSummary\.swapCandidateEvents >= 50\) &&\s*\n\s*walletSwapSummary\.swapCandidateEvents >= 25 &&\s*\n\s*walletTradeStatsSummary\.closedLots <= 10\s*\n\s*\)/, 'early high-activity-poor-reconstruction proxy exists at budget time')
assert.match(snap, /_earlyHighActivityPoorReconstruction && _walletValueTier === 'high_value' && !_missingCostBasisGuardActive && !_adminOverrideUsed\s*\n\s*\? 2\s*\n\s*: 0/, 'budget expansion is gated on high_value tier + the failure mode, capped at +2 pages')

// Budget expansion must stay inside the existing Math.min clamps so the hard cap can never be exceeded.
assert.match(snap, /const _defaultPagesByTier = \(_walletValueTier === 'micro' \? 0 : 1\) \+ _highActivityExtraPagesAllowed/, 'extra pages are added to the tier default, then re-clamped by the existing Math.min budget bounds')
assert.match(snap, /const _highActivityExtraPagesUsed = Math\.max\(0, Math\.min\(_highActivityExtraPagesAllowed, _pagesAllowed - \(_walletValueTier === 'micro' \? 0 : 1\)\)\)/, 'extra pages used reflects what the clamped budget actually granted, never more than allowed')

// HIGH-ACTIVITY-RECON-2: the final public-safe state uses the REAL public-grade count (zero) and
// the raw matched lot count — it never derives or unlocks anything.
assert.match(snap, /const _highActivityPoorReconstruction = Boolean\(\s*\n\s*\(_reconEvidenceEvents >= 500 \|\| _reconSwapCandidateEvents >= 50\) &&\s*\n\s*_reconPublicLots === 0 &&\s*\n\s*_reconRawMatchedLots <= 10 &&\s*\n\s*_reconSwapCandidateEvents >= 25\s*\n\s*\)/, 'final highActivityPoorReconstruction requires zero public-grade lots, low raw matched lots, and high activity')
assert.match(snap, /reason: _highActivityPoorReconstruction \? 'high_activity_trade_reconstruction_incomplete' : null/, 'public-safe reason string is exposed')
assert.match(snap, /'High activity detected, but most trade candidates could not be promoted because quote legs\/cost basis\/prices were incomplete\.'/, 'compact public-safe summary is present')

// Diagnostics are public-safe — no provider names leak into the reconstruction state.
assert.doesNotMatch(snap, /walletReconstructionRecovery[\s\S]{0,1200}(goldrush|moralis|alchemy|zerion)/i, 'reconstruction recovery state never embeds provider names')

// Output + type are wired through the snapshot.
assert.match(snap, /walletReconstructionRecovery: _walletReconstructionRecovery,/, 'walletReconstructionRecovery is attached to the snapshot output')
assert.match(snap, /walletReconstructionRecovery\?:\s*\{/, 'walletReconstructionRecovery type is declared on WalletSnapshot')
for (const field of ['extraPagesAllowed', 'extraPagesUsed', 'extraPriceAttemptsAllowed', 'extraPriceAttemptsUsed', 'creditsUsed', 'capHitReason']) {
  assert.match(snap, new RegExp(`${field}:`), `reconstruction budget exposes ${field}`)
}

// Public stats stay strict — publicPerformanceClosedLots is the real performance-eligible count,
// and the reconstruction state never feeds it.
assert.match(snap, /publicPerformanceClosedLots: _performanceClosedLotsFinal\.length,/, 'publicPerformanceClosedLots remains the strict performance-eligible count')

// UI: the incomplete-reconstruction card renders, does not look like "no activity", and only offers
// "Try deeper recovery" when a deep path exists, else "Deep recovery recommended".
assert.match(ui, /walletReconstructionRecovery\?\.highActivityPoorReconstruction && \(\(\) =>/, 'UI gates the card on the backend flag')
assert.match(ui, /Trade reconstruction incomplete/, 'UI card title present')
assert.match(ui, /ChainLens found heavy activity and many swap candidates, but could not build public-grade performance evidence from this scan\./, 'UI card explains heavy activity, not no activity')
assert.match(ui, /deepPathExists && !deepActivity \? 'Try deeper recovery' : 'Deep recovery recommended'/, 'UI CTA copy depends on whether a deep path exists')
for (const label of ['Events indexed', 'Swap candidates', 'Raw matched lots', 'Excluded lots', 'Public-grade lots']) {
  assert.match(ui, new RegExp(`'${label}'`), `UI card shows ${label}`)
}

console.log('wallet high-activity reconstruction checks passed')
