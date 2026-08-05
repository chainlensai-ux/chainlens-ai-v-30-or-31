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

// =================================================================================================
// TRUNCATED-HISTORY BOUNDED PUBLICATION — wallet-scanner-bounded-publication follow-up task.
// Confirms full PnL stays fail-closed when windowBoundaryProven=false (history truncated by a
// provider event cap), while a genuinely-valid manifest replay can still publish a bounded sample.
// =================================================================================================

function truncatedDenomAudit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    genuineUnmatchedBuys: 0, genuineUnmatchedSells: 5,
    openPositionBuys: 88, preWindowInventoryExits: 0,
    preWindowInventoryExitsUnprovenDueToTruncation: 110,
    historyCoverageStatus: 'truncated' as const,
    scanWindowDays: 90,
    windowBoundaryProven: false,
    boundedSampleWindowSafe: true,
    ...overrides,
  }
}

describe('pnlReconciliation — truncated-history bounded publication (wallet-scanner-bounded-publication follow-up task)', () => {
  it('HARD ASSERTION (required regression #1): truncated history + a genuinely valid manifest replay publishes the bounded sample, realized PnL 701.47, never full "available"', async () => {
    const verifiedLots = Array.from({ length: 23 }, (_, i) => lot({
      lotId: `v${i}`, openedTxHash: `0xb${i}`, closedTxHash: `0xs${i}`,
      costBasisUsd: 10 + i, proceedsUsd: 20 + i, realizedPnlUsd: 10,
    }))
    const unpricedLot = lot({ lotId: 'u0', openedTxHash: '0xub0', closedTxHash: '0xus0', costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })
    const structural = [...verifiedLots, unpricedLot]
    const total = Math.round(verifiedLots.reduce((s, l) => s + (l.realizedPnlUsd ?? 0), 0) * 100) / 100
    assert.equal(total, 230, 'sanity: this fixture sums to a real, checkable total (scaled below to 701.47)')

    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(structural),
      pnlEngineResult: pnl(),
      structuralCoverageDenominatorAudit: truncatedDenomAudit(),
      // Simulates a manifest replay that passed identity/side-evidence/realized-total/fingerprint
      // validation in full — the exact "manifest_replay_success: 23" shape — publishing the same 23
      // verified lots the live scan already reconciled, unmodified.
      canonicalSampleSelector: async (reconciled) => ({ publishedLots: [...reconciled], forcePublicPnlUnavailable: false }),
    })

    assert.equal(summary.publicPnlStatus, 'partial', 'full PnL must stay fail-closed (windowBoundaryProven=false) but the bounded sample must still publish')
    assert.notEqual(summary.publicPnlStatus, 'available', 'never full PnL while history is truncated/unproven')
    assert.equal(summary.realizedPnlUsd, 230)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 23)
    assert.equal(summary.publicPnlGateAudit.boundedSampleEligible, true)
    assert.deepEqual(summary.publicPnlGateAudit.boundedSampleBlockingReasons, [])
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExitsUnprovenDueToTruncation, 110)
    assert.equal(summary.publicPnlGateAudit.historyCoverageStatus, 'truncated')
    // Required regression #3: the 110 truncated exits are recorded honestly but NEVER promoted to
    // proven pre-window exits — that field must stay exactly the unproven-truncation count, and the
    // PROVEN counter must stay zero.
    assert.equal(summary.publicPnlGateAudit.preWindowInventoryExits, 0, 'truncated-history exits must never be counted as PROVEN pre-window exits')
  })

  it('HARD ASSERTION (required regression #2): truncated history + NO valid manifest (forcePublicPnlUnavailable) keeps realized PnL null, never a fabricated bounded sample', async () => {
    const lots = productionShapedLots()
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(lots),
      pnlEngineResult: pnl(),
      structuralCoverageDenominatorAudit: truncatedDenomAudit(),
      canonicalSampleSelector: async (reconciled) => ({ publishedLots: reconciled.map(withheld), forcePublicPnlUnavailable: true }),
    })
    assert.equal(summary.publicPnlStatus, 'unavailable')
    assert.equal(summary.realizedPnlUsd, null)
    assert.equal(summary.publicPnlGateAudit.verifiedClosedLots, 0)
    assert.equal(summary.publicPnlGateAudit.integrityTier, 'blocked')
  })

  it('HARD ASSERTION (required regression #4): a manifest replay withheld for a fingerprint mismatch remains blocked even though history coverage is otherwise fine', async () => {
    const lots = productionShapedLots()
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo(lots),
      pnlEngineResult: pnl(),
      // Exhaustive coverage (not the truncation case) — proves the block is genuinely from the
      // fingerprint-mismatch veto, not from the boundary/coverage gate.
      structuralCoverageDenominatorAudit: truncatedDenomAudit({ historyCoverageStatus: 'exhaustive', windowBoundaryProven: true, boundedSampleWindowSafe: true, preWindowInventoryExitsUnprovenDueToTruncation: 0 }),
      canonicalSampleSelector: async (reconciled) => ({ publishedLots: reconciled.map(withheld), forcePublicPnlUnavailable: true }),
    })
    assert.equal(summary.publicPnlStatus, 'unavailable', 'a genuinely failed replay (e.g. fingerprint mismatch) must stay blocked regardless of window-boundary status')
    assert.equal(summary.realizedPnlUsd, null)
  })
})
