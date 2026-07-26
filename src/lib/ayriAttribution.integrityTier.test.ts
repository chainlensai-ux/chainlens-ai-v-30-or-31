// Tests for src/lib/ayriAttribution.ts's deriveIntegrityTier() — the confirmed root cause this
// closes: integrityTier was previously derived from attribution coverage ALONE (coveragePercent >=
// 0.95 && criticalMismatches.length === 0 ? 'high' : ...), which is exactly how a real production
// scan showed coveragePercent: 1 / integrityTier: 'high' alongside realizedPnlUsd: 0 with zero
// lots actually fully priced — a misleadingly confident label backed by no real pricing evidence.
//
// Uses node:test. Run with:
//   npx tsx --test src/lib/ayriAttribution.integrityTier.test.ts

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deriveIntegrityTier } from './ayriAttribution'

function params(overrides: Partial<Parameters<typeof deriveIntegrityTier>[0]> = {}) {
  return {
    attributionCoveragePercent: 1,
    verifiedPricingCoveragePercent: 1,
    criticalMismatchCount: 0,
    publicPnlStatus: 'available' as const,
    ...overrides,
  }
}

describe('deriveIntegrityTier — never derived from attribution coverage alone', () => {
  it('100% attribution coverage with 0% verified pricing coverage is NEVER high or medium — the confirmed real production bug', () => {
    const tier = deriveIntegrityTier(params({ attributionCoveragePercent: 1, verifiedPricingCoveragePercent: 0 }))
    assert.equal(tier, 'low', 'attribution coverage alone must never produce a confident tier')
  })

  it('100% attribution coverage with only 50% verified pricing coverage caps at low, not medium or high', () => {
    const tier = deriveIntegrityTier(params({ attributionCoveragePercent: 1, verifiedPricingCoveragePercent: 0.5 }))
    assert.equal(tier, 'low')
  })

  it('high requires BOTH attribution and verified pricing coverage above the high threshold', () => {
    assert.equal(deriveIntegrityTier(params({ attributionCoveragePercent: 0.96, verifiedPricingCoveragePercent: 0.96 })), 'high')
    assert.equal(deriveIntegrityTier(params({ attributionCoveragePercent: 0.96, verifiedPricingCoveragePercent: 0.80 })), 'medium', 'attribution alone above the high bar must not reach high without verified pricing coverage matching it')
  })

  it('medium requires BOTH percentages above the medium threshold', () => {
    assert.equal(deriveIntegrityTier(params({ attributionCoveragePercent: 0.80, verifiedPricingCoveragePercent: 0.80 })), 'medium')
    assert.equal(deriveIntegrityTier(params({ attributionCoveragePercent: 0.80, verifiedPricingCoveragePercent: 0.5 })), 'low')
  })

  it('a critical mismatch blocks high even when both coverage percentages are complete', () => {
    const tier = deriveIntegrityTier(params({ criticalMismatchCount: 1 }))
    assert.notEqual(tier, 'high')
  })
})

describe('deriveIntegrityTier — publicPnlStatus unavailable always overrides internal confidence labels', () => {
  it('forces low even with 100% attribution and 100% verified pricing coverage', () => {
    const tier = deriveIntegrityTier(params({ publicPnlStatus: 'unavailable' }))
    assert.equal(tier, 'low', 'publicPnlStatus unavailable must override every other signal')
  })

  it('forces low regardless of criticalMismatchCount or any coverage combination', () => {
    for (const coverage of [0, 0.5, 0.95, 1]) {
      const tier = deriveIntegrityTier(params({ publicPnlStatus: 'unavailable', attributionCoveragePercent: coverage, verifiedPricingCoveragePercent: coverage, criticalMismatchCount: 0 }))
      assert.equal(tier, 'low', `publicPnlStatus unavailable must override even at coverage=${coverage}`)
    }
  })

  it('a "partial" publicPnlStatus does NOT override — high/medium/low still derive from coverage', () => {
    assert.equal(deriveIntegrityTier(params({ publicPnlStatus: 'partial' })), 'high', 'partial is not the override trigger — only unavailable is')
  })
})
