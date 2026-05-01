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
  if (k === 'buy')  return { line: '#2dd4bf', avatarBg: '#0d3b35', chipBg: 'rgba(45,212,191,0.12)',  chipBd: 'rgba(45,212,191,0.32)',  chipTx: '#5eead4', label: 'BUY'      }
  if (k === 'sell') return { line: '#f43f5e', avatarBg: '#3d0d1a', chipBg: 'rgba(244,63,94,0.12)',   chipBd: 'rgba(244,63,94,0.32)',   chipTx: '#fda4af', label: 'SELL'     }
  return               { line: '#8b5cf6', avatarBg: '#1e0d3b', chipBg: 'rgba(139,92,246,0.12)',  chipBd: 'rgba(139,92,246,0.32)',  chipTx: '#c4b5fd', label: 'TRANSFER' }
}

const sevLabel = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return 'HIGH'
  if (sev === 'medium') return 'MED'
  if (sev === 'low') return 'LOW'
  return sev?.toUpperCase() ?? null
}

const sevStyle = (sev: string | null | undefined): React.CSSProperties => {
  if (sev === 'major' || sev === 'large') return { background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.30)', color: '#fda4af' }
  if (sev === 'medium') return { background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.28)', color: '#fcd34d' }
  return { background: 'rgba(100,116,139,0.09)', border: '1px solid rgba(100,116,139,0.20)', color: '#64748b' }
}

const rowDesc = (sev: string | null | undefined) => {
  if (sev === 'major' || sev === 'large') return '● High value movement'
  if (sev === 'medium') return '● Fresh tracked-wallet activity'
  if (sev === 'low') return '● Below whale threshold'
  return null
}

/* ── tokens ── */
const C  = 'rgba(11,20,38,1)'       /* card — solid, clearly distinct from page */
const CI = 'rgba(6,11,22,1)'        /* inner well */
const B  = 'rgba(255,255,255,0.09)' /* border */
const BI = 'rgba(255,255,255,0.06)' /* inner border */

/* ── atoms ── */

function Pill({ children, color = 'slate', dot }: { children: React.ReactNode; color?: string; dot?: boolean }) {
  const m: Record<string, { bg: string; bd: string; tx: string; dt: string }> = {
    slate:  { bg: 'rgba(148,163,184,0.08)', bd: 'rgba(148,163,184,0.18)', tx: '#94a3b8', dt: '#64748b' },
    teal:   { bg: 'rgba(45,212,191,0.09)',  bd: 'rgba(45,212,191,0.26)',  tx: '#5eead4', dt: '#2dd4bf' },
    purple: { bg: 'rgba(139,92,246,0.09)',  bd: 'rgba(139,92,246,0.26)',  tx: '#c4b5fd', dt: '#8b5cf6' },
    cyan:   { bg: 'rgba(34,211,238,0.09)',  bd: 'rgba(34,211,238,0.26)',  tx: '#67e8f9', dt: '#22d3ee' },
    amber:  { bg: 'rgba(251,191,36,0.09)',  bd: 'rgba(251,191,36,0.26)',  tx: '#fcd34d', dt: '#f59e0b' },
    green:  { bg: 'rgba(34,197,94,0.09)',   bd: 'rgba(34,197,94,0.26)',   tx: '#86efac', dt: '#22c55e' },
  }
  const c = m[color] ?? m.slate
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[11px] font-medium"
      style={{ background: c.bg, border: `1px solid ${c.bd}`, color: c.tx }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dt }} />}
      {children}
    </span>
  )
}

function Spark({ color, seed = 0 }: { color: string; seed?: number }) {
  const lines = [
    'M0 30 L16 23 L32 17 L48 21 L64 12 L80 15 L96 8 L112 11 L128 4 L144 6 L160 2',
    'M0 28 L16 21 L32 25 L48 15 L64 19 L80 10 L96 14 L112 6 L128 10 L144 3 L160 5',
    'M0 24 L16 30 L32 20 L48 26 L64 14 L80 18 L96 9 L112 14 L128 5 L144 10 L160 3',
    'M0 26 L16 20 L32 15 L48 22 L64 11 L80 16 L96 7 L112 12 L128 3 L144 8 L160 2',
  ]
  const d = lines[seed % 4]
  const id = `sk${seed}-${color.replace('#', '')}`
  return (
    <svg width="160" height="40" viewBox="0 0 160 40" fill="none" className="absolute bottom-0 right-0 opacity-50">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L160 40 L0 40Z`} fill={`url(#${id})`} />
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <circle cx="160" cy="2" r="2.2" fill={color} />
    </svg>
  )
}

/* ── page ── */

export default function WhaleAlertsPage() {
  const [windowValue, setWindowValue] = useState<(typeof WINDOWS)[number]>('1h')
  const [minUsd,      setMinUsd]      = useState(100)
  const [typeFilter,  setTypeFilter]  = useState('all')
  const [sevFilter,   setSevFilter]   = useState('all')
  const [sideFilter,  setSideFilter]  = useState('all')

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
      if (typeFilter !== 'all') p.set('type',     typeFilter)
      if (sevFilter  !== 'all') p.set('severity', sevFilter)
      if (sideFilter !== 'all') p.set('side',     sideFilter)
      const res  = await fetch(`/api/whale-alerts?${p}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error()
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
    } catch { setFeedError('Feed request failed.') }
    finally  { setLoading(false) }
  }, [windowValue, minUsd, typeFilter, sevFilter, sideFilter])

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
    setTypeFilter('all'); setSevFilter('all'); setSideFilter('all')
    setSyncState(null)
  }

  const types = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.alert_type).filter(Boolean) as string[]))], [alerts])
  const sevs  = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.severity).filter(Boolean)   as string[]))], [alerts])
  const sides = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.side).filter(Boolean)       as string[]))], [alerts])

  // Clark prompt — single source of truth
  const lastSyncSummary = syncState ? `${syncState.processed ?? 0} scanned / ${syncState.inserted ?? 0} inserted` : 'Unavailable'
  const providerSummary = syncState ? ((syncState.providerErrors ?? 0) > 0 ? `Degraded (${syncState.providerErrors} errors)` : 'Healthy') : 'Unavailable'
  const buildClarkPrompt = () => {
    if (alerts.length > 0) return `Review my Whale Alerts feed. Visible alerts: ${alerts.length}. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${sevFilter}, side ${sideFilter}. Explain signals. Do not invent data.`
    return `Review my Whale Alerts setup. No alerts visible. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${sevFilter}, side ${sideFilter}. Explain what this means. Do not invent alerts.`
  }
  const goClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  const covPct = syncState && (syncState.trackedWalletsTotal ?? 0) > 0
    ? Math.min(100, Math.round(((syncState.processed ?? 0) / (syncState.trackedWalletsTotal ?? 1)) * 100)) : null

  const metrics = [
    { label: 'ALERTS · 15M',    val: stats.alerts15m,      sub: 'Last quarter hour',    color: '#2dd4bf' },
    { label: 'ALERTS · 1H',     val: stats.alerts1h,       sub: 'Past 60 minutes',       color: '#2dd4bf' },
    { label: 'ALERTS · 24H',    val: stats.alerts24h,      sub: 'Rolling day window',    color: '#8b5cf6' },
    { label: 'TRACKED WALLETS', val: stats.trackedWallets, sub: 'Smart money + manual',  color: '#ec4899' },
  ]

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden text-white"
      style={{ background: 'radial-gradient(ellipse 80% 55% at 50% -10%,rgba(45,212,191,0.08) 0%,transparent 55%),radial-gradient(ellipse 50% 40% at 85% 5%,rgba(139,92,246,0.06) 0%,transparent 50%),#06070f' }}>

      <div className="mx-auto max-w-[1280px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">

        {/* ══════════ HERO ══════════ */}
        <div className="rounded-[28px] p-6"
          style={{ background: C, border: `1px solid ${B}`, boxShadow: '0 0 80px rgba(45,212,191,0.05),0 24px 64px rgba(0,0,0,0.55)' }}>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center">

            {/* Left */}
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: '#2dd4bf' }}>Whale Alerts</span>
                <span style={{ color: '#1a2d3f', fontSize: 14 }}>·</span>
                <span className="text-[11px] uppercase tracking-[0.12em]" style={{ color: '#243344' }}>base mainnet</span>
              </div>
              <h1 className="text-[2.6rem] font-extrabold leading-tight tracking-tight text-white">Whale Alerts</h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed" style={{ color: '#3d5570' }}>
                Track selected Base wallets for meaningful token movement.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Pill color="cyan" dot>Base Mainnet</Pill>
                <Pill color="slate">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 2, opacity: 0.7 }}>
                    <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
                  </svg>
                  {stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}
                </Pill>
                <Pill color="teal" dot>{syncing ? 'Syncing…' : 'Batch Sync Online'}</Pill>
                <Pill color="purple" dot>CORTEX Watching</Pill>
              </div>
            </div>

            {/* Right — radar panel */}
            <div className="w-full shrink-0 rounded-2xl p-4 lg:w-[360px]"
              style={{ background: CI, border: `1px solid ${BI}` }}>
              <div className="flex items-start gap-4">
                {/* CSS radar rings */}
                <div className="relative mt-0.5 h-[76px] w-[76px] shrink-0">
                  {[0, 9, 18, 27, 34].map((ins, ri) => (
                    <div key={ri} className="absolute rounded-full" style={{
                      inset: ins,
                      border: ri < 4 ? `1px solid rgba(45,212,191,${[0.10, 0.14, 0.20, 0.30][ri]})` : 'none',
                      background: ri === 3 ? 'rgba(45,212,191,0.09)' : ri === 4 ? 'rgba(45,212,191,0.78)' : 'transparent',
                      boxShadow: ri === 4 ? '0 0 10px rgba(45,212,191,0.85)' : 'none',
                    }} />
                  ))}
                  <div className="absolute rounded-full"
                    style={{ width: 7, height: 7, top: 9, left: '50%', transform: 'translateX(-50%)', background: '#22c55e', boxShadow: '0 0 8px #22c55e' }} />
                </div>
                {/* Text + sparkline */}
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: '#22c55e' }}>● Live Wallet Movement</p>
                  <p className="mt-1 text-xs leading-relaxed" style={{ color: '#2d4257' }}>Listening for high-signal wallet moves on Base.</p>
                  <div className="mt-3">
                    <svg width="100%" height="28" viewBox="0 0 200 28" preserveAspectRatio="none" fill="none">
                      <defs>
                        <linearGradient id="hsg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.20" />
                          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path d="M0 25 L22 20 L44 15 L66 18 L88 10 L110 13 L132 6 L154 9 L176 3 L200 2"
                        stroke="#2dd4bf" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.70" />
                      <path d="M0 25 L22 20 L44 15 L66 18 L88 10 L110 13 L132 6 L154 9 L176 3 L200 2 L200 28 L0 28Z"
                        fill="url(#hsg)" />
                      <circle cx="200" cy="2" r="2.2" fill="#2dd4bf" opacity="0.9" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ══════════ METRICS ══════════ */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((m, idx) => (
            <div key={m.label} className="relative min-h-[124px] overflow-hidden rounded-2xl p-5"
              style={{ background: C, border: `1px solid ${B}` }}>
              <div className="flex items-start justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl"
                  style={{ background: `${m.color}14`, border: `1px solid ${m.color}28` }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={m.color} strokeWidth="2.2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </div>
              </div>
              <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: '#2d3f55' }}>{m.label}</p>
              <p className="mt-0.5 text-[2.6rem] font-extrabold leading-none tabular-nums text-white">{m.val}</p>
              <p className="mt-1.5 text-xs" style={{ color: '#354f68' }}>{m.sub}</p>
              <Spark color={m.color} seed={idx} />
              <div className="absolute bottom-0 left-0 right-0 h-[2px]"
                style={{ background: `linear-gradient(90deg,${m.color}55,transparent)` }} />
            </div>
          ))}
        </div>

        {/* ══════════ CONTROLS + SYNC ══════════ */}
        <div className="rounded-[24px] p-5"
          style={{ background: C, border: `1px solid ${B}` }}>
          <div className="flex flex-col gap-5 lg:flex-row">

            {/* Left — filters */}
            <div className="flex flex-col gap-5 lg:w-3/5">

              <div>
                <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: '#2d3f55' }}>Time Window</p>
                <div className="flex gap-1 rounded-xl p-1" style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${BI}`, width: 'fit-content' }}>
                  {WINDOWS.map(w => (
                    <button key={w} onClick={() => setWindowValue(w)}
                      className="rounded-[9px] px-4 py-1.5 text-xs font-semibold transition-all"
                      style={windowValue === w
                        ? { background: 'rgba(45,212,191,0.14)', border: '1px solid rgba(45,212,191,0.42)', color: '#2dd4bf', boxShadow: '0 0 14px rgba(45,212,191,0.12)' }
                        : { background: 'transparent', border: '1px solid transparent', color: '#334155' }}>
                      {w}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: '#2d3f55' }}>Minimum Value</p>
                <div className="flex flex-wrap gap-2">
                  {MIN_OPTIONS.map(m => (
                    <button key={m.value} onClick={() => setMinUsd(m.value)}
                      className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
                      style={minUsd === m.value
                        ? { background: 'rgba(45,212,191,0.14)', border: '1px solid rgba(45,212,191,0.42)', color: '#2dd4bf' }
                        : { background: 'rgba(255,255,255,0.03)', border: `1px solid ${BI}`, color: '#334155' }}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  { label: 'Alert Type', val: typeFilter, set: setTypeFilter, opts: types },
                  { label: 'Severity',   val: sevFilter,  set: setSevFilter,  opts: sevs  },
                  { label: 'Side',       val: sideFilter, set: setSideFilter, opts: sides },
                ].map(({ label, val, set, opts }) => (
                  <div key={label} className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: '#2d3f55' }}>{label}</span>
                    <div className="relative">
                      <select value={val} onChange={e => set(e.target.value)}
                        className="wa-select w-full appearance-none rounded-xl px-3 py-2.5 text-sm outline-none"
                        style={{ background: CI, border: `1px solid ${B}`, color: '#94a3b8' }}>
                        {opts.map(o => <option key={o} value={o}>{o === 'all' ? `All ${label}s` : o}</option>)}
                      </select>
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" style={{ color: '#2d3f55' }}>
                        <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z" /></svg>
                      </span>
                    </div>
                  </div>
                ))}
              </div>

            </div>

            {/* Right — wallet sync */}
            <div className="flex flex-col gap-3 rounded-2xl p-4 lg:w-2/5"
              style={{ background: 'linear-gradient(135deg,rgba(139,92,246,0.09) 0%,rgba(45,212,191,0.04) 100%)', border: '1px solid rgba(139,92,246,0.22)' }}>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl"
                    style={{ background: 'rgba(139,92,246,0.14)', border: '1px solid rgba(139,92,246,0.28)' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="2">
                      <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white">Wallet scan</p>
                    <p className="text-[11px]" style={{ color: '#334155' }}>{syncState ? 'Scan complete' : 'No scan yet'}</p>
                  </div>
                </div>
                <Pill color={syncing ? 'amber' : 'teal'} dot>{syncing ? 'Syncing…' : 'Sync Healthy'}</Pill>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3" style={{ background: CI, border: `1px solid ${BI}` }}>
                  <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#2d3f55' }}>Wallets Scanned</p>
                  <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-white">
                    {syncState
                      ? <>{syncState.processed ?? 0}<span className="text-base font-normal" style={{ color: '#334155' }}> / {syncState.trackedWalletsTotal ?? stats.trackedWallets}</span></>
                      : <span style={{ color: '#2d3f55' }}>—</span>}
                  </p>
                </div>
                <div className="rounded-xl p-3" style={{ background: CI, border: `1px solid ${BI}` }}>
                  <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: '#2d3f55' }}>Alerts Found</p>
                  <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-white">
                    {syncState?.inserted != null ? syncState.inserted : <span style={{ color: '#2d3f55' }}>—</span>}
                  </p>
                </div>
              </div>

              {covPct !== null ? (
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest" style={{ color: '#2d3f55' }}>
                    <span>Scan Coverage</span><span style={{ color: '#94a3b8' }}>{covPct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${covPct}%`, background: 'linear-gradient(90deg,#2dd4bf,#8b5cf6)' }} />
                  </div>
                </div>
              ) : (
                <p className="text-[11px]" style={{ color: '#2d3f55' }}>Run sync to see coverage</p>
              )}

              {(syncState?.providerErrors ?? 0) > 0 && (
                <p className="rounded-xl px-3 py-2 text-[11px]"
                  style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)', color: '#fcd34d' }}>
                  {syncState?.providerErrors} provider error{(syncState?.providerErrors ?? 0) > 1 ? 's' : ''} — some alerts may be delayed.
                </p>
              )}

              {loading && !syncing && <p className="text-center text-[11px]" style={{ color: '#2d3f55' }}>Refreshing feed…</p>}

              <div className="flex gap-2">
                <button onClick={() => { void runSync(syncState?.nextOffset ?? 0) }} disabled={syncing}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-all disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#1aa99c 0%,#8b5cf6 100%)', color: '#fff', boxShadow: '0 0 22px rgba(45,212,191,0.14)' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                  {syncing ? 'Scanning…' : syncState?.nextOffset != null ? 'Sync next batch' : 'Run sync'}
                </button>
                <button onClick={resetFilters} disabled={syncing}
                  className="flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-all disabled:opacity-40"
                  style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${B}`, color: '#64748b' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                  Reset
                </button>
              </div>

              <button className="text-left text-[10px] font-bold uppercase tracking-widest transition-opacity hover:opacity-80"
                style={{ color: '#2d3f55' }}>
                + Advanced Diagnostics
              </button>

            </div>
          </div>
        </div>

        {/* ══════════ FEED ══════════ */}
        <div className="overflow-hidden rounded-[24px]"
          style={{ background: C, border: `1px solid ${B}` }}>

          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
            style={{ borderBottom: `1px solid ${BI}`, background: 'rgba(255,255,255,0.012)' }}>
            <div className="flex items-center gap-3">
              <h2 className="text-[15px] font-bold text-white">Alert feed</h2>
              <Pill color="green" dot>Auto-update</Pill>
              {alerts.length > 0 && (
                <span className="text-xs" style={{ color: '#334155' }}>{alerts.length} matching</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button className="flex h-7 w-7 items-center justify-center rounded-lg"
                style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${BI}`, color: '#334155' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
              </button>
              <button className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium"
                style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${BI}`, color: '#475569' }}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
                </svg>
                Pause
              </button>
              <button onClick={goClark}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-all hover:opacity-90"
                style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.28)', color: '#c4b5fd' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Skeleton */}
          {loading && Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex animate-pulse items-center gap-4 px-5 py-4"
              style={{ borderBottom: `1px solid ${BI}`, borderLeft: '3px solid rgba(255,255,255,0.04)' }}>
              <div className="h-9 w-9 shrink-0 rounded-xl" style={{ background: 'rgba(255,255,255,0.05)' }} />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-3/5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }} />
                <div className="h-2.5 w-2/5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)' }} />
              </div>
              <div className="h-5 w-14 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }} />
            </div>
          ))}

          {/* Error */}
          {feedError && !loading && (
            <div className="px-5 py-12 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{ background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.18)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className="text-sm font-bold" style={{ color: '#fda4af' }}>Feed unavailable</p>
              <p className="mt-1 text-xs" style={{ color: '#334155' }}>The request failed. Sync may still be active.</p>
              <button onClick={() => void loadAlerts()}
                className="mt-4 rounded-xl px-5 py-2 text-xs font-semibold text-white"
                style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${B}` }}>
                Retry
              </button>
            </div>
          )}

          {/* Empty */}
          {!feedError && !loading && alerts.length === 0 && (
            <div className="px-5 py-16 text-center">
              <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
                style={{ background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.15)', boxShadow: '0 0 28px rgba(45,212,191,0.07)' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </div>
              <p className="text-[15px] font-bold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-[380px] text-sm leading-relaxed" style={{ color: '#334155' }}>
                ChainLens is tracking selected Base wallets, but no qualifying movements have been indexed yet.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Pill color="slate">{stats.trackedWallets ? `${stats.trackedWallets} tracked wallets` : 'Wallets unavailable'}</Pill>
                <Pill color="teal">{syncState ? 'Sync active' : 'No sync yet'}</Pill>
                <Pill color={(syncState?.providerErrors ?? 0) > 0 ? 'amber' : 'purple'}>
                  {(syncState?.providerErrors ?? 0) > 0 ? 'Provider degraded' : 'Provider healthy'}
                </Pill>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && !loading && alerts.length > 0 && alerts.map((alert, i) => {
            const side = getSide(alert.side)
            const tok  = alert.token_symbol || alert.token_name || '???'
            const lbl  = tok.slice(0, 3).toUpperCase()
            const amtU = fmtUsd(alert.amount_usd)
            const amtT = fmtToken(alert.amount_token, alert.token_symbol)
            const desc = rowDesc(alert.severity)
            const sevL = sevLabel(alert.severity)
            const s    = alert.side?.toLowerCase() ?? ''
            const act  = s === 'buy' ? 'bought' : s === 'sell' ? 'sold' : 'transferred'

            return (
              <div key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                className="group transition-colors hover:bg-white/[0.018]"
                style={{ borderBottom: `1px solid ${BI}`, borderLeft: `3px solid ${side.line}` }}>
                <div className="flex items-start gap-3 px-5 py-3.5">

                  {/* Avatar */}
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-extrabold text-white"
                    style={{ background: side.avatarBg, border: `1px solid ${side.line}22` }}>
                    {lbl}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    {/* Line 1 — action summary */}
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="rounded px-2 py-0.5 text-[10px] font-extrabold tracking-wider"
                        style={{ background: side.chipBg, border: `1px solid ${side.chipBd}`, color: side.chipTx }}>
                        {side.label}
                      </span>
                      <span className="text-sm font-semibold text-white">
                        {short(alert.wallet_address)}{' '}
                        <span style={{ color: '#2d4a5e' }}>{act}</span>{' '}
                        <span style={{ color: amtU === '—' ? '#2d3f55' : '#5eead4', fontWeight: 700 }}>{amtU}</span>
                        <span style={{ color: '#2d4a5e' }}> of </span>
                        <span className="font-bold text-white">{tok}</span>
                      </span>
                    </div>
                    {/* Line 2 — metadata chips */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]" style={{ color: '#334155' }}>
                      <span className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-widest"
                        style={{ background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.15)', color: '#2dd4bf' }}>
                        TRACKED WALLET
                      </span>
                      <span className="font-mono">{short(alert.wallet_address)}</span>
                      {alert.token_name && <span>· {alert.token_name}</span>}
                      {amtT && <span>· {amtT}</span>}
                    </div>
                    {/* Line 3 — description */}
                    {desc && <p className="mt-0.5 text-[11px]" style={{ color: '#1e3050' }}>{desc}</p>}
                  </div>

                  {/* Right — severity + time + actions */}
                  <div className="flex shrink-0 flex-col items-end gap-1.5 mt-0.5">
                    {sevL && (
                      <span className="rounded-full px-2.5 py-0.5 text-[9px] font-extrabold tracking-wider"
                        style={sevStyle(alert.severity)}>
                        {sevL}
                      </span>
                    )}
                    <span className="font-mono text-[11px]" style={{ color: '#334155' }}>{timeAgo(alert.occurred_at)}</span>
                    <div className="flex items-center gap-1.5">
                      {alert.tx_hash && (
                        <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer"
                          className="flex h-6 w-6 items-center justify-center rounded-lg transition-opacity hover:opacity-80"
                          style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${BI}`, color: '#334155' }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </a>
                      )}
                      <button onClick={goClark}
                        className="hidden items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-bold sm:flex transition-opacity hover:opacity-90"
                        style={{ background: 'rgba(139,92,246,0.10)', border: '1px solid rgba(139,92,246,0.24)', color: '#c4b5fd' }}>
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        Ask Clark
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )
          })}

          {/* Footer */}
          {alerts.length > 0 && (
            <div className="flex items-center justify-between px-5 py-3"
              style={{ borderTop: `1px solid ${BI}` }}>
              <span className="font-mono text-[10px]" style={{ color: '#1e3050' }}>stream · base.alerts.v2</span>
              <div className="flex items-center gap-4 text-[11px]">
                {[{ c: '#2dd4bf', l: 'BUY' }, { c: '#f43f5e', l: 'SELL' }, { c: '#8b5cf6', l: 'TRANSFER' }].map(({ c, l }) => (
                  <span key={l} className="flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                    <span style={{ color: '#334155' }}>{l}</span>
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
