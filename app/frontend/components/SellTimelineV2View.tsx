// SellTimelineV2View — renders report.timelines.sellTimelineV2.entries ONLY. Additive UI feature:
// does not read, render, or otherwise touch report.timelines.sellTimeline (the legacy timeline,
// still rendered separately by SellTimelineView) or any other report field.
//
// V2-SAFE GUARD: `entries` is typed non-optional by the caller's contract, but that's a
// compile-time guarantee only — every access below still defensively falls back to a safe default,
// same convention as every other component in this directory.
//
// HONESTY NOTE: renders exactly the seven real fields sellTimelineV2 produces (timestamp, chain,
// token, symbol, amount, proceedsUsdEstimate, confidence, txHash) plus the chain label itself.
// No router name, DEX label, bridge-contract name, or contract-type badge is rendered, because
// sellTimeline (src/modules/sellTimeline) doesn't compute any of those — inventing one here would
// be exactly the fabricated-metadata pattern this project has refused all session.
import type { SellTimelineEntry } from '@/src/modules/sellTimeline/types'

export type SellTimelineV2ViewProps = {
  entries: SellTimelineEntry[] | null | undefined
}

const CHAIN_LABELS: Record<string, string> = {
  base: 'Base',
  eth: 'ETH',
  arbitrum: 'Arbitrum',
  hyperevm: 'HyperEVM · pending', // no verified provider yet — see providerFetchWindow's HyperEVM TODO
}

const CONFIDENCE_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  high: { bg: 'rgba(45,212,191,0.10)', border: 'rgba(45,212,191,0.35)', color: '#2DD4BF' }, // teal
  medium: { bg: 'rgba(56,189,248,0.10)', border: 'rgba(56,189,248,0.35)', color: '#38bdf8' }, // blue
  low: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', color: '#94a3b8' }, // gray
}

function fmtChain(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain
}

function fmtTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return 'Unknown time'
  return new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtTxHash(txHash: string): string {
  if (!txHash || txHash.length <= 16) return txHash
  return `${txHash.slice(0, 10)}…${txHash.slice(-6)}`
}

function fmtToken(token: string): string {
  if (!token || token.length <= 12) return token
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const style = CONFIDENCE_STYLE[confidence] ?? CONFIDENCE_STYLE.low
  return (
    <span
      style={{
        padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        background: style.bg, border: `1px solid ${style.border}`, color: style.color,
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap',
      }}
    >
      {confidence}
    </span>
  )
}

function SellRow({ entry, index }: { entry: SellTimelineEntry; index: number }) {
  const symbol = entry.symbol ?? '—'
  const proceeds = typeof entry.proceedsUsdEstimate === 'number' ? entry.proceedsUsdEstimate : null

  return (
    <div
      className="stv2-row"
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
        padding: '12px 14px', borderRadius: '12px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
        animationDelay: `${Math.min(index, 20) * 40}ms`,
      }}
    >
      <span
        style={{
          padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800,
          letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0,
          background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.30)', color: '#c4b5fd',
          fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
        }}
      >
        {fmtChain(entry.chain)}
      </span>

      <div style={{ minWidth: '120px', flex: '1 1 160px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{symbol}</div>
        <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{fmtToken(entry.token)}</div>
      </div>

      <div style={{ minWidth: '90px', fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {entry.amount}
      </div>

      <div style={{ minWidth: '90px', fontSize: '12px', color: proceeds != null ? '#4ade80' : 'rgba(148,163,184,0.45)' }}>
        {proceeds != null ? `$${proceeds.toFixed(2)}` : 'No estimate'}
      </div>

      <ConfidenceBadge confidence={entry.confidence} />

      <div style={{ minWidth: '140px', fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>{fmtTimestamp(entry.timestamp)}</div>

      <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.40)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginLeft: 'auto' }}>
        {fmtTxHash(entry.txHash)}
      </div>
    </div>
  )
}

export function SellTimelineV2View({ entries }: SellTimelineV2ViewProps) {
  const safeEntries = Array.isArray(entries) ? entries : []

  return (
    <section>
      <style>{`
        @keyframes stv2FadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .stv2-row { animation: stv2FadeUp 0.28s ease both; }
      `}</style>

      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          Sell Timeline (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Real exits · No fabricated metadata
        </p>
      </div>

      {safeEntries.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No sell events detected by V2.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {safeEntries.map((entry, i) => (
            <SellRow key={`${entry.txHash}-${entry.chain}-${i}`} entry={entry} index={i} />
          ))}
        </div>
      )}
    </section>
  )
}

export default SellTimelineV2View
