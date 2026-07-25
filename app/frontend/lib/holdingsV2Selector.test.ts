// Tests for app/frontend/lib/holdingsV2Selector.ts — the canonical Holdings V2 display selector.
// Real production evidence this closes: Portfolio Intelligence correctly showed FreeCode as 89% of
// a $3,365.52 total, while Holdings V2 showed FreeCode absent entirely and its Base chain total at
// only $337.62 — because Holdings V2 read a separate, disconnected `holdings: TokenHolding[]`
// instead of the canonical `pricedHoldings`/`chainValueUsd` portfolioV2.totalValueUsd is built from.
// Uses node:test, same convention as this codebase's other module test files. Run with:
//   npx tsx --test app/frontend/lib/holdingsV2Selector.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectHoldingsV2 } from './holdingsV2Selector'
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'

function priced(overrides: Partial<PricedHolding> = {}): PricedHolding {
  return { chainId: 8453, tokenAddress: '0xtoken', symbol: 'TOKEN', decimals: 18, quantity: '1', priceUsd: 1, valueUsd: 1, classification: 'other', ...overrides }
}

describe('selectHoldingsV2 — canonical Holdings V2 selector (confirmed regression fix)', () => {
  it('the real FreeCode-shaped $3k holding (dominant, ~89% of portfolio) is visible, never dust-hidden, and sorts first', () => {
    const freeCode = priced({ tokenAddress: '0xfreecode', symbol: 'FreeCode', quantity: '2288000000', decimals: 9, priceUsd: 0.000002625, valueUsd: 3005.73 })
    const second = priced({ tokenAddress: '0xtoriva', symbol: 'TORIVA', quantity: '1000', valueUsd: 256.82 })
    const nemesis = priced({ tokenAddress: '0xnemesis', symbol: 'NEMESIS', quantity: '1', valueUsd: 1.84 })

    const result = selectHoldingsV2([second, nemesis, freeCode], { 8453: 3005.73 + 256.82 + 1.84 })

    assert.equal(result.meaningfulHoldings.length, 3, 'all three real, priced holdings must be visible')
    assert.equal(result.meaningfulHoldings[0].symbol, 'FreeCode', 'the dominant holding must sort first, value-descending')
    assert.equal(result.meaningfulHoldings[0].providerValueUsd, 3005.73)
  })

  it('a dominant, priced, airdrop-classified holding remains visible — acquisition/airdrop classification is never consulted by this selector', () => {
    // This selector has no concept of acquisition source at all (see its own header) — a dominant
    // holding is visible purely because valueUsd > 0, regardless of how it was acquired.
    const airdropped = priced({ tokenAddress: '0xairdrop', symbol: 'AIRDROP', valueUsd: 5000 })
    const result = selectHoldingsV2([airdropped], { 8453: 5000 })
    assert.equal(result.meaningfulHoldings.length, 1)
    assert.equal(result.meaningfulHoldings[0].symbol, 'AIRDROP')
  })

  it('dust classification uses valueUsd only — a low-quantity, thin-decimals holding worth well above the dust threshold is NEVER dust-collapsed', () => {
    // Exactly FreeCode's own real shape: a tiny human-readable quantity (9 decimals) that a
    // quantity-based dust filter would have wrongly flagged, but whose real USD value is large.
    const freeCodeShaped = priced({ tokenAddress: '0xthin', symbol: 'THIN', quantity: '2.288', decimals: 9, valueUsd: 3005.73 })
    const result = selectHoldingsV2([freeCodeShaped], { 8453: 3005.73 })
    assert.equal(result.meaningfulHoldings.length, 1, 'a real, valuable holding must never be dust-collapsed based on its tiny quantity')
    assert.equal(result.dustHoldings.length, 0)
  })

  it('a holding below the value-only dust threshold is collapsed into the dust bucket, never hidden entirely', () => {
    const dust = priced({ tokenAddress: '0xdust', symbol: 'DUST', valueUsd: 0.05 })
    const result = selectHoldingsV2([dust], { 8453: 0.05 })
    assert.equal(result.meaningfulHoldings.length, 0)
    assert.equal(result.dustHoldings.length, 1, 'a real, tiny-but-priced holding must still appear in the (collapsible) dust bucket, never disappear')
    assert.equal(result.diagnostics.excludedPricedHoldings.length, 0, 'a real, nonzero-valued holding must never be counted as excluded')
  })

  it('only a genuinely zero/unpriced holding is excluded — never a holding with any real positive value', () => {
    const unpriced = priced({ tokenAddress: '0xnoprice', symbol: 'NOPRICE', priceUsd: null, valueUsd: null })
    const zero = priced({ tokenAddress: '0xzero', symbol: 'ZERO', valueUsd: 0 })
    const real = priced({ tokenAddress: '0xreal', symbol: 'REAL', valueUsd: 10 })
    const result = selectHoldingsV2([unpriced, zero, real], { 8453: 10 })

    assert.equal(result.meaningfulHoldings.length, 1)
    assert.equal(result.meaningfulHoldings[0].symbol, 'REAL')
    assert.equal(result.diagnostics.excludedPricedHoldings.length, 2)
    assert.deepEqual(
      result.diagnostics.excludedPricedHoldings.map((e) => e.tokenAddress).sort(),
      ['0xnoprice', '0xzero'],
    )
    assert.equal(result.diagnostics.exclusionReason['8453:0xnoprice'], 'zero_or_unpriced')
    assert.equal(result.diagnostics.exclusionReason['8453:0xzero'], 'zero_or_unpriced')
  })

  it('chain-grouped value totals are the canonical chainValueUsd passthrough, never recomputed from a filtered display subset', () => {
    const holdings = [
      priced({ chainId: 8453, tokenAddress: '0xa', valueUsd: 3005.73 }),
      priced({ chainId: 8453, tokenAddress: '0xb', valueUsd: 256.82 }),
      priced({ chainId: 1, tokenAddress: '0xc', valueUsd: 100 }),
    ]
    const canonicalChainValueUsd = { 8453: 3262.55, 1: 100 }
    const result = selectHoldingsV2(holdings, canonicalChainValueUsd)
    assert.deepEqual(result.diagnostics.chainGroupedValueUsd, canonicalChainValueUsd, 'Holdings V2 chain totals must equal the canonical portfolioV2-sourced chain totals exactly')
  })

  it('canonicalPricedValueUsd, holdingsDisplayValueUsd, and valueDifferenceUsd agree when nothing is excluded but zero/unpriced holdings', () => {
    const holdings = [
      priced({ tokenAddress: '0xa', valueUsd: 3005.73 }),
      priced({ tokenAddress: '0xb', valueUsd: 256.82 }),
      priced({ tokenAddress: '0xc', valueUsd: null }),
    ]
    const result = selectHoldingsV2(holdings, { 8453: 3262.55 })
    assert.equal(result.diagnostics.canonicalPricedValueUsd, 3262.55)
    assert.equal(result.diagnostics.holdingsDisplayValueUsd, 3262.55)
    assert.equal(result.diagnostics.valueDifferenceUsd, 0, 'no real value should ever be lost between canonical and displayed totals')
  })

  it('handles null/undefined inputs defensively — never crashes, always resolves to an empty, honest selection', () => {
    const result = selectHoldingsV2(null, null)
    assert.deepEqual(result.meaningfulHoldings, [])
    assert.deepEqual(result.dustHoldings, [])
    assert.equal(result.diagnostics.canonicalPricedValueUsd, 0)
  })
})
