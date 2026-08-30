import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkipCurrentPriceFallback } from './spamSkip'

describe('shouldSkipCurrentPriceFallback', () => {
  it('skips promotional spam symbols and implausible quantities, never ordinary tickers', () => {
    assert.equal(shouldSkipCurrentPriceFallback({ symbol: 'CLAIM-REWARDS.COM', amount: 1 }), true)
    assert.equal(shouldSkipCurrentPriceFallback({ symbol: 'AERO', amount: 1_000_000_000 }), true)
    assert.equal(shouldSkipCurrentPriceFallback({ symbol: 'AERO', amount: 10 }), false)
    assert.equal(shouldSkipCurrentPriceFallback({ symbol: null, amount: 10 }), false)
    assert.equal(shouldSkipCurrentPriceFallback({}), false)
  })
})
