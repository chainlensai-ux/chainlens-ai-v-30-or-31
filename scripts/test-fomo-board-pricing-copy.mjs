// FOMO PnL leaderboard — pricing copy accuracy.
//
// Reported: Elite's pricing card never mentioned the FOMO PnL leaderboard at all — a real gap
// since a concurrent fix (see canAccessFomoBoard() in lib/pricingPlans.ts) made the FOMO Board
// tab genuinely Elite-exclusive. Added "FOMO PnL leaderboard" to Elite's feature list — but NOT
// "Whale Alerts" itself, since the base Whale Alerts page (its Activity tab) remains a Pro+Elite
// feature (PLAN_FEATURES['whale-alerts'] is unchanged); only the FOMO Board tab within it is
// Elite-only, so the pricing copy must not imply the whole page is Elite-exclusive.
import assert from 'node:assert/strict'

const { pricingPlans, canAccessFomoBoard, canAccessFeature } = await import('../lib/pricingPlans.ts')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ }
  else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

const free = pricingPlans.find((p) => p.id === 'free')
const pro = pricingPlans.find((p) => p.id === 'pro')
const elite = pricingPlans.find((p) => p.id === 'elite')

console.log('Section A: Elite advertises the FOMO PnL leaderboard')
check('Elite\'s feature list mentions the FOMO PnL leaderboard', elite.features.some((f) => /FOMO/i.test(f) && /PnL/i.test(f) && /leaderboard/i.test(f)))
check('Free does not mention FOMO', !free.features.some((f) => /FOMO/i.test(f)))
check('Pro does not mention FOMO (it cannot access the FOMO Board)', !pro.features.some((f) => /FOMO/i.test(f)))

console.log('\nSection B: the pricing copy stays accurate — base Whale Alerts access is unaffected')
check(
  'PLAN_FEATURES[\'whale-alerts\'] is untouched — the base Whale Alerts page (Activity tab) stays Pro+Elite',
  canAccessFeature('pro', 'whale-alerts') === true && canAccessFeature('elite', 'whale-alerts') === true
)
check('Elite\'s FOMO bullet does not also claim "Whale Alerts" as a distinguishing Elite feature', !elite.features.some((f) => /Whale Alerts/i.test(f)))

console.log('\nSection C: the gate this copy describes is real (canAccessFomoBoard)')
check('Free cannot access the FOMO Board', canAccessFomoBoard('free') === false)
check('Pro cannot access the FOMO Board', canAccessFomoBoard('pro') === false)
check('Elite can access the FOMO Board', canAccessFomoBoard('elite') === true)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
