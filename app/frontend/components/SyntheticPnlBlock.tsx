'use client'

// SyntheticPnlBlock — pure display component for src/modules/syntheticPnl's UI-only, inferred PnL
// read model. No engine calls, no pricing calls, no network of any kind — renders exactly the
// SyntheticPnlSummary object it's given. Extracted from PnlStatusCard.tsx into its own file per
// this task's own request; behavior unchanged from the inline version.
//
// UI-DISPLAY-ONLY, DISCLOSED: this block is rendered ONLY as a replacement for PnlStatusCard's own
// "PnL unavailable" state (see that file's shouldShowSyntheticPnl) — never alongside, never
// overlaid on top of, a real verified pnlV2 number. See src/modules/syntheticPnl/index.ts's own
// header for the full reasoning on why this data is "synthetic" (a weighted-average-cost
// approximation over inferred router-mediated trades) rather than engine-verified.
import type { SyntheticPnlSummary } from '@/src/modules/syntheticPnl/types'
import { fmtSignedUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'
import { MetricCard, toneFromNumber } from './MetricCard'

export function SyntheticPnlBlock({ syntheticPnl }: { syntheticPnl: SyntheticPnlSummary }) {
  const roiDisplay = syntheticPnl.syntheticRoiPct == null
    ? 'No cost-basis evidence'
    : `${syntheticPnl.syntheticRoiPct >= 0 ? '+' : ''}${syntheticPnl.syntheticRoiPct.toFixed(1)}%`

  return (
    <div style={{ marginBottom: '16px' }}>
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

export default SyntheticPnlBlock
