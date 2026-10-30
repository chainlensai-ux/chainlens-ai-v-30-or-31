// Wallet scanner historical pricing (lib/server/walletSnapshot.ts): a GoldRush 429 or 5xx is never cached
// as "no price"; a real non-transient answer keeps its existing caching.
//   npx tsx --test tests/wallet-snapshot-goldrush-rate-limit.test.ts
import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, test } from 'node:test'

type Snapshot = typeof import('../lib/server/walletSnapshot')
let fetchPrice: Snapshot['__fetchGoldrushHistoricalPriceForTest']
let clearCache: Snapshot['__clearGoldrushPriceAtTimeCacheForTest']
// The module reads the key when it loads, so set it before importing.
before(async () => {
  process.env.GOLDRUSH_API_KEY ||= 'test-key'
  const snapshot = await import('../lib/server/walletSnapshot')
  fetchPrice = snapshot.__fetchGoldrushHistoricalPriceForTest
  clearCache = snapshot.__clearGoldrushPriceAtTimeCacheForTest
})

const TOKEN = '0x4200000000000000000000000000000000000006'
const realFetch = globalThis.fetch
const priced = () => Response.json({ data: [{ prices: [{ date: '2026-10-01', price: 2500 }] }] })
let replies: Array<() => Response> = []
let calls = 0
beforeEach(() => {
  clearCache(); calls = 0
  globalThis.fetch = (async () => { const reply = replies[Math.min(calls, replies.length - 1)]; calls++; return reply() }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

for (const status of [429, 503]) {
  test(`a ${status} is an error that is not cached: the same token-day is asked again`, async () => {
    replies = [() => new Response('{}', { status }), priced]
    const reqCache = new Map<string, number | null>()
    const first = await fetchPrice('base', TOKEN, '2026-10-01T12:00:00Z', reqCache)
    assert.deepEqual({ price: first.priceUsd, error: first.error }, { price: null, error: true })
    assert.equal(reqCache.size, 0)
    const second = await fetchPrice('base', TOKEN, '2026-10-01T12:00:00Z', reqCache)
    assert.equal(second.priceUsd, 2500)
    assert.equal(calls, 2)
  })
}

test('a non-transient failure (404) keeps the existing negative caching', async () => {
  replies = [() => new Response('{}', { status: 404 }), priced]
  const reqCache = new Map<string, number | null>()
  assert.equal((await fetchPrice('base', TOKEN, '2026-10-01T12:00:00Z', reqCache)).priceUsd, null)
  assert.equal(calls, 1)
  const again = await fetchPrice('base', TOKEN, '2026-10-01T12:00:00Z', reqCache)
  assert.equal(again.cacheHit, true)
  assert.equal(calls, 1)
})
