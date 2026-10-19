// Liquidity deposits/withdrawals never become priced buys or sells; real swaps are untouched.
//   npx tsx --test src/lib/liquidityLegGuard.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { NormalizedEvent } from '../modules/normalization/types'
import { guardLiquidityLegs } from './liquidityLegGuard'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const WETH = '0x4200000000000000000000000000000000000006'
const CHIP = '0x0c1c1c109fe34733fca54b82d7b46b75cfb71f6e'
const ZRO = '0x6985884c4392d348587b19cb9eaaf157f13271cd'

const ev = (txHash: string, contract: string, direction: 'inbound' | 'outbound', amount: number): NormalizedEvent => ({
  provider: 'alchemy' as never, chain: 'base', txHash, timestamp: '2026-10-18T00:00:00.000Z',
  fromAddress: '0xa', toAddress: '0xb', contract, symbol: '?', amount, amountRaw: null, tokenDecimals: 18, direction,
})
const priceEverything = () => 100

describe('guardLiquidityLegs', () => {
  it('liquidity add (production shape: CHIP + USDC out, CHIP dust back) prices none of its token legs', () => {
    const legs = [ev('0xadd', CHIP, 'outbound', 16231.19), ev('0xadd', USDC, 'outbound', 478.98), ev('0xadd', CHIP, 'inbound', 0.0000338)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.liquidityAddTxs, 1)
    assert.equal(guard.lookup(legs[0]), null, 'the deposit is not a sell')
    assert.equal(guard.lookup(legs[2]), null, 'the dust refund is not a buy')
    assert.equal(guard.lookup(legs[1]), 100, 'the quote leg itself is left alone')
  })

  it('liquidity add with WETH as the quote asset is caught too', () => {
    const legs = [ev('0xadd2', ZRO, 'outbound', 307054), ev('0xadd2', WETH, 'outbound', 0.0234), ev('0xadd2', ZRO, 'inbound', 4e-13)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.liquidityAddTxs, 1)
    assert.equal(guard.lookup(legs[0]), null)
  })

  it('liquidity remove (token + USDC come back, no quote goes out) prices no inbound token leg', () => {
    const legs = [ev('0xrm', CHIP, 'inbound', 16000), ev('0xrm', USDC, 'inbound', 470)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.liquidityRemoveTxs, 1)
    assert.equal(guard.lookup(legs[0]), null, 'tokens back from a pool are not a purchase')
  })

  it('plain swaps keep their prices: buy with USDC, sell for WETH, token-to-token', () => {
    const legs = [
      ev('0xbuy', USDC, 'outbound', 100), ev('0xbuy', CHIP, 'inbound', 2000),
      ev('0xsell', CHIP, 'outbound', 2000), ev('0xsell', WETH, 'inbound', 0.04),
      ev('0xt2t', CHIP, 'outbound', 2000), ev('0xt2t', ZRO, 'inbound', 50),
    ]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.rejectedEvents, 0)
    for (const leg of legs) assert.equal(guard.lookup(leg), 100)
  })

  it('a sell for USDC that refunds a little of the token keeps the sell priced', () => {
    const legs = [ev('0xs2', CHIP, 'outbound', 2000), ev('0xs2', USDC, 'inbound', 90), ev('0xs2', CHIP, 'inbound', 0.001)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.lookup(legs[0]), 100, 'the real sale stays priced')
  })

  it('a buy with USDC that refunds some USDC keeps the buy priced', () => {
    const legs = [ev('0xb2', USDC, 'outbound', 100), ev('0xb2', CHIP, 'inbound', 2000), ev('0xb2', USDC, 'inbound', 1)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.rejectedEvents, 0)
    assert.equal(guard.lookup(legs[1]), 100)
  })

  it('liquidity add into a pool of two non-quote tokens (cbBTC + AERO out) is not a sell', () => {
    const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'
    const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631'
    const legs = [ev('0xlp', CBBTC, 'outbound', 0.0011465), ev('0xlp', AERO, 'outbound', 120), ev('0xlp', AERO, 'inbound', 0.3)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.liquidityAddTxs, 1)
    for (const leg of legs) assert.equal(guard.lookup(leg), null)
  })

  it('liquidity withdrawal from a pool of two non-quote tokens is not a buy', () => {
    const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'
    const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631'
    const legs = [ev('0xrm2', CBBTC, 'inbound', 0.0011465), ev('0xrm2', AERO, 'inbound', 120)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.liquidityRemoveTxs, 1)
    for (const leg of legs) assert.equal(guard.lookup(leg), null)
  })

  it('a token-to-token swap that refunds part of the input stays priced', () => {
    const legs = [ev('0xt3', CHIP, 'outbound', 2000), ev('0xt3', ZRO, 'inbound', 50), ev('0xt3', CHIP, 'inbound', 5)]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.equal(guard.rejectedEvents, 0)
  })
})

describe('liquidity transactions handed to FIFO', () => {
  it('lists every add and remove transaction, and no swap', () => {
    const legs = [
      ev('0xAdd', CHIP, 'outbound', 100), ev('0xAdd', USDC, 'outbound', 5),
      ev('0xrm2', CHIP, 'inbound', 90), ev('0xrm2', USDC, 'inbound', 5),
      ev('0xswap', USDC, 'outbound', 5), ev('0xswap', CHIP, 'inbound', 100),
    ]
    const guard = guardLiquidityLegs(legs, priceEverything)
    assert.deepEqual([...guard.liquidityTxKeys].sort(), ['base:0xadd', 'base:0xrm2'])
  })
})
