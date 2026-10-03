'use client'

// ReceiptDashboard — the visual top half of the CORTEX intelligence receipt (Base Radar + Robinhood
// Radar). Reads in hierarchy order: what is the risk (summary strip) → why (findings) → what is still
// open (checks matrix + evidence ring) → what to do (action tiles). Pure presentation over
// lib/radarReceiptDashboard.ts; no data fetching, no new client dependencies (inline SVG only).

import type { ReactNode } from 'react'
import type { ReceiptAction, ReceiptCheck, ReceiptDashboard, ReceiptFinding, ReceiptStatus, ReceiptTone } from '@/lib/radarReceiptDashboard'

// Accent discipline: teal = confirmed, red = warning/risk, amber = unresolved, purple/slate = unavailable.
export const STATUS_COLOR: Record<ReceiptStatus, string> = {
  confirmed: '#2dd4bf',
  warning: '#f0868a',
  unknown: '#fbbf24',
  unavailable: '#a5a0d6',
  loading: '#475569',
}
const STATUS_LABEL: Record<ReceiptStatus, string> = { confirmed: 'Confirmed', warning: 'Warning', unknown: 'Unknown', unavailable: 'Unavailable', loading: 'Checking' }
const TONE_COLOR: Record<ReceiptTone, string> = { mint: '#2dd4bf', amber: '#fbbf24', risk: '#f0868a', neutral: '#94a3b8' }
const mono = 'var(--font-plex-mono)'

// ─── Primitives ─────────────────────────────────────────────────────────────────────────────────
export function StatusDot({ status, size = 6 }: { status: ReceiptStatus; size?: number }) {
  return <span aria-hidden className={status === 'loading' ? 'rd-pulse' : undefined} style={{ width: size, height: size, borderRadius: 999, flexShrink: 0, background: STATUS_COLOR[status], boxShadow: status === 'warning' ? `0 0 0 3px ${STATUS_COLOR.warning}1f` : 'none' }} />
}

/** Compact status value (matrix right-hand side). */
export function StatusChip({ status, label }: { status: ReceiptStatus; label: string }) {
  const c = STATUS_COLOR[status]
  return (
    <span title={STATUS_LABEL[status]} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 6, background: `${c}14`, color: status === 'loading' ? '#64748b' : c, fontSize: 10.5, fontWeight: 700, fontFamily: mono, whiteSpace: 'nowrap' }}>
      <StatusDot status={status} size={5} />{label}
    </span>
  )
}

/** Hero evidence chip: the 3–5 signals a user should see first. */
export function EvidenceChip({ status, label }: { status: ReceiptStatus; label: string }) {
  const c = STATUS_COLOR[status]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999, border: `1px solid ${c}33`, background: `${c}0d`, color: status === 'confirmed' ? '#99f6e4' : status === 'warning' ? '#fecaca' : '#e2e8f0', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <StatusDot status={status} size={5} />{label}
    </span>
  )
}

export function SummaryStatCard({ eyebrow, tone, children, footer }: { eyebrow: string; tone: ReceiptTone; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="rd-card" style={{ position: 'relative', padding: '12px 14px 12px', borderRadius: 12, background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.012))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)', minWidth: 0, overflow: 'hidden' }}>
      <span aria-hidden style={{ position: 'absolute', left: 0, top: 12, bottom: 12, width: 2, borderRadius: 2, background: TONE_COLOR[tone], opacity: 0.75 }} />
      <p style={{ margin: '0 0 8px', color: '#64748b', fontSize: 9, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', fontFamily: mono }}>{eyebrow}</p>
      {children}
      {footer ? <div style={{ marginTop: 8 }}>{footer}</div> : null}
    </div>
  )
}

/** Confirmed / warning / unresolved ring — drawn only from the real check counts. */
export function EvidenceRing({ confirmed, warning, unresolved, size = 46 }: { confirmed: number; warning: number; unresolved: number; size?: number }) {
  const total = confirmed + warning + unresolved
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const parts = total === 0 ? [] : [
    { n: confirmed, c: STATUS_COLOR.confirmed },
    { n: warning, c: STATUS_COLOR.warning },
    { n: unresolved, c: STATUS_COLOR.unknown },
  ].filter(p => p.n > 0)
  let offset = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${confirmed} confirmed, ${warning} warnings, ${unresolved} unresolved`} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={5} />
      {parts.map((p, idx) => {
        const len = (p.n / total) * circ
        const gap = parts.length > 1 ? Math.min(2, len / 3) : 0
        const el = <circle key={idx} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.c} strokeWidth={5} strokeDasharray={`${Math.max(0, len - gap)} ${circ}`} strokeDashoffset={-offset} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="butt" />
        offset += len
        return el
      })}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="700" fontFamily="var(--font-plex-mono)">{confirmed}/{total}</text>
    </svg>
  )
}

const FINDING_ICON: Record<string, ReactNode> = {
  control: <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm6.5-1a2.5 2.5 0 1 0 0-5M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M15 14.6c2 .2 3.6 1.6 4.3 4.4" />,
  liquidity: <path d="M12 3.5c3 3.6 5.5 6.6 5.5 9.6a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-9.6Z" />,
  trading: <path d="M4 8h13l-3-3M20 16H7l3 3" />,
  metadata: <path d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm-8.5 8.5h17M12 3.5c2.3 2.5 3.4 5.4 3.4 8.5S14.3 18 12 20.5C9.7 18 8.6 15.1 8.6 12S9.7 6 12 3.5Z" />,
}

export function FindingCard({ finding }: { finding: ReceiptFinding }) {
  const c = STATUS_COLOR[finding.status]
  return (
    <div className="rd-card rd-finding" style={{ display: 'grid', gridTemplateColumns: '30px minmax(0,1fr)', gap: 11, padding: '12px 13px', borderRadius: 12, background: 'rgba(2,6,23,0.42)', boxShadow: `inset 0 0 0 1px ${finding.status === 'warning' ? `${c}2e` : 'rgba(148,163,184,0.09)'}` }}>
      <span aria-hidden style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: `${c}12`, color: c }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{FINDING_ICON[finding.id]}</svg>
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <p style={{ margin: 0, color: '#e2e8f0', fontSize: 12.5, fontWeight: 650 }}>{finding.title}</p>
          <StatusChip status={finding.status} label={STATUS_LABEL[finding.status]} />
        </div>
        <p className={finding.status === 'loading' ? 'rd-shimmer' : undefined} style={{ margin: '5px 0 0', color: '#94a3b8', fontSize: 12, lineHeight: 1.45 }}>{finding.summary}</p>
        {finding.metric ? <p style={{ margin: '7px 0 0', color: '#cbd5e1', fontSize: 11, fontFamily: mono, fontWeight: 600 }}>{finding.metric}</p> : null}
      </div>
    </div>
  )
}

export function ActionCard({ action, href, onClick, done }: { action: ReceiptAction; href?: string; onClick?: () => void; done?: boolean }) {
  const content = (
    <>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: action.emphasis ? '#5eead4' : '#e2e8f0', fontSize: 12.5, fontWeight: 650 }}>{done ? '✓ Watching' : action.title}</span>
        <span aria-hidden style={{ color: action.emphasis ? '#5eead4' : '#64748b', fontSize: 13 }}>{href ? '↗' : '→'}</span>
      </span>
      <span style={{ display: 'block', marginTop: 4, color: '#64748b', fontSize: 11, lineHeight: 1.4 }}>{action.caption}</span>
    </>
  )
  const style: React.CSSProperties = {
    display: 'block', textAlign: 'left', textDecoration: 'none', cursor: 'pointer', width: '100%', padding: '11px 13px', borderRadius: 11,
    border: `1px solid ${action.emphasis ? 'rgba(45,212,191,0.34)' : 'rgba(148,163,184,0.14)'}`,
    background: action.emphasis ? 'rgba(45,212,191,0.07)' : 'rgba(255,255,255,0.02)', font: 'inherit',
  }
  return href
    ? <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="rd-action btn-instant" style={style}>{content}</a>
    : <button type="button" onClick={onClick} className="rd-action btn-instant" style={style} aria-pressed={done || undefined}>{content}</button>
}

function SectionLabel({ children, count }: { children: ReactNode; count?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '0 0 9px' }}>
      <p style={{ margin: 0, color: '#cbd5e1', fontSize: 10.5, fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', fontFamily: mono }}>{children}</p>
      {count ? <span style={{ color: '#475569', fontSize: 10.5, fontFamily: mono }}>{count}</span> : null}
    </div>
  )
}

function CheckRow({ check }: { check: ReceiptCheck }) {
  return (
    <div className="rd-check" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 10px', borderRadius: 8 }}>
      <span style={{ color: '#94a3b8', fontSize: 12 }}>{check.label}</span>
      <StatusChip status={check.status} label={check.value} />
    </div>
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────────────────────────
export function ReceiptSummaryStrip({ d }: { d: ReceiptDashboard }) {
  const s = d.summary
  return (
    <div className="rd-strip" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
      <SummaryStatCard eyebrow="Radar score" tone={s.score.tone} footer={<span style={{ display: 'block', height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${s.score.value}%`, background: TONE_COLOR[s.score.tone], opacity: 0.85 }} /></span>}>
        <p style={{ margin: 0, color: '#f8fafc', fontSize: 24, fontWeight: 700, fontFamily: mono, lineHeight: 1 }}>{s.score.value}<span style={{ color: '#475569', fontSize: 12, fontWeight: 500 }}>/100</span></p>
        <p style={{ margin: '5px 0 0', color: TONE_COLOR[s.score.tone], fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', fontFamily: mono }}>{s.score.label}</p>
      </SummaryStatCard>
      <SummaryStatCard eyebrow="Evidence confidence" tone={s.confidence.tone}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <EvidenceRing confirmed={s.confidence.confirmed} warning={s.confidence.warning} unresolved={s.confidence.unresolved} />
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, color: '#f1f5f9', fontSize: 13, fontWeight: 650, lineHeight: 1.2 }}>{s.confidence.label}</p>
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 10.5, fontFamily: mono }}>{s.confidence.confirmed} confirmed</p>
          </div>
        </div>
      </SummaryStatCard>
      <SummaryStatCard eyebrow="Open checks" tone={s.openChecks.count === 0 ? 'mint' : s.openChecks.count <= 2 ? 'amber' : 'risk'}>
        <p style={{ margin: 0, color: '#f8fafc', fontSize: 24, fontWeight: 700, fontFamily: mono, lineHeight: 1 }}>{s.openChecks.count}</p>
        <p style={{ margin: '5px 0 0', color: s.openChecks.riskFacts > 0 ? '#fecaca' : '#64748b', fontSize: 10.5, fontFamily: mono }}>{s.openChecks.riskFacts > 0 ? `${s.openChecks.riskFacts} risk fact${s.openChecks.riskFacts === 1 ? '' : 's'}` : 'evidence gaps'}</p>
      </SummaryStatCard>
      <SummaryStatCard eyebrow="Main concern" tone={s.mainConcern.tone}>
        <p className="rd-clamp" title={s.mainConcern.text} style={{ margin: 0, color: s.mainConcern.tone === 'risk' ? '#fecaca' : '#e2e8f0', fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>{s.mainConcern.text}</p>
      </SummaryStatCard>
    </div>
  )
}

export function ReceiptFindings({ d }: { d: ReceiptDashboard }) {
  return (
    <section style={{ marginBottom: 14 }}>
      <SectionLabel count={`${d.findings.filter(f => f.status === 'warning').length} flagged`}>Key findings</SectionLabel>
      <div className="rd-findings" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
        {d.findings.map(f => <FindingCard key={f.id} finding={f} />)}
      </div>
    </section>
  )
}

export function ReceiptChecksMatrix({ d }: { d: ReceiptDashboard }) {
  const resolved = d.checks.filter(c => c.status === 'confirmed').length
  // Unresolved first so the gaps lead; confirmed rows stay visible below them.
  const order: Record<ReceiptStatus, number> = { warning: 0, unknown: 1, unavailable: 2, loading: 3, confirmed: 4 }
  const rows = [...d.checks].sort((a, b) => order[a.status] - order[b.status])
  return (
    <section style={{ marginBottom: 14 }}>
      <SectionLabel count={`${resolved}/${d.checks.length} confirmed`}>Evidence checks</SectionLabel>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '0 0 8px' }}>
        {(['confirmed', 'warning', 'unknown', 'unavailable'] as ReceiptStatus[]).map(s => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#64748b', fontSize: 10, fontFamily: mono }}><StatusDot status={s} size={5} />{STATUS_LABEL[s]}</span>
        ))}
      </div>
      <div className="rd-matrix" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '2px 10px', padding: 4, borderRadius: 12, background: 'rgba(2,6,23,0.35)' }}>
        {rows.map(c => <CheckRow key={c.id} check={c} />)}
      </div>
    </section>
  )
}

export function ReceiptActions({ d, hrefFor, onWatchlist, watching }: { d: ReceiptDashboard; hrefFor: (id: ReceiptAction['id']) => string | undefined; onWatchlist?: () => void; watching?: boolean }) {
  const actions = d.actions.filter(a => a.id !== 'watchlist' || onWatchlist)
  return (
    <section style={{ marginBottom: 14 }}>
      <SectionLabel>Next actions</SectionLabel>
      <div className="rd-actions" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
        {actions.map(a => a.id === 'watchlist'
          ? <ActionCard key={a.id} action={a} onClick={onWatchlist} done={watching} />
          : <ActionCard key={a.id} action={a} href={hrefFor(a.id)} />)}
      </div>
    </section>
  )
}

/** Shared styles for the dashboard (one block, scoped by rd- class names). */
export const RECEIPT_DASHBOARD_CSS = `
.rd-card { transition: box-shadow .15s ease, background-color .15s ease; }
.rd-finding:hover { background: rgba(2,6,23,0.6) !important; }
.rd-check:nth-child(odd) { background: rgba(255,255,255,0.015); }
.rd-action:hover { border-color: rgba(45,212,191,0.45) !important; background: rgba(45,212,191,0.06) !important; }
.rd-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.rd-pulse { animation: rdPulse 1.2s ease-in-out infinite; }
.rd-shimmer { color: #475569 !important; }
@keyframes rdPulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
@media (max-width: 720px) { .rd-strip { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
@media (max-width: 560px) { .rd-findings, .rd-matrix, .rd-actions { grid-template-columns: 1fr !important; } }
@media (prefers-reduced-motion: reduce) { .rd-pulse { animation: none; } }
`
