// Tests for src/modules/providerFetchWindow/index.ts's request-scoped promise coalescing
// (fetchProviderWindow / resetProviderFetchWindowRequestCache). Mocks global.fetch (no real network
// dependency), same pattern already used by lib/server/dustPriceCheck.test.ts. Run directly with:
//   npx tsx --test src/modules/providerFetchWindow/coalescing.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchProviderWindow, resetProviderFetchWindowRequestCache, getProviderFetchWindowCoalescingCounters } from './index'

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

  it('mixed 30/60/90-day consumers reuse ONE 90-day live fetch, in any order among the narrower consumers, once the canonical (widest) window is established', async () => {
    // 30 and 60 both clamp to PROVIDER_FETCH_WINDOW_DAYS_MIN (80) via clampWindowDays — real
    // production behavior, not a test artifact. This mirrors this codebase's real architecture: the
    // old pipeline (always requesting the canonical 90-day window) runs to completion BEFORE the V2
    // engine chain's own, possibly-narrower requests ever start (workers/walletScanV2.ts awaits
    // router.handleScanRequest first) — so the widest window is always established first in real
    // production call order, and every later consumer, regardless of ITS OWN relative order, reuses
    // it rather than re-fetching.
    for (const laterOrder of [[30, 60], [60, 30]] as const) {
      resetProviderFetchWindowRequestCache()
      const { getCallCount } = mockFetch({ delayMs: 5 })

      const canonical = await fetchProviderWindow('base', '0xwallet', 90, 'old-pipeline')
      assert.equal(getCallCount(), 3, 'the canonical 90-day fetch must be the only real call so far')

      const laterResults = await Promise.all(laterOrder.map((d) => fetchProviderWindow('base', '0xwallet', d, 'v2-engine')))

      assert.equal(getCallCount(), 3, `later order ${laterOrder.join(',')}: narrower consumers must reuse the canonical fetch, never re-fetch`)
      assert.equal(canonical.providerFetchWindowDays, 90)
      for (const r of laterResults) {
        assert.ok(r.providerFetchWindowDays <= 90, `later order ${laterOrder.join(',')}: a narrower consumer must never receive a window wider than what it asked for`)
      }
    }
  })

  it('regression guard: a caller requesting a wider window that a concurrent narrower caller is ALREADY IN FLIGHT for reuses that in-flight fetch (largest-window reuse, not keyed by exact window)', async () => {
    // PROVIDER_FETCH_WINDOW_DAYS_MIN is 80 (clampWindowDays), so 85 stays a genuinely narrower-than-90
    // but still valid window — real production values, not an artificially clamped one.
    const { getCallCount } = mockFetch({ delayMs: 5 })

    // 90d requested FIRST (wider) — synchronously registers its in-flight entry before the 85d call
    // is even evaluated, since Promise.all evaluates its array left-to-right and this module's
    // synchronous registration happens before any await point.
    const [ninetyDay, eightyFiveDay] = await Promise.all([
      fetchProviderWindow('base', '0xwallet', 90),
      fetchProviderWindow('base', '0xwallet', 85),
    ])

    assert.equal(getCallCount(), 3, 'only ONE real 2-provider fetch (at the wider 90d window) should ever fire, not two')
    assert.equal(ninetyDay.providerFetchWindowDays, 90)
    assert.equal(eightyFiveDay.providerFetchWindowDays, 85, 'the narrower caller must get back a result honestly labeled as its OWN requested window, not the wider one')
  })

  it('regression guard: requesting the narrower window AFTER a wider one has already settled still reuses it (a later wider request never reuses a narrower one)', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    // 90d requested first (wider) — establishes the entry other callers can reuse.
    await fetchProviderWindow('base', '0xwallet', 90)
    const callsAfterWide = getCallCount()
    assert.equal(callsAfterWide, 3)

    // A LATER, narrower 85d caller for the SAME wallet+chain must reuse the already-settled 90d
    // result (sliced locally), never fire its own live call.
    const narrower = await fetchProviderWindow('base', '0xwallet', 85)
    assert.equal(getCallCount(), callsAfterWide, 'a narrower request arriving after a wider settled fetch must reuse it, never refetch')
    assert.equal(narrower.providerFetchWindowDays, 85)

    // A caller requesting something WIDER than anything seen so far must still trigger its own
    // fresh, real fetch — a narrower prior result can never be silently reused as if it were wider.
    await fetchProviderWindow('base', '0xwallet', 120)
    assert.equal(getCallCount(), callsAfterWide + 3, 'a request wider than any known entry must trigger its own real fetch')
  })

  it('resetProviderFetchWindowRequestCache runs exactly once per job — counters reflect real per-job activity, not cumulative drift', async () => {
    mockFetch({ delayMs: 5 })
    const before = getProviderFetchWindowCoalescingCounters().resetCount

    resetProviderFetchWindowRequestCache() // simulates walletScanWorker.ts's single per-job reset
    const afterOneReset = getProviderFetchWindowCoalescingCounters().resetCount
    assert.equal(afterOneReset, before + 1, 'exactly one reset must be recorded for one job start')

    await fetchProviderWindow('base', '0xwallet', 90)
    await fetchProviderWindow('base', '0xwallet', 90)
    const counters = getProviderFetchWindowCoalescingCounters()
    assert.equal(counters.liveFetches, 1, 'exactly one real live fetch for the two same-window calls in this job')
    assert.equal(counters.settledReuseHits, 1, 'the second, already-settled call must count as a settled reuse hit')
    assert.equal(counters.resetCount, before + 1, 'resetCount must not have incremented again mid-job — reset only happens at job start')
  })

  it('canonical wallet/chain variants (mixed case, surrounding whitespace) share exactly one key/entry', async () => {
    const { getCallCount } = mockFetch({ delayMs: 5 })

    const results = await Promise.all([
      fetchProviderWindow('base', '  0xWaLLeT  ', 90),
      fetchProviderWindow('base', '0xwallet', 90),
      fetchProviderWindow('base', '0XWALLET', 90),
    ])

    assert.equal(getCallCount(), 3, 'all three canonically-identical wallet variants must coalesce into one real fetch')
    for (const r of results) {
      assert.deepEqual(r, results[0], 'every canonical-variant caller must receive the exact same resolved result')
    }
  })

  it('regression guard: the same already-settled result is reused byte-for-byte, not recomputed, on a later call', async () => {
    mockFetch({ delayMs: 5 })

    const first = await fetchProviderWindow('base', '0xwallet', 90)
    const second = await fetchProviderWindow('base', '0xwallet', 90)
    assert.deepEqual(second, first, 'a later call for the identical (chain, wallet, window) must return the exact same settled result object contents')
  })
})
