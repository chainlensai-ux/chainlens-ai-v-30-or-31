import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequestPriceKvClient } from './kvClient'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

function neverHitKv() { return { get: async () => null, set: async () => 'OK' } }

describe('RequestPriceKvClient high fan-out controls', () => {
  it('allows provider fetches but suppresses historical KV writes in historicalReadOnly mode', async () => {
    let fetchCalls = 0
    let setCalls = 0
    const kv = { get: async () => null, set: async () => { setCalls++; return 'OK' } }
    const source: PriceSourceFn = async () => { fetchCalls++; return 9 }
    const client = createRequestPriceKvClient({ kv: kv as never, historicalReadOnly: true, maxLookupsPerToken: 10, random: () => 0 })

    assert.equal(await client.getPriceHistorical('0xReadOnly', 'base', 123, source), 9)
    assert.equal(fetchCalls, 1)
    assert.equal(setCalls, 0)
    assert.equal(client.stats.remoteSets, 0)
  })

  it('regression guard: a successful historical price lookup IS remotely cached when historicalReadOnly is not set (the pipeline\'s new default)', async () => {
    // Confirmed real production evidence: remoteGets: 229, remoteSets: 0 — traced to
    // src/pipeline/index.ts unconditionally passing historicalReadOnly: true to
    // createRequestPriceKvClient(), which this file's own first test (above) proves suppresses
    // every write. A historical price at a fixed past timestamp is an immutable fact, safe to share
    // across separate scans (unlike a "current" price) — fixed by no longer passing that flag at the
    // pipeline call site. This test proves a real, previously-uncached KV client (no explicit
    // historicalReadOnly option — matching the fixed pipeline call shape) actually calls kv.set once
    // a price is found.
    let setCalls = 0
    const kv = { get: async () => null, set: async () => { setCalls++; return 'OK' } }
    const source: PriceSourceFn = async () => 9
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })

    assert.equal(await client.getPriceHistorical('0xWritable', 'base', 123, source), 9)
    assert.equal(setCalls, 1, 'a successful price lookup must write to KV when historicalReadOnly is not set')
    assert.equal(client.stats.remoteSets, 1)
  })

  it('regression guard: a second, separate client hits the remote KV cache instead of re-fetching from the provider', async () => {
    // Proves the cached value is actually usable cross-request, not just written and ignored — a
    // fresh RequestPriceKvClient instance (simulating a later, separate scan) with a `get` that
    // returns the previously-cached value must reuse it rather than calling the provider again.
    let fetchCalls = 0
    const store = new Map<string, number>()
    const kv = {
      get: async (key: string) => (store.has(key) ? store.get(key)! : null),
      set: async (key: string, value: number) => { store.set(key, value); return 'OK' as const },
    }
    const source: PriceSourceFn = async () => { fetchCalls++; return 9 }

    const firstScanClient = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })
    assert.equal(await firstScanClient.getPriceHistorical('0xShared', 'base', 123, source), 9)
    assert.equal(fetchCalls, 1)

    // A brand-new client instance, exactly as a later, separate wallet scan would construct — its
    // own in-memory cache is empty, so a real value can only come from the remote KV write above.
    const secondScanClient = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })
    assert.equal(await secondScanClient.getPriceHistorical('0xShared', 'base', 123, source), 9)
    assert.equal(fetchCalls, 1, 'the second scan must reuse the cached remote value, never re-calling the provider')
    assert.equal(secondScanClient.stats.remoteGets, 1)
  })

  it('regression guard: cache keys are chain-aware and timestamp-aware — no cross-chain or cross-timestamp collision', async () => {
    const store = new Map<string, number>()
    const kv = {
      get: async (key: string) => (store.has(key) ? store.get(key)! : null),
      set: async (key: string, value: number) => { store.set(key, value); return 'OK' as const },
    }
    let call = 0
    const source: PriceSourceFn = async () => { call += 1; return call === 1 ? 10 : call === 2 ? 20 : 30 }
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })

    // Same token, different chain -> distinct key, distinct real price.
    assert.equal(await client.getPriceHistorical('0xSame', 'base', 100, source), 10)
    assert.equal(await client.getPriceHistorical('0xSame', 'eth', 100, source), 20)
    // Same token+chain, different timestamp -> distinct key, distinct real price.
    assert.equal(await client.getPriceHistorical('0xSame', 'base', 200, source), 30)
    assert.equal(store.size, 3, 'three genuinely distinct (chain, token, timestamp) keys must be cached separately')
  })

  it('coalesces duplicate historical price requests and reuses the in-request cache', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; await new Promise((r) => setTimeout(r, 5)); return 7 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, maxLookupsPerToken: 10, random: () => 0 })

    const batch = await Promise.all(Array.from({ length: 25 }, () => client.getPriceHistorical('0xToken', 'base', 123, source)))
    assert.deepEqual([...new Set(batch)], [7])
    assert.equal(fetchCalls, 1)
    assert.equal(client.stats.coalesced, 24)

    assert.equal(await client.getPriceHistorical('0xToken', 'base', 123, source), 7)
    assert.equal(fetchCalls, 1)
    assert.equal(client.stats.cacheHits, 1)
  })

  it('caps concurrent KV reads under many distinct tokens', async () => {
    let active = 0
    let maxActive = 0
    const kv = {
      get: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 3)); active--; return null },
      set: async () => 'OK',
    }
    const client = createRequestPriceKvClient({ kv: kv as never, maxConcurrent: 4, maxLookupsPerToken: 10, random: () => 0 })
    const source: PriceSourceFn = async () => 1
    await Promise.all(Array.from({ length: 60 }, (_, i) => client.getPriceHistorical(`0x${i}`, 'base', 1000 + i, source)))
    assert.ok(maxActive <= 4, `expected <= 4 concurrent KV reads, got ${maxActive}`)
  })
})

describe('RequestPriceKvClient breaker and lookup cap', () => {
  it('opens the read breaker on repeated KV timeouts and skips subsequent reads predictably', async () => {
    const kv = { get: async () => new Promise<null>(() => {}), set: async () => 'OK' }
    const client = createRequestPriceKvClient({ kv: kv as never, timeoutMs: 1, maxRetries: 0, maxConsecutiveTimeouts: 2, cooldownMs: 10_000, maxLookupsPerToken: 10, random: () => 0 })
    const source: PriceSourceFn = async () => 2

    assert.equal(await client.getPriceHistorical('0xa', 'base', 1, source), 2)
    assert.equal(await client.getPriceHistorical('0xb', 'base', 1, source), 2)
    assert.equal(await client.getPriceHistorical('0xc', 'base', 1, source), 2)

    assert.equal(client.stats.timeouts, 2)
    assert.equal(client.stats.breakerSkips, 1)
  })

  it('enforces maxLookupsPerToken centrally before KV/provider fan-out', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 5 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, maxLookupsPerToken: 2, random: () => 0 })

    assert.equal(await client.getPriceHistorical('0xCap', 'base', 1, source), 5)
    assert.equal(await client.getPriceHistorical('0xCap', 'base', 2, source), 5)
    assert.equal(await client.getPriceHistorical('0xCap', 'base', 3, source), null)

    assert.equal(fetchCalls, 2)
    assert.equal(client.stats.cappedLookups, 1)
  })
})

describe('RequestPriceKvClient — recovery lane (provider-call-audit follow-up task, confirmed root cause of "recovery made zero live source attempts")', () => {
  it('an exhausted normal per-token cap does not block the bounded recovery lane', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 9 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, maxLookupsPerToken: 1, random: () => 0 })

    // Exhaust the NORMAL per-token cap for this token (simulates the main pricingAtTime pass having
    // already spent its budget on this exact token before recovery ever runs).
    assert.equal(await client.getPriceHistorical('0xshared', 'base', 100, source), 9)
    assert.equal(await client.getPriceHistorical('0xshared', 'base', 200, source), null, 'the normal cap must already be exhausted for this token')
    assert.equal(client.stats.cappedLookups, 1)

    // The SAME token, via the recovery lane, must NOT be blocked by that same exhausted cap.
    const recovered = await client.getPriceRecovery('0xshared', 'base', 300, source, 'chain-aware-historical', 10)
    assert.equal(recovered, 9, 'the recovery lane must still resolve a real price for a token the normal cap has already exhausted')
    assert.equal(client.recoveryStats.recoveryLiveFetches, 1)
  })

  it('recovery remains capped by its own bounded budget, derived strictly from the caller\'s recovery attempts — never unlimited', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 4 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, random: () => 0 })

    const budget = 3
    for (let i = 0; i < 5; i += 1) {
      await client.getPriceRecovery(`0xtoken${i}`, 'base', 1000 + i, source, 'chain-aware-historical', budget)
    }

    assert.equal(fetchCalls, budget, 'only the first `budget` distinct recovery lookups may make a real live fetch')
    assert.equal(client.recoveryStats.recoveryLiveFetches, budget)
    assert.equal(client.recoveryStats.recoveryCappedLookups, 5 - budget, 'lookups beyond the budget must be recorded as capped, never silently dropped')
  })

  it('a KV hit uses zero live recovery allowance', async () => {
    const store = new Map<string, number>([['v2:price:primary:base:0xcached:1', 7]])
    const client = createRequestPriceKvClient({
      kv: { get: async (key: string) => store.get(key) ?? null, set: async () => 'OK' } as never,
      random: () => 0,
    })
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 999 }

    const recovered = await client.getPriceRecovery('0xcached', 'base', 1, source, 'primary', 10)
    assert.equal(recovered, 7, 'the real cached KV value must be returned')
    assert.equal(fetchCalls, 0, 'a KV hit must never invoke the live fetcher')
    assert.equal(client.recoveryStats.recoveryLiveFetches, 0)
    assert.equal(client.recoveryStats.recoveryCacheHits, 1)
  })

  it('identical recovery keys (same chain+token+timestamp) coalesce into one real live fetch', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; await new Promise((r) => setTimeout(r, 5)); return 11 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, random: () => 0 })

    const results = await Promise.all(Array.from({ length: 5 }, () => client.getPriceRecovery('0xshared', 'base', 500, source, 'chain-aware-historical', 10)))
    assert.deepEqual([...new Set(results)], [11])
    assert.equal(fetchCalls, 1, 'five concurrent identical recovery requests must coalesce into one real live fetch')
    assert.equal(client.recoveryStats.recoveryLiveFetches, 1)
    assert.equal(client.recoveryStats.recoveryCacheHits, 4, 'the four coalesced callers must be recorded as consuming zero NEW live allowance')
  })

  it('the recovery lane reuses the same cache a normal-lane lookup already populated — no duplicate real call for the same key', async () => {
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 6 }
    const client = createRequestPriceKvClient({ kv: neverHitKv() as never, maxLookupsPerToken: 10, random: () => 0 })

    assert.equal(await client.getPriceHistorical('0xreused', 'base', 42, source), 6)
    assert.equal(fetchCalls, 1)

    const recovered = await client.getPriceRecovery('0xreused', 'base', 42, source, 'chain-aware-historical', 10)
    assert.equal(recovered, 6, 'the recovery lane must reuse the value the normal lane already resolved for the identical key')
    assert.equal(fetchCalls, 1, 'no duplicate provider call for a key already resolved by the normal lane')
    assert.equal(client.recoveryStats.recoveryCacheHits, 1)
  })
})

describe('RequestPriceKvClient — historical price determinism (determinism follow-up task)', () => {
  it('HARD ASSERTION: a historical price is written with the long (30-day) TTL, never the short 45s primary TTL', async () => {
    const setCalls: Array<{ key: string; opts: { ex?: number } | undefined }> = []
    const kv = { get: async () => null, set: async (key: string, _value: unknown, opts?: { ex?: number }) => { setCalls.push({ key, opts }); return 'OK' } }
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })

    await client.getPriceHistorical('0xLongTtl', 'base', 100, async () => 5)
    await client.getPricePrimary('0xLongTtl', 'base', 200, async () => 6)

    const historicalSet = setCalls.find((c) => c.key.includes('chain-aware-historical'))!
    const primarySet = setCalls.find((c) => c.key.includes(':primary:'))!
    assert.equal(historicalSet.opts?.ex, 60 * 60 * 24 * 30)
    assert.equal(primarySet.opts?.ex, 45)
  })

  it('HARD ASSERTION: a second, separate client (a rescan) reuses the exact accepted historical price beyond the old 45s TTL window — the actual root-cause fix', async () => {
    // Simulates two wallet scans separated by hours: the fake KV honors real expiry via `ex`, so
    // this proves the long TTL — not just "some" persistence — is what makes the value still be
    // there on the second scan.
    const store = new Map<string, { value: unknown; expiresAtMs: number }>()
    let clock = 1_000_000
    const kv = {
      get: async (key: string) => {
        const entry = store.get(key)
        if (!entry) return null
        return entry.expiresAtMs > clock ? entry.value : null
      },
      set: async (key: string, value: unknown, opts?: { ex?: number }) => {
        store.set(key, { value, expiresAtMs: clock + (opts?.ex ?? 0) * 1000 })
        return 'OK'
      },
    }
    let fetchCalls = 0
    const source: PriceSourceFn = async () => { fetchCalls++; return 42 }

    const firstScan = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0, now: () => clock })
    assert.equal(await firstScan.getPriceHistorical('0xRescan', 'base', 999, source), 42)
    assert.equal(fetchCalls, 1)

    // Advance the clock well past the OLD 45-second TTL (10 minutes) — a rescan hours/days later in
    // production, represented here by a smaller but still-45s-busting gap for a fast test.
    clock += 10 * 60 * 1000

    const secondScan = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0, now: () => clock })
    assert.equal(await secondScan.getPriceHistorical('0xRescan', 'base', 999, source), 42, 'the second scan must reuse the SAME accepted historical price')
    assert.equal(fetchCalls, 1, 'no live provider call on the second scan — this is what makes the rescan deterministic')
  })

  it('a bare legacy number (written before this fix) is still read correctly — no invalidation of previously-cached data', async () => {
    const store = new Map<string, number>()
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      set: async () => 'OK',
    }
    store.set('v2:price:chain-aware-historical:base:0xlegacy:1', 17)
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })
    let fetchCalls = 0
    const result = await client.getPriceHistorical('0xlegacy', 'base', 1, async () => { fetchCalls++; return 999 })
    assert.equal(result, 17)
    assert.equal(fetchCalls, 0)
  })

  it('HARD ASSERTION: a corrupt/malformed cached envelope is a cache MISS, never coerced into a price (fail-closed)', async () => {
    const kv = { get: async () => ({ priceUsd: 'not-a-number', evidenceType: 'chain-aware-historical' }), set: async () => 'OK' }
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0 })
    let fetchCalls = 0
    const result = await client.getPriceHistorical('0xcorrupt', 'base', 1, async () => { fetchCalls++; return 55 })
    assert.equal(result, 55, 'a corrupt cache entry must fall through to a real live fetch, never a fabricated value')
    assert.equal(fetchCalls, 1)
  })

  it('HARD ASSERTION: an expired envelope (expiresAt in the past) is a cache MISS, never returned as still-valid', async () => {
    const kv = { get: async () => ({ priceUsd: 3, source: 'unspecified', evidenceType: 'chain-aware-historical', createdAt: 0, expiresAt: 500 }), set: async () => 'OK' }
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0, now: () => 1000 })
    let fetchCalls = 0
    const result = await client.getPriceHistorical('0xexpired', 'base', 1, async () => { fetchCalls++; return 88 })
    assert.equal(result, 88)
    assert.equal(fetchCalls, 1, 'an expired envelope must never be treated as a valid cache hit')
  })

  it('a well-formed, still-live envelope IS reused without a live fetch', async () => {
    const kv = { get: async () => ({ priceUsd: 3, source: 'unspecified', evidenceType: 'chain-aware-historical', createdAt: 0, expiresAt: 5000 }), set: async () => 'OK' }
    const client = createRequestPriceKvClient({ kv: kv as never, maxLookupsPerToken: 10, random: () => 0, now: () => 1000 })
    let fetchCalls = 0
    const result = await client.getPriceHistorical('0xlive', 'base', 1, async () => { fetchCalls++; return 88 })
    assert.equal(result, 3)
    assert.equal(fetchCalls, 0)
  })
})
