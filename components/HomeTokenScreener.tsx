'use client'

import { useEffect, useState } from 'react'

const COLS = ['TOKEN', 'CHAIN', 'PRICE', '24H', 'VOLUME']

interface DexPair {
  pairAddress: string
  baseToken?: { symbol?: string; name?: string }
  chainId?: string
  priceUsd?: string
  priceChange?: { h24?: number }
  volume?: { h24?: number }
}

interface MergedToken {
  contract: string
  symbol: string
  name: string
  chain: string
  price: number | null
  liquidity: number | null
  volume: number | null
  change24h: number | null
  source: string
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed.toLowerCase() === 'nan') return null
    const parsed = Number(trimmed.replace(/[$,\s]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function formatUsd(value: unknown): string {
  const numeric = parseNumeric(value)
  if (!isFiniteNumber(numeric)) return 'Unverified'
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(2)}M`
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}K`
  if (numeric >= 1) return `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
}

function TokenCard({ data }: { data: DexPair }) {
  const change = parseNumeric(data.priceChange?.h24) ?? 0
  const changeColor = change > 0 ? '#2DD4BF' : change < 0 ? '#f87171' : 'rgba(255,255,255,0.40)'
  const priceNumeric = parseNumeric(data.priceUsd)
  const price = isFiniteNumber(priceNumeric) ? `$${priceNumeric.toFixed(6)}` : '—'
  const vol = formatUsd(data.volume?.h24)

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
        padding: '0 16px',
        minHeight: '44px',
        borderBottom: '1px solid rgba(255,255,255,0.03)',
        alignItems: 'center',
      }}
    >
      <span style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9', fontFamily: 'var(--font-inter)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.baseToken?.symbol ?? data.pairAddress?.slice(0, 8) ?? '—'}
      </span>
      <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.40)', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.06em' }}>
        {data.chainId ?? 'base'}
      </span>
      <span style={{ fontSize: '11px', color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}>
        {price}
      </span>
      <span style={{ fontSize: '11px', color: changeColor, fontFamily: 'var(--font-plex-mono)' }}>
        {change !== 0 ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}
      </span>
      <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontFamily: 'var(--font-plex-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {vol}
      </span>
    </div>
  )
}

export default function HomeTokenScreener() {
  const [trending, setTrending] = useState<MergedToken[]>([])
  const [lastUpdate, setLastUpdate] = useState<number | null>(null)

  useEffect(() => {
    async function fetchTrending(): Promise<MergedToken[]> {
      const res = await fetch(`/api/trending`)
      const json = await res.json()
      return json.data || []
    }

    async function poll() {
      const result = await fetchTrending()
      if (result.length > 0) {
        setTrending(result)
        setLastUpdate(Date.now())
      }
    }

    poll()
    const interval = setInterval(poll, 60000)
    return () => clearInterval(interval)
  }, [])

  return (
    <>
      <style>{`
        .screener-scroll::-webkit-scrollbar { width: 4px; }
        .screener-scroll::-webkit-scrollbar-track { background: transparent; }
        .screener-scroll::-webkit-scrollbar-thumb {
          background: rgba(45,212,191,0.18);
          border-radius: 4px;
        }
        .screener-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(45,212,191,0.32);
        }
        .screener-scroll { scrollbar-width: thin; scrollbar-color: rgba(45,212,191,0.18) transparent; }
      `}</style>

      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, minHeight: 0, width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            minHeight: 0,
            background: 'linear-gradient(160deg, #080d1c 0%, #060a14 100%)',
            border: '1px solid rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            overflow: 'hidden',
            height: '100%',
            boxShadow: [
              '0 0 20px rgba(45,212,191,0.05)',
              '0 0 12px rgba(139,92,246,0.04)',
              '0 20px 56px rgba(0,0,0,0.50)',
            ].join(', '),
          }}
        >
          {/* Top accent line */}
          <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.28), rgba(139,92,246,0.28), transparent)', flexShrink: 0 }} />

          {/* Header row */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#f1f5f9', fontFamily: 'var(--font-inter)', textShadow: '0 0 14px rgba(45,212,191,0.10)' }}>
              Token Screener
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span style={{
                fontSize: '9px', fontWeight: 700, color: '#ffffff',
                background: '#0052FF', borderRadius: '4px',
                padding: '2px 7px', fontFamily: 'var(--font-inter)',
                letterSpacing: '0.05em',
                boxShadow: '0 0 8px rgba(0,82,255,0.30)',
              }}>
                BASE
              </span>
              <div style={{
                padding: '3px 10px', borderRadius: '6px',
                fontSize: '11px', fontFamily: 'var(--font-inter)', fontWeight: 600,
                background: 'rgba(45,212,191,0.08)', border: '1px solid rgba(45,212,191,0.22)',
                color: '#2DD4BF',
                boxShadow: '0 0 8px rgba(45,212,191,0.10)',
                transition: 'box-shadow 0.15s, border-color 0.15s',
              }}>
                Trending
              </div>
            </div>
          </div>

          {/* Column headers */}
          <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)', minHeight: '34px', alignItems: 'center' }}>
            {COLS.map(col => (
              <span key={col} style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', color: '#3e5c78', fontFamily: 'var(--font-plex-mono)', textTransform: 'uppercase' }}>
                {col}
              </span>
            ))}
          </div>

          {/* Scrollable content area */}
          <div
            className="screener-scroll"
            style={{
              flex: 1,
              overflowY: 'auto',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              maxHeight: '100%',
            }}
          >
            <div style={{ padding: '4px 16px', fontSize: '10px', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.07em', color: lastUpdate ? '#2DD4BF' : 'rgba(255,255,255,0.22)', flexShrink: 0 }}>
              {lastUpdate
                ? `LIVE — Updated at ${new Date(lastUpdate).toLocaleTimeString()}`
                : 'Waiting for live data…'}
            </div>

            {trending.length === 0 ? (
              <div style={{
                flex: 1,
                padding: '36px 16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}>
                <span style={{
                  fontSize: '11px',
                  color: 'rgba(255,255,255,0.22)',
                  fontFamily: 'var(--font-inter)',
                  letterSpacing: '0.01em',
                }}>
                  Connecting to live Base feed…
                </span>
              </div>
            ) : (
              trending.slice(0, 40).map(token => (
                <TokenCard
                  key={token.contract}
                  data={{
                    pairAddress: token.contract,
                    baseToken: { symbol: token.symbol, name: token.name },
                    chainId: 'base',
                    priceUsd: token.price != null ? String(token.price) : undefined,
                    priceChange: { h24: token.change24h ?? undefined },
                    volume: { h24: token.volume ?? undefined },
                  }}
                />
              ))
            )}
          </div>

          {/* Footer */}
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 5px rgba(45,212,191,0.65)', flexShrink: 0 }} />
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.07em' }}>
              LIVE BASE DATA
            </span>
          </div>
        </div>
      </section>
    </>
  )
}
