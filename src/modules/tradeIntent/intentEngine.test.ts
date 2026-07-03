// Tests for src/modules/tradeIntent/intentEngine.ts. Uses node:test, same convention as
// src/modules/swapNormalizer/swapNormalizer.test.ts. NOT wired into npm test (which runs a single
// hardcoded file, tests/auth-flow.test.js) — same reasoning as the other module test files this
// session. Run directly with:
//   npx tsx --test src/modules/tradeIntent/intentEngine.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTradeIntent, isBaseOrStable } from './intentEngine'
import type { NormalizedTrade } from '../swapNormalizer'
import { UNKNOWN_TOKEN } from '../swapNormalizer'

function trade(overrides: Partial<NormalizedTrade>): NormalizedTrade {
  return {
    type: 'SWAP',
    chain: 'base',
    timestamp: 1000,
    txHash: '0x1',
    wallet: '0xwallet',
    tokenIn: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
    tokenOut: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 },
    amountIn: 100,
    amountOut: 1000,
    router: null,
    isBuy: false,
    isSell: false,
    meta: { hops: 1, routerType: null, reconstructedFromTransfers: true, missingSide: 'none' },
    ...overrides,
  }
}

describe('classifyTradeIntent — pure BUY', () => {
  it('USDC -> DEGEN classifies as BUY', () => {
    const [result] = classifyTradeIntent([trade({})])
    assert.equal(result.intent, 'BUY')
    assert.equal(result.isBuy, true)
    assert.equal(result.isSell, false)
    assert.match(result.intentReason, /Spent base\/stable USDC/)
  })
})

describe('classifyTradeIntent — pure SELL', () => {
  it('DEGEN -> USDC classifies as SELL', () => {
    const [result] = classifyTradeIntent([
      trade({ tokenIn: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 }, tokenOut: { address: '0xusdc', symbol: 'USDC', decimals: 6 } }),
    ])
    assert.equal(result.intent, 'SELL')
    assert.equal(result.isSell, true)
    assert.equal(result.isBuy, false)
  })
})

describe('classifyTradeIntent — volatile -> volatile SWAP', () => {
  it('DEGEN -> BRETT classifies as SWAP', () => {
    const [result] = classifyTradeIntent([
      trade({ tokenIn: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 }, tokenOut: { address: '0xbrett', symbol: 'BRETT', decimals: 18 } }),
    ])
    assert.equal(result.intent, 'SWAP')
    assert.equal(result.isBuy, false)
    assert.equal(result.isSell, false)
  })
})

describe('classifyTradeIntent — both sides base/stable', () => {
  it('USDC -> WETH classifies as SWAP, not BUY or SELL', () => {
    const [result] = classifyTradeIntent([
      trade({ tokenIn: { address: '0xusdc', symbol: 'USDC', decimals: 6 }, tokenOut: { address: '0xweth', symbol: 'WETH', decimals: 18 } }),
    ])
    assert.equal(result.intent, 'SWAP')
  })
})

describe('classifyTradeIntent — LP_ADD passthrough', () => {
  it('never reclassified as BUY/SELL/SWAP, isBuy/isSell false', () => {
    const [result] = classifyTradeIntent([
      trade({ type: 'LP_ADD', tokenIn: { address: '0xusdc', symbol: 'USDC', decimals: 6 }, tokenOut: { address: '', symbol: 'LP', decimals: 18 } }),
    ])
    assert.equal(result.intent, 'LP_ADD')
    assert.equal(result.isBuy, false)
    assert.equal(result.isSell, false)
  })
})

describe('classifyTradeIntent — LP_REMOVE passthrough', () => {
  it('never reclassified as BUY/SELL/SWAP, isBuy/isSell false', () => {
    const [result] = classifyTradeIntent([
      trade({ type: 'LP_REMOVE', tokenIn: { address: '', symbol: 'LP', decimals: 18 }, tokenOut: { address: '0xusdc', symbol: 'USDC', decimals: 6 } }),
    ])
    assert.equal(result.intent, 'LP_REMOVE')
    assert.equal(result.isBuy, false)
    assert.equal(result.isSell, false)
  })
})

describe('classifyTradeIntent — multi-hop with missing tokenOut', () => {
  it('best-effort BUY when the known side (tokenIn) is base/stable', () => {
    const [result] = classifyTradeIntent([
      trade({
        tokenIn: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
        tokenOut: UNKNOWN_TOKEN,
        meta: { hops: 3, routerType: 'UNISWAP_V3', reconstructedFromTransfers: true, missingSide: 'tokenOut' },
      }),
    ])
    assert.equal(result.intent, 'BUY')
    assert.equal(result.isBuy, true)
    assert.match(result.intentReason, /multi-hop, 3 hops/)
  })

  it('falls back to SWAP when the known side (tokenIn) is volatile', () => {
    const [result] = classifyTradeIntent([
      trade({
        tokenIn: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 },
        tokenOut: UNKNOWN_TOKEN,
        meta: { hops: 2, routerType: null, reconstructedFromTransfers: true, missingSide: 'tokenOut' },
      }),
    ])
    assert.equal(result.intent, 'SWAP')
  })
})

describe('classifyTradeIntent — missing tokenIn', () => {
  it('best-effort SELL when the known side (tokenOut) is base/stable', () => {
    const [result] = classifyTradeIntent([
      trade({
        tokenIn: UNKNOWN_TOKEN,
        tokenOut: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
        meta: { hops: 1, routerType: null, reconstructedFromTransfers: true, missingSide: 'tokenIn' },
      }),
    ])
    assert.equal(result.intent, 'SELL')
    assert.equal(result.isSell, true)
  })
})

describe('isBaseOrStable — symbol and address matching', () => {
  it('matches known symbols case-insensitively', () => {
    assert.equal(isBaseOrStable('usdc'), true)
    assert.equal(isBaseOrStable('USDC'), true)
    assert.equal(isBaseOrStable('WETH'), true)
    assert.equal(isBaseOrStable('DEGEN'), false)
  })

  it('matches known addresses case-insensitively', () => {
    assert.equal(isBaseOrStable('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), true)
    assert.equal(isBaseOrStable('0xnotarealtoken'), false)
  })

  it('handles empty/garbage input without throwing', () => {
    assert.equal(isBaseOrStable(''), false)
    assert.equal(isBaseOrStable('   '), false)
  })
})

describe('classifyTradeIntent — determinism and empty input', () => {
  it('returns an empty array for empty input, never throws', () => {
    assert.deepEqual(classifyTradeIntent([]), [])
  })

  it('is pure — same input produces the same output on repeated calls', () => {
    const input = [trade({})]
    const a = classifyTradeIntent(input)
    const b = classifyTradeIntent(input)
    assert.deepEqual(a, b)
  })
})
