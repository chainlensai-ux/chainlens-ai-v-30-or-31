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
import { priceHoldings } from './fetchPricing'
import type { ChainHolding } from '../holdings/types'

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
})
