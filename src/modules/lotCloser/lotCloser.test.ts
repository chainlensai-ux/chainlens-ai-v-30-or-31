// Tests for src/modules/lotCloser/lotCloser.ts. Uses node:test, same convention as the other
// module test files this session. NOT wired into npm test (which runs a single hardcoded file).
// Run directly with:
//   npx tsx --test src/modules/lotCloser/lotCloser.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closeLots } from './index'
import type { IntentLot } from '../lotOpener'
import type { TradeWithIntent } from '../tradeIntent/intentEngine'

function lot(overrides: Partial<IntentLot>): IntentLot {
  return {
    id: 'lot_1',
    wallet: '0xwallet',
    token: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 },
    amount: 1000,
    costBasis: 100,
    costBasisCurrency: 'USD',
    timestamp: 1000,
    sourceTx: '0xbuy1',
    intent: 'BUY',
    meta: { hops: 1, reconstructedFromTransfers: true, missingSide: 'none' },
    ...overrides,
  }
}

function sellTrade(overrides: Partial<TradeWithIntent>): TradeWithIntent {
  return {
    type: 'SELL',
    chain: 'base',
    timestamp: 2000,
    txHash: '0xsell1',
    wallet: '0xwallet',
    tokenIn: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 },
    tokenOut: { address: '0xusdc', symbol: 'USDC', decimals: 6 },
    amountIn: 1000,
    amountOut: 150,
    router: null,
    isBuy: false,
    isSell: true,
    meta: { hops: 1, routerType: null, reconstructedFromTransfers: true, missingSide: 'none' },
    intent: 'SELL',
    intentReason: 'test fixture',
    ...overrides,
  }
}

describe('closeLots — simple full close', () => {
  it('one BUY lot fully closed by one matching SELL', () => {
    const { closedLots, remainingLots, unmatchedSells } = closeLots([lot({})], [sellTrade({})])
    assert.equal(closedLots.length, 1)
    assert.equal(closedLots[0].amountClosed, 1000)
    assert.equal(closedLots[0].costBasis, 100)
    assert.equal(closedLots[0].proceeds, 150)
    assert.equal(closedLots[0].realizedPnl, 50)
    assert.equal(closedLots[0].pnlCurrency, 'USD')
    assert.equal(closedLots[0].pnlCurrencyMismatch, false)
    assert.deepEqual(remainingLots, [])
    assert.deepEqual(unmatchedSells, [])
  })
})

describe('closeLots — partial close', () => {
  it('SELL smaller than the lot leaves a proportionally-reduced remainder', () => {
    const { closedLots, remainingLots } = closeLots(
      [lot({})],
      [sellTrade({ amountIn: 400, amountOut: 60 })],
    )
    assert.equal(closedLots[0].amountClosed, 400)
    assert.equal(closedLots[0].costBasis, 40) // 100 * 400/1000
    assert.equal(closedLots[0].proceeds, 60)
    assert.equal(closedLots[0].realizedPnl, 20)
    assert.equal(remainingLots.length, 1)
    assert.equal(remainingLots[0].amount, 600)
    assert.equal(remainingLots[0].costBasis, 60) // 100 * 600/1000
  })
})

describe('closeLots — multi-lot close (strict FIFO)', () => {
  it('consumes the older lot fully before touching the newer one', () => {
    const lots = [
      lot({ id: 'lot_old', timestamp: 1000, sourceTx: '0xbuy_old', amount: 500, costBasis: 50 }),
      lot({ id: 'lot_new', timestamp: 1500, sourceTx: '0xbuy_new', amount: 500, costBasis: 60 }),
    ]
    const { closedLots, remainingLots } = closeLots(lots, [sellTrade({ amountIn: 800, amountOut: 200 })])
    assert.equal(closedLots.length, 2)
    assert.equal(closedLots[0].lotId, 'lot_old')
    assert.equal(closedLots[0].amountClosed, 500)
    assert.equal(closedLots[0].costBasis, 50)
    assert.equal(closedLots[1].lotId, 'lot_new')
    assert.equal(closedLots[1].amountClosed, 300)
    assert.equal(closedLots[1].costBasis, 36) // 60 * 300/500
    assert.equal(remainingLots.length, 1)
    assert.equal(remainingLots[0].id, 'lot_new')
    assert.equal(remainingLots[0].amount, 200)
    assert.equal(remainingLots[0].costBasis, 24) // 60 * 200/500
  })
})

describe('closeLots — SELL with no matching lot', () => {
  it('produces no closed lots and reports the unmatched sell honestly, never fabricating cost basis', () => {
    const { closedLots, unmatchedSells } = closeLots(
      [],
      [sellTrade({ tokenIn: { address: '0xbrett', symbol: 'BRETT', decimals: 18 } })],
    )
    assert.deepEqual(closedLots, [])
    assert.equal(unmatchedSells.length, 1)
    assert.equal(unmatchedSells[0].amountUnmatched, 1000)
    assert.equal(unmatchedSells[0].token.symbol, 'BRETT')
  })

  it('reports the uncovered remainder when lots exist but are insufficient', () => {
    const { closedLots, unmatchedSells } = closeLots(
      [lot({ amount: 300, costBasis: 30 })],
      [sellTrade({ amountIn: 1000, amountOut: 150 })],
    )
    assert.equal(closedLots.length, 1)
    assert.equal(closedLots[0].amountClosed, 300)
    assert.equal(unmatchedSells.length, 1)
    assert.equal(unmatchedSells[0].amountUnmatched, 700)
  })
})

describe('closeLots — mixed tokens', () => {
  it('a SELL of one token only closes lots of that token, leaving other-token lots untouched', () => {
    const degenLot = lot({ id: 'lot_degen' })
    const brettLot = lot({ id: 'lot_brett', token: { address: '0xbrett', symbol: 'BRETT', decimals: 18 } })
    const { closedLots, remainingLots } = closeLots([degenLot, brettLot], [sellTrade({})])
    assert.equal(closedLots.length, 1)
    assert.equal(closedLots[0].lotId, 'lot_degen')
    assert.equal(remainingLots.length, 1)
    assert.equal(remainingLots[0].id, 'lot_brett')
    assert.equal(remainingLots[0].amount, 1000) // fully untouched
  })
})

describe('closeLots — currency mismatch honesty', () => {
  it('flags pnlCurrencyMismatch when lot cost basis and sell proceeds are different currencies', () => {
    const wethLot = lot({ costBasisCurrency: 'WETH', costBasis: 1 })
    const { closedLots } = closeLots([wethLot], [sellTrade({})]) // sell proceeds in USDC -> "USD"
    assert.equal(closedLots[0].pnlCurrencyMismatch, true)
    assert.match(closedLots[0].pnlCurrency, /mismatched/)
  })

  it('does not flag a mismatch when both sides are the same currency', () => {
    const { closedLots } = closeLots([lot({})], [sellTrade({})])
    assert.equal(closedLots[0].pnlCurrencyMismatch, false)
  })
})

describe('closeLots — non-SELL intents never close lots', () => {
  it('BUY/SWAP/LP_ADD/LP_REMOVE trades are ignored', () => {
    const trades: TradeWithIntent[] = [
      sellTrade({ type: 'BUY', intent: 'BUY', txHash: '0xa' }),
      sellTrade({ type: 'SWAP', intent: 'SWAP', txHash: '0xb' }),
      sellTrade({ type: 'LP_ADD', intent: 'LP_ADD', txHash: '0xc' }),
      sellTrade({ type: 'LP_REMOVE', intent: 'LP_REMOVE', txHash: '0xd' }),
    ]
    const { closedLots, remainingLots, unmatchedSells } = closeLots([lot({})], trades)
    assert.deepEqual(closedLots, [])
    assert.deepEqual(unmatchedSells, [])
    assert.equal(remainingLots.length, 1)
    assert.equal(remainingLots[0].amount, 1000)
  })
})

describe('closeLots — determinism and empty input', () => {
  it('returns empty results for empty input, never throws', () => {
    const result = closeLots([], [])
    assert.deepEqual(result, { closedLots: [], remainingLots: [], unmatchedSells: [] })
  })

  it('is pure — same input produces the same output on repeated calls', () => {
    const lots = [lot({})]
    const trades = [sellTrade({})]
    assert.deepEqual(closeLots(lots, trades), closeLots(lots, trades))
  })
})
