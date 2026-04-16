'use client'

import { useState } from 'react'

type Tab = 'Trending' | 'Smart Money' | 'New Wallets'

const TABS: Tab[] = ['Trending', 'Smart Money', 'New Wallets']

const TOKENS = [
  { sym: 'BRETT',   chain: 'Base',   price: '$0.142',    change: +24.7, vol: '$12.4M', color: '#3b82f6' },
  { sym: 'TOSHI',   chain: 'Base',   price: '$0.00089',  change: +18.3, vol: '$8.2M',  color: '#0ea5e9' },
  { sym: 'VIRTUAL', chain: 'Base',   price: '$2.89',     change: +12.1, vol: '$24.1M', color: '#8b5cf6' },
  { sym: 'AERO',    chain: 'Base',   price: '$1.47',     change: -3.2,  vol: '$6.8M',  color: '#2DD4BF' },
  { sym: 'BONK',    chain: 'Solana', price: '$0.000024', change: +8.9,  vol: '$15.3M', color: '#f97316' },
]

export default function HomeTokenScreener() {
  const [tab, setTab] = useState<Tab>('Trending')

  return (
    <section style={{ padding: '0 24px 96px' }}>
      <div
        style={{
          maxWidth: '960px',
          margin: '0 auto',
          background: '#080c14',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          overflow: 'hidden',
        }}
      >
        {/* Header row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 24px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <span
            style={{
              fontSize: '15px',
              fontWeight: 700,
              color: '#f1f5f9',
              fontFamily: 'var(--font-inter)',
            }}
          >
            Token Screener
          </span>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '6px' }}>
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontFamily: 'var(--font-inter)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  background: tab === t ? 'rgba(45,212,191,0.12)' : 'transparent',
                  border: tab === t ? '1px solid rgba(45,212,191,0.3)' : '1px solid transparent',
                  color: tab === t ? '#2DD4BF' : 'rgba(255,255,255,0.4)',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Column headers */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
            padding: '10px 24px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {['TOKEN', 'CHAIN', 'PRICE', '24H', 'VOLUME'].map((col) => (
            <span
              key={col}
              style={{
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.12em',
                color: '#3e5c78',
                fontFamily: 'var(--font-plex-mono)',
                textTransform: 'uppercase',
              }}
            >
              {col}
            </span>
          ))}
        </div>

        {/* Rows */}
        {TOKENS.map((token, i) => (
          <div
            key={token.sym}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
              padding: '14px 24px',
              alignItems: 'center',
              borderBottom: i < TOKENS.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              cursor: 'pointer',
              transition: 'background 0.12s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.025)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            {/* Token */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: `${token.color}22`,
                  border: `1px solid ${token.color}40`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                  fontFamily: 'var(--font-plex-mono)',
                  color: token.color,
                  flexShrink: 0,
                }}
              >
                {token.sym[0]}
              </div>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  fontFamily: 'var(--font-inter)',
                }}
              >
                {token.sym}
              </span>
            </div>

            {/* Chain */}
            <span
              style={{
                fontSize: '12px',
                color: '#4e6e88',
                fontFamily: 'var(--font-inter)',
              }}
            >
              {token.chain}
            </span>

            {/* Price */}
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#e2e8f0',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              {token.price}
            </span>

            {/* 24H */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {token.change > 0 ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M5 2L8.5 7H1.5L5 2Z" fill="#2DD4BF"/>
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M5 8L1.5 3H8.5L5 8Z" fill="#fb7185"/>
                </svg>
              )}
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  fontFamily: 'var(--font-plex-mono)',
                  color: token.change > 0 ? '#2DD4BF' : '#fb7185',
                }}
              >
                {token.change > 0 ? '+' : ''}{token.change}%
              </span>
            </div>

            {/* Volume */}
            <span
              style={{
                fontSize: '12px',
                color: '#7a90a8',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              {token.vol}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
