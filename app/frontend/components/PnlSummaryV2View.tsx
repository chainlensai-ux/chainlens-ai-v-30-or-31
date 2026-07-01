// PnlSummaryV2View — renders report.pnlSummaryV2 ONLY. Additive UI feature: does not read, render,
// or otherwise touch fifoEngine's report.fifoAndPnl (the legacy/real PnL engine, still rendered
// separately by FifoAndPnlView) or any other report field.
//
// V2-SAFE GUARD: `pnl` is typed non-optional by the caller's contract, but that's a compile-time
// guarantee only — every access below still defensively falls back to a safe default, same
// convention as every other component in this directory.
//
// HONESTY NOTE: renders exactly what src/modules/pnlEngine produces. Real field names differ
// slightly from the requested spec (this module's field is `evidence: 'complete'|'evidence_missing'`,
// not `evidenceStatus`; `confidenceBasis` is `{high, medium, low, aggregate}`, not
// `{highCount, mediumCount, lowCount}`; `chainBreakdown` is an array of
// `{chain, closedLotCount, realizedPnlUsd}`, not a wins/losses-per-chain record) — this component
// binds to the real shape rather than fields that don't exist. Per-chain wins/losses are derived
// here from the real `closedLots` array (a real aggregation over real data, not a fabricated
// value) since pnlEngine's own chainBreakdown doesn't compute that split. No router name, DEX
// label, bridge-contract name, or contract-type badge is rendered — pnlEngine doesn't compute any
// of those.
import type { ClosedLot, PnlSummaryResult } from '@/src/modules/pnlEngine/types'

export type PnlSummaryV2ViewProps = {
  pnl: PnlSummaryResult | null | undefined
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
  unavailable: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', color: '#94a3b8' },
}

const EVIDENCE_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  complete: { bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.35)', color: '#4ade80' },
  evidence_missing: { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.28)', color: '#fbbf24' },
}

function fmtChain(chain: string): string {
  return CHAIN_LABELS[chain] ?? chain
}

function fmtUsd(value: number | null): string {
  if (value == null) return 'No USD evidence'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

function fmtUsdOrMissing(value: number | null): string {
  return value == null ? 'missing' : `$${value.toFixed(2)}`
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

function Badge({ label, style }: { label: string; style: { bg: string; border: string; color: string } }) {
  return (
    <span
      style={{
        padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        background: style.bg, border: `1px solid ${style.border}`, color: style.color,
        fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

function MetricCard({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ flex: '1 1 160px', minWidth: '140px', padding: '12px 14px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '6px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {label}
      </div>
      <div style={{ fontSize: '15px', fontWeight: 800, color: valueColor ?? '#e2e8f0' }}>{value}</div>
    </div>
  )
}

function chainWinLoss(closedLots: ClosedLot[], chain: string): { wins: number; losses: number } {
  let wins = 0
  let losses = 0
  for (const lot of closedLots) {
    if (lot.chain !== chain || lot.evidence !== 'complete') continue
    if (lot.realizedPnlUsd! > 0) wins += 1
    else if (lot.realizedPnlUsd! < 0) losses += 1
  }
  return { wins, losses }
}

function ChainBreakdownCard({ chain, closedLotCount, realizedPnlUsd, closedLots }: { chain: string; closedLotCount: number; realizedPnlUsd: number | null; closedLots: ClosedLot[] }) {
  const { wins, losses } = chainWinLoss(closedLots, chain)
  return (
    <div style={{ padding: '12px 14px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', minWidth: '160px', flex: '1 1 160px' }}>
      <div style={{ marginBottom: '8px' }}>
        <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.30)', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          {fmtChain(chain)}
        </span>
      </div>
      <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '4px' }}>{closedLotCount} closed lot(s) · {wins}W / {losses}L</div>
      <div style={{ fontSize: '14px', fontWeight: 700, color: realizedPnlUsd == null ? 'rgba(148,163,184,0.55)' : realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>
        {fmtUsd(realizedPnlUsd)}
      </div>
    </div>
  )
}

function ClosedLotRow({ lot, index }: { lot: ClosedLot; index: number }) {
  const evidenceStyle = EVIDENCE_STYLE[lot.evidence] ?? EVIDENCE_STYLE.evidence_missing
  const confidenceStyle = CONFIDENCE_STYLE[lot.confidence] ?? CONFIDENCE_STYLE.low

  return (
    <div
      className="pnlv2-row"
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap',
        padding: '12px 14px', borderRadius: '12px',
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
        animationDelay: `${Math.min(index, 20) * 40}ms`,
      }}
    >
      <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0, background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.30)', color: '#c4b5fd', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
        {fmtChain(lot.chain)}
      </span>

      <div style={{ minWidth: '110px', flex: '1 1 150px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{lot.symbol ?? '—'}</div>
        <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.55)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{fmtToken(lot.token)}</div>
      </div>

      <div style={{ minWidth: '70px', fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>{lot.amount}</div>

      <div style={{ minWidth: '80px', fontSize: '11px', color: lot.costUsdEstimate == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>
        Cost: {fmtUsdOrMissing(lot.costUsdEstimate)}
      </div>
      <div style={{ minWidth: '90px', fontSize: '11px', color: lot.proceedsUsdEstimate == null ? 'rgba(148,163,184,0.45)' : '#e2e8f0' }}>
        Proceeds: {fmtUsdOrMissing(lot.proceedsUsdEstimate)}
      </div>
      <div style={{ minWidth: '90px', fontSize: '12px', fontWeight: 700, color: lot.realizedPnlUsd == null ? 'rgba(148,163,184,0.45)' : lot.realizedPnlUsd >= 0 ? '#4ade80' : '#f87171' }}>
        {lot.realizedPnlUsd == null ? 'missing' : fmtUsd(lot.realizedPnlUsd)}
      </div>

      <Badge label={lot.confidence} style={confidenceStyle} />
      <Badge label={lot.evidence === 'complete' ? 'complete' : 'evidence missing'} style={evidenceStyle} />

      <div style={{ minWidth: '140px', fontSize: '11px', color: 'rgba(148,163,184,0.65)' }}>{fmtTimestamp(lot.timestamp)}</div>

      <div style={{ fontSize: '10px', color: 'rgba(148,163,184,0.40)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)', marginLeft: 'auto' }}>
        {fmtTxHash(lot.txHash)}
      </div>
    </div>
  )
}

export function PnlSummaryV2View({ pnl }: PnlSummaryV2ViewProps) {
  const closedLots = Array.isArray(pnl?.closedLots) ? pnl!.closedLots : []
  const realizedPnlUsd = pnl?.realizedPnlUsd ?? null
  const winLossRate = pnl?.winLossRate ?? { wins: 0, losses: 0, evaluated: 0, rate: null }
  const chainBreakdown = Array.isArray(pnl?.chainBreakdown) ? pnl!.chainBreakdown : []
  const confidenceBasis = pnl?.confidenceBasis ?? { high: 0, medium: 0, low: 0, aggregate: 'unavailable' as const }
  const evidenceMissingCount = pnl?.evidenceMissingCount ?? 0

  return (
    <section>
      <style>{`
        @keyframes pnlv2FadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .pnlv2-row { animation: pnlv2FadeUp 0.28s ease both; }
      `}</style>

      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 800, color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>
          PnL Summary (V2)
        </h3>
        <p style={{ margin: '4px 0 0', fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(45,212,191,0.65)', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
          Real evidence · No fabricated USD values
        </p>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <MetricCard
          label="Realized PnL"
          value={fmtUsd(realizedPnlUsd)}
          valueColor={realizedPnlUsd == null ? 'rgba(148,163,184,0.55)' : realizedPnlUsd >= 0 ? '#4ade80' : '#f87171'}
        />
        <MetricCard
          label="Win / Loss Rate"
          value={winLossRate.evaluated === 0 ? 'No complete lots' : `${winLossRate.wins}W / ${winLossRate.losses}L (${(winLossRate.rate! * 100).toFixed(0)}%)`}
        />
        <MetricCard label="Evidence Missing" value={String(evidenceMissingCount)} valueColor={evidenceMissingCount > 0 ? '#fbbf24' : undefined} />
        <MetricCard label="Confidence Basis" value={`${confidenceBasis.high}H / ${confidenceBasis.medium}M / ${confidenceBasis.low}L`} />
      </div>

      {chainBreakdown.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)', marginBottom: '8px', fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)' }}>
            Chain Breakdown
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {chainBreakdown.map((entry) => (
              <ChainBreakdownCard key={entry.chain} chain={entry.chain} closedLotCount={entry.closedLotCount} realizedPnlUsd={entry.realizedPnlUsd} closedLots={closedLots} />
            ))}
          </div>
        </div>
      )}

      {closedLots.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'rgba(148,163,184,0.55)', margin: 0 }}>No closed lots detected by PnL V2.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {closedLots.map((lot, i) => (
            <ClosedLotRow key={`${lot.txHash}-${lot.chain}-${i}`} lot={lot} index={i} />
          ))}
        </div>
      )}
    </section>
  )
}

export default PnlSummaryV2View
