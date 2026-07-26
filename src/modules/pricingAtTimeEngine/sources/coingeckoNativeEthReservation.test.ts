// Regression tests for the CoinGecko native-ETH RESERVATION fix — production evidence: two Tier-2
// ETH native requirements, correctly selected/ranked/routed, both returned resolvedPriceUsd: null,
// with "CoinGecko elsewhere reports circuit_open_after_429" — the shared, process-lifetime breaker
// was tripped by an earlier, lower-priority ordinary CoinGecko contract call within the same scan,
// starving the two high-priority native requirements of their own turn.
//
// Run with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/coingeckoNativeEthReservation.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fetchCoingeckoPriceDetailed,
  fetchCoingeckoNativeEthPriceDetailed,
  reserveCoingeckoSlotsForNativeEth,
  coingeckoReservedForNativeEthSlotsRemainingForTest,
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

const HISTORICAL_TIMESTAMP = Date.parse('2024-03-15T00:00:00.000Z')

describe('CoinGecko native-ETH reservation', () => {
  it('1. an ordinary (lower-priority) request that would trigger a 429 is skipped while a reservation is outstanding, and the reserved native requirement gets its own real attempt first', async () => {
    let realCallCount = 0
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      realCallCount += 1
      if (url.includes('/coins/ethereum/history')) {
        return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
      }
      // The ordinary, contract-based endpoint would 429 if it were ever actually called.
      return new Response(JSON.stringify({}), { status: 429 })
    }) as unknown as typeof fetch

    reserveCoingeckoSlotsForNativeEth(1)

    // An ordinary, lower-priority request arrives (simulating a different, non-native token) BEFORE
    // the native requirement gets its turn — it must be skipped, never risking the shared breaker.
    const ordinaryResult = await fetchCoingeckoPriceDetailed('0xsomeoldtoken', 'eth', HISTORICAL_TIMESTAMP)
    assert.equal(ordinaryResult.reason, 'coingecko_reserved_for_native_eth')
    assert.equal(isCoingeckoCircuitOpenForTest(), false, 'the ordinary request must never have made a real call that could trip the breaker')

    // The reserved native requirement now gets its own real attempt — unaffected by the ordinary
    // request's (skipped) presence, and the breaker is still closed for it.
    const nativeResult = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(nativeResult.priceUsd, 3500)
    assert.equal(nativeResult.diagnostic.circuitBreakerStateBeforeCall, false)
    assert.equal(coingeckoReservedForNativeEthSlotsRemainingForTest(), 0, 'the reservation is consumed once the native attempt has its real turn')

    // Now that the reservation is exhausted, an ordinary request resumes normal operation (and would
    // now genuinely 429, in this fixture).
    const ordinaryAfter = await fetchCoingeckoPriceDetailed('0xsomeoldtoken', 'eth', HISTORICAL_TIMESTAMP)
    assert.equal(ordinaryAfter.reason, 'http_429')
    assert.ok(realCallCount >= 2, 'sanity: real calls were actually made once appropriate')
  })

  it('2. no total provider-call increase: the reservation only ever skips a call that would otherwise have been made, never adds one', async () => {
    let callCount = 0
    global.fetch = (async () => {
      callCount += 1
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
    }) as unknown as typeof fetch

    reserveCoingeckoSlotsForNativeEth(1)
    await fetchCoingeckoPriceDetailed('0xsomeoldtoken', 'eth', HISTORICAL_TIMESTAMP) // skipped, 0 real calls
    await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP) // 1 real call

    assert.equal(callCount, 1, 'exactly one real network call — the reservation never adds a call, only ever removes one')
  })

  it('3. native endpoint success parses market_data.current_price.usd correctly', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ market_data: { current_price: { usd: 4321.5 } } }), { status: 200 })) as unknown as typeof fetch

    const result = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)

    assert.equal(result.priceUsd, 4321.5)
    assert.equal(result.reason, null)
    assert.equal(result.diagnostic.responseShapePresent.marketData, true)
    assert.equal(result.diagnostic.responseShapePresent.currentPrice, true)
    assert.equal(result.diagnostic.responseShapePresent.usd, true)
    assert.equal(result.diagnostic.parsedPrice, 4321.5)
    assert.equal(result.diagnostic.failureReason, null)
  })

  it('4. a response missing market_data remains an honest provider miss, never a fabricated price', async () => {
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch

    const result = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)

    assert.equal(result.priceUsd, null)
    assert.equal(result.diagnostic.responseShapePresent.marketData, false)
    assert.equal(result.diagnostic.failureReason, 'history_payload_missing_market_data')
  })

  it('distinguishes the required failure-reason taxonomy explicitly', async () => {
    // coingecko_circuit_open
    reserveCoingeckoSlotsForNativeEth(0)
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 429 })) as unknown as typeof fetch
    const tripped = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(tripped.diagnostic.failureReason, 'coingecko_http_429')
    assert.equal(isCoingeckoCircuitOpenForTest(), true)

    const nextAttempt = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(nextAttempt.diagnostic.failureReason, 'coingecko_circuit_open')
    assert.equal(nextAttempt.diagnostic.requestAttempted, false)

    resetCoingeckoCircuitBreaker()
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 500 })) as unknown as typeof fetch
    const httpError = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(httpError.diagnostic.failureReason, 'coingecko_http_error')

    resetCoingeckoCircuitBreaker()
    global.fetch = (async () => new Response(JSON.stringify({ market_data: {} }), { status: 200 })) as unknown as typeof fetch
    const missingCurrentPrice = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(missingCurrentPrice.diagnostic.failureReason, 'history_payload_missing_usd')

    resetCoingeckoCircuitBreaker()
    global.fetch = (async () => new Response(JSON.stringify({ market_data: { current_price: {} } }), { status: 200 })) as unknown as typeof fetch
    const missingUsdOnly = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(missingUsdOnly.diagnostic.failureReason, 'invalid_price', 'current_price present but usd itself missing/invalid')

    resetCoingeckoCircuitBreaker()
    const invalidTs = await fetchCoingeckoNativeEthPriceDetailed(NaN)
    assert.equal(invalidTs.diagnostic.failureReason, 'invalid_timestamp')
  })
})
