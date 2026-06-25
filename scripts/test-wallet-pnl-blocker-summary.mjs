import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// walletPnlBlockerSummary is additive — type declared, built from already-computed integrity
// gate signals only, never recomputing PnL or unlocking the underlying gates.
assert.match(snap, /walletPnlBlockerSummary\?: \{[\s\S]{0,40}status: 'ready' \| 'locked_recoverable' \| 'locked_integrity' \| 'locked_insufficient_evidence'/, 'walletPnlBlockerSummary type declares the four statuses')
assert.match(snap, /snapshot\.walletPnlBlockerSummary = \{/, 'snapshot.walletPnlBlockerSummary is assigned')

// High behavior evidence + integrity invalid + synthetic lots => locked_recoverable.
assert.match(snap, /const _blockerRecoverable = _blockerLockedByGate && !_blockerHasNonRecoverableError && \(_p6SyntheticLotCount > 0 \|\| _blockerHistoricalCapHit\)/, 'recoverable requires synthetic lots or historical cap hit, and no non-recoverable hard error')
assert.match(snap, /\? 'locked_recoverable' : 'locked_integrity'/, 'locked status branches on recoverability')

// Reasons mirror the example wallet exactly: synthetic cost basis, coverage threshold, portfolio
// delta mismatch, historical recovery cap.
assert.match(snap, /`\$\{_p6SyntheticLotCount\} closed lots are missing real prior-buy cost basis`/, 'reasons include synthetic cost basis count')
assert.match(snap, /'coverage is below public PnL threshold'/, 'reasons include coverage-below-threshold wording')
assert.match(snap, /'portfolio delta integrity check failed'/, 'reasons include portfolio delta mismatch wording')
assert.match(snap, /'historical recovery hit event cap'/, 'reasons include historical recovery cap wording')

// recoveryMode and nextAction never imply an automatic deeper scan — only a user-triggered action.
assert.match(snap, /recoveryMode: 'deep_history' \| 'price_evidence' \| 'none'/, 'recoveryMode type is declared')
assert.match(snap, /'Run deeper historical recovery for prior buys before showing public PnL\.'/, 'nextAction cites deep history recovery as an explicit next step')

// Debug fields requested by the task.
assert.match(snap, /pnlBlockerSummarySource = 'wallet_pnl_blocker_summary_1'/, 'pnlBlockerSummarySource debug field set')
assert.match(snap, /pnlRecoverableReason = _blockerRecoverable/, 'pnlRecoverableReason debug field set')
assert.match(snap, /syntheticCostBasisLotsBlocking = _p6SyntheticLotCount/, 'syntheticCostBasisLotsBlocking debug field set')
assert.match(snap, /historicalRecoveryCapHit = _blockerHistoricalCapHit/, 'historicalRecoveryCapHit debug field set')
assert.match(snap, /historicalRecoveryCapReason = _blockerHistoricalCapHit/, 'historicalRecoveryCapReason debug field set')
assert.match(snap, /pnlOpenCheckReducedToSpecificStatus = \(_blockerOfficialAvailable \? null : _blockerStatus\)/, 'pnlOpenCheckReducedToSpecificStatus debug field set')

// No new provider calls / no automatic deeper scan — the summary only reads already-computed
// signals inside a try block, it never calls a fetch/provider/recovery trigger itself.
const blockerBlockMatch = snap.match(/\/\/ WALLET-PNL-BLOCKER-SUMMARY-1: built from the same[\s\S]*?\n    \} catch \{\n      \/\/ WALLET-PNL-BLOCKER-SUMMARY-1: best-effort additive summary[\s\S]*?\n    \}\n/)
assert.ok(blockerBlockMatch, 'WALLET-PNL-BLOCKER-SUMMARY-1 block found')
const blockerBlock = blockerBlockMatch[0]
assert.doesNotMatch(blockerBlock, /fetch\(|await /, 'blocker summary block makes no provider calls or awaits')
assert.doesNotMatch(blockerBlock, /Moralis|Etherscan|Alchemy|Covalent|Helius|Birdeye|QuickNode|Zerion/i, 'blocker summary block contains no public provider names')

// tradeIntelligence.status is computed independently of the PnL integrity gate (behavior vs PnL
// are kept separate) — confirms "Trade behavior ready" can show even when PnL is locked.
assert.match(snap, /status: 'ready' \| 'partial' \| 'open_check'/, 'tradeIntelligence.status type unchanged (behavior-only, independent of PnL gate)')

// PnL/win-rate/profit-skill gates themselves are untouched — same hard-invalid branch as before.
assert.match(snap, /if \(_p6GateApplies && _p6HardInvalid\) \{/, 'existing hard-invalid PnL gate branch is unchanged')
assert.match(snap, /\(snapshot as any\)\.publicPnlStatus = 'open_check_integrity_invalid'/, 'existing publicPnlStatus downgrade is unchanged')

// Synthetic lots are never promoted — synthetic count is reported, not used to unlock PnL.
assert.doesNotMatch(blockerBlock, /publicPnlStatus = 'ok'/, 'blocker summary never sets publicPnlStatus to ok')
assert.doesNotMatch(blockerBlock, /winRatePercent = /, 'blocker summary never sets a win rate')

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// UI wording: vague "Open Check" in the Trade Evidence / PnL card is replaced with the clearer
// blocker-summary wording when walletPnlBlockerSummary is present.
assert.match(page, /Trade behavior ready/, 'page.tsx shows "Trade behavior ready"')
assert.match(page, /Public PnL locked/, 'page.tsx shows "Public PnL locked"')
assert.match(page, /Recovery available/, 'page.tsx shows "Recovery available"')
assert.match(page, /Why locked/, 'page.tsx shows "Why locked"')
assert.match(page, /What ChainLens needs next/, 'page.tsx shows "What ChainLens needs next"')
assert.match(page, /walletPnlBlockerSummary\?: \{/, 'page.tsx declares the walletPnlBlockerSummary type on the result')
assert.match(page, /const blocker = result\.walletPnlBlockerSummary/, 'page.tsx reads walletPnlBlockerSummary from the result')

// Raw status/debug fields are kept — the gate still sets publicPnlStatus/pnlIntegrityCheck, the
// blocker summary is additive UI sugar, not a replacement.
assert.match(page, /result\.publicPnlStatus \?\? ts!\.publicPnlStatus\) === 'open_check_integrity_invalid'/, 'page.tsx still branches on the raw publicPnlStatus first')
assert.match(page, /integrityErrors = blocker\?\.integrityErrors \?\? result\.pnlIntegrityCheck\?\.errors/, 'page.tsx falls back to raw pnlIntegrityCheck errors when blocker summary is absent')

// route.ts passes the whole snapshot through (spread), so walletPnlBlockerSummary reaches the
// client automatically — no extra route.ts plumbing/spam needed.
const routeSrc = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
assert.match(routeSrc, /const _ppayload: any = \{ \.\.\.snapshot \}/, 'route.ts spreads the full snapshot (walletPnlBlockerSummary passes through automatically)')

console.log('wallet PnL blocker summary checks passed')
