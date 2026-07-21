// Tests for lib/server/cache/v2StageCache.ts's dev-only KV warm mode. Uses node:test, same
// convention as the other module test files this session. Only tests resolveEffectiveTtl() in
// isolation (a pure function) rather than withStageCache() itself, since the latter depends on a
// real KV client this sandbox has no credentials for — testing the pure TTL-selection logic
// directly avoids needing to mock that client while still covering the actual behavior change.
// Run directly with:
//   npx tsx --test lib/server/cache/v2StageCache.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTtl, createHoldingsKvWriter, createProviderWindowKvWriter } from './v2StageCache'

describe('resolveEffectiveTtl — production behavior unchanged', () => {
  it('returns the caller-supplied ttlSeconds exactly, untouched, when NODE_ENV is production', () => {
    assert.equal(resolveEffectiveTtl(30, 'production'), 30)
    assert.equal(resolveEffectiveTtl(45, 'production'), 45)
    assert.equal(resolveEffectiveTtl(5, 'production'), 5) // even a tiny TTL is never widened in prod
  })
})

describe('resolveEffectiveTtl — dev-only KV warm mode', () => {
  it('widens a short TTL to 600s (10 minutes) when NODE_ENV is not production', () => {
    assert.equal(resolveEffectiveTtl(30, 'development'), 600)
    assert.equal(resolveEffectiveTtl(45, 'test'), 600)
    assert.equal(resolveEffectiveTtl(30, undefined), 600)
  })

  it('never shrinks a TTL that is already longer than 10 minutes outside production', () => {
    assert.equal(resolveEffectiveTtl(3600, 'development'), 3600)
  })
})

describe('resolveEffectiveTtl — determinism', () => {
  it('is pure — same input always produces the same output', () => {
    assert.equal(resolveEffectiveTtl(30, 'development'), resolveEffectiveTtl(30, 'development'))
  })
})

describe('simple holdings/provider KV writer', () => {
  it('writes full holdings payload without chunking', async () => {
    const writes: Array<{ key: string; value: unknown; opts?: { ex?: number } }> = []
    const writer = createHoldingsKvWriter({ kv: { set: async (key: string, value: unknown, opts?: { ex?: number }) => { writes.push({ key, value, opts }); return 'OK' } } as never })
    const value = { items: Array.from({ length: 2000 }, (_, i) => ({ i, token: '0xabc', amount: String(i) })) }

    await writer.write('v2:holdings:base:0xabc', value, 20)

    assert.equal(writes.length, 1)
    assert.equal(writes[0].key, 'v2:holdings:base:0xabc')
    assert.deepEqual(writes[0].value, value)
    assert.deepEqual(writes[0].opts, { ex: 20 })
    assert.equal(writes.some((w) => w.key.includes(':chunk:')), false)
  })

  it('writes full provider-window payload without chunking', async () => {
    const writes: Array<{ key: string; value: unknown }> = []
    const writer = createProviderWindowKvWriter({ kv: { set: async (key: string, value: unknown) => { writes.push({ key, value }); return 'OK' } } as never })
    const value = { windows: Array.from({ length: 500 }, (_, i) => ({ block: i, transfers: [{ token: '0xdef', amount: String(i) }] })) }

    await writer.write('v2:providerFetchWindow:base:0xabc:1', value, 30)

    assert.equal(writes.length, 1)
    assert.equal(writes[0].key, 'v2:providerFetchWindow:base:0xabc:1')
    assert.deepEqual(writes[0].value, value)
    assert.equal(writes.some((w) => w.key.includes(':chunk:')), false)
  })

  it('writes normally when degraded options are passed', async () => {
    const writes: unknown[] = []
    const calls: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { calls.push(args) }
    try {
      const writer = createHoldingsKvWriter({ kv: { set: async (...args: unknown[]) => { writes.push(args); return 'OK' } } as never })
      await writer.write('v2:holdings:base:0xabc', { degraded: true, text: 'x'.repeat(2000) }, 20)
    } finally {
      console.warn = originalWarn
    }
    assert.equal(writes.length, 1)
    assert.equal(calls.some((c) => String(c[0]).includes('partial')), false)
  })

  it('does not retry or treat budget errors specially', async () => {
    let attempts = 0
    const writer = createHoldingsKvWriter({
      kv: { set: async () => { attempts++; throw Object.assign(new Error('write failed'), { code: 'BUDGET_TEST' }) } } as never,
    })

    await assert.rejects(() => writer.write('v2:holdings:base:0xdef', { ok: true }, 20), /write failed/)
    assert.equal(attempts, 1)
  })

  it('does not apply timeout-safe wrapping', async () => {
    let attempts = 0
    const writer = createProviderWindowKvWriter({
      kv: { set: async () => { attempts++; throw Object.assign(new Error('plain timeout'), { code: 'ETIMEDOUT' }) } } as never,
    })

    await assert.rejects(() => writer.write('v2:providerFetchWindow:base:0xabc:2', { a: 2 }, 20), /plain timeout/)
    assert.equal(attempts, 1)
  })
})
