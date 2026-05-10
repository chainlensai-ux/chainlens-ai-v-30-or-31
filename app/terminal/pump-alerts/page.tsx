'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { usePlanWithLoading, LockedPanel, canAccessFeature } from '@/lib/usePlan'
import { supabase } from '@/lib/supabaseClient'

type PumpCategory = 'HIGH_MOMENTUM' | 'VOLUME_EXPANSION' | 'THIN_MOONSHOT' | 'WATCH'
type PumpRisk = 'HIGH' | 'MEDIUM' | 'LOW'

interface PumpAlert {
  symbol: string
  name: string
  contract: string
  priceUsd: number | null
  change24h: number | null
  volume24hUsd: number | null
  liquidityUsd: number | null
  fdvUsd: number | null
  category: PumpCategory
  reason: string
  riskLevel: PumpRisk
  tags: string[]
}

type FilterKey = 'ALL' | PumpCategory

const CATEGORY_LABEL: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'High Momentum',
  VOLUME_EXPANSION: 'Vol Expansion',
  THIN_MOONSHOT: 'Thin Liquidity',
  WATCH: 'Watchlist',
}

const CATEGORY_COLOR: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: '#22d3ee',
  VOLUME_EXPANSION: '#a855f7',
  THIN_MOONSHOT: '#f97316',
  WATCH: '#2DD4BF',
}

const CATEGORY_BG: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'rgba(34,211,238,0.12)',
  VOLUME_EXPANSION: 'rgba(168,85,247,0.12)',
  THIN_MOONSHOT: 'rgba(249,115,22,0.12)',
  WATCH: 'rgba(45,212,191,0.10)',
}

const CATEGORY_BORDER: Record<PumpCategory, string> = {
  HIGH_MOMENTUM: 'rgba(34,211,238,0.32)',
  VOLUME_EXPANSION: 'rgba(168,85,247,0.30)',
  THIN_MOONSHOT: 'rgba(249,115,22,0.30)',
  WATCH: 'rgba(45,212,191,0.26)',
}

const RISK_COLOR: Record<PumpRisk, string> = {
  HIGH: '#f87171',
  MEDIUM: '#fbbf24',
  LOW: '#4ade80',
}

const RISK_BG: Record<PumpRisk, string> = {
  HIGH: 'rgba(248,113,113,0.12)',
  MEDIUM: 'rgba(251,191,36,0.12)',
  LOW: 'rgba(74,222,128,0.10)',
}

const RISK_LABEL: Record<PumpRisk, string> = {
  HIGH: 'HIGH RISK',
  MEDIUM: 'WATCH RISK',
  LOW: 'LOWER RISK',
}

const FILTER_CHIPS: Array<{ key: FilterKey; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'HIGH_MOMENTUM', label: 'High Momentum' },
  { key: 'VOLUME_EXPANSION', label: 'Vol Expansion' },
  { key: 'WATCH', label: 'Watchlist' },
  { key: 'THIN_MOONSHOT', label: 'Thin Liquidity' },
]

function fmtUSD(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

function fmtPrice(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1) return `$${v.toFixed(4)}`
  if (v >= 0.0001) return `$${v.toFixed(6)}`
  return `$${v.toExponential(3)}`
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function StatMetric({ label, value, dimValue }: { label: string; value: string; dimValue?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
      <span style={{ fontSize: '8px', fontWeight: 700, color: '#3a5268', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '11.5px', fontWeight: 700, color: dimValue ? '#64748b' : '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>
        {value}
      </span>
    </div>
  )
}

function AlertCard({ alert, onScan, onAskClark }: {
  alert: PumpAlert
  onScan: () => void
  onAskClark: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const catColor = CATEGORY_COLOR[alert.category]
  const catBg = CATEGORY_BG[alert.category]
  const catBorder = CATEGORY_BORDER[alert.category]
  const riskColor = RISK_COLOR[alert.riskLevel]
  const riskBg = RISK_BG[alert.riskLevel]
  const changePositive = (alert.change24h ?? 0) >= 0
  const avatarText = (alert.symbol || '?').slice(0, 2).toUpperCase()

  return (
    <div
      className="pump-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'rgba(255,255,255,0.048)' : 'rgba(255,255,255,0.026)',
        border: `1px solid ${hovered ? `${catColor}28` : 'rgba(255,255,255,0.08)'}`,
        borderLeft: `3px solid ${catColor}`,
        borderRadius: '10px',
        padding: '10px 12px',
        transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
        boxShadow: hovered ? `0 0 22px ${catColor}16` : 'none',
        display: 'flex',
        alignItems: 'stretch',
        gap: '0',
        animation: 'pumpSlideIn 0.3s ease both',
        overflow: 'hidden',
      }}
    >
      {/* LEFT: identity */}
      <div
        className="pump-card-left"
        style={{
          display: 'flex', alignItems: 'center', gap: '9px',
          width: '185px', flexShrink: 0,
          paddingRight: '12px', borderRight: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{
          width: '28px', height: '28px', borderRadius: '8px', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '9.5px', fontWeight: 800, color: catColor,
          background: `${catColor}1a`, border: `1px solid ${catColor}2e`,
          fontFamily: 'var(--font-plex-mono)',
        }}>
          {avatarText}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {alert.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', fontFamily: 'var(--font-plex-mono)' }}>
            <span style={{ color: '#64748b', fontWeight: 700 }}>{alert.symbol}</span>
            <span style={{ color: '#2d3f52' }}>·</span>
            <span style={{ color: '#374a5c' }}>{shortAddr(alert.contract)}</span>
          </div>
        </div>
      </div>

      {/* CENTER: metrics + reason */}
      <div
        className="pump-card-center"
        style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 12px', gap: '4px', minWidth: 0 }}
      >
        <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <StatMetric label="Price" value={fmtPrice(alert.priceUsd)} />
          {alert.change24h != null && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px' }}>
              <span style={{ fontSize: '8px', fontWeight: 700, color: '#3a5268', letterSpacing: '0.10em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>24h</span>
              <span style={{ fontSize: '12px', fontWeight: 800, color: changePositive ? '#4ade80' : '#f87171', fontFamily: 'var(--font-plex-mono)' }}>
                {changePositive ? '▲' : '▼'}{Math.abs(alert.change24h).toFixed(1)}%
              </span>
            </div>
          )}
          <StatMetric label="Vol" value={fmtUSD(alert.volume24hUsd)} dimValue={alert.volume24hUsd == null} />
          <StatMetric label="Liq" value={fmtUSD(alert.liquidityUsd)} dimValue={alert.liquidityUsd == null} />
          <StatMetric label="FDV" value={fmtUSD(alert.fdvUsd)} dimValue={alert.fdvUsd == null} />
        </div>
        <p style={{ margin: 0, fontSize: '10px', color: '#4a6278', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {alert.riskLevel === 'HIGH' && <span style={{ color: '#f87171' }}>⚠ </span>}
          {alert.reason}
        </p>
      </div>

      {/* RIGHT: chips + actions */}
      <div
        className="pump-card-right"
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
          justifyContent: 'space-between', gap: '6px',
          flexShrink: 0, paddingLeft: '12px', borderLeft: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-end' }}>
          <span style={{
            padding: '2px 7px', borderRadius: '99px', fontSize: '8px', fontWeight: 700, letterSpacing: '0.07em',
            color: catColor, background: catBg, border: `1px solid ${catBorder}`,
            fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
          }}>
            {CATEGORY_LABEL[alert.category]}
          </span>
          <span style={{
            padding: '2px 7px', borderRadius: '99px', fontSize: '8px', fontWeight: 700, letterSpacing: '0.07em',
            color: riskColor, background: riskBg, border: `1px solid ${riskColor}33`,
            fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
          }}>
            {RISK_LABEL[alert.riskLevel]}
          </span>
          {alert.tags?.map(tag => (
            <span key={tag} style={{
              padding: '2px 7px', borderRadius: '99px', fontSize: '8px', fontWeight: 700, letterSpacing: '0.07em',
              color: '#94a3b8', background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.18)',
              fontFamily: 'var(--font-plex-mono)', whiteSpace: 'nowrap',
            }}>
              {tag}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={onScan}
            style={{
              padding: '4px 9px', borderRadius: '6px', fontSize: '8px', fontWeight: 700,
              letterSpacing: '0.07em', textTransform: 'uppercase',
              border: '1px solid rgba(45,212,191,0.32)', background: 'rgba(45,212,191,0.09)',
              color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
              transition: 'background 0.12s, border-color 0.12s',
            }}
          >
            Scan
          </button>
          <button
            onClick={onAskClark}
            style={{
              padding: '4px 9px', borderRadius: '6px', fontSize: '8px', fontWeight: 700,
              letterSpacing: '0.07em', textTransform: 'uppercase',
              border: '1px solid rgba(168,85,247,0.30)', background: 'rgba(168,85,247,0.09)',
              color: '#a855f7', fontFamily: 'var(--font-plex-mono)', cursor: 'pointer',
              transition: 'background 0.12s, border-color 0.12s',
            }}
          >
            Clark
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryStrip({ alerts }: { alerts: PumpAlert[] }) {
  const highMomentum = alerts.filter(a => a.category === 'HIGH_MOMENTUM').length
  const volExp = alerts.filter(a => a.category === 'VOLUME_EXPANSION').length
  const thinLiq = alerts.filter(a => a.category === 'THIN_MOONSHOT').length
  const watch = alerts.filter(a => a.category === 'WATCH').length
  const highRisk = alerts.filter(a => a.riskLevel === 'HIGH').length

  const items = [
    { label: 'Total', value: String(alerts.length), glow: 'rgba(45,212,191,0.22)' },
    { label: 'High Momentum', value: String(highMomentum), glow: 'rgba(34,211,238,0.20)' },
    { label: 'Vol Expansion', value: String(volExp), glow: 'rgba(168,85,247,0.20)' },
    { label: 'Watchlist', value: String(watch), glow: 'rgba(45,212,191,0.16)' },
    { label: 'Thin Liquidity', value: String(thinLiq), glow: 'rgba(249,115,22,0.20)' },
    { label: 'High Risk', value: String(highRisk), glow: 'rgba(248,113,113,0.18)' },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '7px', marginBottom: '16px' }}>
      {items.map(item => (
        <div key={item.label} style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015))',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '9px',
          padding: '9px 10px',
          boxShadow: `0 0 16px ${item.glow}`,
        }}>
          <p style={{ margin: '0 0 3px', fontSize: '8px', color: '#3a5268', letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)' }}>
            {item.label}
          </p>
          <p style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  )
}

export default function PumpAlertsPage() {
  const { plan, loading: planLoading } = usePlanWithLoading()
  const router = useRouter()
  const [alerts, setAlerts] = useState<PumpAlert[]>([])
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [countdown, setCountdown] = useState(60)
  const [activeFilter, setActiveFilter] = useState<FilterKey>('ALL')
  const [refreshKey, setRefreshKey] = useState(0)

  const fetchAlerts = useCallback(async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch('/api/pump-alerts', {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const json = await res.json()
      setAlerts(Array.isArray(json.alerts) ? json.alerts : [])
      setFetchedAt(json.fetchedAt ?? null)
    } catch {
      setAlerts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { setRefreshKey(k => k + 1); return 60 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (refreshKey > 0) { fetchAlerts(); setCountdown(60) }
  }, [refreshKey, fetchAlerts])

  function openToken(contract: string) {
    router.push(`/terminal/token-scanner?contract=${contract}`)
  }

  function openClark(alert: PumpAlert) {
    const prompt = [
      '[mode: pump-alerts]',
      `Token: ${alert.name} (${alert.symbol})`,
      `Contract: ${alert.contract}`,
      `Category: ${CATEGORY_LABEL[alert.category]}`,
      `24h Change: ${alert.change24h != null ? `${(alert.change24h >= 0 ? '+' : '')}${alert.change24h.toFixed(1)}%` : 'N/A'}`,
      `Volume 24h: ${fmtUSD(alert.volume24hUsd)}`,
      `Liquidity: ${fmtUSD(alert.liquidityUsd)}`,
      `FDV: ${fmtUSD(alert.fdvUsd)}`,
      `Risk: ${RISK_LABEL[alert.riskLevel]}`,
      `Signal: ${alert.reason}`,
    ].join('\n')
    router.push(`/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}`)
  }

  const filtered = useMemo(() =>
    activeFilter === 'ALL' ? alerts : alerts.filter(a => a.category === activeFilter),
    [alerts, activeFilter],
  )

  if (planLoading) return <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#94a3b8', fontFamily: 'var(--font-plex-mono)' }}>Loading plan access…</div>
  if (!canAccessFeature(plan, 'pump-alerts')) return <LockedPanel feature="pump-alerts" />

  return (
    <>
      <style>{`
        @keyframes pumpSlideIn {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(236,72,153,0.6); }
          50%       { opacity: 0.6; box-shadow: 0 0 0 5px rgba(236,72,153,0); }
        }
        @keyframes spinRefresh {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @media (max-width: 768px) {
          .pump-main   { padding: 16px 12px 120px !important; }
          .pump-strip  { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
        }
        @media (max-width: 640px) {
          .pump-card       { flex-direction: column !important; }
          .pump-card-left  { width: auto !important; border-right: none !important; padding-right: 0 !important; padding-bottom: 8px !important; border-bottom: 1px solid rgba(255,255,255,0.06) !important; }
          .pump-card-center { padding: 4px 0 !important; }
          .pump-card-right { flex-direction: row !important; align-items: center !important; border-left: none !important; padding-left: 0 !important; padding-top: 8px !important; border-top: 1px solid rgba(255,255,255,0.06) !important; justify-content: space-between !important; }
        }
      `}</style>

      <div className="pump-main" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '28px 32px 120px', color: '#e2e8f0', fontFamily: 'var(--font-inter, Inter, sans-serif)' }}>

        {/* Header */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', margin: 0, letterSpacing: '-0.01em' }}>
              Pump Alerts
            </h1>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '4px 10px', borderRadius: '99px',
              background: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.30)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#ec4899',
              fontFamily: 'var(--font-plex-mono)',
            }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ec4899', animation: 'livePulse 1.8s ease-in-out infinite', flexShrink: 0 }} />
              LIVE
            </span>
          </div>
          <p style={{ fontSize: '12px', color: '#64748b', margin: '0 0 16px' }}>
            Ranked by momentum, volume, liquidity, and CORTEX quality filters. Not financial advice.
          </p>

          <div className="pump-strip">
            <SummaryStrip alerts={alerts} />
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
              Refresh in {countdown}s
            </span>
            <button
              onClick={() => { setCountdown(60); fetchAlerts() }}
              disabled={loading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '5px 12px', borderRadius: '8px',
                background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.20)',
                color: loading ? '#3a5268' : '#2DD4BF',
                fontSize: '10px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              <svg width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'
                style={{ animation: loading ? 'spinRefresh 0.8s linear infinite' : 'none' }}>
                <path d='M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' />
                <path d='M21 3v5h-5' />
                <path d='M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' />
                <path d='M8 16H3v5' />
              </svg>
              {loading ? 'Scanning…' : 'Refresh'}
            </button>
            {fetchedAt && (
              <span style={{ fontSize: '10px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
                Updated {new Date(fetchedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* Filter chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {FILTER_CHIPS.map(chip => {
              const active = chip.key === activeFilter
              const color = chip.key !== 'ALL' ? CATEGORY_COLOR[chip.key as PumpCategory] : '#2DD4BF'
              return (
                <button
                  key={chip.key}
                  onClick={() => setActiveFilter(chip.key)}
                  style={{
                    padding: '5px 11px', borderRadius: '99px', fontSize: '9px', fontWeight: 700,
                    letterSpacing: '0.10em', textTransform: 'uppercase', cursor: 'pointer',
                    border: `1px solid ${active ? `${color}55` : 'rgba(255,255,255,0.10)'}`,
                    background: active ? `${color}1c` : 'rgba(255,255,255,0.03)',
                    color: active ? color : '#94a3b8',
                    fontFamily: 'var(--font-plex-mono)',
                    boxShadow: active ? `0 0 12px ${color}18` : 'none',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  }}
                >
                  {chip.label}
                  {chip.key !== 'ALL' && (
                    <span style={{ marginLeft: '5px', opacity: 0.60 }}>
                      {alerts.filter(a => a.category === chip.key).length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Feed */}
        <div>
          <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: '#3a5268', textTransform: 'uppercase', fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px' }}>
            Alerts {filtered.length > 0 && `— ${filtered.length}`}
          </p>

          {/* Loading skeletons */}
          {loading && alerts.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {[...Array(7)].map((_, i) => (
                <div key={i} style={{ height: '66px', borderRadius: '10px', borderLeft: '3px solid rgba(45,212,191,0.18)', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', animation: 'pumpSlideIn 0.3s ease both', animationDelay: `${i * 55}ms` }} />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && filtered.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)' }}>
              <div style={{ fontSize: '32px', marginBottom: '14px', opacity: 0.35 }}>◈</div>
              <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 6px', color: '#64748b' }}>
                {activeFilter !== 'ALL' && activeFilter in CATEGORY_LABEL
                  ? `No ${CATEGORY_LABEL[activeFilter as PumpCategory]} signals right now.`
                  : 'No fresh pump signals passed the quality filter.'}
              </p>
              <p style={{ fontSize: '11px', margin: 0, color: '#3a5268' }}>
                Try refreshing or widening the watchlist.
              </p>
            </div>
          )}

          {/* Low-count notice */}
          {!loading && alerts.length > 0 && alerts.length < 10 && (
            <p style={{ fontSize: '9.5px', color: '#3a5268', fontFamily: 'var(--font-plex-mono)', margin: '0 0 8px', padding: '5px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              Limited fresh candidates right now — refresh shortly for more.
            </p>
          )}

          {/* Alert cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filtered.map((alert, i) => (
              <div key={alert.contract} style={{ animationDelay: `${i * 30}ms` }}>
                <AlertCard
                  alert={alert}
                  onScan={() => openToken(alert.contract)}
                  onAskClark={() => openClark(alert)}
                />
              </div>
            ))}
          </div>

          {/* Disclaimer */}
          {filtered.length > 0 && (
            <p style={{ marginTop: '20px', fontSize: '10px', color: '#2d3f52', fontFamily: 'var(--font-plex-mono)', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '14px' }}>
              Pump Alerts surface tokens meeting momentum thresholds based on live CORTEX market data. This is not financial advice. Always verify independently before acting.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
