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
  { label: 'All',   value: 0 },
  { label: '$100+', value: 100 },
  { label: '$500+', value: 500 },
  { label: '$1k+',  value: 1000 },
  { label: '$5k+',  value: 5000 },
  { label: '$10k+', value: 10000 },
]
const WINDOWS = ['15m', '1h', '6h', '24h'] as const

const short = (v?: string | null) => !v ? 'Unknown' : `${v.slice(0, 6)}…${v.slice(-4)}`

const timeAgo = (iso?: string | null): string => {
  if (!iso) return '–'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const fmtUsd = (n?: number | null): string => {
  if (n == null) return '—'
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

const actionSummary = (a: AlertItem): string => {
  const s = (a.side ?? '').toLowerCase()
  const tok = a.token_symbol || a.token_name || 'Unknown token'
  const amt = fmtUsd(a.amount_usd)
  if (s === 'buy')  return `Bought ${amt} of ${tok}`
  if (s === 'sell') return `Sold ${amt} of ${tok}`
  if (amt === '—')  return `Token transfer · ${tok}`
  return `Transferred ${amt} of ${tok}`
}

const getSide = (s: string | null | undefined) => {
  const k = (s ?? '').toLowerCase()
  if (k === 'buy')  return { line: '#22c55e', chipBg: 'rgba(34,197,94,0.12)',  chipBd: 'rgba(34,197,94,0.30)',  chipTx: '#86efac', label: 'BUY'      }
  if (k === 'sell') return { line: '#f43f5e', chipBg: 'rgba(244,63,94,0.12)',  chipBd: 'rgba(244,63,94,0.30)',  chipTx: '#fda4af', label: 'SELL'     }
  return               { line: '#8b5cf6', chipBg: 'rgba(139,92,246,0.12)', chipBd: 'rgba(139,92,246,0.30)', chipTx: '#c4b5fd', label: 'TRANSFER' }
}

const sevColor = (sev: string | null | undefined) => {
  if (sev === 'major')  return '#f43f5e'
  if (sev === 'large')  return '#fb923c'
  if (sev === 'medium') return '#fbbf24'
  return '#64748b'
}

/* card backgrounds must contrast against #07080f page bg */
const BG   = 'rgba(11,18,32,1)'       /* card surface — clearly distinct from page */
const BGI  = 'rgba(6,11,22,1)'        /* inner / inset surface */
const BD   = 'rgba(255,255,255,0.09)' /* border */
const BDI  = 'rgba(255,255,255,0.06)' /* inner border */

/* ── Tiny shared components ── */

function Pill({ children, color = 'slate', dot }: { children: React.ReactNode; color?: 'slate'|'teal'|'purple'|'cyan'|'amber'; dot?: boolean }) {
  const p = {
    slate:  { bg:'rgba(148,163,184,0.08)', bd:'rgba(148,163,184,0.18)', tx:'#94a3b8', dt:'#64748b' },
    teal:   { bg:'rgba(45,212,191,0.09)',  bd:'rgba(45,212,191,0.26)',  tx:'#5eead4', dt:'#2dd4bf' },
    purple: { bg:'rgba(139,92,246,0.09)',  bd:'rgba(139,92,246,0.26)',  tx:'#c4b5fd', dt:'#8b5cf6' },
    cyan:   { bg:'rgba(34,211,238,0.09)',  bd:'rgba(34,211,238,0.26)',  tx:'#67e8f9', dt:'#22d3ee' },
    amber:  { bg:'rgba(251,191,36,0.09)',  bd:'rgba(251,191,36,0.26)',  tx:'#fcd34d', dt:'#f59e0b' },
  }[color]
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[11px] font-medium"
      style={{ background: p.bg, border: `1px solid ${p.bd}`, color: p.tx }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.dt }} />}
      {children}
    </span>
  )
}

function WBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-xl px-4 py-2 text-xs font-semibold transition-all"
      style={active
        ? { background:'rgba(45,212,191,0.14)', border:'1px solid rgba(45,212,191,0.42)', color:'#5eead4' }
        : { background:'rgba(255,255,255,0.04)', border:`1px solid ${BDI}`, color:'#64748b' }}>
      {children}
    </button>
  )
}

function VBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-xl px-3 py-1.5 text-xs font-medium transition-all"
      style={active
        ? { background:'rgba(139,92,246,0.14)', border:'1px solid rgba(139,92,246,0.40)', color:'#c4b5fd' }
        : { background:'rgba(255,255,255,0.04)', border:`1px solid ${BDI}`, color:'#64748b' }}>
      {children}
    </button>
  )
}

function Sel({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color:'#475569' }}>{label}</span>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)}
          className="wa-select w-full cursor-pointer appearance-none rounded-xl px-3 py-2.5 text-sm outline-none"
          style={{ background: BGI, border: `1px solid ${BD}`, color:'#e2e8f0' }}>
          {children}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" style={{ color:'#475569' }}>
          <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
        </span>
      </div>
    </div>
  )
}

/* ── Page ── */

export default function WhaleAlertsPage() {
  const [windowValue,    setWindowValue]    = useState<(typeof WINDOWS)[number]>('24h')
  const [minUsd,         setMinUsd]         = useState(100)
  const [typeFilter,     setTypeFilter]     = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [sideFilter,     setSideFilter]     = useState('all')

  const [alerts,    setAlerts]    = useState<AlertItem[]>([])
  const [stats,     setStats]     = useState<AlertStats>({ alerts15m:0, alerts1h:0, alerts24h:0, trackedWallets:0 })
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
      const res  = await fetch(`/api/whale-alerts?${p.toString()}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error('feed_unavailable')
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m:0, alerts1h:0, alerts24h:0, trackedWallets:0 })
    } catch { setFeedError('Feed request failed.') }
    finally { setLoading(false) }
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
    setWindowValue('24h'); setMinUsd(100)
    setTypeFilter('all'); setSeverityFilter('all'); setSideFilter('all')
    setSyncState(null)
  }

  const types      = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.alert_type).filter(Boolean)))], [alerts])
  const severities = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.severity).filter(Boolean)))], [alerts])
  const sides      = useMemo(() => ['all', ...Array.from(new Set(alerts.map(a => a.side).filter(Boolean)))], [alerts])

  // Clark prompt helpers - single source of truth
  const lastSyncSummary = syncState ? `${syncState.processed ?? 0} scanned / ${syncState.inserted ?? 0} inserted` : 'Unavailable'
  const providerSummary = syncState ? ((syncState.providerErrors ?? 0) > 0 ? `Degraded (${syncState.providerErrors} errors)` : 'Healthy') : 'Unavailable'
  const buildClarkPrompt = () => {
    if (alerts.length > 0) return `Review my Whale Alerts feed. Visible alerts: ${alerts.length}. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain signals. Do not invent data.`
    return `Review my Whale Alerts setup. No alerts visible. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain what this means. Do not invent alerts.`
  }
  const goClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  /* coverage % for sync bar */
  const covPct = syncState && (syncState.trackedWalletsTotal ?? 0) > 0
    ? Math.min(100, Math.round(((syncState.processed ?? 0) / (syncState.trackedWalletsTotal ?? 1)) * 100))
    : null

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden text-white"
      style={{ background: 'radial-gradient(ellipse 80% 40% at 50% -8%,rgba(45,212,191,0.08),transparent 60%),radial-gradient(ellipse 55% 35% at 88% 6%,rgba(139,92,246,0.08),transparent 55%),#07080f' }}>

      <div className="mx-auto max-w-[1280px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">

        {/* ── HERO ── */}
        <div className="rounded-[28px] p-6" style={{ background: BG, border: `1px solid ${BD}`, boxShadow: '0 0 70px rgba(45,212,191,0.06),0 20px 50px rgba(0,0,0,0.5)' }}>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">

            {/* Left text */}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color:'#475569' }}>Whale Alerts · Base Mainnet</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Whale Alerts</h1>
              <p className="mt-2 max-w-lg text-sm" style={{ color:'#94a3b8' }}>Track selected Base wallets for meaningful token movement.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Pill color="cyan" dot>Base Mainnet</Pill>
                <Pill color="slate">{stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}</Pill>
                <Pill color="teal" dot>{syncing ? 'Syncing…' : 'Sync Online'}</Pill>
                <Pill color="purple">CORTEX Watching</Pill>
              </div>
            </div>

            {/* Right: compact radar panel — fixed 360px on desktop */}
            <div className="w-full shrink-0 rounded-2xl p-4 lg:w-[360px]" style={{ background: BGI, border: `1px solid ${BDI}` }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color:'#2dd4bf' }}>Live Wallet Movement</p>
              <p className="mt-1 text-xs" style={{ color:'#64748b' }}>Listening for high-signal wallet moves on Base.</p>
              <div className="mt-3 flex items-center gap-4">
                {/* CSS radar rings */}
                <div className="relative h-[60px] w-[60px] shrink-0">
                  <div className="absolute inset-0 rounded-full" style={{ border:'1px solid rgba(45,212,191,0.15)' }} />
                  <div className="absolute inset-[9px] rounded-full" style={{ border:'1px solid rgba(45,212,191,0.12)' }} />
                  <div className="absolute inset-[19px] rounded-full" style={{ background:'rgba(45,212,191,0.15)', border:'1px solid rgba(45,212,191,0.32)' }} />
                  <div className="absolute inset-[26px] rounded-full" style={{ background:'rgba(45,212,191,0.60)' }} />
                </div>
                {/* Sparkline */}
                <div className="min-w-0 flex-1">
                  <svg width="100%" height="44" viewBox="0 0 200 44" preserveAspectRatio="none" fill="none">
                    <defs>
                      <linearGradient id="waSp" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.25"/>
                        <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
                      </linearGradient>
                    </defs>
                    <path d="M0 34 L22 28 L40 20 L60 24 L80 14 L100 18 L120 9 L140 14 L160 6 L180 10 L200 3" stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.8"/>
                    <path d="M0 34 L22 28 L40 20 L60 24 L80 14 L100 18 L120 9 L140 14 L160 6 L180 10 L200 3 L200 44 L0 44Z" fill="url(#waSp)"/>
                    <circle cx="200" cy="3" r="3" fill="#2dd4bf" opacity="0.9"/>
                    <circle cx="200" cy="3" r="5.5" fill="#2dd4bf" opacity="0.15"/>
                  </svg>
                  <p className="text-right text-[10px] font-mono" style={{ color:'rgba(45,212,191,0.5)' }}>Base · live</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── METRICS (4-card grid) ── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label:'15m Alerts',      val: stats.alerts15m,      sub: stats.alerts15m === 0      ? 'No new alerts' : `+${stats.alerts15m} new`,      glow:'rgba(45,212,191,0.4)'  },
            { label:'1h Alerts',       val: stats.alerts1h,       sub: stats.alerts1h  === 0      ? 'No new alerts' : `+${stats.alerts1h} new`,       glow:'rgba(139,92,246,0.4)' },
            { label:'24h Alerts',      val: stats.alerts24h,      sub: stats.alerts24h === 0      ? 'No new alerts' : `+${stats.alerts24h} new`,      glow:'rgba(236,72,153,0.4)' },
            { label:'Tracked Wallets', val: stats.trackedWallets, sub: stats.trackedWallets > 0   ? 'Active on Base' : 'Unavailable',                  glow:'rgba(96,165,250,0.4)'  },
          ].map(m => (
            <div key={m.label} className="relative min-h-[124px] overflow-hidden rounded-2xl p-5"
              style={{ background: BG, border: `1px solid ${BD}` }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.13em]" style={{ color:'#475569' }}>{m.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-white">{m.val}</p>
              <p className="mt-1 text-xs" style={{ color:'#64748b' }}>{m.sub}</p>
              {/* Bottom accent */}
              <div className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background:`linear-gradient(90deg,${m.glow},transparent)`, opacity:0.5 }} />
              {/* Corner glow */}
              <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 rounded-bl-full"
                style={{ background:`radial-gradient(circle at top right,${m.glow.replace('0.4','0.07')},transparent 70%)` }} />
            </div>
          ))}
        </div>

        {/* ── CONTROLS + SYNC (2-column card) ── */}
        <div className="rounded-[24px] p-5" style={{ background: BG, border: `1px solid ${BD}` }}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

            {/* Left: Filters */}
            <div className="space-y-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color:'#475569' }}>Filters</p>

              {/* Time window */}
              <div className="space-y-2">
                <p className="text-xs" style={{ color:'#64748b' }}>Time Window</p>
                <div className="flex flex-wrap gap-2 rounded-xl p-1.5" style={{ background:'rgba(255,255,255,0.02)', border:`1px solid ${BDI}` }}>
                  {WINDOWS.map(w => <WBtn key={w} active={windowValue === w} onClick={() => setWindowValue(w)}>{w}</WBtn>)}
                </div>
              </div>

              {/* Min value */}
              <div className="space-y-2">
                <p className="text-xs" style={{ color:'#64748b' }}>Minimum Value</p>
                <div className="flex flex-wrap gap-2">
                  {MIN_OPTIONS.map(m => <VBtn key={m.value} active={minUsd === m.value} onClick={() => setMinUsd(m.value)}>{m.label}</VBtn>)}
                </div>
              </div>

              {/* Selects */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Sel label="Alert Type" value={typeFilter} onChange={setTypeFilter}>
                  <option value="all">All types</option>
                  {types.filter(o => o !== 'all' && Boolean(o)).map(o => <option key={o} value={o ?? ''}>{o}</option>)}
                </Sel>
                <Sel label="Severity" value={severityFilter} onChange={setSeverityFilter}>
                  <option value="all">All severity</option>
                  {severities.filter(o => o !== 'all' && Boolean(o)).map(o => <option key={o} value={o ?? ''}>{o}</option>)}
                </Sel>
                <Sel label="Side" value={sideFilter} onChange={setSideFilter}>
                  <option value="all">All sides</option>
                  {sides.filter(o => o !== 'all' && Boolean(o)).map(o => <option key={o} value={o ?? ''}>{o}</option>)}
                </Sel>
              </div>
            </div>

            {/* Right: Wallet Sync Panel */}
            <div className="flex flex-col gap-3 rounded-2xl p-4"
              style={{ background:'linear-gradient(135deg,rgba(139,92,246,0.09) 0%,rgba(45,212,191,0.04) 100%)', border:'1px solid rgba(139,92,246,0.22)' }}>

              {/* Header */}
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-white">Wallet Scan</p>
                <Pill color={syncing ? 'amber' : 'teal'} dot>{syncing ? 'Syncing…' : 'Sync Healthy'}</Pill>
              </div>

              {/* Stat boxes */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3" style={{ background: BGI, border: `1px solid ${BDI}` }}>
                  <p className="text-[10px] uppercase tracking-widest" style={{ color:'#475569' }}>Wallets scanned</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-white">
                    {syncState ? `${syncState.processed ?? 0}` : '—'}
                    {syncState && <span className="text-sm font-normal" style={{ color:'#475569' }}>/{syncState.trackedWalletsTotal ?? stats.trackedWallets}</span>}
                  </p>
                </div>
                <div className="rounded-xl p-3" style={{ background: BGI, border: `1px solid ${BDI}` }}>
                  <p className="text-[10px] uppercase tracking-widest" style={{ color:'#475569' }}>Alerts found</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-white">{syncState?.inserted ?? '—'}</p>
                </div>
              </div>

              {/* Coverage bar */}
              {covPct !== null ? (
                <div>
                  <div className="mb-1.5 flex justify-between text-[10px]" style={{ color:'#475569' }}>
                    <span>Coverage</span><span>{covPct}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background:'rgba(255,255,255,0.06)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width:`${covPct}%`, background:'linear-gradient(90deg,#2dd4bf,#8b5cf6)' }} />
                  </div>
                </div>
              ) : (
                <p className="text-xs" style={{ color:'#475569' }}>Coverage available after first sync.</p>
              )}

              {(syncState?.providerErrors ?? 0) > 0 && (
                <p className="rounded-xl px-3 py-2 text-xs" style={{ background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.18)', color:'#fcd34d' }}>
                  {syncState?.providerErrors} provider error{(syncState?.providerErrors ?? 0) > 1 ? 's' : ''} — some alerts may be delayed.
                </p>
              )}

              {loading && <p className="text-center text-[11px]" style={{ color:'#475569' }}>Refreshing…</p>}

              <div className="mt-auto flex gap-2 pt-1">
                <button onClick={resetFilters} disabled={syncing}
                  className="flex-1 rounded-xl py-2.5 text-xs font-medium text-white transition-all disabled:opacity-40"
                  style={{ background:'rgba(255,255,255,0.05)', border:`1px solid ${BD}` }}>
                  Reset
                </button>
                <button onClick={() => { void runSync(syncState?.nextOffset ?? 0) }} disabled={syncing}
                  className="flex-1 rounded-xl py-2.5 text-xs font-semibold transition-opacity disabled:opacity-40"
                  style={{ background:'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 60%,#ec4899 100%)', color:'#030712' }}>
                  {syncing ? 'Scanning…' : syncState?.nextOffset != null ? 'Sync next batch' : 'Run sync'}
                </button>
              </div>
            </div>

          </div>
        </div>

        {/* ── ALERT FEED ── */}
        <div className="overflow-hidden rounded-[24px]" style={{ background: BG, border: `1px solid ${BD}` }}>

          {/* Feed header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" style={{ borderBottom:`1px solid ${BDI}` }}>
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-white">Alert feed</h2>
              <Pill color="teal" dot>Auto-update</Pill>
              {alerts.length > 0 && <span className="text-xs" style={{ color:'#475569' }}>{alerts.length} alerts</span>}
            </div>
            <div className="flex items-center gap-2">
              <button className="flex h-8 w-8 items-center justify-center rounded-xl transition-all"
                style={{ background:'rgba(255,255,255,0.04)', border:`1px solid ${BDI}`, color:'#475569' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              </button>
              <button className="flex h-8 w-8 items-center justify-center rounded-xl transition-all"
                style={{ background:'rgba(255,255,255,0.04)', border:`1px solid ${BDI}`, color:'#475569' }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              </button>
              <button onClick={goClark} className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-all"
                style={{ background:'rgba(139,92,246,0.12)', border:'1px solid rgba(139,92,246,0.28)', color:'#c4b5fd' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Skeleton */}
          {loading && (
            <div>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-4 animate-pulse" style={{ borderBottom:`1px solid ${BDI}` }}>
                  <div className="h-6 w-16 rounded-lg shrink-0" style={{ background:'rgba(255,255,255,0.06)' }} />
                  <div className="h-3 flex-1 rounded" style={{ background:'rgba(255,255,255,0.04)' }} />
                  <div className="h-3 w-20 shrink-0 rounded" style={{ background:'rgba(255,255,255,0.04)' }} />
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {feedError && !loading && (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-semibold" style={{ color:'#fda4af' }}>Feed unavailable</p>
              <p className="mt-1 text-xs" style={{ color:'#475569' }}>The feed request failed. Sync may still be online.</p>
              <button onClick={() => void loadAlerts()} className="mt-4 rounded-xl px-4 py-2 text-xs font-medium text-white"
                style={{ background:'rgba(255,255,255,0.05)', border:`1px solid ${BD}` }}>Retry</button>
            </div>
          )}

          {/* Empty state */}
          {!feedError && !loading && alerts.length === 0 && (
            <div className="px-5 py-14 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{ background:'rgba(45,212,191,0.07)', border:'1px solid rgba(45,212,191,0.15)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <p className="text-base font-semibold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed" style={{ color:'#64748b' }}>
                ChainLens is tracking selected Base wallets, but no qualifying movements have been indexed yet.
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Pill color="slate">{stats.trackedWallets ? `${stats.trackedWallets} tracked wallets` : 'Wallets unavailable'}</Pill>
                <Pill color="teal">{syncState ? 'Sync active' : 'No sync yet'}</Pill>
                <Pill color={(syncState?.providerErrors ?? 0) > 0 ? 'amber' : 'purple'}>{(syncState?.providerErrors ?? 0) > 0 ? 'Provider degraded' : 'Provider stable'}</Pill>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && !loading && alerts.length > 0 && alerts.map((alert, i) => {
            const side  = getSide(alert.side)
            const label = alert.wallet_label || short(alert.wallet_address)
            const sym   = alert.token_symbol || alert.token_name
            return (
              <div key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.018]"
                style={{ borderBottom:`1px solid ${BDI}`, borderLeft:`3px solid ${side.line}` }}>

                {/* Action pill */}
                <span className="shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider"
                  style={{ background:side.chipBg, border:`1px solid ${side.chipBd}`, color:side.chipTx }}>
                  {side.label}
                </span>

                {/* Summary */}
                <span className="min-w-0 flex-1 truncate text-sm text-white">{actionSummary(alert)}</span>

                {/* Token */}
                {sym && <span className="hidden sm:inline shrink-0 text-xs" style={{ color:'#475569' }}>{sym}</span>}

                {/* Severity */}
                {alert.severity && (
                  <span className="hidden md:inline shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ color:sevColor(alert.severity), background:`${sevColor(alert.severity)}18`, border:`1px solid ${sevColor(alert.severity)}30` }}>
                    {alert.severity}
                  </span>
                )}

                {/* Wallet */}
                <span className="hidden lg:inline shrink-0 max-w-[96px] truncate font-mono text-[11px]" style={{ color:'#475569' }} title={alert.wallet_address ?? undefined}>{label}</span>

                {/* Time */}
                <span className="shrink-0 tabular-nums text-[11px]" style={{ color:'#475569' }}>{timeAgo(alert.occurred_at)}</span>

                {/* Tx link */}
                {alert.tx_hash && (
                  <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:text-teal-300"
                    style={{ background:'rgba(255,255,255,0.04)', border:`1px solid ${BDI}`, color:'#475569' }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}

                {/* Ask Clark */}
                <button onClick={goClark} className="hidden sm:flex shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{ background:'rgba(139,92,246,0.08)', border:'1px solid rgba(139,92,246,0.22)', color:'#c4b5fd' }}>
                  Ask Clark
                </button>
              </div>
            )
          })}

        </div>
      </div>
    </div>
  )
}
