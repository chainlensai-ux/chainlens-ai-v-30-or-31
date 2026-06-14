import assert from 'node:assert/strict'
import { applyBaseRadarScoreCaps, getRadarFeedRiskLabel } from '../lib/baseRadarFeedScoring.ts'

function score(input) { return applyBaseRadarScoreCaps({ baseScore: 92, honeypotPresent: true, buyTax: 0, sellTax: 0, liquidityUsd: 20_000, ageMinutes: 60, valuationVerified: true, valuationUsd: 100_000, lpLockBurnConfirmed: true, ...input }) }

const a = score({ simulationStatus: 'passed', majorControlOrHolderOrLpRedFlag: false })
assert.ok(a.score >= 80, a)
assert.equal(a.riskLabel, 'STRONGER')

const b = score({ simulationStatus: 'open_check', ageMinutes: 10 })
assert.ok(b.score <= 59, b)
assert.notEqual(getRadarFeedRiskLabel(b.score), 'STRONGER')

const c = score({ simulationStatus: 'open_check', ageMinutes: 30 })
assert.ok(c.caps.length > 0, c)

const d = score({ simulationStatus: 'passed', activeOwner: true, top10: 71, highHolderConcentration: true })
assert.ok(d.score <= 59, d)

const e = score({ simulationStatus: 'passed', liquidityUsd: 499 })
assert.ok(e.score <= 24, e)

const f = score({ simulationStatus: 'open_check', ageMinutes: 5 })
assert.equal(f.riskLabel, getRadarFeedRiskLabel(f.score))
assert.ok(f.score <= 59, f)

console.log('base radar feed scoring tests passed')

// Additional regression: unresolved tokens with different evidence should not all flatten at cap 49.
{
  const cases = [
    applyBaseRadarScoreCaps({ baseScore: 86, liquidityUsd: 4000, ageMinutes: 4, simulationStatus: 'open_check', simulationReason: 'timeout_after_retry', honeypotPresent: false, valuationVerified: false, lpModel: 'erc20_lp_token', lpLockBurnConfirmed: false }).score,
    applyBaseRadarScoreCaps({ baseScore: 82, liquidityUsd: 12000, ageMinutes: 12, simulationStatus: 'open_check', simulationReason: 'unsupported_pool_model', honeypotPresent: false, valuationVerified: true, lpModel: 'erc20_lp_token', lpLockBurnConfirmed: false }).score,
    applyBaseRadarScoreCaps({ baseScore: 78, liquidityUsd: 25000, ageMinutes: 28, simulationStatus: 'open_check', simulationReason: 'provider_unavailable', honeypotPresent: false, valuationVerified: true, lpModel: 'erc20_lp_token', lpLockBurnConfirmed: false, missingSocials: true }).score,
  ]
  assert('unresolved score cap remains granular, not all 49', new Set(cases).size > 1 && !cases.every((s) => s === 49), cases)
}

// 80+ still requires passed simulation/tax and no major red flags.
{
  const blocked = applyBaseRadarScoreCaps({ baseScore: 96, liquidityUsd: 80000, ageMinutes: 60, simulationStatus: 'open_check', honeypotPresent: false, valuationVerified: true, lpModel: 'not_applicable', lpLockBurnConfirmed: true }).score
  const clear = applyBaseRadarScoreCaps({ baseScore: 96, liquidityUsd: 80000, ageMinutes: 60, simulationStatus: 'passed', honeypotPresent: true, buyTax: 0, sellTax: 0, valuationVerified: true, lpModel: 'not_applicable', lpLockBurnConfirmed: true }).score
  assert('unpassed simulation cannot score 80+', blocked < 80, blocked)
  assert('clean passed simulation can score 80+', clear >= 80, clear)
}
