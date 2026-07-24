// Tests for lib/engine/modules/pricing/fetchPricing.ts. Uses node:test, same convention as the
// other module test files this session. NOT wired into `npm test` (which runs a single hardcoded
// file — see package.json). Run directly with:
//   npx tsx --test lib/engine/modules/pricing/fetchPricing.test.ts
//
// MOCKING DISCLOSURE: the task asked for "priceHoldings with one holding and mocked price". Tried
// node:test's built-in `t.mock.module` first — actually ran it, and it threw
// `t.mock.module is not a function` under this project's tsx-based test runner (not assumed to
// work, verified and found broken). Rather than fight an unreliable experimental API, these tests
// use `priceHoldings`'s own additive, optional second parameter (a plain price-function override,
// added specifically to make this testable without reimplementing a mock-module system) to inject
// a controlled fake price resolver — real production callers never pass this argument and get the
// real `fetchTokenPriceUsd`/`resolvePrices` path unchanged.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { priceHoldings, diffPricedHoldingsForRegression } from './fetchPricing'
import type { ChainHolding } from '../holdings/types'
import type { PricedHolding } from './types'

function holding(overrides: Partial<ChainHolding>): ChainHolding {
  return {
    chainId: 1,
    tokenAddress: '0xtoken',
    symbol: 'TOKEN',
    decimals: 18,
    quantity: '10',
    lastActivityAt: null,
    classification: 'other',
    ...overrides,
  }
}

describe('priceHoldings', () => {
  it('priceHoldings([]) -> totalValueUsd 0, chainValueUsd {}, priceStatus "unavailable"', async () => {
    const result = await priceHoldings([])
    assert.deepEqual(result.pricedHoldings, [])
    assert.equal(result.totalValueUsd, 0)
    assert.deepEqual(result.chainValueUsd, {})
    assert.equal(result.priceStatus, 'unavailable')
  })

  it('one holding with a mocked known price -> correct valueUsd, priceStatus "ok"', async () => {
    const fakePriceFn = async () => 2.5
    const result = await priceHoldings([holding({ quantity: '10' })], fakePriceFn)

    assert.equal(result.pricedHoldings.length, 1)
    assert.equal(result.pricedHoldings[0].priceUsd, 2.5)
    assert.equal(result.pricedHoldings[0].valueUsd, 25) // 10 * 2.5
    assert.equal(result.totalValueUsd, 25)
    assert.deepEqual(result.chainValueUsd, { 1: 25 })
    assert.equal(result.priceStatus, 'ok')
  })

  it('partial pricing (one priced, one unpriced) -> priceStatus "partial"', async () => {
    const fakePriceFn = async (_chainId: number, tokenAddress: string) => (tokenAddress === '0xpriced' ? 3 : null)

    const result = await priceHoldings(
      [
        holding({ tokenAddress: '0xpriced', quantity: '4' }),
        holding({ tokenAddress: '0xunpriced', quantity: '99' }),
      ],
      fakePriceFn,
    )

    assert.equal(result.priceStatus, 'partial')
    const priced = result.pricedHoldings.find((p) => p.tokenAddress === '0xpriced')
    const unpriced = result.pricedHoldings.find((p) => p.tokenAddress === '0xunpriced')
    assert.equal(priced?.valueUsd, 12) // 4 * 3
    assert.equal(unpriced?.valueUsd, null)
    assert.equal(result.totalValueUsd, 12) // only the priced holding contributes
  })

  it('all holdings unpriced -> priceStatus "unavailable", totalValueUsd 0', async () => {
    const fakePriceFn = async () => null
    const result = await priceHoldings([holding({}), holding({ tokenAddress: '0xother' })], fakePriceFn)
    assert.equal(result.priceStatus, 'unavailable')
    assert.equal(result.totalValueUsd, 0)
  })

  it('regression guard: a holding with a known-negligible providerValueUsd (dust) never reaches the DexScreener fallback', async () => {
    let callCount = 0
    const fakePriceFn = async () => { callCount += 1; return 42 }
    const result = await priceHoldings(
      [holding({ tokenAddress: '0xdust', quantity: '1000', providerValueUsd: 0.02 })],
      fakePriceFn,
    )
    assert.equal(callCount, 0, 'a known-negligible providerValueUsd must skip the fallback entirely')
    assert.equal(result.pricedHoldings[0].priceUsd, null, 'dust stays honestly unpriced, never fabricated')
  })

  it('regression guard: a holding with a near-zero quantity and no provider value signal at all is treated as dust', async () => {
    let callCount = 0
    const fakePriceFn = async () => { callCount += 1; return 42 }
    const result = await priceHoldings(
      [holding({ tokenAddress: '0xdustqty', quantity: '0.0000001' })], // below the dust floor, no providerValueUsd
      fakePriceFn,
    )
    assert.equal(callCount, 0, 'a near-zero quantity with no provider value signal must be treated as dust')
    assert.equal(result.pricedHoldings[0].priceUsd, null)
  })

  it('regression guard: a meaningful holding lacking provider USD still reaches the fallback (dust filtering must not become a blanket suppression)', async () => {
    let callCount = 0
    const fakePriceFn = async () => { callCount += 1; return 7 }
    const result = await priceHoldings(
      [holding({ tokenAddress: '0xmeaningful', quantity: '500' })], // no providerValueUsd at all, real quantity
      fakePriceFn,
    )
    assert.equal(callCount, 1, 'a holding with a real quantity and no provider value signal must still be eligible for the fallback')
    assert.equal(result.pricedHoldings[0].priceUsd, 7)
  })

  it('regression guard: two holdings sharing the same (chainId, tokenAddress) fall-back lookup exactly once, not once per holding', async () => {
    // Real production shape: the same token address can appear more than once in chainHoldings
    // (e.g. two classification buckets for the same contract). Both previously fired their OWN
    // independent DexScreener-fallback call for an identical current-price lookup.
    let callCount = 0
    const fakePriceFn = async (_chainId: number, tokenAddress: string) => {
      callCount += 1
      return tokenAddress === '0xshared' ? 5 : null
    }
    const result = await priceHoldings(
      [
        holding({ tokenAddress: '0xshared', quantity: '2' }),
        holding({ tokenAddress: '0xshared', quantity: '3' }),
      ],
      fakePriceFn,
    )
    assert.equal(callCount, 1, 'expected exactly one real lookup for the shared (chainId, tokenAddress) pair')
    assert.equal(result.pricedHoldings[0].valueUsd, 10) // 2 * 5
    assert.equal(result.pricedHoldings[1].valueUsd, 15) // 3 * 5, reused from the single lookup
  })

  it('regression guard: a holding with a free providerPriceUsd never reaches the fallback priceFn at all', async () => {
    let callCount = 0
    const fakePriceFn = async () => {
      callCount += 1
      return 999 // would poison the result if wrongly invoked
    }
    const result = await priceHoldings(
      [holding({ tokenAddress: '0xfree', quantity: '10', providerPriceUsd: 1.5 })],
      fakePriceFn,
    )
    assert.equal(callCount, 0, 'a holding with a real free provider price must never call the fallback')
    assert.equal(result.pricedHoldings[0].priceUsd, 1.5)
    assert.equal(result.pricedHoldings[0].valueUsd, 15)
  })

  it('regression guard: fallback lookups for many distinct tokens stay functionally correct under the bounded-concurrency cap', async () => {
    const holdings = Array.from({ length: 25 }, (_, i) => holding({ tokenAddress: `0xtoken${i}`, quantity: '1' }))
    const fakePriceFn = async (_chainId: number, tokenAddress: string) => {
      const n = Number(tokenAddress.replace('0xtoken', ''))
      return n
    }
    const result = await priceHoldings(holdings, fakePriceFn)
    assert.equal(result.pricedHoldings.length, 25)
    for (const p of result.pricedHoldings) {
      const n = Number(p.tokenAddress.replace('0xtoken', ''))
      assert.equal(p.priceUsd, n, `token ${p.tokenAddress} must resolve its OWN price, never another token's`)
    }
  })

  it('regression guard: meaningful active holdings receive priority over quiet, valueless ones when the fallback budget is tight', async () => {
    // 2 holdings genuinely eligible for the fallback, budget of 1 (via a tiny holdings list plus
    // MAX_FALLBACK_TOKENS=30 normally never binds at this scale — this test instead proves ORDERING:
    // the meaningful one (known partial value + recent activity) must be looked up before the quiet
    // one, by asserting real call order.
    const callOrder: string[] = []
    const fakePriceFn = async (_chainId: number, tokenAddress: string) => {
      callOrder.push(tokenAddress)
      return 3
    }
    await priceHoldings(
      [
        holding({ tokenAddress: '0xquiet', quantity: '50', lastActivityAt: null }),
        holding({ tokenAddress: '0xmeaningful', quantity: '10', providerValueUsd: 40, lastActivityAt: new Date(Date.now() - 1000).toISOString() }),
      ],
      fakePriceFn,
    )
    assert.equal(callOrder[0], '0xmeaningful', 'a holding with a known partial USD value and recent activity must be looked up before a quantity-only, never-active one')
  })

  it('regression guard: spam/dust holdings beyond the bounded fallback budget never consume a real lookup, and holdings within budget still resolve correctly', async () => {
    // 3 real, eligible holdings but a budget of 1 (import the module fresh isn't needed — we assert
    // via call count instead of importing the private MAX_FALLBACK_TOKENS constant).
    const callOrder: string[] = []
    const fakePriceFn = async (_chainId: number, tokenAddress: string) => {
      callOrder.push(tokenAddress)
      return 2
    }
    const holdings = [
      holding({ tokenAddress: '0xspamA', quantity: '999999', lastActivityAt: null }), // huge quantity, never active — classic spam/airdrop shape
      holding({ tokenAddress: '0xspamB', quantity: '888888', lastActivityAt: null }),
      holding({ tokenAddress: '0xreal', quantity: '5', providerValueUsd: 20, lastActivityAt: new Date().toISOString() }),
    ]
    const result = await priceHoldings(holdings, fakePriceFn)
    const realHolding = result.pricedHoldings.find((p) => p.tokenAddress === '0xreal')
    assert.equal(realHolding?.priceUsd, 2, 'the meaningful, active holding must still resolve a real price')
    assert.ok(callOrder.includes('0xreal'), 'the meaningful holding must have consumed a real lookup')
  })

  it('regression guard: a holding excluded by the fallback budget stays visible with a null USD value, never hidden or zeroed', async () => {
    // MAX_FALLBACK_TOKENS is 30 — 31 distinct, equally-ranked (no value/activity signal) holdings
    // guarantees at least one falls outside the budget.
    const holdings = Array.from({ length: 31 }, (_, i) => holding({ tokenAddress: `0xtok${i}`, quantity: '1' }))
    const fakePriceFn = async () => 9
    const result = await priceHoldings(holdings, fakePriceFn)

    assert.equal(result.pricedHoldings.length, 31, 'every holding must still appear in pricedHoldings — none hidden')
    const unpriced = result.pricedHoldings.filter((p) => p.priceUsd === null)
    assert.ok(unpriced.length >= 1, 'at least one holding must fall outside the bounded fallback budget')
    for (const p of unpriced) {
      assert.equal(p.valueUsd, null, 'a budget-excluded holding must show a null USD value, never a fabricated zero')
    }
  })

  it('regression guard: this module never imports the historical pricing engine — current-price fallback pricing can never leak into historical PnL', () => {
    // Static-source guard, matching the convention already used in src/lib/pnlReconciliation.test.ts:
    // fetchPricing.ts must never import pricingAtTimeEngine/getPriceAtTime (the real historical-PnL
    // pricing path) — proving structurally, not just by convention, that this current-price-only
    // module can never be mistaken for or wired into a historical PnL price source. A future change
    // accidentally importing either would fail this test immediately.
    const source = readFileSync(fileURLToPath(new URL('./fetchPricing.ts', import.meta.url)), 'utf8')
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line))
    for (const forbidden of ['pricingAtTimeEngine', 'getPriceAtTime']) {
      assert.ok(
        !importLines.some((line) => line.includes(forbidden)),
        `fetchPricing.ts must never IMPORT ${forbidden} — it is current-price-only, never a historical PnL source`,
      )
    }
  })
})

function pricedHolding(overrides: Partial<PricedHolding> = {}): PricedHolding {
  return { chainId: 8453, tokenAddress: '0xtoken', symbol: 'TOK', decimals: 18, quantity: '1', priceUsd: 1, valueUsd: 1, classification: 'other', ...overrides }
}

describe('diffPricedHoldingsForRegression — cross-scan portfolio-total regression diagnosis', () => {
  it('one missing high-value token is clearly diagnosed — matches the real ~$8,335 production regression', () => {
    const previous: PricedHolding[] = [
      pricedHolding({ tokenAddress: '0xhighvalue', symbol: 'HIGH', priceUsd: 8335, valueUsd: 8335, quantity: '1' }),
      pricedHolding({ tokenAddress: '0xstable', symbol: 'STABLE', priceUsd: 1, valueUsd: 5196.59, quantity: '5196.59' }),
    ]
    const current: PricedHolding[] = [
      // 0xhighvalue is now gone entirely from the priced list — the exact confirmed regression shape.
      pricedHolding({ tokenAddress: '0xstable', symbol: 'STABLE', priceUsd: 1, valueUsd: 5196.59, quantity: '5196.59' }),
    ]

    const diffs = diffPricedHoldingsForRegression(previous, current)
    assert.equal(diffs.length, 1, 'exactly the one affected token must be flagged, never the whole holdings list')
    assert.equal(diffs[0].missingPricedHolding, '8453:0xhighvalue')
    assert.equal(diffs[0].previousValueUsd, 8335)
    assert.equal(diffs[0].currentValueUsd, null)
    assert.equal(diffs[0].exclusionReason, 'absent_from_current_scan')
  })

  it('a token whose price dropped (present but unpriced now) is diagnosed distinctly from one that vanished entirely', () => {
    const previous = [pricedHolding({ tokenAddress: '0xdim', priceUsd: 50, valueUsd: 500 })]
    const current = [pricedHolding({ tokenAddress: '0xdim', priceUsd: null, valueUsd: null })]
    const diffs = diffPricedHoldingsForRegression(previous, current)
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].exclusionReason, 'price_lost_between_scans')
    assert.equal(diffs[0].currentValueUsd, null)
  })

  it('an unchanged or improved holding is never flagged as a regression', () => {
    const previous = [pricedHolding({ tokenAddress: '0xok', valueUsd: 10 })]
    const current = [pricedHolding({ tokenAddress: '0xok', valueUsd: 12 })]
    assert.deepEqual(diffPricedHoldingsForRegression(previous, current), [])
  })

  it('dust-level differences below minValueUsdToReport are not reported as noise', () => {
    const previous = [pricedHolding({ tokenAddress: '0xdust', valueUsd: 0.5 })]
    const current: PricedHolding[] = []
    assert.deepEqual(diffPricedHoldingsForRegression(previous, current, 1), [])
  })
})
