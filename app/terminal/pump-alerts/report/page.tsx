'use client'

// PUMP-INTELLIGENCE-REPORT PAGE, DISCLOSED: renders the report built by
// lib/server/pumpIntelligence.ts via /api/pump-alerts/intelligence. Every value here either comes
// straight from that real, evidence-tagged payload or renders an explicit "Not Available"/"Unknown"
// state — nothing on this page is invented client-side. Confidence/status colors follow this
// codebase's existing honesty-contract convention (green=verified/clear, amber=partial/possible,
// red=confirmed risk, slate=unavailable/unknown) rather than a generic bull/bear palette.

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'
import type {
  PumpIntelligenceReport, Confidence, Catalyst, RiskFactor, KillSignal,
  ContinuationSignal, WalletRow, TimelineEvent, WatchItem,
} from '@/lib/server/pumpIntelligence'
import styles from './report.module.css'

// INSTANT-REPORT-NAV FIX, DISCLOSED (reported live: "Clicking Report takes ~4 seconds before route
// changes... report page should open immediately using the Pump Alert card payload, then enrich in
// the background"). ReportSeed is the same card payload the Pump Alerts page already writes to
// sessionStorage (pumpReportSeed:${chain}:${contract}) before it calls router.push — reading it here
// lets this page paint real price/volume/liquidity/FDV/market-cap/age/chain numbers on its very
// first render, instead of a bare loading skeleton, while the full report enriches in the background.
type ReportSeed = {
  symbol: string; name: string; contract: string; chain: string
  priceUsd: number | null; change24h: number | null; change6h: number | null; change1h: number | null
  volume24hUsd: number | null; liquidityUsd: number | null; fdvUsd: number | null; marketCapUsd: number | null
  tokenAgeDays: number | null; pairAddress: string | null; evidenceGrade: string | null
  reason?: string; riskLevel?: string
  navStartedAt?: number; usedPrefetch?: boolean
}

function reportSeedKey(chain: string, contract: string): string {
  return `pumpReportSeed:${chain}:${contract.toLowerCase()}`
}

function readSeedFromSession(chain: string, contract: string): ReportSeed | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(reportSeedKey(chain, contract))
    return raw ? (JSON.parse(raw) as ReportSeed) : null
  } catch { return null }
}

// Fallback for a direct/shared report URL that never went through a card click (no sessionStorage
// entry to read) — the same fields are already carried in the query string, so the shell can still
// render real numbers instead of blanking out while the API call is in flight.
function readSeedFromParams(params: URLSearchParams): ReportSeed | null {
  const contract = params.get('contract')
  if (!contract) return null
  const num = (key: string): number | null => {
    const v = params.get(key)
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    symbol: params.get('symbol') ?? '?', name: params.get('name') ?? 'Unknown',
    contract, chain: params.get('chain') ?? 'base',
    priceUsd: num('priceUsd'), change24h: num('change24h'), change6h: num('change6h'), change1h: num('change1h'),
    volume24hUsd: num('volume24hUsd'), liquidityUsd: num('liquidityUsd'), fdvUsd: num('fdvUsd'),
    marketCapUsd: num('marketCapUsd'), tokenAgeDays: num('tokenAgeDays'),
    pairAddress: params.get('pairAddress'), evidenceGrade: params.get('evidenceGrade'),
  }
}

const CONF_COLOR: Record<Confidence, string> = { high: '#4ade80', medium: '#fbbf24', low: '#fb923c', unavailable: '#64748b' }
const CONF_BG: Record<Confidence, string> = { high: 'rgba(74,222,128,0.10)', medium: 'rgba(251,191,36,0.10)', low: 'rgba(251,146,60,0.10)', unavailable: 'rgba(100,116,139,0.10)' }

function ConfBadge({ confidence }: { confidence: Confidence }) {
  return (
    <span style={{
      padding: '3px 8px', borderRadius: '999px', fontSize: '8px', fontWeight: 800, letterSpacing: '0.08em',
      textTransform: 'uppercase', color: CONF_COLOR[confidence], background: CONF_BG[confidence],
      border: `1px solid ${CONF_COLOR[confidence]}33`, fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
    }}>
      {confidence === 'unavailable' ? 'No data' : `${confidence} conf.`}
    </span>
  )
}

function ImpactBadge({ impact }: { impact: 'high' | 'medium' | 'low' }) {
  const color = impact === 'high' ? '#f87171' : impact === 'medium' ? '#fbbf24' : '#94a3b8'
  const score = impact === 'high' ? 3 : impact === 'medium' ? 2 : 1
  return (
    <span style={{ padding: '3px 8px', borderRadius: '999px', fontSize: '8px', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color, background: `${color}14`, border: `1px solid ${color}33`, fontFamily: 'var(--font-plex-mono)' }}>
      {score}/3 impact
    </span>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} style={{ marginBottom: '22px' }}>
      <div className={styles.sectionHeader} style={{ marginBottom: '10px' }}>
        <h2 style={{ margin: 0, fontSize: '13px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>{title}</h2>
        {subtitle && <p style={{ margin: '3px 0 0', fontSize: '11px', color: '#64748b' }}>{subtitle}</p>}
      </div>
      <div className={styles.sectionPanel} style={{
        background: 'linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: '16px', padding: '16px',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
      }}>
        {children}
      </div>
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <div className={styles.empty}>{text}</div>
}

function fmtUsd(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}
function fmtAge(hours: number | null): string {
  if (hours == null) return '—'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}
function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return iso }
}
function shortAddr(a: string): string { return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a }

// INSTANT-REPORT-NAV FIX, DISCLOSED: the shell rendered on first paint from the seed payload alone —
// price/24h/6h/1h change/volume/liquidity/market cap/FDV/age/chain/evidence mode, exactly the fields
// the requirement lists, all real values already known from the Pump Alert card. No blank page while
// the full report enriches in the background.
function SeedShell({ seed }: { seed: ReportSeed }) {
  const changeColor = (v: number | null) => v == null ? '#64748b' : v >= 0 ? '#4ade80' : '#f87171'
  const fmtPct = (v: number | null) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
  const metrics: Array<[string, string, string?]> = [
    ['Price', seed.priceUsd == null ? '—' : `$${seed.priceUsd < 0.01 ? seed.priceUsd.toPrecision(3) : seed.priceUsd.toFixed(4)}`],
    ['24h', fmtPct(seed.change24h), changeColor(seed.change24h)],
    ['6h', fmtPct(seed.change6h), changeColor(seed.change6h)],
    ['1h', fmtPct(seed.change1h), changeColor(seed.change1h)],
    ['Volume', fmtUsd(seed.volume24hUsd)],
    ['Liquidity', fmtUsd(seed.liquidityUsd)],
    ['Market Cap', seed.marketCapUsd == null ? 'MCap unavailable' : fmtUsd(seed.marketCapUsd)],
    ['FDV', fmtUsd(seed.fdvUsd)],
    ['Age', seed.tokenAgeDays == null ? '—' : (seed.tokenAgeDays < 1 ? `${(seed.tokenAgeDays*24).toFixed(1)}h` : `${Math.round(seed.tokenAgeDays)}d`)],
    ['Chain', seed.chain.toUpperCase()],
  ]
  return (
    <div className={styles.report}>
      <header className={styles.hero}>
        <div className={styles.identity}>
          <div className={styles.tokenMark} aria-hidden="true">{(seed.symbol || seed.name || 'T').charAt(0).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <p className={styles.eyebrow}>ChainLens intelligence dossier</p>
            <h1 className={styles.title}>{seed.name} <span className={styles.symbol}>{seed.symbol}</span></h1>
            <div className={styles.metaRow}>
              <span className={styles.metaChip}>{shortAddr(seed.contract)}</span>
              <span className={styles.metaChip}>{seed.chain.toUpperCase()} NETWORK</span>
              <span className={styles.metaChip}>{seed.evidenceGrade === 'live_momentum' ? 'LIVE MOMENTUM' : seed.evidenceGrade === 'exact' ? 'EXACT EVIDENCE' : 'CARD EVIDENCE'}</span>
            </div>
          </div>
        </div>
      </header>
      <Section title="Market Structure" subtitle="From the Pump Alert card — live while deeper evidence loads">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: '14px' }}>
          {metrics.map(([label, value, color]) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontSize: '8px', fontWeight: 800, color: '#4a6178', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>{label}</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: color ?? '#dce8f2', fontFamily: 'var(--font-plex-mono)' }}>{value}</span>
            </div>
          ))}
        </div>
      </Section>
      <style>{`@keyframes pumpReportSpin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.18)', color: '#7dd3c8', fontSize: '11px', fontFamily: 'var(--font-plex-mono)' }}>
        <span style={{ width: '10px', height: '10px', borderRadius: '999px', border: '2px solid rgba(125,211,200,0.3)', borderTopColor: '#7dd3c8', animation: 'pumpReportSpin 0.8s linear infinite', flexShrink: 0, display: 'inline-block' }} />
        Loading deeper evidence…
      </div>
    </div>
  )
}

function compactEvidence(value: string): string {
  const first = value.split(/[.!?](?:\s|$)/)[0]?.trim()
  return first || 'Not detected'
}

function scoreTone(score: number | null, inverse = false): string {
  if (score == null) return '#64748b'
  const value = inverse ? 100 - score : score
  return value >= 65 ? '#4ade80' : value >= 40 ? '#fbbf24' : '#f87171'
}

function GaugeCard({ label, score, band, reason, inverse = false }: { label: string; score: number | null; band: string; reason: string; inverse?: boolean }) {
  const color = scoreTone(score, inverse)
  return (
    <div className={styles.gaugeCard} style={{ borderColor: `${color}44` }}>
      <div className={styles.gaugeTop}><span>{label}</span><span style={{ color }}>{band}</span></div>
      <div className={styles.gaugeValue} style={{ color }}>{score == null ? '—' : `${score}`}</div>
      <div className={styles.gaugeTrack}><span style={{ width: `${score ?? 0}%`, background: color, boxShadow: `0 0 14px ${color}88` }} /></div>
      <div className={styles.gaugeReason}>{reason}</div>
    </div>
  )
}

// UI STATE FIX, DISCLOSED (requested: "Replace huge 'Provider unavailable' text with smaller state:
// 'Unavailable' — reason under it"). When a metric is unresolved, the big value slot now always
// reads the short word "Unavailable" — never a full sentence at metricValue's large font size — and
// the specific reason (which sources were tried) renders underneath in small text plus a hover
// tooltip, matching "show source attempts in tooltip/dev audit, not huge UI text."
function MetricCard({ label, value, delta, status, source, reason }: { label: string; value: string; delta: string; status: string; source: string; reason?: string }) {
  const color = status === 'Bullish' ? '#4ade80' : status === 'Risk' ? '#f87171' : status === 'Watch' ? '#fbbf24' : '#94a3b8'
  const unavailable = value === 'Unavailable'
  return (
    <div className={styles.metricCard} title={reason}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={styles.metricValue} style={unavailable ? { fontSize: '13px', color: '#64748b' } : undefined}>{value}</div>
      <div className={styles.metricDelta}>{unavailable && reason ? reason : delta}</div>
      <div className={styles.metricFooter}><span style={{ color }}>{status}</span><span>{source}</span></div>
    </div>
  )
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.statTile} style={{ padding: '10px 12px', borderRadius: '12px', background: 'rgba(2,6,23,0.3)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', fontFamily: 'var(--font-plex-mono)', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '15px', fontWeight: 800, color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: '9.5px', color: '#64748b', marginTop: '2px' }}>{sub}</div>}
    </div>
  )
}

function CatalystRow({ c }: { c: Catalyst }) {
  return (
    <div className={styles.catalystCard}>
      <div style={{ minWidth: 0 }}>
        <div className={styles.cardTitle}>{c.label}</div>
        <div className={styles.cardEvidence}>{compactEvidence(c.evidence)}</div>
        <div className={styles.source}>SOURCE · {c.source}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end', flexShrink: 0 }}>
        <ImpactBadge impact={c.impact} />
        <ConfBadge confidence={c.confidence} />
      </div>
    </div>
  )
}

const STATUS_COLOR: Record<RiskFactor['status'], string> = { confirmed: '#f87171', possible: '#fbbf24', clear: '#4ade80', unknown: '#64748b', unsupported: '#475569' }
// UI STATE FIX, DISCLOSED (requested: replace generic "Unavailable"/"Unknown" with clearer states).
// 'unsupported' reads distinctly from 'unknown' — this module has no resolver for it anywhere in the
// system (permanent), vs. 'unknown' meaning this specific read just didn't resolve (worth retrying).
const STATUS_LABEL: Record<RiskFactor['status'], string> = { confirmed: 'Confirmed', possible: 'Possible', clear: 'Clear', unknown: 'Unknown', unsupported: 'Unsupported' }

function RiskRow({ r }: { r: RiskFactor }) {
  return (
    <div className={styles.riskCard} style={{ borderColor: `${STATUS_COLOR[r.status]}38` }}>
      <div style={{ display: 'flex', gap: '10px', minWidth: 0, flex: 1 }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: STATUS_COLOR[r.status], marginTop: '5px', flexShrink: 0, boxShadow: `0 0 6px ${STATUS_COLOR[r.status]}66` }} />
        <div style={{ minWidth: 0 }}>
          <div className={styles.cardTitle}>{r.label} <span style={{ color: STATUS_COLOR[r.status] }}>· {STATUS_LABEL[r.status]}</span></div>
          <div className={styles.cardEvidence}>{compactEvidence(r.evidence)}</div>
          <div className={styles.source}>IMPACT · {r.impact.toUpperCase()}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end', flexShrink: 0 }}>
        <ImpactBadge impact={r.impact} />
        <ConfBadge confidence={r.confidence} />
      </div>
    </div>
  )
}

const PROB_COLOR: Record<KillSignal['probability'], string> = { high: '#f87171', medium: '#fbbf24', low: '#4ade80', unknown: '#64748b' }

function KillRow({ k }: { k: KillSignal }) {
  return (
    <div className={styles.probabilityCard} style={{ borderColor: `${PROB_COLOR[k.probability]}38` }}>
      <div style={{ minWidth: 0 }}>
        <div className={styles.cardTitle}>{k.label}</div>
        <div className={styles.cardEvidence}>{compactEvidence(k.evidence)}</div>
      </div>
      <span style={{ padding: '4px 10px', borderRadius: '999px', fontSize: '9px', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: PROB_COLOR[k.probability], background: `${PROB_COLOR[k.probability]}14`, border: `1px solid ${PROB_COLOR[k.probability]}33`, fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>
        {k.probability === 'unknown' ? 'NOT DETECTED' : `${k.probability} BAND`}
      </span>
    </div>
  )
}

function ContinuationRow({ s }: { s: ContinuationSignal }) {
  const color = s.status === true ? '#4ade80' : s.status === false ? '#f87171' : '#64748b'
  const mark = s.status === true ? '✓' : s.status === false ? '✕' : '?'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ width: '20px', height: '20px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color, background: `${color}14`, border: `1px solid ${color}33`, fontSize: '11px', fontWeight: 800, flexShrink: 0 }}>{mark}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>{s.label}</div>
        <div style={{ fontSize: '10.5px', color: '#64748b' }}>{s.detail}</div>
      </div>
    </div>
  )
}

function WalletRowView({ w }: { w: WalletRow }) {
  const color = w.side === 'buy' ? '#4ade80' : '#f87171'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        <span style={{ fontSize: '10px', fontWeight: 800, color, fontFamily: 'var(--font-plex-mono)' }}>{w.side === 'buy' ? '▲' : '▼'}</span>
        <span style={{ fontSize: '11.5px', fontFamily: 'var(--font-plex-mono)', color: '#e2e8f0' }}>{shortAddr(w.address)}</span>
        {w.isTracked && <span style={{ fontSize: '8px', fontWeight: 800, color: '#c4b5fd', background: 'rgba(168,85,247,0.10)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: '999px', padding: '2px 6px' }}>SMART MONEY</span>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}>{w.amountUsd != null ? fmtUsd(w.amountUsd) : '—'}</div>
        <div style={{ fontSize: '9px', color: '#64748b' }}>{fmtTime(w.occurredAt)}</div>
      </div>
    </div>
  )
}

const TL_COLOR: Record<TimelineEvent['kind'], string> = { whale_buy: '#4ade80', whale_sell: '#f87171', pool_created: '#22d3ee', other: '#94a3b8' }

function TimelineRow({ e }: { e: TimelineEvent }) {
  return (
    <div style={{ display: 'flex', gap: '10px', padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)', flexShrink: 0, width: '108px' }}>{fmtTime(e.timestamp)}</span>
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: TL_COLOR[e.kind], marginTop: '4px', flexShrink: 0 }} />
      <span style={{ fontSize: '11.5px', color: '#e2e8f0' }}>{e.label}</span>
    </div>
  )
}

function WatchRow({ w }: { w: WatchItem }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ fontSize: '12px', fontWeight: 600, color: '#e2e8f0' }}>{w.label}</span>
      <span style={{ fontSize: '10.5px', color: '#94a3b8', textAlign: 'right' }}>{w.threshold}</span>
    </div>
  )
}

function ReportView({ report }: { report: PumpIntelligenceReport }) {
  const es = report.executiveSummary
  const ms = report.marketStructure
  const impactOrder = { high: 0, medium: 1, low: 2 }
  const sortedCatalysts = [...report.catalysts].sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact])
  const topRisk = report.riskAnalysis.find(r => r.status === 'confirmed') ?? report.riskAnalysis.find(r => r.status === 'possible')
  const highProbKill = report.killSignals.find(k => k.probability === 'high')
  const pullbackRiskLabel = es.pullbackEvidence.split(/[.!?](?:\s|$)/)[0]?.trim() || 'High pullback risk'
  const biggestRisk = topRisk?.label
    ?? (es.pullbackRisk === 'high' ? pullbackRiskLabel : undefined)
    ?? highProbKill?.label
    ?? 'No confirmed risk'
  // UI STATE FIX, DISCLOSED: swapped generic "No data"/"Provider unavailable" sentences for the
  // short "Unavailable" value (see MetricCard) plus the REAL reason from the backend audit — never a
  // guessed explanation. Market Cap and FDV are always independently sourced and labelled per the
  // requested fallback order; Market Cap never silently reads the FDV number.
  const txnsSourceLabel = ms.txnsSource === 'geckoterminal' ? 'GeckoTerminal' : ms.txnsSource === 'dexscreener' ? 'DexScreener' : 'None resolved'
  const SOURCE_LABEL: Record<string, string> = {
    alert_payload: 'Pump Alert card', dexscreener: 'DexScreener', token_scanner: 'Token Scanner',
    internal_snapshot: 'Cached snapshot', none: 'None resolved',
  }
  const marketMetrics = [
    // 7d/14d leads the grid: it is the gate this token had to clear to be a Pump Alert at all, so it
    // is the single most relevant number on the page. Shows an honest "Exact 7d unavailable" rather
    // than falling back to the 24h figure when the exact-window series didn't resolve — this never
    // affects the Momentum/Continuation/Pullback scores above, which compute from live evidence.
    { label: '7d/14d change', value: ms.priceChange7d == null ? 'Unavailable' : `${ms.priceChange7d > 0 ? '+' : ''}${ms.priceChange7d.toFixed(1)}%`, delta: '7d/14d · qualifying gate', status: ms.priceChange7d == null ? 'No data' : ms.priceChange7d >= 0 ? 'Bullish' : 'Risk', source: 'GeckoTerminal OHLCV / snapshots', reason: ms.priceChange7d == null ? 'Exact 7d unavailable — OHLCV and internal snapshots did not resolve.' : undefined },
    { label: 'Price change', value: ms.priceChange24h == null ? 'Unavailable' : `${ms.priceChange24h > 0 ? '+' : ''}${ms.priceChange24h.toFixed(1)}%`, delta: '24h', status: ms.priceChange24h == null ? 'No data' : ms.priceChange24h >= 0 ? 'Bullish' : 'Risk', source: 'DexScreener / GeckoTerminal' },
    { label: 'Liquidity', value: ms.liquidityUsd == null ? 'Unavailable' : fmtUsd(ms.liquidityUsd), delta: 'No stored delta', status: ms.liquidityUsd == null ? 'No data' : 'Live', source: SOURCE_LABEL[ms.liquiditySource], reason: ms.liquidityUsd == null ? 'Neither the Pump Alert card nor DexScreener returned liquidity.' : undefined },
    { label: 'Volume', value: ms.volume24hUsd == null ? 'Unavailable' : fmtUsd(ms.volume24hUsd), delta: '24h total', status: ms.volume24hUsd == null ? 'No data' : 'Live', source: 'GeckoTerminal' },
    { label: 'Buys / Sells', value: ms.buys24h != null && ms.sells24h != null ? `${ms.buys24h} / ${ms.sells24h}` : 'Unavailable', delta: ms.buySellRatio == null ? 'No ratio' : `${ms.buySellRatio.toFixed(2)}:1 ratio`, status: ms.buySellRatio == null ? 'No data' : ms.buySellRatio > 1 ? 'Bullish' : 'Watch', source: txnsSourceLabel, reason: ms.txnsUnavailableReason ?? undefined },
    { label: 'Transactions', value: ms.txns24h == null ? 'Unavailable' : ms.txns24h.toLocaleString(), delta: '24h total', status: ms.txns24h == null ? 'No data' : 'Live', source: txnsSourceLabel, reason: ms.txnsUnavailableReason ?? undefined },
    // FDV is always its own independent card — resolved and sourced separately from Market Cap,
    // never substituted for it.
    { label: 'FDV', value: ms.fdvUsd == null ? 'Unavailable' : fmtUsd(ms.fdvUsd), delta: 'Snapshot', status: ms.fdvUsd == null ? 'No data' : 'Live', source: SOURCE_LABEL[ms.fdvSource], reason: ms.fdvUsd == null ? 'No supported provider returned FDV for this token.' : undefined },
    // MARKET-CAP CARD FIX, DISCLOSED (hard rule: "Do NOT use FDV as market cap unless clearly
    // labelled"): shows the real marketCapUsd when any of the 6 fallback tiers resolved it, or the
    // exact required note when only FDV is available — never a silent FDV substitution, never $0.
    { label: 'Market cap', value: ms.marketCapUsd == null ? 'Unavailable' : fmtUsd(ms.marketCapUsd), delta: 'Snapshot', status: ms.marketCapUsd == null ? 'No data' : 'Live', source: SOURCE_LABEL[ms.marketCapSource], reason: ms.marketCapUnavailableReason ?? undefined },
    { label: 'Pool age', value: ms.ageHours == null ? 'Unavailable' : fmtAge(ms.ageHours), delta: 'Since creation', status: ms.ageHours == null ? 'No data' : 'Live', source: 'GeckoTerminal / DexScreener' },
    { label: 'Holders', value: ms.holderCount == null ? 'Unavailable' : `${ms.holderCount.toLocaleString()}${ms.holderCountCapped ? '+' : ''}`, delta: 'No stored delta', status: ms.holderCount == null ? 'No data' : 'Live', source: 'GoldRush' },
    { label: 'Top holder', value: ms.top1HolderPercent == null ? 'Unavailable' : `${ms.top1HolderPercent.toFixed(1)}%`, delta: 'Supply share', status: ms.top1HolderPercent == null ? 'No data' : ms.top1HolderPercent > 20 ? 'Risk' : 'Live', source: 'Holder analysis' },
    { label: 'Top 10 holders', value: ms.top10HolderPercent == null ? 'Unavailable' : `${ms.top10HolderPercent.toFixed(1)}%`, delta: 'Supply share', status: ms.top10HolderPercent == null ? 'No data' : ms.top10HolderPercent > 50 ? 'Risk' : 'Live', source: 'Holder analysis' },
    { label: 'Buy / sell ratio', value: ms.buySellRatio == null ? 'Unavailable' : `${ms.buySellRatio.toFixed(2)}x`, delta: '24h', status: ms.buySellRatio == null ? 'No data' : ms.buySellRatio > 1 ? 'Bullish' : 'Watch', source: txnsSourceLabel, reason: ms.buySellRatio == null ? ms.txnsUnavailableReason ?? undefined : undefined },
  ]
  return (
    <div className={styles.report}>
      {/* Header */}
      <header className={styles.hero}>
        <div className={styles.identity}>
          <div className={styles.tokenMark} aria-hidden="true">{(report.symbol || report.name || 'T').charAt(0).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <p className={styles.eyebrow}>ChainLens intelligence dossier</p>
            <h1 className={styles.title}>{report.name} <span className={styles.symbol}>{report.symbol}</span></h1>
            <div className={styles.metaRow}>
              <span className={styles.metaChip}>{shortAddr(report.contract)}</span>
              <span className={styles.metaChip}>{report.chain.toUpperCase()} NETWORK</span>
              <span className={styles.metaChip}>GENERATED {fmtTime(report.generatedAt)}</span>
            </div>
          </div>
        </div>
        <div className={styles.statusWrap}>
          <span className={styles.status}><span className={styles.statusDot} />LIVE EVIDENCE</span>
          <span className={styles.statusCaption}>Evidence-grounded · real-time scan</span>
        </div>
      </header>

      <Section title="Executive Summary" subtitle="Evidence scores · no synthetic estimates">
        <div className={styles.gaugeGrid}>
          <GaugeCard label="Momentum Score" score={es.momentumScore} band={es.momentumConfidence} reason={es.momentumEvidence} />
          <GaugeCard label="Continuation Probability" score={es.continuationScore} band={es.continuationProbability} reason={es.continuationEvidence} />
          <GaugeCard label="Pullback Risk" score={es.pullbackRiskScore} band={es.pullbackRisk} reason={es.pullbackEvidence} inverse />
          <GaugeCard label="Confidence" score={es.confidenceScore} band={es.overallConfidence} reason="Core evidence coverage" />
        </div>
      </Section>

      {/* 2. Why It Pumped */}
      <Section title="Why It Pumped" subtitle="Verified catalysts, ranked by impact">
        {sortedCatalysts.length === 0 ? <Empty text="Not detected — no catalyst cleared verification." /> : <div className={styles.catalystGrid}>{sortedCatalysts.map((c, i) => <div key={`${c.label}-${i}`} className={styles.rankedCard}><span className={styles.rank}>#{i + 1}</span><CatalystRow c={c} /></div>)}</div>}
        <div className={styles.notDetectedGrid}>
          {!sortedCatalysts.some(c => /liquidity/i.test(c.label)) && <Empty text="Liquidity increase · Not detected" />}
          {!sortedCatalysts.some(c => /holder/i.test(c.label)) && <Empty text="Holder growth · Not detected" />}
          {!sortedCatalysts.some(c => /volume/i.test(c.label)) && <Empty text="Volume acceleration · Not detected" />}
        </div>
      </Section>

      {/* 3. Market Structure */}
      <Section title="Market Structure">
        <div className={styles.marketGrid}>{marketMetrics.map(metric => <MetricCard key={metric.label} {...metric} />)}</div>
      </Section>

      {/* 4. Wallet Intelligence */}
      {/* WALLET-INTELLIGENCE COLLAPSE FIX, DISCLOSED (requested: "do not show a huge empty section" —
          when the whale-alert feed has zero events for this contract, the full buyer/seller/creator/
          cluster grid rendered as a wall of "No verified wallet evidence yet." rows). Collapses to a
          single compact line whenever there is truly nothing to show. */}
      {report.walletIntelligence.eventCount === 0 ? (
        <Section title="Wallet Intelligence">
          <div style={{ fontSize: '11.5px', color: '#64748b' }}>Wallet-level buyer/seller evidence not available for this chain/provider yet.</div>
        </Section>
      ) : (
        <Section title="Wallet Intelligence" subtitle={`${report.walletIntelligence.eventCount} verified monitored events`}>
          <div className={styles.walletSummary}>
            <StatTile label="Net whale flow" value={report.walletIntelligence.netWhaleFlowUsd == null ? '—' : `${report.walletIntelligence.netWhaleFlowUsd >= 0 ? '+' : '-'}${fmtUsd(Math.abs(report.walletIntelligence.netWhaleFlowUsd))}`} sub="Monitored wallet feed" />
            <StatTile label="Smart wallet events" value={report.walletIntelligence.trackedWalletActivity.length.toLocaleString()} sub="Tracked addresses" />
            <StatTile label="Suspicious clusters" value="—" sub="No verified EVM evidence" />
          </div>
          <div className={styles.twoColumn} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px' }}>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#4ade80', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>Largest Buyers</div>
              {report.walletIntelligence.largestBuyers.length === 0 ? <Empty text="No verified wallet evidence yet." /> : report.walletIntelligence.largestBuyers.map((w, i) => <WalletRowView key={i} w={w} />)}
            </div>
            <div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: '#f87171', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '4px' }}>Largest Sellers</div>
              {report.walletIntelligence.largestSellers.length === 0 ? <Empty text="No verified wallet evidence yet." /> : report.walletIntelligence.largestSellers.map((w, i) => <WalletRowView key={i} w={w} />)}
            </div>
          </div>
          <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontSize: '11px', color: '#94a3b8' }}>Creator activity</span><ConfBadge confidence={report.walletIntelligence.creatorActivity.confidence} /></div>
            <span className={styles.compactEvidence}>{compactEvidence(report.walletIntelligence.creatorActivity.evidence)}</span>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}><span style={{ fontSize: '11px', color: '#94a3b8' }}>Cluster / insider concentration</span><ConfBadge confidence={report.walletIntelligence.clusterAnalysis.confidence} /></div>
            <span className={styles.compactEvidence}>{compactEvidence(report.walletIntelligence.clusterAnalysis.evidence)}</span>
          </div>
        </Section>
      )}

      {/* 5. Risk Analysis */}
      <Section title="Risk Analysis">
        <div className={styles.riskGrid}>{report.riskAnalysis.map((r, i) => <RiskRow key={i} r={r} />)}</div>
      </Section>

      {/* 6. What Could Kill This Pump */}
      <Section title="What Could Kill This Pump" subtitle="Ordered by highest probability first">
        <div className={styles.probabilityGrid}>{[...report.killSignals].sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2, unknown: 3 }
          return order[a.probability] - order[b.probability]
        }).map((k, i) => <KillRow key={i} k={k} />)}</div>
        <div className={styles.calibrationNote}>Probability bands only · calibrated percentages are not available</div>
      </Section>

      {/* 7. Continuation Signals */}
      <Section title="Continuation Signals" subtitle="Bullish checklist">
        {report.continuationSignals.map((s, i) => <ContinuationRow key={i} s={s} />)}
      </Section>

      {/* 8. Historical Similarity */}
      <Section title="Historical Similarity">
        <Empty text="Not detected · no verified pump-outcome history" />
      </Section>

      {/* 9. Actionable Watchlist */}
      <Section title="Actionable Watchlist">
        {report.watchlist.map((w, i) => <WatchRow key={i} w={w} />)}
      </Section>

      {/* 10. Timeline */}
      <Section title="Timeline" subtitle="Chronological, most recent first">
        {report.timeline.length === 0 ? <Empty text="No timed events captured for this token yet." /> : report.timeline.map((e, i) => <TimelineRow key={i} e={e} />)}
        <div className={styles.notDetectedGrid}>
          <Empty text="Liquidity event · Not timestamped" />
          <Empty text="Holder milestone · Not timestamped" />
          <Empty text="Creator movement · Not detected" />
        </div>
      </Section>

      <Section title="Clark Verdict" subtitle="Data shown above · 40-word maximum">
        <ul className={styles.clarkList}>
          <li><strong>Main reason:</strong> {sortedCatalysts[0]?.label ?? 'No verified catalyst'}</li>
          <li><strong>Biggest risk:</strong> {biggestRisk}</li>
          <li><strong>Watch next:</strong> {report.watchlist[0]?.label ?? 'Fresh evidence'}</li>
        </ul>
      </Section>
    </div>
  )
}

function ReportPageInner() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const params = useSearchParams()
  const router = useRouter()
  const contract = params.get('contract') ?? ''
  const chain = params.get('chain') ?? 'base'
  const [report, setReport] = useState<PumpIntelligenceReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // INSTANT-REPORT-NAV FIX, DISCLOSED: read once, synchronously, on the very first render (lazy
  // useState initializer runs before paint) — sessionStorage first (the full card payload written by
  // the Pump Alerts page right before router.push), URL params as the fallback for a direct/shared
  // report link that never went through a card click.
  const [seed] = useState<ReportSeed | null>(() => {
    if (!contract) return null
    return readSeedFromSession(chain, contract) ?? readSeedFromParams(params)
  })

  useEffect(() => {
    if (!contract) return
    let cancelled = false
    const apiStartMs = Date.now()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const token = session?.access_token
        const qs = new URLSearchParams(params.toString())
        const res = await fetch(`/api/pump-alerts/intelligence?${qs.toString()}`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok || json.error) { setError(json.error ?? 'Failed to load report.'); setReport(null) }
        else setReport(json.report)
      } catch {
        if (!cancelled) setError('Failed to load report.')
      } finally {
        if (!cancelled) {
          setLoading(false)
          // NAV AUDIT, DISCLOSED: logged once the enrichment call settles, carrying forward the
          // click-time fields the Pump Alerts page stamped onto the seed (navStartedAt, usedPrefetch)
          // so the full click-to-shell-to-API timeline is visible from one console entry.
          const now = Date.now()
          console.debug('[pumpReportNavigationAudit:settled]', {
            tokenAddress: contract, chainSlug: chain,
            clickToReportShellMs: seed?.navStartedAt != null ? apiStartMs - seed.navStartedAt : null,
            seedPayloadAvailable: seed != null,
            reportApiStartedMs: seed?.navStartedAt != null ? apiStartMs - seed.navStartedAt : null,
            reportApiCompletedMs: seed?.navStartedAt != null ? now - seed.navStartedAt : null,
            blockedNavigation: false,
            usedPrefetch: seed?.usedPrefetch ?? false,
            usedSessionSeed: seed != null && seed.navStartedAt != null,
          })
        }
      }
    }
    run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract])

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!canAccessFeature(plan, 'pump-alerts')) return <LockedPanel feature="pump-alerts" />

  return (
    <main className={styles.page}>
      <div className={styles.content}>
      <button
        type="button"
        onClick={() => router.push('/terminal/pump-alerts')}
        className={styles.backButton}
      >
        <span className={styles.backArrow}>←</span> Back to Pump Alerts
      </button>
      {!contract && <div className={styles.error}><strong>Report evidence unavailable</strong><br />No contract specified.</div>}
      {/* INSTANT-REPORT-NAV FIX, DISCLOSED: while the full report is still loading, render real
          numbers from the seed immediately instead of a content-free skeleton — falls back to the
          skeleton only when there's truly no seed (sessionStorage unavailable AND no URL params). */}
      {contract && loading && seed && <SeedShell seed={seed} />}
      {contract && loading && !seed && <div className={styles.loading} aria-label="Building intelligence report"><div className={styles.loadingCard} /><div className={styles.loadingCard} /><div className={styles.loadingCard} /></div>}
      {contract && !loading && error && <div className={styles.error}><strong>Report evidence unavailable</strong><br />{error}</div>}
      {contract && !loading && !error && report && <ReportView report={report} />}
      </div>
    </main>
  )
}

export default function PumpIntelligenceReportPage() {
  return (
    <Suspense fallback={<div style={{ padding: '32px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>Loading…</div>}>
      <ReportPageInner />
    </Suspense>
  )
}
