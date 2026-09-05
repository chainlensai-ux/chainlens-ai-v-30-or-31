import fs from 'node:fs'
import assert from 'node:assert/strict'

const snap = fs.readFileSync('lib/server/walletSnapshot.ts', 'utf8')
const recovery = fs.readFileSync('src/modules/recoveryPolicy/index.ts', 'utf8')

assert.match(snap, /const HISTORICAL_ELIGIBLE_TOKEN_CAP = 12/, 'walletSnapshot ranks up to 12 tokens as eligible for the already-paid shared GoldRush page')
assert.match(snap, /const _targetContracts = new Set\(_eligibleHistoricalTargets\.map\(t => t\.contract\)\)/, 'the GoldRush post-filter uses the 12-token eligible set, not the funded-only slice')
assert.match(snap, /b\.lotCount - a\.lotCount/, 'historical targets are ranked by lots-completable-per-call')
assert.match(snap, /keep every ranked-eligible token present in the already-paid/, 'post-filter comment forbids dropping eligible tokens after the shared call is paid')
assert.match(recovery, /export const MAX_ELIGIBLE_RECOVERY_TOKENS = 12/, 'recoveryPolicy eligibility cap is 12')
assert.match(recovery, /attributeSharedGoldrushEvents/, 'shared GoldRush attribution runs after dedicated fetches')
assert.doesNotMatch(recovery, /funds only 3 tokens can ever receive recovery, no matter how many trigger/, 'old 3-token-hard-stop wording must not remain as the attribution rule')

console.log('wallet shared recovery attribution checks passed')
