// Tests for lib/engine/modules/portfolio/buildPortfolio.ts. Uses node:test, same convention as the
// other module test files this session. NOT wired into `npm test` (which runs a single hardcoded
// file — see package.json). Run directly with:
//   npx tsx --test lib/engine/modules/portfolio/buildPortfolio.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPortfolio } from './buildPortfolio'
import type { PricedHolding } from '../pricing/types'

function priced(overrides: Partial<PricedHolding>): PricedHolding {
  return {
    chainId: 1,
    tokenAddress: '0xtoken',
    symbol: 'TOKEN',
    decimals: 18,
    quantity: '10',
    priceUsd: 10,
    valueUsd: 100,
    classification: 'other',
    ...overrides,
  }
}

describe('buildPortfolio', () => {
  it('empty case -> portfolioStatus "empty", all-zero portfolio', async () => {
    const result = await buildPortfolio([], 0, {})
    assert.equal(result.portfolioStatus, 'empty')
    assert.equal(result.portfolio.totalValueUsd, 0)
    assert.deepEqual(result.portfolio.categories, [])
    assert.deepEqual(result.portfolio.chains, [])
    assert.deepEqual(result.portfolio.topHoldings, [])
    assert.equal(result.portfolio.stablecoinRatio, 0)
    assert.equal(result.portfolio.concentrationIndex, 0)
  })

  it('single stable holding -> stablecoinRatio 1, topHoldings length 1, categories length 1', async () => {
    const holdings: PricedHolding[] = [priced({ valueUsd: 100, classification: 'stable', chainId: 1 })]
    const result = await buildPortfolio(holdings, 100, { 1: 100 })

    assert.equal(result.portfolioStatus, 'ok')
    assert.equal(result.portfolio.stablecoinRatio, 1)
    assert.equal(result.portfolio.topHoldings.length, 1)
    assert.equal(result.portfolio.categories.length, 1)
    assert.equal(result.portfolio.categories[0].category, 'stable')
    assert.equal(result.portfolio.categories[0].percentage, 1)
    assert.equal(result.portfolio.topHoldings[0].percentage, 1)
  })

  it('partial pricing (some null valueUsd) -> portfolioStatus "partial"', async () => {
    const holdings: PricedHolding[] = [
      priced({ tokenAddress: '0xpriced', valueUsd: 50, priceUsd: 5 }),
      priced({ tokenAddress: '0xunpriced', valueUsd: null, priceUsd: null }),
    ]
    const result = await buildPortfolio(holdings, 50, { 1: 50 })

    assert.equal(result.portfolioStatus, 'partial')
    // The unpriced holding contributes 0 to category/chain totals and is excluded from topHoldings
    // (nothing real to rank it by) — see buildPortfolio.ts's own disclosure on this.
    assert.equal(result.portfolio.topHoldings.length, 1)
    assert.equal(result.portfolio.topHoldings[0].tokenAddress, '0xpriced')
  })

  it('multi-chain -> correct per-chain percentages', async () => {
    const holdings: PricedHolding[] = [
      priced({ chainId: 1, tokenAddress: '0xa', valueUsd: 75 }),
      priced({ chainId: 8453, tokenAddress: '0xb', valueUsd: 25 }),
    ]
    const result = await buildPortfolio(holdings, 100, { 1: 75, 8453: 25 })

    assert.equal(result.portfolioStatus, 'ok')
    const chain1 = result.portfolio.chains.find((c) => c.chainId === 1)
    const chain8453 = result.portfolio.chains.find((c) => c.chainId === 8453)
    assert.equal(chain1?.percentage, 0.75)
    assert.equal(chain8453?.percentage, 0.25)
    assert.equal(result.portfolio.chains.length, 2)
  })

  it('concentrationIndex is the sum of top-5 holdings\' percentages', async () => {
    const holdings: PricedHolding[] = [
      priced({ tokenAddress: '0xa', valueUsd: 40 }),
      priced({ tokenAddress: '0xb', valueUsd: 30 }),
      priced({ tokenAddress: '0xc', valueUsd: 30 }),
    ]
    const result = await buildPortfolio(holdings, 100, { 1: 100 })
    assert.equal(result.portfolio.concentrationIndex, 1) // 0.4 + 0.3 + 0.3 = 1 (only 3 holdings, all in top 5)
  })
})
