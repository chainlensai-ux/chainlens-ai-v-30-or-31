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

type SyncResult = {
  processed?: number
  inserted?: number
  nextOffset?: number | null
  providerErrors?: number
}

const minOptions = [
  { label: '$100+', value: 100 },
  { label: '$500+', value: 500 },
  { label: '$1k+', value: 1000 },
  { label: '$5k+', value: 5000 },
  { label: '$10k+', value: 10000 },
]

function short(value?: string | null) {
  if (!value) return 'Unknown'
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function timeAgo(iso?: string | null) {
  if (!iso) return 'Unknown time'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function WhaleAlertsPage() {
  const [windowValue, setWindowValue] = useState<'15m' | '1h' | '6h' | '24h'>('24h')
  const [minUsd, setMinUsd] = useState(100)
  const [typeFilter, setTypeFilter] = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [sideFilter, setSideFilter] = useState('all')
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [stats, setStats] = useState<AlertStats>({ alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)

  const loadAlerts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        window: windowValue,
        minUsd: String(minUsd),
        limit: '100',
      })
      if (typeFilter !== 'all') params.set('type', typeFilter)
      if (severityFilter !== 'all') params.set('severity', severityFilter)
      if (sideFilter !== 'all') params.set('side', sideFilter)

      const res = await fetch(`/api/whale-alerts?${params.toString()}`, { cache: 'no-store' })
      const json = await res.json()
      setAlerts(Array.isArray(json?.alerts) ? json.alerts : [])
      setStats(json?.stats ?? { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 })
    } finally {
      setLoading(false)
    }
  }, [minUsd, severityFilter, sideFilter, typeFilter, windowValue])

  useEffect(() => {
    void loadAlerts()
  }, [loadAlerts])

  const types = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.alert_type).filter(Boolean)))], [alerts])
  const severities = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.severity).filter(Boolean)))], [alerts])
  const sides = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.side).filter(Boolean)))], [alerts])

  const runSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/whale-alerts/sync?window=7d&limit=5&offset=0&minUsd=100', { method: 'POST' })
      const json = await res.json()
      setSyncResult({
        processed: json?.processed ?? 0,
        inserted: json?.inserted ?? 0,
        nextOffset: json?.nextOffset ?? null,
        providerErrors: json?.providerErrors ?? 0,
      })
      await loadAlerts()
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="min-h-screen p-6 md:p-10 text-slate-100" style={{ background: 'radial-gradient(circle at 20% 20%, #172554 0%, #020617 45%, #020617 100%)' }}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="rounded-2xl border border-fuchsia-400/20 bg-slate-900/50 backdrop-blur-xl p-6">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-300 via-fuchsia-300 to-emerald-300 bg-clip-text text-transparent">Whale Alerts</h1>
          <p className="text-slate-300 mt-2">Track selected Base wallets for meaningful token movement.</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            ['Alerts last 15m', stats.alerts15m],
            ['Alerts last 1h', stats.alerts1h],
            ['Alerts last 24h', stats.alerts24h],
            ['Tracked wallets', stats.trackedWallets],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-cyan-400/20 bg-slate-900/50 backdrop-blur p-4">
              <div className="text-xs text-slate-400">{label}</div>
              <div className="text-2xl font-semibold mt-1">{value}</div>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-purple-400/20 bg-slate-900/50 backdrop-blur p-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['15m', '1h', '6h', '24h'] as const).map((w) => (
              <button key={w} onClick={() => setWindowValue(w)} className={`px-3 py-2 rounded-lg text-sm ${windowValue === w ? 'bg-fuchsia-500/30 border border-fuchsia-300/40' : 'bg-slate-800/60 border border-slate-700'}`}>{w}</button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {minOptions.map((opt) => (
              <button key={opt.value} onClick={() => setMinUsd(opt.value)} className={`px-3 py-2 rounded-lg text-sm ${minUsd === opt.value ? 'bg-emerald-500/20 border border-emerald-300/40' : 'bg-slate-800/60 border border-slate-700'}`}>{opt.label}</button>
            ))}
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2"><option value="all">All alert types</option>{types.filter(Boolean).map((v) => <option key={v}>{v}</option>)}</select>
            <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2"><option value="all">All severities</option>{severities.filter(Boolean).map((v) => <option key={v}>{v}</option>)}</select>
            <select value={sideFilter} onChange={(e) => setSideFilter(e.target.value)} className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2"><option value="all">All sides</option>{sides.filter(Boolean).map((v) => <option key={v}>{v}</option>)}</select>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button onClick={runSync} disabled={syncing} className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-fuchsia-500 disabled:opacity-60">
              {syncing ? 'Syncing...' : 'Run Sync'}
            </button>
            {syncResult && <div className="text-sm text-slate-300">Processed {syncResult.processed} / Inserted {syncResult.inserted} / Next {String(syncResult.nextOffset)} / Provider errors {syncResult.providerErrors}</div>}
            {loading && <div className="text-sm text-slate-400">Refreshing alerts…</div>}
          </div>
        </div>

        <div className="space-y-3">
          {alerts.length === 0 && !loading ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-8 text-slate-300">No whale alerts in this window yet. Run sync or widen the time window.</div>
          ) : (
            alerts.map((alert, idx) => (
              <div key={alert.id ?? `${alert.tx_hash}-${idx}`} className="rounded-xl border border-slate-700/80 bg-slate-900/50 p-4 backdrop-blur">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{alert.wallet_label || short(alert.wallet_address)}</div>
                  <div className="text-xs text-slate-400">{timeAgo(alert.occurred_at)}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="px-2 py-1 rounded bg-purple-500/20">{alert.alert_type || 'token_transfer'}</span>
                  <span className="px-2 py-1 rounded bg-cyan-500/20">{alert.side || 'transfer'}</span>
                  {alert.severity && <span className="px-2 py-1 rounded bg-pink-500/20">{alert.severity}</span>}
                </div>
                <div className="mt-3 text-sm text-slate-300">
                  {(alert.token_symbol || alert.token_name) ? `${alert.token_symbol || ''} ${alert.token_name || ''}` : 'Token unknown'}
                  {' · '}
                  {alert.amount_usd != null ? `$${Number(alert.amount_usd).toLocaleString()}` : 'USD n/a'}
                  {' · '}
                  {alert.amount_token != null ? Number(alert.amount_token).toLocaleString() : 'Amount n/a'}
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs">
                  {alert.tx_hash ? (
                    <a className="text-cyan-300 hover:underline" href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer">View on Basescan</a>
                  ) : <span className="text-slate-500">No transaction hash</span>}
                  <button className="px-2 py-1 rounded bg-slate-800 border border-slate-600">Ask Clark</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
