// Lightweight tests for lib/baseRadarFeedScoring.ts's real, existing evidence-gated scoring logic
// (untouched by this audit — these tests exercise it as-is). Uses node:test, same as
// tests/auth-flow.test.js. NOT wired into npm test (which runs a single hardcoded file,
// tests/auth-flow.test.js) — package.json was intentionally not modified, out of this audit's
// scope. Run directly with: npx tsx --test tests/baseRadarFeedScoring.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyBaseRadarScoreCaps, getRadarFeedStatusFromScore, getRadarFeedRiskLabel } from '../lib/baseRadarFeedScoring'

describe('baseRadarFeedScoring — dead/zero-liquidity tokens are not ranked strong', () => {
  it('caps a token with liquidity below $500 to a low score even with a high base score', () => {
    const result = applyBaseRadarScoreCaps({
      baseScore: 95,
      liquidityUsd: 100,
      simulationStatus: 'passed',
      honeypotPresent: true,
      buyTax: 1,
      sellTax: 1,
    })
    assert.ok(result.score <= 24, `expected near-zero-liquidity token capped low, got ${result.score}`)
    assert.equal(getRadarFeedStatusFromScore(result.score), 'DEAD')
  })
})

describe('baseRadarFeedScoring — missing evidence lowers confidence', () => {
  it('caps score to 49 when both LP/burn proof and simulation evidence are missing', () => {
    const result = applyBaseRadarScoreCaps({
      baseScore: 90,
      liquidityUsd: 50_000,
      simulationStatus: undefined,
      lpModel: 'open_check',
      lpLockBurnConfirmed: false,
    })
    assert.ok(result.score <= 49, `expected evidence-gap cap of 49, got ${result.score}`)
    assert.ok(result.caps.length > 0, 'expected at least one cap reason to be reported')
  })

  it('never allows a HOT/STRONGER-tier score without confirmed simulation + sane valuation + liquidity', () => {
    const result = applyBaseRadarScoreCaps({
      baseScore: 100,
      liquidityUsd: 1_000_000,
      simulationStatus: 'open_check',
    })
    assert.ok(result.score < 75, `expected score below the HOT/STRONGER threshold without full evidence, got ${result.score}`)
  })
})

describe('baseRadarFeedScoring — high score requires real evidence', () => {
  it('allows a high score only when liquidity, simulation, and valuation evidence all agree', () => {
    const result = applyBaseRadarScoreCaps({
      baseScore: 90,
      liquidityUsd: 100_000,
      simulationStatus: 'passed',
      honeypotPresent: true,
      buyTax: 2,
      sellTax: 2,
      valuationVerified: true,
      valuationUsd: 500_000,
      lpLockBurnConfirmed: true,
      lpModel: 'locked',
    })
    assert.ok(result.score >= 75, `expected a strong score with full real evidence, got ${result.score}`)
    assert.equal(getRadarFeedRiskLabel(result.score), 'STRONGER')
  })
})
