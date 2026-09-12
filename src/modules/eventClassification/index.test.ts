// TESTS — evidence-first PnL completion task, requirements #1-#6, #10.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NormalizedEvent } from '../normalization/types'
import { classifyEvents, filterToFifoEligible, countByClassification, isFifoEligible, DUST_AMOUNT_THRESHOLD, auditDistributionDirection, computeStructuralCoverageAudit, computeExactStructuralCoverageAudit, computeUnmatchedEvidenceAudit, buildCriticalTradeEvidenceGapAudit, buildCanonicalWinningJoinGroups } from './index'
import type { UnmatchedEventIdentity } from '../fifoEngine/types'

const WALLET = '0xwallet'
const ROUTER = '0xrouter'
const TOKEN_A = '0xtokena'
const TOKEN_B = '0xtokenb'
const TOKEN_C = '0xtokenc'

let seq = 0
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: `0xtx${seq}`,
    timestamp: String(seq),
    fromAddress: '',
    toAddress: '',
    contract: TOKEN_A,
    symbol: 'TOK',
    amount: 1,
    amountRaw: '1000000000000000000',
    tokenDecimals: 18,
    direction: 'inbound',
    ...overrides,
  }
}

const noRouters = { knownDexRouterAddresses: new Set<string>() }

test('HARD ASSERTION: a two-sided same-tx flow (wallet paid token A, received token B) classifies both legs as genuine_trade_leg', () => {
  const txHash = '0xswap1'
  const out = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 10, fromAddress: WALLET, toAddress: ROUTER })
  const inn = event({ txHash, direction: 'inbound', contract: TOKEN_B, amount: 20, fromAddress: ROUTER, toAddress: WALLET })
  const result = classifyEvents([out, inn], noRouters)
  assert.equal(result.find((r) => r.event === out)!.classification, 'genuine_trade_leg')
  assert.equal(result.find((r) => r.event === inn)!.classification, 'genuine_trade_leg')
})

// NON-REGRESSION, DISCLOSED: a lone single-leg event (no counterpart in its own transaction) is
// exactly how most real CEX-withdrawal buys and direct-to-exchange sells look on-chain — fifoEngine
// has always correctly treated these as trades. This classifier must never reclassify them, or it
// would regress a huge share of today's genuinely correct closed lots (see index.ts's own
// "NON-REGRESSION SCOPING" disclosure).
test('HARD ASSERTION: a lone single-leg transfer with no counterpart in its own transaction stays genuine_trade_leg — never regressed', () => {
  const inbound = event({ txHash: '0xlonebuy', direction: 'inbound', contract: TOKEN_A, amount: 0.67 })
  const outbound = event({ txHash: '0xlonesell', direction: 'outbound', contract: TOKEN_B, amount: 12 })
  const result = classifyEvents([inbound, outbound], noRouters)
  assert.equal(result.find((r) => r.event === inbound)!.classification, 'genuine_trade_leg')
  assert.equal(result.find((r) => r.event === outbound)!.classification, 'genuine_trade_leg')
})

test('HARD ASSERTION: a same-token duplicate/refund pair that is NOT router-mediated is ordinary_transfer for the non-net-contributing leg (0.67-token ordinary-transfer fixture)', () => {
  const txHash = '0xduplicate1'
  // Wallet actually received 10 net TOKEN_A (two separate inbound legs, e.g. a split transfer):
  // one real 9.33 leg and one small 0.67 leg that, on its own, does not represent a distinct
  // economic event — both agree with the net direction here, so both remain genuine. To exercise
  // an actual non-net-contributing leg, add a small REFUND-shaped outbound of 0.67 back out —
  // that leg opposes the token's own net (still positive overall) and is not router-mediated.
  const mainIn = event({ txHash, direction: 'inbound', contract: TOKEN_A, amount: 10 })
  const refundOut = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 0.67 })
  const result = classifyEvents([mainIn, refundOut], noRouters)
  assert.equal(result.find((r) => r.event === mainIn)!.classification, 'genuine_trade_leg')
  assert.equal(result.find((r) => r.event === refundOut)!.classification, 'ordinary_transfer')
  assert.equal(isFifoEligible('ordinary_transfer'), false)
})

test('HARD ASSERTION: an internal hop token that nets to zero within a multi-leg tx and touches a known router is router_intermediary, not a trade leg', () => {
  const txHash = '0xhop1'
  // Wallet's real economic flow: paid TOKEN_A, received TOKEN_C. TOKEN_B passes through the
  // wallet via a known router (received then immediately sent onward) and nets to zero.
  const paidA = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 10 })
  const hopInB = event({ txHash, direction: 'inbound', contract: TOKEN_B, amount: 5, fromAddress: ROUTER })
  const hopOutB = event({ txHash, direction: 'outbound', contract: TOKEN_B, amount: 5, toAddress: ROUTER })
  const receivedC = event({ txHash, direction: 'inbound', contract: TOKEN_C, amount: 15 })
  const result = classifyEvents([paidA, hopInB, hopOutB, receivedC], { knownDexRouterAddresses: new Set([ROUTER]) })
  assert.equal(result.find((r) => r.event === paidA)!.classification, 'genuine_trade_leg')
  assert.equal(result.find((r) => r.event === receivedC)!.classification, 'genuine_trade_leg')
  assert.equal(result.find((r) => r.event === hopInB)!.classification, 'router_intermediary')
  assert.equal(result.find((r) => r.event === hopOutB)!.classification, 'router_intermediary')
})

test('HARD ASSERTION: a negligible on-chain amount is dust_non_economic, distinct from a real 0.67-token transfer', () => {
  const dust = event({ txHash: '0xdust1', direction: 'inbound', contract: TOKEN_A, amount: DUST_AMOUNT_THRESHOLD / 10 })
  const real = event({ txHash: '0xreal1', direction: 'inbound', contract: TOKEN_A, amount: 0.67 })
  const result = classifyEvents([dust, real], noRouters)
  assert.equal(result.find((r) => r.event === dust)!.classification, 'dust_non_economic')
  assert.equal(result.find((r) => r.event === real)!.classification, 'genuine_trade_leg')
})

test('HARD ASSERTION: repeated identical-amount inbound transfers with no outbound counterpart ever are distribution_airdrop (500-token distribution fixture)', () => {
  const drop1 = event({ txHash: '0xdrop1', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const drop2 = event({ txHash: '0xdrop2', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const drop3 = event({ txHash: '0xdrop3', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const result = classifyEvents([drop1, drop2, drop3], noRouters)
  for (const r of result) assert.equal(r.classification, 'distribution_airdrop')
})

test('a repeated identical-amount inbound pattern that ALSO has an outbound leg for the same token is NOT reclassified as an airdrop', () => {
  const drop1 = event({ txHash: '0xdrop1', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const drop2 = event({ txHash: '0xdrop2', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const sold = event({ txHash: '0xsold1', direction: 'outbound', contract: TOKEN_A, amount: 500 })
  const result = classifyEvents([drop1, drop2, sold], noRouters)
  assert.equal(result.find((r) => r.event === drop1)!.classification, 'genuine_trade_leg')
  assert.equal(result.find((r) => r.event === drop2)!.classification, 'genuine_trade_leg')
})

test('an event with direction "unknown" (neither side matches the wallet) classifies as unknown, never dropped', () => {
  const e = event({ direction: 'unknown' })
  const result = classifyEvents([e], noRouters)
  assert.equal(result[0].classification, 'unknown')
  assert.equal(isFifoEligible('unknown'), true)
})

test('HARD ASSERTION: filterToFifoEligible removes distributions and router-intermediary legs, keeping genuine trade legs (including lone single-leg buys/sells)', () => {
  const txHash = '0xswap2'
  const tradeOut = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 10 })
  const tradeIn = event({ txHash, direction: 'inbound', contract: TOKEN_B, amount: 20 })
  const loneBuy = event({ txHash: '0xlone', direction: 'inbound', contract: TOKEN_C, amount: 0.67 })
  const airdrop1 = event({ txHash: '0xair1', direction: 'inbound', contract: TOKEN_C, amount: 500 })
  const airdrop2 = event({ txHash: '0xair2', direction: 'inbound', contract: TOKEN_C, amount: 500 })

  const filtered = filterToFifoEligible([tradeOut, tradeIn, loneBuy, airdrop1, airdrop2], noRouters)
  assert.deepEqual(filtered, [tradeOut, tradeIn, loneBuy])
})

test('classifyEvents preserves input order and length (one output entry per input event)', () => {
  const events = [event(), event(), event()]
  const result = classifyEvents(events, noRouters)
  assert.equal(result.length, 3)
  for (let i = 0; i < events.length; i++) assert.equal(result[i].event, events[i])
})

test('countByClassification reports real counts for every one of the 8 declared categories', () => {
  const classified = classifyEvents([event({ txHash: '0xa', direction: 'inbound', amount: 0.67 })], noRouters)
  const counts = countByClassification(classified)
  assert.equal(Object.keys(counts).length, 8)
  assert.equal(counts.genuine_trade_leg, 1)
})

// =================================================================================================
// PRODUCTION-EVIDENCE FOLLOW-UP — confirmed bug: a real closed lot was lost because its tiny
// (dust-threshold) buy-side event was excluded from FIFO while its normal-sized sell-side event
// stayed in and became an unmatched sell.
// =================================================================================================

test('HARD ASSERTION: a tiny buy later sold must remain matchable — dust is a classification label, never a pre-FIFO exclusion', () => {
  const tinyBuy = event({ txHash: '0xtinybuy', direction: 'inbound', contract: TOKEN_A, amount: DUST_AMOUNT_THRESHOLD / 10 })
  const sell = event({ txHash: '0xnormalsell', direction: 'outbound', contract: TOKEN_A, amount: DUST_AMOUNT_THRESHOLD / 10 })

  const classified = classifyEvents([tinyBuy, sell], noRouters)
  assert.equal(classified.find((c) => c.event === tinyBuy)!.classification, 'dust_non_economic', 'still classified dust for display/stats purposes')
  assert.equal(isFifoEligible('dust_non_economic'), true, 'HARD ASSERTION: dust must be FIFO-eligible — it can never delete a canonical event before matching')

  const filtered = filterToFifoEligible([tinyBuy, sell], noRouters)
  assert.deepEqual(filtered, [tinyBuy, sell], 'both the dust-labeled buy and its sell must reach FIFO — dust is applied only after, for display/stats/significance')
})

test('dust label is applied for display/stats only, after FIFO — never removes the event itself', () => {
  const tinyBuy = event({ txHash: '0xtinybuy2', direction: 'inbound', contract: TOKEN_A, amount: DUST_AMOUNT_THRESHOLD / 5 })
  const classified = classifyEvents([tinyBuy], noRouters)
  assert.equal(classified[0].classification, 'dust_non_economic')
  const filtered = filterToFifoEligible([tinyBuy], noRouters)
  assert.equal(filtered.length, 1, 'the dust-classified event itself is never removed from the FIFO-eligible set')
  assert.equal(filtered[0], tinyBuy)
})

// =================================================================================================
// PRODUCTION-EVIDENCE FOLLOW-UP — requirement #2: an outbound distribution must never be treated as
// a genuine unmatched sell.
// =================================================================================================

test('HARD ASSERTION: repeated identical-amount OUTBOUND transfers with no inbound counterpart ever are distribution_airdrop (outbound distributor pattern), never genuine sells', () => {
  const out1 = event({ txHash: '0xdist1', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const out2 = event({ txHash: '0xdist2', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const out3 = event({ txHash: '0xdist3', direction: 'outbound', contract: TOKEN_B, amount: 500 })

  const classified = classifyEvents([out1, out2, out3], noRouters)
  for (const c of classified) assert.equal(c.classification, 'distribution_airdrop')
  assert.equal(isFifoEligible('distribution_airdrop'), false)

  const filtered = filterToFifoEligible([out1, out2, out3], noRouters)
  assert.deepEqual(filtered, [], 'none of the outbound-distribution legs may enter FIFO as sells')
})

test('auditDistributionDirection reports the real inbound-airdrop vs outbound-distribution split', () => {
  const inbound1 = event({ txHash: '0xin1', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const inbound2 = event({ txHash: '0xin2', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const outbound1 = event({ txHash: '0xout1', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const outbound2 = event({ txHash: '0xout2', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const genuine = event({ txHash: '0xgenuine1', direction: 'inbound', contract: TOKEN_C, amount: 3 })

  const classified = classifyEvents([inbound1, inbound2, outbound1, outbound2, genuine], noRouters)
  const audit = auditDistributionDirection(classified)
  assert.equal(audit.inboundAirdrop, 2)
  assert.equal(audit.outboundDistribution, 2)
  assert.equal(audit.genuineTradeLeg, 1)
})

// =================================================================================================
// PRODUCTION-EVIDENCE FOLLOW-UP — requirements #3/#4: structural coverage denominator audit.
// =================================================================================================

test('HARD ASSERTION: the structural coverage denominator excludes proven non-trades and dust from unmatched counts', () => {
  const distribution = event({ txHash: '0xd1', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const distribution2 = event({ txHash: '0xd2', direction: 'inbound', contract: TOKEN_A, amount: 500 })
  const tinyDust = event({ txHash: '0xdust1', direction: 'inbound', contract: TOKEN_B, amount: DUST_AMOUNT_THRESHOLD / 10 })
  const genuineTrade = event({ txHash: '0xg1', direction: 'inbound', contract: TOKEN_C, amount: 5 })

  const classified = classifyEvents([distribution, distribution2, tinyDust, genuineTrade], noRouters)
  // Simulates fifoEngine's own raw counts: the distribution pair never reached FIFO at all (already
  // excluded), so it contributes nothing to fifoUnmatchedBuys; the dust event DID reach FIFO (per
  // this task's requirement #1) and, in this scenario, remained unmatched.
  const audit = computeStructuralCoverageAudit(classified, /* closedLotCount */ 0, /* fifoUnmatchedBuys */ 2, /* fifoUnmatchedSells */ 0)
  assert.equal(audit.rawUnmatchedBuys, 2)
  assert.equal(audit.genuineUnmatchedBuys, 1, 'the dust-classified unmatched buy is excluded from the genuine denominator, leaving only the real trade leg')
  assert.equal(audit.excludedNonTradeBuys.distribution_airdrop, 2)
  assert.equal(audit.structuralCoverageDenominator, 0 + 1 + 0)
})

test('structural coverage denominator falls back to raw unmatched counts when no dust is present', () => {
  const genuineBuy = event({ txHash: '0xg2', direction: 'inbound', contract: TOKEN_A, amount: 5 })
  const classified = classifyEvents([genuineBuy], noRouters)
  const audit = computeStructuralCoverageAudit(classified, 3, 1, 2)
  assert.equal(audit.genuineUnmatchedBuys, 1)
  assert.equal(audit.genuineUnmatchedSells, 2)
  assert.equal(audit.structuralCoverageNumerator, 3)
  assert.equal(audit.structuralCoverageDenominator, 6)
  assert.equal(audit.structuralCoverage, 3 / 6)
})

// =================================================================================================
// EXACT-UNMATCHED-IDENTITY FOLLOW-UP TASK — computeExactStructuralCoverageAudit joins fifoEngine's
// real unmatched source identities against this module's own classification.
// =================================================================================================

function unmatchedIdentity(overrides: Partial<UnmatchedEventIdentity> = {}): UnmatchedEventIdentity {
  return {
    chain: 'base', txHash: '0xtx1', token: TOKEN_A, timestamp: 1, direction: 'inbound', amount: 1,
    fromAddress: '', toAddress: '', amountRaw: null,
    ...overrides,
  }
}

test('HARD ASSERTION: repeated outbound distributions do not block structural coverage — excluded from genuineUnmatchedSells via the exact join', () => {
  const dist1 = event({ txHash: '0xdist1', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const dist2 = event({ txHash: '0xdist2', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const dist3 = event({ txHash: '0xdist3', direction: 'outbound', contract: TOKEN_B, amount: 500 })
  const classified = classifyEvents([dist1, dist2, dist3], noRouters)
  for (const c of classified) assert.equal(c.classification, 'distribution_airdrop')

  // These never reach FIFO at all (distribution_airdrop is excluded pre-FIFO), so a real
  // fifoEngine would never report them as unmatchedSellEvents in the first place — this test
  // proves the join ALSO correctly excludes them if they were ever passed in (defense in depth).
  const unmatchedSellEvents = [dist1, dist2, dist3].map((e) => unmatchedIdentity({ txHash: e.txHash, token: TOKEN_B, direction: 'outbound', amount: e.amount }))
  const audit = computeExactStructuralCoverageAudit(classified, 0, [], unmatchedSellEvents)
  assert.equal(audit.genuineUnmatchedSells, 0, 'outbound distributions must never count as genuine unmatched sells')
  assert.equal(audit.excludedUnmatchedByClassification.distribution_airdrop, 3)
  assert.equal(audit.structuralCoverageDenominator, 0, 'zero closed lots + zero genuine unmatched = a fully empty, non-blocking denominator')
})

test('HARD ASSERTION: tiny unmatched dust remains visible (excludedUnmatchedByClassification) but does not count as genuine trade evidence', () => {
  const tinyBuy = event({ txHash: '0xtiny1', direction: 'inbound', contract: TOKEN_A, amount: DUST_AMOUNT_THRESHOLD / 10 })
  const classified = classifyEvents([tinyBuy], noRouters)
  assert.equal(classified[0].classification, 'dust_non_economic')

  const unmatchedBuyEvents = [unmatchedIdentity({ txHash: '0xtiny1', token: TOKEN_A, direction: 'inbound', amount: DUST_AMOUNT_THRESHOLD / 10 })]
  const audit = computeExactStructuralCoverageAudit(classified, 0, unmatchedBuyEvents, [])
  assert.equal(audit.genuineUnmatchedBuys, 0, 'dust never counts as genuine trade evidence')
  assert.equal(audit.excludedUnmatchedByClassification.dust_non_economic, 1, 'but it remains visible in the exact breakdown')
  assert.equal(audit.unmatchedIdentityJoinFailures, 0)
})

test('HARD ASSERTION: an unmatched identity with no classified counterpart is a join failure and still blocks (fail-closed)', () => {
  const classified = classifyEvents([], noRouters) // no source events at all — simulates a join gap
  const orphan = unmatchedIdentity({ txHash: '0xorphan', token: TOKEN_A, direction: 'inbound', amount: 7 })
  const audit = computeExactStructuralCoverageAudit(classified, 0, [orphan], [])
  assert.equal(audit.unmatchedIdentityJoinFailures, 1)
  assert.equal(audit.genuineUnmatchedBuys, 1, 'a join failure still counts as genuine (blocking) unmatched evidence — never silently excluded')
  assert.equal(audit.structuralCoverageDenominator, 1)
})

test('HARD ASSERTION: a genuinely ambiguous multi-candidate group (same chain/tx/token/direction, no exact amount match) is a join failure, never a guess', () => {
  const legA = event({ txHash: '0xambig', direction: 'inbound', contract: TOKEN_A, amount: 3 })
  const legB = event({ txHash: '0xambig', direction: 'inbound', contract: TOKEN_A, amount: 4 })
  const classified = classifyEvents([legA, legB], noRouters)
  // Neither leg's amount (3 or 4) matches the unmatched identity's amount (5) exactly.
  const ambiguous = unmatchedIdentity({ txHash: '0xambig', token: TOKEN_A, direction: 'inbound', amount: 5 })
  const audit = computeExactStructuralCoverageAudit(classified, 0, [ambiguous], [])
  assert.equal(audit.unmatchedIdentityJoinFailures, 1)
  assert.equal(audit.genuineUnmatchedBuys, 1)
})

test('an unambiguous single-candidate group joins correctly even when the amount differs (partial-fill remainder)', () => {
  const buy = event({ txHash: '0xpartial', direction: 'inbound', contract: TOKEN_A, amount: 10 })
  const classified = classifyEvents([buy], noRouters)
  // The unmatched remainder (3) legitimately differs from the original buy's full amount (10) —
  // single candidate in the group means the join is still unambiguous.
  const remainder = unmatchedIdentity({ txHash: '0xpartial', token: TOKEN_A, direction: 'inbound', amount: 3 })
  const audit = computeExactStructuralCoverageAudit(classified, 0, [remainder], [])
  assert.equal(audit.unmatchedIdentityJoinFailures, 0)
  assert.equal(audit.genuineUnmatchedBuys, 1)
})

test('a multi-candidate group resolves via exact amount match when exactly one candidate matches', () => {
  const legA = event({ txHash: '0xexact', direction: 'inbound', contract: TOKEN_A, amount: 3 })
  const legB = event({ txHash: '0xexact', direction: 'inbound', contract: TOKEN_A, amount: 500 }) // will be reclassified distribution_airdrop below via a matching counterpart elsewhere — kept simple here
  const classified = classifyEvents([legA, legB], noRouters)
  const identity = unmatchedIdentity({ txHash: '0xexact', token: TOKEN_A, direction: 'inbound', amount: 3 })
  const audit = computeExactStructuralCoverageAudit(classified, 0, [identity], [])
  assert.equal(audit.unmatchedIdentityJoinFailures, 0, 'exactly one exact-amount match resolves the ambiguity')
})

// =================================================================================================
// BOUNDED-HISTORY FOLLOW-UP — requirements #1-#4: computeUnmatchedEvidenceAudit.
// =================================================================================================

const NOW_ISO = '2026-08-03T00:00:00.000Z'
const WINDOW_DAYS = 90
const WINDOW_START = Date.parse(NOW_ISO) - WINDOW_DAYS * 24 * 60 * 60 * 1000
const ctx = { windowStartTimestamp: WINDOW_START, scanWindowDays: WINDOW_DAYS }

test('HARD ASSERTION: an unsold valid buy does not block realized PnL — it is disclosed as open_position_inventory, never counted in the blocking denominator', () => {
  const buy = event({ txHash: '0xopen1', direction: 'inbound', contract: TOKEN_A, amount: 5, timestamp: new Date(WINDOW_START + 10 * 24 * 60 * 60 * 1000).toISOString() })
  const classified = classifyEvents([buy], noRouters)
  const identity = unmatchedIdentity({ txHash: '0xopen1', token: TOKEN_A, direction: 'inbound', amount: 5, timestamp: Date.parse(buy.timestamp) })
  const audit = computeUnmatchedEvidenceAudit(classified, 10, [identity], [], ctx)
  assert.equal(audit.openPositionBuys, 1)
  assert.equal(audit.structurallyInvalidOrUnknownBuys, 0, 'an unsold buy must never block realized PnL on already-closed lots')
  assert.equal(audit.structuralCoverageDenominator, 10, 'open position buys are disclosed but excluded from the blocking denominator')
})

test('HARD ASSERTION: a sell whose entry predates the bounded fetch window is excluded as pre_window_inventory_exit, never fabricated cost basis', () => {
  // Wallet history reaches back to (at or before) the window boundary — the earliest fetched event
  // is right at the window start — proving the fetch genuinely reached its configured boundary.
  const earliestHistoryEvent = event({ txHash: '0xearliest', direction: 'inbound', contract: TOKEN_B, amount: 1, timestamp: new Date(WINDOW_START).toISOString() })
  const sell = event({ txHash: '0xsell1', direction: 'outbound', contract: TOKEN_A, amount: 5, timestamp: new Date(WINDOW_START + 5 * 24 * 60 * 60 * 1000).toISOString() })
  const classified = classifyEvents([earliestHistoryEvent, sell], noRouters)
  const identity = unmatchedIdentity({ txHash: '0xsell1', token: TOKEN_A, direction: 'outbound', amount: 5, timestamp: Date.parse(sell.timestamp) })
  const audit = computeUnmatchedEvidenceAudit(classified, 10, [], [identity], ctx)
  assert.equal(audit.preWindowInventoryExits, 1)
  assert.equal(audit.structurallyInvalidOrUnknownSells, 0, 'a pre-window exit must never block realized PnL on already-closed lots')
  assert.equal(audit.structuralCoverageDenominator, 10)
})

test('HARD ASSERTION: a sell with no earlier buy is NOT excluded when the fetch never reached the window boundary — fail-closed, stays unknown/blocking', () => {
  // The wallet's ENTIRE fetched history is recent (well inside the window, not near its edge) — the
  // fetch never proved it reached back to the window boundary, so "no earlier buy" alone cannot be
  // trusted as a bounded-history signal. Must not be excluded.
  const recentHistoryEvent = event({ txHash: '0xrecent', direction: 'inbound', contract: TOKEN_B, amount: 1, timestamp: new Date(Date.parse(NOW_ISO) - 1 * 24 * 60 * 60 * 1000).toISOString() })
  const sell = event({ txHash: '0xsell2', direction: 'outbound', contract: TOKEN_A, amount: 5, timestamp: new Date(Date.parse(NOW_ISO) - 1 * 24 * 60 * 60 * 1000).toISOString() })
  const classified = classifyEvents([recentHistoryEvent, sell], noRouters)
  const identity = unmatchedIdentity({ txHash: '0xsell2', token: TOKEN_A, direction: 'outbound', amount: 5, timestamp: Date.parse(sell.timestamp) })
  const audit = computeUnmatchedEvidenceAudit(classified, 10, [], [identity], ctx)
  assert.equal(audit.preWindowInventoryExits, 0)
  assert.equal(audit.unknownSells, 1)
  assert.equal(audit.structurallyInvalidOrUnknownSells, 1, 'unproven — continues blocking rather than being silently excluded')
})

test('HARD ASSERTION: unknown/unjoinable unmatched evidence still blocks (fail-closed) even under the bounded-history split', () => {
  const classified = classifyEvents([], noRouters)
  const orphanBuy = unmatchedIdentity({ txHash: '0xorphanbuy', token: TOKEN_A, direction: 'inbound', amount: 7, timestamp: WINDOW_START + 1000 })
  const orphanSell = unmatchedIdentity({ txHash: '0xorphansell', token: TOKEN_A, direction: 'outbound', amount: 7, timestamp: WINDOW_START + 1000 })
  const audit = computeUnmatchedEvidenceAudit(classified, 0, [orphanBuy], [orphanSell], ctx)
  assert.equal(audit.unknownBuys, 1)
  assert.equal(audit.unknownSells, 1)
  assert.equal(audit.unmatchedIdentityJoinFailures, 2)
  assert.equal(audit.structurallyInvalidOrUnknownBuys, 1)
  assert.equal(audit.structurallyInvalidOrUnknownSells, 1)
})

test('a sell resolved to a proven non-trade classification is disclosed as transfer_distribution and never blocks', () => {
  const dist1 = event({ txHash: '0xd1', direction: 'outbound', contract: TOKEN_C, amount: 500, timestamp: new Date(WINDOW_START + 20 * 24 * 60 * 60 * 1000).toISOString() })
  const dist2 = event({ txHash: '0xd2', direction: 'outbound', contract: TOKEN_C, amount: 500, timestamp: new Date(WINDOW_START + 21 * 24 * 60 * 60 * 1000).toISOString() })
  const classified = classifyEvents([dist1, dist2], noRouters)
  for (const c of classified) assert.equal(c.classification, 'distribution_airdrop')
  const identities = [dist1, dist2].map((e) => unmatchedIdentity({ txHash: e.txHash, token: TOKEN_C, direction: 'outbound', amount: e.amount, timestamp: Date.parse(e.timestamp) }))
  const audit = computeUnmatchedEvidenceAudit(classified, 0, [], identities, ctx)
  assert.equal(audit.transferDistributionSells.distribution_airdrop, 2)
  assert.equal(audit.structurallyInvalidOrUnknownSells, 0)
})

// =================================================================================================
// WINDOW-BOUNDARY-PROOF AUDIT — window-boundary-proof audit task (Aug 5 production regression:
// preWindowInventoryExits ~110 -> 0, 115 unmatched sells reclassified unknown,
// window_boundary_proven=false, on a wallet whose lot structure was otherwise unchanged).
//
// WHAT THESE PROVE, DISCLOSED: `windowBoundaryProven` is a SINGLE boolean derived from ONE number —
// the earliest event this scan happened to receive — and every `pre_window_inventory_exit` decision
// is gated on it. The tests below prove, deterministically, that (a) losing older events flips that
// boolean and reclassifies the ENTIRE qualifying sell population at once, (b) the flip is a
// one-event cliff, (c) the classification/join pass is byte-for-byte identical across the flip and
// is therefore exonerated, and (d) the rolling window ADVANCING on its own can only ever make the
// boundary EASIER to prove — so wall-clock advance alone cannot explain the regression and event
// loss is the only remaining mechanism. These are diagnosis regressions: they assert today's exact
// behavior, including the failure, and deliberately implement no fix.
// =================================================================================================

const BP_NOW = Date.parse('2026-08-05T00:00:00.000Z')
const BP_DAY = 24 * 60 * 60 * 1000
const BP_WINDOW_DAYS = 90
const BP_WINDOW_START = BP_NOW - BP_WINDOW_DAYS * BP_DAY
const bpCtx = { windowStartTimestamp: BP_WINDOW_START, scanWindowDays: BP_WINDOW_DAYS }
const iso = (ms: number) => new Date(ms).toISOString()

// Production-shaped fixture: 115 unmatched sells total — 110 with NO earlier buy anywhere in the
// fetched history (the population that legitimately qualifies as bounded-history pre-window exits)
// and 5 that genuinely DO have an earlier in-window buy (permanently unknown regardless of the
// boundary flag). `anchorAtWindowStart` is the single oldest event proving the fetch reached the
// window edge — the exact event a bounded single-page provider fetch drops first when a wallet's
// recent activity grows past the page cap.
function boundaryProofFixture() {
  const anchorAtWindowStart = event({
    txHash: '0xbp-anchor', direction: 'inbound', contract: TOKEN_B, amount: 1,
    timestamp: iso(BP_WINDOW_START),
  })
  const noEarlierBuySells = Array.from({ length: 110 }, (_, i) => event({
    txHash: `0xbp-nb-sell-${i}`, direction: 'outbound', contract: `0xnb${i}`, amount: 5,
    timestamp: iso(BP_NOW - 10 * BP_DAY),
  }))
  const earlierBuys = Array.from({ length: 5 }, (_, i) => event({
    txHash: `0xbp-wb-buy-${i}`, direction: 'inbound', contract: `0xwb${i}`, amount: 9,
    timestamp: iso(BP_NOW - 30 * BP_DAY),
  }))
  const withEarlierBuySells = Array.from({ length: 5 }, (_, i) => event({
    txHash: `0xbp-wb-sell-${i}`, direction: 'outbound', contract: `0xwb${i}`, amount: 9,
    timestamp: iso(BP_NOW - 10 * BP_DAY),
  }))
  const sellEvents = [...noEarlierBuySells, ...withEarlierBuySells]
  const sellIdentities = sellEvents.map((e) => unmatchedIdentity({
    txHash: e.txHash, token: e.contract, direction: 'outbound', amount: e.amount, timestamp: Date.parse(e.timestamp),
  }))
  return { anchorAtWindowStart, earlierBuys, sellEvents, sellIdentities }
}

test('HARD ASSERTION (Aug 5 regression, reproduced exactly): losing ONLY the single oldest event flips windowBoundaryProven and reclassifies all 110 pre-window exits to unknown in one step', () => {
  const f = boundaryProofFixture()
  const fullHistory = [f.anchorAtWindowStart, ...f.earlierBuys, ...f.sellEvents]
  // The failed scan differs from the successful one ONLY by the absence of the oldest event — the
  // exact shape of provider page-cap truncation / rolling-window event loss. Every sell identity,
  // every classification input and the configured window are otherwise byte-for-byte identical.
  const truncatedHistory = [...f.earlierBuys, ...f.sellEvents]

  const good = computeUnmatchedEvidenceAudit(classifyEvents(fullHistory, noRouters), 26, [], f.sellIdentities, bpCtx)
  const bad = computeUnmatchedEvidenceAudit(classifyEvents(truncatedHistory, noRouters), 26, [], f.sellIdentities, bpCtx)

  // Successful scan (7877dd6b-shaped): boundary proven, the 110 qualify as bounded-history exits.
  assert.equal(good.windowBoundaryProven, true)
  assert.equal(good.preWindowInventoryExits, 110)
  assert.equal(good.unknownSells, 5, 'only the 5 sells that genuinely have an earlier in-window buy stay unknown')
  assert.equal(good.structurallyInvalidOrUnknownSells, 5)

  // Failed scan (8486c013-shaped): the reported production numbers, exactly.
  assert.equal(bad.windowBoundaryProven, false)
  assert.equal(bad.preWindowInventoryExits, 0, 'the reported collapse: ~110 -> 0')
  assert.equal(bad.unknownSells, 115, 'the reported reclassification: all 115 unmatched sells become unknown')
  assert.equal(bad.structurallyInvalidOrUnknownSells, 115)

  // THE DECISIVE ATTRIBUTION: the entire swing is sells blocked SOLELY because the boundary was not
  // proven — not one additional sell became unknown for any classification/matching reason.
  assert.equal(bad.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 110)
  assert.equal(bad.boundaryProofDiagnostics.sellsWithEarlierBuyInWindow, 5)
  assert.equal(good.boundaryProofDiagnostics.sellsWithEarlierBuyInWindow, 5, 'identical in both scans — this population is boundary-independent')
  assert.equal(good.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 0)
  assert.equal(
    bad.unknownSells - good.unknownSells,
    bad.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary,
    'the whole unknown-sell increase is accounted for by the boundary flag alone',
  )
})

test('HARD ASSERTION: the classification/join pass is byte-for-byte identical across the flip — unmatched-event classification is exonerated as a cause', () => {
  const f = boundaryProofFixture()
  const good = computeUnmatchedEvidenceAudit(classifyEvents([f.anchorAtWindowStart, ...f.earlierBuys, ...f.sellEvents], noRouters), 26, [], f.sellIdentities, bpCtx)
  const bad = computeUnmatchedEvidenceAudit(classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters), 26, [], f.sellIdentities, bpCtx)

  // Every sell resolved its join in BOTH scans, and none resolved to a non-trade classification —
  // so neither a join failure nor a classification change can explain the swing.
  assert.equal(good.unmatchedIdentityJoinFailures, 0)
  assert.equal(bad.unmatchedIdentityJoinFailures, 0)
  assert.deepEqual(bad.transferDistributionSells, good.transferDistributionSells)
  assert.deepEqual(bad.transferDistributionSells, {})
  assert.equal(bad.structurallyInvalidSells, 0)
  assert.equal(good.structurallyInvalidSells, 0)
  // The sell population itself never changed size — only how it was bucketed.
  assert.equal(good.preWindowInventoryExits + good.unknownSells, 115)
  assert.equal(bad.preWindowInventoryExits + bad.unknownSells, 115)
})

test('HARD ASSERTION: the rolling window ADVANCING on its own can never break boundary proof — wall-clock advance alone is eliminated as a cause', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([f.anchorAtWindowStart, ...f.earlierBuys, ...f.sellEvents], noRouters)
  // Same fetched history, scanned progressively later. windowStartTimestamp = scanTime - windowDays
  // moves FORWARD with wall clock, so the boundary threshold the earliest event must precede also
  // moves forward — a later scan can only ever make the proof EASIER, never harder.
  for (const daysLater of [0, 1, 2, 7, 30]) {
    const laterCtx = { windowStartTimestamp: (BP_NOW + daysLater * BP_DAY) - BP_WINDOW_DAYS * BP_DAY, scanWindowDays: BP_WINDOW_DAYS }
    const audit = computeUnmatchedEvidenceAudit(classified, 26, [], f.sellIdentities, laterCtx)
    assert.equal(audit.windowBoundaryProven, true, `boundary must stay proven ${daysLater} days later when no event is lost`)
    assert.equal(audit.preWindowInventoryExits, 110, `pre-window exits must be stable ${daysLater} days later`)
    assert.equal(audit.boundaryProofDiagnostics.boundaryShortfallMs, 0)
  }
})

test('HARD ASSERTION: boundary proof is a one-event cliff — the flip is driven entirely by whichever single event happens to be oldest', () => {
  const f = boundaryProofFixture()
  const tolerance = 3 * BP_DAY
  // An oldest event exactly AT the tolerance edge still proves the boundary; one millisecond newer
  // does not. Nothing else about the scan differs.
  const atEdge = event({ txHash: '0xbp-edge', direction: 'inbound', contract: TOKEN_B, amount: 1, timestamp: iso(BP_WINDOW_START + tolerance) })
  const justPastEdge = event({ txHash: '0xbp-edge', direction: 'inbound', contract: TOKEN_B, amount: 1, timestamp: iso(BP_WINDOW_START + tolerance + 1) })

  const proven = computeUnmatchedEvidenceAudit(classifyEvents([atEdge, ...f.earlierBuys, ...f.sellEvents], noRouters), 26, [], f.sellIdentities, bpCtx)
  const unproven = computeUnmatchedEvidenceAudit(classifyEvents([justPastEdge, ...f.earlierBuys, ...f.sellEvents], noRouters), 26, [], f.sellIdentities, bpCtx)

  assert.equal(proven.windowBoundaryProven, true)
  assert.equal(proven.preWindowInventoryExits, 110)
  assert.equal(proven.boundaryProofDiagnostics.boundaryShortfallMs, 0)

  assert.equal(unproven.windowBoundaryProven, false, 'one millisecond of lost history reclassifies 110 lots')
  assert.equal(unproven.preWindowInventoryExits, 0)
  assert.equal(unproven.boundaryProofDiagnostics.boundaryShortfallMs, 1)
})

test('HARD ASSERTION: boundary diagnostics quantify page-cap truncation distinctly from a genuinely short wallet history', () => {
  const f = boundaryProofFixture()

  // TRUNCATION SHAPE: the wallet really does have 90 days of history, but the fetch only returned
  // its most recent slice — the fetched span is far below the configured window and the shortfall is
  // large. This is what a bounded single-page provider fetch produces for an active wallet.
  const truncated = computeUnmatchedEvidenceAudit(classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters), 26, [], f.sellIdentities, bpCtx)
  const d = truncated.boundaryProofDiagnostics
  assert.equal(d.earliestFetchedEventTimestamp, BP_NOW - 30 * BP_DAY)
  assert.equal(d.latestFetchedEventTimestamp, BP_NOW - 10 * BP_DAY)
  assert.equal(d.fetchedHistorySpanDays, 20, 'only 20 days of history came back for a 90-day window')
  assert.equal(d.configuredWindowDays, 90)
  assert.equal(d.boundaryThresholdTimestamp, BP_WINDOW_START + 3 * BP_DAY)
  assert.equal(d.boundaryShortfallMs, 57 * BP_DAY, 'the fetch fell 57 days short of proving the window boundary')
  assert.ok(d.fetchedHistorySpanDays! < d.configuredWindowDays! / 2, 'span far below the window is the truncation signature')
  assert.equal(d.classifiedEventsConsidered, 120)

  // SHORT-HISTORY SHAPE, for contrast: an equally unproven boundary, but the fetched span is small
  // because the wallet's real history is small — no large shortfall relative to what exists.
  const youngWallet = [
    event({ txHash: '0xbp-young-buy', direction: 'inbound', contract: TOKEN_B, amount: 1, timestamp: iso(BP_NOW - 2 * BP_DAY) }),
    event({ txHash: '0xbp-young-sell', direction: 'outbound', contract: TOKEN_C, amount: 1, timestamp: iso(BP_NOW - 1 * BP_DAY) }),
  ]
  const youngIdentity = unmatchedIdentity({ txHash: '0xbp-young-sell', token: TOKEN_C, direction: 'outbound', amount: 1, timestamp: BP_NOW - 1 * BP_DAY })
  const young = computeUnmatchedEvidenceAudit(classifyEvents(youngWallet, noRouters), 1, [], [youngIdentity], bpCtx)
  assert.equal(young.windowBoundaryProven, false, 'both shapes fail the proof identically — only the diagnostics tell them apart')
  assert.equal(young.boundaryProofDiagnostics.fetchedHistorySpanDays, 1)
  assert.equal(young.boundaryProofDiagnostics.classifiedEventsConsidered, 2)
  assert.ok(
    young.boundaryProofDiagnostics.classifiedEventsConsidered < d.classifiedEventsConsidered,
    'a short history is sparse; a truncated fetch is dense right up to the cap — the discriminator',
  )
})

test('HARD ASSERTION: one provider dropping out reproduces the identical flip when it was the provider supplying the older history', () => {
  const f = boundaryProofFixture()
  // fetchProviderWindow returns providerStatus 'partial' (not 'provider_unavailable') when exactly
  // one provider succeeds, and mergeProviderResults still merges — so a partial fetch silently
  // yields whatever the surviving provider returned, with no signal reaching the boundary proof.
  // Modelled here as the merged event set the pipeline would actually classify.
  const bothProviders = [f.anchorAtWindowStart, ...f.earlierBuys, ...f.sellEvents]
  const onlyRecentProvider = [...f.earlierBuys, ...f.sellEvents]

  const merged = computeUnmatchedEvidenceAudit(classifyEvents(bothProviders, noRouters), 26, [], f.sellIdentities, bpCtx)
  const partial = computeUnmatchedEvidenceAudit(classifyEvents(onlyRecentProvider, noRouters), 26, [], f.sellIdentities, bpCtx)

  assert.equal(merged.windowBoundaryProven, true)
  assert.equal(partial.windowBoundaryProven, false)
  assert.equal(partial.preWindowInventoryExits, 0)
  assert.equal(partial.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 110)
  // Provider merge loss and page-cap truncation are INDISTINGUISHABLE inside this function — both
  // present as "the oldest event is newer than it was". Telling them apart requires the per-provider
  // coverage the pipeline's own [window-boundary-proof-audit] line now logs alongside these fields.
  assert.deepEqual(partial.boundaryProofDiagnostics, computeUnmatchedEvidenceAudit(classifyEvents(onlyRecentProvider, noRouters), 26, [], f.sellIdentities, bpCtx).boundaryProofDiagnostics)
})

test('the boundary diagnostics never alter any existing decision — every pre-existing field is unchanged by their presence', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([f.anchorAtWindowStart, ...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 26, [], f.sellIdentities, bpCtx)
  // The gate's own inputs: numerator is the closed-lot count, denominator adds ONLY blocking
  // evidence, and pre-window exits/open positions stay excluded from it — unchanged by this task.
  assert.equal(audit.structuralCoverageNumerator, 26)
  assert.equal(audit.structuralCoverageDenominator, 26 + 0 + 5)
  assert.equal(audit.structuralCoverage, 26 / 31)
  assert.equal(audit.openPositionBuys, 0)
  assert.equal(audit.structurallyInvalidBuys, 0)
  assert.equal(audit.unknownBuys, 0)
})

// =================================================================================================
// BOUNDARY MODEL FIX — boundary-model follow-up task (production cause confirmed: Base's Alchemy
// fetch hit the 400-event cap while both providers reported ok:true, fetched span was 82.96 days
// against the 90-day window, boundaryReached flipped false purely from the cap, and 110 pre-window
// exits were reclassified unknown, hard-blocking an otherwise-verified 23/24-lot sample).
// =================================================================================================

test('HARD ASSERTION (production reproduction): a page-capped-but-healthy fetch is classified truncated; truncation is disclosed AND stays blocking until per-sell proof', () => {
  const f = boundaryProofFixture()
  // Reproduces the exact production shape: no anchor event (the cap dropped it), every provider
  // otherwise healthy — `anyProviderAtEventCap: true`, `anyProviderFetchFailed: false`.
  const classified = classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, {
    ...bpCtx, anyProviderAtEventCap: true, anyProviderFetchFailed: false,
  })

  assert.equal(audit.historyCoverageStatus, 'truncated')
  assert.equal(audit.boundedSampleWindowSafe, true, 'truncated coverage is still a bounded-sample coverage signal')
  // NO FALSE FULL-WINDOW CLAIM, DISCLOSED: windowBoundaryProven stays false — truncation is never
  // presented as a proven exhaustive fetch.
  assert.equal(audit.windowBoundaryProven, false)

  // Truncation is NOT per-sell proof: the 110 boundary-gated sells stay blocking and must pass
  // through the resolver. They are still disclosed separately so the cause is attributable.
  assert.equal(audit.preWindowInventoryExits, 0, 'never claimed as PROVEN under truncated coverage')
  assert.equal(audit.preWindowInventoryExitsUnprovenDueToTruncation, 110)
  assert.equal(audit.unknownSells, 115, '110 truncation-unproven + 5 earlier-buy sells all stay blocking')
  assert.equal(audit.structurallyInvalidOrUnknownSells, 115)
  assert.equal(audit.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 110)
  assert.equal(audit.structuralCoverageDenominator, 23 + 0 + 115)
  assert.equal(audit.boundaryProofDiagnostics.boundaryRequiredSells.length, 110)
  assert.ok(audit.boundaryProofDiagnostics.boundaryRequiredSells.every((sell) => sell.reason === 'history_truncated_at_provider'))
  assert.equal(audit.boundaryProofDiagnostics.boundaryIndependentSells.length, 5)
  assert.ok(audit.boundaryProofDiagnostics.boundaryIndependentSells.every((sell) => sell.reason === 'earlier_buy_in_window'))
})

test('HARD ASSERTION: a genuine provider failure (partial) still hard-blocks even when a provider also happens to be at its event cap', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, {
    ...bpCtx, anyProviderAtEventCap: true, anyProviderFetchFailed: true,
  })
  assert.equal(audit.historyCoverageStatus, 'partial', 'a genuine fetch failure outranks a mere cap')
  assert.equal(audit.boundedSampleWindowSafe, false, 'fail-closed, unchanged from before this task')
  assert.equal(audit.windowBoundaryProven, false)
  assert.equal(audit.preWindowInventoryExits, 0)
  assert.equal(audit.preWindowInventoryExitsUnprovenDueToTruncation, 0)
  assert.equal(audit.unknownSells, 115, 'the 110 unproven + the 5 contradictory all stay blocking under a genuine provider failure')
})

test('HARD ASSERTION: a token-scoped proven pre-window set under partial coverage is non-blocking and does not flip windowBoundaryProven', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters)
  const proven = new Set(f.sellIdentities.slice(0, 110).map((identity) => `${identity.chain}:${identity.txHash.toLowerCase()}:${identity.token.toLowerCase()}`))
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, {
    ...bpCtx, anyProviderAtEventCap: true, anyProviderFetchFailed: true,
    provenPreWindowInventoryExits: proven,
  })
  assert.equal(audit.historyCoverageStatus, 'partial')
  assert.equal(audit.windowBoundaryProven, false, 'global boundary flag stays honest')
  assert.equal(audit.boundedSampleWindowSafe, false)
  assert.equal(audit.preWindowInventoryExits, 110)
  assert.equal(audit.unknownSells, 5, 'the 5 sells with earlier in-window buys stay independently blocking')
  assert.equal(audit.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 0)
  assert.equal(audit.structuralCoverageDenominator, 23 + 0 + 5)
})

test('a short real wallet history (no cap, no failure, boundary genuinely not reached) still fails closed exactly as before this task', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, {
    ...bpCtx, anyProviderAtEventCap: false, anyProviderFetchFailed: false,
  })
  assert.equal(audit.historyCoverageStatus, 'unknown')
  assert.equal(audit.boundedSampleWindowSafe, false)
  assert.equal(audit.preWindowInventoryExitsUnprovenDueToTruncation, 0)
  assert.equal(audit.unknownSells, 115)
  assert.equal(audit.boundaryProofDiagnostics.boundaryRequiredSells.length, 110)
  assert.equal(audit.boundaryProofDiagnostics.boundaryIndependentSells.length, 5)
})

test('positive provider exhaustion proves the bounded start for a short wallet without claiming a timestamp at the boundary', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, {
    ...bpCtx, anyProviderAtEventCap: false, anyProviderFetchFailed: false, boundedWindowStartProven: true,
  })
  assert.equal(audit.historyCoverageStatus, 'exhaustive')
  assert.equal(audit.windowBoundaryProven, true)
  assert.equal(audit.boundedSampleWindowSafe, true)
  assert.equal(audit.preWindowInventoryExits, 110)
  assert.equal(audit.unknownSells, 5, 'sells with an earlier in-window buy remain independently blocking')
  assert.equal(audit.boundaryProofDiagnostics.sellsBlockedSolelyByUnprovenBoundary, 0)
  assert.equal(audit.boundaryProofDiagnostics.sellsWithEarlierBuyInWindow, 5)
})

test('a genuinely exhaustive fetch (no cap, no failure, boundary reached) is unaffected by this task — byte-for-byte prior behavior', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([f.anchorAtWindowStart, ...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, {
    ...bpCtx, anyProviderAtEventCap: false, anyProviderFetchFailed: false,
  })
  assert.equal(audit.historyCoverageStatus, 'exhaustive')
  assert.equal(audit.boundedSampleWindowSafe, true)
  assert.equal(audit.windowBoundaryProven, true)
  assert.equal(audit.preWindowInventoryExits, 110)
  assert.equal(audit.preWindowInventoryExitsUnprovenDueToTruncation, 0)
  assert.equal(audit.unknownSells, 5)
})

test('an unmigrated caller that never supplies anyProviderAtEventCap/anyProviderFetchFailed gets byte-for-byte the pre-existing behavior', () => {
  const f = boundaryProofFixture()
  const classified = classifyEvents([...f.earlierBuys, ...f.sellEvents], noRouters)
  const audit = computeUnmatchedEvidenceAudit(classified, 23, [], f.sellIdentities, bpCtx)
  assert.equal(audit.historyCoverageStatus, 'unknown', 'defaults to false/false — old boundaryReached=false path, never silently truncated')
  assert.equal(audit.preWindowInventoryExits, 0)
  assert.equal(audit.preWindowInventoryExitsUnprovenDueToTruncation, 0)
  assert.equal(audit.unknownSells, 115)
})

// =================================================================================================
// CRITICAL-TRADE-EVIDENCE-GAP TASK — unmatchedIdentityJoinFailures identity repair.
// Production wallet 0x4dbb3835744b2976560e0259cb218cab89abef96: 2 join failures, 2 unmatched
// sells, 2 invalidOrUnknownUnmatchedEvents. Join previously used raw txHash (checksum vs
// lowercase) and classified canonical events only, so recovered-only unmatched sells
// short-circuited to blocking `unknown` before pre-window / non-trade rules could run.
// =================================================================================================

const LOOKALIKE_USDC_A = '0x4facd9f622b570aaaaaaaaaaaaaaaaaaaaaaaaaa'
const LOOKALIKE_USDC_B = '0xfab2acd0cc915fbbbbbbbbbbbbbbbbbbbbbbbbbb'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CHECKSUM_TX = '0x37C80f5c89E09FdF3644355D39Aa5Bc728Dd9Bbf774300EEc6E5F798139B7E3E'
const LOWER_TX = CHECKSUM_TX.toLowerCase()

test('HARD ASSERTION: checksum vs lowercase txHash of the SAME transaction joins — never a join failure', () => {
  const classifiedEvent = event({
    txHash: LOWER_TX, direction: 'outbound', contract: LOOKALIKE_USDC_A, amount: 5000.000635,
    fromAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96',
    toAddress: '0xaa1c048f5fe6611683bca589c88cd78f1660859b',
    amountRaw: '5000000635',
  })
  const classified = classifyEvents([classifiedEvent], noRouters)
  const identity = unmatchedIdentity({
    txHash: CHECKSUM_TX, token: LOOKALIKE_USDC_A, direction: 'outbound', amount: 5000.000635,
    fromAddress: classifiedEvent.fromAddress, toAddress: classifiedEvent.toAddress, amountRaw: '5000000635',
  })
  const audit = computeExactStructuralCoverageAudit(classified, 104, [], [identity])
  assert.equal(audit.unmatchedIdentityJoinFailures, 0, 'same tx, different casing, must join')
  assert.equal(audit.genuineUnmatchedSells, 1)
})

test('HARD ASSERTION (production shape): a recovered-only unmatched sell is a join failure against canonical-only classified events', () => {
  const canonicalBuy = event({
    txHash: '0xcanonical-aeon-buy', direction: 'inbound', contract: TOKEN_A, amount: 100,
    timestamp: new Date(WINDOW_START + 10 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const recoveredSell = event({
    txHash: '0x52f77bb405d01d078a66cc00a68d31ce103eaf0a1d39a18583bf00a7c2c67c6e',
    direction: 'outbound', contract: BASE_USDC, amount: 2996.415704, amountRaw: '2996415704',
    fromAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96',
    toAddress: '0x1231deb6a074f5f1b87526fff134ee3e198b3d43',
    timestamp: new Date(WINDOW_START - 20 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const canonicalOnly = classifyEvents([canonicalBuy], noRouters)
  const identity = unmatchedIdentity({
    txHash: recoveredSell.txHash, token: BASE_USDC, direction: 'outbound', amount: 2996.415704,
    fromAddress: recoveredSell.fromAddress, toAddress: recoveredSell.toAddress, amountRaw: '2996415704',
    timestamp: Date.parse(recoveredSell.timestamp),
  })
  const before = computeExactStructuralCoverageAudit(canonicalOnly, 104, [], [identity])
  assert.equal(before.unmatchedIdentityJoinFailures, 1)
  const gap = buildCriticalTradeEvidenceGapAudit(canonicalOnly, [], [identity])
  assert.equal(gap.events.length, 1)
  assert.equal(gap.events[0].identityFailure, 'no_classified_counterpart')
  assert.equal(gap.events[0].proposedResolution, 'include_recovered_events_in_join_set')
  assert.equal(gap.sameTwoAsGenuineUnmatchedSells, true)
})

test('HARD ASSERTION: recovered-only unmatched sell joins via auxiliary recovered classification, without merging into canonical classifyEvents', () => {
  const canonicalBuy = event({
    txHash: '0xcanonical-aeon-buy', direction: 'inbound', contract: TOKEN_A, amount: 100,
    timestamp: new Date(WINDOW_START + 10 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const recoveredSell = event({
    txHash: '0x52f77bb405d01d078a66cc00a68d31ce103eaf0a1d39a18583bf00a7c2c67c6e',
    direction: 'outbound', contract: BASE_USDC, amount: 2996.415704, amountRaw: '2996415704',
    fromAddress: '0x4dbb3835744b2976560e0259cb218cab89abef96',
    toAddress: '0x1231deb6a074f5f1b87526fff134ee3e198b3d43',
    timestamp: new Date(WINDOW_START - 20 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const canonicalClassified = classifyEvents([canonicalBuy], noRouters)
  const recoveredClassified = classifyEvents([recoveredSell], noRouters)
  const identity = unmatchedIdentity({
    txHash: recoveredSell.txHash, token: BASE_USDC, direction: 'outbound', amount: 2996.415704,
    fromAddress: recoveredSell.fromAddress, toAddress: recoveredSell.toAddress, amountRaw: '2996415704',
    timestamp: Date.parse(recoveredSell.timestamp),
  })
  const after = computeExactStructuralCoverageAudit(canonicalClassified, 104, [], [identity], recoveredClassified)
  assert.equal(after.unmatchedIdentityJoinFailures, 0, 'recovered event visible to the join via auxiliary lookup')
  assert.equal(buildCriticalTradeEvidenceGapAudit(canonicalClassified, [], [identity], recoveredClassified).events.length, 0)
  const evidence = computeUnmatchedEvidenceAudit(
    canonicalClassified, 104, [], [identity],
    { ...ctx, boundedWindowStartProven: true },
    recoveredClassified,
  )
  assert.equal(evidence.unmatchedIdentityJoinFailures, 0)
  assert.equal(evidence.preWindowInventoryExits, 1, 'joined recovered sell with no earlier canonical buy is pre-window once coverage is proven from canonical signals, not recovered timestamps')
  assert.equal(evidence.structurallyInvalidOrUnknownSells, 0)
  assert.equal(canonicalClassified[0].classification, 'genuine_trade_leg')
})

test('HARD ASSERTION: two recovered-only unmatched sells are THE SAME two genuine unmatched sells when they are the only unmatched sells', () => {
  const recoveredA = event({
    txHash: LOWER_TX, direction: 'outbound', contract: LOOKALIKE_USDC_A, amount: 5000.000635,
    amountRaw: '5000000635', timestamp: new Date(WINDOW_START + 16 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const recoveredB = event({
    txHash: '0x883e27eabeed5d3471af5d9cb736cba077aeb0501e34dca8d59138b5e6fd41f8',
    direction: 'outbound', contract: LOOKALIKE_USDC_B, amount: 5000.000635,
    amountRaw: '5000000635', timestamp: new Date(WINDOW_START + 16 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const identities = [
    unmatchedIdentity({ txHash: recoveredA.txHash, token: LOOKALIKE_USDC_A, direction: 'outbound', amount: 5000.000635, amountRaw: '5000000635', timestamp: Date.parse(recoveredA.timestamp) }),
    unmatchedIdentity({ txHash: recoveredB.txHash, token: LOOKALIKE_USDC_B, direction: 'outbound', amount: 5000.000635, amountRaw: '5000000635', timestamp: Date.parse(recoveredB.timestamp) }),
  ]
  const canonicalOnly = classifyEvents([], noRouters)
  const gap = buildCriticalTradeEvidenceGapAudit(canonicalOnly, [], identities)
  assert.equal(gap.unmatchedIdentityJoinFailures, 2)
  assert.equal(gap.sellJoinFailures, 2)
  assert.equal(gap.buyJoinFailures, 0)
  assert.equal(gap.sameTwoAsGenuineUnmatchedSells, true, 'the two join failures ARE the two unmatched sells')
  assert.deepEqual(gap.events.map((e) => e.txHash).sort(), [recoveredA.txHash, recoveredB.txHash].sort())
})

test('amountRaw disambiguates a multi-candidate same-tx group when the unmatched remainder does not equal either full leg', () => {
  const txHash = '0xmultileg'
  const legA = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 10, amountRaw: '10', fromAddress: '0xwallet', toAddress: '0xpool' })
  const legB = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 3, amountRaw: '3', fromAddress: '0xwallet', toAddress: '0xfee' })
  const classified = classifyEvents([legA, legB], noRouters)
  const remainderOfA = unmatchedIdentity({
    txHash, token: TOKEN_A, direction: 'outbound', amount: 4, amountRaw: '10',
    fromAddress: '0xwallet', toAddress: '0xpool',
  })
  const audit = computeExactStructuralCoverageAudit(classified, 1, [], [remainderOfA])
  assert.equal(audit.unmatchedIdentityJoinFailures, 0, 'amountRaw + counterparty pick the source leg even when remainder != full amount')
})

test('HARD ASSERTION: a genuinely ambiguous multi-candidate group with no unique amountRaw/counterparty still fails closed', () => {
  const txHash = '0xstillambig'
  const legA = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 3, amountRaw: '3', fromAddress: '0xwallet', toAddress: '0xsame' })
  const legB = event({ txHash, direction: 'outbound', contract: TOKEN_A, amount: 4, amountRaw: '4', fromAddress: '0xwallet', toAddress: '0xsame' })
  const classified = classifyEvents([legA, legB], noRouters)
  const ambiguous = unmatchedIdentity({
    txHash, token: TOKEN_A, direction: 'outbound', amount: 5, amountRaw: null,
    fromAddress: '0xwallet', toAddress: '0xsame',
  })
  const audit = computeExactStructuralCoverageAudit(classified, 0, [], [ambiguous])
  assert.equal(audit.unmatchedIdentityJoinFailures, 1)
  assert.equal(buildCriticalTradeEvidenceGapAudit(classified, [], [ambiguous]).events[0].identityFailure, 'ambiguous_multi_candidate')
})

test('a lookalike-USDC singleton that IS in the classified set is a joined unmatched sell, not a join failure', () => {
  const spam = event({
    txHash: LOWER_TX, direction: 'outbound', contract: LOOKALIKE_USDC_A, amount: 5000.000635,
    amountRaw: '5000000635', timestamp: new Date(WINDOW_START + 16 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const classified = classifyEvents([spam], noRouters)
  assert.equal(classified[0].classification, 'genuine_trade_leg', 'one-off outbound is still a single-leg trade until a repeat pattern exists')
  const identity = unmatchedIdentity({
    txHash: spam.txHash, token: LOOKALIKE_USDC_A, direction: 'outbound', amount: 5000.000635,
    amountRaw: '5000000635', timestamp: Date.parse(spam.timestamp),
  })
  const audit = computeExactStructuralCoverageAudit(classified, 104, [], [identity])
  assert.equal(audit.unmatchedIdentityJoinFailures, 0)
  assert.equal(audit.genuineUnmatchedSells, 1)
})

test('HARD ASSERTION (c7b8a8e regression): a recovered duplicate must not change classification of an existing canonical matched-lot event', () => {
  const canonicalBuy = event({
    txHash: '0xaeon-buy', direction: 'inbound', contract: TOKEN_A, amount: 500,
    timestamp: new Date(WINDOW_START + 10 * 24 * 60 * 60 * 1000).toISOString(),
    fromAddress: '0xpool', toAddress: '0xwallet',
  })
  const canonicalSell = event({
    txHash: '0xaeon-sell', direction: 'outbound', contract: TOKEN_A, amount: 500,
    timestamp: new Date(WINDOW_START + 20 * 24 * 60 * 60 * 1000).toISOString(),
    fromAddress: '0xwallet', toAddress: '0xpool',
  })
  // Recovered same-tx opposite-direction copy of the canonical buy — if classified in the SAME
  // universe, same-tx netting reclassifies the already-matched canonical buy as ordinary_transfer.
  const recoveredSameTxOpposite = event({
    txHash: '0xaeon-buy', direction: 'outbound', contract: TOKEN_A, amount: 500,
    timestamp: canonicalBuy.timestamp, fromAddress: '0xwallet', toAddress: '0xrouter',
  })
  const canonicalClassified = classifyEvents([canonicalBuy, canonicalSell], noRouters)
  assert.equal(canonicalClassified.find((c) => c.event === canonicalBuy)!.classification, 'genuine_trade_leg')
  assert.equal(canonicalClassified.find((c) => c.event === canonicalSell)!.classification, 'genuine_trade_leg')

  const mergedWouldReclassify = classifyEvents([canonicalBuy, canonicalSell, recoveredSameTxOpposite], noRouters)
  assert.equal(
    mergedWouldReclassify.find((c) => c.event === canonicalBuy)!.classification,
    'ordinary_transfer',
    'sanity: merged classifyEvents reclassifies the canonical buy via same-tx netting — the 104→81 mechanism',
  )

  const recoveredClassified = classifyEvents([recoveredSameTxOpposite], noRouters)
  const unmatchedSell = unmatchedIdentity({
    txHash: canonicalSell.txHash, token: TOKEN_A, direction: 'outbound', amount: 500,
    timestamp: Date.parse(canonicalSell.timestamp),
  })
  const audit = computeExactStructuralCoverageAudit(canonicalClassified, 108, [], [unmatchedSell], recoveredClassified)
  assert.equal(canonicalClassified.find((c) => c.event === canonicalBuy)!.classification, 'genuine_trade_leg', 'canonical classification is frozen')
  assert.equal(audit.genuineUnmatchedSells, 1, 'canonical sell still joins as genuine_trade_leg')
  assert.equal(audit.unmatchedIdentityJoinFailures, 0)
  assert.equal(audit.excludedUnmatchedByClassification.ordinary_transfer ?? 0, 0)
})

test('HARD ASSERTION: canonical event wins over a recovered copy on the same join key', () => {
  const canonicalSell = event({
    txHash: LOWER_TX, direction: 'outbound', contract: TOKEN_A, amount: 10, amountRaw: '10',
    fromAddress: '0xwallet', toAddress: '0xrouter',
  })
  const recoveredCopy = event({
    txHash: CHECKSUM_TX, direction: 'outbound', contract: TOKEN_A, amount: 10, amountRaw: '10',
    fromAddress: '0xwallet', toAddress: '0xpool',
  })
  const canonicalClassified = classifyEvents([canonicalSell], noRouters)
  const recoveredClassified = classifyEvents([recoveredCopy], noRouters)
  const groups = buildCanonicalWinningJoinGroups(canonicalClassified, recoveredClassified)
  const key = [...groups.keys()][0]
  assert.equal(groups.get(key)!.length, 1, 'recovered copy is not added alongside the canonical event')
  assert.equal(groups.get(key)![0].event.toAddress, '0xrouter', 'canonical counterparty wins')
  const identity = unmatchedIdentity({
    txHash: CHECKSUM_TX, token: TOKEN_A, direction: 'outbound', amount: 10, amountRaw: '10',
    fromAddress: '0xwallet', toAddress: '0xpool',
  })
  const audit = computeExactStructuralCoverageAudit(canonicalClassified, 1, [], [identity], recoveredClassified)
  assert.equal(audit.unmatchedIdentityJoinFailures, 0)
  assert.equal(audit.genuineUnmatchedSells, 1)
})
