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

  it('regression guard: syntheticPnlAssemblyOutput never becomes the official realizedPnlUsd, even when both real engines have none', async () => {
    // Confirmed real bug: a prior version of this function accepted a third field
    // (computePnlResult), wired at the pipeline layer directly from syntheticPnl's UI-display-only
    // totals, and silently fell back to it as the "official" realizedPnlUsd whenever both real
    // engines (fifoEngineResult, pnlEngineResult) had no verified figure. That field no longer
    // exists on this function's input type at all — this test proves a wallet with zero verified
    // real lots (both engines null) and a large, unrelated synthetic PnL figure still reports
    // realizedPnlUsd: null and publicPnlStatus: 'unavailable', never the synthetic number.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null, publicPnlStatus: 'unavailable' }),
      pnlEngineResult: pnl(0, { realizedPnlUsd: null }),
      // A syntheticPnlAssemblyOutput carrying a large, unrelated inferred PnL figure — this must
      // never leak into the reconciliation's own realizedPnlUsd/unrealizedPnlUsd/publicPnlStatus.
      syntheticPnlAssemblyOutput: { totalLegsCount: 0, pricedLegsCount: 0, realizedPnlUsd: 987654.32, unrealizedPnlUsd: -4321 } as never,
    })
    assert.equal(summary.realizedPnlUsd, null, 'realizedPnlUsd must stay null, never borrowed from synthetic')
    assert.equal(summary.unrealizedPnlUsd, null, 'unrealizedPnlUsd must stay null, never borrowed from synthetic')
    assert.equal(summary.publicPnlStatus, 'unavailable')
  })

  it('regression guard: publicPnlStatus never reports "available" when realizedPnlUsd is null (status/value contradiction guard)', async () => {
    // Even with zero unmatched buys/sells and zero missingEvidenceCount (e.g. via price-recovery
    // bookkeeping that reduces the evidence-count without ever repricing the underlying lots), the
    // status must never claim "available" next to a null value.
    const r = createPnlReconciliation({ logger: quiet })
    const summary = await r.reconcile({
      fifoEngineResult: fifo({ matchedLots: [], realizedPnlUsd: null, unrealizedPnlUsd: null, unmatchedBuys: 0, unmatchedSells: 0 }),
      pnlEngineResult: pnl(0, { realizedPnlUsd: null, evidenceMissingCount: 0 }),
      syntheticPnlAssemblyOutput: null,
    })
    assert.equal(summary.realizedPnlUsd, null)
    assert.notEqual(summary.publicPnlStatus, 'available')
  })

  it('regression guard: price recovery runs with bounded concurrency, not a fully sequential await-per-lot loop', async () => {
    // Confirmed root cause of a real multi-minute hang: recoverPrices previously awaited one lot
    // at a time with zero concurrency. This proves many lots resolve in roughly one fetcher-latency
    // "round", not N sequential rounds — the direct, measurable signature of the fix.
    let inFlight = 0
    let maxInFlight = 0
    const manyLots = Array.from({ length: 60 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: {
        getPriceHistorical: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          return 10
        },
      },
      priceSources: { primary: async () => 10 },
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(manyLots.length), syntheticPnlAssemblyOutput: null })
    assert.ok(maxInFlight > 1, `expected concurrent in-flight lookups, saw max concurrency of ${maxInFlight}`)
  })

  it('regression guard: recovery attempts are capped, never unbounded, for a wallet with many missing-price lots', async () => {
    let callCount = 0
    const manyLots = Array.from({ length: 500 }, (_, i) => lot({ lotId: `lot-${i}`, openedTxHash: `0xbuy${i}`, closedTxHash: `0xsell${i}`, costBasisUsd: null }))
    const r = createPnlReconciliation({
      logger: quiet,
      priceKvClient: { getPriceHistorical: async () => { callCount += 1; return null } },
      priceSources: { primary: async () => null },
    })
    await r.reconcile({ fifoEngineResult: fifo({ matchedLots: manyLots }), pnlEngineResult: pnl(manyLots.length), syntheticPnlAssemblyOutput: null })
    assert.ok(callCount <= 40, `expected recovery attempts capped at 40, saw ${callCount}`)
  })
})
