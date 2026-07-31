// Tests for the rebuilt computeSmartMoneyScore(). NOT wired into `npm test`. Run with:
//   npx tsx --test lib/engine/modules/smartMoney/computeSmartMoneyScore.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSmartMoneyScore, MIN_VERIFIED_TRADES_FOR_OFFICIAL, MIN_COVERAGE_PERCENT_FOR_OFFICIAL } from './computeSmartMoneyScore'
import type { VerifiedTradeEvidence } from './computeSmartMoneyScore'
import type { BehaviorV2 } from '../behavior/types'

const DAY = 86_400_000
const NOW = Date.now()

function trade(overrides: Partial<VerifiedTradeEvidence> = {}): VerifiedTradeEvidence {
  return {
    realizedPnlUsd: 10, costBasisUsd: 100, closedAt: NOW - 5 * DAY, openedAt: NOW - 10 * DAY, isVerified: true,
    ...overrides,
  }
}

// A well-formed, evidence-rich sample: 20 verified trades, spread across many weeks, wins held
// longer than losses, no single trade dominant, real cost basis on every trade — exactly what
// should clear the official gate with a strong (not necessarily perfect) score.
function richVerifiedSample(count = 20): VerifiedTradeEvidence[] {
  return Array.from({ length: count }, (_, i) => {
    const isWin = i % 3 !== 0 // ~67% win rate
    const weekOffset = i * 7 // spread one trade per week
    return trade({
      realizedPnlUsd: isWin ? 15 + (i % 5) : -8 - (i % 3),
      costBasisUsd: 100,
      closedAt: NOW - (200 - weekOffset) * DAY,
      openedAt: NOW - (200 - weekOffset + (isWin ? 12 : 3)) * DAY,
    })
  })
}

const neutralBehavior: BehaviorV2 = {
  accumulationStyle: 'neutral', rotationStyle: 'inactive', bridgingBehavior: 'none',
  farmingBehavior: 'none', stableRoutingBehavior: 'none', memeBehavior: 'none',
  tradeFrequency: 'low', behaviorSummary: '',
}

test('unavailable PnL is not treated as zero: zero trades -> not_yet_rated, breakdown categories are null, never 0', () => {
  const result = computeSmartMoneyScore({ trades: [] })
  assert.equal(result.status, 'not_yet_rated')
  assert.equal(result.officialScore, null)
  assert.equal(result.breakdown.verifiedProfitability, null)
  assert.equal(result.breakdown.verifiedWinQuality, null)
  assert.equal(result.breakdown.riskAdjustedPerformance, null)
  assert.equal(result.breakdown.timingQuality, null)
  assert.equal(result.breakdown.consistency, null)
  assert.ok(result.reasonNotRated != null)
  assert.equal(result.evidenceConfidence.fullyPricedTradeCount, 0)
})

test('activity alone cannot create a high score: many trades but none verified -> still not_yet_rated, never inflated by volume', () => {
  const manyUnverified = Array.from({ length: 500 }, (_, i) => trade({ isVerified: false, closedAt: NOW - i * DAY }))
  const result = computeSmartMoneyScore({ trades: manyUnverified })
  assert.equal(result.status, 'not_yet_rated')
  assert.equal(result.officialScore, null)
  assert.equal(result.evidenceConfidence.fullyPricedTradeCount, 0)
})

test('personality alone cannot increase the official score: behaviorV2 is capped at 10% weight and never substitutes for missing performance evidence', () => {
  const withGreatBehavior = computeSmartMoneyScore({
    trades: [],
    behaviorV2: { ...neutralBehavior, accumulationStyle: 'accumulator', rotationStyle: 'holding', farmingBehavior: 'farmer', stableRoutingBehavior: 'router' },
  })
  // Even a maximally "good" behaviorV2 reading cannot unlock an official score with zero verified trades.
  assert.equal(withGreatBehavior.status, 'not_yet_rated')
  assert.equal(withGreatBehavior.officialScore, null)

  // With enough verified evidence to clear the gate, behaviorV2 alone (worst vs. best case, same
  // trade data) must not swing the OFFICIAL score by more than its 10% weight allows.
  const trades = richVerifiedSample()
  const worstBehavior: BehaviorV2 = { ...neutralBehavior, accumulationStyle: 'distributor', rotationStyle: 'rotating', memeBehavior: 'meme-active' }
  const bestBehavior: BehaviorV2 = { ...neutralBehavior, accumulationStyle: 'accumulator', rotationStyle: 'holding', farmingBehavior: 'farmer', stableRoutingBehavior: 'router' }
  const worst = computeSmartMoneyScore({ trades, behaviorV2: worstBehavior })
  const best = computeSmartMoneyScore({ trades, behaviorV2: bestBehavior })
  assert.equal(worst.status, 'official')
  assert.equal(best.status, 'official')
  assert.ok(Math.abs((best.officialScore ?? 0) - (worst.officialScore ?? 0)) <= 15, 'behaviorQuality swing must stay within its ~10% weight influence')
})

test('low coverage blocks the official score even with 10+ verified trades (mirrors fifoEngine\'s own 50% coverage bar)', () => {
  const verified10 = richVerifiedSample(10)
  // 10 verified out of 219 total matched lots -> ~4.57% coverage, reproducing this task's own
  // reported production evidence exactly.
  const padding = Array.from({ length: 209 }, (_, i) => trade({ isVerified: false, closedAt: NOW - i * DAY }))
  const result = computeSmartMoneyScore({ trades: [...verified10, ...padding] })
  assert.equal(result.status, 'not_yet_rated')
  assert.equal(result.officialScore, null)
  assert.equal(result.evidenceConfidence.fullyPricedTradeCount, 10)
  assert.equal(result.evidenceConfidence.totalMatchedLotCount, 219)
  assert.ok(result.evidenceConfidence.verifiedCoveragePercent < MIN_COVERAGE_PERCENT_FOR_OFFICIAL)
  assert.ok(result.reasonNotRated!.includes('coverage'))
})

test('enough verified trades (>= 10 AND >= 50% coverage) unlocks an official score', () => {
  const trades = richVerifiedSample(MIN_VERIFIED_TRADES_FOR_OFFICIAL + 5)
  const result = computeSmartMoneyScore({ trades })
  assert.equal(result.status, 'official')
  assert.notEqual(result.officialScore, null)
  assert.ok(result.evidenceConfidence.verifiedCoveragePercent >= MIN_COVERAGE_PERCENT_FOR_OFFICIAL)
})

test('one lucky trade cannot dominate: a single extreme outlier is winsorized, never allowed to swing the score alone', () => {
  const base = richVerifiedSample()
  const withOutlier = [...base, trade({ realizedPnlUsd: 1_000_000, costBasisUsd: 100, closedAt: NOW - 3 * DAY, openedAt: NOW - 4 * DAY })]
  const baseResult = computeSmartMoneyScore({ trades: base })
  const outlierResult = computeSmartMoneyScore({ trades: withOutlier })
  assert.equal(baseResult.status, 'official')
  assert.equal(outlierResult.status, 'official')
  assert.ok(Math.abs((outlierResult.officialScore ?? 0) - (baseResult.officialScore ?? 0)) <= 10, 'a single 1,000,000 USD outlier lot must not swing the score by more than a capped amount')
})

test('missing data lowers confidence, not skill: a category with no computable input is excluded from the score, never defaulted to 0', () => {
  // No losses at all -> computeTimingQuality (needs both wins and losses) and payoff-ratio half of
  // win-quality both have less to work with, but never resolve to a punishing 0.
  const allWins = Array.from({ length: 15 }, (_, i) => trade({
    realizedPnlUsd: 20, costBasisUsd: 100, closedAt: NOW - i * 7 * DAY, openedAt: NOW - (i * 7 + 5) * DAY,
  }))
  const result = computeSmartMoneyScore({ trades: allWins })
  assert.equal(result.status, 'official')
  assert.equal(result.breakdown.timingQuality, null, 'timing quality needs both a win and a loss sample to compare')
  assert.notEqual(result.breakdown.verifiedProfitability, null)
  assert.notEqual(result.breakdown.verifiedWinQuality, null)
  // The combine step must still produce a real score from the AVAILABLE categories only.
  assert.notEqual(result.officialScore, null)
})

test('evidence confidence is a separate model from the score itself: two wallets with identical breakdown scores but different sample sizes get different confidence', () => {
  const small = computeSmartMoneyScore({ trades: richVerifiedSample(MIN_VERIFIED_TRADES_FOR_OFFICIAL) })
  const large = computeSmartMoneyScore({ trades: richVerifiedSample(60) })
  assert.equal(small.status, 'official')
  assert.equal(large.status, 'official')
  assert.ok(large.evidenceConfidence.value > small.evidenceConfidence.value, 'more verified trades must raise evidence confidence independently of the score')
})

test('deterministic and explainable output: identical input always produces identical output, with a real reason string whenever not rated', () => {
  const trades = richVerifiedSample()
  const a = computeSmartMoneyScore({ trades })
  const b = computeSmartMoneyScore({ trades })
  assert.deepEqual(a, b)

  const notRated = computeSmartMoneyScore({ trades: richVerifiedSample(3) })
  assert.equal(notRated.status, 'not_yet_rated')
  assert.ok(notRated.reasonNotRated!.length > 0)
  assert.deepEqual(notRated.notes, [notRated.reasonNotRated])
})

test('provisional behavior read is clearly separate from the official score and never published when not rated', () => {
  const result = computeSmartMoneyScore({
    trades: [],
    behaviorV2: { ...neutralBehavior, accumulationStyle: 'accumulator', rotationStyle: 'holding' },
  })
  assert.equal(result.status, 'not_yet_rated')
  assert.equal(result.officialScore, null)
  assert.notEqual(result.provisionalBehaviorScore, null)

  // Once officially rated, the provisional field must not double as/replace the official score.
  const official = computeSmartMoneyScore({ trades: richVerifiedSample(), behaviorV2: neutralBehavior })
  assert.equal(official.status, 'official')
  assert.equal(official.provisionalBehaviorScore, null)
})

test('risk-adjusted performance requires at least 2 verified trades — a single trade proves nothing about volatility', () => {
  const result = computeSmartMoneyScore({ trades: [trade()] })
  assert.equal(result.breakdown.riskAdjustedPerformance, null)
})

test('consistency measures spread across time, not raw profitability: all wins concentrated in one week scores lower than the same win count spread across many weeks', () => {
  const concentrated = Array.from({ length: 10 }, (_, i) => trade({ realizedPnlUsd: 20, closedAt: NOW - i * 60_000, openedAt: NOW - i * 60_000 - DAY })) // all in the same week
  const spread = richVerifiedSample(10)
  const concentratedResult = computeSmartMoneyScore({ trades: concentrated })
  const spreadResult = computeSmartMoneyScore({ trades: spread })
  assert.ok((concentratedResult.breakdown.consistency ?? 100) <= (spreadResult.breakdown.consistency ?? 0))
})
