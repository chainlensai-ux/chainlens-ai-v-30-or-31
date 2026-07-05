// Tests for computeSmartMoneyScore/deriveSmartMoneyInputs. NOT wired into `npm test`. Run with:
//   npx tsx --test lib/engine/modules/smartMoney/computeSmartMoneyScore.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeSmartMoneyScore, deriveSmartMoneyInputs } from './computeSmartMoneyScore'

describe('computeSmartMoneyScore (pure, exactly as specified)', () => {
  it('high pnl + high behavior + high personality -> high score', () => {
    const result = computeSmartMoneyScore({
      pnlScore: 90, behaviorScore: 85, personalityScore: 85,
      chainActivityScore: 70, riskScore: 70, signalsScore: 70,
    })
    assert.ok(result.score >= 80, `expected a high score, got ${result.score}`)
    assert.ok(result.notes.includes('Consistently profitable across tracked period.'))
    assert.ok(result.notes.includes('Exhibits disciplined, non-degen trading behavior.'))
    assert.ok(result.notes.includes('Shows strong conviction and coherent strategy.'))
  })

  it('high pnl + degen behavior (low behaviorScore) -> moderated score', () => {
    const high = computeSmartMoneyScore({
      pnlScore: 90, behaviorScore: 85, personalityScore: 50,
      chainActivityScore: 50, riskScore: 50, signalsScore: 50,
    })
    const degen = computeSmartMoneyScore({
      pnlScore: 90, behaviorScore: 10, personalityScore: 50,
      chainActivityScore: 50, riskScore: 50, signalsScore: 50,
    })
    assert.ok(degen.score < high.score, 'degen behavior must pull the score down relative to disciplined behavior')
    assert.ok(!degen.notes.includes('Exhibits disciplined, non-degen trading behavior.'))
  })

  it('low pnl + high behavior -> moderate score, not high', () => {
    const result = computeSmartMoneyScore({
      pnlScore: 10, behaviorScore: 90, personalityScore: 50,
      chainActivityScore: 50, riskScore: 50, signalsScore: 50,
    })
    assert.ok(result.score < 70, `pnl dominates the 0.30 weight; expected a moderate score, got ${result.score}`)
    assert.ok(!result.notes.includes('Consistently profitable across tracked period.'))
  })

  it('all zeros -> score 0, no notes', () => {
    const result = computeSmartMoneyScore({
      pnlScore: 0, behaviorScore: 0, personalityScore: 0,
      chainActivityScore: 0, riskScore: 0, signalsScore: 0,
    })
    assert.equal(result.score, 0)
    // riskScore: 0 < 40, so the low-risk note DOES legitimately fire even at all-zero input.
    assert.deepEqual(result.notes, ['Operates with relatively low risk exposure.'])
  })

  it('clamps out-of-range component values (< 0 or > 100)', () => {
    const result = computeSmartMoneyScore({
      pnlScore: -50, behaviorScore: 200, personalityScore: 150,
      chainActivityScore: -10, riskScore: 1000, signalsScore: NaN,
    })
    assert.equal(result.components.pnlScore, 0)
    assert.equal(result.components.behaviorScore, 100)
    assert.equal(result.components.personalityScore, 100)
    assert.equal(result.components.chainActivityScore, 0)
    assert.equal(result.components.riskScore, 100)
    assert.equal(result.components.signalsScore, 0)
    assert.ok(result.score >= 0 && result.score <= 100)
  })
})

describe('deriveSmartMoneyInputs (new, disclosed heuristic over real module outputs)', () => {
  const emptyPnl = { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] }
  const neutralBehavior = {
    accumulationStyle: 'neutral' as const, rotationStyle: 'inactive' as const, bridgingBehavior: 'none' as const,
    farmingBehavior: 'none' as const, stableRoutingBehavior: 'none' as const, memeBehavior: 'none' as const,
    tradeFrequency: 'low' as const, behaviorSummary: '',
  }
  const neutralPersonality = {
    archetype: 'Unknown', riskAppetite: 'medium' as const, tradingStyle: 'passive' as const, chainPreference: null,
    volatilityTolerance: 0, stabilityPreference: 0, pnlBehavior: 'neutral' as const, activityConsistency: 'sporadic' as const,
    summary: '',
  }
  const neutralRisk = {
    score: 50, level: 'medium' as const, concentrationRisk: 0, stablecoinRatio: 0,
    unrealizedPnlPressure: 0, chainRisk: 0, volatileExposure: 0, fragmentationRisk: 0,
  }

  it('pnlStatus unavailable -> neutral pnlScore (50), not fabricated', () => {
    const inputs = deriveSmartMoneyInputs({
      pnlV2: emptyPnl, pnlStatus: 'unavailable', totalValueUsd: 0,
      behaviorV2: neutralBehavior, personalityV2: neutralPersonality,
      chainActivityV2: [], riskV2: neutralRisk, signalsV2: [],
    })
    assert.equal(inputs.pnlScore, 50)
  })

  it('inverts riskV2.score so lower real risk yields a higher riskScore input', () => {
    const lowRealRisk = { ...neutralRisk, score: 10 }
    const highRealRisk = { ...neutralRisk, score: 90 }
    const inputsLow = deriveSmartMoneyInputs({
      pnlV2: emptyPnl, pnlStatus: 'empty', totalValueUsd: 0,
      behaviorV2: neutralBehavior, personalityV2: neutralPersonality,
      chainActivityV2: [], riskV2: lowRealRisk, signalsV2: [],
    })
    const inputsHigh = deriveSmartMoneyInputs({
      pnlV2: emptyPnl, pnlStatus: 'empty', totalValueUsd: 0,
      behaviorV2: neutralBehavior, personalityV2: neutralPersonality,
      chainActivityV2: [], riskV2: highRealRisk, signalsV2: [],
    })
    assert.equal(inputsLow.riskScore, 90, 'low real risk (score=10) should invert to a high riskScore input (100-10=90)')
    assert.equal(inputsHigh.riskScore, 10, 'high real risk (score=90) should invert to a low riskScore input (100-90=10)')
  })

  it('chainActivityScore averages activityLevel across chains', () => {
    const inputs = deriveSmartMoneyInputs({
      pnlV2: emptyPnl, pnlStatus: 'empty', totalValueUsd: 0,
      behaviorV2: neutralBehavior, personalityV2: neutralPersonality,
      chainActivityV2: [
        { chainId: 1, lastActiveAt: null, activityLevel: 'high', primaryUse: 'trading', txCount30d: 0, valueHeldUsd: 0, valueMovedUsd30d: 0 },
        { chainId: 8453, lastActiveAt: null, activityLevel: 'low', primaryUse: 'other', txCount30d: 0, valueHeldUsd: 0, valueMovedUsd30d: 0 },
      ],
      riskV2: neutralRisk, signalsV2: [],
    })
    assert.equal(inputs.chainActivityScore, (100 + 35) / 2)
  })

  it('positive/negative signal types push signalsScore away from the 50 midpoint', () => {
    const inputs = deriveSmartMoneyInputs({
      pnlV2: emptyPnl, pnlStatus: 'empty', totalValueUsd: 0,
      behaviorV2: neutralBehavior, personalityV2: neutralPersonality,
      chainActivityV2: [], riskV2: neutralRisk,
      signalsV2: [
        { id: '1', type: 'whale_like_accumulation', severity: 'high', summary: '', details: '' },
        { id: '2', type: 'dormant_wallet', severity: 'low', summary: '', details: '' },
      ],
    })
    assert.equal(inputs.signalsScore, 50 + 10 - 15)
  })
})
