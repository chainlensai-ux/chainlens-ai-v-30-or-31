// TESTS — Wallet Scanner follow-up (chronology + duplicate published lotId, after aee0aa67).
//
// Bug 1 confirmed in production: matchLotsFIFO matched a sell against the oldest STILL-OPEN lot for
// a token regardless of whether that lot's own openedAt was actually before the sell, fabricating
// closedAt < openedAt matches. Bug 2 confirmed in production: every MatchedLot from partial fills of
// the same open lot published the identical `lotId`, so publishedMatchedLots repeated one lotId
// across genuinely different matches with different amounts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLots, matchLotsFIFO } from './index'
import type { NormalizedEvent } from '../normalization/types'

let seq = 0
function evt(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: `0xtx${seq}`,
    timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
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

test('HARD ASSERTION: no matched lot ever has closedAt < openedAt — a sell with no genuinely earlier buy stays unmatched', () => {
  // Sell happens first; the only buy for this token is recorded LATER. There is no real earlier lot
  // to draw from, so the sell must be reported unmatched, never fabricated against the later buy.
  const sell = evt({ txHash: '0xsell1', direction: 'outbound', amount: 5, timestamp: new Date(1_700_000_000_000).toISOString() })
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', amount: 5, timestamp: new Date(1_700_000_005_000).toISOString() })

  const lots = buildLots([buy], [])
  const result = matchLotsFIFO(lots, [sell])

  for (const lot of result.matchedLots) {
    assert.ok(lot.closedAt >= lot.openedAt, `matched lot closedAt (${lot.closedAt}) must never be before openedAt (${lot.openedAt})`)
  }
  assert.equal(result.matchedLots.length, 0, 'a sell with no genuinely earlier buy must not be matched against a later buy')
  assert.equal(result.unmatchedSells, 1)
  assert.equal(result.unmatchedSellEvents[0]?.amount, 5)
  // The later buy remains a real, untouched open lot.
  assert.equal(result.remainingOpenLots.length, 1)
  assert.equal(result.remainingOpenLots[0]?.amountRemaining, 5)
})

test('a sell partially predating its token inventory only matches the portion covered by genuinely earlier buys', () => {
  const earlyBuy = evt({ txHash: '0xbuy-early', direction: 'inbound', amount: 3, timestamp: new Date(1_700_000_000_000).toISOString() })
  const sell = evt({ txHash: '0xsell-mid', direction: 'outbound', amount: 5, timestamp: new Date(1_700_000_002_000).toISOString() })
  const lateBuy = evt({ txHash: '0xbuy-late', direction: 'inbound', amount: 5, timestamp: new Date(1_700_000_004_000).toISOString() })

  const lots = buildLots([earlyBuy, lateBuy], [])
  const result = matchLotsFIFO(lots, [sell])

  assert.equal(result.matchedLots.length, 1)
  assert.equal(result.matchedLots[0]?.amount, 3, 'only the genuinely earlier 3 units may be matched')
  for (const lot of result.matchedLots) assert.ok(lot.closedAt >= lot.openedAt)
  assert.equal(result.unmatchedSells, 1)
  assert.equal(result.unmatchedSellEvents[0]?.amount, 2, 'the remaining 2 units have no earlier buy and stay unmatched')
})

test('HARD ASSERTION: published lotIds are unique across partial-fill matches of the same open lot', () => {
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', amount: 10, timestamp: new Date(1_700_000_000_000).toISOString() })
  const sellA = evt({ txHash: '0xsellA', direction: 'outbound', amount: 4, timestamp: new Date(1_700_000_001_000).toISOString() })
  const sellB = evt({ txHash: '0xsellB', direction: 'outbound', amount: 6, timestamp: new Date(1_700_000_002_000).toISOString() })

  const lots = buildLots([buy], [])
  const result = matchLotsFIFO(lots, [sellA, sellB])

  assert.equal(result.matchedLots.length, 2, 'the single open lot is split across two genuinely distinct partial-fill matches')
  const ids = result.matchedLots.map((l) => l.lotId)
  assert.equal(new Set(ids).size, ids.length, 'every published matched-lot id must be unique, even for partial fills of the same underlying lot')
  // Legitimate partial fills are never merged: distinct amounts, distinct closedTxHash, both present.
  const amounts = result.matchedLots.map((l) => l.amount).sort((a, b) => a - b)
  assert.deepEqual(amounts, [4, 6])
  const closedTxHashes = new Set(result.matchedLots.map((l) => l.closedTxHash))
  assert.equal(closedTxHashes.size, 2)
})

test('a single-fill match (no split) keeps its lotId identical to the underlying open lot id', () => {
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', amount: 5, timestamp: new Date(1_700_000_000_000).toISOString() })
  const sell = evt({ txHash: '0xsell1', direction: 'outbound', amount: 5, timestamp: new Date(1_700_000_001_000).toISOString() })

  const lots = buildLots([buy], [])
  const result = matchLotsFIFO(lots, [sell])

  assert.equal(result.matchedLots.length, 1)
  assert.equal(result.matchedLots[0]?.lotId, lots[0]?.lotId, 'an unsplit match publishes the exact same id as its open lot — no unnecessary suffix churn')
})
