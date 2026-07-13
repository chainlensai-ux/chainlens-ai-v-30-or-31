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
import { fmtSignedUsd, fmtUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'
import { MetricCard, toneFromNumber } from './MetricCard'
import { TrendingDownIcon, TrendingUpIcon, WarningIcon } from './Icons'

export type PnlStatusCardProps = {
  pnlV2: PnlV2 | null | undefined
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
  }
}

function ChainBreakdownTable({ chainBreakdown }: { chainBreakdown: PnlV2['chainBreakdown'] }) {
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
          {chainBreakdown.map((c) => (
            <tr key={c.chainId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{c.chainId}</td>
              <td style={{ padding: '9px 10px', fontWeight: 700, color: c.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(c.realizedPnlUsd)}</td>
              <td style={{ padding: '9px 10px', fontWeight: 700, color: c.unrealizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmtSignedUsd(c.unrealizedPnlUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PnlStatusCard({ pnlV2 }: PnlStatusCardProps) {
  const pnl = selectVerifiedPnlData(pnlV2)
  const isActive = pnlV2 != null

  const headerIcon = pnl.realizedPnlUsd == null
    ? <WarningIcon size={16} color="#fbbf24" />
    : pnl.realizedPnlUsd >= 0 ? <TrendingUpIcon size={16} color="#4ade80" /> : <TrendingDownIcon size={16} color="#f87171" />

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ display: 'inline-flex' }}>{headerIcon}</span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>PnL (Verified V2)</h3>
        <StatusBadge label={isActive ? 'Active' : 'Unavailable'} tone={isActive ? 'success' : 'neutral'} glow={isActive} />
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <MetricCard label="Realized PnL" value={fmtSignedUsd(pnl.realizedPnlUsd)} tone={toneFromNumber(pnl.realizedPnlUsd)} index={0} />
        <MetricCard label="Unrealized PnL" value={fmtSignedUsd(pnl.unrealizedPnlUsd)} tone={toneFromNumber(pnl.unrealizedPnlUsd)} index={1} />
        <MetricCard label="Total PnL" value={fmtSignedUsd(pnl.totalPnlUsd)} tone={toneFromNumber(pnl.totalPnlUsd)} index={2} />
        <MetricCard label="ROI" value={pnl.roi.display} tone={toneFromNumber(pnl.roi.value)} index={3} />
        <MetricCard label="Cost Basis" value={fmtUsd(pnl.totalCostBasisUsd)} index={4} />
        <MetricCard label="Integrity" value={<StatusBadge label="Not available (V2 engine)" tone="neutral" />} index={5} />
      </div>

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Per-Chain Breakdown
        </div>
        <ChainBreakdownTable chainBreakdown={pnlV2?.chainBreakdown ?? []} />
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
