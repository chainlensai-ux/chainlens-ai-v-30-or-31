// Regression test for the direction-blind priceUsdLookup bug in priceLotsForWallet.ts. Tests the
// extracted pure function directly (this project's test runner can't reliably mock module imports —
// see fetchPricing.ts's own header for the same disclosed limitation). Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.directionLookup.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEventPriceUsd } from './priceLotsForWallet.ts'

describe('resolveEventPriceUsd — direction-blind lookup bug (confirmed, fixed)', () => {
  it('a sell event resolves its OWN proceeds, not the paired buy leg\'s cost, when both share one txHash', () => {
    // Real production shape: one swap tx (shared txHash) with an inbound (buy) leg for tokenB and an
    // outbound (sell) leg for tokenA — resolvePricingAtTime prices each leg by its own token, but
    // both dictionaries are keyed purely by txHash (usdByTxHash), so they collide on this shared key.
    const costUsd = { '0xswap': 1000 } // tokenB's (the buy leg's) price
    const proceedsUsd = { '0xswap': 999 } // tokenA's (the sell leg's) OWN price — deliberately
    // different from costUsd so a collision is unambiguously detectable.

    const buyEvent = { txHash: '0xswap', direction: 'inbound' as const }
    const sellEvent = { txHash: '0xswap', direction: 'outbound' as const }

    // The bug: this previously returned costUsd['0xswap'] (1000, tokenB's price) for the SELL event
    // instead of proceedsUsd['0xswap'] (999, tokenA's own price), because it tried costUsd first
    // regardless of the event's direction.
    assert.equal(resolveEventPriceUsd(sellEvent, costUsd, proceedsUsd), 999, 'sell event must resolve its OWN proceeds (999), not the paired buy leg\'s cost (1000)')
    assert.equal(resolveEventPriceUsd(buyEvent, costUsd, proceedsUsd), 1000, 'buy event must resolve its own cost')
  })

  it('a sell event with no proceeds entry resolves to null, never borrowed from costUsd', () => {
    // Only costUsd has an entry for this txHash — proceedsUsd genuinely has nothing (e.g. the sell
    // leg's own price source failed). Before the fix, this would incorrectly borrow 1000.
    const costUsd = { '0xswap2': 1000 }
    const proceedsUsd = {}
    const sellEvent = { txHash: '0xswap2', direction: 'outbound' as const }

    assert.equal(resolveEventPriceUsd(sellEvent, costUsd, proceedsUsd), null, 'unpriced sell must stay honestly null, never borrow the buy dictionary\'s value')
  })

  it('a buy event with no cost entry resolves to null, never borrowed from proceedsUsd', () => {
    const costUsd = {}
    const proceedsUsd = { '0xswap3': 500 }
    const buyEvent = { txHash: '0xswap3', direction: 'inbound' as const }

    assert.equal(resolveEventPriceUsd(buyEvent, costUsd, proceedsUsd), null, 'unpriced buy must stay honestly null, never borrow the sell dictionary\'s value')
  })

  it('an unknown-direction event resolves to null (never guesses which dictionary to use)', () => {
    const costUsd = { '0xswap4': 1000 }
    const proceedsUsd = { '0xswap4': 999 }
    const unknownEvent = { txHash: '0xswap4', direction: 'unknown' as const }

    assert.equal(resolveEventPriceUsd(unknownEvent, costUsd, proceedsUsd), null)
  })
})
