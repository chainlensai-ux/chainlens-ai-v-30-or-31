// Regression tests for the EXPLICIT COINGECKO TIER CONFIGURATION fix — production evidence: the
// native ETH reservation works, same-date requests coalesce to one live call, but that single call
// still receives HTTP 429 — while the runtime always hardcoded api.coingecko.com + x-cg-demo-api-key
// regardless of what tier the configured key actually belongs to.
//
// Run with:
//   npx tsx --test src/modules/pricingAtTimeEngine/sources/coingeckoTierConfig.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveCoingeckoRuntimeConfig,
  fetchCoingeckoPriceDetailed,
  fetchCoingeckoNativeEthPriceDetailed,
  resetCoingeckoCircuitBreaker,
} from './coingecko'

const originalFetch = global.fetch
const originalTier = process.env.COINGECKO_API_TIER
const originalKey = process.env.COINGECKO_API_KEY

beforeEach(() => {
  resetCoingeckoCircuitBreaker()
})

afterEach(() => {
  global.fetch = originalFetch
  if (originalTier === undefined) delete process.env.COINGECKO_API_TIER
  else process.env.COINGECKO_API_TIER = originalTier
  if (originalKey === undefined) delete process.env.COINGECKO_API_KEY
  else process.env.COINGECKO_API_KEY = originalKey
})

const HISTORICAL_TIMESTAMP = Date.parse('2024-03-15T00:00:00.000Z')

describe('CoinGecko explicit tier configuration', () => {
  it('1. demo (and unset, for backward compatibility) selects the public host and demo header', () => {
    delete process.env.COINGECKO_API_TIER
    const unset = resolveCoingeckoRuntimeConfig()
    assert.equal(unset.configuredTier, 'demo')
    assert.equal(unset.selectedBaseUrl, 'https://api.coingecko.com/api/v3')
    assert.equal(unset.selectedHeaderName, 'x-cg-demo-api-key')
    assert.equal(unset.configurationValid, true)

    process.env.COINGECKO_API_TIER = 'demo'
    const explicit = resolveCoingeckoRuntimeConfig()
    assert.equal(explicit.selectedBaseUrl, 'https://api.coingecko.com/api/v3')
    assert.equal(explicit.selectedHeaderName, 'x-cg-demo-api-key')
  })

  it('2. pro selects the pro host and pro header', () => {
    process.env.COINGECKO_API_TIER = 'pro'
    const config = resolveCoingeckoRuntimeConfig()
    assert.equal(config.configuredTier, 'pro')
    assert.equal(config.selectedBaseUrl, 'https://pro-api.coingecko.com/api/v3')
    assert.equal(config.selectedHeaderName, 'x-cg-pro-api-key')
    assert.equal(config.configurationValid, true)
  })

  it('3. an invalid tier fails safely without making a provider call', async () => {
    process.env.COINGECKO_API_TIER = 'enterprise'
    let calls = 0
    global.fetch = (async () => { calls += 1; return new Response(JSON.stringify({}), { status: 200 }) }) as unknown as typeof fetch

    const config = resolveCoingeckoRuntimeConfig()
    assert.equal(config.configurationValid, false)

    const contractResult = await fetchCoingeckoPriceDetailed('0xtoken', 'eth', HISTORICAL_TIMESTAMP)
    assert.equal(contractResult.reason, 'invalid_coingecko_tier_config')

    const nativeResult = await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    assert.equal(nativeResult.reason, 'invalid_coingecko_tier_config')
    assert.equal(nativeResult.diagnostic.failureReason, 'invalid_coingecko_tier_config')

    assert.equal(calls, 0, 'an invalid tier must never trigger a real network call')
  })

  it('4. native and contract routes use the same resolved config (same base URL and header for the same tier)', async () => {
    process.env.COINGECKO_API_TIER = 'pro'
    process.env.COINGECKO_API_KEY = 'test-pro-key'
    const requestedUrls: string[] = []
    const requestedHeaders: string[] = []
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestedUrls.push(url)
      requestedHeaders.push(Object.keys(init?.headers ?? {})[0] ?? '')
      if (url.includes('/coins/ethereum/history')) return new Response(JSON.stringify({ market_data: { current_price: { usd: 3500 } } }), { status: 200 })
      return new Response(JSON.stringify({ prices: [[HISTORICAL_TIMESTAMP, 1.23]] }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchCoingeckoNativeEthPriceDetailed(HISTORICAL_TIMESTAMP)
    await fetchCoingeckoPriceDetailed('0xtoken', 'eth', HISTORICAL_TIMESTAMP)

    assert.ok(requestedUrls.every((u) => u.startsWith('https://pro-api.coingecko.com/api/v3')), 'both routes must hit the same pro base URL')
    assert.ok(requestedHeaders.every((h) => h === 'x-cg-pro-api-key'), 'both routes must use the same pro auth header')
  })

  it('5. no key value appears in any log — only whether a key is configured', () => {
    process.env.COINGECKO_API_KEY = 'super-secret-value-should-never-appear'
    const logs: unknown[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { logs.push(args) }
    try {
      resetCoingeckoCircuitBreaker()
      const config = resolveCoingeckoRuntimeConfig()
      assert.equal(config.keyConfigured, true)
      const serialized = JSON.stringify(logs)
      assert.ok(!serialized.includes('super-secret-value-should-never-appear'), 'the raw key must never appear in any logged output')
    } finally {
      console.warn = originalWarn
    }
  })
})
