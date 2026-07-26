// Tests for priceLotsForWallet.ts's shared-quote-price cross-referencing (requirementsRecoveredBy-
// SharedQuotePrice / lotsCompletedBySharedQuotePrice) — see basedex.ts's own "SHARED QUOTE-PRICE
// CACHE" header for the full production trace (Aerodrome completed 0 lots because
// quote_token_usd_unavailable kept blocking the opposite side).
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.sharedQuotePrice.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import {
  __recordQuotePriceAttributionForTest,
  resetBaseDexVenueAttributionForScan,
} from '../modules/pricingAtTimeEngine/sources/basedex'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

beforeEach(() => {
  resetBaseDexVenueAttributionForScan()
})

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

describe('priceLotsForWallet — shared quote-price attribution', () => {
  it('a requirement resolved via a shared quote-price cache hit is counted, and completes the lot exactly once', async () => {
    const meme = '0x0000000000000000000000000000000000000b01'
    const buyTimestamp = '2026-01-01T00:00:00.000Z'
    const sellTimestamp = '2026-01-01T01:00:00.000Z'
    const buy = event({ txHash: '0xqpbuy', contract: meme, direction: 'inbound', amount: 100, timestamp: buyTimestamp })
    const sell = event({ txHash: '0xqpsell', contract: meme, direction: 'outbound', amount: 100, timestamp: sellTimestamp })
    const events = [buy, sell]

    // The buy leg has a real, ordinary source. The sell leg stands in for a basedex venue price whose
    // WETH-USD conversion was served by the shared cache (a real fetchBaseDexPriceDetailed success
    // would have called __recordQuotePriceAttributionForTest's underlying recorder itself).
    __recordQuotePriceAttributionForTest('base', meme, Date.parse(sellTimestamp), 'uniswap_v3', true)
    const sources: PriceSources = {
      primary: (async (token, _chain, timestamp) => {
        if (token.toLowerCase() !== meme.toLowerCase()) return null
        if (timestamp === Date.parse(buyTimestamp)) return 8
        if (timestamp === Date.parse(sellTimestamp)) return 25
        return null
      }) as PriceSourceFn,
      fallback: (async () => null) as PriceSourceFn,
    }

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    assert.equal(lookups.priceUsdLookup(buy), 800)
    assert.equal(lookups.priceUsdLookup(sell), 2500)
    assert.equal(lookups.aerodromeAttribution.requirementsRecoveredBySharedQuotePrice, 1, 'exactly one requirement was recovered by the shared quote-price cache')
    assert.equal(lookups.aerodromeAttribution.lotsCompletedBySharedQuotePrice, 1, 'the lot completed exactly once, credited to the shared quote-price cache')
  })

  it('a requirement resolved WITHOUT a shared cache hit (a real live resolution) is never counted as recovered', async () => {
    const meme = '0x0000000000000000000000000000000000000b02'
    const buy = event({ txHash: '0xlivebuy', contract: meme, direction: 'inbound', amount: 10, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xlivesell', contract: meme, direction: 'outbound', amount: 10, timestamp: '2026-01-01T01:00:00.000Z' })
    const events = [buy, sell]

    __recordQuotePriceAttributionForTest('base', meme, Date.parse('2026-01-01T01:00:00.000Z'), 'uniswap_v3', false) // live resolution, not a cache hit
    const sources: PriceSources = {
      primary: (async () => 5) as PriceSourceFn,
      fallback: (async () => null) as PriceSourceFn,
    }

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    assert.equal(lookups.aerodromeAttribution.requirementsRecoveredBySharedQuotePrice, 0, 'a live (non-cache-hit) resolution must never be counted as recovered by the shared cache')
    assert.equal(lookups.aerodromeAttribution.lotsCompletedBySharedQuotePrice, 0)
  })
})
