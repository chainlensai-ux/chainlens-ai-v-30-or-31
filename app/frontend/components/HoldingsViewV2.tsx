'use client'

// HoldingsViewV2 — premium, card-based, chain-grouped, dust-collapsed holdings view. Additive:
// renders alongside (does NOT replace) the existing HoldingsView. Frontend-only redesign — no
// backend module (fifoEngine, pnlSummaryV2, pricingAtTimeEngine, holdings, timelineBuilder,
// bridgeDetection) is touched.
//
// V2-SAFE GUARD: every prop is typed non-optional by the caller's contract, but that's a
// compile-time guarantee only — every access below still defensively falls back to a safe default.
//
// HONESTY NOTE — real report.holdings (TokenHolding) has `contract` (not `token`), `amount: number`
// (not `string`), and `providerPriceUsd`/`providerValueUsd` (not `usdValueEstimate`). Dust/
// personality/acquisition logic lives in app/frontend/lib/holdingsHeuristics.ts (shared, pure, see
// that file's own honesty notes) — this component is presentation only.
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'
import {
  TOP_HOLDING_USD_THRESHOLD,
  deriveAcquisitionInfo,
  derivePersonality,
  fmtUsd,
  groupHoldingsByChain,
  holdingKey,
  isDust,
} from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'
import { PersonalityCard } from './PersonalityCard'
import { TokenCard } from './TokenCard'

export type HoldingsViewV2Props = {
  holdings: TokenHolding[] | null | undefined
  buyEntries?: BuyTimelineEntry[] | null
  bridgeEntries?: BridgeCandidateEvent[] | null
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
      {children}
    </div>
  )
}

function TopHoldingsSection({ holdings, buyEntries, bridgeEntries }: { holdings: TokenHolding[]; buyEntries: BuyTimelineEntry[]; bridgeEntries: BridgeCandidateEvent[] }) {
  const top = holdings
    .filter((h) => h.providerValueUsd != null && h.providerValueUsd > TOP_HOLDING_USD_THRESHOLD)
    .sort((a, b) => (b.providerValueUsd ?? 0) - (a.providerValueUsd ?? 0))

  if (top.length === 0) return null

  return (
    <div style={{ marginBottom: '18px' }}>
      <SectionLabel>Top Holdings</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
        {top.map((h, i) => (
          <TokenCard key={holdingKey(h)} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
        ))}
      </div>
    </div>
  )
}

function ChainSection({
  chain,
  holdings,
  buyEntries,
  bridgeEntries,
}: {
  chain: string
  holdings: TokenHolding[]
  buyEntries: BuyTimelineEntry[]
  bridgeEntries: BridgeCandidateEvent[]
}) {
  const [sectionOpen, setSectionOpen] = useState(true)
  const meaningful = holdings.filter((h) => !isDust(h))
  const chainTotalUsd = holdings.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0)
  const hasAnyPrice = holdings.some((h) => h.providerValueUsd != null)

  return (
    <div style={{ borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setSectionOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: 'rgba(139,92,246,0.06)', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ChainBadge chain={chain} />
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
            {meaningful.length} token(s) · {hasAnyPrice ? fmtUsd(chainTotalUsd) : '—'} total
          </span>
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>{sectionOpen ? '▾' : '▸'}</span>
      </button>

      <AnimatePresence>
        {sectionOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px' }}>
              {meaningful.length === 0 ? (
                <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.45)', margin: 0 }}>No meaningful positions on this chain.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
                  {meaningful.map((h, i) => (
                    <TokenCard key={holdingKey(h)} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DustSummaryRow({
  dust,
  showDust,
  setShowDust,
  buyEntries,
  bridgeEntries,
}: {
  dust: TokenHolding[]
  showDust: boolean
  setShowDust: (v: boolean) => void
  buyEntries: BuyTimelineEntry[]
  bridgeEntries: BridgeCandidateEvent[]
}) {
  if (dust.length === 0) return null

  const dustTotalUsd = dust.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0)
  const hasAnyPrice = dust.some((h) => h.providerValueUsd != null)

  return (
    <div style={{ borderRadius: '14px', border: '1px dashed rgba(255,255,255,0.10)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setShowDust(!showDust)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 16px', background: 'rgba(255,255,255,0.015)', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(148,163,184,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Dust tokens ({dust.length}) — {showDust ? 'expanded' : 'collapsed'}
          {hasAnyPrice ? ` · ${fmtUsd(dustTotalUsd)} total` : ''}
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.45)' }}>{showDust ? '▾' : '▸'}</span>
      </button>

      <AnimatePresence>
        {showDust && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
            <div style={{ padding: '14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }}>
              {dust.map((h, i) => (
                <TokenCard key={holdingKey(h)} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function HoldingsViewV2({ holdings, buyEntries, bridgeEntries }: HoldingsViewV2Props) {
  const safeHoldings = Array.isArray(holdings) ? holdings : []
  const safeBuyEntries = Array.isArray(buyEntries) ? buyEntries : []
  const safeBridgeEntries = Array.isArray(bridgeEntries) ? bridgeEntries : []

  const [showDust, setShowDust] = useState(false)

  const byChain = useMemo(() => groupHoldingsByChain(safeHoldings), [safeHoldings])
  const dustTokens = useMemo(() => safeHoldings.filter(isDust), [safeHoldings])
  const personality = useMemo(() => derivePersonality(safeHoldings, safeBuyEntries), [safeHoldings, safeBuyEntries])

  return (
    <section>
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Holdings (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Chain-grouped · Dust-collapsed · No fabricated USD or rotation data
        </p>
      </div>

      {safeHoldings.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No holdings detected.</p>
      ) : (
        <>
          {personality && <PersonalityCard title="Holdings Personality" label={personality} />}
          <TopHoldingsSection holdings={safeHoldings} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[...byChain.entries()].map(([chain, chainHoldings]) => (
              <ChainSection key={chain} chain={chain} holdings={chainHoldings} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
            ))}

            <DustSummaryRow dust={dustTokens} showDust={showDust} setShowDust={setShowDust} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
          </div>
        </>
      )}
    </section>
  )
}

export default HoldingsViewV2
