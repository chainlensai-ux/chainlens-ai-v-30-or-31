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

const minOptions = [
  { label: 'All movements / testing', value: 0 },
  { label: '$100+', value: 100 },
  { label: '$500+', value: 500 },
  { label: '$1k+', value: 1000 },
  { label: '$5k+', value: 5000 },
  { label: '$10k+', value: 10000 },
]

const windows = ['15m', '1h', '6h', '24h'] as const

const shell = 'rounded-2xl border border-white/10 bg-slate-900/55 backdrop-blur-xl shadow-[0_0_40px_rgba(56,189,248,0.06)]'

const short = (value?: string | null) => (!value ? 'Unknown' : `${value.slice(0, 6)}...${value.slice(-4)}`)
const timeAgo = (iso?: string | null) => {
  if (!iso) return 'Unknown'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function WhaleAlertsPage() {
  const [windowValue, setWindowValue] = useState<(typeof windows)[number]>('24h')
  const [minUsd, setMinUsd] = useState(100)
  const [typeFilter, setTypeFilter] = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState('all')
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [stats, setStats] = useState<AlertStats>({ alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncState, setSyncState] = useState<SyncResponse | null>(null)

  const loadAlerts = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ window: windowValue, minUsd: String(minUsd), limit: '100' })
      if (typeFilter !== 'all') p.set('type', typeFilter)
      if (severityFilter !== 'all') p.set('severity', severityFilter)
      if (sideFilter !== 'all') p.set('side', sideFilter)
      const res = await fetch(`/api/whale-alerts?${p.toString()}`, { cache: 'no-store' })
      const json = await res.json()
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
    } finally {
      setLoading(false)
    }
  }, [windowValue, minUsd, typeFilter, severityFilter, sideFilter])

  useEffect(() => { void loadAlerts() }, [loadAlerts])

  const runSync = async (offset: number) => {
    setSyncing(true)
    try {
      const res = await fetch(`/api/whale-alerts/sync?window=7d&limit=5&offset=${offset}&minUsd=${minUsd}`, { method: 'POST' })
      const json = (await res.json()) as SyncResponse
      setSyncState(json)
      await loadAlerts()
    } finally { setSyncing(false) }
  }

  const types = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.alert_type).filter(Boolean)))], [alerts])
  const severities = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.severity).filter(Boolean)))], [alerts])
  const sides = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.side).filter(Boolean)))], [alerts])

  return (
    <div className="min-h-screen p-6 md:p-10 text-slate-100" style={{ background: 'radial-gradient(1200px 500px at 10% -10%, rgba(59,130,246,0.2), transparent), radial-gradient(900px 400px at 90% 0%, rgba(217,70,239,0.12), transparent), #020617' }}>
      <div className="mx-auto max-w-7xl space-y-6">
        <section className={`${shell} p-6`}>
          <h1 className="text-3xl font-semibold bg-gradient-to-r from-cyan-300 via-fuchsia-300 to-emerald-300 bg-clip-text text-transparent">Whale Alerts</h1>
          <p className="mt-2 text-slate-300">Track selected Base wallets for meaningful token movement.</p>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            ['Alerts last 15m', stats.alerts15m], ['Alerts last 1h', stats.alerts1h], ['Alerts last 24h', stats.alerts24h], ['Tracked wallets', stats.trackedWallets],
          ].map(([label, val]) => <div key={String(label)} className={`${shell} p-4`}><div className="text-xs text-slate-400">{label}</div><div className="mt-2 text-2xl font-semibold">{val}</div></div>)}
        </section>

        <section className={`${shell} p-4 md:p-5 space-y-4`}>
          <div className="flex flex-wrap gap-2">
            {windows.map((w) => <button key={w} onClick={() => setWindowValue(w)} className={`px-3 py-2 rounded-full border text-sm ${windowValue === w ? 'border-fuchsia-300/60 bg-fuchsia-500/25' : 'border-white/15 bg-slate-800/80 hover:bg-slate-700/70'}`}>{w}</button>)}
          </div>
          <div className="flex flex-wrap gap-2">
            {minOptions.map((m) => <button key={m.value} onClick={() => setMinUsd(m.value)} className={`px-3 py-2 rounded-full border text-sm ${minUsd === m.value ? 'border-emerald-300/60 bg-emerald-500/20' : 'border-white/15 bg-slate-800/80 hover:bg-slate-700/70'}`}>{m.label}</button>)}
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            {[
              { value: typeFilter, set: setTypeFilter, opts: types, title: 'Alert type' },
              { value: severityFilter, set: setSeverityFilter, opts: severities, title: 'Severity' },
              { value: sideFilter, set: setSideFilter, opts: sides, title: 'Side' },
            ].map((f) => (
              <label key={f.title} className="rounded-xl border border-white/10 bg-slate-800/70 px-3 py-2 text-sm">
                <div className="text-xs text-slate-400 mb-1">{f.title}</div>
                <select value={f.value} onChange={(e) => f.set(e.target.value)} className="w-full bg-transparent outline-none appearance-none">
                  <option value="all">All</option>
                  {f.opts.filter(Boolean).map((o) => <option key={o} value={o ?? ''} className="text-black">{o}</option>)}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section className={`${shell} p-4 md:p-5`}>
          <div className="flex flex-wrap items-center gap-3">
            <button disabled={syncing} onClick={() => runSync(syncState?.nextOffset ?? 0)} className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-fuchsia-500 font-medium disabled:opacity-50">
              {syncing ? 'Syncing...' : syncState?.nextOffset != null ? 'Sync Next Batch' : 'Run Sync'}
            </button>
            <button disabled={syncing} onClick={() => setSyncState(null)} className="px-4 py-2 rounded-xl border border-white/15 bg-slate-800/70 disabled:opacity-50">Reset Sync</button>
            {loading && <span className="text-sm text-slate-400">Refreshing feed…</span>}
          </div>
          {syncState && (
            <div className="mt-3 text-sm text-slate-300 grid md:grid-cols-3 gap-2">
              <div>Processed: <span className="text-cyan-300">{syncState.processed ?? 0}</span> / {syncState.trackedWalletsTotal ?? '?'}</div>
              <div>Offset: <span className="text-fuchsia-300">{syncState.offset ?? 0}</span> → Next: <span className="text-emerald-300">{String(syncState.nextOffset)}</span></div>
              <div>Inserted: <span className="text-emerald-300">{syncState.inserted ?? 0}</span> · Provider errors: <span className="text-rose-300">{syncState.providerErrors ?? 0}</span></div>
            </div>
          )}
        </section>

        <section className="space-y-3">
          {alerts.length === 0 && !loading ? (
            <div className={`${shell} p-8 text-center`}>
              <p className="text-slate-200">No whale alerts in this window yet. Run sync, lower the minimum USD filter, or sync the next wallet batch.</p>
            </div>
          ) : alerts.map((alert, i) => (
            <article key={alert.id ?? `${alert.tx_hash}-${i}`} className={`${shell} p-4`}>
              <div className="flex flex-wrap justify-between items-center gap-2">
                <h3 className="font-medium">{alert.wallet_label || short(alert.wallet_address)}</h3>
                <span className="text-xs text-slate-400">{timeAgo(alert.occurred_at)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded-full bg-purple-500/20 border border-purple-300/20">{alert.alert_type || 'token_transfer'}</span>
                <span className="px-2 py-1 rounded-full bg-cyan-500/20 border border-cyan-300/20">{alert.side || 'transfer'}</span>
                {alert.severity && <span className="px-2 py-1 rounded-full bg-pink-500/20 border border-pink-300/20">{alert.severity}</span>}
              </div>
              <div className="mt-3 text-sm text-slate-300">
                {(alert.token_symbol || alert.token_name) ? `${alert.token_symbol || ''} ${alert.token_name || ''}` : 'Token unknown'} · {alert.amount_usd != null ? `$${Number(alert.amount_usd).toLocaleString()}` : 'USD n/a'} · {alert.amount_token != null ? Number(alert.amount_token).toLocaleString() : 'Amount n/a'}
              </div>
              <div className="mt-3 flex items-center gap-3 text-xs">
                {alert.tx_hash ? <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">View on Basescan</a> : <span className="text-slate-500">No transaction hash</span>}
                <button className="px-2 py-1 rounded-lg border border-white/15 bg-slate-800/70">Ask Clark</button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}
