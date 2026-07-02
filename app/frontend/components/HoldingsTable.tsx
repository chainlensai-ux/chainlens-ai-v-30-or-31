// Compact, sorted holdings table with a "View all N tokens (M more)" expander — replaces an
// unbounded per-chain card dump so a wallet with hundreds/thousands of meaningful tokens doesn't
// force endless scrolling. Row layout: symbol + chain badge (left), balance (center), USD value
// (right), acquisition badges + first-seen underneath.
//
// HONESTY NOTE: no 24H % change column — there is no historical intraday pricing feed anywhere in
// this codebase (holdings only ever carries a single current providerPriceUsd/providerValueUsd
// snapshot), so a 24H change figure would have to be fabricated. Not added.
import { useState } from 'react'
import { motion } from 'framer-motion'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'
import { deriveAcquisitionInfo, fmtAmount, fmtUsd, holdingKey } from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'

const DEFAULT_VISIBLE_COUNT = 10

export type HoldingsTableProps = {
  holdings: TokenHolding[]
  buyEntries: BuyTimelineEntry[]
  bridgeEntries: BridgeCandidateEvent[]
  initialVisibleCount?: number
}

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (index: number) => ({ opacity: 1, y: 0, transition: { duration: 0.22, delay: Math.min(index, 20) * 0.03 } }),
}

function HoldingRow({ holding, buyEntries, bridgeEntries, index }: { holding: TokenHolding; buyEntries: BuyTimelineEntry[]; bridgeEntries: BridgeCandidateEvent[]; index: number }) {
  const acquisition = deriveAcquisitionInfo(holding, buyEntries, bridgeEntries)

  return (
    <motion.div
      custom={index}
      variants={rowVariants}
      initial="hidden"
      animate="visible"
      whileHover={{ background: 'rgba(255,255,255,0.03)' }}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '12px 14px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 800, color: '#e2e8f0' }}>{holding.symbol || '—'}</span>
          <ChainBadge chain={holding.chain} />
        </div>
        <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)', marginTop: '2px' }}>
          {holding.name ?? `${holding.contract.slice(0, 6)}…${holding.contract.slice(-4)}`}
        </div>
        {acquisition.badges.length > 0 && (
          <div style={{ display: 'flex', gap: '5px', marginTop: '5px', flexWrap: 'wrap' }}>
            {acquisition.badges.map((b) => (
              <span key={b} style={{ padding: '1px 8px', borderRadius: '999px', fontSize: '8px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.28)', color: '#38bdf8' }}>
                {b}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ minWidth: '110px', textAlign: 'right', fontSize: '13px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {fmtAmount(holding.amount)}
      </div>

      <div style={{ minWidth: '110px', textAlign: 'right', fontSize: '14px', fontWeight: 800, color: holding.providerValueUsd == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>
        {fmtUsd(holding.providerValueUsd)}
      </div>
    </motion.div>
  )
}

export function HoldingsTable({ holdings, buyEntries, bridgeEntries, initialVisibleCount = DEFAULT_VISIBLE_COUNT }: HoldingsTableProps) {
  const [expanded, setExpanded] = useState(false)

  const sorted = [...holdings].sort((a, b) => {
    const av = a.providerValueUsd ?? -1
    const bv = b.providerValueUsd ?? -1
    return bv - av
  })

  const visible = expanded ? sorted : sorted.slice(0, initialVisibleCount)
  const remaining = sorted.length - visible.length

  if (sorted.length === 0) {
    return <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.45)', margin: 0 }}>No meaningful positions.</p>
  }

  return (
    <div style={{ borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '9px 14px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        <span style={{ flex: '1 1 200px' }}>Token</span>
        <span style={{ minWidth: '110px', textAlign: 'right' }}>Balance</span>
        <span style={{ minWidth: '110px', textAlign: 'right' }}>Value USD</span>
      </div>

      {visible.map((h, i) => (
        <HoldingRow key={holdingKey(h)} holding={h} buyEntries={buyEntries} bridgeEntries={bridgeEntries} index={i} />
      ))}

      {sorted.length > initialVisibleCount && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            width: '100%', textAlign: 'center', padding: '11px', fontSize: '11px', fontWeight: 700,
            color: '#2DD4BF', background: 'rgba(45,212,191,0.04)', border: 'none',
            borderTop: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer',
            fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
          }}
        >
          {expanded ? 'Show fewer' : `View all ${sorted.length} tokens (${remaining} more)`} {expanded ? '▴' : '▾'}
        </button>
      )}
    </div>
  )
}

export default HoldingsTable
