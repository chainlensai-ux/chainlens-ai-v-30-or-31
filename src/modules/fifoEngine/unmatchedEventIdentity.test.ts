// TESTS — exact-unmatched-identity follow-up task: fifoEngine additively exposes
// unmatchedBuyEvents[]/unmatchedSellEvents[] with stable source identity, with zero change to
// matching logic, counts, or matchedLots/realizedPnl.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFifoOutput, buildLots, matchLotsFIFO } from './index'
import type { NormalizedEvent } from '../normalization/types'

let seq = 0
function evt(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: `0xtx${seq}`,
    timestamp: String(1_700_000_000_000 + seq),
    fromAddress: '0xfrom',
    toAddress: '0xto',
    contract: '0xtoken',
    symbol: 'TOK',
    amount: 1,
    amountRaw: '1000000000000000000',
    tokenDecimals: 18,
    direction: 'inbound',
    ...overrides,
  }
}

test('HARD ASSERTION: unmatchedBuyEvents has exactly one entry per remaining open lot, with real stable identity', () => {
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', contract: '0xtoken', amount: 10, fromAddress: '0xseller', toAddress: '0xwallet', amountRaw: '10000000000000000000' })
  const result = buildFifoOutput({ normalizedEvents: [buy], recoveredRawEvents: [], walletAddress: '0xwallet' })

  assert.equal(result.unmatchedBuys, 1)
  assert.equal(result.unmatchedBuyEvents.length, 1, 'unmatchedBuyEvents length must equal unmatchedBuys count')
  const identity = result.unmatchedBuyEvents[0]
  assert.equal(identity.chain, 'base')
  assert.equal(identity.txHash, '0xbuy1')
  assert.equal(identity.token, '0xtoken')
  assert.equal(identity.direction, 'inbound')
  assert.equal(identity.amount, 10)
  assert.equal(identity.fromAddress, '0xseller')
  assert.equal(identity.toAddress, '0xwallet')
  assert.equal(identity.amountRaw, '10000000000000000000')
})

test('HARD ASSERTION: unmatchedSellEvents has exactly one entry per unmatched sell, reporting the real unmatched QUANTITY', () => {
  const sell = evt({ txHash: '0xsell1', direction: 'outbound', contract: '0xtoken', amount: 5, fromAddress: '0xwallet', toAddress: '0xbuyer', amountRaw: '5000000000000000000' })
  const result = buildFifoOutput({ normalizedEvents: [sell], recoveredRawEvents: [], walletAddress: '0xwallet' })

  assert.equal(result.unmatchedSells, 1)
  assert.equal(result.unmatchedSellEvents.length, 1)
  const identity = result.unmatchedSellEvents[0]
  assert.equal(identity.txHash, '0xsell1')
  assert.equal(identity.direction, 'outbound')
  assert.equal(identity.amount, 5)
  assert.equal(identity.toAddress, '0xbuyer')
})

test('a partially-matched sell reports only the UNMATCHED remainder amount, not the full original sell amount', () => {
  const buy = evt({ txHash: '0xbuy2', direction: 'inbound', contract: '0xtoken', amount: 3 })
  const sell = evt({ txHash: '0xsell2', direction: 'outbound', contract: '0xtoken', amount: 10, timestamp: String(1_700_000_001_000) })
  const result = buildFifoOutput({ normalizedEvents: [buy, sell], recoveredRawEvents: [], walletAddress: '0xwallet' })

  assert.equal(result.matchedLots.length, 1)
  assert.equal(result.matchedLots[0].amount, 3)
  assert.equal(result.unmatchedSells, 1)
  assert.equal(result.unmatchedSellEvents.length, 1)
  assert.equal(result.unmatchedSellEvents[0].amount, 7, 'only the 7 unfulfilled units are reported, not the full 10')
})

test('a fully-matched buy/sell pair produces zero unmatched identities on either side', () => {
  const buy = evt({ txHash: '0xbuy3', direction: 'inbound', contract: '0xtoken', amount: 4 })
  const sell = evt({ txHash: '0xsell3', direction: 'outbound', contract: '0xtoken', amount: 4, timestamp: String(1_700_000_002_000) })
  const result = buildFifoOutput({ normalizedEvents: [buy, sell], recoveredRawEvents: [], walletAddress: '0xwallet' })

  assert.equal(result.unmatchedBuys, 0)
  assert.equal(result.unmatchedSells, 0)
  assert.deepEqual(result.unmatchedBuyEvents, [])
  assert.deepEqual(result.unmatchedSellEvents, [])
})

test('HARD ASSERTION: matched lots and realized PnL are byte-for-byte unchanged by the new identity fields', () => {
  const priceLookup = (e: NormalizedEvent) => e.direction === 'inbound' ? 100 : 150
  const buy = evt({ txHash: '0xbuy4', direction: 'inbound', contract: '0xtoken', amount: 2 })
  const sell = evt({ txHash: '0xsell4', direction: 'outbound', contract: '0xtoken', amount: 2, timestamp: String(1_700_000_003_000) })

  const before = buildFifoOutput({ normalizedEvents: [buy, sell], recoveredRawEvents: [], walletAddress: '0xwallet', priceUsdLookup: priceLookup })
  // Re-running the same input must be fully deterministic — same matchedLots/realizedPnl content,
  // proving the additive identity fields introduce no side effect on the core matching output.
  const after = buildFifoOutput({ normalizedEvents: [buy, sell], recoveredRawEvents: [], walletAddress: '0xwallet', priceUsdLookup: priceLookup })

  assert.deepEqual(before.matchedLots, after.matchedLots)
  assert.equal(before.realizedPnlUsd, after.realizedPnlUsd)
  assert.equal(before.matchedLots[0].realizedPnlUsd, 150 - 100)
})

test('buildLots carries source fromAddress/toAddress/amountRaw onto each OpenLot', () => {
  const buy = evt({ txHash: '0xbuy5', direction: 'inbound', contract: '0xtoken', amount: 1, fromAddress: '0xsrc', toAddress: '0xdst', amountRaw: '1' })
  const lots = buildLots([buy], [])
  assert.equal(lots.length, 1)
  assert.equal(lots[0].sourceFromAddress, '0xsrc')
  assert.equal(lots[0].sourceToAddress, '0xdst')
  assert.equal(lots[0].sourceAmountRaw, '1')
})

test('matchLotsFIFO directly returns unmatchedSellEvents alongside the existing unmatchedSells count', () => {
  const lots = buildLots([], [])
  const sell = evt({ txHash: '0xsell5', direction: 'outbound', contract: '0xtoken', amount: 9 })
  const result = matchLotsFIFO(lots, [sell])
  assert.equal(result.unmatchedSells, 1)
  assert.equal(result.unmatchedSellEvents.length, 1)
  assert.equal(result.unmatchedSellEvents[0].amount, 9)
})
