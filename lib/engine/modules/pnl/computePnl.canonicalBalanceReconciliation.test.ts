// Regression tests for computePnl's canonical-balance reconciliation (lib/engine/modules/pnl/
// computePnl.ts) — fixes a confirmed production bug: the wallet-scanner UI's "PnL (Verified V2)"
// panel (backed by THIS module — a separate, parallel PnL engine from src/modules/fifoEngine, whose
// own canonical-balance reconciliation was fixed in an earlier task but never applied here) showed a
// fabricated -$545,833.02 unrealized PnL on chain 8453. Root cause: `holding.valueUsd -
// match.totalCostUsd` was computed with NO check that `match.totalQuantity` (this module's own
// FIFO-replayed remaining quantity) was anywhere close to `holding.quantity` (the real,
// independently-fetched current balance).
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test lib/engine/modules/pnl/computePnl.canonicalBalanceReconciliation.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePnl } from './computePnl'
import type { ParsedTrade } from './types'
import type { PricedHolding } from '../pricing/types'

function trade(overrides: Partial<ParsedTrade>): ParsedTrade {
  return {
    tokenAddress: '0xtoken',
    chainId: 8453,
    type: 'buy',
    quantity: 1,
    valueUsd: 1,
    timestamp: 1000,
    ...overrides,
  }
}

function priced(overrides: Partial<PricedHolding>): PricedHolding {
  return {
    chainId: 8453,
    tokenAddress: '0xtoken',
    symbol: 'TOK',
    decimals: 18,
    quantity: '1',
    priceUsd: 1,
    valueUsd: 1,
    classification: 'meme',
    ...overrides,
  }
}

describe('computePnl — canonical-balance reconciliation (false -$545k unrealized PnL fix)', () => {
  it('HARD ASSERTION (Wallet PnL Item 3): FIFO remaining ≫ canonical balance is CAPPED to the held quantity for unrealized, never excluded and never valued at the FIFO quantity', async () => {
    // Production shape: a token with a real current balance/value of only ~$24, but a FIFO
    // remaining quantity many times larger than the wallet actually holds.
    const trades: ParsedTrade[] = [
      trade({ quantity: 10_000_000, valueUsd: 545_857.17, timestamp: 1 }),
    ]
    const holdings: PricedHolding[] = [priced({ quantity: '100', priceUsd: 0.24, valueUsd: 24 })]

    const result = await computePnl(holdings, [], 24, trades)

    assert.equal(result.pnlV2.unrealized.length, 1, 'a known positive balance must still contribute to official unrealized')
    assert.equal(result.pnlV2.unrealizedExcludedPositions?.length, 0)
    const scale = 100 / 10_000_000
    const expected = 24 - 545_857.17 * scale
    assert.equal(result.pnlV2.unrealizedPnlUsd, expected)
    assert.ok(result.pnlV2.unrealizedPnlUsd > -100 && result.pnlV2.unrealizedPnlUsd < 100, 'official unrealized must be the held-quantity figure, never the ~-$545k FIFO-qty candidate')
    assert.equal(result.pnlV2.realizedPnlUsd, 0, 'capping unrealized must never invent missing sells into realized')
  })

  it('a position with FIFO remaining quantity <= canonical balance reconciles normally and contributes to official unrealizedPnlUsd', async () => {
    const trades: ParsedTrade[] = [trade({ quantity: 100, valueUsd: 50, timestamp: 1 })]
    const holdings: PricedHolding[] = [priced({ quantity: '100', priceUsd: 1, valueUsd: 100 })]

    const result = await computePnl(holdings, [], 100, trades)

    assert.equal(result.pnlV2.unrealizedExcludedPositions?.length, 0)
    assert.equal(result.pnlV2.unrealized.length, 1)
    assert.equal(result.pnlV2.unrealizedPnlUsd, 100 - 50, 'a genuinely reconciling position must still be priced normally')
  })

  it('a malformed (non-numeric) canonical quantity string fails closed instead of silently coercing to NaN/0', async () => {
    const trades: ParsedTrade[] = [trade({ quantity: 10, valueUsd: 5, timestamp: 1 })]
    const holdings: PricedHolding[] = [priced({ quantity: 'not-a-number', priceUsd: 1, valueUsd: 10 })]

    const result = await computePnl(holdings, [], 10, trades)

    assert.equal(result.pnlV2.unrealizedPnlUsd, 0)
    assert.equal(result.pnlV2.unrealizedExcludedPositions?.[0].exclusionReason, 'invalid_canonical_quantity')
  })

  it('a negative canonical quantity (impossible balance) fails closed', async () => {
    const trades: ParsedTrade[] = [trade({ quantity: 10, valueUsd: 5, timestamp: 1 })]
    const holdings: PricedHolding[] = [priced({ quantity: '-5', priceUsd: 1, valueUsd: 10 })]

    const result = await computePnl(holdings, [], 10, trades)

    assert.equal(result.pnlV2.unrealizedExcludedPositions?.[0].exclusionReason, 'invalid_canonical_quantity')
  })

  it('realized PnL is completely unaffected by unrealized-side reconciliation', async () => {
    const trades: ParsedTrade[] = [
      trade({ type: 'buy', quantity: 1, valueUsd: 2000, timestamp: 1 }),
      trade({ type: 'sell', quantity: 1, valueUsd: 2500, timestamp: 2 }),
      // A second, unrelated open position with a wildly inflated quantity vs. its real balance.
      trade({ quantity: 5_000_000, valueUsd: 100_000, timestamp: 3, tokenAddress: '0xother' }),
    ]
    const holdings: PricedHolding[] = [priced({ tokenAddress: '0xother', quantity: '10', priceUsd: 1, valueUsd: 10 })]

    const result = await computePnl(holdings, [], 10, trades)

    assert.equal(result.pnlV2.realizedPnlUsd, 500, 'realizedPnlUsd (2500 - 2000) must be untouched by the capped open position')
    assert.equal(result.pnlV2.realized.length, 1)
    assert.equal(result.pnlV2.realized[0].realizedPnlUsd, 500)
    assert.equal(result.pnlV2.unrealizedExcludedPositions?.length, 0, 'a known positive balance is capped into unrealized, never excluded')
    const scale = 10 / 5_000_000
    assert.equal(result.pnlV2.unrealizedPnlUsd, 10 - 100_000 * scale)
  })

  it('zero-tolerance-boundary: a quantity within the 0.1% float-rounding tolerance still reconciles', async () => {
    const trades: ParsedTrade[] = [trade({ quantity: 100.05, valueUsd: 50, timestamp: 1 })]
    const holdings: PricedHolding[] = [priced({ quantity: '100', priceUsd: 1, valueUsd: 100 })]

    const result = await computePnl(holdings, [], 100, trades)

    assert.equal(result.pnlV2.unrealizedExcludedPositions?.length, 0, '0.05% over is within the 0.1% tolerance')
  })
})
