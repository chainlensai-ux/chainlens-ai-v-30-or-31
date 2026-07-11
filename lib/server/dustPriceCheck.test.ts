// Unit tests for lib/server/dustPriceCheck.ts — the cheap, cached, orchestration-layer-only
// current-price/liquidity check. Mocks global.fetch (no real network dependency). Run with:
//   npx tsx --test lib/server/dustPriceCheck.test.ts

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCheapCurrentPriceForDustCheck,
  isDeadToken,
  hasLiquidity,
  __resetDustPriceCheckCacheForTest,
} from './dustPriceCheck'

function mockFetchOnce(response: unknown, ok = true): void {
  global.fetch = (async () => new Response(JSON.stringify(response), { status: ok ? 200 : 500 })) as unknown as typeof fetch
}

describe('dustPriceCheck', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    __resetDustPriceCheckCacheForTest()
  })

  it('isDeadToken is true when DexScreener returns no pairs', async () => {
    mockFetchOnce({ pairs: [] })
    try {
      const dead = await isDeadToken('0xdead', 'base')
      assert.equal(dead, true)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('isDeadToken is false when DexScreener finds a real pair', async () => {
    mockFetchOnce({ pairs: [{ chainId: 'base', priceUsd: '1.23', liquidity: { usd: 50000 } }] })
    try {
      const dead = await isDeadToken('0xalive', 'base')
      assert.equal(dead, false)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('isDeadToken is true on a network/HTTP failure (fails open to "dead", never throws)', async () => {
    mockFetchOnce({}, false)
    try {
      const dead = await isDeadToken('0xerr', 'base')
      assert.equal(dead, true)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('hasLiquidity reflects the real liquidity figure from the same cached lookup', async () => {
    mockFetchOnce({ pairs: [{ chainId: 'base', priceUsd: '1.23', liquidity: { usd: 50000 } }] })
    try {
      const liquid = await hasLiquidity('0xalive', 'base', 1000)
      assert.equal(liquid, true)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('hasLiquidity is false for a token with no discoverable market', async () => {
    mockFetchOnce({ pairs: [] })
    try {
      const liquid = await hasLiquidity('0xdead', 'base')
      assert.equal(liquid, false)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('caches the result — a second call for the same token does not call fetch again', async () => {
    let callCount = 0
    global.fetch = (async () => {
      callCount++
      return new Response(JSON.stringify({ pairs: [{ chainId: 'base', priceUsd: '2', liquidity: { usd: 100 } }] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      await getCheapCurrentPriceForDustCheck('0xcached', 'base')
      await getCheapCurrentPriceForDustCheck('0xcached', 'base')
      assert.equal(callCount, 1)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('an unverified chain (no DexScreener slug) resolves to dead/no-liquidity without calling fetch', async () => {
    let called = false
    global.fetch = (async () => { called = true; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    try {
      const result = await getCheapCurrentPriceForDustCheck('0xtoken', 'hyperevm')
      assert.equal(result.hasAnyPriceSource, false)
      assert.equal(called, false)
    } finally {
      global.fetch = originalFetch
    }
  })
})
