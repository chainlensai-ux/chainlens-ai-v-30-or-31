// TESTS — surgical cost-pass follow-up task: display-only pricingAtTime pass (pipeline/index.ts's
// syntheticPnl/syntheticPoolData feed) was completely ungated against priceLotsForWallet's own
// accepted-evidence skip, re-requesting a live GoldRush historical price for every buy/sell entry
// even when the canonical sample was already fully priced. Confirmed production waste:
// goldrush_getTokenPrices 22, callsWhoseResultWasUnused 22, on a second scan with
// manifestFound/applied and 21 fully priced canonical lots.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionAlreadyPricedEntries } from './priceLotsForWallet'
import type { PriceUsdLookup } from '../modules/fifoEngine/types'

function lookupFrom(known: Record<string, number>): PriceUsdLookup {
  return (event) => (event.txHash in known ? known[event.txHash] : null)
}

test('HARD ASSERTION: second scan with 21 fully priced canonical entries makes zero display-pass requests', () => {
  const buyEntries = Array.from({ length: 21 }, (_, i) => ({ txHash: `0xbuy${i}`, token: `0xtok${i}`, chain: 'base' as const, timestamp: i, amount: '1' }))
  const sellEntries = Array.from({ length: 21 }, (_, i) => ({ txHash: `0xsell${i}`, token: `0xtok${i}`, chain: 'base' as const, timestamp: 100 + i, amount: '1' }))
  const known: Record<string, number> = {}
  for (const e of buyEntries) known[e.txHash] = 5
  for (const e of sellEntries) known[e.txHash] = 7
  const priceUsdLookup = lookupFrom(known)

  const buyResult = partitionAlreadyPricedEntries(buyEntries, 'inbound', priceUsdLookup)
  const sellResult = partitionAlreadyPricedEntries(sellEntries, 'outbound', priceUsdLookup)

  assert.equal(buyResult.needsPricing.length, 0, 'no live requests for a fully-priced canonical buy side')
  assert.equal(sellResult.needsPricing.length, 0, 'no live requests for a fully-priced canonical sell side')
  assert.equal(buyResult.alreadyKnown.size, 21)
  assert.equal(sellResult.alreadyKnown.size, 21)
  for (const e of buyEntries) assert.equal(buyResult.alreadyKnown.get(e.txHash), 5)
  for (const e of sellEntries) assert.equal(sellResult.alreadyKnown.get(e.txHash), 7)
})

test('a genuinely unresolved side is still sent through, never silently dropped', () => {
  const buyEntries = [
    { txHash: '0xknown', token: '0xtok', chain: 'base' as const, timestamp: 1, amount: '1' },
    { txHash: '0xunknown', token: '0xtok', chain: 'base' as const, timestamp: 2, amount: '1' },
  ]
  const priceUsdLookup = lookupFrom({ '0xknown': 3 })

  const result = partitionAlreadyPricedEntries(buyEntries, 'inbound', priceUsdLookup)

  assert.equal(result.needsPricing.length, 1)
  assert.equal(result.needsPricing[0]?.txHash, '0xunknown')
  assert.equal(result.alreadyKnown.size, 1)
  assert.equal(result.alreadyKnown.get('0xknown'), 3)
})

test('direction is passed through to priceUsdLookup so a buy entry is never priced off the sell dictionary or vice versa', () => {
  const calls: Array<{ txHash: string; direction: string }> = []
  const priceUsdLookup: PriceUsdLookup = (event) => {
    calls.push({ txHash: event.txHash, direction: event.direction })
    return null
  }
  partitionAlreadyPricedEntries([{ txHash: '0xa', token: '0xtok', chain: 'base' as const, timestamp: 1, amount: '1' }], 'inbound', priceUsdLookup)
  partitionAlreadyPricedEntries([{ txHash: '0xb', token: '0xtok', chain: 'base' as const, timestamp: 1, amount: '1' }], 'outbound', priceUsdLookup)

  assert.deepEqual(calls, [
    { txHash: '0xa', direction: 'inbound' },
    { txHash: '0xb', direction: 'outbound' },
  ])
})

test('an empty entry list produces an empty split with no lookup calls', () => {
  let calls = 0
  const priceUsdLookup: PriceUsdLookup = () => { calls += 1; return null }
  const result = partitionAlreadyPricedEntries([], 'inbound', priceUsdLookup)
  assert.equal(result.needsPricing.length, 0)
  assert.equal(result.alreadyKnown.size, 0)
  assert.equal(calls, 0)
})
