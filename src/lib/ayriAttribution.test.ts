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
