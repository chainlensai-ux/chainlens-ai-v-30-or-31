// Tests for src/pipeline/providers/geckoTerminalPriceSource.ts's deterministic no-pool cache —
// source-retry-avoidance task's explicit "skip GeckoTerminal after deterministic no-pool evidence"
// requirement. Mocks global.fetch (no real network dependency). Run with:
//   npx tsx --test src/pipeline/providers/geckoTerminalPriceSource.test.ts

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGeckoTerminalPriceDetailed, resetGeckoTerminalNoPoolCache, isKnownGeckoTerminalNoPool } from './geckoTerminalPriceSource'

const originalFetch = global.fetch
const NOW = Date.now()

afterEach(() => {
  global.fetch = originalFetch
  resetGeckoTerminalNoPoolCache()
})

function mockPoolsResponse(pools: unknown[]): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response(JSON.stringify({ data: pools }), { status: 200 })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchGeckoTerminalPriceDetailed — deterministic no-pool cache (never retries a token proven to have no real pool)', () => {
  it('a token with zero pools is recorded as a deterministic no-pool result', async () => {
    mockPoolsResponse([])
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), false)
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), true)
  })

  it('a later lookup for the SAME token this scan makes zero real network calls', async () => {
    const first = mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(first.getCallCount(), 1)

    const second = mockPoolsResponse([{ attributes: { address: '0xpool', reserve_in_usd: '50000' } }])
    const result = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW - 3_600_000)
    assert.equal(second.getCallCount(), 0, 'a token already proven to have no pool must never trigger a real network call again this scan')
    assert.equal(result.priceUsd, null)
    assert.equal(result.reason, 'no_pool_found')
  })

  it('a DIFFERENT token is never affected by another token\'s no-pool cache entry', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken-a', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken-a'), true)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken-b'), false, 'the no-pool result must be scoped to its own token, never applied to a different one')
  })

  it('the same token on a DIFFERENT chain is not affected — cache is scoped per (chain, token)', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), true)
    assert.equal(isKnownGeckoTerminalNoPool('eth', '0xtoken'), false)
  })

  it('resetGeckoTerminalNoPoolCache() clears the cache for the next scan', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), true)

    resetGeckoTerminalNoPoolCache()
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), false, 'a new scan must be free to re-check a token that may have a pool by now')
  })

  it('never fabricates a price — the cached short-circuit result matches a real no-pool response', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    const cached = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(cached.priceUsd, null)
    assert.equal(cached.reason, 'no_pool_found')
  })
})
