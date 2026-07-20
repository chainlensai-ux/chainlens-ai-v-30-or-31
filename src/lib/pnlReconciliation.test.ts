import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation } from './pnlReconciliation'

const quiet = { warn() {} }

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return { lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...overrides }
}
function fifo(overrides: Partial<FifoOutput> = {}): FifoOutput {
  return { matchedLots: [lot()], unmatchedBuys: 0, unmatchedSells: 0, realizedPnlUsd: 2, unrealizedPnlUsd: 0, costBasisUsd: 10, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, ...overrides }
}
function pnl(closedLots = 1, overrides: Partial<PnlSummaryResult> = {}): PnlSummaryResult {
  return { realizedPnlUsd: 2, closedLots: Array.from({ length: closedLots }, (_, i) => ({ lotId: `closed-${i}`, matchedBuyLotId: null, token: '0xtoken', symbol: 'TOK', chain: 'base', timestamp: 2 + i, txHash: `0xsell${i}`, amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 12, realizedPnlUsd: 2, confidence: 'high', evidence: 'complete' })), winLossRate: { wins: 1, losses: 0, evaluated: 1, rate: 1 }, chainBreakdown: [], confidenceBasis: { high: 1, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0, ...overrides }
}

describe('pnlReconciliation', () => {
  it('corrects mismatched lots by router inference', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(), routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null })
    assert.equal(summary.routerCorrectedCount, 1)
    assert.equal(summary.unmatchedSells, 0)
    assert.equal(summary.publicPnlStatus, 'available')
  })

  it('corrects mismatched lots by price recovery', async () => {
    const r = createPnlReconciliation({ logger: quiet, priceKvClient: { getPriceHistorical: async () => 10, getPricePrimary: async () => null }, priceSources: { primary: async () => 10 } })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ matchedLots: [lot({ costBasisUsd: null })] }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(summary.priceRecoveredCount, 1)
    assert.equal(summary.mismatches.some((m) => m.classification === 'priceRecovered'), true)
  })

  it('aligns synthetic-only legs with unmatched lots', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 1, matchedLots: [lot()] }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: { totalLegsCount: 2, pricedLegsCount: 1, realizedPnlUsd: 2, unrealizedPnlUsd: 0 } as never })
    assert.equal(summary.syntheticAlignedCount, 1)
    assert.equal(summary.unmatchedBuys, 0)
  })

  it('is deterministic for the same input', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const input = { fifoEngineResult: fifo({ unmatchedSells: 1 }), pnlEngineResult: pnl(), routerInferenceOutput: { highConfidenceRouters: new Set(['0xrouter']) }, syntheticPnlAssemblyOutput: null }
    assert.deepEqual(await r.reconcile(input), await r.reconcile(input))
  })

  it('pipeline integration: publicPnlStatus transitions correctly', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    assert.equal((await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'available')
    assert.equal((await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 1 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'partial')
    assert.equal((await r.reconcile({ fifoEngineResult: fifo({ unmatchedBuys: 10 }), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })).publicPnlStatus, 'unavailable')
  })
})
