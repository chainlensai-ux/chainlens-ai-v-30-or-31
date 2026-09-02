// Base Token Scanner state/copy consistency — regression tests.
//
// Verifies (by source contract + pure-logic replication of migrationRiskFinalLabel, since the
// page's helpers are module-private):
//   1. Migration Risk never final-renders the literal "Open Check" from any of its three render
//      sites (compact detail rows, LP Controller Intel, LP History Timeline) — no pool becomes
//      "Not detected", an unresolved proof becomes "Unavailable[: reason]".
//   2. The three Migration Risk render sites share the same migrationRiskFinalLabel() helper, so
//      sidebar/Risk Engine/LP tab wording cannot drift apart.
//   3. The liquidity warning banner rephrases "Liquidity unavailable" into "Liquidity market data
//      available; LP proof unavailable: reason" when the scan already has real liquidity/pool
//      evidence elsewhere — never when there truly is none.
//   4. Concentrated/V3 pools show "not applicable" LP proof wording, never a raw "Open Check" or
//      a standard ERC-20 lock/burn failure message.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pageSrc = readFileSync(new URL('../app/terminal/token-scanner/page.tsx', import.meta.url), 'utf8')

let passed = 0
let failed = 0
function check(label, cond) {
  if (cond) { passed++ }
  else { failed++; console.error(`  ❌ FAIL: ${label}`) }
}

// ── Pure replication of migrationRiskFinalLabel() ───────────────────────────
function migrationRiskFinalLabel(raw, opts = {}) {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'low') return 'Low'
  if (v === 'watch' || v === 'medium') return 'Watch'
  if (v === 'flagged' || v === 'high') return 'Elevated'
  if (opts.hasPool === true) return 'Pool detected'
  if (opts.hasPool === false) return 'Not detected'
  return opts.reason ? `Unavailable: ${opts.reason}` : 'Unavailable'
}

console.log('Section A: migrationRiskFinalLabel never returns "Open Check"')
check('low status renders Low', migrationRiskFinalLabel('low') === 'Low')
check('watch status renders Watch', migrationRiskFinalLabel('watch') === 'Watch')
check('medium status renders Watch', migrationRiskFinalLabel('medium') === 'Watch')
check('flagged status renders Elevated', migrationRiskFinalLabel('flagged') === 'Elevated')
check('high status renders Elevated', migrationRiskFinalLabel('high') === 'Elevated')
check('open_check with no pool renders Not detected', migrationRiskFinalLabel('open_check', { hasPool: false }) === 'Not detected')
check('unknown with no pool renders Not detected', migrationRiskFinalLabel('unknown', { hasPool: false }) === 'Not detected')
check('open_check with a pool present renders Pool detected', migrationRiskFinalLabel('open_check', { hasPool: true }) === 'Pool detected')
check('unresolved status with a reason renders Unavailable: reason', migrationRiskFinalLabel(null, { reason: 'proof pipeline timed out' }) === 'Unavailable: proof pipeline timed out')
check('unresolved status with no reason renders plain Unavailable', migrationRiskFinalLabel(null, {}) === 'Unavailable')
;[null, undefined, 'open_check', 'unknown', '', 'garbage'].forEach((raw) => {
  check(`"${raw}" never renders literal Open Check`, migrationRiskFinalLabel(raw) !== 'Open Check')
})

console.log('\nSection B: source-level wiring — Migration Risk render sites share the helper')
check('shared helper is defined once', (pageSrc.match(/function migrationRiskFinalLabel\(/g) ?? []).length === 1)
check(
  'compact detail rows Migration Risk uses the shared helper',
  /const migrationRisk = isV3PartialPositionProof \? 'Low'\s*\n\s*: isUniswapV3ConcentratedPartial\(result\) \? 'Low'\s*\n\s*: migrationRiskFinalLabel\(migrationRiskRawStatus, \{ hasPool, reason: result\.lpMigrationProof\?\.reason \}\)/.test(pageSrc)
)
check(
  'LP Controller Intel Migration Risk uses the shared helper',
  pageSrc.includes("['Migration Risk', migrationRiskFinalLabel(result.lpControllerIntel.migrationRisk)]")
)
check(
  'LP History Timeline Migration Risk uses the shared helper',
  pageSrc.includes("['Migration Risk', migrationRiskFinalLabel(result.lpHistoryTimeline.migrationRisk)]")
)
check(
  'no Migration Risk render site still falls through to a raw cleanStatusLabel(...migrationRisk) call',
  !/\['Migration Risk', cleanStatusLabel\(/.test(pageSrc)
)

console.log('\nSection C: liquidity warning distinguishes "no liquidity" from "liquidity exists, LP proof failed"')
check(
  'hasVerifiedLiquidityElsewhere is computed before filtering warnings',
  /const hasVerifiedLiquidityElsewhere = \(result\.liquidity \?\? 0\) > 0\s*\n\s*\|\| Boolean\(result\.lpControl\?\.poolAddressPresent\)\s*\n\s*\|\| \(result\.pools\?\.length \?\? 0\) > 0/.test(pageSrc)
)
check(
  'liquidity warnings are rephrased to "Liquidity market data available; LP proof unavailable: reason" when evidence exists',
  pageSrc.includes('`Liquidity market data available; LP proof unavailable: ${match[1]}`')
)
check(
  'the rephrase only fires when hasVerifiedLiquidityElsewhere is true (never fabricates evidence)',
  /hasVerifiedLiquidityElsewhere \? w\.match\(\/\^Liquidity unavailable on \.\+\?:\\s\*\(\.\+\)\$\/\) : null/.test(pageSrc)
)

console.log('\nSection D: concentrated/V3 pools never show ERC-20 lock/burn failure copy or Open Check')
check(
  'notApplicable lock/burn proof reads as Not Applicable, never Open Check',
  pageSrc.includes("notApplicable ? 'Not Applicable — standard ERC-20 LP-token lock/burn proof does not apply.'")
)
check(
  'V3-partial lock/burn proof explicitly says ERC-20 proof was not used, not that it failed',
  pageSrc.includes("isV3Partial ? 'ERC-20 LP proof not used'")
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
