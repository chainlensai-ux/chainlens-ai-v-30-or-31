// Tests for pnlEngine's duplicate-sell-entry fix (dedupeSellEntries, buildPnlSummary). Uses
// node:test, no real network dependency. Run directly with:
//   npx tsx --test src/modules/pnlEngine/index.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPnlSummary, dedupeSellEntries } from './index.ts'
import type { SellTimelineEntry } from '../sellTimeline/types'
import type { BuyTimelineEntry } from '../timelineBuilder/types'

function sell(overrides: Partial<SellTimelineEntry> = {}): SellTimelineEntry {
  return {
    timestamp: 1, chain: 'base', token: '0xtoken', symbol: 'TOK', amount: '10',
    proceedsUsdEstimate: null, matchedBuyLotId: null, confidence: 'medium', txHash: '0xsell',
    chainSelectionRef: { status: 'active_intelligence', gatesPassed: [] }, counterparty: '0xrouter',
    ...overrides,
  }
}

describe('dedupeSellEntries — confirmed bug fix', () => {
  it('rejects an exact-identity duplicate (same chain/token/txHash/amount), keeping the first occurrence', () => {
    // Real production shape: sellTimelineV2 can report the SAME real transfer twice (once via
    // "transfer-out to known router", once via "bridge-exit") — identical chain/token/txHash/amount,
    // only the detection mechanism/confidence differs.
    const original = sell({ txHash: '0xdup', confidence: 'medium' })
    const duplicate = sell({ txHash: '0xdup', confidence: 'high' }) // different mechanism, same real transfer
    const { deduped, duplicatesRejected } = dedupeSellEntries([original, duplicate])

    assert.equal(deduped.length, 1)
    assert.equal(duplicatesRejected, 1)
    assert.equal(deduped[0], original, 'the FIRST occurrence is kept, deterministic')
  })

  it('keeps two genuinely distinct sells (different txHash) for the same token', () => {
    const a = sell({ txHash: '0xa' })
    const b = sell({ txHash: '0xb' })
    const { deduped, duplicatesRejected } = dedupeSellEntries([a, b])
    assert.equal(deduped.length, 2)
    assert.equal(duplicatesRejected, 0)
  })

  it('keeps two distinct legs sharing one txHash but different tokens (a real multi-leg swap)', () => {
    const legA = sell({ txHash: '0xswap', token: '0xtokenA' })
    const legB = sell({ txHash: '0xswap', token: '0xtokenB' })
    const { deduped, duplicatesRejected } = dedupeSellEntries([legA, legB])
    assert.equal(deduped.length, 2, 'two genuinely different tokens in one tx must both survive')
    assert.equal(duplicatesRejected, 0)
  })

  it('chain separation: same token/txHash/amount on two different chains are NOT deduped', () => {
    const onBase = sell({ txHash: '0xsame', chain: 'base' })
    const onEth = sell({ txHash: '0xsame', chain: 'eth' })
    const { deduped, duplicatesRejected } = dedupeSellEntries([onBase, onEth])
    assert.equal(deduped.length, 2)
    assert.equal(duplicatesRejected, 0)
  })
})

describe('buildPnlSummary — duplicate sells cannot double-count realized PnL (confirmed bug, fixed)', () => {
  it('a duplicate sell entry contributes to realizedPnlUsd only once, not twice', () => {
    const original = sell({ txHash: '0xdup', proceedsUsdEstimate: 120 })
    const duplicate = sell({ txHash: '0xdup', proceedsUsdEstimate: 120 })
    const buyEntries: BuyTimelineEntry[] = []

    const summary = buildPnlSummary({
      sellEntries: [original, duplicate],
      buyEntries,
      resolveCostUsdEstimate: () => 100,
      resolveProceedsUsdEstimate: () => 120,
    })

    // Real bug: previously this would have produced 2 closedLots, both realizedPnlUsd: 20, summing
    // to a fabricated $40 for one real $20 sell. Fixed: exactly one closed lot, $20.
    assert.equal(summary.closedLots.length, 1, 'the duplicate entry must not produce a second closed lot')
    assert.equal(summary.realizedPnlUsd, 20, 'realizedPnlUsd must reflect ONE real sell (120-100=20), never double-counted to 40')
  })

  it('two genuinely distinct sells (different txHash) both still contribute independently', () => {
    const sellA = sell({ txHash: '0xa', proceedsUsdEstimate: 50 })
    const sellB = sell({ txHash: '0xb', proceedsUsdEstimate: 80 })

    const summary = buildPnlSummary({
      sellEntries: [sellA, sellB],
      buyEntries: [],
      resolveCostUsdEstimate: () => 30,
      resolveProceedsUsdEstimate: (s) => s.proceedsUsdEstimate,
    })

    assert.equal(summary.closedLots.length, 2)
    assert.equal(summary.realizedPnlUsd, 70, '(50-30) + (80-30) = 70, both real sells counted exactly once each')
  })
})
