// Direct test for PnlStatusCard.tsx's selectVerifiedPnlData adapter. Uses node:test, same
// convention as the other module test files this session. NOT wired into `npm test` (which runs a
// single hardcoded file — see package.json). Run directly with:
//   npx tsx --test app/frontend/components/PnlStatusCard.selectPnlData.test.ts
//
// REWRITTEN, DISCLOSED: this file previously tested selectPnlData()'s 3-way priority fallback
// (pnlV2 > fifoAndPnl > pnlSummaryV2) — that function no longer exists. PnlStatusCard now reads
// realized PnL/ROI/cost-basis ONLY from pnlV2 (unchanged), and Unrealized PnL ONLY from
// `unrealizedReconciliation.officialUnrealizedPnlUsd` (src/modules/fifoEngine's canonical,
// balance-reconciled figure) — see selectDisplayedUnrealizedPnl's own header in PnlStatusCard.tsx
// for the confirmed ~$500k fabricated-PnL bug this fixes. `pnlV2.unrealizedPnlUsd` is set to a
// deliberately WRONG/conflicting value (545000) in most fixtures below specifically to prove it is
// never read for display — every test asserting a real `unrealizedPnlUsd`/`totalPnlUsd` value now
// supplies an explicit `unrealizedReconciliation` fixture.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectVerifiedPnlData, selectDisplayedUnrealizedPnl, shouldShowLimitedSampleBadge, GUARDRAIL_ABS_LIMIT, isStablePnl, PNL_UNAVAILABLE_MESSAGE, hasGlobalSynthetic, hasPerChainSynthetic, shouldShowSyntheticGlobal, shouldShowSyntheticPerChain, resolvePnlDisplayMode } from './PnlStatusCard'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'

function pnlV2(overrides: Partial<PnlV2>): PnlV2 {
  return { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], ...overrides }
}

// LEGACY-VS-CANONICAL CONFLICT FIXTURE, DISCLOSED: `545000` matches this task's own literal
// production-shaped conflicting-value example — a deliberately WRONG legacy pnlV2.unrealizedPnlUsd
// that must never leak into the display, paired with a real, small canonical reconciliation value.
const LEGACY_CONFLICTING_UNREALIZED_PNL_USD = 545_000

function reconciliation(overrides: Partial<UnrealizedReconciliationSummary> = {}): UnrealizedReconciliationSummary {
  return {
    totalOpenPositions: 1,
    reconciledOpenPositions: 1,
    excludedOpenPositions: 0,
    excludedCandidateMarketValueUsd: 0,
    excludedCandidateUnrealizedPnlUsd: 0,
    officialUnrealizedPnlUsd: 0,
    reconciliationStatus: 'ok',
    excludedPositions: [],
    reconciledPositionsByPriceSource: {},
    excludedReasonCounts: {},
    reconciledMarketValueUsd: 0,
    reconciledCostBasisUsd: 0,
    unrealizedCoveragePercent: 100,
    ...overrides,
  }
}

describe('selectVerifiedPnlData', () => {
  it('reads realized from pnlV2, but unrealized ONLY from the canonical unrealizedReconciliation — never from pnlV2.unrealizedPnlUsd', () => {
    const result = selectVerifiedPnlData(
      pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: LEGACY_CONFLICTING_UNREALIZED_PNL_USD }),
      'ok',
      reconciliation({ officialUnrealizedPnlUsd: -40 }),
    )
    assert.equal(result.realizedPnlUsd, 100)
    assert.equal(result.unrealizedPnlUsd, -40, 'must be the canonical reconciled value, never the conflicting legacy pnlV2 figure')
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

  it('never averages or merges — a negative realized + positive canonical unrealized sums exactly, no smoothing', () => {
    const result = selectVerifiedPnlData(
      pnlV2({ realizedPnlUsd: -30, unrealizedPnlUsd: LEGACY_CONFLICTING_UNREALIZED_PNL_USD }),
      'ok',
      reconciliation({ officialUnrealizedPnlUsd: 90 }),
    )
    assert.equal(result.realizedPnlUsd, -30)
    assert.equal(result.unrealizedPnlUsd, 90)
    assert.equal(result.totalPnlUsd, 60)
  })

  it('unrealizedReconciliation omitted entirely -> unrealizedPnlUsd/totalPnlUsd are null, never falling back to pnlV2.unrealizedPnlUsd', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: LEGACY_CONFLICTING_UNREALIZED_PNL_USD }))
    assert.equal(result.unrealizedPnlUsd, null)
    assert.equal(result.totalPnlUsd, null, 'a null unrealized value must make the total honestly null too, never realized-only masquerading as complete')
  })

  it('unrealizedReconciliation explicitly null -> unrealizedPnlUsd is null (canonical source checked, found nothing trustworthy)', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: LEGACY_CONFLICTING_UNREALIZED_PNL_USD }), 'ok', null)
    assert.equal(result.unrealizedPnlUsd, null)
  })

  it('officialUnrealizedPnlUsd itself null (reconciliation ran, nothing reconciled) -> unrealizedPnlUsd is null, never a legacy estimate', () => {
    const result = selectVerifiedPnlData(
      pnlV2({ realizedPnlUsd: 100, unrealizedPnlUsd: LEGACY_CONFLICTING_UNREALIZED_PNL_USD }),
      'ok',
      reconciliation({ officialUnrealizedPnlUsd: null, reconciliationStatus: 'failed', reconciledOpenPositions: 0, excludedOpenPositions: 3 }),
    )
    assert.equal(result.unrealizedPnlUsd, null)
    assert.equal(result.totalPnlUsd, null)
  })

  it("PRODUCTION-SHAPED: legacy pnlV2 field = 545000, canonical field = -0.086 -> resolves to -0.09 (rounded)", () => {
    const result = selectVerifiedPnlData(
      pnlV2({ realizedPnlUsd: 0, unrealizedPnlUsd: 545_000 }),
      'ok',
      reconciliation({ officialUnrealizedPnlUsd: -0.0862676760201886, reconciliationStatus: 'partial', unrealizedCoveragePercent: 8.33 }),
    )
    assert.equal(result.unrealizedPnlUsd, -0.0862676760201886, 'the exact canonical value must be preserved, never the conflicting legacy 545000')
    assert.equal(Math.round(result.unrealizedPnlUsd! * 100) / 100, -0.09, 'rounded for display must read -0.09, never anything derived from 545000')
  })
})

describe('selectDisplayedUnrealizedPnl — the sole selector for the Unrealized PnL value', () => {
  it('resolves the exact officialUnrealizedPnlUsd, reconciliationStatus, and coveragePercent from a real reconciliation', () => {
    const result = selectDisplayedUnrealizedPnl(reconciliation({ officialUnrealizedPnlUsd: -0.0862676760201886, reconciliationStatus: 'partial', unrealizedCoveragePercent: 8.33 }))
    assert.equal(result.value, -0.0862676760201886)
    assert.equal(result.reconciliationStatus, 'partial')
    assert.equal(result.coveragePercent, 8.33)
  })

  it('unrealizedReconciliation undefined -> value null', () => {
    assert.equal(selectDisplayedUnrealizedPnl(undefined).value, null)
  })

  it('unrealizedReconciliation null -> value null (checked, nothing trustworthy — same as undefined for display purposes)', () => {
    assert.equal(selectDisplayedUnrealizedPnl(null).value, null)
  })

  it('officialUnrealizedPnlUsd itself null -> value null, never coerced to 0', () => {
    const result = selectDisplayedUnrealizedPnl(reconciliation({ officialUnrealizedPnlUsd: null }))
    assert.equal(result.value, null)
  })

  it('excludedCandidateUnrealizedPnlUsd is NEVER read as the displayed value, even when it is the only non-zero figure present', () => {
    const recon = reconciliation({
      officialUnrealizedPnlUsd: null,
      excludedCandidateUnrealizedPnlUsd: 545_000, // the refused, diagnostic-only figure
      reconciliationStatus: 'failed',
      reconciledOpenPositions: 0,
      excludedOpenPositions: 1,
    })
    const result = selectDisplayedUnrealizedPnl(recon)
    assert.equal(result.value, null, 'a diagnostic-only excluded candidate must never surface as the official displayed value')
  })
})

describe('selectVerifiedPnlData — display-only guardrail (unreliable magnitude clamp)', () => {
  // UPDATED, DISCLOSED: this guard now reacts to the CANONICAL (reconciled) unrealized value, never
  // pnlV2.unrealizedPnlUsd directly (which is no longer displayed at all) — every test below drives
  // the magnitude via `reconciliation({ officialUnrealizedPnlUsd })`, not via pnlV2.
  it('flags unreliable when the canonical unrealizedPnlUsd is absurdly large, but leaves the resolved number untouched', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 10 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: 5e12 }))
    assert.equal(result.unreliable, true)
    // The underlying number is still returned honestly — only the component's rendering clamps it.
    assert.equal(result.unrealizedPnlUsd, 5e12)
  })

  it('flags unreliable when total cost basis is absurdly large', () => {
    const result = selectVerifiedPnlData(pnlV2({
      costBasis: [{ tokenAddress: '0xa', chainId: 8453, totalQuantity: 1, totalCostUsd: 2e9, averageCostUsd: 2e9 }],
    }), 'ok', reconciliation())
    assert.equal(result.unreliable, true)
  })

  it('a normal, realistic wallet is never flagged unreliable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: -120 }))
    assert.equal(result.unreliable, false)
  })

  it('an extreme 1e30 canonical unrealizedPnlUsd is flagged unreliable (the task\'s own example magnitude)', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: 1e30 }))
    assert.equal(result.unreliable, true)
    assert.equal(result.unrealizedPnlUsd, 1e30) // resolved value still returned untouched
  })

  it('a legacy pnlV2.unrealizedPnlUsd of 1e30 no longer flags unreliable BY ITSELF — it is never read at all once a sane canonical value exists', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0, unrealizedPnlUsd: 1e30 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: 5 }))
    assert.equal(result.unreliable, false, 'the guard must react to the displayed (canonical) value, not the unused legacy field')
    assert.equal(result.unrealizedPnlUsd, 5)
  })

  it('exactly at GUARDRAIL_ABS_LIMIT (1e9) is NOT flagged — the clamp is a strict "exceeds" check', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: GUARDRAIL_ABS_LIMIT }))
    assert.equal(result.unreliable, false)
  })

  it('just above GUARDRAIL_ABS_LIMIT (1e9 + 1) is flagged unreliable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: GUARDRAIL_ABS_LIMIT + 1 }))
    assert.equal(result.unreliable, true)
  })

  it('just below GUARDRAIL_ABS_LIMIT is not flagged', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 0 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: GUARDRAIL_ABS_LIMIT - 1 }))
    assert.equal(result.unreliable, false)
  })

  it('flags unreliable from realizedPnlUsd alone, even if the canonical unrealized total looks sane', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 1e15 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: 10 }))
    assert.equal(result.unreliable, true)
  })

  it('a per-chain pnlV2.chainBreakdown value alone no longer flags unreliable — that legacy figure is excluded from this guard now (see ChainBreakdownTable)', () => {
    const result = selectVerifiedPnlData(pnlV2({
      realizedPnlUsd: 10,
      chainBreakdown: [{ chainId: 8453, realizedPnlUsd: 10, unrealizedPnlUsd: 1e15 }],
    }), 'ok', reconciliation({ officialUnrealizedPnlUsd: 10 }))
    assert.equal(result.unreliable, false)
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
  it('a real, finite pnlV2 with publicPnlStatus "ok" and a real canonical unrealized value is marked stable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: -100 }))
    assert.equal(result.stable, true)
  })

  it('publicPnlStatus "unavailable" marks otherwise-valid numbers unstable', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500 }), 'unavailable', reconciliation({ officialUnrealizedPnlUsd: -100 }))
    assert.equal(result.stable, false)
  })

  it('no pnlV2 at all -> stable is honestly false (nothing to be confident about)', () => {
    const result = selectVerifiedPnlData(null)
    assert.equal(result.stable, false)
  })

  it('a null canonical unrealized value marks the card unstable (blocked), even with a real realizedPnlUsd', () => {
    const result = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 500 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: null }))
    assert.equal(result.stable, false)
    assert.equal(result.unrealizedPnlUsd, null)
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
  pricedViaDexScreenerCount: number
  pricingCoveragePercent: number
  pricingIntegrity: 'high' | 'medium' | 'low'
}>) {
  return {
    totalRealizedPnlUsd: 42, totalUnrealizedPnlUsd: -7, totalPnlUsd: 35, roiPercent: 12, costBasisUsd: 300,
    perChain: [{ chainId: 'base', realizedPnlUsd: 42, unrealizedPnlUsd: -7, totalPnlUsd: 35, roiPercent: 12, costBasisUsd: 300 }],
    tradeCount: 5, highConfidenceCount: 3, mediumConfidenceCount: 2, lowConfidenceCount: 0, pricedViaDexScreenerCount: 0,
    pricingCoveragePercent: 100, pricingIntegrity: 'high' as const,
    pricedViaUniswapCount: 0, pricedViaAerodromeCount: 0, pricedViaSushiCount: 0, pricedViaCurveCount: 0, pricedViaBalancerCount: 0,
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
    const pnl = selectVerifiedPnlData(pnlV2({ realizedPnlUsd: 100 }), 'ok', reconciliation({ officialUnrealizedPnlUsd: 50 }))
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
