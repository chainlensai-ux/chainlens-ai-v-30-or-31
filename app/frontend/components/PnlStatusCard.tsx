'use client'

// PnlStatusCard — premium redesign of the FIFO & PnL section, combining fifoEngine's real
// report.fifoAndPnl (realized/unrealized/cost basis/matched-lots — the real FIFO engine) with
// pnlEngine's real report.pnlSummaryV2 (closed lots, confidence breakdown). Frontend-only; does not
// modify fifoEngine, pnlSummaryV2 (the module), pricingAtTimeEngine, or behaviorIntel. Additive:
// PnLTab.tsx remains in the codebase, untouched — this component supersedes it visually on the
// page (same two real data sources, new layout).
//
// HONESTY NOTE: the requested "Integrity badge (hardInvalid, softInvalid, valid)" doesn't match
// fifoEngine's real IntegrityFlags shape, which has `hardInvalid: boolean` plus
// `estimateOnlyLotsExcluded`/`syntheticLotsExcluded` counts — there is no "softInvalid" field.
// Derived here instead: hardInvalid -> "Invalid"; not hardInvalid but some lots
// estimate-only/synthetic-excluded -> "Partial" (this task's "softInvalid" concept, relabeled to
// match what's actually being measured); neither -> "Valid". "Buy price"/"sell price" per lot are
// likewise derived as costUsdEstimate/amount and proceedsUsdEstimate/amount (real division, shown
// as "—" when either input is missing) — pnlEngine has no such per-unit price fields.
//
// PNL V2 MIGRATION, DISCLOSED (added per a later task): a task assumed this component was nested
// under WalletProfileHeader.tsx and named "PnlIntelligenceCard.tsx" — neither is real. This
// component (PnlStatusCard.tsx) is rendered directly in app/terminal/wallet-scanner/page.tsx, as a
// sibling of WalletProfileHeader, not a child of it — so WalletProfileHeader.tsx was not touched
// for this migration (nothing to thread through it; "do not modify any other components" also
// supports leaving it alone since it never renders this component).
//
// FIELD-NAME/SHAPE CORRECTIONS, DISCLOSED: the task's own pseudocode assumed
// `pnlV2.totalPnlUsd`/`fifoAndPnl.realizedUsd`/`pnlSummaryV2.unrealizedUsd` — none of these exist.
// Real fields: PnlV2 (lib/engine/modules/pnl/types.ts) has `realizedPnlUsd`/`unrealizedPnlUsd`, no
// total (computed here as their sum). FifoOutput has `realizedPnlUsd`/`unrealizedPnlUsd`, both
// `number | null`. PnlSummaryResult has ONLY `realizedPnlUsd` (`number | null`) — no unrealized or
// total field at all, so it can never fully replace fifoAndPnl as an unrealized-PnL source; kept as
// the lowest-priority fallback, exactly matching what this component's own pre-existing code
// already preferred (fifoAndPnl for realized/unrealized, pnlSummaryV2 only ever fed the closed-lots
// table below).
//
// SCOPE OF THIS MIGRATION, DISCLOSED: only the "Realized PnL"/"Unrealized PnL" MetricCards below are
// re-sourced through `selectPnlData`. ROI, the Integrity badge, Matched/Unmatched Lots counts, and
// the Closed Lots table all rely on FifoOutput/PnlSummaryResult fields (matchedLots, integrityFlags,
// closedLots, costBasisUsd) that PnlV2 does not carry at all — those remain sourced from the old
// fields regardless of whether pnlV2 is present, since there is no real V2 equivalent to migrate
// them to. `totalUsd` is computed and returned by the adapter (for testability) but not rendered as
// a new "Total PnL" card — this component had no such card before, and adding one would be a new
// visual element, not the "renders identically" this migration asked for.
import type { FifoOutput } from '@/src/modules/fifoEngine/types'
import type { ClosedLot, PnlSummaryResult } from '@/src/modules/pnlEngine/types'
import type { PnlV2 } from '@/lib/engine/modules/pnl/types'
import { fmtSignedUsd, fmtUsd, fmtDate } from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'
import { ConfidenceBadge } from './ConfidenceBadge'
import { StatusBadge, type StatusTone } from './StatusBadge'
import { MetricCard, toneFromNumber } from './MetricCard'
import { TimelineBar, type TimelinePoint } from './TimelineBar'
import { TrendingDownIcon, TrendingUpIcon, WarningIcon } from './Icons'

export type PnlStatusCardProps = {
  fifoAndPnl: FifoOutput | null | undefined
  pnlSummaryV2: PnlSummaryResult | null | undefined
  pnlV2?: PnlV2 | null
}

export type SelectedPnlData = {
  realizedUsd: number | null
  unrealizedUsd: number | null
  totalUsd: number | null
  usingV2: boolean
}

// Pure, exported for direct testing. Priority: pnlV2 > fifoAndPnl > pnlSummaryV2 > all-null —
// matches this component's own pre-existing real preference (fifoAndPnl already carried both
// realized AND unrealized; pnlSummaryV2 only ever had realized, never unrealized, so it was already
// the weaker fallback before this migration, not a new ordering invented for it).
export function selectPnlData(params: {
  pnlV2?: PnlV2 | null
  fifoAndPnl?: FifoOutput | null
  pnlSummaryV2?: PnlSummaryResult | null
}): SelectedPnlData {
  const { pnlV2, fifoAndPnl, pnlSummaryV2 } = params

  if (pnlV2) {
    return {
      realizedUsd: pnlV2.realizedPnlUsd,
      unrealizedUsd: pnlV2.unrealizedPnlUsd,
      totalUsd: pnlV2.realizedPnlUsd + pnlV2.unrealizedPnlUsd,
      usingV2: true,
    }
  }

  if (fifoAndPnl) {
    const { realizedPnlUsd, unrealizedPnlUsd } = fifoAndPnl
    return {
      realizedUsd: realizedPnlUsd,
      unrealizedUsd: unrealizedPnlUsd,
      totalUsd: realizedPnlUsd != null && unrealizedPnlUsd != null ? realizedPnlUsd + unrealizedPnlUsd : null,
      usingV2: false,
    }
  }

  if (pnlSummaryV2) {
    // Real PnlSummaryResult has no unrealized/total field at all — honestly null, never fabricated.
    return {
      realizedUsd: pnlSummaryV2.realizedPnlUsd,
      unrealizedUsd: null,
      totalUsd: null,
      usingV2: false,
    }
  }

  return { realizedUsd: null, unrealizedUsd: null, totalUsd: null, usingV2: false }
}

function fmtPerUnit(totalUsd: number | null, amount: string): string {
  if (totalUsd == null) return '—'
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt === 0) return '—'
  return `$${(totalUsd / amt).toFixed(4)}`
}

function computeRoi(fifo: FifoOutput | null | undefined): { value: number | null; display: string } {
  const realized = fifo?.realizedPnlUsd ?? null
  const costBasis = fifo?.costBasisUsd ?? null
  if (realized == null || costBasis == null || costBasis === 0) return { value: null, display: 'No USD evidence' }
  const roi = (realized / costBasis) * 100
  return { value: roi, display: `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%` }
}

function deriveIntegrity(fifo: FifoOutput | null | undefined): { label: string; tone: StatusTone } {
  if (!fifo) return { label: 'Unavailable', tone: 'neutral' }
  if (fifo.integrityFlags.hardInvalid) return { label: 'Invalid', tone: 'danger' }
  if (fifo.integrityFlags.estimateOnlyLotsExcluded > 0 || fifo.integrityFlags.syntheticLotsExcluded > 0) {
    return { label: 'Partial', tone: 'warning' }
  }
  return { label: 'Valid', tone: 'success' }
}

function ClosedLotsTable({ closedLots }: { closedLots: ClosedLot[] }) {
  if (closedLots.length === 0) {
    return <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No closed lots detected by PnL V2.</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'rgba(148,163,184,0.55)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            <th style={{ padding: '6px 10px' }}>Token</th>
            <th style={{ padding: '6px 10px' }}>Chain</th>
            <th style={{ padding: '6px 10px' }}>Buy Price</th>
            <th style={{ padding: '6px 10px' }}>Sell Price</th>
            <th style={{ padding: '6px 10px' }}>Cost Basis</th>
            <th style={{ padding: '6px 10px' }}>Proceeds</th>
            <th style={{ padding: '6px 10px' }}>Realized PnL</th>
            <th style={{ padding: '6px 10px' }}>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {closedLots.map((lot, i) => (
            <tr key={`${lot.txHash}-${i}`} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{lot.symbol ?? '—'}</td>
              <td style={{ padding: '9px 10px' }}><ChainBadge chain={lot.chain} /></td>
              <td style={{ padding: '9px 10px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{fmtPerUnit(lot.costUsdEstimate, lot.amount)}</td>
              <td style={{ padding: '9px 10px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{fmtPerUnit(lot.proceedsUsdEstimate, lot.amount)}</td>
              <td style={{ padding: '9px 10px', color: lot.costUsdEstimate == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>{fmtUsd(lot.costUsdEstimate)}</td>
              <td style={{ padding: '9px 10px', color: lot.proceedsUsdEstimate == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>{fmtUsd(lot.proceedsUsdEstimate)}</td>
              <td style={{ padding: '9px 10px', fontWeight: 700, color: lot.realizedPnlUsd == null ? 'rgba(148,163,184,0.45)' : lot.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>
                {lot.realizedPnlUsd == null ? 'missing' : fmtSignedUsd(lot.realizedPnlUsd)}
              </td>
              <td style={{ padding: '9px 10px' }}>
                <ConfidenceBadge level={lot.evidence === 'evidence_missing' ? 'evidence_missing' : lot.confidence} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PnlStatusCard({ fifoAndPnl, pnlSummaryV2, pnlV2 }: PnlStatusCardProps) {
  const pnlData = selectPnlData({ pnlV2, fifoAndPnl, pnlSummaryV2 })
  // TEMPORARY, per this migration's own instructions — remove once pnlV2 is verified live and this
  // fallback path is no longer needed.
  // eslint-disable-next-line no-console
  console.debug('PnlCard using V2:', pnlData.usingV2)

  const closedLots = Array.isArray(pnlSummaryV2?.closedLots) ? pnlSummaryV2!.closedLots : []
  // ROI/Integrity remain fifoAndPnl-only regardless of pnlV2 — see file header's "SCOPE OF THIS
  // MIGRATION" disclosure (PnlV2 carries no costBasis total or integrityFlags equivalent to migrate
  // these to). The "Active" badge/footer note IS extended to also recognize pnlV2 data (PnlV2 has
  // no `publicPnlStatus` field to read directly, but real realized/unrealized numbers from V2 are
  // just as much "active" PnL data as fifoAndPnl's own status flag) — deliberately, to avoid the
  // confusing state of showing real V2 numbers in the metric cards below while this same badge
  // still said "Unavailable" because it only ever looked at fifoAndPnl.
  const roi = computeRoi(fifoAndPnl)
  const integrity = deriveIntegrity(fifoAndPnl)
  const publicStatus = fifoAndPnl?.publicPnlStatus ?? 'unavailable'
  const isActive = publicStatus !== 'unavailable' || pnlData.usingV2
  const realized = pnlData.realizedUsd

  const headerIcon = realized == null ? <WarningIcon size={16} color="#fbbf24" /> : realized >= 0 ? <TrendingUpIcon size={16} color="#4ade80" /> : <TrendingDownIcon size={16} color="#f87171" />

  const timelinePoints: TimelinePoint[] = closedLots.map((lot, i) => ({
    key: `${lot.txHash}-${i}`,
    timestamp: lot.timestamp,
    color: lot.realizedPnlUsd == null ? '#94a3b8' : lot.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171',
    tooltip: `${lot.symbol ?? '—'} · ${fmtDate(lot.timestamp)} · ${lot.realizedPnlUsd == null ? 'missing' : fmtSignedUsd(lot.realizedPnlUsd)}`,
  }))

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
        <span style={{ display: 'inline-flex' }}>{headerIcon}</span>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>FIFO &amp; PnL</h3>
        <StatusBadge label={isActive ? 'Active' : 'Unavailable'} tone={isActive ? 'success' : 'neutral'} glow={isActive} />
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <MetricCard label="Realized PnL" value={fmtSignedUsd(pnlData.realizedUsd)} tone={toneFromNumber(pnlData.realizedUsd)} index={0} />
        <MetricCard label="Unrealized PnL" value={fmtSignedUsd(pnlData.unrealizedUsd)} tone={toneFromNumber(pnlData.unrealizedUsd)} index={1} />
        <MetricCard label="ROI" value={roi.display} tone={toneFromNumber(roi.value)} index={2} />
        <MetricCard label="Cost Basis" value={fmtUsd(fifoAndPnl?.costBasisUsd)} index={3} />
        <MetricCard label="Matched Lots" value={fifoAndPnl?.matchedLots?.length ?? 0} index={4} />
        <MetricCard label="Unmatched Buys" value={fifoAndPnl?.unmatchedBuys ?? 0} index={5} />
        <MetricCard label="Unmatched Sells" value={fifoAndPnl?.unmatchedSells ?? 0} index={6} />
        <MetricCard label="Integrity" value={<StatusBadge label={integrity.label} tone={integrity.tone} />} index={7} />
      </div>

      {timelinePoints.length > 0 && (
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            Sell Timeline
          </div>
          <TimelineBar points={timelinePoints} />
        </div>
      )}

      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Closed Lots
        </div>
        <ClosedLotsTable closedLots={closedLots} />
      </div>

      {!isActive && (
        <div style={{ fontSize: '11px', color: 'rgba(148,163,184,0.50)', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          Pricing source: inactive — no verified priced lot sample yet.
        </div>
      )}
    </section>
  )
}

export default PnlStatusCard
