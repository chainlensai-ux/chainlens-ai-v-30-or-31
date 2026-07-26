// Tests for src/modules/pricingAtTimeEngine/sources/coingecko.ts's scan-level circuit breaker —
// source-retry-avoidance task's explicit "skip CoinGecko after the first 429 circuit-breaker event"
// requirement. Mocks global.fetch (no real network dependency), same pattern as this codebase's
// other price-source tests. Run with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/coingecko.test.ts

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCoingeckoPriceDetailed, resetCoingeckoCircuitBreaker, isCoingeckoCircuitOpenForTest } from './coingecko'

const originalFetch = global.fetch
const NOW = Date.now()

afterEach(() => {
  global.fetch = originalFetch
  resetCoingeckoCircuitBreaker()
})

function mockFetch(status: number, body: unknown = {}): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchCoingeckoPriceDetailed — circuit breaker opens on the first 429, never waits for a second', () => {
  it('a 429 response opens the circuit immediately', async () => {
    mockFetch(429)
    assert.equal(isCoingeckoCircuitOpenForTest(), false)
    await fetchCoingeckoPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isCoingeckoCircuitOpenForTest(), true, 'a single 429 must open the circuit — never wait for a second confirming one')
  })

  it('once open, a later call short-circuits with zero network calls', async () => {
    const first = mockFetch(429)
    await fetchCoingeckoPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(first.getCallCount(), 1)

    const second = mockFetch(200, { prices: [[Math.floor(NOW / 1000), 1.23]] })
    const result = await fetchCoingeckoPriceDetailed('0xother', 'base', NOW)
    assert.equal(second.getCallCount(), 0, 'once the circuit is open, no further real network call may be made this scan')
    assert.equal(result.priceUsd, null)
    assert.equal(result.reason, 'coingecko_circuit_open_after_429')
  })

  it('resetCoingeckoCircuitBreaker() re-enables real calls for the next scan', async () => {
    mockFetch(429)
    await fetchCoingeckoPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isCoingeckoCircuitOpenForTest(), true)

    resetCoingeckoCircuitBreaker()
    assert.equal(isCoingeckoCircuitOpenForTest(), false)

    const afterReset = mockFetch(200, { prices: [[Math.floor(NOW / 1000), 4.56]] })
    const result = await fetchCoingeckoPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(afterReset.getCallCount(), 1, 'a fresh scan must be able to try CoinGecko again')
    assert.equal(result.priceUsd, 4.56)
  })

  it('a non-429 HTTP error does not open the circuit — only a real 429 does', async () => {
    mockFetch(500)
    await fetchCoingeckoPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isCoingeckoCircuitOpenForTest(), false, 'a generic server error is not rate-limiting evidence')
  })

  it('never fabricates a price — the short-circuited result is the same honest null a real 429 would produce', async () => {
    mockFetch(429)
    await fetchCoingeckoPriceDetailed('0xa', 'base', NOW)
    const result = await fetchCoingeckoPriceDetailed('0xb', 'base', NOW)
    assert.equal(result.priceUsd, null)
  })
})
