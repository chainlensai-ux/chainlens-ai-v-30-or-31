import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_USDC_ADDRESS } from '../normalization/canonicalDecimals'
import {
  amountInAtomicUnits, atomicUnitsToNumber, auditAtomicLotAmount, isEconomicAtomicLotAmount,
  isIntegerAtomicUnits, minimumAtomicAmount, numberToAtomicUnits, tokenCanonicalDecimals,
} from './atomicAmount'
import { buildLots, matchLotsFIFO } from './index'
import type { NormalizedEvent } from '../normalization/types'

const USDC = BASE_USDC_ADDRESS
let seq = 0
function evt(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'goldrush', chain: 'base', txHash: `0xtx${seq}`,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    fromAddress: '0xfrom', toAddress: '0xto', contract: USDC, symbol: 'USDC',
    amount: 1, amountRaw: '1000000', tokenDecimals: 6, direction: 'inbound',
    ...overrides,
  }
}

describe('FIFO atomic-unit remainder (sub-atomic USDC artifacts)', () => {
  it('classifies 1e-12 and 0 USDC as non-economic (below 1 atomic unit of 1e-6)', () => {
    for (const amount of [1e-12, 0, 9e-13, 1e-16]) {
      const audit = auditAtomicLotAmount(amount, 6)
      assert.equal(audit.canonicalTokenDecimals, 6)
      assert.equal(audit.minimumAtomicAmount, 1e-6)
      assert.equal(audit.economicLot, false)
      assert.equal(isIntegerAtomicUnits(amount, 6), amount === 0)
      assert.equal(isEconomicAtomicLotAmount(amount, 6), false)
    }
    const oneAtomic = auditAtomicLotAmount(0.000001, 6)
    assert.equal(oneAtomic.economicLot, true)
    assert.equal(oneAtomic.amountInAtomicUnits, '1')
    assert.equal(oneAtomic.isIntegerAtomicUnits, true)
  })

  it('HARD ASSERTION: USDC 6-decimal partial fills never emit amount below 1e-6', () => {
    const buy = evt({ txHash: '0xbuy', direction: 'inbound', amount: 1, amountRaw: '1000000' })
    const sells = Array.from({ length: 10 }, (_, i) => evt({
      txHash: `0xsell${i}`, direction: 'outbound', amount: 0.1, amountRaw: '100000',
    }))
    const lots = buildLots([buy], [])
    const result = matchLotsFIFO(lots, sells)
    assert.equal(result.matchedLots.length, 10)
    for (const lot of result.matchedLots) {
      assert.ok(lot.amount >= 1e-6, `USDC matched amount ${lot.amount} is below 1 atomic unit`)
      assert.equal(isEconomicAtomicLotAmount(lot.amount, 6), true)
    }
    assert.equal(result.remainingOpenLots.length, 0)
    assert.equal(result.unmatchedSells, 0)
    const matchedAtomic = result.matchedLots.reduce((sum, lot) => sum + numberToAtomicUnits(lot.amount, 6), BigInt(0))
    assert.equal(matchedAtomic, BigInt(1000000))
  })

  it('HARD ASSERTION: IEEE remaining -= 0.1 ten times cannot emit a 11th sub-atomic USDC lot', () => {
    let floatRemaining = 1
    let floatDustLots = 0
    for (let i = 0; i < 11; i++) {
      const take = Math.min(floatRemaining, 0.1)
      if (floatRemaining > 0 && take > 0) {
        floatDustLots += 1
        floatRemaining -= take
      }
    }
    assert.ok(floatDustLots >= 11 || floatRemaining > 0, 'the float path must be shown to leave a residual or extra fill')

    const buy = evt({ txHash: '0xbuy-float', direction: 'inbound', amount: 1, amountRaw: '1000000' })
    const sells = Array.from({ length: 11 }, (_, i) => evt({
      txHash: `0xsell-float${i}`, direction: 'outbound', amount: 0.1, amountRaw: '100000',
    }))
    const result = matchLotsFIFO(buildLots([buy], []), sells)
    assert.equal(result.matchedLots.length, 10, '11th 0.1 sell has no remaining atomic inventory')
    assert.ok(result.matchedLots.every((lot) => lot.amount >= 1e-6))
    assert.equal(result.remainingOpenLots.length, 0)
    const eleventh = result.unmatchedSellEvents[0]
    assert.equal(result.unmatchedSells, 1)
    assert.equal(numberToAtomicUnits(eleventh?.amount ?? 0, 6), BigInt(100000))
  })

  it('HARD ASSERTION: integer atomic amount is conserved buy → FIFO → matched sells', () => {
    const buy = evt({ txHash: '0xbuy-cons', direction: 'inbound', amount: 2.996415, amountRaw: '2996415' })
    const sellA = evt({ txHash: '0xsell-a', direction: 'outbound', amount: 1.5, amountRaw: '1500000' })
    const sellB = evt({ txHash: '0xsell-b', direction: 'outbound', amount: 1.496415, amountRaw: '1496415' })
    const result = matchLotsFIFO(buildLots([buy], []), [sellA, sellB])
    const buyAtomic = numberToAtomicUnits(2.996415, 6)
    const matchedAtomic = result.matchedLots.reduce((sum, lot) => sum + numberToAtomicUnits(lot.amount, 6), BigInt(0))
    assert.equal(buyAtomic, BigInt(2996415))
    assert.equal(matchedAtomic, buyAtomic)
    assert.equal(result.remainingOpenLots.length, 0)
    assert.ok(result.matchedLots.every((lot) => isIntegerAtomicUnits(lot.amount, 6)))
  })

  it('HARD ASSERTION: 18-decimal tokens retain legitimate 1-wei amounts', () => {
    const weth = '0x4200000000000000000000000000000000000006'
    const buy = evt({
      contract: weth, symbol: 'WETH', tokenDecimals: 18, amount: 1e-18,
      amountRaw: '1', txHash: '0xbuy-wei', direction: 'inbound',
    })
    const sell = evt({
      contract: weth, symbol: 'WETH', tokenDecimals: 18, amount: 1e-18,
      amountRaw: '1', txHash: '0xsell-wei', direction: 'outbound',
    })
    assert.equal(tokenCanonicalDecimals('base', weth, 18), 18)
    assert.equal(minimumAtomicAmount(18), 1e-18)
    assert.equal(isEconomicAtomicLotAmount(1e-18, 18), true)
    const result = matchLotsFIFO(buildLots([buy], []), [sell])
    assert.equal(result.matchedLots.length, 1)
    assert.equal(result.matchedLots[0]?.amount, 1e-18)
  })

  it('HARD ASSERTION: ordinary integer lots are unchanged', () => {
    const token = '0xtokenordinary'
    const buy = evt({
      contract: token, symbol: 'TOK', tokenDecimals: 18, amount: 10,
      amountRaw: '10000000000000000000', txHash: '0xbuy-ord', direction: 'inbound',
    })
    const sellA = evt({
      contract: token, symbol: 'TOK', tokenDecimals: 18, amount: 4,
      amountRaw: '4000000000000000000', txHash: '0xsell-ord-a', direction: 'outbound',
    })
    const sellB = evt({
      contract: token, symbol: 'TOK', tokenDecimals: 18, amount: 6,
      amountRaw: '6000000000000000000', txHash: '0xsell-ord-b', direction: 'outbound',
    })
    const result = matchLotsFIFO(buildLots([buy], []), [sellA, sellB])
    assert.equal(result.matchedLots.length, 2)
    assert.equal(result.matchedLots[0]?.amount, 4)
    assert.equal(result.matchedLots[1]?.amount, 6)
    assert.equal(result.remainingOpenLots.length, 0)
    assert.equal(result.unmatchedSells, 0)
  })

  it('sub-atomic USDC inventory is not an open lot after FIFO', () => {
    const buy = evt({ txHash: '0xbuy-dust', direction: 'inbound', amount: 1e-12, amountRaw: '0' })
    const lots = buildLots([buy], [])
    const result = matchLotsFIFO(lots, [])
    assert.equal(result.remainingOpenLots.length, 0)
    assert.equal(amountInAtomicUnits(1e-12, 6), BigInt(0))
    assert.equal(atomicUnitsToNumber(BigInt(0), 6), 0)
  })
})
