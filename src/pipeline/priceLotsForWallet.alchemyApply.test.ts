// End-to-end regression tests for Alchemy historical pricing PROMOTED out of shadow mode, gated by
// ALCHEMY_HISTORICAL_PRICING_ENABLED=true (see alchemyHistoricalPriceSource.ts's
// isAlchemyHistoricalPricingEnabled for why this new flag exists — no pre-existing toggle was found
// in this codebase to reuse). Covers: accepted prices actually fill costUsd/proceedsUsd, temporally-
// rejected prices never apply, an existing verified price is never overwritten, the 10-request/400-CU
// cap is unchanged, and FIFO lot structure stays byte-identical regardless of what Alchemy does.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.alchemyApply.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import {
  resetAlchemyHistoricalPricingState,
  MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN,
  ESTIMATED_CU_PER_ALCHEMY_HISTORICAL_REQUEST,
} from '../modules/pricingAtTimeEngine/sources/alchemyHistoricalPriceSource'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const originalKey = process.env.ALCHEMY_API_KEY
const originalEnabledFlag = process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED

beforeEach(() => {
  resetAlchemyHistoricalPricingState()
  process.env.ALCHEMY_API_KEY = 'test-alchemy-key'
})

afterEach(() => {
  global.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ALCHEMY_API_KEY
  else process.env.ALCHEMY_API_KEY = originalKey
  if (originalEnabledFlag === undefined) delete process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED
  else process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED = originalEnabledFlag
})

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'eth', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

const NO_OP_SOURCES: PriceSources = {
  primary: (async () => null) as PriceSourceFn,
  fallback: (async () => null) as PriceSourceFn,
}

describe('priceLotsForWallet — Alchemy historical pricing promoted (ALCHEMY_HISTORICAL_PRICING_ENABLED=true)', () => {
  it('an accepted (temporally-valid) shadow price fills the correct dictionary side, scaled to the transaction total', async () => {
    process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED = 'true'
    const meme = '0x0000000000000000000000000000000000000f00'
    const buy = event({ txHash: '0xapplybuy', contract: meme, direction: 'inbound', amount: 1000, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xapplysell', contract: meme, direction: 'outbound', amount: 1000, timestamp: '2026-01-01T02:00:00.000Z' })
    const events = [buy, sell]

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.g.alchemy.com')) {
        return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '2.5' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: NO_OP_SOURCES })

    // 2.5 USD/token * 1000 tokens = 2500 total USD — the SAME scaling convention resolvePricingAtTime
    // and the quote-leg gap-fill already use (total, not per-unit).
    assert.equal(lookups.priceUsdLookup(buy), 2500, 'the accepted Alchemy price must land in costUsd, scaled by the real transaction amount')
    assert.equal(lookups.priceUsdLookup(sell), 2500, 'the accepted Alchemy price must land in proceedsUsd, scaled by the real transaction amount')
  })

  it('a temporally-rejected (stale) price never applies, even with the flag enabled', async () => {
    process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED = 'true'
    const meme = '0x0000000000000000000000000000000000000f01'
    // 7 hours apart — outside the 6h non-tier2 acceptance window.
    const buy = event({ txHash: '0xstalebuy', contract: meme, direction: 'inbound', amount: 500, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xstalesell', contract: meme, direction: 'outbound', amount: 500, timestamp: '2026-01-01T07:00:00.000Z' })
    const events = [buy, sell]

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.g.alchemy.com')) {
        return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '2.5' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: NO_OP_SOURCES })

    assert.equal(lookups.priceUsdLookup(buy), 1250, 'buy is within the window (0h distance) and must still be applied (2.5 * 500)')
    assert.equal(lookups.priceUsdLookup(sell), null, 'sell is 7h away — outside the 6h non-tier2 window — must be rejected, never applied')
  })

  it('an existing verified price from an earlier source is never overwritten', async () => {
    process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED = 'true'
    const meme = '0x0000000000000000000000000000000000000f02'
    const buy = event({ txHash: '0xverifiedbuy', contract: meme, direction: 'inbound', amount: 100, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xverifiedsell', contract: meme, direction: 'outbound', amount: 100, timestamp: '2026-01-01T01:00:00.000Z' })
    const events = [buy, sell]

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.g.alchemy.com')) {
        // Alchemy would confidently resolve a DIFFERENT price — must never be allowed to win.
        return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '999' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    // The buy leg already has a real, verified price from an earlier (primary) source.
    const sources: PriceSources = {
      primary: (async (_token, _chain, _ts) => 10) as PriceSourceFn, // resolves to a real per-unit price for every entry
      fallback: (async () => null) as PriceSourceFn,
    }

    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    // Both legs get priced by the primary source (10 * 100 = 1000) before Alchemy ever runs — Alchemy
    // must see both sides already resolved and touch neither.
    assert.equal(lookups.priceUsdLookup(buy), 1000, 'the pre-existing verified price must survive untouched')
    assert.equal(lookups.priceUsdLookup(sell), 1000, 'the pre-existing verified price must survive untouched')
  })

  it('the 10-request / 400-CU cap is unchanged when promoted (11 distinct unresolved assets)', async () => {
    process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED = 'true'
    let liveCalls = 0
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.g.alchemy.com')) {
        liveCalls += 1
        return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '1' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const events: NormalizedEvent[] = []
    for (let i = 0; i < 11; i += 1) {
      const token = `0x${(2000 + i).toString().padStart(40, '0')}`
      events.push(event({ txHash: `0xcapbuy${i}`, contract: token, direction: 'inbound', amount: 10, timestamp: '2026-01-01T00:00:00.000Z' }))
      events.push(event({ txHash: `0xcapsell${i}`, contract: token, direction: 'outbound', amount: 10, timestamp: '2026-01-01T01:00:00.000Z' }))
    }

    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: NO_OP_SOURCES })

    assert.equal(liveCalls, MAX_ALCHEMY_HISTORICAL_REQUESTS_PER_SCAN, 'no more than 10 live Alchemy requests, even promoted out of shadow mode')
    assert.equal(liveCalls * ESTIMATED_CU_PER_ALCHEMY_HISTORICAL_REQUEST, 400)
  })

  it('FIFO lot structure stays identical whether Alchemy pricing is promoted or not — only pricing/coverage/PnL values change', async () => {
    const meme = '0x0000000000000000000000000000000000000f03'
    const buy = event({ txHash: '0xfifobuy', contract: meme, direction: 'inbound', amount: 250, timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xfifosell', contract: meme, direction: 'outbound', amount: 250, timestamp: '2026-01-01T01:00:00.000Z' })
    const events = [buy, sell]
    const sellTargets = events.filter((e) => e.direction === 'outbound')

    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('api.g.alchemy.com')) {
        return new Response(JSON.stringify({ data: [{ timestamp: '2026-01-01T00:00:00.000Z', value: '4' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    process.env.ALCHEMY_HISTORICAL_PRICING_ENABLED = 'true'
    await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: NO_OP_SOURCES })

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must be byte-identical — pricing promotion never changes lot structure, matching, or ranking')
  })
})
