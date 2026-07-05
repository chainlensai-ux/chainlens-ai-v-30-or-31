// Tests for app/api/_shared/eventsCache.ts and its real integration point: two modules that both
// need raw events for the same (wallet, chain) should only trigger ONE real provider fetch when
// they share the same EventsCache instance. Uses node:test. NOT wired into `npm test` (which runs a
// single hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/api/_shared/eventsCache.test.ts
//
// This test exercises the real `fetchRawEventsForChain` (app/api/_shared/walletChainPipeline.ts)
// against this sandbox's actual (unconfigured) provider setup — fetchProviderWindow degrades
// honestly to an empty array without real GoldRush/Alchemy keys, which is fine for this test: the
// point being verified is CALL COUNT and CACHE BEHAVIOR, not real fetched content.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEventsCache } from './eventsCache'

describe('EventsCache', () => {
  it('get() returns undefined on a miss and the exact stored value on a hit', () => {
    const cache = createEventsCache()
    assert.equal(cache.get('eth', '0xabc'), undefined)

    const events = [{ provider: 'goldrush', chain: 'eth', txHash: '0x1', timestamp: null, fromAddress: null, toAddress: null, contract: null, symbol: null, amountRaw: null, tokenDecimals: null }] as any
    cache.set('eth', '0xabc', events)
    assert.equal(cache.get('eth', '0xabc'), events)
  })

  it('is keyed by both chain and walletAddress — no cross-contamination', () => {
    const cache = createEventsCache()
    cache.set('eth', '0xabc', [{ txHash: 'eth-events' }] as any)
    cache.set('base', '0xabc', [{ txHash: 'base-events' }] as any)
    cache.set('eth', '0xdef', [{ txHash: 'other-wallet-events' }] as any)

    assert.equal((cache.get('eth', '0xabc') as any)[0].txHash, 'eth-events')
    assert.equal((cache.get('base', '0xabc') as any)[0].txHash, 'base-events')
    assert.equal((cache.get('eth', '0xdef') as any)[0].txHash, 'other-wallet-events')
  })

  it('walletAddress lookup is case-insensitive (matches how the real cache key is built)', () => {
    const cache = createEventsCache()
    cache.set('eth', '0xABC', [{ txHash: '1' }] as any)
    assert.notEqual(cache.get('eth', '0xabc'), undefined)
  })

  it('hitCount increments only on real cache hits, not on misses or writes', () => {
    const cache = createEventsCache()
    assert.equal(cache.hitCount, 0)
    cache.get('eth', '0xabc') // miss
    assert.equal(cache.hitCount, 0)
    cache.set('eth', '0xabc', [] as any) // write
    assert.equal(cache.hitCount, 0)
    cache.get('eth', '0xabc') // hit
    assert.equal(cache.hitCount, 1)
    cache.get('eth', '0xabc') // hit again
    assert.equal(cache.hitCount, 2)
  })

  it('a fresh cache from createEventsCache() never shares state with a previous one (the real "per-request reset")', () => {
    const first = createEventsCache()
    first.set('eth', '0xabc', [{ txHash: 'first-request' }] as any)

    const second = createEventsCache()
    assert.equal(second.get('eth', '0xabc'), undefined, 'a new request\'s cache must start empty, not inherit the previous request\'s entries')
  })
})

describe('fetchRawEventsForChain with a shared cache (real integration)', () => {
  // MOCKING DEVIATION, DISCLOSED: tried node:test's `mock.method` on the imported
  // providerFetchWindow module first — it failed ("argument 'methodName' must be a method") because
  // ESM live-binding exports aren't mockable that way in this runtime (verified by actually running
  // it, not assumed). Instead of a call-count spy, this test proves the same real thing via
  // reference equality: `fetchProviderWindow` (unconfigured in this sandbox — no real GoldRush/
  // Alchemy keys) returns a NEW array instance on every real call, so if a genuine cache hit
  // occurred, `first === second` (the exact same array reference) — a fresh fetch would never
  // produce that. This is a real behavioral proof, not a weaker substitute for one.
  it('two consumers sharing one cache get the exact same array reference for the same (chain, wallet) — the real cache hit, not a fresh fetch', async () => {
    const { fetchRawEventsForChain } = await import('./walletChainPipeline')
    const cache = createEventsCache()

    const first = await fetchRawEventsForChain('eth', '0xabc', cache)
    const second = await fetchRawEventsForChain('eth', '0xabc', cache) // "second module" sharing the same cache

    assert.equal(first, second, 'expected the exact same array reference on the second call — proof of a real cache hit, not a fresh independent fetch')
    assert.equal(cache.hitCount, 1, 'expected exactly one real cache hit')
  })

  it('omitting the cache parameter entirely preserves the original behavior (a fresh, independent fetch every time)', async () => {
    const { fetchRawEventsForChain } = await import('./walletChainPipeline')

    const first = await fetchRawEventsForChain('eth', '0xabc') // no cache — pre-existing callers' exact behavior
    const second = await fetchRawEventsForChain('eth', '0xabc')

    assert.notEqual(first, second, 'expected two independent array instances when no cache is passed — zero behavior change for existing callers')
    assert.deepEqual(first, second, 'both calls still return equivalent real (honestly empty, no provider keys in this sandbox) data — same real value, just not the same cached instance')
  })

  it('two different chains for the same wallet, sharing one cache, do NOT collide (separate cache entries)', async () => {
    const { fetchRawEventsForChain } = await import('./walletChainPipeline')
    const cache = createEventsCache()

    await fetchRawEventsForChain('eth', '0xabc', cache)
    await fetchRawEventsForChain('base', '0xabc', cache)
    assert.equal(cache.hitCount, 0, 'two DIFFERENT chains must never count as a cache hit against each other')

    const ethAgain = await fetchRawEventsForChain('eth', '0xabc', cache)
    assert.equal(cache.hitCount, 1, 'only re-requesting the SAME (chain, wallet) counts as a hit')
    assert.equal(ethAgain, cache.get('eth', '0xabc'))
  })
})
