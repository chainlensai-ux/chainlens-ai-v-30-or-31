// Tests for src/modules/providerFetchWindow/index.ts's request-scoped promise coalescing
// (fetchProviderWindow / resetProviderFetchWindowRequestCache). Mocks global.fetch (no real network
// dependency), same pattern already used by lib/server/dustPriceCheck.test.ts. Run directly with:
//   npx tsx --test src/modules/providerFetchWindow/coalescing.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchProviderWindow, resetProviderFetchWindowRequestCache } from './index'

const originalFetch = global.fetch
const originalGoldrushKey = process.env.GOLDRUSH_API_KEY
const originalAlchemyBaseKey = process.env.ALCHEMY_BASE_KEY
const originalAlchemyEthKey = process.env.ALCHEMY_ETHEREUM_KEY

beforeEach(() => {
  resetProviderFetchWindowRequestCache()
  process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
  process.env.ALCHEMY_BASE_KEY = 'test-alchemy-key'
  process.env.ALCHEMY_ETHEREUM_KEY = 'test-alchemy-key'
})

afterEach(() => {
  global.fetch = originalFetch
  resetProviderFetchWindowRequestCache()
  process.env.GOLDRUSH_API_KEY = originalGoldrushKey
  process.env.ALCHEMY_BASE_KEY = originalAlchemyBaseKey
  process.env.ALCHEMY_ETHEREUM_KEY = originalAlchemyEthKey
})

// Counts real fetch() invocations and, when `delayMs`/`fail` are given, simulates a slow or
// permanently-failing provider — long enough that several concurrent callers overlap in real time,
// exactly the production scenario (a 12s provider timeout) this fix targets.
function mockFetch(opts: { delayMs?: number; fail?: boolean } = {}): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    if (opts.fail) throw new Error('simulated provider timeout')
    return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchProviderWindow — request-scoped promise coalescing', () => {
  it('four concurrent callers for the same wallet+chain trigger exactly ONE live fetch (goldrush + alchemy = 2 real calls, not 8)', async () => {
    const { getCallCount } = mockFetch({ delayMs: 20 })

    const results = await Promise.all([
      fetchProviderWindow('base', '0xWallet', 90),
      fetchProviderWindow('base', '0xwallet', 90), // case-insensitive, same wallet
      fetchProviderWindow('base', '0xWALLET', 90),
      fetchProviderWindow('base', '0xwallet', 90),
    ])

    // One goldrush call + one alchemy call = 2 real fetch() invocations total, not 4x that.
    assert.equal(getCallCount(), 3, 'expected exactly one real goldrush call and one real (2-batch) alchemy call across all 4 concurrent callers')
    for (const r of results) {
      assert.deepEqual(r, results[0], 'every concurrent caller must receive the exact same resolved result')
    }
  })

  it('a timeout/failure result is reused for the rest of the request — a later caller does not retry live', async () => {
    const { getCallCount } = mockFetch({ fail: true })

    const first = await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(first.providerStatus, 'provider_unavailable')
    const callsAfterFirst = getCallCount()
    assert.equal(callsAfterFirst, 3) // goldrush (1) + alchemy (2-batch), all failed

    // A SECOND, LATER caller for the same key (simulating the V2 engine chain reading after the old
    // pipeline already failed) must reuse the same failure result, not fire new live calls.
    const second = await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(second.providerStatus, 'provider_unavailable')
    assert.equal(getCallCount(), callsAfterFirst, 'a later caller must NOT trigger a fresh live fetch after a failure — it must reuse the request-scoped result')
  })

  it('a different chain for the same wallet remains independent — its own live fetch still happens', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    await fetchProviderWindow('base', '0xwallet', 90)
    const callsAfterBase = getCallCount()
    assert.equal(callsAfterBase, 3)

    await fetchProviderWindow('eth', '0xwallet', 90)
    assert.equal(getCallCount(), callsAfterBase + 3, 'a different chain must trigger its own real fetch, not be coalesced with base')
  })

  it('resetProviderFetchWindowRequestCache clears coalescing between scan jobs — a new job for the same wallet fetches live again', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(getCallCount(), 3)

    resetProviderFetchWindowRequestCache()

    await fetchProviderWindow('base', '0xwallet', 90)
    assert.equal(getCallCount(), 6, 'a fresh job (after reset) must not reuse a coalesced result from a prior, unrelated job')
  })
})
