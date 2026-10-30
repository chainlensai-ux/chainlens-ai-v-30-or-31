// Burns (transfers to the zero or dead address) are disposals, not trades: they consume FIFO inventory
// oldest-first and remove that inventory's cost basis, but never produce a matched lot, proceeds or a
// realized PnL figure, and never count as an unmatched sell. Amounts and hashes are the real DGUY
// creator wallet's (Base, 0x404a…d1af): a 146,339.4386 DGUY buy for 173.227618 USDC (0x8782…), then
// 1,000,000 DGUY sent to 0x…dEaD (0x1ede…); and a 30,000,000 DGUY burn (0x27d6…) against a
// 15,890,943.1168 DGUY launch buy.
//   npx tsx --test src/modules/fifoEngine/burnDisposal.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFifoOutput, buildLots, isBurnTransfer, matchLotsFIFO } from './index'
import type { NormalizedEvent } from '../normalization/types'

const WALLET = '0x404a2e936be3c9faccb4a59c764c1d14f6add1af'
const DGUY = '0xe34356dcd3d7bb991248f322e4ec31b5d60bc54e'
const DEAD = '0x000000000000000000000000000000000000dEaD'
const ZERO = '0x0000000000000000000000000000000000000000'
const ROUTER = '0x20f6ee51340adeed01a59b0e65cb3703f3dc860c'
const POOL = '0x4be684f77419999aa3e1162d25d9ae6ff64c05a0'

const raw = (whole: string) => { const [i, f = ''] = whole.split('.'); return (BigInt(i) * BigInt(10) ** BigInt(18) + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString() }
function evt(o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'txHash' | 'timestamp' | 'direction' | 'amount'>): NormalizedEvent {
  return { provider: 'goldrush', chain: 'base', fromAddress: WALLET, toAddress: WALLET, contract: DGUY, symbol: 'DGUY', amountRaw: raw(String(o.amount)), tokenDecimals: 18, ...o }
}

const buy146k = evt({ txHash: '0x87820bf9b166a8c8c5bb2b201dd8926dfe16220ebbc9df302e4d8d3686bed7db', timestamp: new Date(1792335785000).toISOString(), direction: 'inbound', amount: 146339.43860252292, fromAddress: ROUTER })
const burn1m = evt({ txHash: '0x1ede73e1d79c47fc69a1af810ec8de6f7b2d357ec912772fd878df0ca7fdc861', timestamp: new Date(1792335901000).toISOString(), direction: 'outbound', amount: 1000000, toAddress: DEAD })
const marketLookup = (e: NormalizedEvent) => e.amount * (175.0249505219809 / 146339.43860252292)
const paidLookup = (e: NormalizedEvent) => (e.txHash === buy146k.txHash ? 173.227618 : marketLookup(e))

test('only outbound transfers to the zero or dead address are burns', () => {
  assert.equal(isBurnTransfer(burn1m), true)
  assert.equal(isBurnTransfer({ direction: 'outbound', toAddress: ZERO }), true)
  assert.equal(isBurnTransfer({ direction: 'outbound', toAddress: POOL }), false)
  assert.equal(isBurnTransfer({ direction: 'inbound', toAddress: DEAD }), false)
})

test('a burn creates no matched lot, no proceeds and no realized PnL, and is never priced', () => {
  let burnLookups = 0
  const lookup = (e: NormalizedEvent) => { if (e.txHash === burn1m.txHash) burnLookups++; return paidLookup(e) }
  const result = matchLotsFIFO(buildLots([buy146k], [], lookup), [burn1m], lookup)
  assert.equal(result.matchedLots.length, 0)
  assert.equal(burnLookups, 0, 'the burn is never sent to a price lookup')
  assert.equal(result.burnDisposals.length, 1)
  assert.deepEqual(result.burnDisposals[0], {
    lotId: result.burnDisposals[0].lotId, token: DGUY, chain: 'base', openedAt: 1792335785000, openedTxHash: buy146k.txHash,
    burnedAt: 1792335901000, burnTxHash: burn1m.txHash, amount: 146339.43860252292, amountRaw: buy146k.amountRaw, costBasisRemovedUsd: 173.227618,
  })
})

test('the burned lot leaves inventory with its cost basis, so it cannot back a later sale or open position', () => {
  const sale = evt({ txHash: '0xsale', timestamp: new Date(1792336000000).toISOString(), direction: 'outbound', amount: 10, toAddress: POOL })
  const result = matchLotsFIFO(buildLots([buy146k], [], paidLookup), [burn1m, sale], marketLookup)
  assert.equal(result.remainingOpenLots.length, 0)
  assert.equal(result.matchedLots.length, 0, 'the later sale finds no lot: the burn already consumed it')
  assert.equal(result.unmatchedSells, 1)
})

test('burned quantity with no earlier lot is a burn, not an unmatched sell', () => {
  const { unmatchedSells, unmatchedSellEvents, unmatchedBurnEvents } = matchLotsFIFO(buildLots([buy146k], [], paidLookup), [burn1m], marketLookup)
  assert.equal(unmatchedSells, 0)
  assert.equal(unmatchedSellEvents.length, 0)
  assert.equal(unmatchedBurnEvents.length, 1)
  assert.equal(BigInt(unmatchedBurnEvents[0].unmatchedRaw!), BigInt(raw('1000000')) - BigInt(buy146k.amountRaw!))
})

test('a partial burn removes only its share of cost basis; the rest stays priced in inventory', () => {
  const smallBurn = evt({ txHash: '0xburnpart', timestamp: burn1m.timestamp, direction: 'outbound', amount: 46339.43860252292, toAddress: DEAD })
  const result = matchLotsFIFO(buildLots([buy146k], [], paidLookup), [smallBurn], marketLookup)
  const removed = result.burnDisposals[0].costBasisRemovedUsd!
  const left = result.remainingOpenLots[0].costBasisUsd!
  assert.ok(Math.abs(removed + left - 173.227618) < 1e-9)
  assert.ok(Math.abs(result.remainingOpenLots[0].amountRemaining - 100000) < 1e-9)
})

test('deterministic: the same events in any input order give the same burns and inventory', () => {
  const later = evt({ txHash: '0xbuy2', timestamp: new Date(1792335950000).toISOString(), direction: 'inbound', amount: 500, fromAddress: ROUTER })
  const burn2 = evt({ txHash: '0xburn2', timestamp: new Date(1792336100000).toISOString(), direction: 'outbound', amount: 200, toAddress: ZERO })
  const run = (buys: NormalizedEvent[], sells: NormalizedEvent[]) => {
    const r = matchLotsFIFO(buildLots(buys, [], paidLookup), sells, marketLookup)
    return JSON.stringify({ burns: r.burnDisposals, open: r.remainingOpenLots.map((l) => [l.lotId, l.amountRemaining, l.costBasisUsd]), unmatched: r.unmatchedBurnEvents.map((e) => e.unmatchedRaw) })
  }
  assert.equal(run([buy146k, later], [burn1m, burn2]), run([later, buy146k], [burn2, burn1m]))
})

test('buildFifoOutput: a 30M burn against an unpriced 15.89M launch buy adds no lot, PnL or unmatched sell', () => {
  const launch = evt({ txHash: '0x49320f7d55f4245fdc66bab4f50374cc3ecc2d995f14c1136a5335da1fbdd243', timestamp: new Date(1789415435000).toISOString(), direction: 'inbound', amount: 15890943.11684549, fromAddress: POOL })
  const burn30m = evt({ txHash: '0x27d614ea8becd95e9cc49dc76111f0a4beb6d61be2adf7405c28eec94bd1861e', timestamp: new Date(1789556173000).toISOString(), direction: 'outbound', amount: 30000000, toAddress: DEAD })
  const out = buildFifoOutput({ normalizedEvents: [launch, burn30m], recoveredRawEvents: [], walletAddress: WALLET, priceUsdLookup: (e) => (e.direction === 'outbound' ? e.amount * 0.001 : null) })
  assert.equal(out.matchedLots.length, 0)
  assert.equal(out.realizedPnlUsd, null)
  assert.equal(out.unmatchedSells, 0)
  assert.equal(out.burnDisposals?.length, 1)
  assert.equal(out.unmatchedBurnEvents?.length, 1)
  assert.equal(out.publicPnlStatus, 'unavailable', 'burns never make the public status look better')
})

test('an ordinary outbound sale is unchanged: market-valued proceeds and an unmatched remainder', () => {
  const sale = evt({ txHash: '0xsale', timestamp: burn1m.timestamp, direction: 'outbound', amount: 1000000, toAddress: POOL })
  const { matchedLots, unmatchedSells, burnDisposals } = matchLotsFIFO(buildLots([buy146k], [], paidLookup), [sale], marketLookup)
  assert.ok(Math.abs(matchedLots[0].proceedsUsd! - 175.0249505219809) < 1e-6)
  assert.equal(unmatchedSells, 1)
  assert.equal(burnDisposals.length, 0)
})
