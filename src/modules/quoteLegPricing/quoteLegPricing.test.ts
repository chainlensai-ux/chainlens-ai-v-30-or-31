// Tests for src/modules/quoteLegPricing/index.ts — same-transaction quote-leg historical pricing.
//
// Run with:
//   npx tsx --test src/modules/quoteLegPricing/quoteLegPricing.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveSameTransactionQuotePrice,
  groupSwapLegsByTransaction,
  type SwapLeg,
} from './index'
import type { NormalizedEvent } from '../normalization/types'

const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const FAKE_USDC = '0x000000000000000000000000000000deadbeef'
const MEME_TOKEN = '0x00000000000000000000000000000000000001'
const OTHER_TOKEN = '0x00000000000000000000000000000000000002'
const ROUTER_REFUND_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

function baseParams(overrides: Partial<Parameters<typeof deriveSameTransactionQuotePrice>[0]> = {}) {
  return {
    chain: 'eth' as const,
    txHash: '0xtx1',
    timestamp: 1700000000000,
    targetToken: MEME_TOKEN,
    targetDirection: 'inbound' as const,
    targetQuantity: 1000,
    groupedSwapLegs: [] as SwapLeg[],
    historicalNativePrice: null,
    ...overrides,
  }
}

describe('deriveSameTransactionQuotePrice — stablecoin quote', () => {
  it('1. USDC buy derives exact same-transaction token price', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 500, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs, targetDirection: 'inbound', targetQuantity: 1000 }))
    assert.equal(result.priceUsd, 0.5)
    assert.equal(result.source, 'same_tx_stable_quote')
    assert.equal(result.confidence, 'verified')
    assert.equal(result.evidence.rejectionReason, null)
  })

  it('2. USDC sell derives exact same-transaction token price', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 2000, direction: 'outbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 1000, direction: 'inbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs, targetDirection: 'outbound', targetQuantity: 2000 }))
    assert.equal(result.priceUsd, 0.5)
    assert.equal(result.source, 'same_tx_stable_quote')
  })
})

describe('deriveSameTransactionQuotePrice — native/WETH quote', () => {
  it('3. WETH quote derives price using historical ETH price', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: WETH_ETH, symbol: 'WETH', decimals: 18, amount: 1, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(
      baseParams({ groupedSwapLegs: legs, targetDirection: 'inbound', targetQuantity: 1000, historicalNativePrice: 3500 }),
    )
    assert.equal(result.priceUsd, 3.5)
    assert.equal(result.source, 'same_tx_native_quote')
  })

  it('4. native ETH and WETH representations do not double-count', () => {
    // Both a native 'ETH' leg and a WETH leg claim the same opposite direction — the function must
    // choose exactly one quote leg, never sum them.
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: 'native', symbol: 'ETH', decimals: 18, amount: 1, direction: 'outbound', logIndex: 1 },
      { contract: WETH_ETH, symbol: 'WETH', decimals: 18, amount: 1, direction: 'outbound', logIndex: 2 },
    ]
    const result = deriveSameTransactionQuotePrice(
      baseParams({ groupedSwapLegs: legs, targetDirection: 'inbound', targetQuantity: 1000, historicalNativePrice: 3500 }),
    )
    assert.equal(result.priceUsd, 3.5, 'exactly one quote leg amount (1 ETH-equivalent) must be used, not 2')
  })

  it('5. stablecoin quote wins over native quote', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: WETH_ETH, symbol: 'WETH', decimals: 18, amount: 1, direction: 'outbound', logIndex: 1 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 500, direction: 'outbound', logIndex: 2 },
    ]
    const result = deriveSameTransactionQuotePrice(
      baseParams({ groupedSwapLegs: legs, targetDirection: 'inbound', targetQuantity: 1000, historicalNativePrice: 3500 }),
    )
    assert.equal(result.source, 'same_tx_stable_quote')
    assert.equal(result.priceUsd, 0.5)
  })

  it('6. largest verified quote wins when multiple quotes exist', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 100, direction: 'outbound', logIndex: 1 },
      { contract: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', symbol: 'DAI', decimals: 18, amount: 900, direction: 'outbound', logIndex: 2 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ chain: 'arbitrum', groupedSwapLegs: legs, targetDirection: 'inbound', targetQuantity: 1000 }))
    assert.equal(result.quoteQuantity, 900)
    assert.equal(result.priceUsd, 0.9)
  })
})

describe('deriveSameTransactionQuotePrice — rejections', () => {
  it('7. unrelated transfer in the same transaction is rejected', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: OTHER_TOKEN, symbol: 'JUNK', decimals: 18, amount: 5, direction: 'outbound', logIndex: 1, excludeReason: 'unrelated_transfer' },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs }))
    assert.equal(result.priceUsd, null)
    assert.equal(result.evidence.rejectionReason, 'no_opposite_leg_in_transaction')
  })

  it('8. router refund is rejected', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: ROUTER_REFUND_WETH, symbol: 'WETH', decimals: 18, amount: 0.001, direction: 'outbound', logIndex: 1, excludeReason: 'router_refund' },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs, historicalNativePrice: 3500 }))
    assert.equal(result.priceUsd, null)
    assert.equal(result.evidence.rejectionReason, 'no_opposite_leg_in_transaction')
  })

  it('9. airdrop/mint/burn/bridge event is rejected', () => {
    for (const reason of ['airdrop', 'mint', 'burn', 'bridge']) {
      const legs: SwapLeg[] = [
        { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
        { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 500, direction: 'outbound', logIndex: 1, excludeReason: reason },
      ]
      const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs }))
      assert.equal(result.priceUsd, null, `reason=${reason}`)
    }
  })

  it('10. malformed decimals are rejected', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: Number.NaN, amount: 500, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs }))
    assert.equal(result.priceUsd, null)
    assert.equal(result.evidence.rejectionReason, 'no_opposite_leg_in_transaction')
  })

  it('11. zero quantity is rejected', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 0, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs }))
    assert.equal(result.priceUsd, null)
    assert.equal(result.evidence.rejectionReason, 'no_opposite_leg_in_transaction')
  })

  it('12. non-canonical fake USDC symbol is rejected', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: FAKE_USDC, symbol: 'USDC', decimals: 6, amount: 500, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs }))
    assert.equal(result.priceUsd, null)
    assert.equal(result.evidence.rejectionReason, 'no_verified_quote_leg_found')
  })
})

describe('deriveSameTransactionQuotePrice — determinism and isolation', () => {
  it('13. two transactions never share quote legs', () => {
    const groups = groupSwapLegsByTransaction([
      { provider: 'goldrush', chain: 'eth', txHash: '0xaaa', timestamp: '2024-01-01T00:00:00Z', fromAddress: 'a', toAddress: 'b', contract: MEME_TOKEN, symbol: 'MEME', amount: 1000, amountRaw: null, tokenDecimals: 18, direction: 'inbound' },
      { provider: 'goldrush', chain: 'eth', txHash: '0xaaa', timestamp: '2024-01-01T00:00:00Z', fromAddress: 'a', toAddress: 'b', contract: USDC_ETH, symbol: 'USDC', amount: 500, amountRaw: null, tokenDecimals: 6, direction: 'outbound' },
      { provider: 'goldrush', chain: 'eth', txHash: '0xbbb', timestamp: '2024-01-01T00:00:00Z', fromAddress: 'a', toAddress: 'b', contract: OTHER_TOKEN, symbol: 'OTHER', amount: 10, amountRaw: null, tokenDecimals: 18, direction: 'inbound' },
    ] as unknown as NormalizedEvent[])
    assert.equal(groups.size, 2)
    const legsForAaa = groups.get('eth:0xaaa') ?? []
    const legsForBbb = groups.get('eth:0xbbb') ?? []
    assert.equal(legsForAaa.length, 2)
    assert.equal(legsForBbb.length, 1)
    assert.ok(!legsForBbb.some((l) => l.contract === USDC_ETH), 'tx 0xbbb must never see tx 0xaaa\'s quote leg')
  })

  it('14. deterministic result regardless of input leg order', () => {
    const legsA: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 500, direction: 'outbound', logIndex: 1 },
    ]
    const legsB = [...legsA].reverse()
    const resultA = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legsA }))
    const resultB = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legsB }))
    assert.deepEqual(resultA, resultB)
  })

  it('17. derived prices pass sane-price bounds (positive, finite, below the $1e6 ceiling)', () => {
    const legs: SwapLeg[] = [
      { contract: MEME_TOKEN, symbol: 'MEME', decimals: 18, amount: 1000, direction: 'inbound', logIndex: 0 },
      { contract: USDC_ETH, symbol: 'USDC', decimals: 6, amount: 500, direction: 'outbound', logIndex: 1 },
    ]
    const result = deriveSameTransactionQuotePrice(baseParams({ groupedSwapLegs: legs }))
    assert.ok(result.priceUsd != null && Number.isFinite(result.priceUsd) && result.priceUsd > 0 && result.priceUsd <= 1e6)
  })
})
