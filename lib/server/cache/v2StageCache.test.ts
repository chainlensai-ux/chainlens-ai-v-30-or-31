// Tests for lib/server/cache/v2StageCache.ts's dev-only KV warm mode. Uses node:test, same
// convention as the other module test files this session. Only tests resolveEffectiveTtl() in
// isolation (a pure function) rather than withStageCache() itself, since the latter depends on a
// real KV client this sandbox has no credentials for — testing the pure TTL-selection logic
// directly avoids needing to mock that client while still covering the actual behavior change.
// Run directly with:
//   npx tsx --test lib/server/cache/v2StageCache.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTtl, compress, decompress, MAX_PAYLOAD_BYTES } from './v2StageCache'

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

// COMPRESSION / LARGE-PAYLOAD TESTS, ADDED: these test compress()/decompress() directly (real,
// exported, pure functions — see this file's own header for why the setStageCache/getStageCache
// they're used inside can't be exercised end-to-end without live KV credentials this sandbox
// doesn't have).
describe('compress/decompress — round-trip', () => {
  it('round-trips a real JSON payload exactly', async () => {
    const original = JSON.stringify({ hello: 'world', values: [1, 2, 3], nested: { a: true } })
    const compressed = await compress(original)
    assert.notEqual(compressed, original) // it actually changed the bytes, not a no-op
    const decompressed = await decompress<{ hello: string; values: number[]; nested: { a: boolean } }>(compressed)
    assert.deepEqual(decompressed, { hello: 'world', values: [1, 2, 3], nested: { a: true } })
  })

  it('shrinks a large, repetitive payload well below MAX_PAYLOAD_BYTES', async () => {
    // A realistic "large holdings/provider window" shape: a big array of repetitive small objects
    // — highly compressible, the exact case this fix targets (JSON-large but compresses small).
    const bigArray = Array.from({ length: 5000 }, (_, i) => ({ tokenAddress: '0xtoken', chain: 'base', amount: i, symbol: 'TEST' }))
    const serialized = JSON.stringify(bigArray)
    const uncompressedBytes = Buffer.byteLength(serialized, 'utf8')
    const compressed = await compress(serialized)
    const compressedBytes = Buffer.byteLength(compressed, 'utf8')

    assert.ok(uncompressedBytes > MAX_PAYLOAD_BYTES, `expected a genuinely large uncompressed payload (${uncompressedBytes} bytes)`)
    assert.ok(compressedBytes < uncompressedBytes, 'compression must actually shrink the payload')
    // The real point of this fix: a payload that WOULD have been skipped pre-compression is small
    // enough to actually cache once compressed.
    assert.ok(compressedBytes < MAX_PAYLOAD_BYTES, `expected compressed payload (${compressedBytes} bytes) to fit under MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES})`)
  })

  it('backward-compatible read: decompress() falls back to plain JSON.parse for a pre-compression value', async () => {
    const legacyRawValue = JSON.stringify({ legacy: true })
    const result = await decompress<{ legacy: boolean }>(legacyRawValue)
    assert.deepEqual(result, { legacy: true })
  })

  it('decompress() returns a non-string value as-is (kv.get<T> may already have deserialized it)', async () => {
    const alreadyDeserialized = { already: 'an object' }
    const result = await decompress<typeof alreadyDeserialized>(alreadyDeserialized)
    assert.deepEqual(result, alreadyDeserialized)
  })
})
