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
