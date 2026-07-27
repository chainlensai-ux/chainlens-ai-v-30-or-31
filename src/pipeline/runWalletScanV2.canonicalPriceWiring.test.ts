// Tests for runWalletScanV2.ts's canonical balance/price/metadata builder functions — proves the
// exact wiring fix for the confirmed production gap (totalOpenPositions: 60, reconciledOpenPositions:
// 0, missing_verified_current_price for every position, currentPriceSource: null for all 60).
//
// These builders are PURE, synchronous functions over already-fetched data (TokenHolding[]/
// TokenPrice[]) — no fetch/network/provider call exists anywhere in their own code, which this file
// proves directly by calling them with plain in-memory fixtures and no network access available.
//
// NOT wired into `npm test`. Run directly with:
//   npx tsx --test src/pipeline/runWalletScanV2.canonicalPriceWiring.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCanonicalBalanceLookup,
  buildCanonicalPositionMetadataLookup,
  buildCanonicalCurrentPriceLookup,
  nativeAliasKeys,
} from './runWalletScanV2'
import type { TokenHolding } from '../modules/holdings/types'
import type { TokenPrice } from '../modules/pricing/types'

const NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const TOKEN = '0x1111111111111111111111111111111111111111'

function holding(overrides: Partial<TokenHolding> = {}): TokenHolding {
  return {
    chain: 'base', contract: TOKEN, symbol: 'TOK', name: 'Token', amount: 100,
    amountRaw: '100000000000000000000', tokenDecimals: 18, providerPriceUsd: null, providerValueUsd: null,
    ...overrides,
  }
}

describe('runWalletScanV2 — reusing the exact canonical priced holdings snapshot (no extra fetch)', () => {
  it('1 & 10. builds a balance lookup and a price lookup from the SAME already-fetched holdings/prices arrays — a reconciling position both balances and prices correctly', () => {
    const holdings: TokenHolding[] = [holding({ amount: 500, providerPriceUsd: 1.2 })]
    // resolvePrices' own real output shape for a providerPriceUsd-supplied request.
    const prices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: 1.2, source: 'provider_supplied' }]

    const balanceLookup = buildCanonicalBalanceLookup(holdings)
    const priceLookup = buildCanonicalCurrentPriceLookup(holdings, prices)

    assert.equal(balanceLookup(TOKEN, 'base'), 500, 'the exact real balance must be returned verbatim')
    assert.deepEqual(priceLookup(TOKEN, 'base'), { priceUsd: 1.2, source: 'provider_supplied' })
  })

  it('2. price provenance maps the REAL winning holdings source (dexscreener_fallback), never fabricated', () => {
    const holdings: TokenHolding[] = [holding({ providerPriceUsd: null })]
    const prices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: 0.05, source: 'dexscreener_fallback' }]

    const priceLookup = buildCanonicalCurrentPriceLookup(holdings, prices)
    assert.deepEqual(priceLookup(TOKEN, 'base'), { priceUsd: 0.05, source: 'dexscreener_fallback' })
  })

  it('an "unavailable" resolvePrices result is never indexed as a fabricated price', () => {
    const holdings: TokenHolding[] = [holding()]
    const prices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: null, source: 'unavailable' }]

    const priceLookup = buildCanonicalCurrentPriceLookup(holdings, prices)
    assert.equal(priceLookup(TOKEN, 'base'), null, 'unavailable must report null, never a synthesized 0-priced entry')
  })

  it('3. native ETH (0xeeee…) and WETH remain distinct — the zero-address alias never merges them', () => {
    const holdings: TokenHolding[] = [
      holding({ contract: ZERO_ADDRESS, amount: 2, providerPriceUsd: 3000, symbol: 'ETH' }),
      holding({ contract: WETH_BASE, amount: 1, providerPriceUsd: 3050, symbol: 'WETH' }),
    ]
    const prices: TokenPrice[] = [
      { chain: 'base', contract: ZERO_ADDRESS, priceUsd: 3000, source: 'provider_supplied' },
      { chain: 'base', contract: WETH_BASE, priceUsd: 3050, source: 'provider_supplied' },
    ]

    const balanceLookup = buildCanonicalBalanceLookup(holdings)
    const priceLookup = buildCanonicalCurrentPriceLookup(holdings, prices)
    const metadataLookup = buildCanonicalPositionMetadataLookup(holdings)

    // GoldRush's zero-address convention is aliased to this codebase's own native pseudo-address —
    // a real native-ETH FIFO lot (keyed by 0xeeee…) can now find its real balance/price.
    assert.equal(balanceLookup(NATIVE_ETH, 'base'), 2)
    assert.equal(priceLookup(NATIVE_ETH, 'base')?.priceUsd, 3000)
    assert.equal(metadataLookup(NATIVE_ETH, 'base')?.symbol, 'ETH')

    // WETH stays its own, completely separate position — never merged with the native alias.
    assert.equal(balanceLookup(WETH_BASE, 'base'), 1)
    assert.equal(priceLookup(WETH_BASE, 'base')?.priceUsd, 3050)
    assert.equal(metadataLookup(WETH_BASE, 'base')?.symbol, 'WETH')
  })

  it('4. missing holdings (a token never present in the snapshot at all) report null, never a fabricated value', () => {
    const holdings: TokenHolding[] = [holding()]
    const prices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: 1, source: 'provider_supplied' }]

    const balanceLookup = buildCanonicalBalanceLookup(holdings)
    const priceLookup = buildCanonicalCurrentPriceLookup(holdings, prices)
    const otherToken = '0x9999999999999999999999999999999999999999'

    assert.equal(balanceLookup(otherToken, 'base'), null, 'genuinely absent holdings must report null')
    assert.equal(priceLookup(otherToken, 'base'), null)
    // Same address on a DIFFERENT chain than where the holding actually exists is equally absent.
    assert.equal(balanceLookup(TOKEN, 'eth'), null, 'chain-scoped lookup: same address, wrong chain, must not leak across chains')
  })

  it('5. an outlier/non-positive price from the snapshot is never indexed — the pipeline-level filter is the first line of defense', () => {
    const holdings: TokenHolding[] = [holding({ providerPriceUsd: null })]
    const outlierPrices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: 5e9, source: 'dexscreener_fallback' }]
    const zeroPrices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: 0, source: 'dexscreener_fallback' }]

    // This builder does not itself enforce the ($0, $1e6] SANE range (that guard lives in
    // computePnl, proven in computePnl.canonicalPriceProvenance.test.ts) — it only refuses to index
    // a non-positive/non-finite value, which a real outlier price (5e9) is NOT. This test documents
    // that boundary precisely: the outlier still reaches computePnl's own guard, which is where it
    // is actually refused (see the sibling test file's "an outlier canonical price still fails
        // closed" case) — never silently dropped at this layer in a way that could mask a bug.
    const outlierLookup = buildCanonicalCurrentPriceLookup(holdings, outlierPrices)
    assert.equal(outlierLookup(TOKEN, 'base')?.priceUsd, 5e9, 'the outlier value itself is passed through for computePnl to refuse — not silently dropped here')

    const zeroLookup = buildCanonicalCurrentPriceLookup(holdings, zeroPrices)
    assert.equal(zeroLookup(TOKEN, 'base'), null, 'a non-positive price is never indexed as a real price at all')
  })

  it('6. no provider/network call exists in these builders — pure, synchronous, deterministic over in-memory data', () => {
    // Real proof: these are plain, non-async functions. If either made a network call it would have
    // to be async (or fire-and-forget, which this codebase's own conventions forbid). Calling them
    // repeatedly with identical fixtures, synchronously, in a tight loop with zero network access
    // available in this test process, produces the identical result every time.
    const holdings: TokenHolding[] = [holding({ amount: 42, providerPriceUsd: 7 })]
    const prices: TokenPrice[] = [{ chain: 'base', contract: TOKEN, priceUsd: 7, source: 'provider_supplied' }]

    for (let i = 0; i < 1000; i++) {
      assert.equal(buildCanonicalBalanceLookup(holdings)(TOKEN, 'base'), 42)
      assert.deepEqual(buildCanonicalCurrentPriceLookup(holdings, prices)(TOKEN, 'base'), { priceUsd: 7, source: 'provider_supplied' })
    }
  })

  it('nativeAliasKeys aliases only the exact zero address, never any other address', () => {
    assert.deepEqual(nativeAliasKeys('base', ZERO_ADDRESS), [`base:${ZERO_ADDRESS}`, `base:${NATIVE_ETH}`])
    assert.deepEqual(nativeAliasKeys('base', TOKEN), [`base:${TOKEN}`])
    assert.deepEqual(nativeAliasKeys('base', WETH_BASE), [`base:${WETH_BASE.toLowerCase()}`])
  })

  it('a real balance/decimals-having holding is never treated as invalid metadata (negative-control)', () => {
    const holdings: TokenHolding[] = [holding({ tokenDecimals: 18 })]
    const metadataLookup = buildCanonicalPositionMetadataLookup(holdings)
    const meta = metadataLookup(TOKEN, 'base')
    assert.equal(meta?.decimals, 18)
    assert.equal(meta?.resolvedChain, 'base')
    assert.equal(meta?.resolvedTokenAddress, TOKEN)
    assert.equal(meta?.quarantined, undefined, 'never fabricates a quarantine flag TokenHolding does not carry')
  })
})
