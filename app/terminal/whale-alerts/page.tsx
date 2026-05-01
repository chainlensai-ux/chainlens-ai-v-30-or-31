'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

type AlertItem = {
  id?: string
  wallet_address?: string | null
  wallet_label?: string | null
  token_address?: string | null
  token_symbol?: string | null
  token_name?: string | null
  alert_type?: string | null
  side?: string | null
  amount_usd?: number | null
  amount_token?: number | null
  tx_hash?: string | null
  severity?: string | null
  occurred_at?: string | null
}
type AlertStats = { alerts15m: number; alerts1h: number; alerts24h: number; trackedWallets: number }
type SyncResponse = { processed?: number; inserted?: number; nextOffset?: number | null; providerErrors?: number; trackedWalletsTotal?: number; offset?: number }

const MIN_OPTIONS = [
  { label: 'All', value: 0 }, { label: '$100+', value: 100 }, { label: '$500+', value: 500 },
  { label: '$1k+', value: 1000 }, { label: '$5k+', value: 5000 }, { label: '$10k+', value: 10000 },
]
const WINDOWS = ['15m', '1h', '6h', '24h'] as const

const short = (v?: string | null) => !v ? '0x????…????' : `${v.slice(0, 6)}…${v.slice(-4)}`

const timeAgo = (iso?: string | null): string => {
  if (!iso) return '–'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const fmtUsd = (n?: number | null) => {
  if (n == null) return '—'
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

const fmtToken = (n?: number | null, sym?: string | null) => {
  if (n == null || !sym) return null
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${sym}`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K ${sym}`
  return `${n.toFixed(2)} ${sym}`
}

const getSide = (s: string | null | undefined) => {
  const k = (s ?? '').toLowerCase()
  if (k === 'buy')  return { line: '#2dd4bf', avatarBg: '#0d3b35', chipBg: 'rgba(45,212,191,0.10)',  chipBd: 'rgba(45,212,191,0.28)',  chipTx: '#5eead4', label: 'BUY'      }
  if (k === 'sell') return { line: '#f43f5e', avatarBg: '#3b0d1a', chipBg: 'rgba(244,63,94,0.12)',   chipBd: 'rgba(244,63,94,0.30)',   chipTx: '#fda4af', label: 'SELL'     }
  return               { line: '#8b5cf6', avatarBg: '#1e0d3b', chipBg: 'rgba(139,92,246,0.12)',  chipBd: 'rgba(139,92,246,0.30)',  chipTx: '#c4b5fd', label: 'TRANSFER' }
}

const sevLabel = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return 'HIGH'
  if (sev === 'medium') return 'MED'
  if (sev === 'low') return 'LOW'
  return sev?.toUpperCase() ?? null
}

const sevStyle = (sev: string | null | undefined): React.CSSProperties => {
  if (sev === 'major' || sev === 'large') return { background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.28)', color: '#fda4af' }
  if (sev === 'medium') return { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.26)', color: '#fcd34d' }
  return { background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.18)', color: '#475569' }
}

const rowDesc = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return 'High value movement detected'
  if (sev === 'medium') return 'Fresh tracked-wallet activity'
  if (sev === 'low') return 'Below whale threshold'
  return null
}

/* ── Design tokens ── */
const CARD = '#0c1525'
const INNER = '#07101e'
const BD = 'rgba(255,255,255,0.075)'
const BD2 = 'rgba(255,255,255,0.055)'

/* ── Atoms ── */

function Chip({ children, color = 'slate', dot }: { children: React.ReactNode; color?: string; dot?: boolean }) {
  const map: Record<string, { bg: string; bd: string; tx: string; dt: string }> = {
    slate:  { bg: 'rgba(148,163,184,0.07)', bd: 'rgba(148,163,184,0.16)', tx: '#64748b', dt: '#475569' },
    teal:   { bg: 'rgba(45,212,191,0.08)',  bd: 'rgba(45,212,191,0.22)',  tx: '#5eead4', dt: '#2dd4bf' },
    purple: { bg: 'rgba(139,92,246,0.08)',  bd: 'rgba(139,92,246,0.22)',  tx: '#c4b5fd', dt: '#8b5cf6' },
    cyan:   { bg: 'rgba(34,211,238,0.08)',  bd: 'rgba(34,211,238,0.22)',  tx: '#67e8f9', dt: '#22d3ee' },
    amber:  { bg: 'rgba(251,191,36,0.08)',  bd: 'rgba(251,191,36,0.22)',  tx: '#fcd34d', dt: '#f59e0b' },
    green:  { bg: 'rgba(34,197,94,0.08)',   bd: 'rgba(34,197,94,0.22)',   tx: '#86efac', dt: '#22c55e' },
  }
  const c = map[color] ?? map.slate
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium"
      style={{ background: c.bg, border: `1px solid ${c.bd}`, color: c.tx }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dt }} />}
      {children}
    </span>
  )
}

/* Sparkline for metric cards */
function MetricSpark({ color, idx = 0 }: { color: string; idx?: number }) {
  const paths = [
    { line: 'M0 34 L18 28 L36 22 L54 26 L72 16 L90 19 L108 11 L126 14 L144 6 L162 9 L180 2', fill: 'M0 34 L18 28 L36 22 L54 26 L72 16 L90 19 L108 11 L126 14 L144 6 L162 9 L180 2 L180 40 L0 40Z' },
    { line: 'M0 36 L18 30 L36 24 L54 18 L72 22 L90 12 L108 16 L126 8 L144 12 L162 4 L180 8',  fill: 'M0 36 L18 30 L36 24 L54 18 L72 22 L90 12 L108 16 L126 8 L144 12 L162 4 L180 8 L180 40 L0 40Z' },
    { line: 'M0 20 L18 26 L36 18 L54 28 L72 14 L90 20 L108 10 L126 16 L144 6 L162 12 L180 4',  fill: 'M0 20 L18 26 L36 18 L54 28 L72 14 L90 20 L108 10 L126 16 L144 6 L162 12 L180 4 L180 40 L0 40Z' },
    { line: 'M0 30 L18 34 L36 26 L54 32 L72 20 L90 26 L108 14 L126 20 L144 8 L162 14 L180 6',  fill: 'M0 30 L18 34 L36 26 L54 32 L72 20 L90 26 L108 14 L126 20 L144 8 L162 14 L180 6 L180 40 L0 40Z' },
  ]
  const p = paths[idx % paths.length]
  const id = `ms-${idx}-${color.replace('#', '')}`
  return (
    <svg width="180" height="40" viewBox="0 0 180 40" fill="none"
      className="absolute bottom-0 right-0 opacity-60" style={{ borderBottomRightRadius: 16 }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={p.fill} fill={`url(#${id})`} />
      <path d={p.line} stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

/* ── Page ── */

export default function WhaleAlertsPage() {
  const [windowValue,    setWindowValue]    = useState<(typeof WINDOWS)[number]>('1h')
  const [minUsd,         setMinUsd]         = useState(100)
  const [typeFilter,     setTypeFilter]     = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [sideFilter,     setSideFilter]     = useState('all')

  const [alerts,    setAlerts]    = useState<AlertItem[]>([])
  const [stats,     setStats]     = useState<AlertStats>({ alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
  const [loading,   setLoading]   = useState(false)
  const [syncing,   setSyncing]   = useState(false)
  const [syncState, setSyncState] = useState<SyncResponse | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)

  const loadAlerts = useCallback(async () => {
    setLoading(true); setFeedError(null)
    try {
      const p = new URLSearchParams({ window: windowValue, minUsd: String(minUsd), limit: '100' })
      if (typeFilter     !== 'all') p.set('type',     typeFilter)
      if (severityFilter !== 'all') p.set('severity', severityFilter)
      if (sideFilter     !== 'all') p.set('side',     sideFilter)
      const res  = await fetch(`/api/whale-alerts?${p}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error('feed_unavailable')
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
    } catch { setFeedError('Feed request failed.') }
    finally  { setLoading(false) }
  }, [windowValue, minUsd, typeFilter, severityFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  const runSync = async (offset: number) => {
    setSyncing(true)
    try {
      const res  = await fetch(`/api/whale-alerts/sync?window=7d&limit=5&offset=${offset}&minUsd=${minUsd}`, { method: 'POST' })
      const json = (await res.json()) as SyncResponse
      setSyncState(json); await loadAlerts()
    } finally { setSyncing(false) }
  }

  const resetFilters = () => {
    setWindowValue('1h'); setMinUsd(100)
    setTypeFilter('all'); setSeverityFilter('all'); setSideFilter('all')
    setSyncState(null)
  }

  const types      = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.alert_type).filter(Boolean) as string[]))], [alerts])
  const severities = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.severity).filter(Boolean)   as string[]))], [alerts])
  const sides      = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.side).filter(Boolean)       as string[]))], [alerts])

  // Clark prompt helpers - single source of truth
  const lastSyncSummary = syncState ? `${syncState.processed ?? 0} scanned / ${syncState.inserted ?? 0} inserted` : 'Unavailable'
  const providerSummary = syncState ? ((syncState.providerErrors ?? 0) > 0 ? `Degraded (${syncState.providerErrors} errors)` : 'Healthy') : 'Unavailable'
  const buildClarkPrompt = () => {
    if (alerts.length > 0) return `Review my Whale Alerts feed. Visible alerts: ${alerts.length}. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain signals. Do not invent data.`
    return `Review my Whale Alerts setup. No alerts visible. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain what this means. Do not invent alerts.`
  }
  const goClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  const covPct = syncState && (syncState.trackedWalletsTotal ?? 0) > 0
    ? Math.min(100, Math.round(((syncState.processed ?? 0) / (syncState.trackedWalletsTotal ?? 1)) * 100)) : null

  /* Derived change % from real multi-window data */
  const ch15m = stats.alerts1h  > 0 ? Math.round(((stats.alerts15m / (stats.alerts1h  / 4))  - 1) * 100) : null
  const ch1h  = stats.alerts24h > 0 ? Math.round(((stats.alerts1h  / (stats.alerts24h / 24)) - 1) * 100) : null

  const metrics = [
    { label: 'ALERTS · 15M',       val: stats.alerts15m,      desc: 'Last quarter hour',    color: '#2dd4bf', change: ch15m  },
    { label: 'ALERTS · 1H',        val: stats.alerts1h,       desc: 'Past 60 minutes',       color: '#2dd4bf', change: ch1h   },
    { label: 'ALERTS · 24H',       val: stats.alerts24h,      desc: 'Rolling day window',    color: '#f43f5e', change: null   },
    { label: 'TRACKED WALLETS',    val: stats.trackedWallets,  desc: 'Smart money + manual', color: '#ec4899', change: null   },
  ]

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden"
      style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -5%,rgba(45,212,191,0.07) 0%,transparent 50%),#030c1a' }}>

      <div className="mx-auto max-w-[1340px] space-y-4 px-4 py-6 sm:px-6 lg:px-8">

        {/* ══ HERO ══════════════════════════════════════════════════════ */}
        <div className="rounded-[20px] p-6 sm:p-7" style={{ background: CARD, border: `1px solid ${BD}` }}>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center">

            {/* Left */}
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                <span style={{ color: '#2dd4bf', fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' }}>Whale Alerts</span>
                <span style={{ color: '#132030', fontSize: 13 }}>·</span>
                <span style={{ color: '#132030', fontSize: 13 }}>·</span>
                <span style={{ color: '#1a3040', fontSize: 11 }}>base mainnet</span>
              </div>
              <h1 className="text-[2.6rem] font-bold leading-tight text-white">Whale Alerts</h1>
              <p className="mt-2 text-sm" style={{ color: '#3a5470' }}>Track selected Base wallets for meaningful token movement.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Chip color="cyan" dot>Base Mainnet</Chip>
                <Chip color="slate">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 2 }}>
                    <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
                  </svg>
                  {stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}
                </Chip>
                <Chip color="teal" dot>{syncing ? 'Syncing…' : 'Batch Sync Online'}</Chip>
                <Chip color="purple" dot>CORTEX Watching</Chip>
              </div>
            </div>

            {/* Right: live radar panel */}
            <div className="w-full shrink-0 rounded-2xl p-4 lg:w-[390px]"
              style={{ background: INNER, border: `1px solid ${BD2}` }}>
              <div className="flex items-start gap-4">

                {/* Radar rings */}
                <div className="relative mt-0.5 h-[78px] w-[78px] shrink-0">
                  <div className="absolute inset-0 rounded-full" style={{ border: '1px solid rgba(45,212,191,0.12)' }}/>
                  <div className="absolute inset-[10px] rounded-full" style={{ border: '1px solid rgba(45,212,191,0.14)' }}/>
                  <div className="absolute inset-[20px] rounded-full" style={{ border: '1px solid rgba(45,212,191,0.20)', background: 'rgba(45,212,191,0.04)' }}/>
                  <div className="absolute inset-[30px] rounded-full" style={{ border: '1px solid rgba(45,212,191,0.30)', background: 'rgba(45,212,191,0.10)' }}/>
                  <div className="absolute inset-[37px] rounded-full" style={{ background: 'rgba(45,212,191,0.70)', boxShadow: '0 0 8px rgba(45,212,191,0.8)' }}/>
                  {/* sweep dot */}
                  <div className="absolute rounded-full" style={{ width: 7, height: 7, top: 10, left: '50%', transform: 'translateX(-50%)', background: '#22c55e', boxShadow: '0 0 8px #22c55e' }}/>
                </div>

                {/* Text + sparkline */}
                <div className="min-w-0 flex-1">
                  <p style={{ color: '#22c55e', fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>● LIVE WALLET MOVEMENT</p>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: '#2d4060' }}>Listening for high-signal wallet moves on Base.</p>
                  <div className="mt-3">
                    <svg width="100%" height="30" viewBox="0 0 220 30" preserveAspectRatio="none" fill="none">
                      <defs>
                        <linearGradient id="hsp" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.20"/>
                          <stop offset="100%" stopColor="#22c55e" stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      <path d="M0 26 L25 20 L50 15 L75 18 L100 10 L125 13 L150 6 L175 9 L200 3 L220 2"
                        stroke="#22c55e" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.75"/>
                      <path d="M0 26 L25 20 L50 15 L75 18 L100 10 L125 13 L150 6 L175 9 L200 3 L220 2 L220 30 L0 30Z"
                        fill="url(#hsp)"/>
                      <circle cx="220" cy="2" r="2" fill="#22c55e" opacity="0.9"/>
                    </svg>
                  </div>
                </div>

              </div>
            </div>

          </div>
        </div>

        {/* ══ METRICS ══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {metrics.map((m, idx) => (
            <div key={m.label} className="relative overflow-hidden rounded-2xl p-5"
              style={{ background: CARD, border: `1px solid ${BD}`, minHeight: 140 }}>

              {/* Top row: icon + label | change */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{ background: `${m.color}14`, border: `1px solid ${m.color}28` }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="2.2">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                  </div>
                  <span style={{ color: m.color, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>{m.label}</span>
                </div>
                {m.change !== null && (
                  <span className="flex items-center gap-0.5 text-[11px] font-bold"
                    style={{ color: m.change >= 0 ? '#22c55e' : '#f43f5e' }}>
                    {m.change >= 0
                      ? <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l8 8h-6v8h-4v-8H4z"/></svg>
                      : <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 20l-8-8h6V4h4v8h6z"/></svg>}
                    {m.change >= 0 ? '+' : ''}{m.change}%
                  </span>
                )}
              </div>

              {/* Number */}
              <p className="mt-4 text-[2.4rem] font-bold leading-none tabular-nums text-white">{m.val}</p>
              <p className="mt-1.5 text-xs" style={{ color: '#2d4060' }}>{m.desc}</p>

              <MetricSpark color={m.color} idx={idx}/>
            </div>
          ))}
        </div>

        {/* ══ CONTROLS + SYNC ══════════════════════════════════════════ */}
        <div className="rounded-[20px] p-5 sm:p-6" style={{ background: CARD, border: `1px solid ${BD}` }}>
          <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">

            {/* Left: filters */}
            <div className="flex flex-col gap-5 lg:flex-1">

              {/* Time window */}
              <div>
                <p style={{ color: '#2d3f55', fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 10 }}>Time Window</p>
                <div style={{ display: 'inline-flex', gap: 4, background: 'rgba(255,255,255,0.02)', border: `1px solid ${BD2}`, borderRadius: 12, padding: 4 }}>
                  {WINDOWS.map(w => (
                    <button key={w} onClick={() => setWindowValue(w)}
                      style={windowValue === w
                        ? { background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.38)', color: '#2dd4bf', borderRadius: 8, padding: '6px 16px', fontSize: 12, fontWeight: 600 }
                        : { background: 'transparent', border: '1px solid transparent', color: '#2d3f55', borderRadius: 8, padding: '6px 16px', fontSize: 12, fontWeight: 600 }}>
                      {w}
                    </button>
                  ))}
                </div>
              </div>

              {/* Min value */}
              <div>
                <p style={{ color: '#2d3f55', fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 10 }}>Minimum Value</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {MIN_OPTIONS.map(m => (
                    <button key={m.value} onClick={() => setMinUsd(m.value)}
                      style={minUsd === m.value
                        ? { background: 'rgba(45,212,191,0.12)', border: '1px solid rgba(45,212,191,0.38)', color: '#2dd4bf', borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 600 }
                        : { background: 'rgba(255,255,255,0.03)', border: `1px solid ${BD2}`, color: '#2d3f55', borderRadius: 999, padding: '6px 14px', fontSize: 12, fontWeight: 600 }}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Dropdowns */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
                {[
                  { label: 'Alert Type', value: typeFilter,     onChange: setTypeFilter,     opts: types },
                  { label: 'Severity',   value: severityFilter, onChange: setSeverityFilter, opts: severities },
                  { label: 'Side',       value: sideFilter,     onChange: setSideFilter,     opts: sides },
                ].map(({ label, value, onChange, opts }) => (
                  <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ color: '#2d3f55', fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' }}>{label}</span>
                    <div style={{ position: 'relative' }}>
                      <select value={value} onChange={e => onChange(e.target.value)}
                        className="wa-select w-full"
                        style={{ background: INNER, border: `1px solid ${BD}`, color: '#94a3b8', borderRadius: 12, padding: '10px 32px 10px 12px', fontSize: 13, width: '100%' }}>
                        {opts.map(o => <option key={o} value={o}>{o === 'all' ? `All ${label}s` : o}</option>)}
                      </select>
                      <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: '#2d3f55', pointerEvents: 'none' }}>
                        <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
                      </span>
                    </div>
                  </div>
                ))}
              </div>

            </div>

            {/* Right: wallet sync sub-card */}
            <div style={{ flexShrink: 0, width: '100%', maxWidth: 480 }}>
              <div className="rounded-2xl p-5 flex flex-col gap-4"
                style={{ background: INNER, border: `1px solid ${BD}` }}>

                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 10, background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.24)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2">
                        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                      </svg>
                    </div>
                    <div>
                      <p style={{ color: '#ffffff', fontSize: 14, fontWeight: 700 }}>Wallet scan</p>
                      <p style={{ color: '#2d4060', fontSize: 11, marginTop: 1 }}>
                        {syncState ? `Last scan ${timeAgo(undefined)}` : 'No scan yet'}
                      </p>
                    </div>
                  </div>
                  <Chip color={syncing ? 'amber' : 'teal'} dot>{syncing ? 'Syncing…' : 'Sync Healthy'}</Chip>
                </div>

                {/* Stat boxes */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div style={{ background: CARD, border: `1px solid ${BD2}`, borderRadius: 12, padding: 12 }}>
                    <p style={{ color: '#2d3f55', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>Wallets Scanned</p>
                    <p style={{ color: '#ffffff', fontSize: 22, fontWeight: 700, marginTop: 6, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                      {syncState
                        ? <>{syncState.processed ?? 0}<span style={{ fontSize: 16, fontWeight: 400, color: '#2d4060' }}> / {syncState.trackedWalletsTotal ?? stats.trackedWallets}</span></>
                        : <span style={{ color: '#2d3f55' }}>—</span>}
                    </p>
                  </div>
                  <div style={{ background: CARD, border: `1px solid ${BD2}`, borderRadius: 12, padding: 12 }}>
                    <p style={{ color: '#2d3f55', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>Alerts Found</p>
                    <p style={{ color: '#ffffff', fontSize: 22, fontWeight: 700, marginTop: 6, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                      {syncState?.inserted != null ? syncState.inserted : <span style={{ color: '#2d3f55' }}>—</span>}
                    </p>
                  </div>
                </div>

                {/* Coverage */}
                {covPct !== null ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ color: '#2d3f55', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>Scan Coverage</span>
                      <span style={{ color: '#5eead4', fontSize: 12, fontWeight: 700 }}>{covPct}%</span>
                    </div>
                    <div style={{ height: 5, background: 'rgba(255,255,255,0.05)', borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${covPct}%`, background: 'linear-gradient(90deg,#2dd4bf,#8b5cf6)', borderRadius: 999, transition: 'width 0.4s ease' }}/>
                    </div>
                  </div>
                ) : (
                  <div>
                    <span style={{ color: '#2d3f55', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>Scan Coverage</span>
                    <p style={{ color: '#1e3050', fontSize: 12, marginTop: 4 }}>Available after first sync</p>
                  </div>
                )}

                {(syncState?.providerErrors ?? 0) > 0 && (
                  <p style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.16)', color: '#fcd34d', borderRadius: 10, padding: '8px 12px', fontSize: 11 }}>
                    ⚠ {syncState?.providerErrors} provider error{(syncState?.providerErrors ?? 0) > 1 ? 's' : ''} — some alerts may be delayed.
                  </p>
                )}

                {/* Buttons */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => { void runSync(syncState?.nextOffset ?? 0) }}
                    disabled={syncing}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      background: 'linear-gradient(90deg,#1da89a 0%,#2dd4bf 100%)',
                      border: '1px solid rgba(45,212,191,0.30)',
                      borderRadius: 12, padding: '11px 16px',
                      color: '#ffffff', fontSize: 14, fontWeight: 700,
                      opacity: syncing ? 0.5 : 1,
                    }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                    </svg>
                    {syncing ? 'Scanning…' : syncState?.nextOffset != null ? 'Sync next batch' : 'Run sync'}
                  </button>
                  <button
                    onClick={resetFilters}
                    disabled={syncing}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'rgba(255,255,255,0.04)',
                      border: `1px solid ${BD}`,
                      borderRadius: 12, padding: '11px 16px',
                      color: '#475569', fontSize: 13, fontWeight: 600,
                      opacity: syncing ? 0.4 : 1,
                    }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                    Reset
                  </button>
                </div>

                <button style={{ color: '#1e3050', fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', textAlign: 'left' }}>
                  + Advanced Diagnostics
                </button>

              </div>
            </div>

          </div>
        </div>

        {/* ══ ALERT FEED ═══════════════════════════════════════════════ */}
        <div className="overflow-hidden rounded-[20px]" style={{ background: CARD, border: `1px solid ${BD}` }}>

          {/* Feed header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
            style={{ borderBottom: `1px solid ${BD2}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }}/>
                <h2 style={{ color: '#ffffff', fontSize: 14, fontWeight: 700 }}>Alert Feed</h2>
              </div>
              {alerts.length > 0 && (
                <span style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${BD2}`, borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 700, color: '#475569' }}>
                  {alerts.length}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: `1px solid ${BD2}`, color: '#2d4060', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
              </button>
              <button style={{ display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: `1px solid ${BD2}`, color: '#2d4060', padding: '5px 12px', fontSize: 11, fontWeight: 500 }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                Pause
              </button>
              <button onClick={goClark} style={{ display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8, background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.26)', color: '#c4b5fd', padding: '5px 12px', fontSize: 11, fontWeight: 600 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Skeleton */}
          {loading && Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="animate-pulse" style={{ borderBottom: `1px solid ${BD2}`, borderLeft: '3px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px' }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,0.04)', flexShrink: 0 }}/>
              <div style={{ flex: 1 }}>
                <div style={{ height: 11, width: '55%', borderRadius: 6, background: 'rgba(255,255,255,0.05)', marginBottom: 8 }}/>
                <div style={{ height: 9, width: '35%', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}/>
              </div>
              <div style={{ width: 52, height: 20, borderRadius: 999, background: 'rgba(255,255,255,0.04)' }}/>
            </div>
          ))}

          {/* Error */}
          {feedError && !loading && (
            <div style={{ textAlign: 'center', padding: '48px 20px' }}>
              <div style={{ width: 44, height: 44, borderRadius: 14, background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p style={{ color: '#fda4af', fontWeight: 700, fontSize: 14 }}>Feed unavailable</p>
              <p style={{ color: '#2d4060', fontSize: 12, marginTop: 4 }}>The request failed. Sync may still be active.</p>
              <button onClick={() => void loadAlerts()} style={{ marginTop: 16, background: 'rgba(255,255,255,0.06)', border: `1px solid ${BD}`, borderRadius: 10, padding: '8px 20px', fontSize: 12, fontWeight: 600, color: '#ffffff' }}>
                Retry
              </button>
            </div>
          )}

          {/* Empty */}
          {!feedError && !loading && alerts.length === 0 && (
            <div style={{ textAlign: 'center', padding: '64px 20px' }}>
              <div style={{ width: 52, height: 52, borderRadius: 16, background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <p style={{ color: '#ffffff', fontWeight: 700, fontSize: 15 }}>No whale alerts yet</p>
              <p style={{ color: '#2d4060', fontSize: 13, marginTop: 8, maxWidth: 380, margin: '8px auto 0' }}>
                ChainLens is watching selected Base wallets. No qualifying movements indexed yet.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 20 }}>
                <Chip color="slate">{stats.trackedWallets ? `${stats.trackedWallets} tracked` : 'Wallets unavailable'}</Chip>
                <Chip color="teal">{syncState ? 'Sync active' : 'No sync yet'}</Chip>
                <Chip color={(syncState?.providerErrors ?? 0) > 0 ? 'amber' : 'purple'}>
                  {(syncState?.providerErrors ?? 0) > 0 ? 'Provider degraded' : 'Provider healthy'}
                </Chip>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && !loading && alerts.length > 0 && alerts.map((alert, i) => {
            const side  = getSide(alert.side)
            const tok   = alert.token_symbol || alert.token_name || '???'
            const avatarLabel = tok.slice(0, 3).toUpperCase()
            const amtUsd  = fmtUsd(alert.amount_usd)
            const amtTok  = fmtToken(alert.amount_token, alert.token_symbol)
            const desc    = rowDesc(alert.severity)
            const sevL    = sevLabel(alert.severity)
            const s       = alert.side?.toLowerCase() ?? ''
            const action  = s === 'buy' ? 'bought' : s === 'sell' ? 'sold' : 'transferred'

            return (
              <div key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                style={{ borderBottom: `1px solid ${BD2}`, borderLeft: `3px solid ${side.line}`, background: 'transparent', transition: 'background 0.12s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.016)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 20px' }}>

                  {/* Avatar */}
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: side.avatarBg, border: `1px solid ${side.line}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#ffffff', flexShrink: 0, marginTop: 2 }}>
                    {avatarLabel}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>

                    {/* Line 1 */}
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 6px' }}>
                      <span style={{ background: side.chipBg, border: `1px solid ${side.chipBd}`, color: side.chipTx, borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em' }}>
                        {side.label}
                      </span>
                      <span style={{ color: '#ffffff', fontSize: 13, fontWeight: 600 }}>
                        {short(alert.wallet_address)}{' '}
                        <span style={{ color: '#3a5470' }}>{action}</span>{' '}
                        <span style={{ color: amtUsd === '—' ? '#2d4060' : '#5eead4', fontWeight: 700 }}>{amtUsd}</span>
                        <span style={{ color: '#3a5470' }}> of </span>
                        <span style={{ color: '#ffffff', fontWeight: 700 }}>{tok}</span>
                      </span>
                    </div>

                    {/* Line 2 */}
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '3px 8px', marginTop: 5 }}>
                      <span style={{ background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.16)', color: '#2dd4bf', borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
                        TRACKED
                      </span>
                      <span style={{ color: '#2d4060', fontFamily: 'monospace', fontSize: 11 }}>{short(alert.wallet_address)}</span>
                      {alert.token_name && <span style={{ color: '#1e3050', fontSize: 11 }}>· {alert.token_name}</span>}
                      {amtTok && <span style={{ color: '#1e3050', fontSize: 11 }}>· {amtTok}</span>}
                    </div>

                    {/* Line 3 */}
                    {desc && <p style={{ color: '#1a2d40', fontSize: 11, marginTop: 3 }}>{desc}</p>}
                  </div>

                  {/* Right */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0 }}>
                    {sevL && (
                      <span style={{ ...sevStyle(alert.severity), borderRadius: 999, padding: '2px 10px', fontSize: 9, fontWeight: 800, letterSpacing: '0.12em' }}>
                        {sevL}
                      </span>
                    )}
                    <span style={{ color: '#1a2d40', fontSize: 11, fontFamily: 'monospace' }}>{timeAgo(alert.occurred_at)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {alert.tx_hash && (
                        <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer"
                          style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: `1px solid ${BD2}`, color: '#2d4060', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </a>
                      )}
                      <button onClick={goClark}
                        style={{ display: 'none', alignItems: 'center', gap: 4, borderRadius: 7, background: 'rgba(139,92,246,0.09)', border: '1px solid rgba(139,92,246,0.22)', color: '#a78bfa', padding: '4px 10px', fontSize: 10, fontWeight: 700 }}
                        className="sm:!flex">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        Clark
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )
          })}

          {/* Footer */}
          {alerts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderTop: `1px solid ${BD2}` }}>
              <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#1a2d40' }}>stream · base.alerts.v2</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                {[{ c: '#2dd4bf', l: 'BUY' }, { c: '#f43f5e', l: 'SELL' }, { c: '#8b5cf6', l: 'TRANSFER' }].map(({ c, l }) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, display: 'inline-block' }}/>
                    <span style={{ color: '#1a2d40', fontSize: 11 }}>{l}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

        </div>

      </div>
    </div>
  )
}
