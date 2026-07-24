// Tests for src/modules/recoveryPolicy/utils.ts's request-scoped promise coalescing around
// fetchGoldrushHistoricalPage (resetRecoveryHistoricalPageRequestCache). Confirmed root cause of
// the "4 Base transactions_v3 calls" symptom surviving the fetchProviderWindow-level fix: this
// function's real request depends ONLY on (chain, walletAddress, pageNumber) — never the token —
// yet buildRecoveryPolicyObject calls it once per triggered candidate. Mocks global.fetch (no real
// network dependency), same pattern already used by lib/server/dustPriceCheck.test.ts. Run with:
//   npx tsx --test src/modules/recoveryPolicy/historicalPageCoalescing.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGoldrushHistoricalPage, resetRecoveryHistoricalPageRequestCache } from './utils'

const originalFetch = global.fetch
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY

beforeEach(() => {
  resetRecoveryHistoricalPageRequestCache()
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
})

afterEach(() => {
  global.fetch = originalFetch
  resetRecoveryHistoricalPageRequestCache()
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
})

function mockFetch(opts: { delayMs?: number } = {}): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchGoldrushHistoricalPage — request-scoped promise coalescing (no direct history caller may bypass it)', () => {
  it('two triggered candidates on the same chain+wallet+page reuse ONE real GoldRush call, not one each', async () => {
    const { getCallCount } = mockFetch({ delayMs: 10 })

    // Simulates buildRecoveryPolicyObject calling fetchHistoricalPages once per triggered candidate
    // (e.g. two different tokens on Base both triggering recovery) — same chain, same wallet, same
    // page-number=1, DIFFERENT tokens (which this function never even receives, since its own real
    // request has no token parameter at all).
    const [forTokenA, forTokenB] = await Promise.all([
      fetchGoldrushHistoricalPage('base', '0xwallet', 1),
      fetchGoldrushHistoricalPage('base', '0xwallet', 1),
    ])

    assert.equal(getCallCount(), 1, 'two candidates for the identical (chain, wallet, page) must produce exactly one real network call')
    assert.deepEqual(forTokenA, forTokenB, 'both candidates must receive the exact same result to locally filter by their own token')
  })

  it('a different page number is NOT coalesced with page 1 — it triggers its own real fetch', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    await fetchGoldrushHistoricalPage('base', '0xwallet', 1)
    assert.equal(getCallCount(), 1)

    await fetchGoldrushHistoricalPage('base', '0xwallet', 2)
    assert.equal(getCallCount(), 2, 'a genuinely different page must never be silently served from a different page\'s cached result')
  })

  it('a different chain remains independent — its own real fetch still happens', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    await fetchGoldrushHistoricalPage('base', '0xwallet', 1)
    assert.equal(getCallCount(), 1)

    await fetchGoldrushHistoricalPage('eth', '0xwallet', 1)
    assert.equal(getCallCount(), 2, 'a different chain must trigger its own real fetch, never be coalesced with base')
  })

  it('resetRecoveryHistoricalPageRequestCache clears coalescing between scan jobs — reset runs exactly once per job', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    await fetchGoldrushHistoricalPage('base', '0xwallet', 1)
    assert.equal(getCallCount(), 1)

    // Same job: a repeat candidate reuses the settled result, no new call.
    await fetchGoldrushHistoricalPage('base', '0xwallet', 1)
    assert.equal(getCallCount(), 1, 'within the same job, a later candidate must reuse the settled result')

    // Simulates walletScanWorker.ts's single per-job reset — a NEW job for the same wallet must
    // fetch live again, never silently reuse a prior job's result.
    resetRecoveryHistoricalPageRequestCache()
    await fetchGoldrushHistoricalPage('base', '0xwallet', 1)
    assert.equal(getCallCount(), 2, 'a fresh job (after the single per-job reset) must not reuse a coalesced result from a prior, unrelated job')
  })
})
