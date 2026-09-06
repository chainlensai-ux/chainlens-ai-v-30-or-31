import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLots, matchLotsFIFO } from './index'
import type { NormalizedEvent } from '../normalization/types'

const WALLET = '0x84fa0f109d12db098846eb6eb456ec4dde8661f6'
const TOKEN = '0x5576d6ed9181f2225aff5282ac0ed29f755437ea'

function leg(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0xbuy', timestamp: '2026-01-01T00:00:00Z',
    fromAddress: '0x1111111111111111111111111111111111111111', toAddress: WALLET,
    contract: TOKEN, symbol: 'TOK', amount: 20_000, amountRaw: '20000000000', tokenDecimals: 6,
    direction: 'inbound', ...overrides,
  }
}

test('recovered non-router swap exit closes real earlier inventory structurally', () => {
  const buy = leg({})
  const receiptProvenSell = leg({
    txHash: '0xreceipt-proven-exit', timestamp: '2026-02-01T00:00:00Z', direction: 'outbound',
    fromAddress: WALLET, toAddress: '0xd230967560b5f3a568414e790a72ea83312ce863', amount: 11_306, amountRaw: '11306000000',
  })
  const result = matchLotsFIFO(buildLots([buy], []), [receiptProvenSell])
  assert.equal(result.matchedLots.length, 1)
  assert.equal(result.matchedLots[0].amount, 11_306)
  assert.equal(result.matchedLots[0].evidenceQuality, 'unpriced', 'structural matching must not invent prices')
  assert.equal(result.unmatchedSells, 0)
})

test('a recovered exit before any buy remains honestly unmatched', () => {
  const laterBuy = leg({ timestamp: '2026-03-01T00:00:00Z' })
  const earlierSell = leg({
    txHash: '0xpre-window-exit', timestamp: '2026-02-01T00:00:00Z', direction: 'outbound',
    fromAddress: WALLET, toAddress: '0xd230967560b5f3a568414e790a72ea83312ce863', amount: 11_306,
  })
  const result = matchLotsFIFO(buildLots([laterBuy], []), [earlierSell])
  assert.equal(result.matchedLots.length, 0)
  assert.equal(result.unmatchedSells, 1)
})
