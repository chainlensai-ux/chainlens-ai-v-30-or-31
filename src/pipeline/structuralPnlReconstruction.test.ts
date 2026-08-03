// TESTS — evidence-first PnL completion task, requirements #6, #8, #9: safeRunFifoEngine now
// filters normalizedEvents through eventClassification before handing them to fifoEngine, and
// (when computeReconstructionAudit is set) logs a [structural-pnl-reconstruction-audit] comparing
// the unfiltered ("before") and filtered ("after") result.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeRunFifoEngine } from './index'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { RecoveryPolicyResult } from '../modules/recoveryPolicy/types'
import type { BuyTimeline, SellTimeline } from '../modules/timelineBuilder/types'

const emptyRecoveryPolicy: RecoveryPolicyResult = {
  triggerRecoveryWhen: {} as never,
  caps: {} as never,
  evaluation: [],
  totalPagesUsedThisWallet: 0,
}
const emptyBuyTimeline = { totalBuys: 0, chainContext: {}, entries: [] } as unknown as BuyTimeline
const emptySellTimeline = { totalSells: 0, chainContext: {}, entries: [] } as unknown as SellTimeline

let seq = 0
function evt(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1
  return {
    provider: 'goldrush',
    chain: 'base',
    txHash: `0xtx${seq}`,
    timestamp: String(1_700_000_000 + seq),
    fromAddress: '',
    toAddress: '',
    contract: '0xtokena',
    symbol: 'TOK',
    amount: 1,
    amountRaw: '1000000000000000000',
    tokenDecimals: 18,
    direction: 'inbound',
    ...overrides,
  }
}

const originalConsoleWarn = console.warn
function captureWarnings(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = []
  console.warn = (...args: unknown[]) => { calls.push(args) }
  return { calls, restore: () => { console.warn = originalConsoleWarn } }
}

test('HARD ASSERTION: a repeated-500-token distribution is removed from FIFO input — never opens a matched lot', () => {
  const drop1 = evt({ txHash: '0xdrop1', direction: 'inbound', contract: '0xdistributed', amount: 500 })
  const drop2 = evt({ txHash: '0xdrop2', direction: 'inbound', contract: '0xdistributed', amount: 500 })
  const genuineBuy = evt({ txHash: '0xbuy1', direction: 'inbound', contract: '0xtokena', amount: 5 })
  const genuineSell = evt({ txHash: '0xsell1', direction: 'outbound', contract: '0xtokena', amount: 5 })

  const result = safeRunFifoEngine({
    normalizedEvents: [drop1, drop2, genuineBuy, genuineSell],
    recoveryPolicy: emptyRecoveryPolicy,
    walletAddress: '0xwallet',
    buyTimeline: emptyBuyTimeline,
    sellTimeline: emptySellTimeline,
  })

  // No matched lot or unmatched buy should reference the distributed token — it never reached FIFO.
  assert.equal(result.matchedLots.some((l) => l.token === '0xdistributed'), false)
})

test('HARD ASSERTION: a lone single-leg buy/sell is never regressed out of FIFO — it still opens/closes a lot', () => {
  const buy = evt({ txHash: '0xbuy2', direction: 'inbound', contract: '0xtokenb', amount: 10, timestamp: '1700000000' })
  const sell = evt({ txHash: '0xsell2', direction: 'outbound', contract: '0xtokenb', amount: 10, timestamp: '1700000100' })

  const result = safeRunFifoEngine({
    normalizedEvents: [buy, sell],
    recoveryPolicy: emptyRecoveryPolicy,
    walletAddress: '0xwallet',
    buyTimeline: emptyBuyTimeline,
    sellTimeline: emptySellTimeline,
  })

  assert.equal(result.matchedLots.length, 1)
  assert.equal(result.matchedLots[0].token, '0xtokenb')
  assert.equal(result.unmatchedBuys, 0)
  assert.equal(result.unmatchedSells, 0)
})

test('HARD ASSERTION: computeReconstructionAudit logs [structural-pnl-reconstruction-audit] with real eventsByClassification/before/after counts', () => {
  const { calls, restore } = captureWarnings()
  try {
    const drop1 = evt({ txHash: '0xdrop1', direction: 'inbound', contract: '0xdistributed', amount: 500 })
    const drop2 = evt({ txHash: '0xdrop2', direction: 'inbound', contract: '0xdistributed', amount: 500 })
    const buy = evt({ txHash: '0xbuy3', direction: 'inbound', contract: '0xtokenb', amount: 10 })
    const sell = evt({ txHash: '0xsell3', direction: 'outbound', contract: '0xtokenb', amount: 10 })

    safeRunFifoEngine({
      normalizedEvents: [drop1, drop2, buy, sell],
      recoveryPolicy: emptyRecoveryPolicy,
      walletAddress: '0xwallet',
      buyTimeline: emptyBuyTimeline,
      sellTimeline: emptySellTimeline,
      computeReconstructionAudit: true,
    })
    restore()

    const auditCall = calls.find((c) => c[0] === '[structural-pnl-reconstruction-audit]')
    assert.ok(auditCall, 'must log the required audit diagnostic')
    const payload = auditCall![1] as Record<string, unknown>
    assert.equal((payload.eventsByClassification as Record<string, number>).distribution_airdrop, 2)
    assert.equal((payload.eventsByClassification as Record<string, number>).genuine_trade_leg, 2)
    assert.equal(payload.nonTradesRemovedFromFifo, 2)
    assert.equal(typeof payload.closedLotsBefore, 'number')
    assert.equal(typeof payload.closedLotsAfter, 'number')
    assert.equal(typeof payload.genuineUnmatchedTradeLegsBefore, 'number')
    assert.equal(typeof payload.genuineUnmatchedTradeLegsAfter, 'number')
    assert.equal(payload.lotsUnlockedByMultihop, 0)
  } finally {
    restore()
  }
})

test('computeReconstructionAudit is opt-in — omitting it logs no audit entry and still returns the filtered (canonical) result', () => {
  const { calls, restore } = captureWarnings()
  try {
    const buy = evt({ txHash: '0xbuy4', direction: 'inbound', contract: '0xtokenb', amount: 10 })
    const sell = evt({ txHash: '0xsell4', direction: 'outbound', contract: '0xtokenb', amount: 10 })
    safeRunFifoEngine({
      normalizedEvents: [buy, sell],
      recoveryPolicy: emptyRecoveryPolicy,
      walletAddress: '0xwallet',
      buyTimeline: emptyBuyTimeline,
      sellTimeline: emptySellTimeline,
    })
    restore()
    assert.equal(calls.find((c) => c[0] === '[structural-pnl-reconstruction-audit]'), undefined)
  } finally {
    restore()
  }
})

// =================================================================================================
// PRODUCTION-EVIDENCE FOLLOW-UP — lot identity audit (requirement #1) and the "provably
// non-economic" safety guard (requirement #4) that fixes the exact class of one-lot regression the
// production report described (closed lots 27 -> 26).
// =================================================================================================

test('HARD ASSERTION: [lot-identity-audit] traces a removed lot to its excluded buy-side source event and the exact classification/reason', () => {
  const { calls, restore } = captureWarnings()
  try {
    // A pure pass-through hop (received then immediately forwarded, same tx, nets to zero) —
    // fifoEngine's OLD (unfiltered) behavior treats the inbound leg as a "buy" and the outbound leg
    // as a "sell" and matches them into a lot; the "after" (classification-filtered) result
    // correctly excludes both as a same-token wash (ordinary_transfer — not a known router
    // address in this test, so it lands in the non-router non-economic bucket), so that lot
    // disappears.
    const txHash = '0xhoptx'
    const hopIn = evt({ txHash, direction: 'inbound', contract: '0xhoptoken', amount: 5 })
    const hopOut = evt({ txHash, direction: 'outbound', contract: '0xhoptoken', amount: 5 })

    safeRunFifoEngine({
      normalizedEvents: [hopIn, hopOut],
      recoveryPolicy: emptyRecoveryPolicy,
      walletAddress: '0xwallet',
      buyTimeline: emptyBuyTimeline,
      sellTimeline: emptySellTimeline,
      computeReconstructionAudit: true,
    })
    restore()

    const auditCall = calls.find((c) => c[0] === '[lot-identity-audit]')
    assert.ok(auditCall, 'must log the required lot-identity-audit diagnostic')
    const payload = auditCall![1] as { lotsRemoved: Array<Record<string, unknown>>; lotsAdded: unknown[] }
    const removed = payload.lotsRemoved.find((l) => l.token === '0xhoptoken')
    assert.ok(removed, 'the pass-through-hop lot present in the unfiltered baseline must be traced as removed')
    assert.equal(removed!.buyClassification, 'ordinary_transfer')
    assert.match(removed!.exclusionReason as string, /ordinary_transfer.*removed from FIFO/)
  } finally {
    restore()
  }
})

test('HARD ASSERTION: structural-pnl-reconstruction-audit reports restoredLots/exactSwapsRecovered/contradictoryLegsBefore-After fields', () => {
  const { calls, restore } = captureWarnings()
  try {
    const buy = evt({ txHash: '0xbuy6', direction: 'inbound', contract: '0xtokenc', amount: 10 })
    const sell = evt({ txHash: '0xsell6', direction: 'outbound', contract: '0xtokenc', amount: 10 })
    safeRunFifoEngine({
      normalizedEvents: [buy, sell],
      recoveryPolicy: emptyRecoveryPolicy,
      walletAddress: '0xwallet',
      buyTimeline: emptyBuyTimeline,
      sellTimeline: emptySellTimeline,
      computeReconstructionAudit: true,
      receiptPromotionCounts: { exactSwapsRecovered: 3, contradictoryLegsAfter: null },
    })
    restore()
    const payload = calls.find((c) => c[0] === '[structural-pnl-reconstruction-audit]')![1] as Record<string, unknown>
    assert.equal(typeof payload.restoredLots, 'number')
    assert.equal(payload.exactSwapsRecovered, 3)
    assert.equal(payload.contradictoryLegsBefore, null)
    assert.equal(payload.contradictoryLegsAfter, null)
  } finally {
    restore()
  }
})

test('HARD ASSERTION (requirement #4 safety guard): a same-token pair with COMPARABLE (not clearly minor) opposing amounts stays fully trade-eligible — never guessed as non-economic', () => {
  // 10 in / 8 out for the same token in one tx: the 8 is NOT clearly a minor remainder relative to
  // the 10 (ratio 0.8, above the 0.5 "provably minor" threshold) — this classifier must not guess
  // which side is real; both stay genuine_trade_leg, preserving whatever lots depend on them.
  const txHash = '0xcomparable1'
  const inLeg = evt({ txHash, direction: 'inbound', contract: '0xtokend', amount: 10 })
  const outLeg = evt({ txHash, direction: 'outbound', contract: '0xtokend', amount: 8 })
  const sell = evt({ txHash: '0xsell7', direction: 'outbound', contract: '0xtokend', amount: 2 })

  const result = safeRunFifoEngine({
    normalizedEvents: [inLeg, outLeg, sell],
    recoveryPolicy: emptyRecoveryPolicy,
    walletAddress: '0xwallet',
    buyTimeline: emptyBuyTimeline,
    sellTimeline: emptySellTimeline,
  })
  // Both the 10 (buy) and 8 (sell) stayed in FIFO alongside the later 2 sell — total sold = 10,
  // fully matched against the one 10-unit buy, zero unmatched.
  assert.equal(result.unmatchedBuys, 0)
  assert.equal(result.unmatchedSells, 0)
})
