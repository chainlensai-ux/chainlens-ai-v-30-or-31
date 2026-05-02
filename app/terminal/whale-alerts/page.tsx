'use client'

import { useMemo, useState } from 'react'

type AlertSide = 'buy' | 'sell'
type AlertKind = 'ACCUMULATION' | 'DISTRIBUTION' | 'EXIT'

type WhaleAlert = {
  id: string
  wallet: string
  side: AlertSide
  token: string
  amountUsd: number
  kind: AlertKind
  createdAt: string
  clarkNote: string
}

const ALERTS: WhaleAlert[] = [
  {
    id: '1',
    wallet: '0x8f42e7b31f2301ca177d76b2a4ff0da9c6f30e71',
    side: 'buy',
    token: 'AERO',
    amountUsd: 184200,
    kind: 'ACCUMULATION',
    createdAt: '2026-05-02T16:19:00.000Z',
    clarkNote: 'Clark: Quiet wallet, loud conviction. Size suggests a longer setup leg.',
  },
  {
    id: '2',
    wallet: '0x1256a82ca46798fb19f5374a58c62810b0caf101',
    side: 'sell',
    token: 'DEGEN',
    amountUsd: 92300,
    kind: 'DISTRIBUTION',
    createdAt: '2026-05-02T16:02:00.000Z',
    clarkNote: 'Clark: This looks like strength into liquidity, not panic.',
  },
  {
    id: '3',
    wallet: '0x4dc9f1f29a7adf4f62903f98ef4bcf35867bf054',
    side: 'sell',
    token: 'BRETT',
    amountUsd: 310500,
    kind: 'EXIT',
    createdAt: '2026-05-02T15:48:00.000Z',
    clarkNote: 'Clark: Full unwind behavior. Watch follow-up flows for confirmation.',
  },
]

const TIME_FILTERS = ['15M', '1H', '6H', '24H'] as const
const MIN_FILTERS = [100, 500, 1000, 5000, 10000] as const

const shortWallet = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

const formatMoney = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)

const timeAgo = (iso: string) => {
  const diffMinutes = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const hours = Math.floor(diffMinutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function WhaleAlertsPage() {
  const [timeFilter, setTimeFilter] = useState<(typeof TIME_FILTERS)[number]>('1H')
  const [minValue, setMinValue] = useState<number>(100)

  const filteredAlerts = useMemo(() => {
    return ALERTS.filter((alert) => {
      if (alert.amountUsd < minValue) return false
      return true
    })
  }, [minValue])

  const totalAlerts = filteredAlerts.length

  return (
    <main className="min-h-screen bg-[#06060a] px-4 py-8 text-white sm:px-6 lg:px-10" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="mx-auto w-full max-w-[1280px] space-y-5">
        <section className="space-y-4">
          <header className="rounded-2xl border border-white/10 bg-[#080c14] p-5" style={{ background: 'linear-gradient(120deg, rgba(8,12,20,0.95) 5%, rgba(9,16,30,0.95) 60%, rgba(35,16,58,0.7) 100%)' }}>
            <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
              <div>
                <p className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                  <span>🔔 Whale Alerts</span>
                  <span className="text-slate-500">· · base mainnet</span>
                </p>
                <h1 className="mt-3 text-5xl font-bold tracking-tight text-white">Whale Alerts</h1>
                <p className="mt-3 text-lg text-slate-300">Track selected Base wallets for meaningful token movement.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {['· Base Mainnet', '⧉ 72 tracked wallets', '● Batch Sync Online', '⬡ CORTEX Watching'].map((pill, index) => (
                    <span
                      key={pill}
                      className="inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold"
                      style={{
                        color: index === 2 ? '#2DD4BF' : index === 3 ? '#c4b5fd' : '#d1d5db',
                        borderColor: index === 2 ? 'rgba(45,212,191,0.4)' : index === 3 ? 'rgba(139,92,246,0.5)' : 'rgba(255,255,255,0.14)',
                        background: index === 2 ? 'rgba(45,212,191,0.15)' : index === 3 ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.03)',
                      }}
                    >
                      {pill}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border p-4" style={{ borderColor: 'rgba(45,212,191,0.3)', background: 'linear-gradient(145deg, rgba(16,32,44,0.9), rgba(11,20,35,0.8))' }}>
                <p className="text-xs uppercase tracking-[0.14em] text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                  ● LIVE WALLET MOVEMENT
                </p>
                <p className="mt-2 text-xl text-slate-200">Listening for high-signal wallet moves on Base.</p>
                <div className="mt-4 h-16 rounded-xl border border-white/10 bg-[#081325] p-3">
                  <svg viewBox="0 0 260 40" className="h-full w-full">
                    <polyline fill="url(#sparkFill)" stroke="#2DD4BF" strokeWidth="2" points="0,32 18,31 30,28 44,29 56,26 70,27 82,24 94,25 108,22 120,23 134,20 146,21 160,18 172,19 186,16 198,17 212,14 226,15 240,12 260,10" />
                    <defs>
                      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="rgba(45,212,191,0.35)" />
                        <stop offset="100%" stopColor="rgba(45,212,191,0)" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            </div>
          </header>
          <div className="grid gap-3 lg:grid-cols-4">
            {[
              { label: 'ALERTS · 15M', value: '3', sub: 'Last quarter hour', delta: '+12%', positive: true },
              { label: 'ALERTS · 1H', value: '6', sub: 'Past 60 minutes', delta: '+28%', positive: true },
              { label: 'ALERTS · 24H', value: '10', sub: 'Rolling day window', delta: '-4%', positive: false },
              { label: 'TRACKED WALLETS', value: '72', sub: 'Smart money + manual', delta: '+3%', positive: true },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border p-4" style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}>
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-[0.18em] text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{stat.label}</p>
                  <span className="text-sm font-semibold" style={{ color: stat.positive ? '#2DD4BF' : '#f43f5e' }}>{stat.delta}</span>
                </div>
                <p className="mt-3 text-5xl font-bold text-white">{stat.value}</p>
                <p className="text-sm text-[#94a3b8]">{stat.sub}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 rounded-2xl border p-4 lg:grid-cols-[1fr_480px]" style={{ background: 'rgba(8,12,20,0.92)', borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="space-y-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>TIME WINDOW</p>
              <div className="flex flex-wrap gap-2">
                {TIME_FILTERS.map((filter) => (
                  <button key={filter} type="button" onClick={() => setTimeFilter(filter)} className="rounded-xl border px-4 py-2 text-sm font-semibold" style={{ background: timeFilter === filter ? 'rgba(45,212,191,0.15)' : 'rgba(255,255,255,0.02)', color: timeFilter === filter ? '#2DD4BF' : '#cbd5e1', borderColor: timeFilter === filter ? 'rgba(45,212,191,0.4)' : 'rgba(255,255,255,0.12)' }}>{filter.toLowerCase()}</button>
                ))}
              </div>
              <p className="text-xs uppercase tracking-[0.18em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>MINIMUM VALUE</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="rounded-xl border border-[#2DD4BF]/60 bg-[#2DD4BF]/15 px-4 py-2 text-sm font-semibold text-[#2DD4BF]">All</button>
                {MIN_FILTERS.map((value) => (
                  <button key={value} type="button" onClick={() => setMinValue(value)} className="rounded-xl border px-4 py-2 text-sm font-semibold" style={{ background: minValue === value ? 'rgba(45,212,191,0.15)' : 'rgba(255,255,255,0.02)', color: minValue === value ? '#2DD4BF' : '#cbd5e1', borderColor: minValue === value ? 'rgba(45,212,191,0.4)' : 'rgba(255,255,255,0.12)' }}>${value >= 1000 ? `${value / 1000}k` : value}+</button>
                ))}
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                {['Alert Type', 'Severity', 'Side'].map((label) => (
                  <label key={label} className="space-y-1 text-sm text-[#94a3b8]">
                    <span className="text-xs uppercase tracking-[0.16em]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{label}</span>
                    <select className="w-full rounded-xl border border-white/10 bg-[#070d19] px-3 py-2 text-sm font-semibold text-white">
                      <option>{label === 'Alert Type' ? 'All types' : label === 'Severity' ? 'All severity' : 'Buy + sell + xfer'}</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border p-4" style={{ background: 'linear-gradient(160deg, rgba(23,26,56,0.55), rgba(7,17,31,0.6))', borderColor: 'rgba(139,92,246,0.35)' }}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-2xl font-semibold text-white">Wallet scan</p>
                  <p className="text-sm text-[#94a3b8]">Last scan 8m ago</p>
                </div>
                <span className="rounded-full border border-[#2DD4BF]/40 bg-[#2DD4BF]/15 px-3 py-1 text-sm font-semibold text-[#2DD4BF]">● Sync Healthy</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-xs uppercase tracking-[0.14em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>WALLETS SCANNED</p><p className="text-3xl font-bold text-[#2DD4BF]">48 / 72</p></div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3"><p className="text-xs uppercase tracking-[0.14em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>ALERTS FOUND</p><p className="text-3xl font-bold text-white">{totalAlerts}</p></div>
              </div>
              <p className="mt-4 text-xs uppercase tracking-[0.16em] text-[#94a3b8]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>SCAN COVERAGE</p>
              <div className="mt-2 h-2 w-full rounded-full bg-white/10"><div className="h-2 rounded-full bg-gradient-to-r from-[#2DD4BF] to-[#8b5cf6]" style={{ width: '67%' }} /></div>
              <div className="mt-4 flex gap-2">
                <button type="button" className="flex-1 rounded-xl border border-[#2DD4BF]/50 bg-gradient-to-r from-[#154b46] to-[#216463] px-4 py-2 text-base font-semibold text-[#d9fffa]">→ Sync next batch</button>
                <button type="button" className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-base font-semibold text-slate-200">Reset</button>
              </div>
            </div>
          </div>

          {filteredAlerts.length === 0 ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border text-center" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="mb-4 text-6xl text-[#2DD4BF]">🔔</div>
              <h2 className="text-2xl font-semibold text-white">No whale alerts yet</h2>
              <p className="mt-2 text-sm text-[#94a3b8]">ChainLens is watching Base wallets for significant moves</p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredAlerts.map((alert) => {
                const accent = alert.kind === 'EXIT' ? '#ec4899' : alert.side === 'buy' ? '#2DD4BF' : '#ef4444'
                const amountColor = alert.side === 'buy' ? '#2DD4BF' : '#ef4444'
                const typeColor = alert.kind === 'ACCUMULATION' ? '#2DD4BF' : alert.kind === 'DISTRIBUTION' ? '#ef4444' : '#ec4899'
                return (
                  <a
                    key={alert.id}
                    href={`https://basescan.org/address/${alert.wallet}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block min-h-[100px] rounded-2xl border p-4 transition hover:border-white/20"
                    style={{ borderLeft: `3px solid ${accent}`, background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                          <span className="text-[14px] text-[#2DD4BF]">{shortWallet(alert.wallet)}</span>
                          <span className="text-xs text-[#94a3b8]">📋</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm font-bold text-white">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-[10px] font-bold">{alert.token[0]}</span>
                          <span>{alert.side === 'buy' ? 'Bought' : 'Sold'} {alert.token}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[18px] font-bold" style={{ color: amountColor }}>{formatMoney(alert.amountUsd)}</p>
                        <div className="mt-1 flex items-center justify-end gap-2">
                          <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: typeColor }}>{alert.kind}</span>
                          <span className="text-xs text-slate-500">{timeAgo(alert.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                    <p className="mt-3 text-[13px] italic text-[#94a3b8]">{alert.clarkNote}</p>
                  </a>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
