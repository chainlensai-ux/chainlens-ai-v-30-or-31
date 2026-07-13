// Direct test for walletChainPipeline.ts's classifyEventType/buildSellCandidatesFromTrades — the
// additive "swap-to-ETH/stablecoin = sell" UI-facing classification layer. Uses node:test, same
// convention as the other module test files this session. Run directly with:
//   npx tsx --test app/api/_shared/walletChainPipeline.eventClassification.test.ts
//
// Deliberately constructs real TradeWithIntent fixtures rather than mocking — classifyEventType
// reads trade.isSell/isBuy/wallet/meta.routerType directly, all real fields already computed by
// the protected swapNormalizer/tradeIntent modules (never re-derived here).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEventType, buildSellCandidatesFromTrades } from './walletChainPipeline'
import type { TradeWithIntent } from '@/src/modules/tradeIntent/intentEngine'
import { UNKNOWN_TOKEN } from '@/src/modules/swapNormalizer'
import type { TokenRef } from '@/src/modules/swapNormalizer/types'

const WALLET = '0x1111111111111111111111111111111111111111'
const ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43' // real Aerodrome router address (Base)

function token(address: string, symbol: string): TokenRef {
  return { address, symbol, decimals: 18 }
}

function trade(overrides: Partial<TradeWithIntent>): TradeWithIntent {
  return {
    type: 'SELL',
    chain: 'base',
    timestamp: 1_700_000_000,
    txHash: '0xtx',
    wallet: WALLET,
    tokenIn: token('0xtoken', 'PEPE'),
    tokenOut: token('0xusdc', 'USDC'),
    amountIn: 1000,
    amountOut: 50,
    router: ROUTER,
    isBuy: false,
    isSell: true,
    meta: { hops: 1, routerType: 'aerodrome', reconstructedFromTransfers: false, missingSide: 'none' },
    intent: 'SELL',
    intentReason: 'test fixture',
    ...overrides,
  } as TradeWithIntent
}

describe('classifyEventType — swap_sell (token -> ETH/stablecoin, known router)', () => {
  it('classifies a real sell-shaped swap through a known router as swap_sell', () => {
    const t = trade({})
    assert.equal(classifyEventType(t, WALLET), 'swap_sell')
  })

  it('does NOT classify as swap_sell when the counterparty is not a recognized router', () => {
    const t = trade({ meta: { hops: 1, routerType: null, reconstructedFromTransfers: false, missingSide: 'none' } })
    assert.equal(classifyEventType(t, WALLET), 'other')
  })

  it('does NOT classify as swap_sell when the wallet is not the initiator', () => {
    const t = trade({ wallet: '0x2222222222222222222222222222222222222222' })
    assert.equal(classifyEventType(t, WALLET), 'other')
  })

  it('does NOT classify as swap_sell when isSell is false (real swapNormalizer classification says no)', () => {
    const t = trade({ isSell: false, isBuy: false, type: 'SWAP' })
    assert.equal(classifyEventType(t, WALLET), 'other')
  })

  it('never fabricates a classification when either side is UNKNOWN_TOKEN (requirement 7)', () => {
    const t = trade({ tokenIn: UNKNOWN_TOKEN, isSell: true })
    assert.equal(classifyEventType(t, WALLET), 'other')
  })
})

describe('classifyEventType — swap_buy (ETH/stablecoin -> token, known router)', () => {
  it('classifies a real buy-shaped swap through a known router as swap_buy', () => {
    const t = trade({
      tokenIn: token('0xusdc', 'USDC'),
      tokenOut: token('0xtoken', 'PEPE'),
      isSell: false,
      isBuy: true,
      type: 'BUY',
    })
    assert.equal(classifyEventType(t, WALLET), 'swap_buy')
  })
})

describe('buildSellCandidatesFromTrades — UI-safe lot-building shape (requirement 5)', () => {
  it('builds a real sell candidate with sellToken=tokenIn, sellAmount=amountIn, counterparty=router', () => {
    const trades = [trade({})]
    const candidates = buildSellCandidatesFromTrades(trades, WALLET)
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].sellToken, '0xtoken')
    assert.equal(candidates[0].sellAmount, 1000)
    assert.equal(candidates[0].counterparty, ROUTER)
    assert.equal(candidates[0].proceedsUsd, null) // no priceAtTime callback supplied — never fabricated
  })

  it('computes real proceedsUsd only when a priceAtTime callback is supplied', () => {
    const trades = [trade({})]
    const candidates = buildSellCandidatesFromTrades(trades, WALLET, () => 2) // $2/unit of tokenOut
    assert.equal(candidates[0].proceedsUsd, 100) // $2 * amountOut (50)
  })

  it('excludes non-swap_sell trades entirely — never a fabricated candidate', () => {
    const trades = [trade({ isSell: false, isBuy: true, type: 'BUY' }), trade({ meta: { hops: 1, routerType: null, reconstructedFromTransfers: false, missingSide: 'none' } })]
    const candidates = buildSellCandidatesFromTrades(trades, WALLET)
    assert.equal(candidates.length, 0)
  })
})
