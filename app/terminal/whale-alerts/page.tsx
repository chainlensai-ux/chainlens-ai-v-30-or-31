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

const FILTERS = ['ALL', 'BUYS', 'SELLS', 'EXITS'] as const
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
  const [flowFilter, setFlowFilter] = useState<(typeof FILTERS)[number]>('ALL')
  const [timeFilter, setTimeFilter] = useState<(typeof TIME_FILTERS)[number]>('1H')
  const [minValue, setMinValue] = useState<number>(100)

  const filteredAlerts = useMemo(() => {
    return ALERTS.filter((alert) => {
      if (alert.amountUsd < minValue) return false
      if (flowFilter === 'BUYS') return alert.side === 'buy'
      if (flowFilter === 'SELLS') return alert.side === 'sell'
      if (flowFilter === 'EXITS') return alert.kind === 'EXIT'
      return true
    })
  }, [flowFilter, minValue])

  const walletActivity = useMemo(() => {
    const counts = new Map<string, number>()
    ALERTS.forEach((alert) => counts.set(alert.wallet, (counts.get(alert.wallet) ?? 0) + 1))
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [])

  const totalAlerts = filteredAlerts.length
  const largestMove = filteredAlerts.length ? Math.max(...filteredAlerts.map((alert) => alert.amountUsd)) : 0
  const mostActiveToken =
    filteredAlerts
      .reduce<Map<string, number>>((acc, item) => {
        acc.set(item.token, (acc.get(item.token) ?? 0) + 1)
        return acc
      }, new Map())
      .entries()
      .next().value?.[0] ?? '—'

  return (
    <main className="min-h-screen bg-[#06060a] px-4 py-8 text-white sm:px-6 lg:px-10" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="mx-auto grid w-full max-w-[1500px] gap-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-5">
          <header className="rounded-2xl border border-white/10 bg-[#080c14] p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-4xl font-bold tracking-tight text-white">Whale Alerts</h1>
                <p className="mt-2 text-sm text-slate-300">Track smart money moves on Base in real time</p>
              </div>
              <div className="inline-flex items-center gap-2 rounded-full border border-pink-400/35 bg-pink-500/15 px-3 py-1 text-xs font-semibold text-pink-300">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#ec4899]" />LIVE
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                {FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setFlowFilter(filter)}
                    className="rounded-xl border bg-[#0a1020] px-4 py-2 text-sm font-semibold"
                    style={{
                      background: flowFilter === filter ? 'rgba(45,212,191,0.16)' : '#0a1020',
                      color: flowFilter === filter ? '#2DD4BF' : '#cbd5e1',
                      borderColor: flowFilter === filter ? 'rgba(45,212,191,0.45)' : 'rgba(255,255,255,0.08)',
                    }}
                  >
                    {filter}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {TIME_FILTERS.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setTimeFilter(filter)}
                    className="rounded-xl border border-white/10 bg-[#0a1020] px-4 py-2 text-sm font-semibold"
                    style={{ color: timeFilter === filter ? '#8b5cf6' : '#cbd5e1' }}
                  >
                    {filter}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {MIN_FILTERS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMinValue(value)}
                    className="rounded-xl border border-white/10 bg-[#0a1020] px-4 py-2 text-sm font-semibold"
                    style={{ color: minValue === value ? '#2DD4BF' : '#cbd5e1' }}
                  >
                    ${value >= 1000 ? `${value / 1000}k` : value}+
                  </button>
                ))}
              </div>
            </div>
          </header>

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

        <aside className="space-y-4">
          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">Today&apos;s Stats</h3>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between"><span className="text-[#94a3b8]">Total alerts today</span><span className="font-semibold text-white">{totalAlerts}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#94a3b8]">Largest move today</span><span className="font-bold text-white">{formatMoney(largestMove)}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#94a3b8]">Most active token</span><span className="font-bold text-white">{mostActiveToken}</span></div>
            </div>
          </div>

          <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">Top whale wallets</h3>
            <div className="space-y-2">
              {walletActivity.map(([wallet, count]) => (
                <div key={wallet} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.08)" }}>
                  <span className="text-xs text-[#2DD4BF]" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{shortWallet(wallet)}</span>
                  <span className="text-xs font-semibold text-white">{count} moves</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  )
}
