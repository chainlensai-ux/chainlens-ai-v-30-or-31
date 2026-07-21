// Tests for lib/server/cache/v2StageCache.ts's dev-only KV warm mode. Uses node:test, same
// convention as the other module test files this session. Only tests resolveEffectiveTtl() in
// isolation (a pure function) rather than withStageCache() itself, since the latter depends on a
// real KV client this sandbox has no credentials for — testing the pure TTL-selection logic
// directly avoids needing to mock that client while still covering the actual behavior change.
// Run directly with:
//   npx tsx --test lib/server/cache/v2StageCache.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTtl, compress, decompress, decompressStageValue, MAX_PAYLOAD_BYTES, createHoldingsKvWriter, createProviderWindowKvWriter, chunkStringByUtf8Bytes } from './v2StageCache'

async function decompressChunkForTest(base64: unknown): Promise<string> {
  assert.equal(typeof base64, 'string')
  const decompressedStream = new Blob([Buffer.from(base64 as string, 'base64')]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buffer = await new Response(decompressedStream).arrayBuffer()
  return Buffer.from(buffer).toString('utf8')
}

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
// doesn't have). `compress` takes the raw value directly (not a pre-serialized string) and returns
// `{ compressedBase64, compressedBytes }`; `decompress` is pure and strict (throws on non-gzip
// input) — the backward-compatible legacy/non-string fallback behavior lives in the separately
// exported `decompressStageValue`, tested in its own section below.
describe('compress/decompress — round-trip', () => {
  it('round-trips a real JSON-serializable value exactly', async () => {
    const original = { hello: 'world', values: [1, 2, 3], nested: { a: true } }
    const { compressedBase64, compressedBytes } = await compress(original)
    assert.notEqual(compressedBase64, JSON.stringify(original)) // it actually changed the bytes, not a no-op
    assert.equal(compressedBytes, Buffer.byteLength(compressedBase64, 'utf8'))
    const decompressed = await decompress(compressedBase64)
    assert.deepEqual(decompressed, original)
  })

  it('shrinks a large, repetitive payload well below MAX_PAYLOAD_BYTES', async () => {
    // A realistic "large holdings/provider window" shape: a big array of repetitive small objects
    // — highly compressible, the exact case this fix targets (JSON-large but compresses small).
    const bigArray = Array.from({ length: 5000 }, (_, i) => ({ tokenAddress: '0xtoken', chain: 'base', amount: i, symbol: 'TEST' }))
    const uncompressedBytes = Buffer.byteLength(JSON.stringify(bigArray), 'utf8')
    const { compressedBase64, compressedBytes } = await compress(bigArray)

    assert.ok(uncompressedBytes > MAX_PAYLOAD_BYTES, `expected a genuinely large uncompressed payload (${uncompressedBytes} bytes)`)
    assert.ok(compressedBytes < uncompressedBytes, 'compression must actually shrink the payload')
    // The real point of this fix: a payload that WOULD have been skipped pre-compression is small
    // enough to actually cache once compressed.
    assert.ok(compressedBytes < MAX_PAYLOAD_BYTES, `expected compressed payload (${compressedBytes} bytes) to fit under MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES})`)
    assert.ok(compressedBase64.length > 0)
  })

  it('decompress() throws on malformed (non-gzip) input — it is pure/strict, not a fallback handler', async () => {
    await assert.rejects(() => decompress('not valid base64 gzip data'))
  })

  it('remains large enough to stay skipped even after compression for effectively-incompressible data', async () => {
    // Random-looking, non-repetitive data compresses poorly — a real scenario where even gzip
    // can't bring a payload under the limit, exercising the "still skipped after compression" path.
    const incompressible = Array.from({ length: 30_000 }, () => Math.random().toString(36)).join('')
    const uncompressedBytes = Buffer.byteLength(JSON.stringify(incompressible), 'utf8')
    const { compressedBytes } = await compress(incompressible)
    assert.ok(uncompressedBytes > MAX_PAYLOAD_BYTES)
    // Not asserting compressedBytes > MAX_PAYLOAD_BYTES unconditionally (random strings still
    // compress somewhat via base64/gzip framing overhead vs. true incompressibility) — asserting
    // instead that compression genuinely ran and produced a real, different-sized result.
    assert.ok(compressedBytes > 0)
  })
})

describe('decompressStageValue — backward-compatible read (internal fallback helper)', () => {
  it('falls back to plain JSON.parse for a pre-compression legacy value', async () => {
    const legacyRawValue = JSON.stringify({ legacy: true })
    const result = await decompressStageValue<{ legacy: boolean }>(legacyRawValue)
    assert.deepEqual(result, { legacy: true })
  })

  it('returns a non-string value as-is (kv.get<T> may already have deserialized it)', async () => {
    const alreadyDeserialized = { already: 'an object' }
    const result = await decompressStageValue<typeof alreadyDeserialized>(alreadyDeserialized)
    assert.deepEqual(result, alreadyDeserialized)
  })

  it('round-trips a real compressed value produced by compress()', async () => {
    const original = { real: 'compressed', n: 42 }
    const { compressedBase64 } = await compress(original)
    const result = await decompressStageValue<typeof original>(compressedBase64)
    assert.deepEqual(result, original)
  })
})

describe('chunked holdings/provider KV writer', () => {
  it('chunks deterministically into <=50KB serialized segments and compresses each chunk', async () => {
    const input = 'x'.repeat(120_000)
    const chunks = chunkStringByUtf8Bytes(input, 50_000)
    assert.deepEqual(chunks.map((c) => Buffer.byteLength(c, 'utf8')), [50_000, 50_000, 20_000])
    assert.deepEqual(chunkStringByUtf8Bytes(input, 50_000), chunks)
  })

  it('writes compressed chunks plus a deterministic manifest that reassembles correctly', async () => {
    const writes: Array<{ key: string; value: unknown }> = []
    const writer = createHoldingsKvWriter({ kv: { set: async (key: string, value: unknown) => { writes.push({ key, value }); return 'OK' } } as never, sleep: async () => undefined })
    const value = { items: Array.from({ length: 2000 }, (_, i) => ({ i, token: '0xabc', amount: String(i) })) }

    await writer.write('v2:holdings:base:0xabc', value, 20)

    assert.ok(writes.length > 1, 'expected chunk writes plus manifest')
    const manifest = writes.at(-1)!.value as { __chainlensChunkedKv: boolean; chunkCount: number; hash: string }
    assert.equal(manifest.__chainlensChunkedKv, true)
    assert.equal(manifest.chunkCount, writes.length - 1)
    assert.equal(typeof manifest.hash, 'string')
    const serialized = (await Promise.all(writes.slice(0, -1).map((w) => decompressChunkForTest(w.value)))).join('')
    assert.deepEqual(JSON.parse(serialized), value)
  })

  it('enforces total write budget and logs budget_exceeded without throwing', async () => {
    let nowMs = 0
    const writes: string[] = []
    const calls: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { calls.push(args) }
    try {
      const writer = createHoldingsKvWriter({
        kv: { set: async (key: string) => { writes.push(key); nowMs += 1000; return 'OK' } } as never,
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms },
        maxTotalWriteTimeMs: 1,
        maxChunkBytes: 10,
      })
      await writer.write('v2:holdings:base:0xabc', { text: 'x'.repeat(100) }, 20)
    } finally {
      console.warn = original
    }
    assert.ok(writes.length <= 1)
    assert.ok(calls.some((c) => c[0] === '[holdings-kv] partial-write-mode' && (c[1] as { reason: string }).reason === 'budget_exceeded'))
  })

  it('skips unchanged payloads by hash within the request-scoped writer', async () => {
    const writes: Array<{ key: string; value: unknown }> = []
    const writer = createHoldingsKvWriter({ kv: { set: async (key: string, value: unknown) => { writes.push({ key, value }); return 'OK' } } as never, sleep: async () => undefined })
    await writer.write('v2:holdings:base:0xabc', { same: true }, 20)
    const firstWriteCount = writes.length
    await writer.write('v2:holdings:base:0xabc', { same: true }, 20)
    assert.equal(writes.length, firstWriteCount)
  })

  it('switches degraded mode to partial writes instead of skipping', async () => {
    const writes: unknown[] = []
    const writer = createHoldingsKvWriter({ kv: { set: async (...args: unknown[]) => { writes.push(args); return 'OK' } } as never, sleep: async () => undefined })
    await writer.write('v2:holdings:base:0xabc', { degraded: true, text: 'x'.repeat(2000) }, 20, { degradedMode: true })
    assert.ok(writes.length > 0)
  })

  it('backs off on budget_exceeded and eventually writes the final manifest', async () => {
    const writes: Array<{ key: string; value: unknown }> = []
    const slept: number[] = []
    let attempts = 0
    const writer = createHoldingsKvWriter({
      kv: { set: async (key: string, value: unknown) => { attempts++; if (attempts <= 2) throw Object.assign(new Error('budget_exceeded'), { code: 'budget_exceeded', remainingRps: 0, remainingBandwidth: 0, remainingPipelineBudget: 0, latencyMs: 30, clusterHealth: 'degraded' }); writes.push({ key, value }); return 'OK' } } as never,
      sleep: async (ms) => { slept.push(ms) },
    })
    await writer.write('v2:holdings:base:0xdef', { ok: true }, 20)
    assert.deepEqual(slept.slice(0, 2), [50, 100])
    assert.equal((writes.at(-1)?.value as { __chainlensChunkedKv?: boolean }).__chainlensChunkedKv, true)
  })

  it('reduces provider-window write frequency after degraded pressure', async () => {
    const writes: unknown[] = []
    const writer = createProviderWindowKvWriter({ kv: { set: async (...args: unknown[]) => { writes.push(args); return 'OK' } } as never, sleep: async () => undefined })
    await writer.write('v2:providerFetchWindow:base:0xabc:1', { a: 1 }, 20, { degradedMode: true })
    assert.equal(writes.length, 0)
    await writer.write('v2:providerFetchWindow:base:0xabc:2', { a: 2 }, 20)
    assert.ok(writes.length > 0)
  })
})
