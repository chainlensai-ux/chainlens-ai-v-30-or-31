// Tests for priceLotsForWallet.ts's Aerodrome production-attribution cross-referencing (see
// AerodromeAttribution's own header there). Covers: an existing verified price from an earlier
// source is never miscounted as Aerodrome's, a single accepted Aerodrome price completes the
// correct closed lot exactly once, and FIFO lot structure stays byte-identical regardless of
// whether an Aerodrome attribution was recorded.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.aerodromeAttribution.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import {
  __recordAerodromeAttributionForTest,
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

const NO_OP_SOURCES: PriceSources = {
  primary: (async () => null) as PriceSourceFn,
  fallback: (async () => null) as PriceSourceFn,
}

describe('priceLotsForWallet — Aerodrome production attribution', () => {
  it('4. an existing verified price from an earlier source is never counted as resolved by Aerodrome', async () => {
    const meme = '0x0000000000000000000000000000000000000a01'
    const buy = event({ txHash: '0xexistingbuy', contract: meme, direction: 'inbound', amount: 100, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xexistingsell', contract: meme, direction: 'outbound', amount: 100, timestamp: '2026-01-01T01:00:00.000Z' })
    const events = [buy, sell]

    // Both legs resolve via an ordinary, already-verified priceSources.primary — no Aerodrome
    // attribution is ever recorded for either request (the real production invariant: basedex is
    // only ever reached, and only ever records an attribution, when nothing earlier already
    // resolved that exact request — see basedex.ts's own recordAerodromeAttribution header).
    const sources: PriceSources = {
      primary: (async () => 10) as PriceSourceFn,
      fallback: (async () => null) as PriceSourceFn,
    }

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    assert.equal(lookups.priceUsdLookup(buy), 1000, 'sanity: the pre-existing verified price actually resolved')
    assert.equal(lookups.priceUsdLookup(sell), 1000, 'sanity: the pre-existing verified price actually resolved')
    assert.equal(lookups.aerodromeAttribution.aerodromeSlipstreamRequirementsResolved, 0, 'no requirement here was ever attributed to Aerodrome Slipstream')
    assert.equal(lookups.aerodromeAttribution.aerodromeClassicRequirementsResolved, 0, 'no requirement here was ever attributed to Aerodrome Classic')
    assert.equal(lookups.aerodromeAttribution.lotsCompletedByAerodrome, 0, 'a lot fully priced by an earlier source must never be credited to Aerodrome')
  })

  it('5. one accepted Aerodrome price completes the correct lot exactly once', async () => {
    const meme = '0x0000000000000000000000000000000000000a02'
    const buyTimestamp = '2026-01-01T00:00:00.000Z'
    const sellTimestamp = '2026-01-01T01:00:00.000Z'
    const buy = event({ txHash: '0xcompletebuy', contract: meme, direction: 'inbound', amount: 100, timestamp: buyTimestamp })
    const sell = event({ txHash: '0xcompletesell', contract: meme, direction: 'outbound', amount: 100, timestamp: sellTimestamp })
    const events = [buy, sell]

    // The buy leg has NO other source (would stay unpriced without Aerodrome). The sell leg is
    // "resolved" by a plain source standing in for basedex's real return value — the accompanying
    // __recordAerodromeAttributionForTest call is what a real fetchBaseDexPriceDetailed success
    // would have recorded for this exact (chain, token, timestamp) request, letting this test
    // exercise the REAL cross-referencing logic in priceLotsForWallet.ts without mocking a full
        // JSON-RPC round trip.
    __recordAerodromeAttributionForTest('base', meme, Date.parse(sellTimestamp), 'aerodrome_slipstream', 25)
    const sources: PriceSources = {
      primary: (async (token, _chain, timestamp) => (token.toLowerCase() === meme.toLowerCase() && timestamp === Date.parse(sellTimestamp) ? 25 : null)) as PriceSourceFn,
      fallback: (async () => null) as PriceSourceFn,
    }

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    assert.equal(lookups.priceUsdLookup(buy), null, 'sanity: the buy leg genuinely has no other source')
    assert.equal(lookups.priceUsdLookup(sell), 2500, 'sanity: the sell leg resolved (25 * 100)')
    assert.equal(lookups.aerodromeAttribution.aerodromeSlipstreamRequirementsResolved, 1, 'exactly one requirement (the sell leg) was resolved by Aerodrome Slipstream')
    assert.equal(lookups.aerodromeAttribution.aerodromeClassicRequirementsResolved, 0, 'must never be miscounted under the wrong venue')
    // The lot still isn't FULLY priced (the buy leg has no price at all, from any source) — so
    // Aerodrome's own single accepted price must NOT be reported as having completed this lot.
    assert.equal(lookups.aerodromeAttribution.lotsCompletedByAerodrome, 0, 'one missing leg means the lot is not complete yet, regardless of the other leg\'s source')

    // Now give the buy leg a real, non-Aerodrome price too — the lot completes, and this final
    // completion must be attributed to Aerodrome exactly once (via the sell leg it actually
    // resolved), not zero and not more than once.
    resetBaseDexVenueAttributionForScan()
    __recordAerodromeAttributionForTest('base', meme, Date.parse(sellTimestamp), 'aerodrome_slipstream', 25)
    const sourcesBothSides: PriceSources = {
      primary: (async (token, _chain, timestamp) => {
        if (token.toLowerCase() !== meme.toLowerCase()) return null
        if (timestamp === Date.parse(buyTimestamp)) return 8 // ordinary source resolves the buy leg
        if (timestamp === Date.parse(sellTimestamp)) return 25 // stands in for Aerodrome's own accepted price
        return null
      }) as PriceSourceFn,
      fallback: (async () => null) as PriceSourceFn,
    }
    const completedLookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sourcesBothSides })

    assert.equal(completedLookups.priceUsdLookup(buy), 800, 'sanity: buy leg now resolved via an ordinary source')
    assert.equal(completedLookups.priceUsdLookup(sell), 2500, 'sanity: sell leg still resolved via the Aerodrome-standin source')
    assert.equal(completedLookups.aerodromeAttribution.aerodromeSlipstreamRequirementsResolved, 1, 'still exactly one requirement resolved by Aerodrome')
    assert.equal(completedLookups.aerodromeAttribution.lotsCompletedByAerodrome, 1, 'this lot completed exactly once, credited to Aerodrome')
    assert.equal(completedLookups.aerodromeAttribution.fullyPricedLotsAfterAerodrome - completedLookups.aerodromeAttribution.fullyPricedLotsBeforeAerodrome, 1)
  })

  it('6. FIFO lot structure stays byte-identical whether or not an Aerodrome attribution was recorded', async () => {
    const meme = '0x0000000000000000000000000000000000000a03'
    const buy = event({ txHash: '0xfifobuy', contract: meme, direction: 'inbound', amount: 250, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xfifosell', contract: meme, direction: 'outbound', amount: 250, timestamp: '2026-01-01T01:00:00.000Z' })
    const events = [buy, sell]
    const sellTargets = events.filter((e) => e.direction === 'outbound')

    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    __recordAerodromeAttributionForTest('base', meme, Date.parse('2026-01-01T01:00:00.000Z'), 'aerodrome_classic_volatile', 4)
    const sources: PriceSources = {
      primary: (async (token, _chain, timestamp) =>
        token.toLowerCase() === meme.toLowerCase() && timestamp === Date.parse('2026-01-01T01:00:00.000Z') ? 4 : null) as PriceSourceFn,
      fallback: (async () => null) as PriceSourceFn,
    }
    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical — Aerodrome attribution never changes lot structure, matching, or ranking')

    // Same invariant with NO Aerodrome attribution recorded at all.
    resetBaseDexVenueAttributionForScan()
    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: NO_OP_SOURCES })
    const lotsNone = buildLots(events, [])
    const { matchedLots: matchedNone } = matchLotsFIFO(lotsNone, sellTargets)
    assert.deepEqual(matchedNone, matchedBefore, 'FIFO structure is identical with zero pricing/attribution too')
  })
})
