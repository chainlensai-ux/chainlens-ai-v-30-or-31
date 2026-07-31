// Integration tests for the completion-yield historical-pricing scheduler wiring in
// priceLotsForWallet.ts. Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.scheduler.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xtx', timestamp: '2026-01-01T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

function countingPriceSources(): { sources: PriceSources; calls: number } {
  const state = { calls: 0 }
  const fn: PriceSourceFn = () => {
    state.calls += 1
    return 1
  }
  return { sources: { primary: fn, fallback: fn }, calls: 0 }
}

const originalFlag = process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED

afterEach(() => {
  if (originalFlag === undefined) delete process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED
  else process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED = originalFlag
})

beforeEach(() => {
  delete process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED
})

describe('priceLotsForWallet — completion-yield scheduler wiring', () => {
  it('with the flag OFF (default), a simple buy+sell pair prices identically to the unmodified flat-cap behavior', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(buy), 1)
    assert.equal(lookups.priceUsdLookup(sell), 1)
  })

  it('with the flag ON, the same simple buy+sell pair still fully prices — the scheduler selects at least what the flat rule already would', async () => {
    process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED = 'true'
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sources })
    assert.equal(lookups.priceUsdLookup(buy), 1)
    assert.equal(lookups.priceUsdLookup(sell), 1)
  })

  it('the flag never changes the structural closed-lot count (the public gate denominator)', async () => {
    const buy = event({ txHash: '0xbuy', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', direction: 'outbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const { sources: sourcesOff } = countingPriceSources()
    const offResult = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sourcesOff })

    process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED = 'true'
    const { sources: sourcesOn } = countingPriceSources()
    const onResult = await priceLotsForWallet({ normalizedEvents: [buy, sell], recoveredEvents: [], priceSources: sourcesOn })

    // Neither run ever changes FIFO matching or which lots exist — only pricing selection. The
    // structural closed-lot denominator (fifoEngine's own matchedLots.length, mirrored here via the
    // Aerodrome attribution's own "before" snapshot) must be identical regardless of the flag.
    assert.equal(offResult.aerodromeAttribution.fullyPricedLotsBeforeAerodrome, onResult.aerodromeAttribution.fullyPricedLotsBeforeAerodrome)
  })

  it('a dense wallet (>120 distinct tokens) still fully prices its one real closed lot with the scheduler enabled', async () => {
    process.env.HISTORICAL_PRICING_YIELD_SCHEDULER_ENABLED = 'true'
    const noiseBuys = Array.from({ length: 125 }, (_, i) =>
      event({ txHash: `0xnoise${i}`, contract: `0xnoise${i}`, direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' }))
    const buy1 = event({ txHash: '0xbuy1', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-01T00:00:00.000Z' })
    const buy2 = event({ txHash: '0xbuy2', contract: '0xtarget', direction: 'inbound', timestamp: '2026-01-02T00:00:00.000Z' })
    const sell = event({ txHash: '0xsell', contract: '0xtarget', direction: 'outbound', timestamp: '2026-01-03T00:00:00.000Z', amount: 1 })
    const { sources } = countingPriceSources()

    const lookups = await priceLotsForWallet({
      normalizedEvents: [...noiseBuys, buy1, buy2, sell],
      recoveredEvents: [],
      priceSources: sources,
    })
    assert.equal(lookups.priceUsdLookup(sell), 1, 'the real closed lot\'s sell must still price under the scheduler')
  })
})
