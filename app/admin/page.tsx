'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'
import type { AdminData, AffiliateWithStats } from '@/app/api/admin/data/route'

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtUsd(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return 'N/A'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`
  return `$${v.toFixed(2)}`
}

function fmtPct(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return 'N/A'
  return `${(v * 100).toFixed(0)}%`
}

function fmtConv(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return '0%'
  return `${(v * 100).toFixed(1)}%`
}

function fmtDate(s: unknown): string {
  if (!s || typeof s !== 'string') return '—'
  try {
    return new Date(s).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return String(s).slice(0, 16)
  }
}

function fmtAge(s: unknown): string {
  if (!s || typeof s !== 'string') return '—'
  try {
    const diff = Date.now() - new Date(s).getTime()
    const h = Math.floor(diff / 3_600_000)
    if (h < 1)  return 'Just now'
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d ago`
    return `${Math.floor(d / 30)}mo ago`
  } catch { return '—' }
}

function shorten(s: unknown, len = 16): string {
  const str = String(s ?? '—')
  if (str.length <= len) return str
  return `${str.slice(0, 8)}…${str.slice(-6)}`
}

// ─── Status badges ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
  confirmed:  { color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  finished:   { color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  approved:   { color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  active:     { color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  paid:       { color: '#67e8f9', bg: 'rgba(103,232,249,0.10)', border: 'rgba(103,232,249,0.3)'  },
  pending:    { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.3)'  },
  created:    { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
  failed:     { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.3)'  },
  expired:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.3)'  },
  cancelled:  { color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.2)'  },
  rejected:   { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.3)'  },
}

function StatusBadge({ status }: { status: unknown }) {
  const s = String(status ?? 'unknown').toLowerCase()
  const c = STATUS_COLORS[s] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.2)' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: '999px',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
      fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
      color: c.color, background: c.bg, border: `1px solid ${c.border}`,
    }}>
      {s.toUpperCase()}
    </span>
  )
}

const PAYMENT_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  created:   { label: 'UNPAID',    color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.32)'  },
  waiting:   { label: 'WAITING',   color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.32)'  },
  pending:   { label: 'PENDING',   color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)'  },
  confirmed: { label: 'CONFIRMED', color: '#34d399', bg: 'rgba(52,211,153,0.14)',  border: 'rgba(52,211,153,0.40)'  },
  finished:  { label: 'PAID',      color: '#34d399', bg: 'rgba(52,211,153,0.14)',  border: 'rgba(52,211,153,0.40)'  },
  failed:    { label: 'FAILED',    color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)' },
  expired:   { label: 'EXPIRED',   color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.22)' },
  cancelled: { label: 'CANCELLED', color: '#64748b', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.22)' },
}

function PaymentStatusBadge({ status }: { status: unknown }) {
  const s = String(status ?? '').toLowerCase()
  const c = PAYMENT_BADGE[s] ?? { label: s.toUpperCase() || 'UNKNOWN', color: '#94a3b8', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.2)' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: '999px',
      fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
      fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
      color: c.color, background: c.bg, border: `1px solid ${c.border}`,
    }}>
      {c.label}
    </span>
  )
}

function paymentAmountColor(status: unknown): string {
  const s = String(status ?? '').toLowerCase()
  if (s === 'confirmed' || s === 'finished') return '#34d399'
  if (s === 'failed' || s === 'expired' || s === 'cancelled') return '#475569'
  return '#94a3b8'
}

// ─── Shared style helpers ─────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(10,18,34,.92), rgba(3,8,19,.9))',
  border: '1px solid rgba(148,163,184,.16)',
  borderRadius: '14px',
  padding: '20px 22px',
}

const tableWrap: React.CSSProperties = {
  overflowX: 'auto',
  borderRadius: '10px',
  border: '1px solid rgba(148,163,184,.12)',
}

const th: React.CSSProperties = {
  padding: '9px 14px', textAlign: 'left',
  fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em',
  color: '#3a5268', textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(148,163,184,.1)',
  background: 'rgba(255,255,255,0.02)',
}

const td: React.CSSProperties = {
  padding: '10px 14px', fontSize: '12px', color: '#cbd5e1',
  fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
}

const sectionLabel: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, letterSpacing: '0.16em',
  color: '#2DD4BF', textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)', marginBottom: '12px',
}

function SectionHeader({ label, count, sub }: { label: string; count?: number; sub?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
      <p style={sectionLabel}>{label}</p>
      {count != null && (
        <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'var(--font-plex-mono)' }}>
          {count} rows
        </span>
      )}
      {sub && <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{sub}</span>}
    </div>
  )
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} style={{ ...td, color: '#1e3a44', textAlign: 'center', padding: '24px' }}>
        No data yet.
      </td>
    </tr>
  )
}

// ─── Metric card ──────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, accent = '#2DD4BF' }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{ ...card, padding: '18px 20px', borderTop: `2px solid ${accent}44` }}>
      <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: 0 }}>
        {label}
      </p>
      <p style={{ fontSize: '24px', fontWeight: 800, color: accent, fontFamily: 'var(--font-plex-mono)', margin: '10px 0 0' }}>
        {value}
      </p>
      {sub && <p style={{ margin: '4px 0 0', fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{sub}</p>}
    </div>
  )
}

// ─── Loading / gate states ────────────────────────────────────────────────────

function FullPageMessage({ title, sub, color = '#64748b' }: { title: string; sub?: string; color?: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 20% 0%, rgba(20,35,68,.45), rgba(2,6,23,1) 55%)' }}>
      <p style={{ fontSize: '18px', fontWeight: 700, color, fontFamily: 'var(--font-plex-mono)' }}>{title}</p>
      {sub && <p style={{ marginTop: '8px', fontSize: '13px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>{sub}</p>}
    </div>
  )
}

// ─── Shared components ────────────────────────────────────────────────────────

function TestBadge() {
  return (
    <span style={{
      display: 'inline-block', marginLeft: '6px', padding: '1px 7px',
      borderRadius: '999px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.10em',
      fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap', verticalAlign: 'middle',
      color: '#f59e0b', background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.30)',
    }}>
      TEST
    </span>
  )
}

function FilterBar({
  filters, active, onSelect,
}: { filters: { key: string; label: string }[]; active: string; onSelect: (k: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
      {filters.map((f) => (
        <button
          key={f.key}
          onClick={() => onSelect(f.key)}
          style={{
            padding: '4px 12px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
            border: active === f.key ? '1px solid rgba(45,212,191,0.5)' : '1px solid rgba(148,163,184,0.15)',
            background: active === f.key ? 'rgba(45,212,191,0.10)' : 'transparent',
            color: active === f.key ? '#2DD4BF' : '#475569',
            transition: 'all 0.1s',
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

// ─── Plan Breakdown ───────────────────────────────────────────────────────────

function PlanBreakdown({ metrics }: { metrics: AdminData['metrics'] }) {
  const plans = [
    {
      label: 'PRO',
      accent: '#a78bfa',
      confirmed: metrics.proConfirmedCount,
      revenue: metrics.proConfirmedRevenueUsd,
      unpaid: metrics.proUnpaidCount,
    },
    {
      label: 'ELITE',
      accent: '#2DD4BF',
      confirmed: metrics.eliteConfirmedCount,
      revenue: metrics.eliteConfirmedRevenueUsd,
      unpaid: metrics.eliteUnpaidCount,
    },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
      {plans.map((p) => (
        <div key={p.label} style={{ ...card, borderTop: `2px solid ${p.accent}44`, padding: '18px 20px' }}>
          <p style={{ margin: '0 0 14px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.18em', color: p.accent, fontFamily: 'var(--font-plex-mono)' }}>
            {p.label} PLAN
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
            {[
              { label: 'Confirmed Sales', value: p.confirmed.toLocaleString(), color: '#34d399' },
              { label: 'Revenue',         value: fmtUsd(p.revenue),            color: '#34d399' },
              { label: 'Unpaid Attempts', value: p.unpaid.toLocaleString(),     color: p.unpaid > 0 ? '#fbbf24' : '#3a5268' },
            ].map((item) => (
              <div key={item.label}>
                <p style={{ margin: '0 0 4px', fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.10em' }}>{item.label}</p>
                <p style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: item.color, fontFamily: 'var(--font-plex-mono)' }}>{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Checkout Funnel ──────────────────────────────────────────────────────────

function CheckoutFunnel({ metrics }: { metrics: AdminData['metrics'] }) {
  const total = metrics.totalCheckoutAttempts || 1
  const stages = [
    { label: 'Confirmed / Paid',  count: metrics.funnelConfirmed, color: '#34d399', pct: metrics.funnelConfirmed / total },
    { label: 'Failed / Expired',  count: metrics.funnelFailed,   color: '#f87171', pct: metrics.funnelFailed / total   },
    { label: 'Open / Unpaid',     count: metrics.funnelUnpaid,   color: '#fbbf24', pct: metrics.funnelUnpaid / total   },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '6px' }}>
        <div style={{ ...card, padding: '14px 16px', borderTop: '2px solid rgba(45,212,191,0.4)' }}>
          <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em' }}>CHECKOUT STARTED</p>
          <p style={{ margin: 0, fontSize: '26px', fontWeight: 800, color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}>{metrics.totalCheckoutAttempts.toLocaleString()}</p>
          <p style={{ margin: '3px 0 0', fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>all statuses · all accounts</p>
        </div>
        {stages.map((s) => (
          <div key={s.label} style={{ ...card, padding: '14px 16px', borderTop: `2px solid ${s.color}44` }}>
            <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{s.label}</p>
            <p style={{ margin: 0, fontSize: '26px', fontWeight: 800, color: s.color, fontFamily: 'var(--font-plex-mono)' }}>{s.count.toLocaleString()}</p>
            <p style={{ margin: '3px 0 0', fontSize: '9px', color: s.color + '80', fontFamily: 'var(--font-plex-mono)' }}>{(s.pct * 100).toFixed(1)}% of total</p>
          </div>
        ))}
        <div style={{ ...card, padding: '14px 16px', borderTop: '2px solid rgba(52,211,153,0.6)' }}>
          <p style={{ margin: '0 0 6px', fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.12em' }}>REAL CONVERSION</p>
          <p style={{ margin: 0, fontSize: '26px', fontWeight: 800, color: '#34d399', fontFamily: 'var(--font-plex-mono)' }}>{fmtConv(metrics.realConversionRate)}</p>
          <p style={{ margin: '3px 0 0', fontSize: '9px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>real customers only · excl. test</p>
        </div>
      </div>
      {/* Visual bar */}
      <div style={{ height: '8px', borderRadius: '999px', overflow: 'hidden', display: 'flex', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(148,163,184,0.1)' }}>
        {stages.map((s) => (
          <div key={s.label} style={{ width: `${s.pct * 100}%`, background: s.color, transition: 'width 0.5s ease', minWidth: s.count > 0 ? '2px' : '0' }} />
        ))}
      </div>
      <p style={{ margin: 0, fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
        Funnel counts include all accounts. Real conversion rate excludes internal/test emails.
      </p>
    </div>
  )
}

// ─── Recent Confirmed Sales ───────────────────────────────────────────────────

function ConfirmedSalesTable({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Time', 'Email', 'Plan', 'Amount', 'Referral Code', 'Affiliate', 'Status'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={7} />}
          {rows.map((p, i) => (
            <tr key={i}>
              <td style={{ ...td, color: '#64748b' }}>{fmtDate(p.created_at)}</td>
              <td style={td}>
                {String(p.user_email ?? '—')}
                {!!p._isInternal && <TestBadge />}
              </td>
              <td style={{ ...td, color: '#a78bfa', textTransform: 'uppercase' }}>{String(p.plan ?? '—')}</td>
              <td style={{ ...td, color: '#34d399', fontWeight: 700 }}>{fmtUsd(p.amount_usd)}</td>
              <td style={{ ...td, color: '#67e8f9' }}>{p.referral_code ? String(p.referral_code) : <span style={{ color: '#1e3a44' }}>None</span>}</td>
              <td style={{ ...td, color: p.affiliate_id ? '#34d399' : '#1e3a44' }}>{p.affiliate_id ? 'Yes' : 'No'}</td>
              <td style={td}><PaymentStatusBadge status={p.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Checkout Abandonment ─────────────────────────────────────────────────────

function AbandonmentTable({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Created', 'Age', 'Email', 'Plan', 'Amount', 'Status', 'Referral Code', 'Affiliate'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={8} />}
          {rows.map((p, i) => (
            <tr key={i}>
              <td style={{ ...td, color: '#64748b' }}>{fmtDate(p.created_at)}</td>
              <td style={{ ...td, color: '#f59e0b' }}>{fmtAge(p.created_at)}</td>
              <td style={td}>
                {String(p.user_email ?? '—')}
                {!!p._isInternal && <TestBadge />}
              </td>
              <td style={{ ...td, color: '#a78bfa', textTransform: 'uppercase' }}>{String(p.plan ?? '—')}</td>
              <td style={{ ...td, color: '#94a3b8' }}>{fmtUsd(p.amount_usd)}</td>
              <td style={td}><PaymentStatusBadge status={p.status} /></td>
              <td style={{ ...td, color: '#67e8f9' }}>{p.referral_code ? String(p.referral_code) : <span style={{ color: '#1e3a44' }}>None</span>}</td>
              <td style={{ ...td, color: p.affiliate_id ? '#34d399' : '#1e3a44' }}>{p.affiliate_id ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Affiliate Leaderboard ────────────────────────────────────────────────────

function AffiliateLeaderboardTable({ rows }: { rows: AffiliateWithStats[] }) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['#', 'Email', 'Code', 'Rate', 'Status', 'Checkouts', 'Confirmed Sales', 'Revenue', 'Pending Owed', 'Paid Total', 'Conv.'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={11} />}
          {rows.map((a, i) => (
            <tr key={i}>
              <td style={{ ...td, color: '#3a5268', fontWeight: 700 }}>{i + 1}</td>
              <td style={td}>{String(a.email ?? '—')}</td>
              <td style={{ ...td, color: '#a78bfa' }}>{String(a.referral_code ?? '—')}</td>
              <td style={{ ...td, color: '#2DD4BF' }}>{fmtPct(a.commission_rate)}</td>
              <td style={td}><StatusBadge status={a.status} /></td>
              <td style={{ ...td, color: '#cbd5e1', fontWeight: 700 }}>{Number(a.referredCheckoutCount).toLocaleString()}</td>
              <td style={{ ...td, color: Number(a.confirmedSalesCount) > 0 ? '#34d399' : '#3a5268', fontWeight: 700 }}>{Number(a.confirmedSalesCount).toLocaleString()}</td>
              <td style={{ ...td, color: Number(a.confirmedRevenueUsd) > 0 ? '#34d399' : '#3a5268', fontWeight: 700 }}>{fmtUsd(a.confirmedRevenueUsd)}</td>
              <td style={{ ...td, color: Number(a.pendingCommissionOwed) > 0 ? '#fbbf24' : '#3a5268', fontWeight: 700 }}>{fmtUsd(a.pendingCommissionOwed)}</td>
              <td style={{ ...td, color: Number(a.paidCommissionUsd) > 0 ? '#67e8f9' : '#3a5268', fontWeight: 700 }}>{fmtUsd(a.paidCommissionUsd)}</td>
              <td style={{ ...td, color: Number(a.affiliateConversionRate) > 0 ? '#2DD4BF' : '#3a5268' }}>{fmtConv(a.affiliateConversionRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Pending Payouts ──────────────────────────────────────────────────────────

type PayoutRow = { affiliateId: string; email: string; code: string; total: number; count: number; oldest: string | null }

function PendingPayoutsTable({ rows }: { rows: PayoutRow[] }) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Affiliate Email', 'Code', 'Pending Total', 'Commissions', 'Oldest Commission'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={5} />}
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={td}>{r.email}</td>
              <td style={{ ...td, color: '#a78bfa' }}>{r.code}</td>
              <td style={{ ...td, color: '#fbbf24', fontWeight: 700 }}>{fmtUsd(r.total)}</td>
              <td style={{ ...td, color: '#cbd5e1' }}>{r.count}</td>
              <td style={{ ...td, color: '#64748b' }}>{fmtDate(r.oldest)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── All-payments table (existing, with extended filters) ─────────────────────

function PaymentsTable({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Time', 'Email', 'Plan', 'Amount', 'Status', 'Referral Code', 'Affiliate'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={7} />}
          {rows.map((p, i) => (
            <tr key={i}>
              <td style={{ ...td, color: '#64748b' }}>{fmtDate(p.created_at)}</td>
              <td style={td}>
                {String(p.user_email ?? '—')}
                {!!p._isInternal && <TestBadge />}
              </td>
              <td style={{ ...td, color: '#a78bfa', textTransform: 'uppercase' }}>{String(p.plan ?? '—')}</td>
              <td style={{ ...td, color: paymentAmountColor(p.status), fontWeight: 700 }}>{fmtUsd(p.amount_usd)}</td>
              <td style={td}><PaymentStatusBadge status={p.status} /></td>
              <td style={{ ...td, color: '#67e8f9' }}>{p.referral_code ? String(p.referral_code) : <span style={{ color: '#1e3a44' }}>None</span>}</td>
              <td style={{ ...td, color: p.affiliate_id ? '#34d399' : '#1e3a44' }}>{p.affiliate_id ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Applications table ───────────────────────────────────────────────────────

function ApplicationsTable({ rows, onAction, pendingId }: {
  rows: Record<string, unknown>[]
  onAction: (action: string, id: string, confirmMsg: string) => void
  pendingId: string | null
}) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Time', 'Name', 'Email', 'X Handle', 'Audience Size', 'Status', 'Referral Code', 'Actions'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={8} />}
          {rows.map((a, i) => {
            const id = String(a.id ?? '')
            const busy = pendingId === id
            return (
              <tr key={i}>
                <td style={{ ...td, color: '#64748b' }}>{fmtDate(a.created_at)}</td>
                <td style={td}>{String(a.name ?? '—')}</td>
                <td style={td}>{String(a.email ?? '—')}</td>
                <td style={{ ...td, color: '#67e8f9' }}>{a.x_handle ? `@${a.x_handle}` : '—'}</td>
                <td style={{ ...td, color: '#94a3b8' }}>{a.audience_size ? Number(a.audience_size).toLocaleString() : '—'}</td>
                <td style={td}><StatusBadge status={a.status} /></td>
                <td style={{ ...td, color: '#a78bfa' }}>{String(a.referral_code ?? '—')}</td>
                <td style={td}>
                  {a.status === 'pending' && id ? (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        disabled={busy}
                        onClick={() => onAction('approve_affiliate', id, `Approve affiliate ${String(a.email ?? id)}?`)}
                        style={{ padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(52,211,153,0.35)', background: busy ? 'rgba(52,211,153,0.04)' : 'rgba(52,211,153,0.10)', color: '#34d399', fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, letterSpacing: '0.06em' }}
                      >
                        {busy ? '…' : 'APPROVE'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => onAction('reject_affiliate', id, `Reject affiliate ${String(a.email ?? id)}?`)}
                        style={{ padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(248,113,113,0.35)', background: busy ? 'rgba(248,113,113,0.04)' : 'rgba(248,113,113,0.10)', color: '#f87171', fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, letterSpacing: '0.06em' }}
                      >
                        {busy ? '…' : 'REJECT'}
                      </button>
                    </div>
                  ) : (
                    <span style={{ color: '#1e3a44', fontSize: '10px', fontFamily: 'var(--font-plex-mono)' }}>—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Commissions table ────────────────────────────────────────────────────────

function CommissionsTable({ rows, onAction, pendingId }: {
  rows: Record<string, unknown>[]
  onAction: (action: string, id: string, confirmMsg: string) => void
  pendingId: string | null
}) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Time', 'Affiliate ID', 'Buyer Email', 'Payment Amt', 'Rate', 'Commission', 'Status', 'Paid At', 'Actions'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={9} />}
          {rows.map((c, i) => {
            const id     = String(c.id ?? '')
            const busy   = pendingId === id
            const status = String(c.status ?? '').toLowerCase()
            return (
              <tr key={i}>
                <td style={{ ...td, color: '#64748b' }}>{fmtDate(c.created_at)}</td>
                <td style={{ ...td, color: '#94a3b8' }}>{shorten(c.affiliate_id, 14)}</td>
                <td style={td}>
                  {String(c.buyer_email ?? '—')}
                  {!!c._isTestPayment && <TestBadge />}
                </td>
                <td style={{ ...td, color: '#34d399' }}>{fmtUsd(c.payment_amount_usd)}</td>
                <td style={{ ...td, color: '#2DD4BF' }}>{fmtPct(c.commission_rate)}</td>
                <td style={{ ...td, color: '#fbbf24', fontWeight: 700 }}>{fmtUsd(c.commission_amount)}</td>
                <td style={td}><StatusBadge status={c.status} /></td>
                <td style={{ ...td, color: '#64748b' }}>{c.paid_at ? fmtDate(c.paid_at) : '—'}</td>
                <td style={td}>
                  {id && status === 'pending' && (
                    <button
                      disabled={busy}
                      onClick={() => onAction('mark_commission_paid', id, `Mark commission ${fmtUsd(c.commission_amount)} as paid?`)}
                      style={{ padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(103,232,249,0.35)', background: busy ? 'rgba(103,232,249,0.04)' : 'rgba(103,232,249,0.10)', color: '#67e8f9', fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, letterSpacing: '0.06em' }}
                    >
                      {busy ? '…' : 'MARK PAID'}
                    </button>
                  )}
                  {id && status === 'paid' && (
                    <button
                      disabled={busy}
                      onClick={() => onAction('mark_commission_pending', id, `Revert commission ${fmtUsd(c.commission_amount)} to pending?`)}
                      style={{ padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(251,191,36,0.30)', background: busy ? 'rgba(251,191,36,0.04)' : 'rgba(251,191,36,0.08)', color: '#fbbf24', fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-plex-mono)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, letterSpacing: '0.06em' }}
                    >
                      {busy ? '…' : 'REVERT'}
                    </button>
                  )}
                  {(!id || (status !== 'pending' && status !== 'paid')) && (
                    <span style={{ color: '#1e3a44', fontSize: '10px', fontFamily: 'var(--font-plex-mono)' }}>—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Referred Users table ─────────────────────────────────────────────────────

function ReferredUsersTable({ rows }: { rows: Record<string, unknown>[] }) {
  return (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['User ID', 'Plan', 'Sub Status', 'Referred By (Affiliate ID)', 'Created', 'Updated'].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={6} />}
          {rows.map((u, i) => (
            <tr key={i}>
              <td style={{ ...td, color: '#94a3b8' }}>{shorten(u.user_id, 16)}</td>
              <td style={{ ...td, color: '#a78bfa', textTransform: 'uppercase' }}>{String(u.plan ?? '—')}</td>
              <td style={td}><StatusBadge status={u.subscription_status ?? 'free'} /></td>
              <td style={{ ...td, color: '#67e8f9' }}>{shorten(u.referred_by_affiliate_id, 16)}</td>
              <td style={{ ...td, color: '#64748b' }}>{fmtDate(u.created_at)}</td>
              <td style={{ ...td, color: '#64748b' }}>{fmtDate(u.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ msg, ok, onDismiss }: { msg: string; ok: boolean; onDismiss: () => void }) {
  return (
    <div style={{
      position: 'fixed', bottom: '28px', right: '28px', zIndex: 9999,
      padding: '12px 18px', borderRadius: '10px',
      background: ok ? 'rgba(10,25,15,0.97)' : 'rgba(25,10,10,0.97)',
      border: `1px solid ${ok ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)'}`,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '340px',
    }}>
      <span style={{ fontSize: '13px', color: ok ? '#34d399' : '#f87171', fontFamily: 'var(--font-plex-mono)', fontWeight: 600 }}>{ok ? 'OK' : 'ERR'}</span>
      <span style={{ fontSize: '12px', color: '#cbd5e1', fontFamily: 'var(--font-plex-mono)', flex: 1 }}>{msg}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: '#3a5268', cursor: 'pointer', fontSize: '14px', padding: '0 4px', lineHeight: 1 }}>x</button>
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ data, adminEmail, onRefresh, lastRefresh, refreshing, token }: {
  data: AdminData
  adminEmail: string
  onRefresh: () => void
  lastRefresh: Date | null
  refreshing: boolean
  token: string
}) {
  const { metrics, payments, pendingApplications, approvedAffiliates, commissions, referredUsers } = data
  const [pendingId, setPendingId]           = useState<string | null>(null)
  const [toast, setToast]                   = useState<{ msg: string; ok: boolean } | null>(null)
  const [payFilter, setPayFilter]           = useState<string>('all')
  const [planFilter, setPlanFilter]         = useState<string>('all')
  const [statusFilter, setStatusFilter]     = useState<string>('all')
  const [affiliateFilter, setAffiliateFilter] = useState<string>('all')

  // Derived views
  const confirmedPayments = payments.filter((p) => {
    const s = String(p.status ?? '').toLowerCase()
    return s === 'confirmed' || s === 'finished'
  })

  const unpaidPayments = payments.filter((p) => {
    const s = String(p.status ?? '').toLowerCase()
    return s === 'created' || s === 'waiting' || s === 'pending'
  })

  const filteredPayments = payments
    .filter((p) => payFilter === 'all' ? true : payFilter === 'real' ? !p._isInternal : !!p._isInternal)
    .filter((p) => planFilter === 'all' ? true : String(p.plan ?? '').toLowerCase() === planFilter)
    .filter((p) => {
      if (statusFilter === 'all') return true
      const s = String(p.status ?? '').toLowerCase()
      if (statusFilter === 'confirmed') return s === 'confirmed' || s === 'finished'
      if (statusFilter === 'unpaid') return s === 'created' || s === 'waiting' || s === 'pending'
      if (statusFilter === 'failed') return s === 'failed' || s === 'expired' || s === 'cancelled'
      return true
    })
    .filter((p) => affiliateFilter === 'all' ? true : affiliateFilter === 'affiliate' ? !!p.affiliate_id : !p.affiliate_id)

  // Build pending payouts grouped by affiliate (from commissions + affiliate map)
  const affiliateById = new Map(approvedAffiliates.map((a) => [String(a.id ?? ''), a]))
  const payoutsMap = new Map<string, PayoutRow>()
  for (const c of commissions) {
    if (String(c.status ?? '') !== 'pending') continue
    const affId = String(c.affiliate_id ?? '')
    const aff   = affiliateById.get(affId)
    const email = aff ? String(aff.email ?? affId) : affId
    const code  = aff ? String(aff.referral_code ?? '—') : '—'
    if (!payoutsMap.has(affId)) payoutsMap.set(affId, { affiliateId: affId, email, code, total: 0, count: 0, oldest: null })
    const entry = payoutsMap.get(affId)!
    entry.total += Number(c.commission_amount) || 0
    entry.count++
    const dt = String(c.created_at ?? '')
    if (dt && (!entry.oldest || dt < entry.oldest)) entry.oldest = dt
  }
  const pendingPayouts = Array.from(payoutsMap.values()).sort((a, b) => b.total - a.total)

  const runAction = useCallback(async (action: string, id: string, confirmMsg: string) => {
    if (!window.confirm(confirmMsg)) return
    setPendingId(id)
    try {
      const res = await fetch('/api/admin/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, id }),
      })
      const json = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string }
      if (res.ok && json.ok) {
        setToast({ msg: json.message ?? 'Done', ok: true })
        onRefresh()
      } else {
        setToast({ msg: json.error ?? `Error ${res.status}`, ok: false })
      }
    } catch {
      setToast({ msg: 'Network error', ok: false })
    } finally {
      setPendingId(null)
    }
  }, [token, onRefresh])

  const sec = card

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(circle at 20% 0%, rgba(20,35,68,.45), rgba(2,6,23,1) 55%)', color: '#e2e8f0', padding: '36px clamp(16px, 3vw, 48px) 80px' }}>
      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '32px' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', marginBottom: '10px', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.28)', borderRadius: '999px', padding: '3px 12px' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f87171', boxShadow: '0 0 6px #f87171', flexShrink: 0 }} />
              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#fca5a5', fontFamily: 'var(--font-plex-mono)' }}>ADMIN ONLY</span>
            </div>
            <h1 style={{ fontSize: '26px', fontWeight: 800, color: '#f8fafc', margin: 0 }}>ChainLens Control Room</h1>
            <p style={{ margin: '6px 0 0', color: '#3a5268', fontSize: '12px', fontFamily: 'var(--font-plex-mono)' }}>Signed in as {adminEmail}</p>
          </div>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            style={{ padding: '9px 22px', borderRadius: '10px', border: '1px solid rgba(45,212,191,.3)', background: 'rgba(45,212,191,0.07)', color: '#2DD4BF', fontSize: '11px', fontWeight: 700, letterSpacing: '0.10em', fontFamily: 'var(--font-plex-mono)', cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.5 : 1, transition: 'all 0.15s' }}
          >
            {refreshing ? 'REFRESHING…' : 'REFRESH'}
          </button>
        </div>
        {lastRefresh && (
          <p style={{ marginBottom: '28px', fontSize: '10px', color: '#1e3a44', fontFamily: 'var(--font-plex-mono)' }}>
            Last refreshed {lastRefresh.toLocaleTimeString()}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '36px' }}>

          {/* ── 1. Revenue Overview ───────────────────────────────────────── */}
          <div>
            <SectionHeader label="Revenue Overview" />
            {/* Row 1: Real revenue */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(176px, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <MetricCard label="Real Confirmed Revenue" value={fmtUsd(metrics.realConfirmedRevenueUsd)} sub="internal/test excluded" accent="#34d399" />
              <MetricCard label="Avg Order Value" value={fmtUsd(metrics.avgOrderValueUsd)} sub="real confirmed only" accent="#34d399" />
              <MetricCard label="Real Confirmed Sales" value={metrics.realConfirmedSalesCount.toLocaleString()} sub="real customers only" accent="#34d399" />
              <MetricCard label="Checkout Conversion" value={fmtConv(metrics.realConversionRate)} sub="real customers · excl. test" accent="#2DD4BF" />
            </div>
            {/* Row 2: Plan + unpaid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(176px, 1fr))', gap: '12px', marginBottom: '12px' }}>
              <MetricCard label="Pro Confirmed Sales" value={metrics.proConfirmedCount.toLocaleString()} sub={`${fmtUsd(metrics.proConfirmedRevenueUsd)} revenue`} accent="#a78bfa" />
              <MetricCard label="Elite Confirmed Sales" value={metrics.eliteConfirmedCount.toLocaleString()} sub={`${fmtUsd(metrics.eliteConfirmedRevenueUsd)} revenue`} accent="#2DD4BF" />
              <MetricCard label="Unpaid Checkouts" value={metrics.unpaidCheckoutsCount.toLocaleString()} sub="created / waiting / pending" accent={metrics.unpaidCheckoutsCount > 0 ? '#f59e0b' : '#3a5268'} />
              <MetricCard label="Test / Internal Revenue" value={fmtUsd(metrics.testConfirmedRevenueUsd)} sub={`${metrics.testPaymentsCount} confirmed test payments`} accent={metrics.testConfirmedRevenueUsd > 0 ? '#f59e0b' : '#3a5268'} />
            </div>
            {/* Row 3: Affiliate/commission */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(176px, 1fr))', gap: '12px' }}>
              <MetricCard label="Commission Owed" value={fmtUsd(metrics.pendingCommissionAmountUsd)} sub="affiliate pending payouts" accent={metrics.pendingCommissionAmountUsd > 0 ? '#fbbf24' : '#3a5268'} />
              <MetricCard label="Commission Paid" value={fmtUsd(metrics.totalPaidCommissionUsd)} sub="all-time paid commissions" accent={metrics.totalPaidCommissionUsd > 0 ? '#67e8f9' : '#3a5268'} />
              <MetricCard label="Approved Affiliates" value={metrics.approvedAffiliatesCount.toLocaleString()} accent="#8b5cf6" />
              <MetricCard label="Pending Applications" value={metrics.pendingApplicationsCount.toLocaleString()} accent={metrics.pendingApplicationsCount > 0 ? '#f59e0b' : '#3a5268'} />
            </div>
            <p style={{ marginTop: '14px', fontSize: '11px', color: '#475569', fontFamily: 'var(--font-plex-mono)', borderLeft: '2px solid rgba(245,158,11,0.4)', paddingLeft: '10px' }}>
              Internal/test payments are excluded from real revenue totals. Conversion rate uses real checkout attempts only.
            </p>
          </div>

          {/* ── 2. Plan Breakdown ─────────────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Plan Breakdown" sub="Pro vs Elite split · real confirmed customers only" />
            <PlanBreakdown metrics={metrics} />
          </div>

          {/* ── 3. Checkout Funnel ────────────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Checkout Funnel" sub="all statuses · all accounts" />
            <CheckoutFunnel metrics={metrics} />
          </div>

          {/* ── 4. Recent Confirmed Sales ─────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Recent Confirmed Sales" count={confirmedPayments.length} sub="confirmed / paid status only · last 50 payments scanned" />
            <p style={{ margin: '-4px 0 14px', fontSize: '11px', color: '#475569', fontFamily: 'var(--font-plex-mono)', borderLeft: '2px solid rgba(52,211,153,0.4)', paddingLeft: '10px' }}>
              Only CONFIRMED and PAID rows represent real revenue. TEST badge indicates internal accounts.
            </p>
            <ConfirmedSalesTable rows={confirmedPayments} />
          </div>

          {/* ── 5. Checkout Abandonment ───────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Checkout Abandonment" count={unpaidPayments.length} sub="open / unpaid checkouts · last 50 scanned" />
            <p style={{ margin: '-4px 0 14px', fontSize: '11px', color: '#475569', fontFamily: 'var(--font-plex-mono)', borderLeft: '2px solid rgba(245,158,11,0.4)', paddingLeft: '10px' }}>
              Unpaid rows are opened checkouts, not completed sales. Created/waiting/pending = checkout not yet confirmed.
            </p>
            <AbandonmentTable rows={unpaidPayments} />
          </div>

          {/* ── 6. Affiliate Leaderboard ──────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Affiliate Leaderboard" count={approvedAffiliates.length} sub="ranked by confirmed revenue · real customers only" />
            <AffiliateLeaderboardTable rows={approvedAffiliates} />
          </div>

          {/* ── 7. Pending Payouts ────────────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Pending Payouts" count={pendingPayouts.length} sub="pending commissions grouped by affiliate · last 50 commissions scanned" />
            <p style={{ margin: '-4px 0 14px', fontSize: '11px', color: '#475569', fontFamily: 'var(--font-plex-mono)', borderLeft: '2px solid rgba(251,191,36,0.4)', paddingLeft: '10px' }}>
              Manual payout only. Mark individual commissions paid from the Commissions table below.
            </p>
            <PendingPayoutsTable rows={pendingPayouts} />
          </div>

          {/* ── 8. Recent Payments (all, with filters) ────────────────────── */}
          <div style={sec}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '14px' }}>
              <SectionHeader label="Recent Payments" count={filteredPayments.length} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <FilterBar
                  filters={[{ key: 'all', label: 'ALL' }, { key: 'real', label: 'REAL' }, { key: 'test', label: 'TEST' }]}
                  active={payFilter}
                  onSelect={setPayFilter}
                />
                <FilterBar
                  filters={[{ key: 'all', label: 'ALL PLANS' }, { key: 'pro', label: 'PRO' }, { key: 'elite', label: 'ELITE' }]}
                  active={planFilter}
                  onSelect={setPlanFilter}
                />
                <FilterBar
                  filters={[{ key: 'all', label: 'ALL STATUS' }, { key: 'confirmed', label: 'CONFIRMED' }, { key: 'unpaid', label: 'UNPAID' }, { key: 'failed', label: 'FAILED' }]}
                  active={statusFilter}
                  onSelect={setStatusFilter}
                />
                <FilterBar
                  filters={[{ key: 'all', label: 'ALL' }, { key: 'affiliate', label: 'AFFILIATE' }, { key: 'organic', label: 'ORGANIC' }]}
                  active={affiliateFilter}
                  onSelect={setAffiliateFilter}
                />
              </div>
            </div>
            <p style={{ margin: '-4px 0 14px', fontSize: '11px', color: '#475569', fontFamily: 'var(--font-plex-mono)', borderLeft: '2px solid rgba(245,158,11,0.4)', paddingLeft: '10px' }}>
              UNPAID rows are checkout attempts, not completed sales. Only CONFIRMED and PAID rows represent real revenue.
            </p>
            <PaymentsTable rows={filteredPayments} />
          </div>

          {/* ── 9. Affiliate Applications ─────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Affiliate Applications (Pending)" count={pendingApplications.length} />
            <ApplicationsTable rows={pendingApplications} onAction={runAction} pendingId={pendingId} />
          </div>

          {/* ── 10. Commissions Detail ────────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Commissions" count={commissions.length} sub="last 50 · mark paid here" />
            <CommissionsTable rows={commissions} onAction={runAction} pendingId={pendingId} />
          </div>

          {/* ── 11. Referred Users ────────────────────────────────────────── */}
          <div style={sec}>
            <SectionHeader label="Referred Users" count={referredUsers.length} />
            <ReferredUsersTable rows={referredUsers} />
          </div>

        </div>

        <p style={{ marginTop: '40px', textAlign: 'center', fontSize: '10px', color: '#0f1f2b', fontFamily: 'var(--font-plex-mono)' }}>
          ChainLens Admin · Internal use only · Do not share this page
        </p>
      </div>
      {toast && <Toast msg={toast.msg} ok={toast.ok} onDismiss={() => setToast(null)} />}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [sessionLoading, setSessionLoading] = useState(true)
  const [token, setToken]                   = useState<string | null>(null)
  const [adminEmail, setAdminEmail]         = useState<string>('')
  const [loading, setLoading]               = useState(false)
  const [refreshing, setRefreshing]         = useState(false)
  const [data, setData]                     = useState<AdminData | null>(null)
  const [error, setError]                   = useState<string | null>(null)
  const [lastRefresh, setLastRefresh]       = useState<Date | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: sd }) => {
      setToken(sd.session?.access_token ?? null)
      setAdminEmail(sd.session?.user?.email ?? '')
      setSessionLoading(false)
    })
  }, [])

  const fetchData = useCallback(async (tok: string, isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/data', {
        headers: { Authorization: `Bearer ${tok}` },
        cache: 'no-store',
      })
      if (res.status === 401) { setError('Unauthorized'); setData(null); return }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? `Error ${res.status}`)
        setData(null)
        return
      }
      const json = await res.json() as AdminData
      setData(json)
      setLastRefresh(new Date())
    } catch {
      setError('Network error — check your connection.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!sessionLoading && token) fetchData(token)
    else if (!sessionLoading) setLoading(false)
  }, [sessionLoading, token, fetchData])

  if (sessionLoading || loading) return <FullPageMessage title="Loading…" color="#2DD4BF" />
  if (!token) return <FullPageMessage title="Sign in required" sub="You must be signed in to access this page." color="#94a3b8" />
  if (error === 'Unauthorized') return <FullPageMessage title="Admin access only" sub={`${adminEmail} is not an admin account.`} color="#f87171" />
  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 20% 0%, rgba(20,35,68,.45), rgba(2,6,23,1) 55%)' }}>
        <p style={{ color: '#f87171', fontFamily: 'var(--font-plex-mono)', fontSize: '14px' }}>Error: {error}</p>
        {token && (
          <button onClick={() => fetchData(token)} style={{ marginTop: '16px', padding: '8px 20px', borderRadius: '8px', border: '1px solid rgba(248,113,113,.3)', background: 'rgba(248,113,113,.08)', color: '#f87171', cursor: 'pointer', fontSize: '12px', fontFamily: 'var(--font-plex-mono)' }}>
            Retry
          </button>
        )}
      </div>
    )
  }
  if (!data) return null

  return (
    <Dashboard
      data={data}
      adminEmail={adminEmail}
      onRefresh={() => token && fetchData(token, true)}
      lastRefresh={lastRefresh}
      refreshing={refreshing}
      token={token ?? ''}
    />
  )
}
