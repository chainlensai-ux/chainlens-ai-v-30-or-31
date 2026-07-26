// End-to-end regression test: two ETH-native closed-lot requirements sharing the SAME calendar date
// (production's confirmed "both requested ethereum history for 11-05-2026, both received real HTTP
// 429") — proving the fixed date-level coalescing makes exactly one real request for both, recovers
// fullyPricedLots, and leaves FIFO output byte-identical.
//
// Run with:
//   npx tsx --test src/pipeline/priceLotsForWallet.ethNativeDateCoalescing.test.ts

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
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

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
    provider: 'goldrush', chain: 'eth', txHash: '0xtx', timestamp: '2026-05-11T00:00:00.000Z',
    fromAddress: '0xfrom', toAddress: '0xto', contract: '0xtoken', symbol: 'TOK',
    amount: 1, amountRaw: '1000000000000000000', tokenDecimals: 18, direction: 'inbound',
    ...overrides,
  }
}

describe('priceLotsForWallet — ETH native history date coalescing, end-to-end', () => {
  it('two closed lots quoted in ETH on the SAME calendar date share one real request, fullyPricedLots increases, FIFO stays byte-identical', async () => {
    const memeA = '0x0000000000000000000000000000000000000800'
    const memeB = '0x0000000000000000000000000000000000000801'
    // Two DIFFERENT closed lots, both entry-quoted in native ETH on the SAME calendar date
    // (2026-05-11), different times of day — matching production's confirmed shape exactly.
    const events: NormalizedEvent[] = [
      event({ txHash: '0xcoalbuyA', contract: memeA, direction: 'inbound', amount: 1000, timestamp: '2026-05-11T02:00:00.000Z' }),
      event({
        txHash: '0xcoalbuyA', contract: ETH_WETH, symbol: 'WETH', tokenDecimals: 18,
        amount: 1, direction: 'outbound', fromAddress: '0xwallet', toAddress: '0xrouter', timestamp: '2026-05-11T02:00:00.000Z',
      }),
      // Exit side priced via a deterministic stablecoin quote (never competes for the ETH/WETH
      // per-token cap) — isolates this fixture to exactly 2 native-ETH requirements (both entries),
      // both sharing the same calendar date, so the (unchanged) per-token cap of 2 lets both through.
      event({ txHash: '0xcoalsellA', contract: memeA, direction: 'outbound', amount: 1000, timestamp: '2026-05-12T00:00:00.000Z' }),
      event({
        txHash: '0xcoalsellA', contract: USDC_ETH, symbol: 'USDC', tokenDecimals: 6,
        amount: 500, direction: 'unknown', timestamp: '2026-05-12T00:00:00.000Z',
      }),
      event({ txHash: '0xcoalbuyB', contract: memeB, direction: 'inbound', amount: 2000, timestamp: '2026-05-11T20:00:00.000Z' }),
      event({
        txHash: '0xcoalbuyB', contract: ETH_WETH, symbol: 'WETH', tokenDecimals: 18,
        amount: 0.5, direction: 'outbound', fromAddress: '0xwallet', toAddress: '0xrouter', timestamp: '2026-05-11T20:00:00.000Z',
      }),
      event({ txHash: '0xcoalsellB', contract: memeB, direction: 'outbound', amount: 2000, timestamp: '2026-05-13T00:00:00.000Z' }),
      event({
        txHash: '0xcoalsellB', contract: USDC_ETH, symbol: 'USDC', tokenDecimals: 6,
        amount: 600, direction: 'unknown', timestamp: '2026-05-13T00:00:00.000Z',
      }),
    ]

    let liveNativeEthCalls = 0
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/coins/ethereum/history')) {
        liveNativeEthCalls += 1
        const date = new URL(url).searchParams.get('date')
        const priceByDate: Record<string, number> = { '11-05-2026': 3500, '12-05-2026': 3550, '13-05-2026': 3600 }
        return new Response(JSON.stringify({ market_data: { current_price: { usd: priceByDate[date ?? ''] ?? 3500 } } }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const goldrush: PriceSourceFn = async () => null
    const realHistoricalSource = buildChainAwareHistoricalPriceSource(goldrush)
    const sources: PriceSources = { primary: realHistoricalSource, fallback: realHistoricalSource }

    const sellTargets = events.filter((e) => e.direction === 'outbound')
    const lotsBefore = buildLots(events, [])
    const { matchedLots: matchedBefore } = matchLotsFIFO(lotsBefore, sellTargets)

    const fullyPricedBefore = 0
    const lookups = await priceLotsForWallet({ normalizedEvents: events, recoveredEvents: [], priceSources: sources })

    const buyA = events.find((e) => e.txHash === '0xcoalbuyA' && e.contract === memeA)!
    const sellA = events.find((e) => e.txHash === '0xcoalsellA' && e.contract === memeA)!
    const buyB = events.find((e) => e.txHash === '0xcoalbuyB' && e.contract === memeB)!

    let fullyPricedAfter = 0
    if (lookups.priceUsdLookup(buyA) != null && lookups.priceUsdLookup(sellA) != null) fullyPricedAfter += 1

    assert.ok(fullyPricedAfter > fullyPricedBefore, 'fullyPricedLots must increase')
    // Both native-ETH requirements (buyA and buyB) share the SAME calendar date (11-05-2026) — this
    // must produce exactly one real request, not two.
    assert.equal(liveNativeEthCalls, 1, 'the two same-date requirements (buyA and buyB, both 11-05-2026) must share exactly one real request')
    assert.ok(lookups.priceUsdLookup(buyA) != null && lookups.priceUsdLookup(buyB) != null, 'both same-date requirements must still resolve their own price')

    const lotsAfter = buildLots(events, [])
    const { matchedLots: matchedAfter } = matchLotsFIFO(lotsAfter, sellTargets)
    assert.deepEqual(matchedAfter, matchedBefore, 'FIFO quantities/matches must stay byte-identical')
  })
})
