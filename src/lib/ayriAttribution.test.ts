import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MatchedLot } from '../modules/fifoEngine/types'
import type { PnlReconciliationSummary } from './pnlReconciliation'
import { createAyriAttribution } from './ayriAttribution'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...overrides }
}

function reconciled(overrides: Partial<PnlReconciliationSummary> = {}): PnlReconciliationSummary {
  return { closedLots: 1, unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: 2, unrealizedPnlUsd: 5, priceRecoveredCount: 0, routerCorrectedCount: 0, syntheticAlignedCount: 0, missingEvidenceCount: 0, publicPnlStatus: 'available', mismatches: [], ...overrides }
}

describe('ayriAttribution', () => {
  it('attributes synthetic-only legs correctly', () => {
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ syntheticAlignedCount: 1 }),
      reconciledLots: [lot({ costBasisUsd: null })],
      syntheticPnlAssemblyOutput: { totalLegsCount: 1, pricedLegsCount: 1 } as never,
      pricingSourceBreakdown: { synthetic: 1 },
    })
    assert.equal(output.records[0].attributionSource, 'syntheticPrice')
    assert.equal(output.records[0].syntheticAligned, true)
    assert.equal(output.syntheticAlignedCount, 1)
  })

  it('attributes router-corrected lots correctly', () => {
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ routerCorrectedCount: 1 }),
      reconciledLots: [lot()],
      routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']), acceptedRouters: new Set(['0xrouter']), tokenFlowClustersByAddress: new Map([['0xrouter', [{ tokens: ['0xtoken'] }]]]) } as never,
      pricingSourceBreakdown: { primary: 1 },
    })
    assert.equal(output.records[0].routerCorrected, true)
    assert.equal(output.records[0].routerAddress, '0xrouter')
    assert.equal(output.routerCorrectedCount, 1)
  })

  it('attributes price-recovered lots correctly', () => {
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ priceRecoveredCount: 1, mismatches: [{ key: 'base:0xtoken:0xbuy:0xsell:1:2', classification: 'priceRecovered' }] }),
      reconciledLots: [lot({ costBasisUsd: null })],
      priceRecoveryMap: new Set(['base:0xtoken:0xbuy:0xsell:1:2']),
    })
    assert.equal(output.records[0].attributionSource, 'recoveredPrice')
    assert.equal(output.records[0].priceRecovered, true)
    assert.equal(output.recoveredCount, 1)
  })

  it('produces deterministic output', () => {
    const ayri = createAyriAttribution({ logger: quiet })
    const input = { reconciledPnL: reconciled({ routerCorrectedCount: 1, syntheticAlignedCount: 1 }), reconciledLots: [lot({ lotId: 'b', openedTxHash: '0xb' }), lot({ lotId: 'a', openedTxHash: '0xa' })], pricingSourceBreakdown: { primary: 2 } }
    assert.deepEqual(ayri.build(input), ayri.build(input))
  })

  it('computes coveragePercent and integrityTier transitions', () => {
    const high = createAyriAttribution({ logger: quiet }).build({ reconciledPnL: reconciled({ closedLots: 1 }), reconciledLots: [lot()], pricingSourceBreakdown: { primary: 1 } })
    const medium = createAyriAttribution({ logger: quiet }).build({ reconciledPnL: reconciled({ closedLots: 4 }), reconciledLots: [lot(), lot({ lotId: '2', openedTxHash: '0xb2' }), lot({ lotId: '3', openedTxHash: '0xb3' })], pricingSourceBreakdown: { primary: 3 } })
    const low = createAyriAttribution({ logger: quiet }).build({ reconciledPnL: reconciled({ closedLots: 4 }), reconciledLots: [lot()], pricingSourceBreakdown: { primary: 1 } })
    assert.equal(high.integrityTier, 'high')
    assert.equal(medium.coveragePercent, 0.75)
    assert.equal(medium.integrityTier, 'medium')
    assert.equal(low.integrityTier, 'low')
  })

  it('matches reconciled PnL totals in attribution summary', () => {
    const output = createAyriAttribution({ logger: quiet }).build({ reconciledPnL: reconciled({ realizedPnlUsd: 123.45, unrealizedPnlUsd: 67.89 }), reconciledLots: [lot({ realizedPnlUsd: 1 })], pricingSourceBreakdown: { primary: 1 } })
    assert.equal(output.realizedPnlUsd, 123.45)
    assert.equal(output.unrealizedPnlUsd, 67.89)
  })

  it('regression guard: realizedPnlUsd is null (not fabricated $0) when many lots are attributed but zero are fully priced', () => {
    // Confirmed real bug, real production evidence: totalLots: 290, attributedLots: 290,
    // realizedPnlUsd: 0 — despite zero lots having a real priced realizedPnlUsd. Every lot here has
    // costBasisUsd/proceedsUsd null (unpriced) but still attributes (via routerCorrected/synthetic
    // bookkeeping), which previously summed 290 omitted `realizedUsd` fields as (undefined ?? 0) = 0.
    const unpricedLots = Array.from({ length: 5 }, (_, i) =>
      lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }))
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ closedLots: 5, realizedPnlUsd: null, routerCorrectedCount: 5 }),
      reconciledLots: unpricedLots,
      routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']), acceptedRouters: new Set(['0xrouter']), tokenFlowClustersByAddress: new Map([['0xrouter', [{ tokens: ['0xtoken'] }]]]) } as never,
      // A non-empty scan-wide breakdown (some OTHER token in the scan got a real primary price) is
      // what makes sourceForLot() attribute even these specific, individually-unpriced lots — matches
      // the real production scenario (attributedLots: 290 while most individual lots stayed unpriced).
      pricingSourceBreakdown: { primary: 1 },
    })
    assert.equal(output.attributedLots, 5, 'sanity: lots are attributed even though unpriced')
    assert.equal(output.fullyPricedLots, 0)
    assert.equal(output.historicalPricingCoveragePercent, 0)
    assert.equal(output.realizedPnlUsd, null, 'realizedPnlUsd must be null, never a fabricated 0, when zero lots are fully priced')
  })

  it('regression guard: realizedPnlUsd is the real sum (which may legitimately be 0) when at least one lot is fully priced', () => {
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ closedLots: 1, realizedPnlUsd: null }),
      reconciledLots: [lot({ realizedPnlUsd: 0 })], // a real, legitimately-zero realized PnL (equal cost/proceeds)
      pricingSourceBreakdown: { primary: 1 },
    })
    assert.equal(output.fullyPricedLots, 1)
    assert.equal(output.realizedPnlUsd, 0, 'a real priced lot summing to exactly 0 must report 0, not null')
  })

  it('regression guard: coveragePercent (attribution) and historicalPricingCoveragePercent (pricing) are distinct fields', () => {
    // Confirmed real production evidence: coveragePercent: 1 / integrityTier: 'high' shown alongside
    // realizedPnlUsd: 0 with poor real pricing coverage — this test proves the two percentages can
    // legitimately diverge (100% attribution, 0% real pricing) rather than being conflated.
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ closedLots: 3, realizedPnlUsd: null, routerCorrectedCount: 3 }),
      reconciledLots: [
        lot({ lotId: 'a', openedTxHash: '0xa', closedTxHash: '0xas', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }),
        lot({ lotId: 'b', openedTxHash: '0xb', closedTxHash: '0xbs', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }),
        lot({ lotId: 'c', openedTxHash: '0xc', closedTxHash: '0xcs', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }),
      ],
      routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']), acceptedRouters: new Set(['0xrouter']), tokenFlowClustersByAddress: new Map([['0xrouter', [{ tokens: ['0xtoken'] }]]]) } as never,
      pricingSourceBreakdown: { primary: 1 },
    })
    assert.equal(output.coveragePercent, 1, 'attribution coverage: all 3 lots attributed')
    assert.equal(output.historicalPricingCoveragePercent, 0, 'pricing coverage: none actually priced')
  })

  it('selects the correct route for a lot among many candidates for other tokens/timestamps (grouped-index lookup, not a linear scan)', () => {
    const pricingRoutes = [
      { token: 'other-token', chain: 'base', timestamp: 999, route: 'goldrush' },
      { token: '0xtoken', chain: 'base', timestamp: 999, route: 'goldrush' }, // wrong timestamp, same token
      { token: '0xtoken', chain: 'eth', timestamp: 1, route: 'dexscreener' }, // wrong chain
      { token: '0xtoken', chain: 'base', timestamp: 1, route: 'dexscreener' }, // the real match (openedAt=1)
    ] as never
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled(),
      reconciledLots: [lot()],
      pricingRoutes,
      pricingSourceBreakdown: {},
    })
    assert.equal(output.records[0].attributionSource, 'ratioPrice', 'expected the dexscreener route at openedAt to be selected, driving ratioPrice attribution')
  })

  it('handles a large pricingRoutes array and many lots without behavior change (regression guard for the per-lot full-array-sort performance bug)', () => {
    const manyRoutes = Array.from({ length: 2000 }, (_, i) => ({
      token: `0xtoken${i % 50}`, chain: 'base', timestamp: i, route: 'goldrush',
    })) as never
    const manyLots = Array.from({ length: 300 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, token: `0xtoken${i % 50}`, openedAt: i }))
    const start = performance.now()
    const output = createAyriAttribution({ logger: quiet }).build({
      reconciledPnL: reconciled({ closedLots: 300 }),
      reconciledLots: manyLots,
      pricingRoutes: manyRoutes,
      pricingSourceBreakdown: { primary: 300 },
    })
    const elapsedMs = performance.now() - start
    assert.equal(output.attributedLots, 300)
    assert.ok(elapsedMs < 2000, `expected grouped-index lookup to stay fast even at this scale, took ${elapsedMs}ms`)
  })
})
