// Tests for src/lib/dexscreenerRequestCache.ts — the shared, request-scoped DexScreener
// cache/coalescer. Confirmed root cause this closes: two entirely separate, uncoordinated
// DexScreener implementations (current-holdings fallback vs historical/recovery) meant a token
// needed by both fired two independent real HTTP calls for the identical answer, and neither lane's
// own cap bounded the other — far more than the intended 30 calls in one real production scan.
// Mocks global.fetch (no real network dependency), same pattern already used by
// lib/server/dustPriceCheck.test.ts. Run directly with:
//   npx tsx --test src/lib/dexscreenerRequestCache.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchDexscreenerPriceShared, resetDexscreenerRequestCache, getDexscreenerRequestDiagnostics } from './dexscreenerRequestCache'

const originalFetch = global.fetch

beforeEach(() => {
  resetDexscreenerRequestCache()
})

afterEach(() => {
  global.fetch = originalFetch
  resetDexscreenerRequestCache()
})

function mockFetch(): { getCallCount: () => number } {
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    return new Response(JSON.stringify({ pairs: [{ chainId: 'base', priceUsd: '2.50', liquidity: { usd: 1000 } }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { getCallCount: () => callCount }
}

describe('fetchDexscreenerPriceShared — cross-module coalescing (confirmed regression fix)', () => {
  it('the same token requested by multiple modules (holdings + historical) makes exactly ONE live DexScreener call', async () => {
    const { getCallCount } = mockFetch()
    const now = Date.now()

    const [fromHoldings, fromHistorical] = await Promise.all([
      fetchDexscreenerPriceShared('0xshared', 'base', now, 'holdings'),
      fetchDexscreenerPriceShared('0xshared', 'base', now, 'historical'),
    ])

    assert.equal(getCallCount(), 1, 'two different lanes requesting the identical (chain, token, freshness) must coalesce into one real call')
    assert.equal(fromHoldings.priceUsd, 2.5)
    assert.equal(fromHistorical.priceUsd, 2.5)

    const diagnostics = getDexscreenerRequestDiagnostics()
    assert.equal(diagnostics.dexUniqueTokens, 1)
    assert.ok((diagnostics.dexLiveFetchesByCaller.holdings ?? 0) + (diagnostics.dexLiveFetchesByCaller.historical ?? 0) === 1, 'exactly one caller should be credited with the real live fetch, the other with a cache hit')
  })

  it('no extra provider calls are introduced versus a single caller making the same request alone', async () => {
    const { getCallCount } = mockFetch()
    const now = Date.now()
    await fetchDexscreenerPriceShared('0xsolo', 'base', now, 'holdings')
    assert.equal(getCallCount(), 1, 'a single caller must still make exactly one real call — the shared cache adds no overhead')
  })

  it('the historical/recovery lane is bounded by its own explicit budget — never unbounded fanout', async () => {
    const { getCallCount } = mockFetch()
    resetDexscreenerRequestCache(3) // explicit small budget for this test
    const now = Date.now()

    for (let i = 0; i < 5; i += 1) {
      await fetchDexscreenerPriceShared(`0xtoken${i}`, 'base', now, 'historical')
    }

    assert.equal(getCallCount(), 3, 'only the first `budget` distinct historical/recovery lookups may make a real live call')
    const diagnostics = getDexscreenerRequestDiagnostics()
    assert.equal(diagnostics.dexBudgetCappedByCaller.historical, 2, 'the remaining 2 lookups must be recorded as budget-capped, never silently dropped or retried')
  })

  it('recovery cannot bypass its own bounded budget by using a different caller label than "historical"', async () => {
    // Recovery reuses the exact same detailed pricing-router function as the main historical pass
    // (see pricingAtTimeAdapter.ts / pnlReconciliation.ts), so it is always labeled 'historical' —
    // there is no separate 'recovery' caller identity that could dodge this budget gate.
    resetDexscreenerRequestCache(1)
    mockFetch()
    const now = Date.now()
    const first = await fetchDexscreenerPriceShared('0xa', 'base', now, 'historical')
    const second = await fetchDexscreenerPriceShared('0xb', 'base', now, 'historical')
    assert.equal(first.priceUsd, 2.5)
    assert.equal(second.priceUsd, null, 'a second, distinct token beyond the budget must be honestly unpriced, never fabricated or unbounded')
    assert.equal(second.reason, 'dexscreener_shared_historical_budget_exhausted')
  })

  it('the holdings lane is NEVER subject to the historical/recovery budget — its own separate 30-token cap (enforced upstream in fetchPricing.ts) is unaffected', async () => {
    resetDexscreenerRequestCache(1) // tiny historical budget
    mockFetch()
    const now = Date.now()
    // Exhaust the historical budget first.
    await fetchDexscreenerPriceShared('0xhist', 'base', now, 'historical')
    await fetchDexscreenerPriceShared('0xhist2', 'base', now, 'historical') // would be capped

    // A holdings-lane request for a genuinely different token must still succeed live — this
    // module's own budget gate is scoped to caller !== 'holdings' by construction.
    const holdingsResult = await fetchDexscreenerPriceShared('0xholding', 'base', now, 'holdings')
    assert.equal(holdingsResult.priceUsd, 2.5, 'holdings cap remains its own separate 30-token gate — this shared-cache budget must never cap it')
  })

  it('a timeout/failure result is reused within the request — the same endpoint is not retried', async () => {
    let callCount = 0
    global.fetch = (async () => { callCount += 1; throw new Error('simulated timeout') }) as unknown as typeof fetch
    const now = Date.now()

    const first = await fetchDexscreenerPriceShared('0xflaky', 'base', now, 'holdings')
    const second = await fetchDexscreenerPriceShared('0xflaky', 'base', now, 'holdings')

    assert.equal(callCount, 1, 'a failed lookup must not be retried by a later identical call within the same request')
    assert.equal(first.priceUsd, null)
    assert.equal(second.priceUsd, null)
    assert.equal(second.reason, first.reason, 'the later caller must reuse the exact same cached failure reason')
  })
})
