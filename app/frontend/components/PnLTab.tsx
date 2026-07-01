'use client'

// PnLTab — premium, consolidated PnL view combining fifoEngine's real report.fifoAndPnl (realized/
// unrealized/cost basis — the real FIFO engine) with pnlEngine's real report.pnlSummaryV2 (closed
// lots + confidence breakdown). Frontend-only redesign — does NOT modify fifoEngine, pnlSummaryV2
// (the module), pricingAtTimeEngine, or behaviorIntel. Additive: FifoAndPnlView and
// PnlSummaryV2View remain in the codebase, untouched; this component is a new, consolidated visual
// layer over the same two real data sources.
//
// HONESTY NOTE — "buy price"/"sell price" per the requested Closed Lots Table columns don't exist
// as fields anywhere (ClosedLot has costUsdEstimate/proceedsUsdEstimate totals, not per-unit
// prices). Buy/sell price-per-unit are derived here as costUsdEstimate/amount and
// proceedsUsdEstimate/amount — a real division of two real numbers, shown as "—" whenever either
// input is null/zero, never guessed. ROI is realizedPnlUsd / costBasisUsd from the real fifoAndPnl
// object, shown as "No USD evidence" when either is null or costBasisUsd is 0.
import { useState } from 'react'
import { motion } from 'framer-motion'
import type { FifoOutput } from '@/src/modules/fifoEngine/types'
import type { ClosedLot, PnlSummaryResult } from '@/src/modules/pnlEngine/types'
import { fmtSignedUsd, fmtUsd, fmtDate } from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'
import { ConfidenceBadge } from './ConfidenceBadge'
import { PnLHeaderCard, toneFromValue } from './PnLHeaderCard'

export type PnLTabProps = {
  fifoAndPnl: FifoOutput | null | undefined
  pnlSummaryV2: PnlSummaryResult | null | undefined
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
            <motion.tr
              key={`${lot.txHash}-${i}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 20) * 0.03 }}
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
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
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SellTimelineVisual({ closedLots }: { closedLots: ClosedLot[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  if (closedLots.length === 0) return null

  const timestamps = closedLots.map((l) => l.timestamp)
  const minTs = Math.min(...timestamps)
  const maxTs = Math.max(...timestamps)
  const span = maxTs - minTs || 1

  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '10px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        Sell Timeline
      </div>
      <div style={{ position: 'relative', height: '48px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ position: 'absolute', left: '4%', right: '4%', top: '50%', height: '1px', background: 'rgba(255,255,255,0.10)' }} />
        {closedLots.map((lot, i) => {
          const pct = 4 + ((lot.timestamp - minTs) / span) * 92
          const color = lot.realizedPnlUsd == null ? '#94a3b8' : lot.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171'
          return (
            <motion.div
              key={`${lot.txHash}-${i}`}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.2, delay: Math.min(i, 20) * 0.03 }}
              whileHover={{ scale: 1.4 }}
              onMouseEnter={() => setHoverIndex(i)}
              onMouseLeave={() => setHoverIndex((cur) => (cur === i ? null : cur))}
              style={{
                position: 'absolute', left: `${pct}%`, top: '50%', width: '10px', height: '10px',
                borderRadius: '999px', background: color, transform: 'translate(-50%, -50%)', cursor: 'pointer',
                boxShadow: `0 0 8px ${color}80`,
              }}
            />
          )
        })}
        {hoverIndex != null && closedLots[hoverIndex] && (
          <div
            style={{
              position: 'absolute', bottom: '54px',
              left: `${4 + ((closedLots[hoverIndex].timestamp - minTs) / span) * 92}%`,
              transform: 'translateX(-50%)', padding: '8px 10px', borderRadius: '9px',
              background: '#0b1220', border: '1px solid rgba(255,255,255,0.12)', fontSize: '11px',
              color: '#e2e8f0', whiteSpace: 'nowrap', zIndex: 10,
            }}
          >
            {closedLots[hoverIndex].symbol ?? '—'} · {fmtDate(closedLots[hoverIndex].timestamp)} · {closedLots[hoverIndex].realizedPnlUsd == null ? 'missing' : fmtSignedUsd(closedLots[hoverIndex].realizedPnlUsd)}
          </div>
        )}
      </div>
    </div>
  )
}

function ConfidenceIndicators({ pnl }: { pnl: PnlSummaryResult }) {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '18px' }}>
      <ConfidenceBadge level="high" label={`${pnl.confidenceBasis.high} high`} />
      <ConfidenceBadge level="medium" label={`${pnl.confidenceBasis.medium} medium`} />
      <ConfidenceBadge level="low" label={`${pnl.confidenceBasis.low} low`} />
      <ConfidenceBadge level="evidence_missing" label={`${pnl.evidenceMissingCount} missing evidence`} />
    </div>
  )
}

export function PnLTab({ fifoAndPnl, pnlSummaryV2 }: PnLTabProps) {
  const closedLots = Array.isArray(pnlSummaryV2?.closedLots) ? pnlSummaryV2!.closedLots : []
  const roi = computeRoi(fifoAndPnl)

  return (
    <section>
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          FIFO / PnL
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Real FIFO engine + real closed-lot evidence · No fabricated USD values
        </p>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
        <PnLHeaderCard label="Realized PnL" value={fmtSignedUsd(fifoAndPnl?.realizedPnlUsd ?? null)} tone={toneFromValue(fifoAndPnl?.realizedPnlUsd)} index={0} />
        <PnLHeaderCard label="Unrealized PnL" value={fmtSignedUsd(fifoAndPnl?.unrealizedPnlUsd ?? null)} tone={toneFromValue(fifoAndPnl?.unrealizedPnlUsd)} index={1} />
        <PnLHeaderCard label="ROI" value={roi.display} tone={toneFromValue(roi.value)} index={2} />
      </div>

      {pnlSummaryV2 && <ConfidenceIndicators pnl={pnlSummaryV2} />}

      <SellTimelineVisual closedLots={closedLots} />

      <div>
        <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Closed Lots
        </div>
        <ClosedLotsTable closedLots={closedLots} />
      </div>
    </section>
  )
}

export default PnLTab
