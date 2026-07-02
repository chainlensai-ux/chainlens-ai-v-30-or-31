// Tests for src/modules/tradeLedger.ts. Uses node:test, same convention as
// tests/auth-flow.test.js and tests/baseRadarFeedScoring.test.ts. NOT wired into npm test (which
// runs a single hardcoded file, tests/auth-flow.test.js) — package.json intentionally not modified
// (out of scope for this task, same reasoning as the earlier baseRadarFeedScoring test). Run
// directly with: npx tsx --test src/modules/tradeLedger.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTradeLedger, type SwapEvent } from './tradeLedger'

function swap(overrides: Partial<SwapEvent>): SwapEvent {
  return {
    txHash: '0xhash',
    tokenIn: 'USDC',
    tokenOut: 'DEGEN',
    amountIn: 100,
    amountOut: 1000,
    priceIn: 1,
    priceOut: 0.1,
    timestamp: 1000,
    chain: 'base',
    path: ['USDC', 'DEGEN'],
    ...overrides,
  }
}

describe('buildTradeLedger — single-hop BUY', () => {
  it('classifies USDC -> DEGEN as BUY with a real costBasis, null pnl/duration', () => {
    const events = [swap({ txHash: '0x1', tokenIn: 'USDC', tokenOut: 'DEGEN', amountIn: 100, priceIn: 1 })]
    const [trade] = buildTradeLedger(events)
    assert.equal(trade.type, 'BUY')
    assert.equal(trade.tokenIn, 'USDC')
    assert.equal(trade.tokenOut, 'DEGEN')
    assert.equal(trade.costBasis, 100)
    assert.equal(trade.pnl, null)
    assert.equal(trade.duration, null)
    assert.equal(trade.hops, 1)
    assert.equal(trade.rawEvents.length, 1)
  })
})

describe('buildTradeLedger — single-hop SELL', () => {
  it('classifies DEGEN -> USDC as SELL with null costBasis/pnl', () => {
    const events = [swap({ txHash: '0x2', tokenIn: 'DEGEN', tokenOut: 'USDC', amountIn: 1000, amountOut: 90, priceOut: 1 })]
    const [trade] = buildTradeLedger(events)
    assert.equal(trade.type, 'SELL')
    assert.equal(trade.costBasis, null)
    assert.equal(trade.pnl, null)
    assert.equal(trade.duration, null)
  })
})

describe('buildTradeLedger — multi-hop BUY (USDC -> WETH -> DEGEN)', () => {
  it('collapses two legs sharing a txHash into one BUY trade with hops=2', () => {
    const events = [
      swap({ txHash: '0x3', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: 500, priceIn: 1, timestamp: 2000 }),
      swap({ txHash: '0x3', tokenIn: 'WETH', tokenOut: 'DEGEN', amountOut: 5000, priceOut: 0.1, timestamp: 2001 }),
    ]
    const [trade] = buildTradeLedger(events)
    assert.equal(trade.type, 'BUY')
    assert.equal(trade.tokenIn, 'USDC')
    assert.equal(trade.tokenOut, 'DEGEN')
    assert.equal(trade.hops, 2)
    assert.equal(trade.rawEvents.length, 2)
    assert.equal(trade.costBasis, 500)
  })
})

describe('buildTradeLedger — ROTATE (DEGEN -> BRETT)', () => {
  it('classifies a token-to-token swap (neither side a quote asset) as ROTATE', () => {
    const events = [swap({ txHash: '0x4', tokenIn: 'DEGEN', tokenOut: 'BRETT', amountIn: 1000, amountOut: 500, priceIn: 0.1, priceOut: 0.2 })]
    const [trade] = buildTradeLedger(events)
    assert.equal(trade.type, 'ROTATE')
    assert.equal(trade.costBasis, 100) // amountIn * priceIn = 1000 * 0.1
    assert.equal(trade.pnl, null)
  })
})

describe('buildTradeLedger — mixed BUY/SELL timeline', () => {
  it('returns all trades correctly classified and sorted by timestamp', () => {
    const events = [
      swap({ txHash: '0x5', tokenIn: 'USDC', tokenOut: 'DEGEN', timestamp: 1000 }),
      swap({ txHash: '0x6', tokenIn: 'DEGEN', tokenOut: 'USDC', timestamp: 2000 }),
      swap({ txHash: '0x7', tokenIn: 'USDC', tokenOut: 'BRETT', timestamp: 3000 }),
    ]
    const trades = buildTradeLedger(events)
    assert.equal(trades.length, 3)
    assert.deepEqual(trades.map((t) => t.type), ['BUY', 'SELL', 'BUY'])
    assert.deepEqual(trades.map((t) => t.timestamp), [1000, 2000, 3000])
  })
})

describe('buildTradeLedger — empty input', () => {
  it('returns an empty array, never throws', () => {
    assert.deepEqual(buildTradeLedger([]), [])
  })
})

describe('buildTradeLedger — out-of-order timestamps', () => {
  it('sorts output ascending regardless of input order', () => {
    const events = [
      swap({ txHash: '0x8', timestamp: 3000 }),
      swap({ txHash: '0x9', timestamp: 1000 }),
      swap({ txHash: '0xa', timestamp: 2000 }),
    ]
    const trades = buildTradeLedger(events)
    assert.deepEqual(trades.map((t) => t.timestamp), [1000, 2000, 3000])
  })
})

describe('buildTradeLedger — multiple chains', () => {
  it('keeps each chain\'s trades independent even if txHash strings coincide', () => {
    const events = [
      swap({ txHash: '0xsame', chain: 'base', tokenIn: 'USDC', tokenOut: 'DEGEN', timestamp: 1000 }),
      swap({ txHash: '0xsame', chain: 'eth', tokenIn: 'USDC', tokenOut: 'PEPE', timestamp: 1000 }),
    ]
    const trades = buildTradeLedger(events)
    assert.equal(trades.length, 2)
    const chains = trades.map((t) => t.chain).sort()
    assert.deepEqual(chains, ['base', 'eth'])
  })
})
