import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MatchedLot } from '../modules/fifoEngine/types'
import { buildPnlSummary } from '../modules/pnlEngine/index'
import type { SellTimelineEntry } from '../modules/sellTimeline/types'
import { buildFifoBackedPnlResolvers } from './fifoBackedPnlResolvers'

function lot(overrides: Partial<MatchedLot> = {}): MatchedLot {
  return {
    lotId: 'lot-1', token: '0xtoken-a', chain: 'base', openedAt: 1, closedAt: 2,
    openedTxHash: '0xbuy', closedTxHash: '0xshared-sell', amount: 1,
    costBasisUsd: 10, proceedsUsd: 15, realizedPnlUsd: 5, evidenceQuality: 'verified',
    ...overrides,
  }
}

function sell(overrides: Partial<SellTimelineEntry> = {}): SellTimelineEntry {
  return {
    timestamp: 2, chain: 'base', token: '0xtoken-a', symbol: 'A', amount: '1',
    proceedsUsdEstimate: null, matchedBuyLotId: null, confidence: 'high', txHash: '0xshared-sell',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] }, counterparty: '0xrouter',
    ...overrides,
  }
}

describe('buildFifoBackedPnlResolvers', () => {
  it('scopes same-transaction aggregates by chain and token so multi-token rows are never duplicated', () => {
    const sellA = sell({ token: '0xtoken-a', symbol: 'A', amount: '1' })
    const sellB = sell({ token: '0xtoken-b', symbol: 'B', amount: '2' })
    const resolvers = buildFifoBackedPnlResolvers([
      lot({ lotId: 'a', token: '0xtoken-a', amount: 1, costBasisUsd: 10, proceedsUsd: 15, realizedPnlUsd: 5 }),
      lot({ lotId: 'b', token: '0xtoken-b', amount: 2, costBasisUsd: 20, proceedsUsd: 30, realizedPnlUsd: 10 }),
    ], [sellA, sellB])

    const summary = buildPnlSummary({ sellEntries: [sellA, sellB], buyEntries: [], ...resolvers })
    assert.deepEqual(summary.closedLots.map(row => ({ token: row.token, cost: row.costUsdEstimate, proceeds: row.proceedsUsdEstimate, pnl: row.realizedPnlUsd })), [
      { token: '0xtoken-a', cost: 10, proceeds: 15, pnl: 5 },
      { token: '0xtoken-b', cost: 20, proceeds: 30, pnl: 10 },
    ])
    assert.equal(summary.realizedPnlUsd, 15)
  })

  it('sums FIFO fragments for one sell entry without changing fragment economics', () => {
    const entry = sell({ amount: '1' })
    const resolvers = buildFifoBackedPnlResolvers([
      lot({ lotId: 'a', amount: 0.4, costBasisUsd: 4, proceedsUsd: 6, realizedPnlUsd: 2 }),
      lot({ lotId: 'b', amount: 0.6, costBasisUsd: 6, proceedsUsd: 9, realizedPnlUsd: 3 }),
    ], [entry])
    assert.equal(resolvers.resolveCostUsdEstimate(entry, []), 10)
    assert.equal(resolvers.resolveProceedsUsdEstimate(entry), 15)
  })

  it('fails closed for ambiguous same-chain/token/tx sells instead of assigning one aggregate twice', () => {
    const first = sell({ amount: '1' })
    const second = sell({ amount: '2' })
    const resolvers = buildFifoBackedPnlResolvers([lot({ amount: 3, costBasisUsd: 30, proceedsUsd: 45 })], [first, second])
    const summary = buildPnlSummary({ sellEntries: [first, second], buyEntries: [], ...resolvers })
    assert.equal(summary.realizedPnlUsd, null)
    assert.equal(summary.evidenceMissingCount, 2)
    assert.deepEqual(summary.closedLots.map(row => [row.costUsdEstimate, row.proceedsUsdEstimate]), [[null, null], [null, null]])
  })
})
