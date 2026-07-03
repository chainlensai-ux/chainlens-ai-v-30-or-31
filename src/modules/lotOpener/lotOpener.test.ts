// Tests for src/modules/lotOpener/lotOpener.ts. Uses node:test, same convention as the other
// module test files this session. NOT wired into npm test (which runs a single hardcoded file).
// Run directly with:
//   npx tsx --test src/modules/lotOpener/lotOpener.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openLots } from './index'
import type { TradeWithIntent } from '../tradeIntent/intentEngine'
import { UNKNOWN_TOKEN } from '../swapNormalizer'

function tradeWithIntent(overrides: Partial<TradeWithIntent>): TradeWithIntent {
  return {
    type: 'BUY',
    chain: 'base',
    timestamp: 1000,
    txHash: '0x1',
    wallet: '0xwallet',
    tokenIn: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
    tokenOut: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 },
    amountIn: 100,
    amountOut: 1000,
    router: null,
    isBuy: true,
    isSell: false,
    meta: { hops: 1, routerType: null, reconstructedFromTransfers: true, missingSide: 'none' },
    intent: 'BUY',
    intentReason: 'test fixture',
    ...overrides,
  }
}

describe('openLots — simple BUY', () => {
  it('creates one lot: token=tokenOut, amount=amountOut, costBasis=amountIn, currency=USD', () => {
    const [lot] = openLots([tradeWithIntent({})])
    assert.ok(lot)
    assert.equal(lot.token.symbol, 'DEGEN')
    assert.equal(lot.amount, 1000)
    assert.equal(lot.costBasis, 100)
    assert.equal(lot.costBasisCurrency, 'USD')
    assert.equal(lot.wallet, '0xwallet')
    assert.equal(lot.sourceTx, '0x1')
    assert.equal(lot.intent, 'BUY')
  })

  it('id is deterministic for the same (txHash, tokenOut.address, timestamp)', () => {
    const [a] = openLots([tradeWithIntent({})])
    const [b] = openLots([tradeWithIntent({})])
    assert.equal(a.id, b.id)
  })
})

describe('openLots — multi-hop BUY flattens to one lot', () => {
  it('produces exactly one lot regardless of hops, with hops passed through', () => {
    const trade = tradeWithIntent({ meta: { hops: 4, routerType: 'UNISWAP_V3', reconstructedFromTransfers: true, missingSide: 'none' } })
    const lots = openLots([trade])
    assert.equal(lots.length, 1)
    assert.equal(lots[0].meta.hops, 4)
  })
})

describe('openLots — missing-side BUY', () => {
  it('still creates a lot with honest amount=0/token=UNKNOWN when tokenOut was unresolved', () => {
    const trade = tradeWithIntent({
      tokenOut: UNKNOWN_TOKEN,
      amountOut: 0,
      meta: { hops: 2, routerType: null, reconstructedFromTransfers: true, missingSide: 'tokenOut' },
    })
    const [lot] = openLots([trade])
    assert.equal(lot.token.symbol, 'UNKNOWN')
    assert.equal(lot.amount, 0)
    assert.equal(lot.costBasis, 100) // the known, real spent side is still preserved
    assert.equal(lot.meta.missingSide, 'tokenOut')
  })
})

describe('openLots — LP_ADD synthetic lot', () => {
  it('creates exactly one lot for the known underlying token (tokenIn), self-costed', () => {
    const trade = tradeWithIntent({
      type: 'LP_ADD',
      intent: 'LP_ADD',
      tokenIn: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
      tokenOut: { address: '', symbol: 'LP', decimals: 18 },
      amountIn: 1000,
      amountOut: 1,
    })
    const lots = openLots([trade])
    assert.equal(lots.length, 1)
    assert.equal(lots[0].token.symbol, 'USDC')
    assert.equal(lots[0].amount, 1000)
    assert.equal(lots[0].costBasis, 1000)
    assert.equal(lots[0].costBasisCurrency, 'USDC')
    assert.equal(lots[0].intent, 'LP_ADD')
  })
})

describe('openLots — volatile BUY with stable cost basis vs. non-stable-base cost basis', () => {
  it('DAI-funded BUY reports costBasisCurrency USD', () => {
    const [lot] = openLots([tradeWithIntent({ tokenIn: { address: '0xdai', symbol: 'DAI', decimals: 18 }, amountIn: 250, amountOut: 500 })])
    assert.equal(lot.costBasisCurrency, 'USD')
    assert.equal(lot.costBasis, 250)
  })

  it('WETH-funded BUY reports costBasisCurrency WETH, never mislabeled as USD', () => {
    const [lot] = openLots([tradeWithIntent({ tokenIn: { address: '0xweth', symbol: 'WETH', decimals: 18 }, amountIn: 1, amountOut: 500 })])
    assert.equal(lot.costBasisCurrency, 'WETH')
    assert.equal(lot.costBasis, 1)
  })
})

describe('openLots — SELL/SWAP/LP_REMOVE never create lots', () => {
  it('filters out everything except BUY and LP_ADD', () => {
    const sell = tradeWithIntent({ type: 'SELL', intent: 'SELL', isBuy: false, isSell: true })
    const swap = tradeWithIntent({ type: 'SWAP', intent: 'SWAP', isBuy: false, isSell: false })
    const lpRemove = tradeWithIntent({ type: 'LP_REMOVE', intent: 'LP_REMOVE', isBuy: false, isSell: false })
    assert.deepEqual(openLots([sell, swap, lpRemove]), [])
  })
})

describe('openLots — determinism and empty input', () => {
  it('returns an empty array for empty input, never throws', () => {
    assert.deepEqual(openLots([]), [])
  })

  it('is pure — same input produces the same output on repeated calls', () => {
    const input = [tradeWithIntent({})]
    assert.deepEqual(openLots(input), openLots(input))
  })
})
