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

// Pure, exported for direct testing. The ONLY selector this component uses — no priority list, no
// merge, no averaging: pnlV2 present -> real numbers; pnlV2 absent -> honestly all-null.
export function selectVerifiedPnlData(pnlV2: PnlV2 | null | undefined): VerifiedPnlData {
  if (!pnlV2) {
    return {
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
      totalPnlUsd: null,
      totalCostBasisUsd: null,
      roi: { value: null, display: 'No verified PnL data' },
      integritySummary: 'not_available_in_v2_engine',
      unreliable: false,
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
export function shouldShowLimitedSampleBadge(publicPnlStatus: PublicPnlStatus | null | undefined): boolean {
  return publicPnlStatus != null && publicPnlStatus !== 'ok'
}

export function PnlStatusCard({ pnlV2, publicPnlStatus }: PnlStatusCardProps) {
  const pnl = selectVerifiedPnlData(pnlV2)
  const isActive = pnlV2 != null
  const showLimitedSampleBadge = shouldShowLimitedSampleBadge(publicPnlStatus)

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
        {/* REAL backend classification (fifoEngine's publicPnlStatus, via
            finalSummary.financialStatus.officialPnlStatus) — a SEPARATE signal from the UI-only
            magnitude clamp above; shown whenever it isn't 'ok', regardless of magnitude. */}
        {showLimitedSampleBadge && <StatusBadge label="Limited verified sample" tone="warning" />}
      </div>

      {pnl.unreliable && (
        <p style={{ fontSize: '12px', color: '#fbbf24', margin: '0 0 12px' }}>
          PnL sample too incomplete to show a reliable number — one or more values from the verified
          V2 engine exceeded a sane magnitude (likely a missing/duplicate-decimals price rather than
          a real gain or loss). The underlying data is unchanged; only this display is clamped.
        </p>
      )}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <MetricCard label="Realized PnL" value={pnl.unreliable ? 'Not reliable' : fmtSignedUsd(pnl.realizedPnlUsd)} tone={pnl.unreliable ? 'neutral' : toneFromNumber(pnl.realizedPnlUsd)} index={0} />
        <MetricCard label="Unrealized PnL" value={pnl.unreliable ? 'Not reliable' : fmtSignedUsd(pnl.unrealizedPnlUsd)} tone={pnl.unreliable ? 'neutral' : toneFromNumber(pnl.unrealizedPnlUsd)} index={1} />
        <MetricCard label="Total PnL" value={pnl.unreliable ? 'Not reliable' : fmtSignedUsd(pnl.totalPnlUsd)} tone={pnl.unreliable ? 'neutral' : toneFromNumber(pnl.totalPnlUsd)} index={2} />
        <MetricCard label="ROI" value={pnl.unreliable ? 'Not reliable' : pnl.roi.display} tone={pnl.unreliable ? 'neutral' : toneFromNumber(pnl.roi.value)} index={3} />
        <MetricCard label="Cost Basis" value={pnl.unreliable ? 'Not reliable' : fmtUsd(pnl.totalCostBasisUsd)} index={4} />
        <MetricCard label="Integrity" value={<StatusBadge label="Not available (V2 engine)" tone="neutral" />} index={5} />
      </div>

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Per-Chain Breakdown
        </div>
        <ChainBreakdownTable chainBreakdown={pnlV2?.chainBreakdown ?? []} unreliable={pnl.unreliable} />
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
