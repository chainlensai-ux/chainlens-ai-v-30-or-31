import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const identity = fs.readFileSync('lib/server/walletIdentity.ts', 'utf8')
const intel = fs.readFileSync('lib/server/walletIntelligence.ts', 'utf8')

assert.match(snap, /requested: historicalCoverage \|\| _acquisitionRecoveryEligible,/, 'targeted acquisition recovery eligibility is reflected in requested diagnostics')
assert.match(snap, /\(_historicalEligible \|\| _historicalNotRunDueToCostGuard \|\| _acquisitionRecoveryEligible\),/, 'targeted acquisition recovery eligibility is reflected in eligible diagnostics')
assert.doesNotMatch(snap, /\? 'acquisition_history_recovery_for_top_holdings' : \(_skipReasons\[0\]/, 'acquisition_history_recovery_for_top_holdings is not used as a skip/stop reason')
assert.match(snap, /stoppedReason: !_p20ShouldRun \? \(!process\.env\.MORALIS_API_KEY \? 'provider_unavailable' : !\(deepScan \|\| deepActivity\) \? 'disabled_by_request' : 'budget_cap'\) : _p20Moralis\.stoppedReason,/, 'historical source budget uses a real stop reason instead of not_eligible for non-running recovery budget')
assert.doesNotMatch(snap, /_earlyRealBackedClosedLots >= 10 \? 'public_grade_lots_already_sufficient'/, 'Moralis recovery skip reason is not public_grade_lots_already_sufficient based on non-public-grade lots')
assert.match(snap, /_earlyRealBackedClosedLots >= 10 \? 'recovery_attempted_no_public_grade_lots'/, 'Wallet 2-style flat/estimate-only recovery skip reason avoids claiming sufficient public-grade lots')

assert.match(identity, /Profit skill is not scored because public PnL is locked\./, 'profile score wording excludes PnL quality when public PnL is locked')
assert.match(identity, /const profitSkillLocked = tradingLockedByPublicPnl/, 'profile computes a profitSkillLocked gate')

assert.match(intel, /basis: pnlIntegrityInvalid \? 'behavior_only'/, 'bot score remains behavior-only when PnL integrity is invalid')
assert.match(intel, /pnlUsed: false/, 'bot score still reports pnlUsed=false')

console.log('wallet recovery/profile lock checks passed')
