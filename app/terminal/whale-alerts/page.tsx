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
  { label: 'All movements / testing', value: 0 },
  { label: '$100+',  value: 100   },
  { label: '$500+',  value: 500   },
  { label: '$1k+',   value: 1000  },
  { label: '$5k+',   value: 5000  },
  { label: '$10k+',  value: 10000 },
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
  if (n == null) return 'Value unavailable'
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
  if (amt === 'Value unavailable') return `Token transfer · ${tok}`
  return `Transferred ${amt} of ${tok}`
}

const getSide = (s: string | null | undefined) => {
  const k = (s ?? '').toLowerCase()
  if (k === 'buy')  return { border: '#22c55e', chip: 'bg-green-500/20 border-green-400/30 text-green-300', label: 'BUY' }
  if (k === 'sell') return { border: '#f43f5e', chip: 'bg-rose-500/20 border-rose-400/30 text-rose-300', label: 'SELL' }
  return               { border: '#8b5cf6', chip: 'bg-violet-500/20 border-violet-400/30 text-violet-300', label: 'TRANSFER' }
}

const severityColor = (sev: string | null | undefined): string => {
  if (sev === 'major')  return '#f43f5e'
  if (sev === 'large')  return '#fb923c'
  if (sev === 'medium') return '#fbbf24'
  return '#475569'
}

const compactMonospace = 'font-mono truncate max-w-full inline-block align-bottom'

/* ─── Sub-components ────────────────────────────────────────────────────────── */

function BellIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}

function WalletIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2"/>
      <line x1="1" y1="10" x2="23" y2="10"/>
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6"  y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
      <path d="M0 0l5 6 5-6z"/>
    </svg>
  )
}

function StatusChip({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'mint' | 'purple' | 'pink' | 'cyan' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/5 border-white/10 text-slate-300',
    mint: 'bg-[#2DD4BF]/10 border-[#2DD4BF]/30 text-[#7ef2da]',
    purple: 'bg-[#8b5cf6]/12 border-[#8b5cf6]/30 text-[#c4b5fd]',
    pink: 'bg-[#ec4899]/12 border-[#ec4899]/30 text-[#f9a8d4]',
    cyan: 'bg-cyan-400/10 border-cyan-400/30 text-cyan-200',
  }
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${tones[tone]}`}>{children}</span>
}

function MetricCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#080c14]/85 p-4">
      <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  )
}

function ControlButton({
  active,
  children,
  onClick,
  disabled = false,
}: {
  active?: boolean
  children: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? 'border-[#8b5cf6]/60 bg-[#8b5cf6]/20 text-white shadow-[0_0_18px_rgba(139,92,246,0.25)]'
          : 'border-white/10 bg-[#07101d] text-slate-300 hover:border-white/20 hover:text-white'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
    </button>
  )
}

function SyncStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#07101d] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-200">{value}</p>
    </div>
  )
}

/* Decorative sparkline SVG for hero */
function SparklineVisual() {
  return (
    <div className="hidden md:flex flex-col items-end gap-1.5 flex-shrink-0">
      <span className="text-[10px] text-emerald-400 font-semibold tracking-wide uppercase">
        Listening for large wallet movements on Base
      </span>
      <div className="relative">
        <svg width="190" height="46" viewBox="0 0 190 46" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="whaSparkFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#2dd4bf" stopOpacity="0.32"/>
              <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0"/>
            </linearGradient>
          </defs>
          <path
            d="M0 36 L16 32 L30 24 L46 28 L60 16 L74 20 L88 11 L102 16 L116 9 L130 13 L146 7 L160 11 L175 5 L190 7"
            stroke="#2dd4bf" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            fill="none" opacity="0.85"
          />
          <path
            d="M0 36 L16 32 L30 24 L46 28 L60 16 L74 20 L88 11 L102 16 L116 9 L130 13 L146 7 L160 11 L175 5 L190 7 L190 46 L0 46Z"
            fill="url(#whaSparkFill)"
          />
          <circle cx="190" cy="7" r="3" fill="#2dd4bf" opacity="0.9"/>
          <circle cx="190" cy="7" r="5" fill="#2dd4bf" opacity="0.2"/>
        </svg>
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

  /* Metric cards config */
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

  return (
    <div className="whale-alerts-page min-h-dvh overflow-x-hidden bg-[#06060a] px-4 py-6 text-white md:px-6">
      <div className="mx-auto max-w-7xl space-y-5">

        {/* ── Hero card ──────────────────────────────────────────────────────── */}
        <section className="rounded-2xl border border-white/10 bg-[#080c14]/90 p-5 md:p-6" style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.02), 0 24px 70px rgba(0,0,0,0.45), 0 0 50px rgba(139,92,246,0.12)' }}>
          <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-start">
            <div>
              <p className="text-[11px] uppercase tracking-[0.14em] text-slate-400">WHALE ALERTS · base mainnet</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">Whale Alerts</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-300">Track selected Base wallets for meaningful token movement.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <StatusChip tone="cyan">Base Mainnet</StatusChip>
                <StatusChip>{stats.trackedWallets > 0 ? `${stats.trackedWallets} tracked wallets` : 'Tracked wallets loading'}</StatusChip>
                <StatusChip tone="mint">{syncState ? 'Batch Sync Online' : 'Sync status unavailable'}</StatusChip>
                <StatusChip tone="purple">CORTEX Watching</StatusChip>
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#07101d] p-3 lg:min-w-[270px]">
              <p className="text-[10px] uppercase tracking-[0.13em] text-[#2DD4BF]">LIVE WALLET MOVEMENT</p>
              <p className="mt-1 text-xs text-slate-300">Listening for high-signal wallet moves on Base.</p>
              <SparklineVisual />
            </div>
          </div>
        </section>

        {/* ── Metric cards ───────────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Tracked Wallets" value={stats.trackedWallets || '—'} hint={stats.trackedWallets ? 'Configured in tracked wallets set' : 'Unavailable'} />
          <MetricCard label="Alerts Found" value={alerts.length || '—'} hint="Current loaded alerts after filters" />
          <MetricCard label="Last Sync" value={syncState ? `${syncState.processed ?? 0} scanned` : '—'} hint={syncState ? `Inserted ${syncState.inserted ?? 0}` : 'No sync result yet'} />
          <MetricCard label="Provider Status" value={syncState ? ((syncState.providerErrors ?? 0) > 0 ? 'Degraded' : 'Healthy') : 'Unavailable'} hint={syncState ? `${syncState.providerErrors ?? 0} provider errors` : 'Sync status unavailable'} />
        </section>

        {/* ── Combined filter + sync panel ───────────────────────────────────── */}
        <section className="rounded-2xl border border-white/10 bg-[#080c14]/90 p-4 md:p-5">
          <div className="grid gap-4 lg:grid-cols-2">

            {/* Left: Filters */}
            <div className="space-y-4 rounded-2xl border border-white/10 bg-[#07101d] p-4">

              {/* Time window segmented control */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Time window</div>
                <div className="flex flex-wrap gap-2">
                  {WINDOWS.map((w) => (
                    <ControlButton
                      key={w}
                      onClick={() => setWindowValue(w)}
                      active={windowValue === w}
                    >
                      {w}
                    </ControlButton>
                  ))}
                </div>
              </div>

              {/* Minimum USD chips */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Minimum USD value</div>
                <div className="flex flex-wrap gap-2">
                  {MIN_OPTIONS.map((m) => (
                    <ControlButton
                      key={m.value}
                      onClick={() => setMinUsd(m.value)}
                      active={minUsd === m.value}
                    >
                      {m.label}
                    </ControlButton>
                  ))}
                </div>
              </div>

              {/* Alert type / severity / side selects */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {([
                  { label: 'Alert type', value: typeFilter,     set: setTypeFilter,     opts: types      },
                  { label: 'Severity',   value: severityFilter, set: setSeverityFilter, opts: severities },
                  { label: 'Side',       value: sideFilter,     set: setSideFilter,     opts: sides      },
                ] as const).map((f) => (
                  <div key={f.label}>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">{f.label}</div>
                    <div className="relative">
                      <select
                        value={f.value}
                        onChange={(e) => (f.set as (v: string) => void)(e.target.value)}
                        className="wa-select w-full appearance-none rounded-xl border border-white/10 bg-[#060b16] px-3 py-2 text-xs text-slate-100 outline-none transition-colors hover:border-white/20 focus:border-cyan-400/50"
                      >
                        <option value="all">All</option>
                        {f.opts.filter(Boolean).map((o) => (
                          <option key={o} value={o ?? ''}>{o}</option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-500">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: Sync status */}
            <div className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-[#07101d] p-4">
              {/* Sync status header */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Wallet sync panel</div>
                  <StatusChip tone="mint">{syncing ? 'Syncing…' : 'Sync Healthy'}</StatusChip>
                </div>

                {/* Sync stats rows */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <SyncStat label="Wallets scanned" value={syncState ? `${syncState.processed ?? 0} / ${syncState.trackedWalletsTotal ?? stats.trackedWallets}` : 'Unavailable'} />
                  <SyncStat label="Alerts inserted" value={syncState?.inserted != null ? String(syncState.inserted) : 'Unavailable'} />
                  <SyncStat label="Next offset" value={syncState ? (syncState.nextOffset != null ? String(syncState.nextOffset) : 'Complete') : '—'} />
                  <SyncStat label="Provider errors" value={syncState?.providerErrors != null ? String(syncState.providerErrors) : '—'} />
                </div>
                {(syncState?.providerErrors ?? 0) > 0 && (
                  <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Provider returned errors for some wallets. Sync is still online, but some alerts may be delayed.
                  </p>
                )}
              </div>

              {/* Buttons */}
              <div className="flex gap-2 mt-auto">
                <button
                  onClick={resetFilters}
                  disabled={syncing}
                  className="flex-1 rounded-xl border border-white/10 bg-[#060b16] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
                >
                  Reset filters
                </button>
                <button
                  onClick={() => { void runSync(syncState?.nextOffset ?? 0) }}
                  disabled={syncing}
                  className="flex-1 rounded-xl px-3 py-2 text-xs font-semibold text-[#030712] disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 60%, #ec4899 100%)' }}
                >
                  {syncing ? 'Scanning…' : syncState?.nextOffset != null ? 'Sync next batch' : 'Run sync'}
                </button>
              </div>

              {loading && (
                <p className="text-[11px] text-slate-500 text-center -mt-1">Refreshing feed…</p>
              )}
            </div>
          </div>
        </section>

        {/* ── Alert feed ─────────────────────────────────────────────────────── */}
        <section>
          {/* Feed header */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-bold text-white">Alert feed</h2>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-400/20 text-[10px] text-emerald-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                Auto-update
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(buildClarkPrompt())}&autosend=1`
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#8b5cf6]/30 bg-[#8b5cf6]/15 px-2.5 py-1 text-xs text-[#c4b5fd] hover:border-[#8b5cf6]/60"
            >
              Ask Clark
            </button>
            <button className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-slate-900/80 text-xs text-slate-400 hover:text-slate-300 hover:border-white/20 transition-colors">
              <PauseIcon />
              Pause
            </button>
            </div>
          </div>

          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="animate-pulse rounded-2xl border border-white/10 bg-[#080c14]/80 p-4">
                  <div className="mb-2 h-3 w-24 rounded bg-white/10" />
                  <div className="mb-2 h-3 w-2/3 rounded bg-white/10" />
                  <div className="h-3 w-1/3 rounded bg-white/10" />
                </div>
              ))}
            </div>
          )}

          {feedError && !loading && (
            <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 p-5 text-sm text-rose-100">
              <p className="font-semibold">Whale Alerts could not load right now.</p>
              <p className="mt-1 text-rose-200/90">The sync engine may still be online, but the feed request failed.</p>
              <button onClick={() => void loadAlerts()} className="mt-3 rounded-lg border border-rose-300/40 px-3 py-1.5 text-xs hover:bg-rose-400/10">Retry</button>
            </div>
          )}

          {!feedError && alerts.length === 0 && !loading && (
            <div className="rounded-2xl border border-white/10 bg-[#080c14]/80 p-8 text-center">
              <p className="text-lg font-semibold text-white">No whale alerts yet</p>
              <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">ChainLens is tracking selected Base wallets, but no qualifying movements have been indexed yet.</p>
              <p className="mt-1 text-xs text-slate-500">Run a sync or check back after new wallet activity is detected.</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <StatusChip>{stats.trackedWallets ? `${stats.trackedWallets} tracked wallets` : 'Tracked wallets unavailable'}</StatusChip>
                <StatusChip tone="mint">{syncState ? 'Sync active' : 'Last sync unavailable'}</StatusChip>
                <StatusChip tone="purple">{(syncState?.providerErrors ?? 0) > 0 ? 'Provider degraded' : 'Provider stable'}</StatusChip>
              </div>
            </div>
          )}

          {/* Alert rows */}
          {!feedError && alerts.length > 0 && !loading && (
            <div className="space-y-2">
              {alerts.map((alert, i) => {
                const side  = getSide(alert.side)
                const label = alert.wallet_label || short(alert.wallet_address)
                const sym   = alert.token_symbol || alert.token_name

                return (
                  <article
                    key={alert.id ?? `${alert.tx_hash ?? ''}-${i}`}
                    className="rounded-2xl border border-white/10 bg-[#080c14]/80 p-3 transition-colors hover:border-white/20"
                    style={{ borderLeftWidth: '3px', borderLeftColor: side.border }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold tracking-wide ${side.chip}`}>{side.label}</span>
                      <span className="text-xs text-slate-200">{actionSummary(alert)}</span>
                      <span className="ml-auto text-[11px] text-slate-500">{timeAgo(alert.occurred_at)}</span>
                    </div>
                    <div className="mt-2 grid gap-2 text-xs text-slate-400 md:grid-cols-2">
                      <div>Wallet: <span className={`${compactMonospace} text-slate-300`} title={alert.wallet_address ?? undefined}>{label || '—'}</span></div>
                      <div>Token: <span className="text-slate-300">{sym || '—'}</span></div>
                      <div>Value: <span className="text-slate-300">{alert.amount_usd == null ? 'Not indexed yet' : fmtUsd(alert.amount_usd)}</span></div>
                      <div>Severity: <span style={{ color: severityColor(alert.severity) }}>{alert.severity ?? '—'}</span></div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {alert.wallet_address && <a href={`https://basescan.org/address/${alert.wallet_address}`} target="_blank" rel="noreferrer" className="rounded-lg border border-white/10 px-2 py-1 text-[11px] font-mono text-slate-300 hover:border-white/20">{short(alert.wallet_address)}</a>}
                      {alert.tx_hash && <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-[#2DD4BF]/50 hover:text-[#7ef2da]"><span className={compactMonospace}>{short(alert.tx_hash)}</span> <ExternalLinkIcon /></a>}
                      <button
                        onClick={() => {
                          const prompt = buildClarkPrompt()
                          window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}&autosend=1`
                        }}
                        className="rounded-lg border border-[#8b5cf6]/30 bg-[#8b5cf6]/15 px-2 py-1 text-[11px] text-[#c4b5fd] hover:border-[#8b5cf6]/60"
                      >
                        Ask Clark
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

      </div>
    </div>
  )
}
