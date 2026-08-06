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

// DUPLICATE-ECONOMIC-LOT FOLLOW-UP TASK — confirmed production bug: publishedMatchedLots carried
// two matches with identical token/openedAt/closedAt/openedTxHash/closedTxHash/amount/costBasisUsd/
// proceedsUsd/realizedPnlUsd, distinguished only by the occurrence-suffixed lotId (e.g. base id and
// `#3` for the exact same real match) — a genuine duplicate, not a legitimate partial fill. Root
// cause: mergeNormalizedEvents.ts's own `base` array was never deduped against itself. These tests
// exercise matchLotsFIFO's own publication-time economic-fingerprint safety net directly (the
// backstop), independent of that upstream source fix.
test('HARD ASSERTION (required regression): unique lotId is not enough — a true duplicate match (same sell processed twice) is never published twice', () => {
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', amount: 483894.23953504855, timestamp: new Date(1_700_000_000_000).toISOString() })
  const sell = evt({ txHash: '0xsell1', direction: 'outbound', amount: 483894.23953504855, timestamp: new Date(1_700_000_001_000).toISOString() })

  const lots = buildLots([buy], [])
  // The exact same sell event object appears twice in the input — simulating an undetected upstream
  // duplicate that bypassed mergeNormalizedEvents (this function's own defense-in-depth backstop).
  const result = matchLotsFIFO(lots, [sell, sell])

  assert.equal(result.matchedLots.length, 1, 'the true duplicate match is dropped — never published twice just because its lotId happens to differ')
  assert.equal(result.matchedLots[0]?.amount, 483894.23953504855)
})

test('legitimate partial fills across different sells are never collapsed by the economic-duplicate safety net', () => {
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', amount: 1212.7675176316989 * 2, timestamp: new Date(1_700_000_000_000).toISOString() })
  const sellA = evt({ txHash: '0xsellA', direction: 'outbound', amount: 1212.7675176316989, timestamp: new Date(1_700_000_001_000).toISOString() })
  const sellB = evt({ txHash: '0xsellB', direction: 'outbound', amount: 1212.7675176316989, timestamp: new Date(1_700_000_002_000).toISOString() })

  const lots = buildLots([buy], [])
  const result = matchLotsFIFO(lots, [sellA, sellB])

  // Two genuinely distinct matches (different closedTxHash) sharing the same amount must both survive
  // — the safety net only ever drops a match whose ENTIRE economic identity, closedTxHash included,
  // is byte-identical to an earlier one.
  assert.equal(result.matchedLots.length, 2, 'same-amount partial fills against different sells are real, distinct matches, never merged')
  const closedTxHashes = new Set(result.matchedLots.map((l) => l.closedTxHash))
  assert.equal(closedTxHashes.size, 2)
})

test('a genuine same-lotId partial-fill occurrence set (different amounts) is unaffected by the duplicate safety net', () => {
  const buy = evt({ txHash: '0xbuy1', direction: 'inbound', amount: 10, timestamp: new Date(1_700_000_000_000).toISOString() })
  const sellA = evt({ txHash: '0xsellA', direction: 'outbound', amount: 4, timestamp: new Date(1_700_000_001_000).toISOString() })
  const sellB = evt({ txHash: '0xsellB', direction: 'outbound', amount: 6, timestamp: new Date(1_700_000_002_000).toISOString() })

  const lots = buildLots([buy], [])
  const result = matchLotsFIFO(lots, [sellA, sellB])

  assert.equal(result.matchedLots.length, 2, 'genuinely distinct partial-fill amounts must both survive the economic-duplicate safety net')
})
