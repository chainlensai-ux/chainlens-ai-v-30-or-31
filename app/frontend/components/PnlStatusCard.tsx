'use client'

// PnlStatusCard — single-verified-source redesign of the FIFO & PnL section.
//
// SINGLE-SOURCE MIGRATION, DISCLOSED (this task's own request): this component previously merged
// THREE independent PnL sources with a silent priority fallback (pnlV2 > fifoAndPnl > pnlSummaryV2
// — see this file's own prior header/selectPnlData for the exact old logic) — realized/unrealized
// numbers, ROI, integrity, and the closed-lots table each quietly came from whichever of the three
// happened to be present, which is exactly the "duplicate/inconsistent PnL" confusion this task
// asked to eliminate. This component now reads ONLY `pnlV2` (lib/engine/modules/pnl/types.ts's
// PnlV2 — the V2 engine's own self-contained realized+unrealized computation) for every number it
// renders. `fifoAndPnl`/`pnlSummaryV2` (the old pipeline's FIFO engine / pnlEngine outputs) are no
// longer accepted as props at all — never merged, never averaged, never used as a silent fallback.
//
// REAL GAPS FROM DROPPING THE OLD SOURCES, DISCLOSED (not silently worked around):
//   - Integrity/confidence: PnlV2 carries no integrity-flag or confidence concept at all (no
//     hardInvalid/estimateOnlyLotsExcluded/syntheticLotsExcluded equivalent). Previously this badge
//     read fifoAndPnl.integrityFlags — now honestly shows "Not available (V2 engine)" rather than
//     silently falling back to the excluded pipeline-level source.
//   - Matched/Unmatched Lots, Closed Lots table, Sell Timeline: these are FIFO-lot-level concepts
//     (lotId/txHash/costUsdEstimate/proceedsUsdEstimate/evidence) that do not exist in PnlV2's shape
//     at all (PnlV2 has per-TOKEN realized/unrealized entries — TokenRealizedPnl/TokenUnrealizedPnl
//     — not per-LOT entries). Removed entirely rather than sourced from the now-excluded
//     fifoAndPnl/pnlSummaryV2. Replaced with a real, verified-source-only view: per-token
//     realized/unrealized breakdown and per-chain breakdown, both directly from PnlV2.
//   - ROI: now computed purely from PnlV2 — realizedPnlUsd / sum(costBasis[].totalCostUsd), a real
//     total cost basis PnlV2 does carry (per-token, summed here), never fifoAndPnl.costBasisUsd.
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import type { PublicPnlStatus, UnrealizedReconciliationSummary } from '@/src/modules/fifoEngine/types'
import type { SyntheticPnlSummary } from '@/src/modules/syntheticPnl/types'
import { fmtSignedUsd, fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'
import { MetricCard, toneFromNumber } from './MetricCard'
import { TrendingDownIcon, TrendingUpIcon, WarningIcon } from './Icons'
import { SyntheticPnlBlock } from './SyntheticPnlBlock'
import { SyntheticPerChainPnlBlock } from './SyntheticPerChainPnlBlock'

export type PnlStatusCardProps = {
  pnlV2: PnlV2 | null | undefined
  // Optional, additive — the REAL field lives at
  // result.finalSummary.financialStatus.officialPnlStatus (FifoOutput['publicPnlStatus'] =
  // 'ok' | 'limited_verified_sample' | 'unavailable'; there is no `publicPnlStatus` directly on
  // pnlV2 or on the report's top level, despite a later task describing one there). Omitting this
  // prop simply skips the badge below — no fabricated default value.
  publicPnlStatus?: PublicPnlStatus | null
  // Optional, additive — the real field lives at result.syntheticPnl (src/modules/syntheticPnl,
  // UI-DISPLAY-ONLY — never derived from or fed into fifoEngine/pnlV2, see that module's own
  // header). Only ever rendered when publicPnlStatus === 'unavailable' AND pnlV2's own display is
  // blocked — never overlaid on top of a real, verified number.
  syntheticPnl?: SyntheticPnlSummary | null
  // CANONICAL UNREALIZED-PNL SOURCE, DISCLOSED (found live, this task — confirmed production bug:
  // the wallet-scanner UI kept showing a fabricated ~$500k unrealized PnL, sourced from pnlV2's own
  // unrealizedPnlUsd, DESPITE the backend's real canonical reconciliation
  // — result.fifoAndPnl.unrealizedReconciliation.officialUnrealizedPnlUsd — already correctly
  // reporting -$0.0863). Real field lives at result.fifoAndPnl.unrealizedReconciliation
  // (src/modules/fifoEngine/types.ts's UnrealizedReconciliationSummary) — a SEPARATE engine
  // (fifoEngine) from pnlV2 (lib/engine/modules/pnl), but its own reconciliation, not its
  // un-reconciled top-level unrealizedPnlUsd, is now this card's SOLE source for the displayed
  // Unrealized PnL value. See selectDisplayedUnrealizedPnl's own header below for the exact rule.
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null
}

export type VerifiedPnlData = {
  realizedPnlUsd: number | null
  unrealizedPnlUsd: number | null
  totalPnlUsd: number | null
  totalCostBasisUsd: number | null
  roi: { value: number | null; display: string }
  // Honest placeholders — PnlV2 (the one verified source this component now reads) carries neither.
  // Never derived from the excluded fifoAndPnl/pnlSummaryV2 sources.
  integritySummary: 'not_available_in_v2_engine'
  // DISPLAY-ONLY GUARDRAIL, DISCLOSED: true when unrealizedPnlUsd or totalCostBasisUsd exceeds
  // GUARDRAIL_ABS_LIMIT. This flag never changes pnlV2 itself or any number returned above — it
  // only tells the component below to swap the numeric MetricCards for a "Not reliable" placeholder
  // and a warning badge. The underlying pnlV2 data is untouched and still fully present in this
  // object for any caller (e.g. a test) that wants the raw number regardless of the clamp.
  unreliable: boolean
  // STABLE-PNL GUARD, DISCLOSED (this task's own request) — see isStablePnl's own header for the
  // exact rule and the two real-field corrections applied. `unreliable` (the magnitude heuristic
  // above) and `!stable` are two INDEPENDENT reasons a display can be blocked; either one alone is
  // enough (see PnlStatusCard's own `blocked` combination below).
  stable: boolean
}

// UI-ONLY HEURISTIC, DISCLOSED: not a backend-computed threshold. pnlV2 (lib/engine/modules/pnl)
// has no evidence-count/confidence field of its own, so the only defensive signal available at this
// layer is magnitude — a real wallet's realistic USD PnL/cost-basis does not reach $1e9. This value
// existing at all almost always means a missing/duplicate-decimals price or a pathological token
// slipped past pricingAtTimeEngine, not a real gain/loss. Chosen for THIS card only; does not alter
// pricingAtTimeEngine, fifoEngine, or pnlV2's own semantics anywhere else in the codebase.
export const GUARDRAIL_ABS_LIMIT = 1e9

// UNREALIZED-VALUE PARAMETERIZED, DISCLOSED: this used to read pnlV2.unrealizedPnlUsd directly —
// now takes the ALREADY-RESOLVED displayed unrealized value (from selectDisplayedUnrealizedPnl,
// the canonical fifoEngine reconciliation, never pnlV2's own field) so this guard reacts to the
// SAME number the card actually renders, never a legacy figure the card no longer displays at all.
// Per-chain unrealizedPnlUsd (pnlV2.chainBreakdown) is deliberately EXCLUDED from this magnitude
// check now — see ChainBreakdownTable's own header for why that legacy per-chain figure is no
// longer rendered as an official number either.
function isUnreliableMagnitude(pnlV2: PnlV2, totalCostBasisUsd: number, displayedUnrealizedPnlUsd: number | null): boolean {
  const magnitudes = [
    pnlV2.realizedPnlUsd,
    totalCostBasisUsd,
    ...pnlV2.chainBreakdown.map((c) => c.realizedPnlUsd),
  ]
  if (displayedUnrealizedPnlUsd != null) magnitudes.push(displayedUnrealizedPnlUsd)
  return magnitudes.some((v) => Math.abs(v) > GUARDRAIL_ABS_LIMIT)
}

// CANONICAL UNREALIZED-PNL SELECTOR, DISCLOSED — see PnlStatusCardProps.unrealizedReconciliation's
// own header for the full production trace. Pure, exported for direct testing. The ONLY function
// this card uses to resolve the displayed Unrealized PnL value — no priority list, no merge, no
// averaging, and specifically NEVER pnlV2.unrealizedPnlUsd (the legacy, un-reconciled figure that
// caused the reported ~$500k bug). `unrealizedReconciliation` missing/null (a caller that hasn't
// wired it, or a genuinely absent backend field) and `officialUnrealizedPnlUsd` itself being null
// (backend computed reconciliation but found nothing trustworthy to report) BOTH resolve to `value:
// null` here — the component then renders "Unavailable", never a fallback estimate.
export type DisplayedUnrealizedPnl = {
  value: number | null
  reconciliationStatus: UnrealizedReconciliationSummary['reconciliationStatus'] | null
  coveragePercent: number | null
}

export function selectDisplayedUnrealizedPnl(
  unrealizedReconciliation: UnrealizedReconciliationSummary | null | undefined,
): DisplayedUnrealizedPnl {
  if (!unrealizedReconciliation) {
    return { value: null, reconciliationStatus: null, coveragePercent: null }
  }
  return {
    value: unrealizedReconciliation.officialUnrealizedPnlUsd,
    reconciliationStatus: unrealizedReconciliation.reconciliationStatus,
    coveragePercent: unrealizedReconciliation.unrealizedCoveragePercent,
  }
}

// DEV-ONLY DIAGNOSTIC, DISCLOSED (this task's own "add a development assertion/log identifying the
// exact field selected" requirement): a single, cheap console.debug — never runs in production
// (next.config's compiler.removeConsole strips console.debug/log there anyway, but this also skips
// the call entirely rather than relying only on that stripping). Identifies, in plain text, exactly
// which real field backed the rendered Unrealized PnL for this render — makes a future regression
// (a fallback silently reintroduced) immediately visible in the browser console during development.
function logUnrealizedPnlFieldSelection(displayed: DisplayedUnrealizedPnl, legacyPnlV2UnrealizedPnlUsd: number | null | undefined): void {
  if (process.env.NODE_ENV === 'production') return
  const field = displayed.value != null
    ? 'fifoAndPnl.unrealizedReconciliation.officialUnrealizedPnlUsd'
    : 'unavailable (no reconciliation or null officialUnrealizedPnlUsd)'
  // eslint-disable-next-line no-console
  console.debug('[PnlStatusCard] Unrealized PnL field selected', {
    field,
    displayedValue: displayed.value,
    reconciliationStatus: displayed.reconciliationStatus,
    coveragePercent: displayed.coveragePercent,
    // Logged ONLY for comparison/debugging — never used anywhere as the displayed value.
    legacyPnlV2UnrealizedPnlUsd: legacyPnlV2UnrealizedPnlUsd ?? null,
  })
}

// isStablePnl — PURE, exported for direct testing, adapted from this task's own literal spec with
// two real-field corrections, both disclosed:
//   1. `evidenceMissingCount` does not exist on PnlV2 (the single verified source this card reads —
//      see this file's own header). It's a real field on the OLD pipeline's pnlSummaryV2/
//      PnlSummaryResult, which this component deliberately excluded (single-verified-source
//      decision, an earlier task this session). Rather than re-introduce that excluded source just
//      for this one field, it's accepted here as an OPTIONAL parameter — a caller with real access
//      to it (none currently wire it) can supply it; omitted defaults to 0 (pass), never a
//      fabricated failure for a caller that has no such data.
//   2. `publicPnlStatus !== 'available'`: the REAL enum (FifoOutput['publicPnlStatus'],
//      src/modules/fifoEngine/types.ts) is `'ok' | 'limited_verified_sample' | 'unavailable'` — it
//      can never equal the literal string `'available'`. Taking the spec literally would mean this
//      guard ALWAYS fails, permanently hiding every wallet's PnL regardless of data quality — not
//      the intent. `'ok'` is treated as the real equivalent (same mapping this codebase's own
//      FinalSummaryView.tsx already uses for its officialPnlStatus tone). `publicPnlStatus` is
//      already an optional prop on this component (see PnlStatusCardProps) for callers that don't
//      wire it — omitted/undefined does not fail this check by itself, so this guard's addition
//      never silently blocks every existing caller that hasn't been updated to pass it.
export function isStablePnl(params: {
  realizedPnlUsd: number | null | undefined
  unrealizedPnlUsd: number | null | undefined
  evidenceMissingCount?: number
  publicPnlStatus?: PublicPnlStatus | null
}): boolean {
  if ((params.evidenceMissingCount ?? 0) > 0) return false
  if (!Number.isFinite(params.realizedPnlUsd)) return false
  if (!Number.isFinite(params.unrealizedPnlUsd)) return false
  if (params.publicPnlStatus != null && params.publicPnlStatus !== 'ok') return false
  return true
}

// Pure, exported for direct testing. The ONLY selector this component uses for realized PnL/ROI/
// cost basis — no priority list, no merge, no averaging: pnlV2 present -> real numbers; pnlV2
// absent -> honestly all-null. UNREALIZED PNL, DISCLOSED: sourced EXCLUSIVELY from
// `unrealizedReconciliation` (via selectDisplayedUnrealizedPnl) — never from pnlV2.unrealizedPnlUsd,
// regardless of whether pnlV2 itself is present. `totalPnlUsd` is therefore also null whenever the
// reconciled unrealized value is null (realized-only would misrepresent itself as a complete total).
export function selectVerifiedPnlData(
  pnlV2: PnlV2 | null | undefined,
  publicPnlStatus?: PublicPnlStatus | null,
  unrealizedReconciliation?: UnrealizedReconciliationSummary | null,
): VerifiedPnlData {
  const displayedUnrealized = selectDisplayedUnrealizedPnl(unrealizedReconciliation)
  logUnrealizedPnlFieldSelection(displayedUnrealized, pnlV2?.unrealizedPnlUsd)

  if (!pnlV2) {
    return {
      realizedPnlUsd: null,
      unrealizedPnlUsd: displayedUnrealized.value,
      totalPnlUsd: null,
      totalCostBasisUsd: null,
      roi: { value: null, display: 'No verified PnL data' },
      integritySummary: 'not_available_in_v2_engine',
      unreliable: false,
      stable: false,
    }
  }

  const totalCostBasisUsd = pnlV2.costBasis.reduce((sum, c) => sum + c.totalCostUsd, 0)
  const roiValue = totalCostBasisUsd > 0 ? (pnlV2.realizedPnlUsd / totalCostBasisUsd) * 100 : null
  const roi = roiValue == null
    ? { value: null, display: 'No cost-basis evidence' }
    : { value: roiValue, display: `${roiValue >= 0 ? '+' : ''}${roiValue.toFixed(1)}%` }

  const unrealizedPnlUsd = displayedUnrealized.value
  const totalPnlUsd = unrealizedPnlUsd == null ? null : pnlV2.realizedPnlUsd + unrealizedPnlUsd

  return {
    realizedPnlUsd: pnlV2.realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    totalCostBasisUsd,
    roi,
    integritySummary: 'not_available_in_v2_engine',
    unreliable: isUnreliableMagnitude(pnlV2, totalCostBasisUsd, unrealizedPnlUsd),
    stable: isStablePnl({ realizedPnlUsd: pnlV2.realizedPnlUsd, unrealizedPnlUsd, publicPnlStatus }),
  }
}

// PER-CHAIN UNREALIZED SUPPRESSION, DISCLOSED (found live, this task — "audit every Wallet Scanner
// UI path that renders Unrealized PnL" requirement): this table's per-chain `unrealizedPnlUsd`
// column came straight from pnlV2.chainBreakdown — the SAME legacy, un-reconciled source responsible
// for the reported ~$500k bug (confirmed: the original bug screenshot's own "PER-CHAIN BREAKDOWN"
// table showed exactly this column, for chain 8453, as the fabricated figure). There is no
// per-chain breakdown of the canonical `unrealizedReconciliation.officialUnrealizedPnlUsd` on the
// backend to substitute it with, so rather than either (a) keep showing the legacy figure as if
// official, or (b) fabricate a per-chain split of the aggregate that doesn't exist, this column is
// replaced with an honest pointer to the one real reconciled number, shown above, whenever a
// canonical reconciliation was supplied to this card at all (regardless of its own value/status).
function ChainBreakdownTable({
  chainBreakdown,
  unreliable,
  hasCanonicalUnrealizedSource,
}: {
  chainBreakdown: PnlV2['chainBreakdown']
  unreliable: boolean
  hasCanonicalUnrealizedSource: boolean
}) {
  if (chainBreakdown.length === 0) {
    return <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No per-chain PnL breakdown from the verified V2 engine.</p>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'rgba(148,163,184,0.55)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            <th style={{ padding: '6px 10px' }}>Chain ID</th>
            <th style={{ padding: '6px 10px' }}>Realized PnL</th>
            <th style={{ padding: '6px 10px' }}>Unrealized PnL</th>
          </tr>
        </thead>
        <tbody>
          {chainBreakdown.map((c) => {
            // Same GUARDRAIL_ABS_LIMIT clamp applied per-chain-row, per task requirement — the
            // per-chain breakdown must not leak an absurd number even if the aggregate is clamped.
            // Only applied to realizedPnlUsd now (still a real, pnlV2-sourced figure) — the legacy
            // unrealized figure is suppressed unconditionally below, never rendered as official.
            const rowUnreliable = unreliable && Math.abs(c.realizedPnlUsd) > GUARDRAIL_ABS_LIMIT
            return (
              <tr key={c.chainId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{c.chainId}</td>
                {rowUnreliable ? (
                  <td colSpan={2} style={{ padding: '9px 10px', fontWeight: 700, color: '#fbbf24' }}>Not reliable — sample too incomplete</td>
                ) : (
                  <>
                    <td style={{ padding: '9px 10px', fontWeight: 700, color: c.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(c.realizedPnlUsd)}</td>
                    <td style={{ padding: '9px 10px', color: 'rgba(148,163,184,0.55)', fontStyle: 'italic' }}>
                      {hasCanonicalUnrealizedSource ? 'See reconciled total above' : fmtSignedUsd(c.unrealizedPnlUsd)}
                    </td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Pure, exported for direct testing — real backend classification only, no UI-only heuristic.
// Returns null for 'ok' (no badge) or when publicPnlStatus wasn't supplied at all (no fabricated
// default); otherwise returns the exact label to show, distinguishing the two non-'ok' real
// statuses rather than collapsing them into one generic string.
export function shouldShowLimitedSampleBadge(publicPnlStatus: PublicPnlStatus | null | undefined): string | null {
  if (publicPnlStatus == null || publicPnlStatus === 'ok') return null
  if (publicPnlStatus === 'limited_verified_sample') return 'Limited verified sample'
  return 'Not verified' // publicPnlStatus === 'unavailable'
}

// Literal message text, per this task's own spec — exported so tests can assert on the exact
// string rather than a substring guess.
export const PNL_UNAVAILABLE_MESSAGE = 'PnL unavailable due to missing evidence'

// GLOBAL-VS-PER-CHAIN SYNTHETIC GATING, DISCLOSED. RELAXED, DISCLOSED (this task's own request —
// Nansen-style "always show a number when the real engine can't"): `hasGlobalSynthetic` previously
// additionally required `syntheticPnl.totalPnlUsd !== null` — since computeSyntheticPnl (see that
// module's own header) NEVER returns a null totalPnlUsd anymore (missing cost basis/price
// contributes a real 0, never null), that extra check was already almost always true and is now
// removed entirely: any real, computed SyntheticPnlSummary object is sufficient. `hasPerChainSynthetic`
// is now correspondingly rare in practice (only reachable if the pipeline ever supplies a
// summary object with a genuinely empty/null-only perChain array) — kept for that edge case and for
// callers/tests that construct a summary by hand.
export function hasGlobalSynthetic(syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return syntheticPnl !== null && syntheticPnl !== undefined
}

export function hasPerChainSynthetic(syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return syntheticPnl != null && Array.isArray(syntheticPnl.perChain) && syntheticPnl.perChain.length > 0 &&
    syntheticPnl.perChain.some((c) => c.totalPnlUsd !== null || c.realizedPnlUsd !== null || c.unrealizedPnlUsd !== null)
}

// Pure, exported for direct testing — the exact condition for showing the GLOBAL synthetic block.
export function shouldShowSyntheticGlobal(publicPnlStatus: PublicPnlStatus | null | undefined, syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return publicPnlStatus === 'unavailable' && hasGlobalSynthetic(syntheticPnl)
}

// Pure, exported for direct testing — the exact condition for showing the PER-CHAIN fallback block:
// only when the global block is NOT shown (mutually exclusive by construction, not just by render
// order) AND at least one chain has real evidence.
export function shouldShowSyntheticPerChain(publicPnlStatus: PublicPnlStatus | null | undefined, syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return publicPnlStatus === 'unavailable' && !hasGlobalSynthetic(syntheticPnl) && hasPerChainSynthetic(syntheticPnl)
}

// DEPRECATED ALIAS, kept for backward compatibility with existing tests/callers from a prior
// commit — identical to shouldShowSyntheticGlobal (this task's canonical name going forward).
export const shouldShowSyntheticPnl = shouldShowSyntheticGlobal

export type PnlDisplayMode = 'synthetic' | 'synthetic_per_chain' | 'unavailable' | 'real' | 'inactive'

// Pure, exported for direct testing — the exact combinatorial decision PnlStatusCard renders from.
// REPLACE, NOT APPEND, DISCLOSED (this task's own request): 'synthetic'/'synthetic_per_chain' and
// 'unavailable' are mutually exclusive — when either synthetic summary is available, it REPLACES
// the "PnL unavailable" banner and the blocked numeric MetricCards, never rendered alongside them.
// 'synthetic' (global) always wins over 'synthetic_per_chain' when both would otherwise apply.
export function resolvePnlDisplayMode(params: {
  isActive: boolean
  blocked: boolean
  showSyntheticGlobal: boolean
  showSyntheticPerChain: boolean
}): PnlDisplayMode {
  if (!params.isActive) return 'inactive'
  if (params.blocked && params.showSyntheticGlobal) return 'synthetic'
  if (params.blocked && params.showSyntheticPerChain) return 'synthetic_per_chain'
  if (params.blocked) return 'unavailable'
  return 'real'
}

export function PnlStatusCard({ pnlV2, publicPnlStatus, syntheticPnl, unrealizedReconciliation }: PnlStatusCardProps) {
  const pnl = selectVerifiedPnlData(pnlV2, publicPnlStatus, unrealizedReconciliation)
  const isActive = pnlV2 != null
  // PARTIAL-COVERAGE BADGE, DISCLOSED (this task's own requirement): shown SEPARATELY from the
  // blocked/unavailable states above — a "partial" reconciliation still has a real, honestly-
  // computed officialUnrealizedPnlUsd (excluded positions are simply left out, never blended in),
  // so this is informational context alongside a real number, never a reason to hide it.
  const unrealizedCoverageBadgeLabel = unrealizedReconciliation?.reconciliationStatus === 'partial'
    ? `Partial — ${unrealizedReconciliation.unrealizedCoveragePercent.toFixed(2)}% coverage`
    : null
  const limitedSampleBadgeLabel = shouldShowLimitedSampleBadge(publicPnlStatus)
  const showSyntheticGlobal = shouldShowSyntheticGlobal(publicPnlStatus, syntheticPnl)
  const showSyntheticPerChain = shouldShowSyntheticPerChain(publicPnlStatus, syntheticPnl)
  // BLOCKED, DISCLOSED: `pnl.unreliable` (the pre-existing magnitude heuristic) and
  // `!pnl.stable` (this task's new isStablePnl guard) are two independent reasons to hide the
  // numeric display — either alone is enough. Applies uniformly to Realized/Unrealized/Total/ROI
  // (this task's requirement 4); Cost Basis is a real, always-finite sum of costBasis[] entries
  // with no NaN/Infinity failure mode of its own, so it is not blocked by this guard, only by the
  // separate magnitude heuristic already applied to it below.
  const blocked = isActive && (pnl.unreliable || !pnl.stable)
  const displayMode = resolvePnlDisplayMode({ isActive, blocked, showSyntheticGlobal, showSyntheticPerChain })
  const showUnavailableBanner = displayMode === 'unavailable'

  const headerIcon = pnl.realizedPnlUsd == null
    ? <WarningIcon size={16} color="#fbbf24" />
    : pnl.realizedPnlUsd >= 0 ? <TrendingUpIcon size={16} color="#4ade80" /> : <TrendingDownIcon size={16} color="#f87171" />

  return (
    <section>
      {/* RESPONSIVE FIX, DISCLOSED (Wallet Scanner V3 layout task, "no horizontal overflow on
          mobile" requirement): this row previously had no `flexWrap`, so a narrow viewport (~390px)
          pushed the "Not Verified"/"Not Reliable" StatusBadge text (nowrap by design — see that
          component's own header) past the viewport edge instead of wrapping onto a second line.
          Presentational only — no badge label, tone, or underlying PnL value changes. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex' }}>{headerIcon}</span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>PnL (Verified V2)</h3>
        <StatusBadge label={isActive ? 'Active' : 'Unavailable'} tone={isActive ? 'success' : 'neutral'} glow={isActive} />
        {pnl.unreliable && <StatusBadge label="Not reliable (magnitude)" tone="warning" glow />}
        {!pnl.stable && isActive && <StatusBadge label="PnL unavailable" tone="warning" glow />}
        {/* REAL backend classification (fifoEngine's publicPnlStatus, via
            finalSummary.financialStatus.officialPnlStatus) — a SEPARATE signal from the UI-only
            magnitude clamp above; shown whenever it isn't 'ok', regardless of magnitude. */}
        {limitedSampleBadgeLabel && <StatusBadge label={limitedSampleBadgeLabel} tone="warning" />}
        {unrealizedCoverageBadgeLabel && <StatusBadge label={unrealizedCoverageBadgeLabel} tone="warning" />}
      </div>

      {showUnavailableBanner && (
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#fbbf24', margin: '0 0 12px' }}>
          {PNL_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {displayMode === 'synthetic' && syntheticPnl ? (
        <SyntheticPnlBlock syntheticPnl={syntheticPnl} />
      ) : displayMode === 'synthetic_per_chain' && syntheticPnl ? (
        <SyntheticPerChainPnlBlock perChain={syntheticPnl.perChain} />
      ) : (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
          <MetricCard label="Realized PnL" value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.realizedPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.realizedPnlUsd)} index={0} />
          <MetricCard
            label="Unrealized PnL"
            value={pnl.unrealizedPnlUsd == null ? 'Unavailable' : blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.unrealizedPnlUsd)}
            tone={pnl.unrealizedPnlUsd == null || blocked ? 'neutral' : toneFromNumber(pnl.unrealizedPnlUsd)}
            index={1}
          />
          <MetricCard label="Total PnL" value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.totalPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.totalPnlUsd)} index={2} />
          <MetricCard label="ROI" value={blocked ? PNL_UNAVAILABLE_MESSAGE : pnl.roi.display} tone={blocked ? 'neutral' : toneFromNumber(pnl.roi.value)} index={3} />
          <MetricCard label="Cost Basis" value={pnl.unreliable ? 'Not reliable' : fmtUsd(pnl.totalCostBasisUsd)} index={4} />
          <MetricCard label="Integrity" value={<StatusBadge label="Not available (V2 engine)" tone="neutral" />} index={5} />
        </div>
      )}

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Per-Chain Breakdown
        </div>
        {/* hasCanonicalUnrealizedSource: `!== undefined`, NOT `!= null` — a caller that explicitly
            passes `null` (a real "checked, found nothing trustworthy" result) must still suppress
            the legacy per-chain figure; only a prop that was never supplied at all (a caller not
            yet migrated to this fix) falls back to it. */}
        <ChainBreakdownTable chainBreakdown={pnlV2?.chainBreakdown ?? []} unreliable={pnl.unreliable || blocked} hasCanonicalUnrealizedSource={unrealizedReconciliation !== undefined} />
      </div>

      {!isActive && (
        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.50)', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          Verified V2 PnL engine: inactive — no data for this scan yet.
        </div>
      )}
    </section>
  )
}

export default PnlStatusCard
