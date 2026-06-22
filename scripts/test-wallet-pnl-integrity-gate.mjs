import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')

// Fix 1: a single gate, run after _p6Integrity is computed, classifies errors into hard-invalid
// vs soft-partial-only and overwrites the already-frozen public PnL fields rather than trusting
// the earlier (integrity-unaware) call sites.
assert.match(snap, /const HARD_INVALID_PNL_ERRORS = new Set\(\[/, 'gate defines a hard-invalid error classification set')
assert.match(snap, /'sells_exceed_buys',/, 'hard-invalid set includes sells_exceed_buys')
assert.match(snap, /'pnl_portfolio_delta_mismatch',/, 'hard-invalid set includes pnl_portfolio_delta_mismatch')

// Fix 2: hard-invalid downgrades publicPnlStatus away from "ok", locks win rate, and forces
// profitSkillStatus to integrity_invalid_not_proven — unconditionally, not only when it was
// previously 'unlocked'.
assert.match(snap, /if \(_p6GateApplies && _p6HardInvalid\) \{/, 'gate branches on hard-invalid case')
assert.match(snap, /\(snapshot as any\)\.publicPnlStatus = 'open_check_integrity_invalid'/, 'hard-invalid sets publicPnlStatus to open_check_integrity_invalid')
assert.match(snap, /ts\.publicWinRatePercent = null/, 'hard-invalid locks publicWinRatePercent to null')
assert.match(snap, /snapshot\.tradeIntelligence\.profitSkillStatus = 'integrity_invalid_not_proven'/, 'hard-invalid forces profitSkillStatus to integrity_invalid_not_proven')

// Fix 3: soft-partial-only (coverage_percent_below_threshold alone) still allows a labeled
// partial-sample read, and only unlocks win rate at >= 10 public-grade closed lots.
assert.match(snap, /else if \(_p6GateApplies && _p6SoftPartialOnly\) \{/, 'gate branches on soft-partial-only case')
assert.match(snap, /'Verified FIFO sample — partial coverage'/, 'soft-partial case uses the partial-coverage label wording')
assert.match(snap, /if \(_publicPerfLots < 10\) \{/, 'soft-partial win rate only unlocks at 10+ public-grade closed lots')

// Fix 4: debug field exposing the gate's before/after state.
assert.match(snap, /snapshot\.publicPnlIntegrityGate = \{/, 'gate writes publicPnlIntegrityGate debug field')
assert.match(snap, /publicPnlIntegrityGate\?: \{[\s\S]*?applied: boolean/, 'publicPnlIntegrityGate type is declared on the snapshot')

const identity = fs.readFileSync('lib/server/walletIdentity.ts', 'utf8')

// Fix 5: walletProfile's "Smart Money Candidate"/trading-evidence gating must also treat a
// hard-invalid integrity status (and the new open_check_integrity_invalid status) as locked,
// not just the older publicPnlStatus values.
assert.match(identity, /publicPnlStatus === 'open_check_integrity_invalid' \|\| pnlIntegrityStatusForLock === 'invalid'/, 'tradingLockedByPublicPnl directly checks pnlIntegrityStatus and the new integrity-invalid status')

const page = fs.readFileSync('app/terminal/wallet-scanner/page.tsx', 'utf8')

// Fix 6: walletPersonality/walletBotScore stay locked on invalid integrity — these already key
// off pnlIntegrityStatus directly in walletIntelligence.ts, independent of this gate.
const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
assert.match(intel, /\(tradeStats as any\)\?\.pnlIntegrityStatus === 'invalid'/, 'computeWalletPersonality locks on invalid pnlIntegrityStatus')
assert.match(intel, /tradeStats\?\.scoreUnlocked !== true \|\| \(tradeStats as any\)\?\.pnlIntegrityStatus === 'invalid'/, 'computeBotScore locks on invalid pnlIntegrityStatus')

// Fix 7: UI shows a clear integrity-failure message instead of a clean PnL/win-rate read, and the
// "Smart Money Candidate" derivation is gated off the same integrity status so it cannot leak from
// a hard-invalid integrity result.
assert.match(page, /'open_check_integrity_invalid'/, 'page.tsx PnL card branches on the open_check_integrity_invalid status')
assert.match(page, /PnL integrity check failed/, 'page.tsx shows the PnL integrity check failed message')
assert.match(page, /ts\.pnlIntegrityStatus !== 'invalid' &&/, 'isTradeStatsGradeable requires pnlIntegrityStatus to not be invalid before treating stats as gradeable (blocks Smart Money Candidate leak)')

// Fix 8: walletEvidenceModel is a separately-built nested object and must be sanitized by the
// same gate — not just the top-level/walletTradeStatsSummary fields — since the UI/export/Clark
// facts read it directly and previously kept stale "Verified FIFO sample" labels and win rates.
assert.match(snap, /em\.publicPnlStatus = 'open_check_integrity_invalid'/, 'walletEvidenceModel.publicPnlStatus is downgraded on hard-invalid')
assert.match(snap, /em\.publicWinRatePercent = null/, 'walletEvidenceModel.publicWinRatePercent is nulled on hard-invalid')
assert.match(snap, /em\.publicPnlDisplayLabel = 'PnL integrity check failed'/, 'walletEvidenceModel.publicPnlDisplayLabel reflects the integrity failure')
assert.match(snap, /em\.publicPnlBlockedReason = _reasonText/, 'walletEvidenceModel carries a publicPnlBlockedReason explaining the gate')

// Fix 9: walletTradeStatsSummary must also lock scoreUnlocked/readyForWalletScore and use the
// integrity-specific winRateStatus value (not just the small-sample one), since several downstream
// reads (computeWindowedPnl's scoreUnlocked gate, the wallet score pipeline) key off these flags.
assert.match(snap, /ts\.winRateStatus = 'locked_integrity_invalid'/, 'walletTradeStatsSummary.winRateStatus uses the integrity-specific locked value')
assert.match(snap, /ts\.scoreUnlocked = false\s*\n\s*ts\.readyForWalletScore = false/, 'hard-invalid locks scoreUnlocked and readyForWalletScore on walletTradeStatsSummary')

// Fix 10: the free-text tradeStyleSummary generated before the integrity verdict exists must be
// rewritten when it would otherwise claim profit skill is available/profitable/winning while
// profitSkillStatus is now integrity_invalid_not_proven.
assert.match(snap, /profit skill is available\|profitable\|smart money\|winning/i, 'gate detects and rewrites stale profit-skill wording in tradeStyleSummary')
assert.match(snap, /profit skill is not proven because PnL integrity failed/, 'rewritten tradeStyleSummary explains the integrity failure')

const intelSrc = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')

// Fix 11: walletPnlWindows (3d/7d/30d) must not show stale realizedPnlUsd/winRatePercent once the
// parent integrity check is hard-invalid — these are computed from the same lots, downstream of
// walletSnapshot, in a separate computeWindowedPnl call, so the gate must be wired through there too.
assert.match(intelSrc, /integrityInvalid\?: boolean/, 'computeWindowedPnl accepts an integrityInvalid option')
assert.match(intelSrc, /realizedPnlUsd: null,[\s\S]{0,200}winRateStatus: 'locked_integrity_invalid'/, 'computeWindowedPnl nulls realizedPnlUsd/winRatePercent and locks winRateStatus when integrity is invalid')

const routeSrc = fs.readFileSync('app/api/wallet/route.ts', 'utf8')
assert.match(routeSrc, /integrityInvalid: snapshot\.publicPnlStatus === 'open_check_integrity_invalid' \|\| snapshot\.pnlIntegrityCheck\?\.status === 'invalid'/, 'route.ts wires the integrity-invalid flag into computeWindowedPnl')

// Fix 12: the client-side export report (buildWalletReport) must not show a public-sample PnL
// number or claim "Profit skill evidence-eligible" once integrity is invalid, even though
// publicLots >= 10 might otherwise satisfy the old, integrity-unaware threshold check.
assert.match(page, /const integrityInvalid = \(result\.publicPnlStatus \?\? ts\?\.publicPnlStatus\) === 'open_check_integrity_invalid'/, 'buildWalletReport computes an integrityInvalid flag')
assert.match(page, /const profitSkillProven = publicLots >= 10 && !integrityInvalid/, 'buildWalletReport profitSkillProven requires integrity to not be invalid')

console.log('wallet PnL integrity gate checks passed')
