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

// Fix 6: walletPersonality stays locked on invalid integrity, while walletBotScore remains
// behavior-only and explicitly avoids PnL use.
const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')
assert.match(intel, /\(tradeStats as any\)\?\.pnlIntegrityStatus === 'invalid'/, 'computeWalletPersonality locks on invalid pnlIntegrityStatus')
assert.match(intel, /basis: pnlIntegrityInvalid \? 'behavior_only'/, 'computeBotScore switches to behavior-only basis on invalid pnlIntegrityStatus')
assert.match(intel, /pnlUsed: false/, 'computeBotScore reports no PnL use')

// Fix 7: UI shows a clear integrity-failure message instead of a clean PnL/win-rate read, and the
// "Smart Money Candidate" derivation is gated off the same integrity status so it cannot leak from
// a hard-invalid integrity result.
assert.match(page, /'open_check_integrity_invalid'/, 'page.tsx PnL card branches on the open_check_integrity_invalid status')
assert.match(page, /PnL integrity check failed/, 'page.tsx shows the PnL integrity check failed message')
assert.match(page, /ts\.pnlIntegrityStatus !== 'invalid' &&/, 'isTradeStatsGradeable requires pnlIntegrityStatus to not be invalid before treating stats as gradeable (blocks Smart Money Candidate leak)')

console.log('wallet PnL integrity gate checks passed')
