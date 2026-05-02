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

const minOptions = [0, 100, 500, 1000, 5000, 10000] as const
const windows = ['15m', '1h', '6h', '24h'] as const

const short = (value?: string | null) => (!value ? 'Unknown' : `${value.slice(0, 6)}...${value.slice(-4)}`)
const timeAgo = (iso?: string | null) => {
  if (!iso) return 'No sync yet'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.max(1, Math.floor(diff / 60000))
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const money = (n?: number | null) => (typeof n === 'number' ? `$${Math.round(n).toLocaleString()}` : 'Unavailable')

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

  useEffect(() => {
    void loadAlerts()
  }, [loadAlerts])

  const runSync = async (offset: number) => {
    setSyncing(true)
    try {
      const res = await fetch(`/api/whale-alerts/sync?window=7d&limit=5&offset=${offset}&minUsd=${minUsd}`, { method: 'POST' })
      const json = (await res.json()) as SyncResponse
      setSyncState(json)
      await loadAlerts()
    } finally {
      setSyncing(false)
    }
  }

  const types = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.alert_type).filter(Boolean)))], [alerts])
  const severities = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.severity).filter(Boolean)))], [alerts])
  const sides = useMemo(() => ['all', ...Array.from(new Set(alerts.map((a) => a.side).filter(Boolean)))], [alerts])

  const scanCoverage = syncState?.trackedWalletsTotal ? Math.min(100, Math.round(((syncState.processed ?? 0) / syncState.trackedWalletsTotal) * 100)) : 0

  return (
    <main className="min-h-screen bg-[#06060a] px-4 py-6 text-white sm:px-6 lg:px-10" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="mx-auto w-full max-w-[1280px] space-y-4">
        <section className="space-y-4">
          <header className="rounded-2xl border border-white/10 bg-[#080c14] p-5" style={{ background: 'linear-gradient(120deg, rgba(8,12,20,0.95) 5%, rgba(9,16,30,0.95) 60%, rgba(35,16,58,0.7) 100%)' }}>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <div>
                <p className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                  <span>🔔 WHALE ALERTS</span><span className="text-slate-500">· · base mainnet</span>
                </p>
                <h1 className="mt-3 text-5xl font-bold tracking-tight text-white">Whale Alerts</h1>
                <p className="mt-3 text-lg text-slate-300">Track selected Base wallets for meaningful token movement.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="inline-flex rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm font-semibold text-slate-200">· Base Mainnet</span>
                  <span className="inline-flex rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm font-semibold text-slate-200">⧉ {stats.trackedWallets || 0} tracked wallets</span>
                  <span className="inline-flex rounded-full border border-[#2DD4BF]/40 bg-[#2DD4BF]/15 px-3 py-1 text-sm font-semibold text-[#2DD4BF]">● Batch Sync Online</span>
                  <span className="inline-flex rounded-full border border-[#8b5cf6]/50 bg-[#8b5cf6]/20 px-3 py-1 text-sm font-semibold text-[#c4b5fd]">⬡ CORTEX Watching</span>
                </div>
              </div>
              <div className="rounded-2xl border p-4" style={{ borderColor: 'rgba(45,212,191,0.3)', background: 'linear-gradient(145deg, rgba(16,32,44,0.9), rgba(11,20,35,0.8))' }}>
                <p className="text-xs uppercase tracking-[0.14em] text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>● LIVE WALLET MOVEMENT</p>
                <p className="mt-2 text-xl text-slate-200">Listening for high-signal wallet moves on Base.</p>
                <div className="mt-4 h-16 rounded-xl border border-white/10 bg-[#081325] p-3"><svg viewBox="0 0 260 40" className="h-full w-full"><polyline fill="none" stroke="#2DD4BF" strokeWidth="2" points="0,32 18,31 30,28 44,29 56,26 70,27 82,24 94,25 108,22 120,23 134,20 146,21 160,18 172,19 186,16 198,17 212,14 226,15 240,12 260,10" /></svg></div>
              </div>
            </div>
          </header>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: 'ALERTS · 15M', value: stats.alerts15m },
              { label: 'ALERTS · 1H', value: stats.alerts1h },
              { label: 'ALERTS · 24H', value: stats.alerts24h },
              { label: 'TRACKED WALLETS', value: stats.trackedWallets },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border p-4" style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}>
                <p className="text-xs uppercase tracking-[0.18em] text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{stat.label}</p>
                <p className="mt-3 text-5xl font-bold text-white">{stat.value ?? 0}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 rounded-2xl border p-4 lg:grid-cols-[1fr_460px]" style={{ background: 'rgba(8,12,20,0.92)', borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="space-y-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>TIME WINDOW</p>
              <div className="flex flex-wrap gap-2">{windows.map((w) => <button key={w} onClick={() => setWindowValue(w)} className="rounded-xl border px-4 py-2 text-sm font-semibold" style={{ background: windowValue === w ? 'rgba(45,212,191,0.15)' : 'rgba(255,255,255,0.02)', color: windowValue === w ? '#2DD4BF' : '#cbd5e1', borderColor: windowValue === w ? 'rgba(45,212,191,0.4)' : 'rgba(255,255,255,0.12)' }}>{w}</button>)}</div>
              <p className="text-xs uppercase tracking-[0.18em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>MINIMUM VALUE</p>
              <div className="flex flex-wrap gap-2">{minOptions.map((v) => <button key={v} onClick={() => setMinUsd(v)} className="rounded-xl border px-4 py-2 text-sm font-semibold" style={{ background: minUsd === v ? 'rgba(45,212,191,0.15)' : 'rgba(255,255,255,0.02)', color: minUsd === v ? '#2DD4BF' : '#cbd5e1', borderColor: minUsd === v ? 'rgba(45,212,191,0.4)' : 'rgba(255,255,255,0.12)' }}>{v === 0 ? 'All' : `$${v >= 1000 ? `${v / 1000}k` : v}+`}</button>)}</div>
              <div className="grid gap-3 md:grid-cols-3">{[
                { label: 'Alert type', value: typeFilter, set: setTypeFilter, opts: types },
                { label: 'Severity', value: severityFilter, set: setSeverityFilter, opts: severities },
                { label: 'Side', value: sideFilter, set: setSideFilter, opts: sides },
              ].map((f) => <label key={f.label} className="space-y-1 text-sm text-[#94a3b8]"><span className="text-xs uppercase tracking-[0.16em]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{f.label}</span><select value={f.value} onChange={(e) => f.set(e.target.value)} className="w-full rounded-xl border border-white/10 bg-[#070d19] px-3 py-2 text-sm font-semibold text-white"><option value="all">All</option>{f.opts.filter(Boolean).map((o) => <option key={o} value={o ?? ''}>{o}</option>)}</select></label>)}</div>
            </div>
            <div className="rounded-2xl border p-4" style={{ background: 'linear-gradient(160deg, rgba(23,26,56,0.55), rgba(7,17,31,0.6))', borderColor: 'rgba(139,92,246,0.35)' }}>
              <div className="flex items-start justify-between"><div><p className="text-2xl font-semibold text-white">Wallet scan</p><p className="text-sm text-[#94a3b8]">Last scan {syncState ? `${Math.max(0, syncState.offset ?? 0)} offset` : 'No sync yet'}</p></div><span className="rounded-full border border-[#2DD4BF]/40 bg-[#2DD4BF]/15 px-3 py-1 text-sm font-semibold text-[#2DD4BF]">● Sync Healthy</span></div>
              <div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-xs uppercase tracking-[0.14em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>WALLETS SCANNED</p><p className="text-3xl font-bold text-[#2DD4BF]">{syncState?.processed ?? 0} / {syncState?.trackedWalletsTotal ?? stats.trackedWallets ?? 0}</p></div><div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-xs uppercase tracking-[0.14em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>ALERTS FOUND</p><p className="text-3xl font-bold text-white">{stats.alerts24h ?? 0}</p></div></div>
              <p className="mt-4 text-xs uppercase tracking-[0.16em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>SCAN COVERAGE</p>
              <div className="mt-2 h-2 w-full rounded-full bg-white/10"><div className="h-2 rounded-full bg-gradient-to-r from-[#2DD4BF] to-[#8b5cf6]" style={{ width: `${scanCoverage}%` }} /></div>
              <div className="mt-4 flex gap-2"><button disabled={syncing} onClick={() => runSync(syncState?.nextOffset ?? 0)} className="flex-1 rounded-xl border border-[#2DD4BF]/50 bg-gradient-to-r from-[#154b46] to-[#216463] px-4 py-2 text-base font-semibold text-[#d9fffa] disabled:opacity-50">{syncing ? 'Syncing...' : '→ Sync next batch'}</button><button type="button" disabled={syncing} onClick={() => setSyncState(null)} className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-base font-semibold text-slate-200 disabled:opacity-50">Reset</button></div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {alerts.length === 0 && !loading ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border text-center" style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="mb-4 text-6xl text-[#2DD4BF]">🔔</div><h2 className="text-2xl font-semibold text-white">No whale alerts yet</h2><p className="mt-2 text-sm text-[#94a3b8]">ChainLens is watching Base wallets for significant moves</p>
            </div>
          ) : alerts.map((alert, i) => {
            const isBuy = (alert.side || '').toLowerCase().includes('buy')
            const isExit = (alert.alert_type || '').toLowerCase().includes('exit')
            const accent = isExit ? '#ec4899' : isBuy ? '#2DD4BF' : '#ef4444'
            const clarkPrompt = encodeURIComponent(`Analyze this whale alert on Base: wallet ${alert.wallet_address || 'Unknown'}, token ${alert.token_symbol || alert.token_name || 'Unknown'}, amount ${money(alert.amount_usd)}, side ${alert.side || 'unknown'}, type ${alert.alert_type || 'unknown'}.`)
            return <article key={alert.id ?? `${alert.tx_hash}-${i}`} className="block min-h-[100px] rounded-2xl border p-4 transition hover:border-white/20" style={{ borderLeft: `3px solid ${accent}`, background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}><div className="flex flex-wrap items-center justify-between gap-3"><div className="space-y-2"><div className="flex items-center gap-2" style={{ fontFamily: 'IBM Plex Mono, monospace' }}><span className="text-[14px] text-[#2DD4BF]">{alert.wallet_label || short(alert.wallet_address)}</span><span className="text-xs text-[#94a3b8]">{timeAgo(alert.occurred_at)}</span></div><div className="flex items-center gap-2 text-sm font-bold text-white"><span>{alert.side || 'Transfer'} {alert.token_symbol || alert.token_name || 'Unknown'}</span></div></div><div className="text-right"><p className="text-[18px] font-bold" style={{ color: isBuy ? '#2DD4BF' : '#ef4444' }}>{money(alert.amount_usd)}</p></div></div><div className="mt-3 flex flex-wrap items-center gap-3 text-xs"><span className="rounded-full px-2 py-0.5 font-semibold text-white" style={{ background: accent }}>{alert.alert_type || 'Unknown'}</span>{alert.tx_hash ? <a href={`https://basescan.org/tx/${alert.tx_hash}`} target="_blank" rel="noreferrer" className="text-[#2DD4BF] hover:underline">View tx</a> : <span className="text-slate-500">No transaction hash</span>}<a href={`/terminal/clark-ai?prompt=${clarkPrompt}&autosend=1`} className="rounded-lg border border-white/15 bg-slate-800/70 px-2 py-1 text-slate-200">Ask Clark</a></div></article>
          })}
        </section>
      </div>
    </main>
  )
}
