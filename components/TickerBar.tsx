'use client'

import { useEffect, useState } from 'react'

const COINS = [
  { id: 'bitcoin', sym: 'BTC' },
  { id: 'ethereum', sym: 'ETH' },
  { id: 'solana', sym: 'SOL' },
  { id: 'binancecoin', sym: 'BNB' },
  { id: 'ripple', sym: 'XRP' },
  { id: 'cardano', sym: 'ADA' },
  { id: 'avalanche-2', sym: 'AVAX' },
  { id: 'dogecoin', sym: 'DOGE' },
  { id: 'chainlink', sym: 'LINK' },
  { id: 'uniswap', sym: 'UNI' },
  { id: 'polkadot', sym: 'DOT' },
  { id: 'near', sym: 'NEAR' },
  { id: 'arbitrum', sym: 'ARB' },
  { id: 'optimism', sym: 'OP' },
  { id: 'aave', sym: 'AAVE' },
  { id: 'injective-protocol', sym: 'INJ' },
]

type PriceData = { usd: number; usd_24h_change: number }
type Prices = Record<string, PriceData>

function fmt(p: number) {
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 1) return '$' + p.toFixed(2)
  return '$' + p.toFixed(4)
}

export default function TickerBar() {
  const [prices, setPrices] = useState<Prices>({})

  useEffect(() => {
    const ids = COINS.map(c => c.id).join(',')
    const load = () =>
      fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`)
        .then(r => r.json())
        .then(setPrices)
        .catch(() => {})

    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  const hasData = Object.keys(prices).length > 0
  if (!hasData) return null

  const items = COINS.flatMap(({ id, sym }) => {
    const d = prices[id]
    if (!d) return []
    const up = d.usd_24h_change >= 0
    return [
      <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.65)', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)' }}>{sym}</span>
        <span style={{ fontSize: '11px', color: '#fff', fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)' }}>{fmt(d.usd)}</span>
        <span style={{
          fontSize: '10px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px',
          background: up ? 'rgba(100,255,218,0.12)' : 'rgba(239,71,111,0.1)',
          color: up ? '#64ffda' : '#ef476f',
        }}>
          {up ? '+' : ''}{d.usd_24h_change.toFixed(2)}%
        </span>
      </div>,
      <div key={id + '-d'} style={{ width: '1px', height: '12px', background: 'rgba(139,92,246,0.12)', flexShrink: 0 }} />,
    ]
  })

  return (
    <div style={{
      background: 'linear-gradient(90deg, rgba(139,92,246,0.03), rgba(9,11,24,0.8), rgba(139,92,246,0.03))',
      borderTop: '1px solid rgba(139,92,246,0.07)',
      borderBottom: '1px solid rgba(139,92,246,0.05)',
      padding: '11px 0',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex',
        gap: '36px',
        width: 'max-content',
        animation: 'ticker-scroll 80s linear infinite',
      }}>
        {items}
        {items}
      </div>
    </div>
  )
}
