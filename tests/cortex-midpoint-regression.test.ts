import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateCortexScoreV2 } from '../lib/token/scoring'
import { calculateTokenRiskScore } from '../lib/server/riskScore'

test('canonical API risk is unrated without measurements and separates measured profiles', () => {
  assert.equal(calculateTokenRiskScore({}).riskScore, null)
  const low = calculateTokenRiskScore({ liquidityUsd: 10_000_000, holderDistribution: { top1: 2, top10: 20 }, lpControl: { status: 'burned' }, honeypot: { isHoneypot: false } })
  const high = calculateTokenRiskScore({ liquidityUsd: 100, holderDistribution: { top1: 95, top10: 99 }, lpControl: { status: 'team_controlled' }, honeypot: { isHoneypot: true } })
  assert.ok(low.riskScore != null && high.riskScore != null && low.riskScore < high.riskScore)
  assert.ok(high.riskScore! >= 85)
})

test('empty and price-only evidence cannot manufacture a midpoint or high confidence', () => {
  for (const input of [{}, { price: 1 }, { contractFlags: { mint: { status: 'inferred' } } }]) {
    const r = calculateCortexScoreV2(input)
    assert.equal(r.cortexScore, null)
    assert.equal(r.cortexConfidence, 'insufficient')
  }
})

test('orders of magnitude of measured liquidity produce distinct deterministic scores', () => {
  const values = [100, 100_000, 100_000_000].map(liquidityUsd => {
    const input = { liquidityUsd }
    const r = calculateCortexScoreV2(input)
    assert.deepEqual(r, calculateCortexScoreV2(input))
    assert.equal(r.cortexConfidence, 'low')
    return r.cortexScore!
  })
  assert.ok(values[0] < values[1] && values[1] < values[2])
  assert.ok(values[2] - values[0] > 50)
})

test('partial security retains a verified honeypot instead of substituting 50', () => {
  const r = calculateCortexScoreV2({ honeypot: { isHoneypot: true } })
  assert.ok(r.cortexScore != null && r.cortexScore <= 24)
  assert.notEqual(r.cortexConfidence, 'high')
  assert.equal(r.cortexScoreDebug.categoryStatuses.securityRiskChecks, 'critical')
})

test('concentrated pool classification alone supplies no safety proof on any EVM chain', () => {
  for (const chain of ['base', 'eth', 'bnb', 'robinhood']) {
    const r = calculateCortexScoreV2({ chain, lpControl: { status: 'concentrated_liquidity' } })
    assert.equal(r.cortexScoreDebug.categoryStatuses.lpControl, 'open_check')
    assert.ok(r.missingScoreInputs.includes('LP Control / LP Proof'))
  }
})
