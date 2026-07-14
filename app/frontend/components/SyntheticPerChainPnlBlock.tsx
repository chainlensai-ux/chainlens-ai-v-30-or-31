'use client'

// SyntheticPerChainPnlBlock — pure display component for src/modules/syntheticPnl's per-chain
// breakdown. No engine calls, no pricing calls, no network of any kind. Rendered by
// PnlStatusCard.tsx ONLY as a fallback when the GLOBAL synthetic summary has no usable totals but
// at least one chain's own figures do (see PnlStatusCard's hasPerChainSynthetic) — never alongside
// a real, verified pnlV2 number, never alongside the global SyntheticPnlBlock at the same time.
import type { SyntheticChainPnl } from '@/src/modules/syntheticPnl/types'
import { fmtSignedUsd } from '@/app/frontend/lib/holdingsHeuristics'
import { StatusBadge } from './StatusBadge'

function fmtRoi(roiPercent: number | null): string {
  if (roiPercent == null) return 'No cost-basis evidence'
  return `${roiPercent >= 0 ? '+' : ''}${roiPercent.toFixed(1)}%`
}

export function SyntheticPerChainPnlBlock({ perChain }: { perChain: SyntheticChainPnl[] }) {
  const rows = perChain.filter((c) => c.totalPnlUsd !== null || c.realizedPnlUsd !== null || c.unrealizedPnlUsd !== null)

  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <StatusBadge label="SYNTHETIC · PER-CHAIN · NOT ENGINE VERIFIED" tone="warning" glow />
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.6)' }}>
          No reliable wallet-wide total — showing per-chain estimates where evidence exists
        </span>
      </div>

      {rows.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No per-chain synthetic PnL evidence available.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'rgba(148,163,184,0.55)', fontSize: '9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                <th style={{ padding: '6px 10px' }}>Chain</th>
                <th style={{ padding: '6px 10px' }}>Synthetic Realized PnL</th>
                <th style={{ padding: '6px 10px' }}>Synthetic Unrealized PnL</th>
                <th style={{ padding: '6px 10px' }}>Synthetic Total PnL</th>
                <th style={{ padding: '6px 10px' }}>Synthetic ROI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.chainId} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{c.chainId}</td>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: (c.realizedPnlUsd ?? 0) >= 0 ? '#4ade80' : '#f87171' }}>
                    {c.realizedPnlUsd == null ? 'No evidence' : fmtSignedUsd(c.realizedPnlUsd)}
                  </td>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: (c.unrealizedPnlUsd ?? 0) >= 0 ? '#4ade80' : '#f87171' }}>
                    {c.unrealizedPnlUsd == null ? 'No evidence' : fmtSignedUsd(c.unrealizedPnlUsd)}
                  </td>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: (c.totalPnlUsd ?? 0) >= 0 ? '#4ade80' : '#f87171' }}>
                    {c.totalPnlUsd == null ? 'No evidence' : fmtSignedUsd(c.totalPnlUsd)}
                  </td>
                  <td style={{ padding: '9px 10px', fontWeight: 700, color: '#e2e8f0' }}>{fmtRoi(c.roiPercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default SyntheticPerChainPnlBlock
