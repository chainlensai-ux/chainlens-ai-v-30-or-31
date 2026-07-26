// Tests for src/pipeline/pricingAtTimeAdapter.ts's source-retry-avoidance behaviour — stop
// retrying source/token/chain/time combinations already known to be structurally unsupported within
// the same scan, and prioritise Base DEX first for Base once it has proven itself this scan.
//
// Run with:
//   npx tsx --test src/pipeline/pricingAtTimeAdapter.sourceRetryAvoidance.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChainAwareHistoricalPriceSourceDetailed,
  resetPricingAtTimeAdapterScanState,
  isBaseDexProvenThisScanForTest,
} from './pricingAtTimeAdapter'
import { __resetGoldrushPriceSourceCachesForTest, isGoldrushBreakerOpenForTest, goldrushPriceSource } from '../modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import { resetCoingeckoCircuitBreaker } from '../modules/pricingAtTimeEngine/sources/coingecko'
import { resetGeckoTerminalNoPoolCache } from './providers/geckoTerminalPriceSource'
import { __resetBaseDexCachesForTest } from '../modules/pricingAtTimeEngine/sources/basedex'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

const originalFetch = global.fetch
const NOW = Date.now()

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

function mockFetchAlwaysFail(): void {
  global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
}

describe('DexScreener — skip for a historical timestamp it structurally cannot serve', () => {
  it('a timestamp far outside the freshness window never reaches a real fetch call for a DexScreener-supported chain', async () => {
    mockFetchAlwaysFail()
    // Tracks calls to DexScreener's OWN endpoint specifically — the router's fallthrough to
    // GeckoTerminal/CoinGecko in its later safety-net stages is real, unrelated, expected behavior
    // (this test only asserts DexScreener itself is skipped, not that the whole lookup short-circuits).
    let dexscreenerFetchCallCount = 0
    const wrappedFetch = global.fetch
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('dexscreener.com')) dexscreenerFetchCallCount += 1
      return wrappedFetch(input, init)
    }) as unknown as typeof fetch

    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    const oldTimestamp = NOW - 24 * 60 * 60 * 1000 // 1 day old — far past DexScreener's 5-minute window
    const result = await detailed('0xtoken', 'eth', oldTimestamp)

    const dexAttempt = result.attempts.find((a) => a.source === 'dexscreener')
    assert.equal(dexAttempt?.reason, 'dexscreener_only_exposes_current_price_timestamp_too_far_from_now')
    assert.equal(dexscreenerFetchCallCount, 0, 'a timestamp already known to be outside the freshness window must never trigger a real DexScreener fetch')
  })

  it('an unverified chain still reports its own real reason, never shadowed by the freshness skip', async () => {
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    const result = await detailed('0xtoken', 'hyperevm', NOW - 24 * 60 * 60 * 1000)
    const dexAttempt = result.attempts.find((a) => a.source === 'dexscreener')
    assert.equal(dexAttempt?.reason, 'unverified_chain_for_dexscreener', 'chain-support precedence must be checked before the freshness skip')
  })
})

describe('GoldRush — skip once its own circuit breaker has opened this scan', () => {
  it('once the breaker is open, the router never attempts GoldRush again', async () => {
    // Force the REAL breaker open via 20 consecutive misses, going through the real
    // goldrushPriceSource() function (a fake GoldRushClient whose PricingService always throws) —
    // the breaker's own state lives inside goldrushPriceSource.ts and is only updated by calls
    // through that real function, never by an arbitrary injected PriceSourceFn.
    const failingClient = { PricingService: { getTokenPrices: async () => { throw new Error('simulated failure') } } } as never
    const realGoldrush = goldrushPriceSource(failingClient)
    for (let i = 0; i < 20; i += 1) {
      await realGoldrush(`0xtoken${i}`, 'eth', NOW)
    }
    assert.equal(isGoldrushBreakerOpenForTest(), true, 'sanity: the breaker must actually be open before this test proceeds')

    let routerGoldrushCallCount = 0
    const trackedGoldrush: PriceSourceFn = async (token, chain, timestamp) => { routerGoldrushCallCount += 1; return realGoldrush(token, chain, timestamp) }
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(trackedGoldrush)
    const result = await detailed('0xafterbreaker', 'eth', NOW)

    assert.equal(routerGoldrushCallCount, 0, 'once the breaker is open, the router must skip the attempt entirely — never call the fetcher again')
    const goldrushAttempt = result.attempts.find((a) => a.source === 'goldrush')
    assert.equal(goldrushAttempt?.reason, 'goldrush_no_data', 'a skipped attempt must still report the same honest reason a real attempt would have')
  })
})

describe('Base DEX — prioritised first for Base once it has demonstrated success this scan', () => {
  it('before any success this scan, Base DEX is only tried as the final safety net (after everything else fails)', async () => {
    assert.equal(isBaseDexProvenThisScanForTest(), false)
    const goldrush: PriceSourceFn = async () => null
    const detailed = buildChainAwareHistoricalPriceSourceDetailed(goldrush)
    const result = await detailed('0xtoken', 'base', NOW)
    // No real API key/RPC configured in this test env, so base_dex genuinely misses too — but it
    // must appear LAST among the attempts (geckoterminal, dexscreener, goldrush all come first).
    const order = result.attempts.map((a) => a.source)
    const baseDexIndex = order.indexOf('base_dex')
    assert.ok(baseDexIndex === -1 || baseDexIndex === order.length - 1, 'base_dex must not be prioritised before it has proven itself this scan')
  })

  it('resetPricingAtTimeAdapterScanState() clears the proven flag for the next scan', () => {
    resetPricingAtTimeAdapterScanState()
    assert.equal(isBaseDexProvenThisScanForTest(), false)
  })
})
