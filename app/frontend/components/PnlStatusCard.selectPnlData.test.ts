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
import { selectVerifiedPnlData, shouldShowLimitedSampleBadge, GUARDRAIL_ABS_LIMIT, isStablePnl, PNL_UNAVAILABLE_MESSAGE, shouldShowSyntheticPnl, resolvePnlDisplayMode } from './PnlStatusCard'
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

describe('selectVerifiedPnlData — display-only guardrail (unreliable magnitude clamp)', () => {
  it('flags unreliable when unrealizedPnlUsd is absurdly large, but leaves the raw pnlV2 numbers untouched', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 10, unrealizedPnlUsd: 5e12 }))
    assert.equal(result.unreliable, true)
    // The underlying number is still returned honestly — only the component's rendering clamps it.
    assert.equal(result.unrealizedPnlUsd, 5e12)
  })

  it('flags unreliable when total cost basis is absurdly large', () => {
    const result = selectVerifiedPnlData(pnlV2({
      costBasis: [{ tokenAddress: '0xa', chainId: 8453, totalQuantity: 1, totalCostUsd: 2e9, averageCostUsd: 2e9 }],
    }))
    assert.equal(result.unreliable, true)
  })

  it('a normal, realistic wallet is never flagged unreliable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500, unrealizedPnlUsd: -120 }))
    assert.equal(result.unreliable, false)
  })

  it('an extreme 1e30 unrealizedPnlUsd is flagged unreliable (the task\'s own example magnitude)', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0, unrealizedPnlUsd: 1e30 }))
    assert.equal(result.unreliable, true)
    assert.equal(result.unrealizedPnlUsd, 1e30) // raw pnlV2 value still returned untouched
  })

  it('exactly at GUARDRAIL_ABS_LIMIT (1e9) is NOT flagged — the clamp is a strict "exceeds" check', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0, unrealizedPnlUsd: GUARDRAIL_ABS_LIMIT }))
    assert.equal(result.unreliable, false)
  })

  it('just above GUARDRAIL_ABS_LIMIT (1e9 + 1) is flagged unreliable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0, unrealizedPnlUsd: GUARDRAIL_ABS_LIMIT + 1 }))
    assert.equal(result.unreliable, true)
  })

  it('just below GUARDRAIL_ABS_LIMIT is not flagged', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0, unrealizedPnlUsd: GUARDRAIL_ABS_LIMIT - 1 }))
    assert.equal(result.unreliable, false)
  })

  it('flags unreliable from a per-chain breakdown value alone, even if aggregate totals look sane', () => {
    const result = selectVerifiedPnlData(pnlV2({
      realizedPnlUsd: 10,
      unrealizedPnlUsd: 10,
      chainBreakdown: [{ chainId: 8453, realizedPnlUsd: 1e15, unrealizedPnlUsd: 0 }],
    }))
    assert.equal(result.unreliable, true)
  })
})

describe('shouldShowLimitedSampleBadge — real backend publicPnlStatus classification', () => {
  it("publicPnlStatus 'ok' -> no badge", () => {
    assert.equal(shouldShowLimitedSampleBadge('ok'), null)
  })

  it("publicPnlStatus 'limited_verified_sample' -> 'Limited verified sample' badge", () => {
    assert.equal(shouldShowLimitedSampleBadge('limited_verified_sample'), 'Limited verified sample')
  })

  it("publicPnlStatus 'unavailable' -> distinct 'Not verified' badge (not the same string as limited_verified_sample)", () => {
    assert.equal(shouldShowLimitedSampleBadge('unavailable'), 'Not verified')
  })

  it('publicPnlStatus omitted -> no badge (never a fabricated default)', () => {
    assert.equal(shouldShowLimitedSampleBadge(null), null)
    assert.equal(shouldShowLimitedSampleBadge(undefined), null)
  })
})

describe('isStablePnl — this task\'s stable-PnL display guard', () => {
  it('evidenceMissingCount > 0 -> unstable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 100, unrealizedPnlUsd: 50, evidenceMissingCount: 1 }), false)
  })

  it('evidenceMissingCount omitted -> defaults to 0 (does not fail by itself)', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), true)
  })

  it('realizedPnlUsd is NaN -> unstable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: NaN, unrealizedPnlUsd: 50 }), false)
  })

  it('realizedPnlUsd is Infinity -> unstable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: Infinity, unrealizedPnlUsd: 50 }), false)
  })

  it('realizedPnlUsd is -Infinity -> unstable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: -Infinity, unrealizedPnlUsd: 50 }), false)
  })

  it('realizedPnlUsd is null -> unstable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: null, unrealizedPnlUsd: 50 }), false)
  })

  it('realizedPnlUsd is undefined -> unstable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: undefined, unrealizedPnlUsd: 50 }), false)
  })

  it('unrealizedPnlUsd is NaN/Infinity/null/undefined -> unstable (same checks, other field)', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: NaN }), false)
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: Infinity }), false)
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: -Infinity }), false)
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: null }), false)
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: undefined }), false)
  })

  it("publicPnlStatus 'ok' -> stable (real equivalent of the spec's 'available')", () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: 5, publicPnlStatus: 'ok' }), true)
  })

  it("publicPnlStatus 'limited_verified_sample' -> unstable", () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: 5, publicPnlStatus: 'limited_verified_sample' }), false)
  })

  it("publicPnlStatus 'unavailable' -> unstable", () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: 5, publicPnlStatus: 'unavailable' }), false)
  })

  it('publicPnlStatus omitted -> does not fail by itself (caller has no such data wired)', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 10, unrealizedPnlUsd: 5 }), true)
  })

  it('valid finite numbers, no missing evidence, publicPnlStatus ok -> stable', () => {
    assert.equal(isStablePnl({ realizedPnlUsd: 1234.56, unrealizedPnlUsd: -789.01, evidenceMissingCount: 0, publicPnlStatus: 'ok' }), true)
  })
})

describe('selectVerifiedPnlData — stable field wiring', () => {
  it('a real, finite pnlV2 with publicPnlStatus "ok" is marked stable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500, unrealizedPnlUsd: -100 }), 'ok')
    assert.equal(result.stable, true)
  })

  it('publicPnlStatus "unavailable" marks otherwise-valid numbers unstable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500, unrealizedPnlUsd: -100 }), 'unavailable')
    assert.equal(result.stable, false)
  })

  it('no pnlV2 at all -> stable is honestly false (nothing to be confident about)', () => {
    const result = selectVerifiedPnlData(null)
    assert.equal(result.stable, false)
  })
})

describe('PNL_UNAVAILABLE_MESSAGE — exact literal text', () => {
  it('matches this task\'s required exact string', () => {
    assert.equal(PNL_UNAVAILABLE_MESSAGE, 'PnL unavailable due to missing evidence')
  })
})

describe('shouldShowSyntheticPnl — Part 4 UI gating', () => {
  const syntheticPnl = {
    syntheticRealizedPnlUsd: 10, syntheticUnrealizedPnlUsd: 5, syntheticTotalPnlUsd: 15, syntheticRoiPct: 20,
    tradeCount: 3, highConfidenceCount: 2, mediumConfidenceCount: 1, lowConfidenceCount: 0,
  }

  it("shows synthetic PnL when publicPnlStatus is 'unavailable' and real synthetic trades exist", () => {
    assert.equal(shouldShowSyntheticPnl('unavailable', syntheticPnl), true)
  })

  it("does NOT show synthetic PnL when publicPnlStatus is 'ok' (a real, verified number is available)", () => {
    assert.equal(shouldShowSyntheticPnl('ok', syntheticPnl), false)
  })

  it("does NOT show synthetic PnL when publicPnlStatus is 'limited_verified_sample'", () => {
    assert.equal(shouldShowSyntheticPnl('limited_verified_sample', syntheticPnl), false)
  })

  it('does NOT show synthetic PnL when syntheticPnl is null/undefined (nothing to show)', () => {
    assert.equal(shouldShowSyntheticPnl('unavailable', null), false)
    assert.equal(shouldShowSyntheticPnl('unavailable', undefined), false)
  })

  it('does NOT show synthetic PnL when tradeCount is 0 (an empty synthetic summary is not worth displaying)', () => {
    assert.equal(shouldShowSyntheticPnl('unavailable', { ...syntheticPnl, tradeCount: 0 }), false)
  })

  it('publicPnlStatus omitted -> does not show synthetic PnL (never assumes unavailable)', () => {
    assert.equal(shouldShowSyntheticPnl(null, syntheticPnl), false)
    assert.equal(shouldShowSyntheticPnl(undefined, syntheticPnl), false)
  })
})

describe('PnlStatusCard end-to-end display mode — this task\'s 3 required scenarios', () => {
  const realSyntheticPnl = {
    syntheticRealizedPnlUsd: 42, syntheticUnrealizedPnlUsd: -7, syntheticTotalPnlUsd: 35, syntheticRoiPct: 12,
    tradeCount: 5, highConfidenceCount: 3, mediumConfidenceCount: 2, lowConfidenceCount: 0,
  }

  it("publicPnlStatus = 'unavailable', syntheticPnl present -> synthetic block renders (mode 'synthetic')", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'unavailable')
    const isActive = true
    const showSynthetic = shouldShowSyntheticPnl('unavailable', realSyntheticPnl)
    assert.equal(showSynthetic, true)
    const mode = resolvePnlDisplayMode({ isActive, blocked: pnl.unreliable || !pnl.stable, showSyntheticPnl: showSynthetic })
    assert.equal(mode, 'synthetic')
  })

  it("publicPnlStatus = 'unavailable', syntheticPnl missing -> fallback unavailable block renders (mode 'unavailable')", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'unavailable')
    const isActive = true
    const showSynthetic = shouldShowSyntheticPnl('unavailable', null)
    assert.equal(showSynthetic, false)
    const mode = resolvePnlDisplayMode({ isActive, blocked: pnl.unreliable || !pnl.stable, showSyntheticPnl: showSynthetic })
    assert.equal(mode, 'unavailable')
  })

  it("publicPnlStatus = 'ok' -> real PnL renders, synthetic ignored even if present (mode 'real')", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'ok')
    const isActive = true
    const showSynthetic = shouldShowSyntheticPnl('ok', realSyntheticPnl)
    assert.equal(showSynthetic, false) // synthetic never even considered when the real engine says 'ok'
    const mode = resolvePnlDisplayMode({ isActive, blocked: pnl.unreliable || !pnl.stable, showSyntheticPnl: showSynthetic })
    assert.equal(mode, 'real')
  })
})

describe('resolvePnlDisplayMode — pure combinatorial logic', () => {
  it('inactive (no pnlV2 at all) always wins, regardless of blocked/synthetic', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: false, blocked: true, showSyntheticPnl: true }), 'inactive')
    assert.equal(resolvePnlDisplayMode({ isActive: false, blocked: false, showSyntheticPnl: false }), 'inactive')
  })

  it('synthetic REPLACES unavailable — never both blocked and unavailable when synthetic is available', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: true, showSyntheticPnl: true }), 'synthetic')
  })

  it('blocked without synthetic -> unavailable', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: true, showSyntheticPnl: false }), 'unavailable')
  })

  it('not blocked -> real, regardless of showSyntheticPnl (should never happen together, but real wins if it does)', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: false, showSyntheticPnl: true }), 'real')
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: false, showSyntheticPnl: false }), 'real')
  })
})
