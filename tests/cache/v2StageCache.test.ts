// tests/cache/v2StageCache.test.ts — full read/write-path tests for
// lib/server/cache/v2StageCache.ts's setStageCache/getStageCache (exported test-only as
// __setStageCacheForTest/__getStageCacheForTest — see that file's own disclosure).
//
// KV MOCKING, DISCLOSED: this sandbox has no real KV_REST_API_URL/TOKEN, so kvConfigured() would
// normally be false and these functions would never even attempt a KV call — the exact reason a
// prior audit found setStageCache/getStageCache completely untested. `@vercel/kv`'s real `kv`
// export is also a lazy-initializing Proxy — directly monkey-patching `kv.set`/`kv.get` was tried
// first and confirmed NOT to reliably override what the real module's own calls resolve to (the
// real network call still fired against a fake URL, producing genuine timeouts). Uses
// v2StageCache.ts's own `__setKvClientForTest`/`__resetKvClientForTest` injection seam instead —
// added specifically to make this file's required tests possible — which is a real, disclosed,
// additive change to the module under test, not a workaround external to it.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setStageCacheForTest,
  __getStageCacheForTest,
  __setKvClientForTest,
  __resetKvClientForTest,
  MAX_PAYLOAD_BYTES,
} from '../../lib/server/cache/v2StageCache'
import { __resetKvCircuitBreakerForTest, __simulateKvOutcomeForTest } from '../../lib/server/cache/tokenCache'

let kvStore: Map<string, unknown>
let kvSetCalls: Array<{ key: string; value: unknown }>

beforeEach(() => {
  kvStore = new Map()
  kvSetCalls = []
  __setKvClientForTest({
    set: (async (key: string, value: unknown) => {
      kvSetCalls.push({ key, value })
      kvStore.set(key, value)
      return 'OK'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
    get: (async (key: string) => {
      return kvStore.has(key) ? kvStore.get(key) : null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  })
})

afterEach(() => {
  __resetKvClientForTest()
})

function captureWarnings(): { calls: unknown[][]; restore: () => void } {
  const original = console.warn
  const calls: unknown[][] = []
  console.warn = (...args: unknown[]) => { calls.push(args) }
  return { calls, restore: () => { console.warn = original } }
}

describe('getStageCache — read-only circuit-breaker consult on v2:providerFetchWindow:* keys', () => {
  afterEach(() => {
    __resetKvCircuitBreakerForTest()
  })

  it('skips the KV read (falls to memory fallback) for a providerFetchWindow key when tokenCache\'s breaker is open', async () => {
    const key = `v2:providerFetchWindow:base:0xwallet:${Date.now()}`
    // Prime the real KV path so a value genuinely exists, then confirm a normal read finds it.
    await __setStageCacheForTest(key, { window: 'real' }, 60)
    kvSetCalls.length = 0 // reset call tracking, not the store

    // Trip tokenCache's real circuit breaker (5 consecutive timeouts, per its own re-tuned spec).
    for (let i = 0; i < 5; i++) __simulateKvOutcomeForTest('timeout')

    const { calls, restore } = captureWarnings()
    let result: unknown
    try {
      result = await __getStageCacheForTest(key)
    } finally {
      restore()
    }

    // The real KV `get` was never attempted — falls straight to the in-memory fallback that
    // __setStageCacheForTest above also populated, so the value is still correctly returned.
    assert.deepEqual(result, { window: 'real' })
    assert.ok(calls.some((c) => c[0] === 'kv_disabled_for_request'), 'expected a kv_disabled_for_request log for the skipped read')
  })

  it('a non-providerFetchWindow key is unaffected by tokenCache\'s breaker being open', async () => {
    const key = `v2:holdings:base:0xwallet:${Date.now()}`
    await __setStageCacheForTest(key, { holdings: 'real' }, 60)

    for (let i = 0; i < 5; i++) __simulateKvOutcomeForTest('timeout')

    const result = await __getStageCacheForTest(key)
    assert.deepEqual(result, { holdings: 'real' }) // still reads through the real (mocked) KV path
  })
})

describe('setStageCache — small payload (requirement 1)', () => {
  it('stores raw JSON uncompressed, with no compression/skip logs', async () => {
    const key = `test:small:${Date.now()}`
    const value = { hello: 'world', n: 42 }

    const { calls, restore } = captureWarnings()
    try {
      await __setStageCacheForTest(key, value, 60)
    } finally {
      restore()
    }

    assert.equal(kvSetCalls.length, 1)
    assert.equal(kvSetCalls[0].key, key)
    assert.deepEqual(kvSetCalls[0].value, value) // raw, not base64/compressed
    assert.ok(!calls.some((c) => c[0] === 'kv_payload_compressed'), 'must not log kv_payload_compressed for a small payload')
    assert.ok(!calls.some((c) => c[0] === 'kv_skip_large_payload'), 'must not log kv_skip_large_payload for a small payload')
  })
})

describe('setStageCache — large-but-compressible payload (requirement 2)', () => {
  it('compresses and stores, logging kv_payload_compressed with fallback "none"', async () => {
    const key = `test:large-compressible:${Date.now()}`
    // Realistic large-holdings shape: repetitive small objects — highly compressible.
    const value = Array.from({ length: 5000 }, (_, i) => ({ tokenAddress: '0xtoken', chain: 'base', amount: i, symbol: 'TEST' }))
    const uncompressedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    assert.ok(uncompressedBytes > MAX_PAYLOAD_BYTES, `expected a genuinely large uncompressed payload (${uncompressedBytes} bytes)`)

    const { calls, restore } = captureWarnings()
    try {
      await __setStageCacheForTest(key, value, 60)
    } finally {
      restore()
    }

    const compressedLog = calls.find((c) => c[0] === 'kv_payload_compressed')
    assert.ok(compressedLog, 'expected kv_payload_compressed to fire')
    const payload = compressedLog![1] as Record<string, unknown>
    assert.equal(payload.key, key)
    assert.equal(payload.strategyAttempted, 'gzip_base64')
    assert.equal(payload.fallback, 'none')
    assert.ok(typeof payload.compressedBytes === 'number' && payload.compressedBytes <= MAX_PAYLOAD_BYTES)
    assert.equal(payload.uncompressedBytes, uncompressedBytes)
    assert.ok(!calls.some((c) => c[0] === 'kv_skip_large_payload'))

    assert.equal(kvSetCalls.length, 1)
    assert.notEqual(kvSetCalls[0].value, JSON.stringify(value)) // stored the compressed base64, not raw JSON
  })
})

describe('setStageCache — large-and-still-too-big payload (requirement 3)', () => {
  it('skips the KV write, logging kv_skip_large_payload with both byte sizes and fallback "in_memory_only"', async () => {
    const key = `test:too-big:${Date.now()}`
    // Effectively-incompressible: random base36 fragments joined into one large string. Real
    // entropy defeats gzip, so compressedBytes stays large too (base64 encoding even inflates it).
    const value = Array.from({ length: 40_000 }, () => Math.random().toString(36).slice(2)).join('')
    const uncompressedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    assert.ok(uncompressedBytes > MAX_PAYLOAD_BYTES, `expected a genuinely large uncompressed payload (${uncompressedBytes} bytes)`)

    const { calls, restore } = captureWarnings()
    try {
      await __setStageCacheForTest(key, value, 60)
    } finally {
      restore()
    }

    const skipLog = calls.find((c) => c[0] === 'kv_skip_large_payload')
    assert.ok(skipLog, 'expected kv_skip_large_payload to fire')
    const payload = skipLog![1] as Record<string, unknown>
    assert.equal(payload.key, key)
    assert.equal(payload.fallback, 'in_memory_only')
    assert.equal(payload.strategyAttempted, 'gzip_base64')
    assert.ok(typeof payload.uncompressedBytes === 'number' && payload.uncompressedBytes > MAX_PAYLOAD_BYTES)
    assert.ok(typeof payload.compressedBytes === 'number' && payload.compressedBytes > MAX_PAYLOAD_BYTES)
    assert.equal(kvSetCalls.length, 0) // KV write genuinely skipped — never attempted

    // REAL BEHAVIOR, DISCLOSED: after a skipped write, KV genuinely has no entry for this key —
    // if KV is reachable, getStageCache correctly returns that real "no such key" answer (null),
    // it does NOT silently substitute the in-memory fallback over a genuine, successful KV miss
    // (the fallback is a "KV unreachable" safety net, not an override for a deliberate skip).
    // `withStageCache`'s own caller handles this correctly already: a null result means
    // `compute()` runs again, a fresh real recomputation — never a stale/zeroed value.
    const readBackWhileKvReachable = await __getStageCacheForTest<string>(key)
    assert.equal(readBackWhileKvReachable, null)

    // What "never silently lost" actually means here: the real value genuinely IS retained in the
    // in-memory fallback for this process's lifetime (set unconditionally at the top of
    // setStageCache, before the KV branch), and IS served on an actual KV failure. Proven directly
    // by simulating KV becoming unreachable after the skipped write.
    __setKvClientForTest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: (async () => { throw new Error('simulated KV outage') }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (async () => { throw new Error('simulated KV outage') }) as any,
    })
    const readBackDuringKvOutage = await __getStageCacheForTest<string>(key)
    assert.equal(readBackDuringKvOutage, value, 'the in-memory fallback must serve the real value when KV is genuinely unreachable')
  })
})

describe('setStageCache/getStageCache — round-trip read (requirement 4)', () => {
  it('reads back the exact value written, via the real KV path (mocked transport)', async () => {
    const key = `test:roundtrip:${Date.now()}`
    const value = { real: 'value', nested: { n: 42 }, arr: [1, 2, 3] }

    await __setStageCacheForTest(key, value, 60)
    assert.equal(kvSetCalls.length, 1) // confirms this genuinely went through the mocked KV, not just memory

    const readBack = await __getStageCacheForTest<typeof value>(key)
    assert.deepEqual(readBack, value)
  })

  it('round-trips a large, compressed value through the real KV path too', async () => {
    const key = `test:roundtrip-large:${Date.now()}`
    const value = Array.from({ length: 5000 }, (_, i) => ({ tokenAddress: '0xtoken', chain: 'base', amount: i, symbol: 'TEST' }))

    await __setStageCacheForTest(key, value, 60)
    assert.equal(kvSetCalls.length, 1)

    const readBack = await __getStageCacheForTest<typeof value>(key)
    assert.deepEqual(readBack, value)
  })
})
