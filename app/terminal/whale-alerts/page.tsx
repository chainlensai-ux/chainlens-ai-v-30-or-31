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

type AlertStats = {
  alerts15m: number
  alerts1h: number
  alerts24h: number
  trackedWallets: number
}

type SyncResponse = {
  processed?: number
  inserted?: number
  nextOffset?: number | null
  providerErrors?: number
  trackedWalletsTotal?: number
  offset?: number
}

const MIN_OPTIONS = [
  { label: 'All',   value: 0     },
  { label: '$100+', value: 100   },
  { label: '$500+', value: 500   },
  { label: '$1k+',  value: 1000  },
  { label: '$5k+',  value: 5000  },
  { label: '$10k+', value: 10000 },
]

const WINDOWS = ['15m', '1h', '6h', '24h'] as const

const short = (v?: string | null) =>
  !v ? 'Unknown' : `${v.slice(0, 6)}…${v.slice(-4)}`

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
  if (amt === '—') return `Token transfer · ${tok}`
  return `Transferred ${amt} of ${tok}`
}

const getSide = (s: string | null | undefined) => {
  const k = (s ?? '').toLowerCase()
  if (k === 'buy')  return { color: '#22c55e', bgChip: 'rgba(34,197,94,0.13)',  borderChip: 'rgba(34,197,94,0.32)',  textChip: '#86efac', label: 'BUY'      }
  if (k === 'sell') return { color: '#f43f5e', bgChip: 'rgba(244,63,94,0.13)',  borderChip: 'rgba(244,63,94,0.32)',  textChip: '#fda4af', label: 'SELL'     }
  return               { color: '#8b5cf6', bgChip: 'rgba(139,92,246,0.13)', borderChip: 'rgba(139,92,246,0.32)', textChip: '#c4b5fd', label: 'TRANSFER' }
}

const sevColor = (sev: string | null | undefined) => {
  if (sev === 'major')  return '#f43f5e'
  if (sev === 'large')  return '#fb923c'
  if (sev === 'medium') return '#fbbf24'
  return '#64748b'
}

/* ── Inline style constants (avoids JIT purge issues) ── */
const S = {
  card:      { background: 'rgba(7,16,27,0.90)',  border: '1px solid rgba(255,255,255,0.08)' } as React.CSSProperties,
  cardInner: { background: 'rgba(4,10,20,0.70)',  border: '1px solid rgba(255,255,255,0.06)' } as React.CSSProperties,
  syncPanel: { background: 'linear-gradient(135deg,rgba(139,92,246,0.10) 0%,rgba(45,212,191,0.04) 100%)', border: '1px solid rgba(139,92,246,0.20)' } as React.CSSProperties,
}

/* ── Small reusable components ── */

function StatusPill({ children, color = 'slate', dot }: { children: React.ReactNode; color?: 'slate'|'teal'|'purple'|'cyan'|'amber'; dot?: boolean }) {
  const c = {
    slate:  { bg:'rgba(148,163,184,0.08)', br:'rgba(148,163,184,0.16)', tx:'#94a3b8', dt:'#64748b' },
    teal:   { bg:'rgba(45,212,191,0.09)',  br:'rgba(45,212,191,0.24)',  tx:'#5eead4', dt:'#2dd4bf' },
    purple: { bg:'rgba(139,92,246,0.09)',  br:'rgba(139,92,246,0.24)',  tx:'#c4b5fd', dt:'#8b5cf6' },
    cyan:   { bg:'rgba(34,211,238,0.09)',  br:'rgba(34,211,238,0.24)',  tx:'#67e8f9', dt:'#22d3ee' },
    amber:  { bg:'rgba(251,191,36,0.09)',  br:'rgba(251,191,36,0.24)',  tx:'#fcd34d', dt:'#f59e0b' },
  }[color]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-[11px] font-medium" style={{ background: c.bg, border: `1px solid ${c.br}`, color: c.tx }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: c.dt }} />}
      {children}
    </span>
  )
}

function WinBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all" style={active
      ? { background:'rgba(45,212,191,0.14)', border:'1px solid rgba(45,212,191,0.40)', color:'#5eead4', boxShadow:'0 0 12px rgba(45,212,191,0.12)' }
      : { background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', color:'#64748b' }
    }>{children}</button>
  )
}

function ValBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-xl px-3 py-1.5 text-xs font-medium transition-all" style={active
      ? { background:'rgba(139,92,246,0.14)', border:'1px solid rgba(139,92,246,0.38)', color:'#c4b5fd' }
      : { background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', color:'#64748b' }
    }>{children}</button>
  )
}

function DkSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</span>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)} className="wa-select w-full cursor-pointer appearance-none rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background:'#050912', border:'1px solid rgba(255,255,255,0.09)', color:'#e2e8f0' }}>
          {children}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-600">
          <svg width="9" height="5" viewBox="0 0 9 5" fill="currentColor"><path d="M0 0l4.5 5L9 0z"/></svg>
        </span>
      </div>
    </div>
  )
}

/* ── Page ── */

export default function WhaleAlertsPage() {
  const [windowValue, setWindowValue] = useState<(typeof WINDOWS)[number]>('24h')
  const [minUsd,      setMinUsd]      = useState(100)
  const [typeFilter,      setTypeFilter]      = useState('all')
  const [severityFilter,  setSeverityFilter]  = useState('all')
  const [sideFilter,      setSideFilter]      = useState('all')

  const [alerts,    setAlerts]    = useState<AlertItem[]>([])
  const [stats,     setStats]     = useState<AlertStats>({ alerts15m:0, alerts1h:0, alerts24h:0, trackedWallets:0 })
  const [loading,   setLoading]   = useState(false)
  const [syncing,   setSyncing]   = useState(false)
  const [syncState, setSyncState] = useState<SyncResponse | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)

  /* Load alerts — original fetch logic unchanged */
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
    } catch {
      setFeedError('Feed request failed.')
    } finally {
      setLoading(false)
    }
  }, [windowValue, minUsd, typeFilter, severityFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  /* Sync — original POST logic unchanged */
  const runSync = async (offset: number) => {
    setSyncing(true)
    try {
      const res  = await fetch(`/api/whale-alerts/sync?window=7d&limit=5&offset=${offset}&minUsd=${minUsd}`, { method: 'POST' })
      const json = (await res.json()) as SyncResponse
      setSyncState(json)
      await loadAlerts()
    } finally {
      setSyncing(false)
    }
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
    if (alerts.length > 0) return `Review my Whale Alerts feed. Visible alerts: ${alerts.length}. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain signals and what to monitor. Do not invent data.`
    return `Review my Whale Alerts setup. No alerts visible. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain what this means. Do not invent alerts.`
  }
  const goClark = () => { window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1` }

  /* ── Render ── */
  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden text-white" style={{ background: 'radial-gradient(ellipse 90% 40% at 50% -5%,rgba(45,212,191,0.07),transparent 60%),radial-gradient(ellipse 60% 35% at 85% 5%,rgba(139,92,246,0.07),transparent 55%),#060810' }}>
      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 space-y-6">

        {/* ── 1. HERO ── */}
        <section className="rounded-[28px] p-6" style={{ ...S.card, boxShadow: '0 0 80px rgba(45,212,191,0.06),0 24px 60px rgba(0,0,0,0.55)' }}>
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">

            {/* Left */}
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Whale Alerts · Base Mainnet</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Whale Alerts</h1>
              <p className="mt-2 text-sm text-slate-400 max-w-lg">Track selected Base wallets for meaningful token movement.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <StatusPill color="cyan" dot>Base Mainnet</StatusPill>
                <StatusPill color="slate">{stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}</StatusPill>
                <StatusPill color="teal" dot>{syncing ? 'Syncing…' : 'Sync Online'}</StatusPill>
                <StatusPill color="purple">CORTEX Watching</StatusPill>
              </div>
            </div>

            {/* Right: compact radar panel ≈360px */}
            <div className="w-full lg:w-[360px] flex-shrink-0 rounded-2xl p-4" style={S.cardInner}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-400">Live Wallet Movement</p>
              <p className="mt-1 text-xs text-slate-500">Listening for high-signal wallet moves on Base.</p>
              {/* Mini radar + sparkline */}
              <div className="mt-3 flex items-center gap-3">
                {/* CSS radar circle */}
                <div className="relative flex-shrink-0 h-[56px] w-[56px]">
                  <div className="absolute inset-0 rounded-full" style={{ border:'1px solid rgba(45,212,191,0.18)' }} />
                  <div className="absolute inset-[8px] rounded-full" style={{ border:'1px solid rgba(45,212,191,0.12)' }} />
                  <div className="absolute inset-[18px] rounded-full" style={{ background:'rgba(45,212,191,0.18)', border:'1px solid rgba(45,212,191,0.35)' }} />
                  <div className="absolute inset-[24px] rounded-full" style={{ background:'rgba(45,212,191,0.55)' }} />
                </div>
                {/* Sparkline */}
                <div className="flex-1 min-w-0">
                  <svg width="100%" height="40" viewBox="0 0 200 40" preserveAspectRatio="none" fill="none">
                    <defs>
                      <linearGradient id="hSpark" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.28"/>
                        <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
                      </linearGradient>
                    </defs>
                    <path d="M0 32 L20 26 L38 18 L58 22 L76 12 L96 16 L116 8 L136 13 L156 5 L176 9 L200 4" stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.8"/>
                    <path d="M0 32 L20 26 L38 18 L58 22 L76 12 L96 16 L116 8 L136 13 L156 5 L176 9 L200 4 L200 40 L0 40Z" fill="url(#hSpark)"/>
                    <circle cx="200" cy="4" r="3" fill="#2dd4bf" opacity="0.9"/>
                  </svg>
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* ── 2. METRICS (4-card grid) ── */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label:'15m Alerts',       val: stats.alerts15m,      sub: stats.alerts15m === 0 ? 'No new alerts' : `+${stats.alerts15m} new`,      accent:'rgba(45,212,191,0.5)',  icon:'🔔' },
            { label:'1h Alerts',        val: stats.alerts1h,       sub: stats.alerts1h  === 0 ? 'No new alerts' : `+${stats.alerts1h} new`,       accent:'rgba(139,92,246,0.5)', icon:'🔔' },
            { label:'24h Alerts',       val: stats.alerts24h,      sub: stats.alerts24h === 0 ? 'No new alerts' : `+${stats.alerts24h} new`,      accent:'rgba(236,72,153,0.5)', icon:'🔔' },
            { label:'Tracked Wallets',  val: stats.trackedWallets, sub: stats.trackedWallets ? 'Active on Base' : 'Unavailable',                   accent:'rgba(96,165,250,0.5)',  icon:'👛' },
          ].map((m) => (
            <div key={m.label} className="relative overflow-hidden rounded-2xl p-5 min-h-[124px] flex flex-col justify-between" style={S.card}>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{m.label}</p>
                <p className="mt-2 text-3xl font-semibold tabular-nums text-white">{m.val}</p>
                <p className="mt-1 text-xs text-slate-500">{m.sub}</p>
              </div>
              {/* Bottom accent bar */}
              <div className="mt-3 h-[2px] w-full rounded-full" style={{ background: `linear-gradient(90deg,${m.accent} 0%,transparent 70%)`, opacity: 0.5 }} />
              {/* Corner glow */}
              <div className="pointer-events-none absolute right-0 top-0 h-20 w-20 rounded-bl-full" style={{ background: `radial-gradient(circle at top right,${m.accent.replace('0.5','0.08')},transparent 70%)` }} />
            </div>
          ))}
        </section>

        {/* ── 3. CONTROLS + SYNC ── */}
        <section className="rounded-[24px] p-5" style={S.card}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.35fr_0.9fr]">

            {/* Left: Filters */}
            <div className="space-y-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Filters</p>

              {/* Time window */}
              <div className="space-y-2">
                <p className="text-xs text-slate-400">Time Window</p>
                <div className="flex flex-wrap gap-2 rounded-xl p-1.5" style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)' }}>
                  {WINDOWS.map(w => <WinBtn key={w} active={windowValue === w} onClick={() => setWindowValue(w)}>{w}</WinBtn>)}
                </div>
              </div>

              {/* Minimum value */}
              <div className="space-y-2">
                <p className="text-xs text-slate-400">Minimum Value</p>
                <div className="flex flex-wrap gap-2">
                  {MIN_OPTIONS.map(m => <ValBtn key={m.value} active={minUsd === m.value} onClick={() => setMinUsd(m.value)}>{m.label}</ValBtn>)}
                </div>
              </div>

              {/* Selects */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <DkSelect label="Alert Type" value={typeFilter} onChange={setTypeFilter}>
                  <option value="all">All types</option>
                  {types.filter(o => o !== 'all' && Boolean(o)).map(o => <option key={o} value={o ?? ''}>{o}</option>)}
                </DkSelect>
                <DkSelect label="Severity" value={severityFilter} onChange={setSeverityFilter}>
                  <option value="all">All severity</option>
                  {severities.filter(o => o !== 'all' && Boolean(o)).map(o => <option key={o} value={o ?? ''}>{o}</option>)}
                </DkSelect>
                <DkSelect label="Side" value={sideFilter} onChange={setSideFilter}>
                  <option value="all">All sides</option>
                  {sides.filter(o => o !== 'all' && Boolean(o)).map(o => <option key={o} value={o ?? ''}>{o}</option>)}
                </DkSelect>
              </div>
            </div>

            {/* Right: Wallet Sync Panel */}
            <div className="flex flex-col gap-3 rounded-2xl p-4" style={S.syncPanel}>
              {/* Header */}
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-white">Wallet Scan</p>
                <StatusPill color={syncing ? 'amber' : 'teal'} dot>{syncing ? 'Syncing…' : 'Sync Healthy'}</StatusPill>
              </div>

              {/* Stat boxes */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl p-3" style={S.cardInner}>
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">Wallets scanned</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-white">
                    {syncState ? `${syncState.processed ?? 0}/${syncState.trackedWalletsTotal ?? stats.trackedWallets}` : '—'}
                  </p>
                </div>
                <div className="rounded-xl p-3" style={S.cardInner}>
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">Alerts found</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-white">
                    {syncState?.inserted != null ? syncState.inserted : '—'}
                  </p>
                </div>
              </div>

              {/* Coverage bar */}
              {syncState && (syncState.trackedWalletsTotal ?? 0) > 0 ? (
                <div>
                  <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
                    <span>Coverage</span>
                    <span>{Math.round(((syncState.processed ?? 0) / (syncState.trackedWalletsTotal ?? 1)) * 100)}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background:'rgba(255,255,255,0.06)' }}>
                    <div className="h-full rounded-full" style={{ width:`${Math.min(100,Math.round(((syncState.processed ?? 0)/(syncState.trackedWalletsTotal ?? 1))*100))}%`, background:'linear-gradient(90deg,#2dd4bf,#8b5cf6)' }} />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500">Coverage data available after first sync.</p>
              )}

              {(syncState?.providerErrors ?? 0) > 0 && (
                <p className="rounded-xl px-3 py-2 text-xs text-amber-300" style={{ background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.18)' }}>
                  {syncState?.providerErrors} provider error{(syncState?.providerErrors ?? 0) > 1 ? 's' : ''} — some alerts may be delayed.
                </p>
              )}

              {loading && <p className="text-center text-[11px] text-slate-500">Refreshing…</p>}

              {/* Buttons */}
              <div className="mt-auto flex gap-2 pt-1">
                <button onClick={resetFilters} disabled={syncing} className="flex-1 rounded-xl py-2.5 text-xs font-medium text-slate-400 transition-all hover:text-white disabled:opacity-40" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)' }}>
                  Reset
                </button>
                <button onClick={() => { void runSync(syncState?.nextOffset ?? 0) }} disabled={syncing} className="flex-1 rounded-xl py-2.5 text-xs font-semibold transition-opacity disabled:opacity-40" style={{ background:'linear-gradient(135deg,#2DD4BF 0%,#8b5cf6 60%,#ec4899 100%)', color:'#030712' }}>
                  {syncing ? 'Scanning…' : syncState?.nextOffset != null ? 'Sync next batch' : 'Run sync'}
                </button>
              </div>
            </div>

          </div>
        </section>

        {/* ── 4. ALERT FEED ── */}
        <section className="overflow-hidden rounded-[24px]" style={S.card}>

          {/* Feed header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" style={{ borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-white">Alert feed</h2>
              <StatusPill color="teal" dot>Auto-update</StatusPill>
              {alerts.length > 0 && <span className="text-xs text-slate-500">{alerts.length} alerts</span>}
            </div>
            <div className="flex items-center gap-2">
              {/* Filter icon */}
              <button className="flex h-8 w-8 items-center justify-center rounded-xl transition-all" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#64748b' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              </button>
              {/* Pause */}
              <button className="flex h-8 w-8 items-center justify-center rounded-xl transition-all" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', color:'#64748b' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              </button>
              {/* Ask Clark */}
              <button onClick={goClark} className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-all" style={{ background:'rgba(139,92,246,0.12)', border:'1px solid rgba(139,92,246,0.28)', color:'#c4b5fd' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Loading skeleton */}
          {loading && (
            <div>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-4 animate-pulse" style={{ borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                  <div className="h-6 w-16 rounded-lg flex-shrink-0" style={{ background:'rgba(255,255,255,0.06)' }} />
                  <div className="h-3 flex-1 rounded" style={{ background:'rgba(255,255,255,0.04)' }} />
                  <div className="h-3 w-20 rounded flex-shrink-0" style={{ background:'rgba(255,255,255,0.04)' }} />
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {feedError && !loading && (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-semibold text-rose-300">Feed unavailable</p>
              <p className="mt-1 text-xs text-slate-500">The feed request failed. Sync may still be online.</p>
              <button onClick={() => void loadAlerts()} className="mt-4 rounded-xl px-4 py-2 text-xs font-medium text-slate-200" style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.09)' }}>Retry</button>
            </div>
          )}

          {/* Empty state */}
          {!feedError && !loading && alerts.length === 0 && (
            <div className="px-5 py-14 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background:'rgba(45,212,191,0.07)', border:'1px solid rgba(45,212,191,0.14)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <p className="text-base font-semibold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-400 leading-relaxed">ChainLens is tracking selected Base wallets, but no qualifying movements have been indexed yet.</p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <StatusPill color="slate">{stats.trackedWallets ? `${stats.trackedWallets} tracked wallets` : 'Wallets unavailable'}</StatusPill>
                <StatusPill color="teal">{syncState ? 'Sync active' : 'No sync yet'}</StatusPill>
                <StatusPill color={(syncState?.providerErrors ?? 0) > 0 ? 'amber' : 'purple'}>{(syncState?.providerErrors ?? 0) > 0 ? 'Provider degraded' : 'Provider stable'}</StatusPill>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && !loading && alerts.length > 0 && (
            <div>
              {alerts.map((alert, i) => {
                const side  = getSide(alert.side)
                const label = alert.wallet_label || short(alert.wallet_address)
                const sym   = alert.token_symbol || alert.token_name

                return (
                  <div
                    key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                    className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                    style={{ borderBottom:'1px solid rgba(255,255,255,0.05)', borderLeft:`3px solid ${side.color}` }}
                  >
                    {/* Action pill */}
                    <span className="flex-shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider" style={{ background:side.bgChip, border:`1px solid ${side.borderChip}`, color:side.textChip }}>
                      {side.label}
                    </span>

                    {/* Summary */}
                    <span className="flex-1 min-w-0 truncate text-sm text-slate-100">{actionSummary(alert)}</span>

                    {/* Token */}
                    {sym && <span className="hidden sm:inline text-xs text-slate-500 flex-shrink-0">{sym}</span>}

                    {/* Severity */}
                    {alert.severity && (
                      <span className="hidden md:inline flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: sevColor(alert.severity), background:`${sevColor(alert.severity)}18`, border:`1px solid ${sevColor(alert.severity)}30` }}>
                        {alert.severity}
                      </span>
                    )}

                    {/* Wallet */}
                    <span className="hidden lg:inline font-mono text-[11px] text-slate-500 flex-shrink-0 max-w-[100px] truncate" title={alert.wallet_address ?? undefined}>{label}</span>

                    {/* Time */}
                    <span className="flex-shrink-0 tabular-nums text-[11px] text-slate-500">{timeAgo(alert.occurred_at)}</span>

                    {/* Tx link */}
                    {alert.tx_hash && (
                      <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer" className="flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:text-teal-300 text-slate-500" style={{ background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)' }} title="Basescan">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      </a>
                    )}

                    {/* Ask Clark */}
                    <button onClick={goClark} className="hidden sm:flex flex-shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-medium text-violet-300 transition-colors" style={{ background:'rgba(139,92,246,0.08)', border:'1px solid rgba(139,92,246,0.20)' }}>
                      Ask Clark
                    </button>
                  </div>
                )
              })}
            </div>
          )}

        </section>

      </div>
    </div>
  )
}
