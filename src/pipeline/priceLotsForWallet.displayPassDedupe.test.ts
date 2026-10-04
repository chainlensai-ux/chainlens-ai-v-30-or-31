// TESTS — surgical cost-pass follow-up task: display-only pricingAtTime pass (pipeline/index.ts's
// syntheticPnl/syntheticPoolData feed) was completely ungated against priceLotsForWallet's own
// accepted-evidence skip, re-requesting a live GoldRush historical price for every buy/sell entry
// even when the canonical sample was already fully priced. Confirmed production waste:
// goldrush_getTokenPrices 22, callsWhoseResultWasUnused 22, on a second scan with
// manifestFound/applied and 21 fully priced canonical lots.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionAlreadyPricedEntries } from './priceLotsForWallet'
import type { TxSideValueLookup } from '../lib/txSideEventAllocation'
import { buildTxSideEventPriceLookup, buildTxSideValueLookup } from '../lib/txSideEventAllocation'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { mergeNormalizedEvents } from '../modules/fifoEngine/utils'
import type { NormalizedEvent } from '../modules/normalization/types'

function lookupFrom(known: Record<string, number>): TxSideValueLookup {
  return (side) => (side.txHash in known ? known[side.txHash] : null)
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
  const priceUsdLookup: TxSideValueLookup = (side) => {
    calls.push({ txHash: side.txHash, direction: side.direction })
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
  const priceUsdLookup: TxSideValueLookup = () => { calls += 1; return null }
  const result = partitionAlreadyPricedEntries([], 'inbound', priceUsdLookup)
  assert.equal(result.needsPricing.length, 0)
  assert.equal(result.alreadyKnown.size, 0)
  assert.equal(calls, 0)
})

// ─── REGRESSION (5143d693 production crash): "Cannot read properties of undefined (reading
// 'toLowerCase')" — the display dedupe cast `{ txHash, direction }` to a NormalizedEvent and called the
// FIFO event-level allocator, which reads the event's contract/from/to. It now uses the side lookup the
// real pipeline wires (`buildTxSideValueLookup` over the same at-trade-time dictionaries).
const CLAW = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
const WALLET = `0x${'9'.repeat(40)}`
function ev(txHash: string, direction: 'inbound' | 'outbound', amount: number, at: string, counterparty = '0xpool'): NormalizedEvent {
  return {
    chain: 'base', txHash, contract: CLAW, direction, amount, timestamp: at, tokenDecimals: 18,
    fromAddress: direction === 'inbound' ? counterparty : WALLET, toAddress: direction === 'inbound' ? WALLET : counterparty,
    amountRaw: (BigInt(Math.round(amount * 1e6)) * BigInt(10) ** BigInt(12)).toString(),
  } as unknown as NormalizedEvent
}
const events = [
  ev('0xb1', 'inbound', 700, '2026-04-01T00:00:00Z'), ev('0xb2', 'inbound', 300, '2026-04-01T00:00:00Z'),
  ev('0xsx', 'outbound', 900, '2026-04-02T00:00:00Z', '0xpool'), ev('0xsx', 'outbound', 100, '2026-04-02T00:00:00Z', '0xfee'),
  ev('0xb3', 'inbound', 50, '2026-04-01T00:00:00Z'), ev('0xs3', 'outbound', 50, '2026-04-02T00:00:00Z'),
]
const costUsd: Record<string, number | null> = { '0xb1': 70, '0xb2': 30, '0xb3': 5 }
const proceedsUsd: Record<string, number | null> = { '0xsx': 90, '0xs3': 6 }

test('1-3. production shape: display entries through the real tx-side lookup — no crash, known sides deduped, unknown sides still priced', () => {
  const sideLookup = buildTxSideValueLookup(costUsd, proceedsUsd)
  const buys = [
    { txHash: '0xb1', token: CLAW, chain: 'base' as const, timestamp: 1, amount: '700' },
    { txHash: '0xunpriced', token: CLAW, chain: 'base' as const, timestamp: 2, amount: '1' },
  ]
  const sells = [{ txHash: '0xsx', token: CLAW, chain: 'base' as const, timestamp: 3, amount: '1000' }]
  let buyResult!: ReturnType<typeof partitionAlreadyPricedEntries<typeof buys[number]>>
  let sellResult!: ReturnType<typeof partitionAlreadyPricedEntries<typeof sells[number]>>
  assert.doesNotThrow(() => {
    buyResult = partitionAlreadyPricedEntries(buys, 'inbound', sideLookup)
    sellResult = partitionAlreadyPricedEntries(sells, 'outbound', sideLookup)
  })
  assert.deepEqual([...buyResult.alreadyKnown], [['0xb1', 70]])
  assert.deepEqual(buyResult.needsPricing.map((e) => e.txHash), ['0xunpriced'])
  assert.deepEqual([...sellResult.alreadyKnown], [['0xsx', 90]], 'the side value, once — never a per-event share or a multiple')
  assert.equal(sellResult.needsPricing.length, 0)
})

test('the event-level FIFO lookup is never handed a partial event by the display dedupe (it would crash on it)', () => {
  const { lookup } = buildTxSideEventPriceLookup(mergeNormalizedEvents(events, []), costUsd, proceedsUsd)
  assert.throws(() => lookup({ txHash: '0xsx', direction: 'outbound' } as NormalizedEvent), TypeError, 'a partial event is not a valid FIFO lookup input')
})

test('4. FIFO full-event lookup still allocates a multi-event side exactly once', () => {
  const merged = mergeNormalizedEvents(events, [])
  const { lookup } = buildTxSideEventPriceLookup(merged, costUsd, proceedsUsd)
  const lots = matchLotsFIFO(buildLots(merged, [], lookup), merged.filter((e) => e.direction === 'outbound'), lookup).matchedLots
  const sxProceeds = lots.filter((l) => l.closedTxHash === '0xsx').reduce((s, l) => s + (l.proceedsUsd ?? 0), 0)
  assert.equal(Math.round(sxProceeds * 1e8) / 1e8, 90)
})

test('5. single-event side behavior unchanged (event lookup and side lookup return the same value)', () => {
  const merged = mergeNormalizedEvents(events, [])
  const { lookup } = buildTxSideEventPriceLookup(merged, costUsd, proceedsUsd)
  const sideLookup = buildTxSideValueLookup(costUsd, proceedsUsd)
  const s3 = merged.find((e) => e.txHash === '0xs3')!
  const b3 = merged.find((e) => e.txHash === '0xb3')!
  assert.equal(lookup(s3), 6)
  assert.equal(lookup(b3), 5)
  assert.equal(sideLookup({ chain: 'base', txHash: '0xs3', direction: 'outbound', token: CLAW }), 6)
  assert.equal(sideLookup({ chain: 'base', txHash: '0xb3', direction: 'inbound', token: CLAW }), 5)
})
