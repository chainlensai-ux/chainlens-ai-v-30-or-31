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
import { selectVerifiedPnlData, shouldShowLimitedSampleBadge, GUARDRAIL_ABS_LIMIT, isStablePnl, PNL_UNAVAILABLE_MESSAGE, hasGlobalSynthetic, hasPerChainSynthetic, shouldShowSyntheticGlobal, shouldShowSyntheticPerChain, resolvePnlDisplayMode } from './PnlStatusCard'
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

function syntheticPnlFixture(overrides: Partial<{
  totalRealizedPnlUsd: number | null
  totalUnrealizedPnlUsd: number | null
  totalPnlUsd: number | null
  roiPercent: number | null
  costBasisUsd: number | null
  perChain: Array<{ chainId: string; realizedPnlUsd: number | null; unrealizedPnlUsd: number | null; totalPnlUsd: number | null; roiPercent: number | null; costBasisUsd: number | null }>
  tradeCount: number
  highConfidenceCount: number
  mediumConfidenceCount: number
  lowConfidenceCount: number
}>) {
  return {
    totalRealizedPnlUsd: 42, totalUnrealizedPnlUsd: -7, totalPnlUsd: 35, roiPercent: 12, costBasisUsd: 300,
    perChain: [{ chainId: 'base', realizedPnlUsd: 42, unrealizedPnlUsd: -7, totalPnlUsd: 35, roiPercent: 12, costBasisUsd: 300 }],
    tradeCount: 5, highConfidenceCount: 3, mediumConfidenceCount: 2, lowConfidenceCount: 0,
    ...overrides,
  }
}

describe('hasGlobalSynthetic / hasPerChainSynthetic / shouldShowSyntheticGlobal / shouldShowSyntheticPerChain', () => {
  // RELAXED, DISCLOSED (this task's own request): hasGlobalSynthetic no longer requires
  // totalPnlUsd !== null — computeSyntheticPnl (src/modules/syntheticPnl) never returns a null
  // totalPnlUsd anymore (missing cost basis/price contributes a real 0), so the object's mere
  // presence is now sufficient. A hand-constructed fixture with totalPnlUsd: null (not something
  // the real computeSyntheticPnl produces, but still a valid SyntheticPnlSummary shape) is STILL
  // "present" and therefore still shown — this is the intended, disclosed relaxation.
  it('hasGlobalSynthetic is true whenever a real SyntheticPnlSummary object exists, regardless of its field values', () => {
    assert.equal(hasGlobalSynthetic(syntheticPnlFixture({})), true)
    assert.equal(hasGlobalSynthetic(syntheticPnlFixture({ totalPnlUsd: null })), true)
    assert.equal(hasGlobalSynthetic(null), false)
    assert.equal(hasGlobalSynthetic(undefined), false)
  })

  it('hasPerChainSynthetic is true when at least one chain entry has any real number', () => {
    assert.equal(hasPerChainSynthetic(syntheticPnlFixture({ totalPnlUsd: null })), true)
    assert.equal(hasPerChainSynthetic(syntheticPnlFixture({
      totalPnlUsd: null,
      perChain: [{ chainId: 'base', realizedPnlUsd: null, unrealizedPnlUsd: null, totalPnlUsd: null, roiPercent: null, costBasisUsd: null }],
    })), false)
    assert.equal(hasPerChainSynthetic(syntheticPnlFixture({ totalPnlUsd: null, perChain: [] })), false)
    assert.equal(hasPerChainSynthetic(null), false)
  })

  it("shouldShowSyntheticGlobal requires publicPnlStatus === 'unavailable' AND a real synthetic object (relaxed: any object, not just non-null totals)", () => {
    assert.equal(shouldShowSyntheticGlobal('unavailable', syntheticPnlFixture({})), true)
    assert.equal(shouldShowSyntheticGlobal('ok', syntheticPnlFixture({})), false)
    assert.equal(shouldShowSyntheticGlobal('unavailable', syntheticPnlFixture({ totalPnlUsd: null })), true)
    assert.equal(shouldShowSyntheticGlobal('unavailable', null), false)
  })

  it('shouldShowSyntheticPerChain is now rare: only reachable when syntheticPnl itself is null/undefined (global always wins otherwise)', () => {
    assert.equal(shouldShowSyntheticPerChain('unavailable', syntheticPnlFixture({ totalPnlUsd: null })), false) // global object present -> global wins even with null totals
    assert.equal(shouldShowSyntheticPerChain('unavailable', syntheticPnlFixture({})), false)
    assert.equal(shouldShowSyntheticPerChain('ok', syntheticPnlFixture({ totalPnlUsd: null })), false)
    assert.equal(shouldShowSyntheticPerChain('unavailable', null), false) // hasGlobalSynthetic(null) is false, but hasPerChainSynthetic(null) is also false
  })
})

describe('PnlStatusCard end-to-end display mode — Cases A/B/C/D', () => {
  it("Case A: publicPnlStatus = 'unavailable', global synthetic present -> global synthetic block renders", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'unavailable')
    const syntheticPnl = syntheticPnlFixture({})
    const mode = resolvePnlDisplayMode({
      isActive: true,
      blocked: pnl.unreliable || !pnl.stable,
      showSyntheticGlobal: shouldShowSyntheticGlobal('unavailable', syntheticPnl),
      showSyntheticPerChain: shouldShowSyntheticPerChain('unavailable', syntheticPnl),
    })
    assert.equal(mode, 'synthetic')
  })

  // RELAXED, DISCLOSED (this task's own request, Step 4: "per-chain synthetic remains fallback
  // only when global synthetic is null (should now be rare)"): with hasGlobalSynthetic relaxed to
  // "the object exists" (see that function's own header), shouldShowSyntheticPerChain is now
  // effectively unreachable via the gating functions in practice — the ONLY way hasGlobalSynthetic
  // is false is when syntheticPnl itself is null/undefined, and hasPerChainSynthetic requires the
  // object to be non-null too. Case B is therefore tested directly against resolvePnlDisplayMode's
  // own pure logic (proving the 'synthetic_per_chain' mode itself still works correctly if the
  // pipeline or a future caller ever produces that combination), rather than via the real gating
  // functions, which correctly no longer reach it given today's relaxed rules.
  it("Case B (mode-level): resolvePnlDisplayMode still supports 'synthetic_per_chain' as a mode, even though shouldShowSyntheticGlobal now makes it rare in practice", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'unavailable')
    const mode = resolvePnlDisplayMode({
      isActive: true,
      blocked: pnl.unreliable || !pnl.stable,
      showSyntheticGlobal: false, // hypothetical: global unavailable
      showSyntheticPerChain: true, // hypothetical: per-chain evidence exists
    })
    assert.equal(mode, 'synthetic_per_chain')
  })

  it("Case B (gating-level, this task's own relaxation): a real SyntheticPnlSummary object with null totals now shows GLOBAL, not per-chain (global always wins when the object exists)", () => {
    const syntheticPnl = syntheticPnlFixture({ totalRealizedPnlUsd: null, totalUnrealizedPnlUsd: null, totalPnlUsd: null, roiPercent: null })
    assert.equal(shouldShowSyntheticGlobal('unavailable', syntheticPnl), true)
    assert.equal(shouldShowSyntheticPerChain('unavailable', syntheticPnl), false)
  })

  it("Case C: publicPnlStatus = 'unavailable', syntheticPnl missing (null) -> unavailable block renders", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'unavailable')
    const mode = resolvePnlDisplayMode({
      isActive: true, blocked: pnl.unreliable || !pnl.stable,
      showSyntheticGlobal: shouldShowSyntheticGlobal('unavailable', null),
      showSyntheticPerChain: shouldShowSyntheticPerChain('unavailable', null),
    })
    assert.equal(mode, 'unavailable')
  })

  it("Case D: publicPnlStatus = 'ok' -> real engine PnL renders, both synthetic blocks hidden", () => {
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: 50 }), 'ok')
    const syntheticPnl = syntheticPnlFixture({})
    const showGlobal = shouldShowSyntheticGlobal('ok', syntheticPnl)
    const showPerChain = shouldShowSyntheticPerChain('ok', syntheticPnl)
    assert.equal(showGlobal, false)
    assert.equal(showPerChain, false)
    const mode = resolvePnlDisplayMode({ isActive: true, blocked: pnl.unreliable || !pnl.stable, showSyntheticGlobal: showGlobal, showSyntheticPerChain: showPerChain })
    assert.equal(mode, 'real')
  })
})

describe('resolvePnlDisplayMode — pure combinatorial logic', () => {
  it('inactive (no pnlV2 at all) always wins, regardless of blocked/synthetic', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: false, blocked: true, showSyntheticGlobal: true, showSyntheticPerChain: true }), 'inactive')
    assert.equal(resolvePnlDisplayMode({ isActive: false, blocked: false, showSyntheticGlobal: false, showSyntheticPerChain: false }), 'inactive')
  })

  it('global synthetic REPLACES unavailable and takes priority over per-chain', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: true, showSyntheticGlobal: true, showSyntheticPerChain: true }), 'synthetic')
  })

  it('per-chain synthetic REPLACES unavailable when global is not shown', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: true, showSyntheticGlobal: false, showSyntheticPerChain: true }), 'synthetic_per_chain')
  })

  it('blocked without any synthetic -> unavailable', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: true, showSyntheticGlobal: false, showSyntheticPerChain: false }), 'unavailable')
  })

  it('not blocked -> real, regardless of synthetic flags (should never happen together, but real wins if it does)', () => {
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: false, showSyntheticGlobal: true, showSyntheticPerChain: true }), 'real')
    assert.equal(resolvePnlDisplayMode({ isActive: true, blocked: false, showSyntheticGlobal: false, showSyntheticPerChain: false }), 'real')
  })
})
