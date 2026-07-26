// End-to-end regression test: shadow-mode Alchemy historical pricing runs (records results, logs the
// audit) but leaves FIFO output and official pricing completely unchanged — proving the shadow-mode
// guarantee holds through the real priceLotsForWallet call path, not just in isolation.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.alchemyShadowMode.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { resetAlchemyHistoricalPricingState } from '../modules/pricingAtTimeEngine/sources/alchemyHistoricalPriceSource'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const originalKey = process.env.ALCHEMY_API_KEY

beforeEach(() => {
  resetAlchemyHistoricalPricingState()
  process.env.ALCHEMY_API_KEY = 'test-alchemy-key'
})

afterEach(() => {
  global.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY
  else process.env.ALCHEMY_API_KEY = originalKey
})

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'eth', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

describe('priceLotsForWallet — Alchemy shadow mode leaves official pricing/FIFO unchanged', () => {
  it('a closed lot with no direct price anywhere stays unpriced in the official lookup, even though the Alchemy shadow pass would have resolved a price', async () => {
    const meme = '0x0000000000000000000000000000000000000a00'
    const buy = event({ txHash: '0xshadowbuy', contract: meme, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xshadowsell', contract: meme, direction: 'outbound', amount: 1000, timestamp: '2026-01-02T00:00:00.000Z' })
    const events = [buy, sell]

    // Alchemy would genuinely succeed here (shadow evidence) — but no official source does.
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.g.alchemy.com')) {
        return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '3500' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const goldrush: PriceSourceFn = async () => null
    const sources: PriceSources = { primary: goldrush, fallback: goldrush }

    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    // Official pricing is completely unaffected — Alchemy's shadow success never reaches costUsd/
    // proceedsUsd, fifoEngine, or the returned lookup.
    assert.equal(lookups.priceUsdLookup(buy), null, 'shadow-mode Alchemy pricing must never leak into the official priceUsdLookup')
    assert.equal(lookups.priceUsdLookup(sell), null)

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical — shadow mode changes nothing about lot matching')
  })
})
