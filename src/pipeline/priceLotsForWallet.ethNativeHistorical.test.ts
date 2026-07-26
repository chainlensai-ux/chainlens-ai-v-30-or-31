// End-to-end regression test: an Ethereum-mainnet native-ETH-funded swap, priced through the REAL
// chain-aware router (buildChainAwareHistoricalPriceSource), proving the ETH native routing fix
// (pricingAtTimeAdapter.ts) actually recovers fullyPricedLots for real 'eth'-chain closed lots —
// not just the isolated router-level fix.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.ethNativeHistorical.test.ts

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

// Only counts calls carrying one of THIS fixture's two real historical dates — priceLotsForWallet
// also runs a separate "current" price pass (Date.now()-timestamped, for open-lot mark-to-market)
// that legitimately queries WETH's current price too, uncapped by and unrelated to the historical
// per-token cap this test is about.
function mockCoingeckoNativeEth(priceUsd: number): { historicalCallCount: () => number } {
  let calls = 0
  const historicalDates = new Set(['15-03-2024', '16-03-2024'])
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/coins/ethereum/history')) {
      if (historicalDates.has(new URL(url).searchParams.get('date') ?? '')) calls += 1
      return new Response(JSON.stringify({ market_data: { current_price: { usd: priceUsd } } }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
  return { historicalCallCount: () => calls }
}

describe('priceLotsForWallet — ETH native historical pricing, end-to-end via the real router', () => {
  it('an Ethereum native-ETH-funded closed lot becomes fully priced using the fixed routing, cap stays 2, FIFO byte-identical', async () => {
    const meme = '0x0000000000000000000000000000000000000600'
    const events: NormalizedEvent[] = [
      event({ txHash: '0xethbuy1', contract: meme, direction: 'inbound', amount: 1000, timestamp: '2024-03-15T00:00:00.000Z' }),
      event({
        txHash: '0xethbuy1', contract: ETH_WETH, symbol: 'WETH', tokenDecimals: 18,
        amount: 1, direction: 'outbound', fromAddress: '0xwallet', toAddress: '0xrouter', timestamp: '2024-03-15T00:00:00.000Z',
      }),
      event({ txHash: '0xethsell1', contract: meme, direction: 'outbound', amount: 1000, timestamp: '2024-03-16T00:00:00.000Z' }),
      event({
        txHash: '0xethsell1', contract: ETH_WETH, symbol: 'WETH', tokenDecimals: 18,
        amount: 1.2, direction: 'inbound', fromAddress: '0xrouter', toAddress: '0xwallet', timestamp: '2024-03-16T00:00:00.000Z',
      }),
    ]

    const { historicalCallCount } = mockCoingeckoNativeEth(3500)
    // The memecoin itself never resolves via any real source (production's own reality); goldrush
    // (this file's own real-provider slot) is always null here — WETH resolves via the real chain-
    // aware router, exercising the actual fixed code path, not a hand-rolled mock of it.
    const goldrush: PriceSourceFn = async () => null
    const realHistoricalSource = buildChainAwareHistoricalPriceSource(goldrush)
    const sources: PriceSources = { primary: realHistoricalSource, fallback: realHistoricalSource }

    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const fullyPricedBefore = 0
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const buyLeg = events.find((e) => e.txHash === '0xethbuy1' && e.contract === meme)!
    const sellLeg = events.find((e) => e.txHash === '0xethsell1' && e.contract === meme)!
    const entryPriced = lookups.priceUsdLookup(buyLeg) != null
    const exitPriced = lookups.priceUsdLookup(sellLeg) != null
    const fullyPricedAfter = entryPriced && exitPriced ? 1 : 0

    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must increase — the Ethereum native quote leg must now resolve via the fixed routing')
    assert.ok(historicalCallCount() <= 2, 'cap remains 2 — no additional provider-budget increase')

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must stay byte-identical')
  })
})
