import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActiveChainCache } from './activeChainCache'

const WALLET = '0x1111111111111111111111111111111111111111'

test('get() is a miss before anything has been merged', () => {
  const cache = new ActiveChainCache()
  assert.equal(cache.get(WALLET), null)
})

test('merge() then get() returns the merged chains while still fresh', () => {
  const cache = new ActiveChainCache(60_000)
  cache.merge(WALLET, ['base'])
  assert.deepEqual(cache.get(WALLET), ['base'])
})

test('merge() is a union -- calling it again with a different chain never drops the first one', () => {
  const cache = new ActiveChainCache(60_000)
  cache.merge(WALLET, ['base'])
  cache.merge(WALLET, ['arbitrum'])
  const result = cache.get(WALLET)
  assert.ok(result?.includes('base'))
  assert.ok(result?.includes('arbitrum'))
})

test('merge() never duplicates a chain already present', () => {
  const cache = new ActiveChainCache(60_000)
  cache.merge(WALLET, ['base'])
  const merged = cache.merge(WALLET, ['base'])
  assert.deepEqual(merged, ['base'])
})

test('get() is a TTL-gated miss once expired, but getAccumulated() still returns the proven-active chains', () => {
  const cache = new ActiveChainCache(-1) // already-expired TTL
  cache.merge(WALLET, ['base'])
  assert.equal(cache.get(WALLET), null)
  assert.deepEqual(cache.getAccumulated(WALLET), ['base'])
})

test('different wallets are cached independently, never conflated', () => {
  const cache = new ActiveChainCache(60_000)
  cache.merge(WALLET, ['base'])
  cache.merge('0x2222222222222222222222222222222222222222', ['polygon'])
  assert.deepEqual(cache.get(WALLET), ['base'])
  assert.deepEqual(cache.get('0x2222222222222222222222222222222222222222'), ['polygon'])
})

test('wallet address casing is normalized', () => {
  const cache = new ActiveChainCache(60_000)
  cache.merge(WALLET.toUpperCase(), ['base'])
  assert.deepEqual(cache.get(WALLET.toLowerCase()), ['base'])
})

test('singleflight: concurrent calls for the same wallet only invoke compute() once', async () => {
  const cache = new ActiveChainCache(60_000)
  let computeCalls = 0
  const compute = async () => {
    computeCalls += 1
    await new Promise((r) => setTimeout(r, 10))
    return ['base']
  }
  const [a, b, c] = await Promise.all([
    cache.singleflight(WALLET, compute),
    cache.singleflight(WALLET, compute),
    cache.singleflight(WALLET, compute),
  ])
  assert.equal(computeCalls, 1)
  assert.deepEqual(a, ['base'])
  assert.deepEqual(b, ['base'])
  assert.deepEqual(c, ['base'])
})

test('singleflight: a later, non-overlapping call computes fresh again (not permanently deduped)', async () => {
  const cache = new ActiveChainCache(60_000)
  let computeCalls = 0
  const compute = async () => { computeCalls += 1; return ['base'] }
  await cache.singleflight(WALLET, compute)
  await cache.singleflight(WALLET, compute)
  assert.equal(computeCalls, 2)
})

test('singleflight: different wallets never coalesce into the same in-flight computation', async () => {
  const cache = new ActiveChainCache(60_000)
  const calls: string[] = []
  const [a, b] = await Promise.all([
    cache.singleflight(WALLET, async () => { calls.push('a'); return ['base'] }),
    cache.singleflight('0x2222222222222222222222222222222222222222', async () => { calls.push('b'); return ['polygon'] }),
  ])
  assert.equal(calls.length, 2)
  assert.deepEqual(a, ['base'])
  assert.deepEqual(b, ['polygon'])
})
