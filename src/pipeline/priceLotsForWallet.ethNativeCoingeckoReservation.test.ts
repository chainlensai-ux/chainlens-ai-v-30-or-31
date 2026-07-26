// End-to-end regression test: an ordinary, lower-priority CoinGecko call would trip a 429 in this
// scan (simulating production's "CoinGecko elsewhere reports circuit_open_after_429"), but the
// higher-priority ETH native requirement — reserved ahead of it — gets its own real attempt first
// and resolves successfully, recovering fullyPricedLots.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.ethNativeCoingeckoReservation.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { buildChainAwareHistoricalPriceSource, resetPricingAtTimeAdapterScanState } from './pricingAtTimeAdapter'
import { resetCoingeckoCircuitBreaker } from '../modules/pricingAtTimeEngine/sources/coingecko'
import { __resetGoldrushPriceSourceCachesForTest } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { resetGeckoTerminalNoPoolCache } from './providers/geckoTerminalPriceSource'
import { __resetBaseDexCachesForTest } from '../modules/pricingAtTimeEngine/sources/basedex'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn, PriceSources } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const ETH_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

beforeEach(() => {
  resetPricingAtTimeAdapterScanState()
  __resetGoldrushPriceSourceCachesForTest()
  resetCoingeckoCircuitBreaker()
  resetGeckoTerminalNoPoolCache()
  __resetBaseDexCachesForTest()
})

afterEach(() => {
  global.fetch = originalFetch
})

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    provider: 'goldrush', chain: 'eth', txHash: '0xtx', timestamp: '2024-03-15T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

describe('priceLotsForWallet — ETH native CoinGecko reservation, end-to-end', () => {
  it('fullyPricedLots increases even though an ordinary CoinGecko call would have 429\'d in this scan, and FIFO stays byte-identical', async () => {
    const meme = '0x0000000000000000000000000000000000000700'
    const events: NormalizedEvent[] = [
      event({ txHash: '0xressbuy1', contract: meme, direction: 'inbound', amount: 1000, timestamp: '2024-03-15T00:00:00.000Z' }),
      event({
        txHash: '0xressbuy1', contract: ETH_WETH, symbol: 'WETH', tokenDecimals: 18,
        amount: 1, direction: 'outbound', fromAddress: '0xwallet', toAddress: '0xrouter', timestamp: '2024-03-15T00:00:00.000Z',
      }),
      event({ txHash: '0xresssell1', contract: meme, direction: 'outbound', amount: 1000, timestamp: '2024-03-16T00:00:00.000Z' }),
      event({
        txHash: '0xresssell1', contract: ETH_WETH, symbol: 'WETH', tokenDecimals: 18,
        amount: 1.2, direction: 'inbound', fromAddress: '0xrouter', toAddress: '0xwallet', timestamp: '2024-03-16T00:00:00.000Z',
      }),
    ]

    // Every ORDINARY (contract-based) CoinGecko request in this scan would trip a 429 — simulating
    // production's confirmed starvation mechanism. The native ETH endpoint always succeeds.
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/coins/ethereum/history')) {
        return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 429 })
    }) as unknown as typeof fetch

    const goldrush: PriceSourceFn = async () => null
    const realHistoricalSource = buildChainAwareHistoricalPriceSource(goldrush)
    const sources: PriceSources = { primary: realHistoricalSource, fallback: realHistoricalSource }

    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const fullyPricedBefore = 0
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const buyLeg = events.find((e) => e.txHash === '0xressbuy1' && e.contract === meme)!
    const sellLeg = events.find((e) => e.txHash === '0xresssell1' && e.contract === meme)!
    const fullyPricedAfter = lookups.priceUsdLookup(buyLeg) != null && lookups.priceUsdLookup(sellLeg) != null ? 1 : 0

    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must increase — the reserved native ETH requirements must resolve despite the 429-prone ordinary CoinGecko traffic')

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must stay byte-identical')
  })
})
