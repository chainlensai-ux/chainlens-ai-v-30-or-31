'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

/* ─── Types ─────────────────────────────────────────────────────────────────── */

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

/* ─── Constants ─────────────────────────────────────────────────────────────── */

const MIN_OPTIONS = [
  { label: 'All',   value: 0     },
  { label: '$100+', value: 100   },
  { label: '$500+', value: 500   },
  { label: '$1k+',  value: 1000  },
  { label: '$5k+',  value: 5000  },
  { label: '$10k+', value: 10000 },
]

const WINDOWS = ['15m', '1h', '6h', '24h'] as const

/* ─── Helpers ───────────────────────────────────────────────────────────────── */

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
  if (k === 'buy')  return { color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.30)',  text: '#86efac', label: 'BUY'      }
  if (k === 'sell') return { color: '#f43f5e', bg: 'rgba(244,63,94,0.12)',  border: 'rgba(244,63,94,0.30)',  text: '#fda4af', label: 'SELL'     }
  return               { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.30)', text: '#c4b5fd', label: 'TRANSFER' }
}

const severityColor = (sev: string | null | undefined): string => {
  if (sev === 'major')  return '#f43f5e'
  if (sev === 'large')  return '#fb923c'
  if (sev === 'medium') return '#fbbf24'
  return '#64748b'
}

/* ─── Design tokens ─────────────────────────────────────────────────────────── */

const CARD = { background: 'rgba(8,13,22,0.82)', border: '1px solid rgba(255,255,255,0.07)' }
const CARD_INNER = { background: 'rgba(5,9,18,0.70)', border: '1px solid rgba(255,255,255,0.06)' }

/* ─── Micro components ──────────────────────────────────────────────────────── */

function Chip({
  children,
  color = 'slate',
  dot,
}: {
  children: React.ReactNode
  color?: 'slate' | 'teal' | 'purple' | 'pink' | 'cyan' | 'amber'
  dot?: boolean
}) {
  const palettes: Record<string, { bg: string; border: string; text: string; dotColor: string }> = {
    slate:  { bg: 'rgba(148,163,184,0.07)', border: 'rgba(148,163,184,0.14)', text: '#94a3b8', dotColor: '#64748b' },
    teal:   { bg: 'rgba(45,212,191,0.09)',  border: 'rgba(45,212,191,0.22)',  text: '#5eead4', dotColor: '#2dd4bf' },
    purple: { bg: 'rgba(139,92,246,0.09)',  border: 'rgba(139,92,246,0.22)',  text: '#c4b5fd', dotColor: '#8b5cf6' },
    pink:   { bg: 'rgba(236,72,153,0.09)',  border: 'rgba(236,72,153,0.22)',  text: '#f9a8d4', dotColor: '#ec4899' },
    cyan:   { bg: 'rgba(34,211,238,0.09)',  border: 'rgba(34,211,238,0.22)',  text: '#67e8f9', dotColor: '#22d3ee' },
    amber:  { bg: 'rgba(251,191,36,0.09)',  border: 'rgba(251,191,36,0.22)',  text: '#fcd34d', dotColor: '#f59e0b' },
  }
  const p = palettes[color]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: p.bg, border: `1px solid ${p.border}`, color: p.text }}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full flex-shrink-0 animate-pulse" style={{ background: p.dotColor }} />}
      {children}
    </span>
  )
}

function FilterBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
      style={
        active
          ? { background: 'rgba(45,212,191,0.13)', border: '1px solid rgba(45,212,191,0.38)', color: '#5eead4', boxShadow: '0 0 14px rgba(45,212,191,0.14)' }
          : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8' }
      }
    >
      {children}
    </button>
  )
}

function DarkSelect({
  value,
  onChange,
  label,
  children,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="wa-select w-full appearance-none rounded-xl px-3 py-2.5 text-sm outline-none transition-colors cursor-pointer"
          style={{ background: '#050912', border: '1px solid rgba(255,255,255,0.09)', color: '#e2e8f0' }}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-600">
          <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
        </span>
      </div>
    </div>
  )
}

function StatRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${accent ? 'text-rose-400' : 'text-slate-200'}`}>{value}</span>
    </div>
  )
}

/* Decorative radar / live visual for hero */
function LiveRadar() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-teal-400">Live wallet movement</p>
      <div className="relative h-[64px] overflow-hidden rounded-xl" style={{ background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.10)' }}>
        <svg width="100%" height="64" viewBox="0 0 260 64" preserveAspectRatio="none" fill="none">
          <defs>
            <linearGradient id="waSpark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.28"/>
              <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
            </linearGradient>
          </defs>
          <path d="M0 48 L22 42 L40 32 L62 38 L80 22 L100 28 L120 15 L140 21 L160 11 L180 17 L200 9 L220 13 L240 6 L260 9" stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.75"/>
          <path d="M0 48 L22 42 L40 32 L62 38 L80 22 L100 28 L120 15 L140 21 L160 11 L180 17 L200 9 L220 13 L240 6 L260 9 L260 64 L0 64Z" fill="url(#waSpark)"/>
          <circle cx="260" cy="9" r="3.5" fill="#2dd4bf" opacity="0.9"/>
          <circle cx="260" cy="9" r="6" fill="#2dd4bf" opacity="0.18"/>
        </svg>
        <span className="absolute bottom-2 right-3 text-[10px] font-mono text-teal-400/60">Base · live</span>
      </div>
    </div>
  )
}

/* ─── Page ──────────────────────────────────────────────────────────────────── */

export default function WhaleAlertsPage() {
  /* Filter state */
  const [windowValue, setWindowValue] = useState<(typeof WINDOWS)[number]>('24h')
  const [minUsd, setMinUsd]           = useState(100)
  const [typeFilter, setTypeFilter]   = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [sideFilter, setSideFilter]   = useState('all')

  /* Data state */
  const [alerts,    setAlerts]    = useState<AlertItem[]>([])
  const [stats,     setStats]     = useState<AlertStats>({ alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
  const [loading,   setLoading]   = useState(false)
  const [syncing,   setSyncing]   = useState(false)
  const [syncState, setSyncState] = useState<SyncResponse | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)

  /* Load alerts from API — preserves original fetch logic */
  const loadAlerts = useCallback(async () => {
    setLoading(true)
    setFeedError(null)
    try {
      const p = new URLSearchParams({ window: windowValue, minUsd: String(minUsd), limit: '100' })
      if (typeFilter    !== 'all') p.set('type',     typeFilter)
      if (severityFilter !== 'all') p.set('severity', severityFilter)
      if (sideFilter    !== 'all') p.set('side',     sideFilter)
      const res  = await fetch(`/api/whale-alerts?${p.toString()}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error('feed_unavailable')
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
    } catch {
      setFeedError('Whale Alerts could not load right now. The sync engine may still be online, but the feed request failed.')
    } finally {
      setLoading(false)
    }
  }, [windowValue, minUsd, typeFilter, severityFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  /* Batch sync — preserves original POST logic */
  const runSync = async (offset: number) => {
    setSyncing(true)
    try {
      const res  = await fetch(
        `/api/whale-alerts/sync?window=7d&limit=5&offset=${offset}&minUsd=${minUsd}`,
        { method: 'POST' },
      )
      const json = (await res.json()) as SyncResponse
      setSyncState(json)
      await loadAlerts()
    } finally {
      setSyncing(false)
    }
  }

  /* Reset all filters and sync state */
  const resetFilters = () => {
    setWindowValue('24h')
    setMinUsd(100)
    setTypeFilter('all')
    setSeverityFilter('all')
    setSideFilter('all')
    setSyncState(null)
  }

  /* Derived filter options from real alert data */
  const types      = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.alert_type).filter(Boolean)))], [alerts])
  const severities = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.severity).filter(Boolean)))], [alerts])
  const sides      = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.side).filter(Boolean)))], [alerts])

  // Clark prompt helpers - single source of truth
  const lastSyncSummary = syncState
    ? `${syncState.processed ?? 0} scanned / ${syncState.inserted ?? 0} inserted`
    : 'Unavailable'
  const providerSummary = syncState
    ? ((syncState.providerErrors ?? 0) > 0 ? `Degraded (${syncState.providerErrors ?? 0} errors)` : 'Healthy')
    : 'Unavailable'
  const buildClarkPrompt = () => {
    if (alerts.length > 0) {
      return `Review my Whale Alerts feed. Current visible alerts: ${alerts.length}. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider status: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain the key wallet movement signals and what to monitor next. Do not invent missing data.`
    }
    return `Review my Whale Alerts setup. No qualifying whale alerts are currently visible. Tracked wallets: ${stats.trackedWallets || 'unavailable'}. Last sync: ${lastSyncSummary}. Provider status: ${providerSummary}. Filters: window ${windowValue}, minUsd ${minUsd}, type ${typeFilter}, severity ${severityFilter}, side ${sideFilter}. Explain what this means, what may be missing, and what to monitor next. Do not invent alerts or balances.`
  }

  const goClark = () => {
    window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1`
  }

  return (
    <div
      className="whale-alerts-page min-h-dvh overflow-x-hidden text-white"
      style={{ background: 'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(45,212,191,0.07) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 90% 10%, rgba(139,92,246,0.07) 0%, transparent 55%), #060810' }}
    >
      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8 space-y-5">

        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <section
          className="rounded-[28px] p-5 sm:p-7"
          style={{ ...CARD, boxShadow: '0 0 80px rgba(45,212,191,0.06), 0 24px 60px rgba(0,0,0,0.5)' }}
        >
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            {/* Left */}
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Whale Alerts · Base Mainnet</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">Whale Alerts</h1>
              <p className="mt-2 text-sm text-slate-400 max-w-lg">Track selected Base wallets for meaningful token movement.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Chip color="cyan" dot>Base Mainnet</Chip>
                <Chip color="slate">{stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Wallets loading'}</Chip>
                <Chip color="teal" dot>{syncing ? 'Syncing…' : 'Sync Online'}</Chip>
                <Chip color="purple">CORTEX Watching</Chip>
              </div>
            </div>
            {/* Right: radar panel */}
            <div className="w-full lg:w-[260px] flex-shrink-0 rounded-2xl p-4" style={CARD_INNER}>
              <LiveRadar />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.12)' }}>
                  <p className="text-[10px] text-teal-400/70 uppercase tracking-widest">15m alerts</p>
                  <p className="mt-0.5 text-lg font-semibold text-white tabular-nums">{stats.alerts15m}</p>
                </div>
                <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.12)' }}>
                  <p className="text-[10px] text-violet-400/70 uppercase tracking-widest">1h alerts</p>
                  <p className="mt-0.5 text-lg font-semibold text-white tabular-nums">{stats.alerts1h}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Metric cards ─────────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: 'Tracked Wallets',  value: stats.trackedWallets || '—', hint: stats.trackedWallets ? 'Active on Base' : 'Unavailable',                accent: 'rgba(45,212,191,0.5)' },
            { label: 'Feed Alerts',      value: alerts.length || '—',        hint: 'After current filters',                                                 accent: 'rgba(139,92,246,0.5)' },
            { label: 'Last Sync',        value: syncState ? `${syncState.processed ?? 0} scanned` : '—', hint: syncState ? `${syncState.inserted ?? 0} inserted` : 'No sync yet', accent: 'rgba(96,165,250,0.5)' },
            { label: 'Provider Status',  value: syncState ? ((syncState.providerErrors ?? 0) > 0 ? 'Degraded' : 'Healthy') : '—', hint: syncState ? `${syncState.providerErrors ?? 0} errors` : 'Run sync first', accent: (syncState?.providerErrors ?? 0) > 0 ? 'rgba(244,63,94,0.5)' : 'rgba(34,197,94,0.5)' },
          ].map((m) => (
            <div key={m.label} className="rounded-2xl p-5" style={CARD}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{m.label}</p>
              <p className="mt-2 text-3xl font-semibold tabular-nums text-white">{m.value}</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="h-px flex-1 rounded" style={{ background: m.accent, opacity: 0.4 }} />
                <p className="text-[11px] text-slate-500">{m.hint}</p>
              </div>
            </div>
          ))}
        </section>

        {/* ── Controls + Sync ───────────────────────────────────────────────── */}
        <section
          className="rounded-[24px] overflow-hidden"
          style={CARD}
        >
          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr]">

            {/* Left: Filters */}
            <div className="p-5 sm:p-6 space-y-5" style={{ borderRight: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Filters</p>

              {/* Time window */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500">Time window</p>
                <div className="flex flex-wrap gap-2">
                  {WINDOWS.map((w) => (
                    <FilterBtn key={w} active={windowValue === w} onClick={() => setWindowValue(w)}>{w}</FilterBtn>
                  ))}
                </div>
              </div>

              {/* Min USD */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500">Minimum value</p>
                <div className="flex flex-wrap gap-2">
                  {MIN_OPTIONS.map((m) => (
                    <FilterBtn key={m.value} active={minUsd === m.value} onClick={() => setMinUsd(m.value)}>{m.label}</FilterBtn>
                  ))}
                </div>
              </div>

              {/* Selects */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <DarkSelect label="Alert type" value={typeFilter} onChange={setTypeFilter}>
                  <option value="all">All types</option>
                  {types.filter(Boolean).filter((o) => o !== 'all').map((o) => <option key={o} value={o ?? ''}>{o}</option>)}
                </DarkSelect>
                <DarkSelect label="Severity" value={severityFilter} onChange={setSeverityFilter}>
                  <option value="all">All severity</option>
                  {severities.filter(Boolean).filter((o) => o !== 'all').map((o) => <option key={o} value={o ?? ''}>{o}</option>)}
                </DarkSelect>
                <DarkSelect label="Side" value={sideFilter} onChange={setSideFilter}>
                  <option value="all">All sides</option>
                  {sides.filter(Boolean).filter((o) => o !== 'all').map((o) => <option key={o} value={o ?? ''}>{o}</option>)}
                </DarkSelect>
              </div>
            </div>

            {/* Right: Sync panel */}
            <div className="p-5 sm:p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Wallet sync</p>
                <Chip color={syncing ? 'amber' : 'teal'} dot>{syncing ? 'Syncing…' : 'Sync Online'}</Chip>
              </div>

              {/* Sync stats */}
              <div className="flex-1 rounded-xl p-1" style={CARD_INNER}>
                <StatRow
                  label="Wallets scanned"
                  value={syncState ? `${syncState.processed ?? 0} / ${syncState.trackedWalletsTotal ?? stats.trackedWallets}` : '—'}
                />
                <StatRow
                  label="Alerts inserted"
                  value={syncState?.inserted != null ? String(syncState.inserted) : '—'}
                />
                <StatRow
                  label="Next offset"
                  value={syncState ? (syncState.nextOffset != null ? String(syncState.nextOffset) : 'Complete') : '—'}
                />
                <StatRow
                  label="Provider errors"
                  value={syncState?.providerErrors != null ? String(syncState.providerErrors) : '—'}
                  accent={(syncState?.providerErrors ?? 0) > 0}
                />
                {loading && (
                  <div className="py-2.5 text-center">
                    <span className="text-[11px] text-slate-500">Refreshing feed…</span>
                  </div>
                )}
              </div>

              {(syncState?.providerErrors ?? 0) > 0 && (
                <p className="rounded-xl px-3 py-2 text-xs text-amber-300" style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)' }}>
                  Some provider errors occurred. Sync is online but alerts may be delayed.
                </p>
              )}

              {/* Buttons */}
              <div className="flex gap-3 mt-auto">
                <button
                  onClick={resetFilters}
                  disabled={syncing}
                  className="flex-1 rounded-xl py-2.5 text-xs font-medium text-slate-300 transition-all hover:text-white disabled:opacity-40"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)' }}
                >
                  Reset filters
                </button>
                <button
                  onClick={() => { void runSync(syncState?.nextOffset ?? 0) }}
                  disabled={syncing}
                  className="flex-1 rounded-xl py-2.5 text-xs font-semibold disabled:opacity-40 transition-opacity"
                  style={{ background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 60%, #ec4899 100%)', color: '#030712' }}
                >
                  {syncing ? 'Scanning…' : syncState?.nextOffset != null ? 'Sync next batch' : 'Run sync'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ── Alert feed ───────────────────────────────────────────────────── */}
        <section className="rounded-[24px] overflow-hidden" style={CARD}>

          {/* Feed header */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-white">Alert feed</h2>
              <Chip color="teal" dot>Live</Chip>
              {alerts.length > 0 && <span className="text-xs text-slate-500">{alerts.length} alerts</span>}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={goClark}
                className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-all"
                style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.28)', color: '#c4b5fd' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Ask Clark
              </button>
            </div>
          </div>

          {/* Loading skeleton */}
          {loading && (
            <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-4 animate-pulse">
                  <div className="h-5 w-14 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)' }} />
                  <div className="h-3 flex-1 rounded" style={{ background: 'rgba(255,255,255,0.04)' }} />
                  <div className="h-3 w-16 rounded" style={{ background: 'rgba(255,255,255,0.04)' }} />
                </div>
              ))}
            </div>
          )}

          {/* Error state */}
          {feedError && !loading && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm font-semibold text-rose-300">Feed unavailable</p>
              <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">The sync engine may still be online, but the feed request failed.</p>
              <button
                onClick={() => void loadAlerts()}
                className="mt-4 rounded-xl px-4 py-2 text-xs font-medium text-slate-200 transition-all"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)' }}
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!feedError && !loading && alerts.length === 0 && (
            <div className="px-5 py-12 text-center">
              <div
                className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl"
                style={{ background: 'rgba(45,212,191,0.07)', border: '1px solid rgba(45,212,191,0.14)' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
              </div>
              <p className="text-base font-semibold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-400 leading-relaxed">
                ChainLens is tracking selected Base wallets, but no qualifying movements have been indexed yet.
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Chip color="slate">{stats.trackedWallets ? `${stats.trackedWallets} tracked wallets` : 'Wallets unavailable'}</Chip>
                <Chip color="teal">{syncState ? 'Sync active' : 'No sync yet'}</Chip>
                <Chip color={( syncState?.providerErrors ?? 0) > 0 ? 'amber' : 'purple'}>{(syncState?.providerErrors ?? 0) > 0 ? 'Provider degraded' : 'Provider stable'}</Chip>
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
                    className="flex flex-wrap items-start gap-3 px-5 py-4 transition-colors"
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      borderLeft: `3px solid ${side.color}`,
                    }}
                  >
                    {/* Side pill */}
                    <span
                      className="mt-0.5 flex-shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wider"
                      style={{ background: side.bg, border: `1px solid ${side.border}`, color: side.text }}
                    >
                      {side.label}
                    </span>

                    {/* Main content */}
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-sm text-slate-100 truncate">{actionSummary(alert)}</p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-xs text-slate-500 font-mono truncate max-w-[140px]" title={alert.wallet_address ?? undefined}>{label}</span>
                        {sym && <span className="text-xs text-slate-500">{sym}</span>}
                        {alert.severity && (
                          <span className="text-xs font-medium" style={{ color: severityColor(alert.severity) }}>{alert.severity}</span>
                        )}
                      </div>
                    </div>

                    {/* Right: time + links */}
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <span className="text-[11px] tabular-nums text-slate-500">{timeAgo(alert.occurred_at)}</span>
                      {alert.tx_hash && (
                        <a
                          href={`https://basescan.org/tx/${alert.tx_hash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg px-2 py-1 text-[11px] text-slate-400 transition-colors hover:text-teal-300"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                          title="View on Basescan"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        </a>
                      )}
                      <button
                        onClick={goClark}
                        className="hidden sm:inline-flex rounded-lg px-2 py-1 text-[11px] font-medium text-violet-300 transition-colors"
                        style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.20)' }}
                      >
                        Ask Clark
                      </button>
                    </div>
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
