// TESTS — evidence-first PnL completion task, requirements #1-#6, #10.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NormalizedEvent } from '../normalization/types'
import { classifyEvents, filterToFifoEligible, countByClassification, isFifoEligible, DUST_AMOUNT_THRESHOLD, auditDistributionDirection, computeStructuralCoverageAudit } from './index'

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
