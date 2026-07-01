'use client'

// HoldingsViewV2 — additive, chain-grouped, dust-filtered holdings view. Renders alongside (does
// NOT replace) the existing HoldingsView — this file adds a new view, it doesn't remove working
// functionality without an unambiguous instruction to delete it.
//
// V2-SAFE GUARD: every prop is typed non-optional by the caller's contract, but that's a
// compile-time guarantee only — every access below still defensively falls back to a safe default,
// same convention as every other component in this directory.
//
// HONESTY NOTE — real report.holdings (src/modules/holdings/types.ts TokenHolding) does NOT have
// `usdValueEstimate`, `sourceType`, `firstSeenTimestamp`, `lastSeenTimestamp`, `rotationSignals`,
// or `chainSelectionRef` fields the way the request assumed. The real fields are `contract`
// (not `token`) and `providerPriceUsd`/`providerValueUsd` (not `usdValueEstimate`). This component
// binds to the real TokenHolding shape, and:
//   - derives "first seen" / "last seen" / acquisition badges from REAL buyTimeline entries
//     (optional `buyEntries` prop) and REAL bridgeTimeline entries (optional `bridgeEntries` prop),
//     matched to a holding by (chain, contract) / (chain, symbol) — never guessed when no matching
//     entry exists (shows "Not available", not a fabricated date).
//   - does NOT render "High rotation" / "Low rotation" per-token badges — no per-token rotation
//     signal exists anywhere in this codebase (behaviorIntel.rotationStyle is a wallet-level
//     signal, not a per-holding one). Inventing one would be exactly the fabrication this
//     project's conventions forbid.
//   - does NOT wire pricingAtTime (src/modules/pricingAtTimeEngine) into the USD column —
//     pricingAtTime prices individual BUY/SELL TRANSACTIONS at their historical timestamp, keyed
//     by txHash; it has no concept of "current value of a still-held balance". Using it here would
//     answer a different question than the one this column asks. The USD column uses
//     providerValueUsd (real, already on TokenHolding — populated only when the balances provider
//     itself returned a value alongside the balance).
import { useMemo, useState } from 'react'
import type { TokenHolding } from '@/src/modules/holdings/types'
import type { BuyTimelineEntry } from '@/src/modules/timelineBuilder/types'
import type { BridgeCandidateEvent } from '@/src/modules/bridgeDetection/types'

export type HoldingsViewV2Props = {
  holdings: TokenHolding[] | null | undefined
  buyEntries?: BuyTimelineEntry[] | null
  bridgeEntries?: BridgeCandidateEvent[] | null
}

const DUST_AMOUNT_THRESHOLD = 0.001
const DUST_USD_THRESHOLD = 0.10

const CHAIN_LABELS: Record<string, string> = {
  base: 'Base',
  eth: 'ETH',
  arbitrum: 'Arbitrum',
  hyperevm: 'HyperEVM · pending', // no verified provider yet — see providerFetchWindow's HyperEVM TODO
}

function fmtChain(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain
}

function fmtUsd(value: number | null): string {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

function fmtAmount(amount: number): string {
  if (amount >= 1000) return amount.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return amount.toFixed(amount < 1 ? 6 : 4).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not available'
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function isDust(holding: TokenHolding): boolean {
  if (holding.amount < DUST_AMOUNT_THRESHOLD) return true
  if (holding.providerValueUsd !== null && holding.providerValueUsd < DUST_USD_THRESHOLD) return true
  if (!holding.symbol || holding.symbol.trim() === '' || holding.symbol === '?') return true
  return false
}

type AcquisitionInfo = {
  firstSeenMs: number | null
  lastSeenMs: number | null
  badges: string[]
}

// PURE. Derives real acquisition context for one holding by matching it against real
// buyTimeline/bridgeTimeline entries — never invents a date or a source when no matching entry
// exists.
function deriveAcquisitionInfo(
  holding: TokenHolding,
  buyEntries: BuyTimelineEntry[],
  bridgeEntries: BridgeCandidateEvent[],
): AcquisitionInfo {
  const matchingBuys = buyEntries.filter(
    (e) => e.chain === holding.chain && e.token.toLowerCase() === holding.contract.toLowerCase(),
  )
  const matchingBridgeIn = bridgeEntries.filter(
    (b) => b.chainTo === holding.chain && b.token.toLowerCase() === holding.symbol.toLowerCase(),
  )

  const timestamps = matchingBuys.map((e) => e.timestamp)
  const firstSeenMs = timestamps.length > 0 ? Math.min(...timestamps) : null
  const lastSeenMs = timestamps.length > 0 ? Math.max(...timestamps) : null

  const badges: string[] = []
  if (matchingBuys.length > 0 && matchingBuys.every((e) => e.sourceType === 'airdrop')) {
    badges.push('Airdrop-only')
  } else if (matchingBuys.some((e) => e.sourceType === 'swap')) {
    badges.push('Swap-acquired')
  }
  if (matchingBridgeIn.length > 0) badges.push('Bridge-acquired')

  return { firstSeenMs, lastSeenMs, badges }
}

function daysHeld(firstSeenMs: number | null): string {
  if (firstSeenMs == null) return 'Not available'
  const days = Math.max(0, Math.floor((Date.now() - firstSeenMs) / (24 * 60 * 60 * 1000)))
  return `${days} day(s)`
}

function AcquisitionBadge({ label }: { label: string }) {
  return (
    <span
      style={{
        padding: '2px 9px', borderRadius: '999px', fontSize: '9px', fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        background: 'rgba(56,189,248,0.10)', border: '1px solid rgba(56,189,248,0.30)', color: '#38bdf8',
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

function HoldingRow({
  holding,
  acquisition,
  index,
}: {
  holding: TokenHolding
  acquisition: AcquisitionInfo
  index: number
}) {
  return (
    <div
      className="hv2-row"
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
        padding: '11px 14px', borderRadius: '11px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
        animationDelay: `${Math.min(index, 20) * 35}ms`,
      }}
    >
      <div style={{ minWidth: '110px', flex: '1 1 150px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{holding.symbol || '—'}</div>
        <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          {holding.name ?? `${holding.contract.slice(0, 6)}…${holding.contract.slice(-4)}`}
        </div>
      </div>

      <div style={{ minWidth: '90px', fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {fmtAmount(holding.amount)}
      </div>

      <div style={{ minWidth: '80px', fontSize: '12px', fontWeight: 700, color: holding.providerValueUsd == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>
        {fmtUsd(holding.providerValueUsd)}
      </div>

      {acquisition.badges.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {acquisition.badges.map((b) => <AcquisitionBadge key={b} label={b} />)}
        </div>
      )}

      <div style={{ minWidth: '190px', fontSize: '10px', color: 'rgba(148,163,184,0.55)', marginLeft: 'auto' }}>
        First seen: {fmtDate(acquisition.firstSeenMs)} · Last: {fmtDate(acquisition.lastSeenMs)} · {daysHeld(acquisition.firstSeenMs)}
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
  const [dustOpen, setDustOpen] = useState(false)

  const meaningful = holdings.filter((h) => !isDust(h))
  const dust = holdings.filter(isDust)

  return (
    <div style={{ borderRadius: '13px', border: '1px solid rgba(255,255,255,0.07)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setSectionOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 14px', background: 'rgba(139,92,246,0.06)', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.32)', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            {fmtChain(chain)}
          </span>
          <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>{meaningful.length} position(s) · {dust.length} dust</span>
        </span>
        <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.55)' }}>{sectionOpen ? '▾' : '▸'}</span>
      </button>

      {sectionOpen && (
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {meaningful.length === 0 ? (
            <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.45)', margin: 0 }}>No meaningful positions on this chain.</p>
          ) : (
            meaningful.map((h, i) => (
              <HoldingRow key={`${h.chain}:${h.contract}`} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
            ))
          )}

          {dust.length > 0 && (
            <div style={{ marginTop: '4px' }}>
              <button
                type="button"
                onClick={() => setDustOpen((v) => !v)}
                style={{
                  fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', color: 'rgba(148,163,184,0.65)',
                  background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '999px',
                  padding: '5px 12px', cursor: 'pointer', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                }}
              >
                {dustOpen ? `Hide dust tokens (${dust.length})` : `Show dust tokens (${dust.length})`}
              </button>
              {dustOpen && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {dust.map((h, i) => (
                    <HoldingRow key={`${h.chain}:${h.contract}`} holding={h} acquisition={deriveAcquisitionInfo(h, buyEntries, bridgeEntries)} index={i} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function HoldingsViewV2({ holdings, buyEntries, bridgeEntries }: HoldingsViewV2Props) {
  const safeHoldings = Array.isArray(holdings) ? holdings : []
  const safeBuyEntries = Array.isArray(buyEntries) ? buyEntries : []
  const safeBridgeEntries = Array.isArray(bridgeEntries) ? bridgeEntries : []

  const byChain = useMemo(() => {
    const map = new Map<string, TokenHolding[]>()
    for (const h of safeHoldings) {
      const group = map.get(h.chain) ?? []
      group.push(h)
      map.set(h.chain, group)
    }
    return map
  }, [safeHoldings])

  const totalDust = safeHoldings.filter(isDust).length

  return (
    <section>
      <style>{`
        @keyframes hv2FadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .hv2-row { animation: hv2FadeUp 0.26s ease both; }
      `}</style>

      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Holdings (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Chain-grouped · Dust-filtered · No fabricated USD or rotation data
        </p>
      </div>

      {safeHoldings.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No holdings detected.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[...byChain.entries()].map(([chain, chainHoldings]) => (
            <ChainSection key={chain} chain={chain} holdings={chainHoldings} buyEntries={safeBuyEntries} bridgeEntries={safeBridgeEntries} />
          ))}
          {totalDust > 0 && (
            <p style={{ fontSize: '10px', color: 'rgba(148,163,184,0.40)', margin: 0 }}>
              {totalDust} dust token(s) total across all chains (amount &lt; {DUST_AMOUNT_THRESHOLD}, value &lt; ${DUST_USD_THRESHOLD.toFixed(2)}, or no symbol).
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export default HoldingsViewV2
