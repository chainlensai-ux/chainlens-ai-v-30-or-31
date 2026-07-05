// Direct test for PnlStatusCard.tsx's selectPnlData adapter. Uses node:test, same convention as
// the other module test files this session. NOT wired into `npm test` (which runs a single
// hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/frontend/components/PnlStatusCard.selectPnlData.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectPnlData } from './PnlStatusCard'
import type { FifoOutput } from '@/src/modules/fifoEngine/types'
import type { PnlSummaryResult } from '@/src/modules/pnlEngine/types'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'

function fifo(overrides: Partial<FifoOutput>): FifoOutput {
  return {
    matchedLots: [], unmatchedBuys: 0, unmatchedSells: 0,
    realizedPnlUsd: null, unrealizedPnlUsd: null, costBasisUsd: null,
    publicPnlStatus: 'ok', integrityFlags: { hardInvalid: false, estimateOnlyLotsExcluded: 0, syntheticLotsExcluded: 0 },
    ...overrides,
  } as FifoOutput
}
function summary(overrides: Partial<PnlSummaryResult>): PnlSummaryResult {
  return {
    realizedPnlUsd: null, closedLots: [], winLossRate: { wins: 0, losses: 0 } as any,
    chainBreakdown: [], confidenceBasis: 'estimated' as any, evidenceMissingCount: 0,
    ...overrides,
  } as PnlSummaryResult
}
function pnlV2(overrides: Partial<PnlV2>): PnlV2 {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], ...overrides }
}

describe('selectPnlData', () => {
  it('V1 (fifoAndPnl) and V2 (pnlV2) produce identical rendered numbers for equivalent data', () => {
    const v1 = selectPnlData({ fifoAndPnl: fifo({ realizedPnlUsd: 100, unrealizedPnlUsd: -40 }) })
    const v2 = selectPnlData({ pnlV2: pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: -40 }) })

    assert.equal(v1.realizedUsd, 100)
    assert.equal(v1.unrealizedUsd, -40)
    assert.equal(v1.totalUsd, 60)
    assert.equal(v2.realizedUsd, v1.realizedUsd)
    assert.equal(v2.unrealizedUsd, v1.unrealizedUsd)
    assert.equal(v2.totalUsd, v1.totalUsd)
  })

  it('usingV2 flips correctly: true when pnlV2 present, false otherwise', () => {
    assert.equal(selectPnlData({ pnlV2: pnlV2({}) }).usingV2, true)
    assert.equal(selectPnlData({ fifoAndPnl: fifo({}) }).usingV2, false)
    assert.equal(selectPnlData({ pnlSummaryV2: summary({}) }).usingV2, false)
    assert.equal(selectPnlData({}).usingV2, false)
  })

  it('pnlV2 takes priority over fifoAndPnl when both are present', () => {
    const result = selectPnlData({
      pnlV2: pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: -40 }),
      fifoAndPnl: fifo({ realizedPnlUsd: 999, unrealizedPnlUsd: 999 }),
    })
    assert.equal(result.realizedUsd, 100)
    assert.equal(result.unrealizedUsd, -40)
    assert.equal(result.usingV2, true)
  })

  it('no data at all degrades gracefully to all-null, usingV2 false', () => {
    const result = selectPnlData({})
    assert.equal(result.realizedUsd, null)
    assert.equal(result.unrealizedUsd, null)
    assert.equal(result.totalUsd, null)
    assert.equal(result.usingV2, false)
  })

  it('pnlSummaryV2-only fallback: real shape has no unrealized/total field — honestly null, not fabricated', () => {
    const result = selectPnlData({ pnlSummaryV2: summary({ realizedPnlUsd: 55 }) })
    assert.equal(result.realizedUsd, 55)
    assert.equal(result.unrealizedUsd, null)
    assert.equal(result.totalUsd, null)
  })

  it('fifoAndPnl with a null realized/unrealized value produces a null total, never a fabricated partial sum', () => {
    const result = selectPnlData({ fifoAndPnl: fifo({ realizedPnlUsd: 100, unrealizedPnlUsd: null }) })
    assert.equal(result.realizedUsd, 100)
    assert.equal(result.unrealizedUsd, null)
    assert.equal(result.totalUsd, null)
  })
})
