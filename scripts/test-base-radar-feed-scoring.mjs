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
