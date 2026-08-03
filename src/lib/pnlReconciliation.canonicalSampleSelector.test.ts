// Regression tests for the canonical sample selector wired INTO pnlReconciliation (canonical-
// manifest-replay follow-up task, requirements #4/#5/#6).
//
// CONFIRMED PRODUCTION FAILURE THESE REPRODUCE: the manifest used to be applied AFTER reconcile()
// returned, so the public gate had already computed its figures from the live candidate array. A
// scan whose manifest replay failed published 23 lots / 85.19% / +4105.85 while the manifest audit
// simultaneously reported `canonicalSampleEvidenceUnavailable: true`. These tests assert the gate
// itself now derives from the selected array. Run directly with:
//   npx tsx --test src/lib/pnlReconciliation.canonicalSampleSelector.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createPnlReconciliation, isCanonicalVerifiedLotForPnl } from './pnlReconciliation'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 20, realizedPnlUsd: 10, evidenceQuality: 'verified',
    ...overrides,
  }
}

function fifo(matchedLots: MatchedLot[]): FifoOutput {
  return {
    matchedLots, unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [],
    realizedPnlUsd: null, unrealizedPnlUsd: 0, costBasisUsd: null, publicPnlStatus: 'unavailable',
    integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
    unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation(),
  }
}

function pnl(): PnlSummaryResult {
  return {
    realizedPnlUsd: null, closedLots: [], winLossRate: { wins: 0, losses: 0, evaluated: 0, rate: 0 },
    chainBreakdown: [], confidenceBasis: { high: 0, medium: 0, low: 0, aggregate: 'low' }, evidenceMissingCount: 0,
  }
}

// 27 structural lots, 23 currently verified — the exact production candidate shape.
function productionShapedLots(): MatchedLot[] {
  return Array.from({ length: 27 }, (_, i) => lot({
    lotId: `lot-${i}`, token: `0xtok${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
    openedAt: i, closedAt: 100 + i,
    evidenceQuality: i < 23 ? 'verified' : 'unpriced',
    costBasisUsd: i < 23 ? 10 : null,
    proceedsUsd: i < 23 ? 20 : null,
    realizedPnlUsd: i < 23 ? 10 : null,
  }))
}

function withheld(l: MatchedLot): MatchedLot {
  return { ...l, evidenceQuality: 'unpriced', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null }
}

describe('pnlReconciliation — canonical sample selector (requirements #4/#5/#6)', () => {
  it('with no selector wired, behavior is unchanged — the full candidate sample is published', async () => {
    const lots = productionShapedLots()
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo(lots), pnlEngineResult: pnl() })

    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 23)
    assert.equal(summary.publishedMatchedLots.length, 27)
    assert.equal(summary.publishedMatchedLots.filter(isCanonicalVerifiedLotForPnl).length, 23)
  })

  it('HARD ASSERTION (requirement #5/#6): the gate reports the SELECTED 21 lots / 77.78%, never the live 23 / 85.19%', async () => {
    const lots = productionShapedLots()
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(lots),
      pnlEngineResult: pnl(),
      // Selector withholds the two newest verified lots, exactly as manifest replay would.
      canonicalSampleSelector: async (reconciled) => ({
        publishedLots: reconciled.map((l) => (l.lotId === 'lot-21' || l.lotId === 'lot-22') ? withheld(l) : l),
        forcePublicPnlUnavailable: false,
      }),
    })

    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 21, 'the gate must count only the selected sample')
    assert.equal(summary.publicPnlGateAudit.verifiedLotCount, 21)
    assert.equal(summary.publicPnlGateAudit.fullyPricedLotCount, 21)
    assert.equal(Number(summary.publicPnlGateAudit.verifiedPricingCoverage?.toFixed(4)), Number((21 / 27).toFixed(4)))
    assert.equal(summary.realizedPnlUsd, 210, 'the two withheld lots contribute exactly zero to public realized PnL')
    assert.equal(summary.publishedMatchedLots.filter(isCanonicalVerifiedLotForPnl).length, 21)
    assert.equal(summary.publishedMatchedLots.length, 27, 'the structural lot set is never shrunk')
  })

  it('HARD ASSERTION (requirement #4): a failed replay publishes NO verified sample, a null realized PnL and an unavailable status', async () => {
    const lots = productionShapedLots()
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(lots),
      pnlEngineResult: pnl(),
      canonicalSampleSelector: async (reconciled) => ({
        publishedLots: reconciled.map(withheld),
        forcePublicPnlUnavailable: true,
      }),
    })

    assert.equal(summary.publicPnlStatus, 'unavailable', 'a failed manifest replay must never publish a live sample')
    assert.equal(summary.publicPnlGateAudit.integrityTier, 'blocked')
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 0)
    assert.equal(summary.realizedPnlUsd, null, 'never a fabricated 0 and never the live +4105.85')
    assert.equal(summary.publishedMatchedLots.filter(isCanonicalVerifiedLotForPnl).length, 0)
    assert.equal(summary.publishedMatchedLots.length, 27, 'structural lots stay disclosed, just unpriced')
  })

  it('forcePublicPnlUnavailable is a veto only — it can never promote a sample to available', async () => {
    const lots = productionShapedLots()
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(lots),
      pnlEngineResult: pnl(),
      // A selector that leaves everything published but still vetoes.
      canonicalSampleSelector: async (reconciled) => ({ publishedLots: [...reconciled], forcePublicPnlUnavailable: true }),
    })
    assert.equal(summary.publicPnlStatus, 'unavailable')
    assert.equal(summary.publicPnlGateAudit.integrityTier, 'blocked')
  })

  it('the selector receives the accepted-evidence-reconciled lots, and its output is the array every published figure derives from', async () => {
    const lots = productionShapedLots()
    let received: readonly MatchedLot[] = []
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(lots),
      pnlEngineResult: pnl(),
      canonicalSampleSelector: async (reconciled) => {
        received = reconciled
        return { publishedLots: reconciled.slice(0, 12), forcePublicPnlUnavailable: false }
      },
    })
    assert.equal(received.length, 27, 'the selector must see the full reconciled structural array')
    assert.equal(summary.publishedMatchedLots.length, 12, 'the published array is exactly what the selector returned')
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 12)
  })
})
