'use client'

// HoldingsViewV2 — premium, sorted, capped-with-expand holdings view. Additive: renders alongside
// (does NOT replace) the existing HoldingsView. Frontend-only redesign — no backend module
// (fifoEngine, pnlSummaryV2, pricingAtTimeEngine, holdings, timelineBuilder, bridgeDetection) is
// touched.
//
// LAYOUT NOTE: previously this rendered every meaningful holding per chain in an unbounded card
// grid — for a wallet with hundreds/thousands of tokens that meant scrolling through everything at
// once. Replaced with HoldingsTable: one list sorted by real USD value descending, capped to the
// top 10 by default with a real "View all N tokens (M more)" expander (same pattern used for the
// dust list) — matches the reference "top balances + view more" pattern.
//
// V2-SAFE GUARD: every prop is typed non-optional by the caller's contract, but that's a
// compile-time guarantee only — every access below still defensively falls back to a safe default.
//
// HONESTY NOTE — real report.holdings (TokenHolding) has `contract` (not `token`), `amount: number`
// (not `string`), and `providerPriceUsd`/`providerValueUsd` (not `usdValueEstimate`). No 24H %
// change column anywhere — no historical intraday pricing feed exists in this codebase. Dust/
// personality/acquisition logic lives in app/frontend/lib/holdingsHeuristics.ts (shared, pure, see
// that file's own honesty notes) — this component is presentation only.
import { useMemo, useState } from 'react'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'
import { derivePersonality, fmtUsd, groupHoldingsByChain, isDust } from '@/app/frontend/lib/holdingsHeuristics'
import { ChainBadge } from './ChainBadge'
import { PersonalityCard } from './PersonalityCard'
import { HoldingsTable } from './HoldingsTable'

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

// Compact, non-collapsible overview strip — real per-chain token count + USD total. Replaces the
// old per-chain sections that each dumped their full holding list (that's what caused the
// unbounded scroll); the actual token list now lives in one sorted HoldingsTable below.
function ChainSummaryStrip({ byChain }: { byChain: Map<string, TokenHolding[]> }) {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
      {[...byChain.entries()].map(([chain, chainHoldings]) => {
        const meaningfulCount = chainHoldings.filter((h) => !isDust(h)).length
        const total = chainHoldings.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0)
        const hasAnyPrice = chainHoldings.some((h) => h.providerValueUsd != null)
        return (
          <div key={chain} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', borderRadius: '999px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <ChainBadge chain={chain} />
            <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
              {meaningfulCount} token(s) · {hasAnyPrice ? fmtUsd(total) : '—'} total
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function HoldingsViewV2({ holdings, buyEntries, bridgeEntries }: HoldingsViewV2Props) {
  const safeHoldings = Array.isArray(holdings) ? holdings : []
  const safeBuyEntries = Array.isArray(buyEntries) ? buyEntries : []
  const safeBridgeEntries = Array.isArray(bridgeEntries) ? bridgeEntries : []

  const [showDust, setShowDust] = useState(false)

  const byChain = useMemo(() => groupHoldingsByChain(safeHoldings), [safeHoldings])
  const meaningfulTokens = useMemo(() => safeHoldings.filter((h) => !isDust(h)), [safeHoldings])
  const dustTokens = useMemo(() => safeHoldings.filter(isDust), [safeHoldings])
  const personality = useMemo(() => derivePersonality(safeHoldings, safeBuyEntries), [safeHoldings, safeBuyEntries])

  return (
    <section>
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Holdings (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Sorted by value · Dust-collapsed · No fabricated USD or 24H data
        </p>
      </div>

      {safeHoldings.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No holdings detected.</p>
      ) : (
        <>
          {personality && <PersonalityCard title="Holdings Personality" label={personality} />}

          <ChainSummaryStrip byChain={byChain} />

          <div style={{ marginBottom: '14px' }}>
            <SectionLabel>Holdings ({meaningfulTokens.length})</SectionLabel>
            <HoldingsTable holdings={meaningfulTokens} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
          </div>

          {dustTokens.length > 0 && (
            <div style={{ borderRadius: '14px', border: '1px dashed rgba(255,255,255,0.10)', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setShowDust((v) => !v)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 16px', background: 'rgba(255,255,255,0.015)', border: 'none', cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(148,163,184,0.70)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
                  Dust tokens ({dustTokens.length}) — {showDust ? 'expanded' : 'collapsed'}
                  {dustTokens.some((h) => h.providerValueUsd != null)
                    ? ` · ${fmtUsd(dustTokens.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0))} total`
                    : ''}
                </span>
                <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.45)' }}>{showDust ? '▾' : '▸'}</span>
              </button>

              {showDust && (
                <div style={{ padding: '14px' }}>
                  <HoldingsTable holdings={dustTokens} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default HoldingsViewV2
