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
import type { PublicPnlStatus } from '@/src/modules/fifoEngine/types'
import type { SyntheticPnlSummary } from '@/src/modules/syntheticPnl/types'
import { fmtSignedUsd, fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'
import { MetricCard, toneFromNumber } from './MetricCard'
import { TrendingDownIcon, TrendingUpIcon, WarningIcon } from './Icons'

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

function isUnreliableMagnitude(pnlV2: PnlV2, totalCostBasisUsd: number): boolean {
  const magnitudes = [
    pnlV2.realizedPnlUsd,
    pnlV2.unrealizedPnlUsd,
    totalCostBasisUsd,
    ...pnlV2.chainBreakdown.map((c) => c.realizedPnlUsd),
    ...pnlV2.chainBreakdown.map((c) => c.unrealizedPnlUsd),
  ]
  return magnitudes.some((v) => Math.abs(v) > GUARDRAIL_ABS_LIMIT)
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

// Pure, exported for direct testing. The ONLY selector this component uses — no priority list, no
// merge, no averaging: pnlV2 present -> real numbers; pnlV2 absent -> honestly all-null.
export function selectVerifiedPnlData(
  pnlV2: PnlV2 | null | undefined,
  publicPnlStatus?: PublicPnlStatus | null,
): VerifiedPnlData {
  if (!pnlV2) {
    return {
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
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

  return {
    realizedPnlUsd: pnlV2.realizedPnlUsd,
    unrealizedPnlUsd: pnlV2.unrealizedPnlUsd,
    totalPnlUsd: pnlV2.realizedPnlUsd + pnlV2.unrealizedPnlUsd,
    totalCostBasisUsd,
    roi,
    integritySummary: 'not_available_in_v2_engine',
    unreliable: isUnreliableMagnitude(pnlV2, totalCostBasisUsd),
    stable: isStablePnl({ realizedPnlUsd: pnlV2.realizedPnlUsd, unrealizedPnlUsd: pnlV2.unrealizedPnlUsd, publicPnlStatus }),
  }
}

function ChainBreakdownTable({ chainBreakdown, unreliable }: { chainBreakdown: PnlV2['chainBreakdown']; unreliable: boolean }) {
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
            const rowUnreliable = unreliable && (Math.abs(c.realizedPnlUsd) > GUARDRAIL_ABS_LIMIT || Math.abs(c.unrealizedPnlUsd) > GUARDRAIL_ABS_LIMIT)
            return (
              <tr key={c.chainId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{c.chainId}</td>
                {rowUnreliable ? (
                  <td colSpan={2} style={{ padding: '9px 10px', fontWeight: 700, color: '#fbbf24' }}>Not reliable — sample too incomplete</td>
                ) : (
                  <>
                    <td style={{ padding: '9px 10px', fontWeight: 700, color: c.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(c.realizedPnlUsd)}</td>
                    <td style={{ padding: '9px 10px', fontWeight: 700, color: c.unrealizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(c.unrealizedPnlUsd)}</td>
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

// Pure, exported for direct testing — the exact condition for showing the synthetic block at all.
// Only when the REAL engine's own display is blocked AND real synthetic data exists — never shown
// alongside a real, verified number, never shown from an empty/zero-trade synthetic summary.
export function shouldShowSyntheticPnl(publicPnlStatus: PublicPnlStatus | null | undefined, syntheticPnl: SyntheticPnlSummary | null | undefined): boolean {
  return publicPnlStatus === 'unavailable' && syntheticPnl != null && syntheticPnl.tradeCount > 0
}

function SyntheticPnlBlock({ syntheticPnl }: { syntheticPnl: SyntheticPnlSummary }) {
  const roiDisplay = syntheticPnl.syntheticRoiPct == null
    ? 'No cost-basis evidence'
    : `${syntheticPnl.syntheticRoiPct >= 0 ? '+' : ''}${syntheticPnl.syntheticRoiPct.toFixed(1)}%`

  return (
    <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed rgba(251,191,36,0.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <StatusBadge label="SYNTHETIC · INFERRED · NOT ENGINE VERIFIED" tone="warning" glow />
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.6)' }}>
          {syntheticPnl.tradeCount} inferred trade{syntheticPnl.tradeCount === 1 ? '' : 's'}
          {' '}({syntheticPnl.highConfidenceCount} high / {syntheticPnl.mediumConfidenceCount} medium / {syntheticPnl.lowConfidenceCount} low confidence)
        </span>
      </div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <MetricCard label="Synthetic Realized PnL" value={fmtSignedUsd(syntheticPnl.syntheticRealizedPnlUsd)} tone={toneFromNumber(syntheticPnl.syntheticRealizedPnlUsd)} index={0} />
        <MetricCard label="Synthetic Unrealized PnL" value={fmtSignedUsd(syntheticPnl.syntheticUnrealizedPnlUsd)} tone={toneFromNumber(syntheticPnl.syntheticUnrealizedPnlUsd)} index={1} />
        <MetricCard label="Synthetic Total PnL" value={fmtSignedUsd(syntheticPnl.syntheticTotalPnlUsd)} tone={toneFromNumber(syntheticPnl.syntheticTotalPnlUsd)} index={2} />
        <MetricCard label="Synthetic ROI" value={roiDisplay} tone={toneFromNumber(syntheticPnl.syntheticRoiPct)} index={3} />
      </div>
    </div>
  )
}

export function PnlStatusCard({ pnlV2, publicPnlStatus, syntheticPnl }: PnlStatusCardProps) {
  const pnl = selectVerifiedPnlData(pnlV2, publicPnlStatus)
  const isActive = pnlV2 != null
  const limitedSampleBadgeLabel = shouldShowLimitedSampleBadge(publicPnlStatus)
  const showSyntheticPnl = shouldShowSyntheticPnl(publicPnlStatus, syntheticPnl)
  // BLOCKED, DISCLOSED: `pnl.unreliable` (the pre-existing magnitude heuristic) and
  // `!pnl.stable` (this task's new isStablePnl guard) are two independent reasons to hide the
  // numeric display — either alone is enough. Applies uniformly to Realized/Unrealized/Total/ROI
  // (this task's requirement 4); Cost Basis is a real, always-finite sum of costBasis[] entries
  // with no NaN/Infinity failure mode of its own, so it is not blocked by this guard, only by the
  // separate magnitude heuristic already applied to it below.
  const blocked = isActive && (pnl.unreliable || !pnl.stable)

  const headerIcon = pnl.realizedPnlUsd == null
    ? <WarningIcon size={16} color="#fbbf24" />
    : pnl.realizedPnlUsd >= 0 ? <TrendingUpIcon size={16} color="#4ade80" /> : <TrendingDownIcon size={16} color="#f87171" />

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ display: 'inline-flex' }}>{headerIcon}</span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>PnL (Verified V2)</h3>
        <StatusBadge label={isActive ? 'Active' : 'Unavailable'} tone={isActive ? 'success' : 'neutral'} glow={isActive} />
        {pnl.unreliable && <StatusBadge label="Not reliable (magnitude)" tone="warning" glow />}
        {!pnl.stable && isActive && <StatusBadge label="PnL unavailable" tone="warning" glow />}
        {/* REAL backend classification (fifoEngine's publicPnlStatus, via
            finalSummary.financialStatus.officialPnlStatus) — a SEPARATE signal from the UI-only
            magnitude clamp above; shown whenever it isn't 'ok', regardless of magnitude. */}
        {limitedSampleBadgeLabel && <StatusBadge label={limitedSampleBadgeLabel} tone="warning" />}
      </div>

      {blocked && (
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#fbbf24', margin: '0 0 12px' }}>
          {PNL_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {showSyntheticPnl && syntheticPnl && <SyntheticPnlBlock syntheticPnl={syntheticPnl} />}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <MetricCard label="Realized PnL" value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.realizedPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.realizedPnlUsd)} index={0} />
        <MetricCard label="Unrealized PnL" value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.unrealizedPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.unrealizedPnlUsd)} index={1} />
        <MetricCard label="Total PnL" value={blocked ? PNL_UNAVAILABLE_MESSAGE : fmtSignedUsd(pnl.totalPnlUsd)} tone={blocked ? 'neutral' : toneFromNumber(pnl.totalPnlUsd)} index={2} />
        <MetricCard label="ROI" value={blocked ? PNL_UNAVAILABLE_MESSAGE : pnl.roi.display} tone={blocked ? 'neutral' : toneFromNumber(pnl.roi.value)} index={3} />
        <MetricCard label="Cost Basis" value={pnl.unreliable ? 'Not reliable' : fmtUsd(pnl.totalCostBasisUsd)} index={4} />
        <MetricCard label="Integrity" value={<StatusBadge label="Not available (V2 engine)" tone="neutral" />} index={5} />
      </div>

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Per-Chain Breakdown
        </div>
        <ChainBreakdownTable chainBreakdown={pnlV2?.chainBreakdown ?? []} unreliable={pnl.unreliable || blocked} />
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
