// Public PnL gate: a sample with no canonically verified published lot is never 'partial', and a sample
// whose verified lots include a market-estimated side is never 'available' (the "Verified" badge).
// Without a pricing-basis lookup, only the zero-verified rule applies.
//   npx tsx --test src/lib/pnlReconciliation.verifiedEvidenceGate.test.ts
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FifoOutput, MatchedLot } from '../modules/fifoEngine/types'
import { emptyUnrealizedReconciliation } from '../modules/fifoEngine/types'
import type { PnlSummaryResult } from '../modules/pnlEngine/types'
import { createPnlReconciliation } from './pnlReconciliation'

const quiet = { warn() {} }
const lot = (o: Partial<MatchedLot> = {}): MatchedLot => ({ lotId: 'lot-1', token: '0xtoken', chain: 'base', openedAt: 1, closedAt: 2, openedTxHash: '0xbuy', closedTxHash: '0xsell', amount: 1, costBasisUsd: 10, proceedsUsd: 12, realizedPnlUsd: 2, evidenceQuality: 'verified', ...o })
const fifo = (o: Partial<FifoOutput> = {}): FifoOutput => ({ matchedLots: [lot()], unmatchedBuys: 0, unmatchedSells: 0, unmatchedBuyEvents: [], unmatchedSellEvents: [], realizedPnlUsd: 2, unrealizedPnlUsd: 0, costBasisUsd: 10, publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 }, unrealizedPnlExcludedTokens: [], unrealizedReconciliation: emptyUnrealizedReconciliation(), ...o })
const pnl = (): PnlSummaryResult => ({ realizedPnlUsd: 2, closedLots: [{ lotId: 'closed-0', matchedBuyLotId: null, token: '0xtoken', symbol: 'TOK', chain: 'base', timestamp: 2, txHash: '0xsell', amount: '1', costUsdEstimate: 10, proceedsUsdEstimate: 12, realizedPnlUsd: 2, confidence: 'high', evidence: 'complete' }], winLossRate: { wins: 1, losses: 0, evaluated: 1, rate: 1 }, chainBreakdown: [], confidenceBasis: { high: 1, medium: 0, low: 0, aggregate: 'high' }, evidenceMissingCount: 0 })
const provenAudit = () => ({ genuineUnmatchedBuys: 0, genuineUnmatchedSells: 0, windowBoundaryProven: true, historyCoverageStatus: 'exhaustive' as const })

describe('public PnL gate: verified evidence', () => {
  it('a complete sample priced from its own transactions stays available', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const s = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null, structuralCoverageDenominatorAudit: provenAudit(), sidePricingBasisLookup: () => 'transaction' })
    assert.equal(s.publicPnlStatus, 'available')
  })

  it('a complete sample with a market-estimated side is partial, never available', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const s = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null, structuralCoverageDenominatorAudit: provenAudit(), sidePricingBasisLookup: (_c, _t, side) => (side === 'entry' ? 'estimate' : 'transaction') })
    assert.equal(s.publicPnlStatus, 'partial')
  })

  it('no verified lot at all: unavailable, even when the structural gate would say partial', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const unpriced = fifo({ matchedLots: [lot({ costBasisUsd: null, proceedsUsd: null, realizedPnlUsd: null, evidenceQuality: 'unpriced' })], realizedPnlUsd: null, unmatchedBuys: 1 })
    const s = await r.reconcile({ fifoEngineResult: unpriced, pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null })
    assert.equal(s.publicPnlStatus, 'unavailable')
  })

  it('without a basis lookup, a complete verified sample keeps its existing status', async () => {
    const r = createPnlReconciliation({ logger: quiet })
    const s = await r.reconcile({ fifoEngineResult: fifo(), pnlEngineResult: pnl(), syntheticPnlAssemblyOutput: null, structuralCoverageDenominatorAudit: provenAudit() })
    assert.equal(s.publicPnlStatus, 'available')
  })
})
