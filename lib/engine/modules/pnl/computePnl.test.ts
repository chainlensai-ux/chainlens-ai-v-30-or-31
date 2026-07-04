// Tests for lib/engine/modules/pnl/computePnl.ts. Uses node:test, same convention as the other
// module test files this session. NOT wired into `npm test` (which runs a single hardcoded file —
// see package.json). Run directly with:
//   npx tsx --test lib/engine/modules/pnl/computePnl.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './computePnl'
import type { ParsedTrade } from './types'
import type { PricedHolding } from '../pricing/types'

function trade(overrides: Partial<ParsedTrade>): ParsedTrade {
  return {
    tokenAddress: '0xeth',
    chainId: 1,
    type: 'buy',
    quantity: 1,
    valueUsd: 2000,
    timestamp: 1000,
    ...overrides,
  }
}

function priced(overrides: Partial<PricedHolding>): PricedHolding {
  return {
    chainId: 1,
    tokenAddress: '0xeth',
    symbol: 'ETH',
    decimals: 18,
    quantity: '1',
    priceUsd: 3000,
    valueUsd: 3000,
    classification: 'blue_chip',
    ...overrides,
  }
}

describe('computePnl', () => {
  it('empty trades -> pnlStatus "unavailable", realized/unrealized 0', async () => {
    const result = await computePnl([], [], 0, [])
    assert.equal(result.pnlStatus, 'unavailable')
    assert.equal(result.pnlV2.realizedPnlUsd, 0)
    assert.equal(result.pnlV2.unrealizedPnlUsd, 0)
    assert.deepEqual(result.pnlV2.costBasis, [])
    assert.deepEqual(result.pnlV2.realized, [])
    assert.deepEqual(result.pnlV2.unrealized, [])
    assert.deepEqual(result.pnlV2.chainBreakdown, [])
  })

  it('simple FIFO: buys 1 ETH@2000, 1 ETH@2500; sell 1 ETH@3000 -> realizedPnlUsd = 1000', async () => {
    const trades: ParsedTrade[] = [
      trade({ type: 'buy', quantity: 1, valueUsd: 2000, timestamp: 1 }),
      trade({ type: 'buy', quantity: 1, valueUsd: 2500, timestamp: 2 }),
      trade({ type: 'sell', quantity: 1, valueUsd: 3000, timestamp: 3 }),
    ]
    const result = await computePnl([], [], 0, trades)

    assert.equal(result.pnlStatus, 'ok')
    assert.equal(result.pnlV2.realizedPnlUsd, 1000) // FIFO: first lot (2000) sold @ 3000 -> 1000
    assert.equal(result.pnlV2.realized.length, 1)
    assert.equal(result.pnlV2.realized[0].realizedPnlUsd, 1000)

    // Remaining FIFO queue: the second buy (1 ETH @ 2500) is still open.
    assert.equal(result.pnlV2.costBasis.length, 1)
    assert.equal(result.pnlV2.costBasis[0].totalQuantity, 1)
    assert.equal(result.pnlV2.costBasis[0].totalCostUsd, 2500)
    assert.equal(result.pnlV2.costBasis[0].averageCostUsd, 2500)
  })

  it('unrealized: remaining 1 ETH cost basis $2500, current price $3000 -> unrealizedPnlUsd = 500', async () => {
    const trades: ParsedTrade[] = [
      trade({ type: 'buy', quantity: 1, valueUsd: 2000, timestamp: 1 }),
      trade({ type: 'buy', quantity: 1, valueUsd: 2500, timestamp: 2 }),
      trade({ type: 'sell', quantity: 1, valueUsd: 3000, timestamp: 3 }),
    ]
    const holdings: PricedHolding[] = [priced({ valueUsd: 3000 })]
    const result = await computePnl(holdings, [], 3000, trades)

    assert.equal(result.pnlV2.unrealized.length, 1)
    assert.equal(result.pnlV2.unrealized[0].unrealizedPnlUsd, 500) // 3000 - 2500
    assert.equal(result.pnlV2.unrealizedPnlUsd, 500)
  })

  it('partial pricing: some pricedHoldings have null priceUsd/valueUsd -> pnlStatus "partial"', async () => {
    const trades: ParsedTrade[] = [trade({ type: 'buy', quantity: 1, valueUsd: 2000, timestamp: 1 })]
    const holdings: PricedHolding[] = [
      priced({ valueUsd: 3000, priceUsd: 3000 }),
      priced({ tokenAddress: '0xunpriced', valueUsd: null, priceUsd: null }),
    ]
    const result = await computePnl(holdings, [], 3000, trades)
    assert.equal(result.pnlStatus, 'partial')
  })

  it('unpriced trade -> excluded from FIFO, pnlStatus "partial"', async () => {
    const trades: ParsedTrade[] = [
      trade({ type: 'buy', quantity: 1, valueUsd: null, timestamp: 1 }), // unpriced buy, skipped
      trade({ type: 'buy', quantity: 1, valueUsd: 2000, timestamp: 2 }),
    ]
    const result = await computePnl([], [], 0, trades)
    assert.equal(result.pnlStatus, 'partial')
    assert.equal(result.pnlV2.costBasis.length, 1)
    assert.equal(result.pnlV2.costBasis[0].totalCostUsd, 2000) // only the priced buy counted
  })
})
