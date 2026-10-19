// Market-history prices count as verified only for majors, and only within an hour of the trade.
//   npx tsx --test src/lib/majorMarketPrice.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptsMajorMarketPrice, CBBTC_ADDRESS } from './majorMarketPrice'

const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const MEME = '0x1111111111166b7fe7bd91427724b487980afc69'
const MIN = 60_000

describe('acceptsMajorMarketPrice', () => {
  it('accepts WETH, cbBTC and USDC within an hour', () => {
    assert.equal(acceptsMajorMarketPrice('base', WETH, 20 * MIN), true)
    assert.equal(acceptsMajorMarketPrice('base', CBBTC_ADDRESS, 60 * MIN), true)
    assert.equal(acceptsMajorMarketPrice('base', USDC, 0), true)
  })
  it('rejects prices farther than an hour, or a missing distance', () => {
    assert.equal(acceptsMajorMarketPrice('base', WETH, 61 * MIN), false)
    assert.equal(acceptsMajorMarketPrice('base', WETH, 22 * 60 * MIN), false)
    assert.equal(acceptsMajorMarketPrice('base', WETH, undefined), false)
  })
  it('never accepts other tokens', () => {
    assert.equal(acceptsMajorMarketPrice('base', MEME, 0), false)
  })
})
