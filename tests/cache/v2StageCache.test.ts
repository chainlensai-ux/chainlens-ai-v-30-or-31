import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setStageCacheForTest,
  __getStageCacheForTest,
  __setKvClientForTest,
  __resetKvClientForTest,
  withStageCache,
  resolveEffectiveTtl,
} from '../../lib/server/cache/v2StageCache'

let kvStore: Map<string, unknown>
let kvSetCalls: Array<{ key: string; value: unknown; opts?: { ex?: number } }>
let kvGetCalls: string[]

beforeEach(() => {
  kvStore = new Map()
  kvSetCalls = []
  kvGetCalls = []
  __setKvClientForTest({
    set: (async (key: string, value: unknown, opts?: { ex?: number }) => {
      kvSetCalls.push({ key, value, opts })
      kvStore.set(key, value)
      return 'OK'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    get: (async (key: string) => {
      kvGetCalls.push(key)
      return kvStore.has(key) ? kvStore.get(key) : null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  })
})

afterEach(() => {
  __resetKvClientForTest()
})

describe('v2StageCache simple KV layer', () => {
  it('directly writes the full value to one key', async () => {
    const key = `test:simple-set:${Date.now()}`
    const value = { holdings: Array.from({ length: 1000 }, (_, i) => ({ token: '0xabc', amount: String(i) })) }

    await __setStageCacheForTest(key, value, 60)

    assert.equal(kvSetCalls.length, 1)
    assert.deepEqual(kvSetCalls[0], { key, value, opts: { ex: 60 } })
    assert.equal(kvSetCalls.some((call) => call.key.includes(':chunk:')), false)
  })

  it('directly reads the stored value without fallback substitution', async () => {
    const key = `test:simple-get:${Date.now()}`
    const value = { providerWindow: [{ chain: 'base', events: [1, 2, 3] }] }
    kvStore.set(key, value)

    const readBack = await __getStageCacheForTest<typeof value>(key)

    assert.deepEqual(readBack, value)
    assert.deepEqual(kvGetCalls, [key])
  })

  it('does not skip large payload writes', async () => {
    const key = `test:large:${Date.now()}`
    const value = Array.from({ length: 5000 }, (_, i) => ({ tokenAddress: '0xtoken', chain: 'base', amount: i, symbol: 'TEST' }))

    await __setStageCacheForTest(key, value, 60)

    assert.equal(kvSetCalls.length, 1)
    assert.deepEqual(kvSetCalls[0].value, value)
  })

  it('propagates KV set failures without retrying', async () => {
    let attempts = 0
    __setKvClientForTest({
      get: (async () => null) as never,
      set: (async () => { attempts++; throw new Error('set failed') }) as never,
    })

    await assert.rejects(() => __setStageCacheForTest('test:fail', { ok: false }, 60), /set failed/)
    assert.equal(attempts, 1)
  })
})

// DEGRADED-RESULT-NOT-CACHED-AS-HEALTHY, DISCLOSED (Wallet Scanner graph/API support audit task):
// `shouldCache` is a new, optional, backward-compatible predicate on withStageCache's options — see
// its own header in v2StageCache.ts. These tests cover both the new opt-in behavior and that every
// existing (no-predicate) caller keeps writing every successful result exactly as before.
describe('withStageCache shouldCache predicate', () => {
  it('does not write to KV when shouldCache returns false for a degraded result', async () => {
    const key = `test:shouldCache-skip:${Date.now()}`
    const degraded = { providerStatus: 'provider_unavailable', rawEvents: [] as unknown[] }

    const result = await withStageCache(key, 30, async () => degraded, {
      shouldCache: (r) => r.providerStatus !== 'provider_unavailable',
    })

    assert.deepEqual(result, degraded, 'the caller still gets the real compute() result')
    assert.equal(kvSetCalls.length, 0, 'a degraded result must never be written to the shared cache')
    assert.equal(kvStore.has(key), false)
  })

  it('still writes to KV when shouldCache returns true for a healthy result', async () => {
    const key = `test:shouldCache-write:${Date.now()}`
    const healthy = { providerStatus: 'ok', rawEvents: [{ txHash: '0x1' }] }

    const result = await withStageCache(key, 30, async () => healthy, {
      shouldCache: (r) => r.providerStatus !== 'provider_unavailable',
    })

    assert.deepEqual(result, healthy)
    assert.equal(kvSetCalls.length, 1)
    // Dev-warm-mode (resolveEffectiveTtl) may widen the TTL outside NODE_ENV=production — same real
    // effective TTL the write actually used, never hardcoded, so this test is environment-agnostic.
    assert.deepEqual(kvSetCalls[0], { key, value: healthy, opts: { ex: resolveEffectiveTtl(30, process.env.NODE_ENV) } })
  })

  it('a caller that omits shouldCache keeps writing every successful result, unchanged', async () => {
    const key = `test:shouldCache-omitted:${Date.now()}`
    const value = { anything: 'no predicate supplied' }

    await withStageCache(key, 30, async () => value)

    assert.equal(kvSetCalls.length, 1)
    assert.deepEqual(kvSetCalls[0].value, value)
  })
})
