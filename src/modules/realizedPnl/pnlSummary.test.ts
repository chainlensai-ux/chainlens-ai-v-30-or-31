// Tests for src/modules/realizedPnl/pnlSummary.ts. Uses node:test, same convention as the other
// module test files this session. NOT wired into npm test. Run directly with:
//   npx tsx --test src/modules/realizedPnl/pnlSummary.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeRealizedPnl } from './index'
import type { ClosedLot } from '../lotCloser'

function closedLot(overrides: Partial<ClosedLot>): ClosedLot {
  return {
    lotId: 'lot_1',
    wallet: '0xwallet',
    token: { address: '0xdegen', symbol: 'DEGEN', decimals: 18 },
    amountClosed: 100,
    costBasis: 100,
    proceeds: 150,
    realizedPnl: 50,
    openedAt: 1000,
    closedAt: 2000,
    openTx: '0xbuy',
    closeTx: '0xsell',
    meta: { hops: 1, reconstructedFromTransfers: true },
    pnlCurrency: 'USD',
    pnlCurrencyMismatch: false,
    ...overrides,
  }
}

describe('computeRealizedPnl — all wins', () => {
  it('winRate=100, avgLoss=0, totals sum all lots', () => {
    const lots = [
      closedLot({ lotId: 'l1', realizedPnl: 50, costBasis: 100, proceeds: 150 }),
      closedLot({ lotId: 'l2', realizedPnl: 30, costBasis: 100, proceeds: 130 }),
      closedLot({ lotId: 'l3', realizedPnl: 20, costBasis: 100, proceeds: 120 }),
    ]
    const summary = computeRealizedPnl(lots)
    assert.equal(summary.winRate, 100)
    assert.equal(summary.avgLoss, 0)
    assert.equal(summary.avgWin, (50 + 30 + 20) / 3)
    assert.equal(summary.totalRealizedPnl, 100)
    assert.equal(summary.totalCostBasis, 300)
    assert.equal(summary.totalProceeds, 400)
  })
})

describe('computeRealizedPnl — mixed wins/losses', () => {
  it('computes winRate, avgWin, avgLoss correctly', () => {
    const lots = [
      closedLot({ lotId: 'l1', realizedPnl: 50, costBasis: 100, proceeds: 150 }),
      closedLot({ lotId: 'l2', realizedPnl: 30, costBasis: 100, proceeds: 130 }),
      closedLot({ lotId: 'l3', realizedPnl: -20, costBasis: 100, proceeds: 80 }),
    ]
    const summary = computeRealizedPnl(lots)
    assert.ok(Math.abs(summary.winRate - (200 / 3)) < 0.001)
    assert.equal(summary.avgWin, 40)
    assert.equal(summary.avgLoss, -20)
  })
})

describe('computeRealizedPnl — currency mismatch', () => {
  it('excludes mismatched lots from totals but keeps them in currencyMismatchLots; winRate counts all', () => {
    const lots = [
      closedLot({ lotId: 'l1', realizedPnl: 50, costBasis: 100, proceeds: 150, pnlCurrency: 'USD', pnlCurrencyMismatch: false }),
      closedLot({ lotId: 'l2', realizedPnl: 30, costBasis: 100, proceeds: 130, pnlCurrency: 'USD', pnlCurrencyMismatch: false }),
      closedLot({ lotId: 'l3', realizedPnl: 999, costBasis: 1, proceeds: 1000, pnlCurrency: 'WETH/USD (mismatched — not a reliable PnL figure)', pnlCurrencyMismatch: true }),
    ]
    const summary = computeRealizedPnl(lots)
    assert.equal(summary.currency, 'USD')
    assert.equal(summary.currencyMismatchLots.length, 1)
    assert.equal(summary.currencyMismatchLots[0].lotId, 'l3')
    assert.equal(summary.totalRealizedPnl, 80) // only the 2 clean USD lots
    assert.equal(summary.winRate, 100) // all 3 lots have realizedPnl > 0, regardless of currency
  })

  it('surfaces internally-consistent but non-dominant-currency lots separately', () => {
    const lots = [
      closedLot({ lotId: 'l1', pnlCurrency: 'USD', pnlCurrencyMismatch: false }),
      closedLot({ lotId: 'l2', pnlCurrency: 'USD', pnlCurrencyMismatch: false }),
      closedLot({ lotId: 'l3', pnlCurrency: 'WETH', pnlCurrencyMismatch: false }),
    ]
    const summary = computeRealizedPnl(lots)
    assert.equal(summary.currency, 'USD')
    assert.equal(summary.nonDominantCurrencyLots.length, 1)
    assert.equal(summary.nonDominantCurrencyLots[0].lotId, 'l3')
    assert.equal(summary.currencyMismatchLots.length, 0)
  })
})

describe('computeRealizedPnl — long vs short holding time', () => {
  it('computes real average and median holding times', () => {
    const dayMs = 24 * 60 * 60 * 1000
    const lots = [
      closedLot({ lotId: 'l1', openedAt: 0, closedAt: 30 * dayMs }), // 30 days
      closedLot({ lotId: 'l2', openedAt: 0, closedAt: 60 * 60 * 1000 }), // 1 hour
    ]
    const summary = computeRealizedPnl(lots)
    assert.equal(summary.holdingTimeAvg, (30 * dayMs + 60 * 60 * 1000) / 2)
    assert.equal(summary.holdingTimeMedian, (30 * dayMs + 60 * 60 * 1000) / 2) // 2 values -> mean of both
  })

  it('median with an odd count picks the true middle value', () => {
    const lots = [
      closedLot({ lotId: 'l1', openedAt: 0, closedAt: 100 }),
      closedLot({ lotId: 'l2', openedAt: 0, closedAt: 200 }),
      closedLot({ lotId: 'l3', openedAt: 0, closedAt: 300 }),
    ]
    const summary = computeRealizedPnl(lots)
    assert.equal(summary.holdingTimeMedian, 200)
  })
})

describe('computeRealizedPnl — multi-token breakdown', () => {
  it('produces independent, correctly-summed per-token entries', () => {
    const degen = { address: '0xdegen', symbol: 'DEGEN', decimals: 18 }
    const brett = { address: '0xbrett', symbol: 'BRETT', decimals: 18 }
    const lots = [
      closedLot({ lotId: 'l1', token: degen, realizedPnl: 50, costBasis: 100, proceeds: 150 }),
      closedLot({ lotId: 'l2', token: degen, realizedPnl: 30, costBasis: 100, proceeds: 130 }),
      closedLot({ lotId: 'l3', token: brett, realizedPnl: -10, costBasis: 50, proceeds: 40 }),
    ]
    const summary = computeRealizedPnl(lots)
    assert.equal(Object.keys(summary.byToken).length, 2)
    const degenEntry = summary.byToken['0xdegen']
    const brettEntry = summary.byToken['0xbrett']
    assert.equal(degenEntry.count, 2)
    assert.equal(degenEntry.realizedPnl, 80)
    assert.equal(degenEntry.currency, 'USD')
    assert.equal(brettEntry.count, 1)
    assert.equal(brettEntry.realizedPnl, -10)
    // Wallet-wide totals equal the sum across tokens when everything shares one currency.
    assert.equal(summary.totalRealizedPnl, degenEntry.realizedPnl + brettEntry.realizedPnl)
  })
})

describe('computeRealizedPnl — edge cases', () => {
  it('returns a safe zeroed summary for empty input, never throws', () => {
    const summary = computeRealizedPnl([])
    assert.equal(summary.totalRealizedPnl, 0)
    assert.equal(summary.winRate, 0)
    assert.equal(summary.currency, 'NONE')
    assert.deepEqual(summary.currencyMismatchLots, [])
    assert.deepEqual(summary.byToken, {})
  })

  it('realizedRoi is 0 (never NaN/Infinity) when total cost basis is 0', () => {
    const lots = [closedLot({ costBasis: 0, proceeds: 100, realizedPnl: 100 })]
    const summary = computeRealizedPnl(lots)
    assert.equal(summary.realizedRoi, 0)
  })

  it('is pure — same input produces the same output on repeated calls', () => {
    const lots = [closedLot({})]
    assert.deepEqual(computeRealizedPnl(lots), computeRealizedPnl(lots))
  })
})
