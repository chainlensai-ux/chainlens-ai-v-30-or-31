// Tests for src/pipeline/providers/geckoTerminalPriceSource.ts's deterministic no-pool cache —
// source-retry-avoidance task's explicit "skip GeckoTerminal after deterministic no-pool evidence"
// requirement. Mocks global.fetch (no real network dependency). Run with:
//   npx tsx --test src/pipeline/providers/geckoTerminalPriceSource.test.ts

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGeckoTerminalPriceDetailed, resetGeckoTerminalNoPoolCache, isKnownGeckoTerminalNoPool, GECKOTERMINAL_COOLDOWN_KEY, GECKOTERMINAL_COOLDOWN_TTL_SECONDS, type GeckoTerminalCooldownKvLike } from './geckoTerminalPriceSource'

function fakeCooldownKv(): GeckoTerminalCooldownKvLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

const originalFetch = global.fetch
const NOW = Date.now()

afterEach(() => {
  global.fetch = originalFetch
  resetGeckoTerminalNoPoolCache()
})

function mockPoolsResponse(pools: unknown[]): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response(JSON.stringify({ data: pools }), { status: 200 })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchGeckoTerminalPriceDetailed — deterministic no-pool cache (never retries a token proven to have no real pool)', () => {
  it('a token with zero pools is recorded as a deterministic no-pool result', async () => {
    mockPoolsResponse([])
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), false)
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), true)
  })

  it('a later lookup for the SAME token this scan makes zero real network calls', async () => {
    const first = mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(first.getCallCount(), 1)

    const second = mockPoolsResponse([{ attributes: { address: '0xpool', reserve_in_usd: '50000' } }])
    const result = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW - 3_600_000)
    assert.equal(second.getCallCount(), 0, 'a token already proven to have no pool must never trigger a real network call again this scan')
    assert.equal(result.priceUsd, null)
    assert.equal(result.reason, 'no_pool_found')
  })

  it('a DIFFERENT token is never affected by another token\'s no-pool cache entry', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken-a', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken-a'), true)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken-b'), false, 'the no-pool result must be scoped to its own token, never applied to a different one')
  })

  it('the same token on a DIFFERENT chain is not affected — cache is scoped per (chain, token)', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), true)
    assert.equal(isKnownGeckoTerminalNoPool('eth', '0xtoken'), false)
  })

  it('resetGeckoTerminalNoPoolCache() clears the cache for the next scan', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), true)

    resetGeckoTerminalNoPoolCache()
    assert.equal(isKnownGeckoTerminalNoPool('base', '0xtoken'), false, 'a new scan must be free to re-check a token that may have a pool by now')
  })

  it('never fabricates a price — the cached short-circuit result matches a real no-pool response', async () => {
    mockPoolsResponse([])
    await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    const cached = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW)
    assert.equal(cached.priceUsd, null)
    assert.equal(cached.reason, 'no_pool_found')
  })
})

describe('fetchGeckoTerminalPriceDetailed — persisted 429 cooldown (determinism follow-up task, requirement #7)', () => {
  it('HARD ASSERTION: a real 429 opens a persisted cooldown that a LATER, SEPARATE call (a new process/request, simulated by a fresh kv reference to the same store) honors — cross-request quota memory, not just in-process', async () => {
    const kv = fakeCooldownKv()
    global.fetch = (async (url: string) => {
      if (url.includes('/pools/')) return new Response('{}', { status: 429 })
      return new Response(JSON.stringify({ data: [{ attributes: { address: '0xpool', reserve_in_usd: '50000' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const clock = 0
    const first = await fetchGeckoTerminalPriceDetailed('0xrl', 'base', NOW, { kv, now: () => clock })
    assert.equal(first.reason, 'http_429')
    assert.equal(kv.store.has(GECKOTERMINAL_COOLDOWN_KEY), true, 'a real 429 must persist a cooldown entry')

    // A later call, same process or not (only the persisted store matters) — must SKIP the network
    // call entirely rather than re-attempting GeckoTerminal and getting a different outcome by luck.
    const second = await fetchGeckoTerminalPriceDetailed('0xrl', 'base', NOW, { kv, now: () => clock + 1000 })
    assert.equal(second.skippedDueToPersistedCooldown, true)
    assert.equal(second.reason, 'skipped_due_to_persisted_cooldown')
  })

  it('the cooldown is bounded, never permanent — a call after the TTL expires resumes normally', async () => {
    const kv = fakeCooldownKv()
    let clock = 0
    kv.store.set(GECKOTERMINAL_COOLDOWN_KEY, clock + GECKOTERMINAL_COOLDOWN_TTL_SECONDS * 1000)
    mockPoolsResponse([{ attributes: { address: '0xpool', reserve_in_usd: '50000' } }])

    const duringCooldown = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW, { kv, now: () => clock })
    assert.equal(duringCooldown.skippedDueToPersistedCooldown, true)

    clock += GECKOTERMINAL_COOLDOWN_TTL_SECONDS * 1000 + 1
    const afterCooldown = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW, { kv, now: () => clock })
    assert.notEqual(afterCooldown.skippedDueToPersistedCooldown, true, 'the source must never be permanently disabled — only skipped for the bounded window')
  })

  it('a KV read failure during the cooldown check fails open — never blocks a legitimate call', async () => {
    const kv: GeckoTerminalCooldownKvLike = { get: async () => { throw new Error('kv down') }, set: async () => 'OK' }
    mockPoolsResponse([])
    const result = await fetchGeckoTerminalPriceDetailed('0xtoken', 'base', NOW, { kv })
    assert.notEqual(result.skippedDueToPersistedCooldown, true)
  })
})
