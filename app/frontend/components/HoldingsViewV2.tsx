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
import type { PricedHolding } from '@/lib/engine/modules/pricing/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'
import { derivePersonality, fmtUsd, groupHoldingsByChain } from '@/app/frontend/lib/holdingsHeuristics'
import { selectHoldingsV2 } from '@/app/frontend/lib/holdingsV2Selector'
import { ChainBadge } from './ChainBadge'
import { PersonalityCard } from './PersonalityCard'
import { HoldingsTable } from './HoldingsTable'

// CANONICAL DATA SOURCE, DISCLOSED (Holdings V2 display consistency fix — see
// app/frontend/lib/holdingsV2Selector.ts's own header for the confirmed regression this closes):
// this component now receives the SAME canonical `pricedHoldings`/`chainValueUsd` that
// `portfolioV2.totalValueUsd` is built from — never the old, separately-fetched `holdings:
// TokenHolding[]` this component previously read, which could (and did, in production) disagree
// with the canonical total for the same scan.
export type HoldingsViewV2Props = {
  pricedHoldings: PricedHolding[] | null | undefined
  chainValueUsd: Record<number, number> | null | undefined
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

// Compact, non-collapsible overview strip — real per-chain token count + CANONICAL USD total (the
// same `chainValueUsd` portfolioV2.totalValueUsd is built from — see this file's own header). Token
// COUNT is still derived from the display rows (a presentation-only figure), but the $ total is
// never recomputed from a filtered/display subset — that recomputation is exactly how the confirmed
// production regression happened (Base showing $337.62 instead of the real ~$3,342).
function ChainSummaryStrip({
  chainCounts,
  chainGroupedValueUsd,
}: {
  chainCounts: Map<string, number>
  chainGroupedValueUsd: Record<number, number>
}) {
  const CHAIN_STRING_TO_ID: Record<string, number> = { eth: 1, base: 8453, arbitrum: 42161, hyperevm: 999 }
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
      {[...chainCounts.entries()].map(([chain, count]) => {
        const chainId = CHAIN_STRING_TO_ID[chain]
        const total = chainId != null ? chainGroupedValueUsd[chainId] ?? null : null
        return (
          <div key={chain} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', borderRadius: '999px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <ChainBadge chain={chain} />
            <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>
              {count} token(s) · {total != null ? fmtUsd(total) : '—'} total
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function HoldingsViewV2({ pricedHoldings, chainValueUsd, buyEntries, bridgeEntries }: HoldingsViewV2Props) {
  const safeBuyEntries = Array.isArray(buyEntries) ? buyEntries : []
  const safeBridgeEntries = Array.isArray(bridgeEntries) ? bridgeEntries : []

  const [showDust, setShowDust] = useState(false)

  // CANONICAL SELECTOR, DISCLOSED: the ONE source every number below derives from — see
  // app/frontend/lib/holdingsV2Selector.ts's own header for the confirmed regression this closes.
  const selection = useMemo(() => selectHoldingsV2(pricedHoldings, chainValueUsd), [pricedHoldings, chainValueUsd])
  const { meaningfulHoldings, dustHoldings, diagnostics } = selection
  const allDisplayed = useMemo(() => [...meaningfulHoldings, ...dustHoldings], [meaningfulHoldings, dustHoldings])
  const zeroOrUnpricedCount = diagnostics.excludedPricedHoldings.length
  const totalConsidered = allDisplayed.length + zeroOrUnpricedCount

  const chainCounts = useMemo(() => {
    const byChain = groupHoldingsByChain(allDisplayed)
    return new Map([...byChain.entries()].map(([chain, rows]) => [chain, rows.length]))
  }, [allDisplayed])
  const personality = useMemo(() => derivePersonality(allDisplayed, safeBuyEntries), [allDisplayed, safeBuyEntries])

  return (
    <section>
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Holdings (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Sorted by value · Zero/unpriced hidden · Dust-collapsed · No fabricated USD or 24H data
        </p>
      </div>

      {totalConsidered === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No holdings detected.</p>
      ) : allDisplayed.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>
          {totalConsidered} token(s) detected, all with no known USD value — hidden. No priced holdings to show.
        </p>
      ) : (
        <>
          {zeroOrUnpricedCount > 0 && (
            <p style={{ fontSize: '10px', color: 'rgba(148,163,184,0.40)', margin: '0 0 12px' }}>
              {zeroOrUnpricedCount} token(s) with no known USD value (zero or unpriced) hidden from this view.
            </p>
          )}
          {personality && <PersonalityCard title="Holdings Personality" label={personality} />}

          <ChainSummaryStrip chainCounts={chainCounts} chainGroupedValueUsd={diagnostics.chainGroupedValueUsd} />

          <div style={{ marginBottom: '14px' }}>
            <SectionLabel>Holdings ({meaningfulHoldings.length})</SectionLabel>
            <HoldingsTable holdings={meaningfulHoldings} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
          </div>

          {dustHoldings.length > 0 && (
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
                  Dust tokens ({dustHoldings.length}) — {showDust ? 'expanded' : 'collapsed'}
                  {dustHoldings.some((h) => h.providerValueUsd != null)
                    ? ` · ${fmtUsd(dustHoldings.reduce((sum, h) => sum + (h.providerValueUsd ?? 0), 0))} total`
                    : ''}
                </span>
                <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.45)' }}>{showDust ? '▾' : '▸'}</span>
              </button>

              {showDust && (
                <div style={{ padding: '14px' }}>
                  <HoldingsTable holdings={dustHoldings} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
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
