// Regression tests for the NATIVE ETH HISTORY DATE-COALESCING fix — production evidence: the
// reservation worked, both selected Tier-2 ETH requirements attempted the native endpoint, the
// breaker was CLOSED before both calls, both requested `ethereum history` for the SAME date
// (11-05-2026), and both received a real HTTP 429 — two redundant live requests for identical data.
// coverage stayed 5 -> 5.
//
// Run with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/coingeckoNativeEthDateCoalescing.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchCoingeckoNativeEthPriceDetailed,
  getNativeEthHistoryCoalescingDiagnostics,
  resetCoingeckoCircuitBreaker,
  isCoingeckoCircuitOpenForTest,
} from './coingecko'

const originalFetch = global.fetch

beforeEach(() => {
  resetCoingeckoCircuitBreaker()
})

afterEach(() => {
  global.fetch = originalFetch
})

const SAME_DAY_A = Date.parse('2026-05-11T02:00:00.000Z')
const SAME_DAY_B = Date.parse('2026-05-11T20:00:00.000Z') // same calendar date (UTC), different tx time
const OTHER_DAY = Date.parse('2026-05-12T02:00:00.000Z')

describe('CoinGecko native-ETH history — same-date coalescing', () => {
  it('1. two requirements for the same date produce exactly one live request', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
    }) as unknown as typeof fetch

    const [a, b] = await Promise.all([
      fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A),
      fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_B),
    ])

    assert.equal(liveCalls, 1, 'exactly one real HTTP request for two requirements sharing the same calendar date')
    assert.equal(a.priceUsd, 3500)
    assert.equal(b.priceUsd, 3500)

    const diag = getNativeEthHistoryCoalescingDiagnostics()
    assert.equal(diag.nativeEthHistoryUniqueDateRequests, 1)
    assert.equal(diag.nativeEthHistoryLiveCalls, 1)
    assert.equal(diag.nativeEthHistoryCoalescedHits, 1)
  })

  it('2. both requirements consume the exact same successful price', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ market_data: { current_price: { usd: 4200.5 } } }), { status: 200 })) as unknown as typeof fetch

    const a = await fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A)
    const b = await fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_B)

    assert.equal(a.priceUsd, 4200.5)
    assert.equal(b.priceUsd, 4200.5)
    assert.equal(a.priceUsd, b.priceUsd)
  })

  it('3. a shared 429 produces one live request and two honest misses — never retried, never converted into a price', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({}), { status: 429 })
    }) as unknown as typeof fetch

    const [a, b] = await Promise.all([
      fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A),
      fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_B),
    ])

    assert.equal(liveCalls, 1, 'the second requirement must never re-attempt a request this scan already knows is a 429')
    assert.equal(a.priceUsd, null)
    assert.equal(b.priceUsd, null)
    assert.equal(a.diagnostic.failureReason, 'coingecko_http_429')
    assert.equal(b.diagnostic.failureReason, 'coingecko_http_429')
    assert.equal(isCoingeckoCircuitOpenForTest(), true)

    const diag = getNativeEthHistoryCoalescingDiagnostics()
    assert.equal(diag.nativeEthHistoryLiveCalls, 1)
    assert.equal(diag.nativeEthHistoryCoalescedHits, 1)
  })

  it('4. different dates remain separate — never share a result', async () => {
    let liveCalls = 0
    const pricesByDate: Record<string, number> = { '11-05-2026': 3500, '12-05-2026': 3600 }
    global.fetch = (async (input: RequestInfo | URL) => {
      liveCalls += 1
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const date = new URL(url).searchParams.get('date') ?? ''
      return new Response(JSON.stringify({ market_data: { current_price: { usd: pricesByDate[date] } } }), { status: 200 })
    }) as unknown as typeof fetch

    const sameDate = await fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A)
    const otherDate = await fetchCoingeckoNativeEthPriceDetailed(OTHER_DAY)

    assert.equal(liveCalls, 2, 'two genuinely different dates must each get their own real request')
    assert.equal(sameDate.priceUsd, 3500)
    assert.equal(otherDate.priceUsd, 3600)

    const diag = getNativeEthHistoryCoalescingDiagnostics()
    assert.equal(diag.nativeEthHistoryUniqueDateRequests, 2)
    assert.equal(diag.nativeEthHistoryCoalescedHits, 0)
  })

  it('5. no provider-call increase: three requirements sharing one date still produce exactly one live call', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
    }) as unknown as typeof fetch

    await Promise.all([
      fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A),
      fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_B),
      fetchCoingeckoNativeEthPriceDetailed(Date.parse('2026-05-11T23:59:00.000Z')),
    ])

    assert.equal(liveCalls, 1)
  })

  it('the cache resets at the existing per-scan boundary (resetCoingeckoCircuitBreaker)', async () => {
    let liveCalls = 0
    global.fetch = (async () => {
      liveCalls += 1
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A)
    resetCoingeckoCircuitBreaker()
    await fetchCoingeckoNativeEthPriceDetailed(SAME_DAY_A)

    assert.equal(liveCalls, 2, 'a new scan must not reuse the previous scan\'s cached result for the same date')
  })
})
