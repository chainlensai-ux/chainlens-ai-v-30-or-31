// Direct test for PnlStatusCard.tsx's selectVerifiedPnlData adapter. Uses node:test, same
// convention as the other module test files this session. NOT wired into `npm test` (which runs a
// single hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/frontend/components/PnlStatusCard.selectPnlData.test.ts
//
// REWRITTEN, DISCLOSED: this file previously tested selectPnlData()'s 3-way priority fallback
// (pnlV2 > fifoAndPnl > pnlSummaryV2) — that function no longer exists. PnlStatusCard now reads
// ONLY pnlV2 (the single verified source), so these tests cover selectVerifiedPnlData() instead:
// real numbers when pnlV2 is present, honest all-null when it is not, and a real ROI computed from
// pnlV2's own costBasis array (never fifoAndPnl.costBasisUsd, which no longer reaches this component).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectVerifiedPnlData } from './PnlStatusCard'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'

function pnlV2(overrides: Partial<PnlV2>): PnlV2 {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], ...overrides }
}

describe('selectVerifiedPnlData', () => {
  it('reads real realized/unrealized/total numbers directly from pnlV2', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: -40 }))
    assert.equal(result.realizedPnlUsd, 100)
    assert.equal(result.unrealizedPnlUsd, -40)
    assert.equal(result.totalPnlUsd, 60)
  })

  it('computes a real ROI from the sum of costBasis[].totalCostUsd, never from an external source', () => {
    const result = selectVerifiedPnlData(pnlV2({
      realizedPnlUsd: 50,
      costBasis: [
        { tokenAddress: '0xa', chainId: 8453, totalQuantity: 10, totalCostUsd: 100, averageCostUsd: 10 },
        { tokenAddress: '0xb', chainId: 8453, totalQuantity: 5, totalCostUsd: 100, averageCostUsd: 20 },
      ],
    }))
    assert.equal(result.totalCostBasisUsd, 200)
    assert.equal(result.roi.value, 25) // 50 / 200 * 100
    assert.equal(result.roi.display, '+25.0%')
  })

  it('a zero total cost basis produces a null ROI, never a divide-by-zero or fabricated value', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 50, costBasis: [] }))
    assert.equal(result.totalCostBasisUsd, 0)
    assert.equal(result.roi.value, null)
    assert.equal(result.roi.display, 'No cost-basis evidence')
  })

  it('no pnlV2 at all degrades honestly to all-null — never falls back to any other source', () => {
    const result = selectVerifiedPnlData(null)
    assert.equal(result.realizedPnlUsd, null)
    assert.equal(result.unrealizedPnlUsd, null)
    assert.equal(result.totalPnlUsd, null)
    assert.equal(result.totalCostBasisUsd, null)
    assert.equal(result.roi.value, null)
  })

  it('never averages or merges — a negative realized + positive unrealized sums exactly, no smoothing', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: -30, unrealizedPnlUsd: 90 }))
    assert.equal(result.realizedPnlUsd, -30)
    assert.equal(result.unrealizedPnlUsd, 90)
    assert.equal(result.totalPnlUsd, 60)
  })
})
