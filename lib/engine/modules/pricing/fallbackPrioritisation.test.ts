// Tests for the holdings-coverage fallback prioritisation in lib/engine/modules/pricing/fetchPricing.ts.
//
// CONFIRMED ROOT CAUSE these cover (real production evidence: 1,581 holdings discovered / 107 priced
// / 1,346 fallback-eligible / only 30 looked up / 1,316 left unpriced by budget, with a canonical
// total far below the wallet's expected value): the prior ranking was, in practice, RAW QUANTITY
// DESCENDING — its providerValueUsd lane is absent for almost every fallback-eligible holding, and
// its lastActivityAt lane is dead (hardcoded null for every holding by fetchHoldings.ts). Raw unit
// count is precisely the axis spam/airdrop tokens maximize, so the same spam consumed the same 30
// lookups on every scan while genuinely valuable holdings were never checked.
//
// NO HARDCODED PORTFOLIO TOTAL, DISCLOSED: these assert ORDERING and BUDGET behaviour only — never
// that any particular dollar figure is correct.
//
// Run with:
//   npx tsx --test lib/engine/modules/pricing/fallbackPrioritisation.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  priceHoldings,
  estimateMaterialityUsd,
  isWellFormedSymbol,
  buildUnpricedHoldingDiagnostics,
} from './fetchPricing'
import type { ChainHolding } from '../holdings/types'
import type { PricedHolding } from './types'

function holding(overrides: Partial<ChainHolding>): ChainHolding {
  return {
    chainId: 8453,
    tokenAddress: '0xtoken',
    symbol: 'TOKEN',
    decimals: 18,
    quantity: '10',
    lastActivityAt: null,
    classification: 'other',
    ...overrides,
  }
}

// Records the order priceFn was called in — the real, observable proof of ranking.
function recordingPriceFn(): { fn: (chainId: number, token: string) => Promise<number | null>; order: string[] } {
  const order: string[] = []
  return {
    order,
    fn: async (_chainId: number, tokenAddress: string) => {
      order.push(tokenAddress)
      return null // never fabricate a price — ordering is what's under test
    },
  }
}

describe('fallback prioritisation — likely USD materiality, not raw unit count', () => {
  it('a valuable-looking holding ranks above obvious high-unit-count spam (the confirmed regression)', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        // Classic spam shape: astronomically large unit count, which the OLD ranking maximized.
        holding({ tokenAddress: '0xspam', symbol: 'CLAIM', quantity: '900000000000000' }),
        // A real, provider-value-backed position with a far smaller unit count.
        holding({ tokenAddress: '0xreal', symbol: 'REAL', quantity: '2.5', providerValueUsd: 480 }),
      ],
      fn,
    )
    assert.equal(order[0], '0xreal', 'a provider-value-backed holding must be looked up before high-unit-count spam')
  })

  it('raw unit count alone can no longer dominate the queue', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        holding({ tokenAddress: '0xspam', symbol: 'AIRDROP', quantity: '999999999999' }),
        holding({ tokenAddress: '0xweth', symbol: 'WETH', quantity: '0.04', classification: 'blue_chip' }),
      ],
      fn,
    )
    assert.equal(order[0], '0xweth', 'a tiny wrapped-native balance must outrank a huge spam unit count')
  })
})

describe('fallback prioritisation — native / wrapped-native / stablecoin assets receive priority', () => {
  it('stablecoins rank above blue-chip, which ranks above unclassified tokens', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        holding({ tokenAddress: '0xother', symbol: 'RANDOM', quantity: '5000' }),
        holding({ tokenAddress: '0xweth', symbol: 'WETH', quantity: '0.01', classification: 'blue_chip' }),
        holding({ tokenAddress: '0xusdc', symbol: 'USDC', quantity: '120', classification: 'stable' }),
      ],
      fn,
    )
    assert.deepEqual(order, ['0xusdc', '0xweth', '0xother'])
  })

  it('stablecoins are ordered among themselves by their real ~$1/unit materiality estimate', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        holding({ tokenAddress: '0xsmallstable', symbol: 'DAI', quantity: '4', classification: 'stable' }),
        holding({ tokenAddress: '0xbigstable', symbol: 'USDC', quantity: '900', classification: 'stable' }),
      ],
      fn,
    )
    assert.deepEqual(order, ['0xbigstable', '0xsmallstable'])
  })

  it('a malformed-symbol row ranks below a well-formed one of the same class', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        // '?' is this codebase's placeholder for an Alchemy row with no metadata (decimals also
        // defaulted to 18), so its quantity is unreliable.
        holding({ tokenAddress: '0xnometa', symbol: '?', quantity: '5000' }),
        holding({ tokenAddress: '0xnamed', symbol: 'NAMED', quantity: '10' }),
      ],
      fn,
    )
    assert.equal(order[0], '0xnamed')
  })

  it('an advertising-shaped spam symbol ranks below a well-formed one', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        holding({ tokenAddress: '0xadvert', symbol: 'claim at site.com', quantity: '100000' }),
        holding({ tokenAddress: '0xclean', symbol: 'CLEAN', quantity: '3' }),
      ],
      fn,
    )
    assert.equal(order[0], '0xclean')
  })
})

describe('fallback budget — exactly 30, never consumed by malformed or zero balances', () => {
  it('the cap remains exactly 30 real lookups regardless of how many holdings are eligible', async () => {
    const { fn, order } = recordingPriceFn()
    const holdings = Array.from({ length: 400 }, (_, i) =>
      holding({ tokenAddress: `0xtok${String(i).padStart(4, '0')}`, symbol: `T${i}`, quantity: '100' }),
    )
    await priceHoldings(holdings, fn)
    assert.equal(order.length, 30, 'the fallback budget must remain exactly 30 — never widened by this change')
  })

  it('zero, negative and malformed balances never consume a slot of the budget', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        holding({ tokenAddress: '0xzero', symbol: 'ZERO', quantity: '0' }),
        holding({ tokenAddress: '0xnegative', symbol: 'NEG', quantity: '-5' }),
        holding({ tokenAddress: '0xnan', symbol: 'NAN', quantity: 'not-a-number' }),
        holding({ tokenAddress: '0xempty', symbol: 'EMPTY', quantity: '' }),
        holding({ tokenAddress: '0xreal', symbol: 'REAL', quantity: '10' }),
      ],
      fn,
    )
    assert.deepEqual(order, ['0xreal'], 'only the one real, non-zero balance may consume budget')
  })

  it('a known-negligible provider value never consumes a slot', async () => {
    const { fn, order } = recordingPriceFn()
    await priceHoldings(
      [
        holding({ tokenAddress: '0xnegligible', symbol: 'TINY', quantity: '1000', providerValueUsd: 0.02 }),
        holding({ tokenAddress: '0xreal', symbol: 'REAL', quantity: '10' }),
      ],
      fn,
    )
    assert.deepEqual(order, ['0xreal'])
  })
})

describe('fallback prioritisation — deterministic ordering', () => {
  it('identical signals resolve identically regardless of input order', async () => {
    const a = holding({ tokenAddress: '0xaaa', symbol: 'AAA', quantity: '100' })
    const b = holding({ tokenAddress: '0xbbb', symbol: 'BBB', quantity: '100' })

    const first = recordingPriceFn()
    await priceHoldings([a, b], first.fn)
    const second = recordingPriceFn()
    await priceHoldings([b, a], second.fn)

    assert.deepEqual(first.order, second.order, 'tied holdings must always resolve to the same deterministic order')
  })

  it('repeated runs over the same holdings select the same 30 tokens', async () => {
    const holdings = Array.from({ length: 60 }, (_, i) =>
      holding({ tokenAddress: `0xt${String(i).padStart(3, '0')}`, symbol: `S${i}`, quantity: String(1000 - i) }),
    )
    const first = recordingPriceFn()
    await priceHoldings(holdings, first.fn)
    const second = recordingPriceFn()
    await priceHoldings([...holdings].reverse(), second.fn)

    assert.deepEqual([...first.order].sort(), [...second.order].sort(), 'the selected budget set must not depend on provider response ordering')
  })
})

describe('totals remain derived only from verified prices', () => {
  it('an unpriced holding contributes nothing to the total and stays visible with null value', async () => {
    const { fn } = recordingPriceFn() // always returns null
    const result = await priceHoldings(
      [
        holding({ tokenAddress: '0xa', symbol: 'A', quantity: '100' }),
        holding({ tokenAddress: '0xb', symbol: 'B', quantity: '200' }),
      ],
      fn,
    )
    assert.equal(result.totalValueUsd, 0, 'no materiality ESTIMATE may ever leak into the canonical total')
    for (const p of result.pricedHoldings) {
      assert.equal(p.priceUsd, null)
      assert.equal(p.valueUsd, null, 'an unpriced holding stays null — never zero, never an estimate')
    }
  })

  it('the materiality estimate used for ranking is never written to priceUsd/valueUsd', async () => {
    const result = await priceHoldings(
      [holding({ tokenAddress: '0xusdc', symbol: 'USDC', quantity: '500', classification: 'stable' })],
      async () => null,
    )
    assert.equal(result.pricedHoldings[0].priceUsd, null)
    assert.equal(result.pricedHoldings[0].valueUsd, null, 'a stablecoin peg estimate must never become a real price')
    assert.equal(result.totalValueUsd, 0)
  })
})

describe('estimateMaterialityUsd / isWellFormedSymbol — pure local signals, never fabricated', () => {
  it('prefers a real provider value over any estimate', () => {
    assert.equal(estimateMaterialityUsd(holding({ providerValueUsd: 42, quantity: '999', classification: 'stable' })), 42)
  })

  it('estimates a stablecoin from its unit count', () => {
    assert.equal(estimateMaterialityUsd(holding({ symbol: 'USDC', quantity: '250', classification: 'stable' })), 250)
  })

  it('returns null — never a guess — when there is no local basis to estimate', () => {
    assert.equal(estimateMaterialityUsd(holding({ symbol: 'RANDOM', quantity: '1000' })), null)
    assert.equal(estimateMaterialityUsd(holding({ symbol: 'WETH', quantity: '2', classification: 'blue_chip' })), null)
  })

  it('recognises malformed symbol shapes without excluding real ones', () => {
    for (const good of ['USDC', 'WETH', 'FreeCode', 'TORIVA', 'cbBTC']) {
      assert.equal(isWellFormedSymbol(good), true, `${good} must be treated as well-formed`)
    }
    for (const bad of ['?', '', '   ', 'claim at site.com', 'visit x.com/claim', 'A'.repeat(40)]) {
      assert.equal(isWellFormedSymbol(bad), false, `${JSON.stringify(bad)} must be treated as malformed`)
    }
  })
})

describe('buildUnpricedHoldingDiagnostics — one record per unpriced holding', () => {
  function priced(overrides: Partial<PricedHolding> = {}): PricedHolding {
    return { chainId: 8453, tokenAddress: '0xtoken', symbol: 'TOKEN', decimals: 18, quantity: '10', priceUsd: null, valueUsd: null, classification: 'other', ...overrides }
  }

  it('emits a record for every unpriced holding and none for priced ones', () => {
    const holdings = [
      holding({ tokenAddress: '0xpriced', symbol: 'P' }),
      holding({ tokenAddress: '0xunpriced', symbol: 'U' }),
    ]
    const pricedHoldings = [
      priced({ tokenAddress: '0xpriced', priceUsd: 2, valueUsd: 20 }),
      priced({ tokenAddress: '0xunpriced' }),
    ]
    const diagnostics = buildUnpricedHoldingDiagnostics({
      holdings,
      pricedHoldings,
      rankedFallbackKeys: ['8453:0xunpriced'],
      budgetedFallbackKeys: ['8453:0xunpriced'],
      keyOf: (h) => `${h.chainId}:${h.tokenAddress.toLowerCase()}`,
    })
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].tokenAddress, '0xunpriced')
  })

  it('carries every required diagnostic field', () => {
    const diagnostics = buildUnpricedHoldingDiagnostics({
      holdings: [holding({ tokenAddress: '0xu', symbol: 'USDC', quantity: '75', classification: 'stable' })],
      pricedHoldings: [priced({ tokenAddress: '0xu' })],
      rankedFallbackKeys: ['8453:0xu'],
      budgetedFallbackKeys: [],
      keyOf: (h) => `${h.chainId}:${h.tokenAddress.toLowerCase()}`,
    })
    const d = diagnostics[0]
    for (const field of [
      'chainId', 'tokenAddress', 'symbol', 'quantity', 'providerPriceUsd', 'providerValueUsd',
      'fallbackEligible', 'fallbackRank', 'selectedForFallback', 'skipReason', 'knownBalanceSignal',
      'currentTransferRecency', 'estimatedMaterialitySignal',
    ]) {
      assert.ok(field in d, `missing required diagnostic field: ${field}`)
    }
    assert.equal(d.skipReason, 'outside_fallback_budget')
    assert.equal(d.knownBalanceSignal, 'stable_unit_peg')
    assert.equal(d.estimatedMaterialitySignal, 75)
    assert.equal(d.currentTransferRecency, null, 'reported as the real null it is, never fabricated')
  })

  it('distinguishes the real skip reasons', () => {
    const keyOf = (h: ChainHolding) => `${h.chainId}:${h.tokenAddress.toLowerCase()}`
    const holdings = [
      holding({ tokenAddress: '0xzero', quantity: '0' }),
      holding({ tokenAddress: '0xnegligible', quantity: '10', providerValueUsd: 0.5 }),
      holding({ tokenAddress: '0xbudget', quantity: '10' }),
      holding({ tokenAddress: '0xnoprice', quantity: '10' }),
    ]
    const diagnostics = buildUnpricedHoldingDiagnostics({
      holdings,
      pricedHoldings: holdings.map((h) => priced({ tokenAddress: h.tokenAddress })),
      rankedFallbackKeys: ['8453:0xbudget', '8453:0xnoprice'],
      budgetedFallbackKeys: ['8453:0xnoprice'],
      keyOf,
    })
    const byToken = new Map(diagnostics.map((d) => [d.tokenAddress, d]))
    assert.equal(byToken.get('0xzero')?.skipReason, 'zero_or_malformed_quantity')
    assert.equal(byToken.get('0xnegligible')?.skipReason, 'known_negligible_provider_value')
    assert.equal(byToken.get('0xbudget')?.skipReason, 'outside_fallback_budget')
    assert.equal(byToken.get('0xnoprice')?.skipReason, 'fallback_lookup_returned_no_price')
  })
})
