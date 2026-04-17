'use client'

import { useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'

// ─── Action chips inside the prompt box ───────────────────────────────────

const CHIPS = [
  "WHAT'S PUMPING RIGHT NOW?",
  'SCAN A WHALE WALLET',
  'IS BTC A BUY RIGHT NOW?',
  'SHOW ME SMART MONEY MOVES',
  'BEST PERFORMER THIS WEEK?',
  "WHAT'S THE MARKET SENTIMENT?",
]

// ─── Bottom ticker tokens ──────────────────────────────────────────────────

const TICKER = [
  { sym: 'ADA',  price: '$0.2493', pct: '+3.88%' },
  { sym: 'AVAX', price: '$9.47',   pct: '+1.25%' },
  { sym: 'DOGE', price: '$0.0963', pct: '+3.55%' },
  { sym: 'DOT',  price: '$1.26',   pct: '+8.60%' },
  { sym: 'LINK', price: '$9.29',   pct: '+2.44%' },
  { sym: 'UNI',  price: '$3.27',   pct: '+3.63%' },
  { sym: 'LTC',  price: '$55.50',  pct: '+2.21%' },
  { sym: 'BCH',  price: '$439.90', pct: '+1.39%' },
  { sym: 'XLM',  price: '$0.1619', pct: '+3.78%' },
  { sym: 'ATOM', price: '$1.80',   pct: '+3.35%' },
  { sym: 'XMR',  price: '$344.77', pct: '+1.22%' },
  { sym: 'ETC',  price: '$8.55',   pct: '+2.79%' },
  { sym: 'FIL',  price: '$0.9692', pct: '+8.31%' },
  { sym: 'AAVE', price: '$106.45', pct: '+5.66%' },
  { sym: 'MKR',  price: '$1,773',  pct: '+0.78%' },
  { sym: 'OP',   price: '$0.1227', pct: '+8.46%' },
  { sym: 'ARB',  price: '$0.1190', pct: '+5.54%' },
  { sym: 'NEAR', price: '$1.43',   pct: '+6.09%' },
  { sym: 'FTM',  price: '$0.0471', pct: '+3.84%' },
]

// ─── Page ─────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [query, setQuery] = useState('')

  return (
    <>
      {/* Keyframes */}
      <style>{`
        @keyframes ticker-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        ::placeholder { color: rgba(255,255,255,0.3); }
      `}</style>

      <Navbar />

      <div className="relative min-h-screen bg-[#07070f] overflow-hidden" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* Scattered-star background */}
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: [
            'radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.18) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 28% 55%, rgba(255,255,255,0.12) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 44% 32%, rgba(255,255,255,0.15) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 62% 74%, rgba(255,255,255,0.10) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 78% 22%, rgba(255,255,255,0.13) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 88% 60%, rgba(255,255,255,0.16) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 5%  80%, rgba(255,255,255,0.10) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 35% 90%, rgba(255,255,255,0.12) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 55% 10%, rgba(255,255,255,0.14) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 92% 45%, rgba(255,255,255,0.11) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 20% 42%, rgba(255,255,255,0.09) 0%, transparent 100%)',
            'radial-gradient(1px 1px at 70% 88%, rgba(255,255,255,0.10) 0%, transparent 100%)',
          ].join(', '),
        }} />

        {/* Hero */}
        <main style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '60px 24px 40px',
          position: 'relative',
          zIndex: 1,
          textAlign: 'center',
        }}>

          {/* POWERED BY CORTEX ENGINE badge */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '7px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(139,92,246,0.28)',
            borderRadius: '999px',
            padding: '5px 14px',
            marginBottom: '28px',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#4ade80',
              boxShadow: '0 0 7px #4ade80',
              display: 'inline-block',
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.15em',
              color: 'rgba(255,255,255,0.75)',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              textTransform: 'uppercase',
            }}>
              Powered by CORTEX ENGINE
            </span>
          </div>

          {/* Headline */}
          <h1 style={{
            fontSize: 'clamp(52px, 7vw, 80px)',
            fontWeight: 800,
            lineHeight: 1.08,
            letterSpacing: '-0.02em',
            margin: '0 0 24px',
            maxWidth: '820px',
          }}>
            {/* Line 1 — white */}
            <span style={{ color: '#ffffff', display: 'block' }}>
              See what whales do
            </span>
            {/* Line 2 — pink → purple gradient */}
            <span style={{
              display: 'block',
              background: 'linear-gradient(90deg, #ec4899 0%, #a855f7 50%, #818cf8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              before everyone else
            </span>
            {/* Line 3 — purple */}
            <span style={{
              display: 'block',
              background: 'linear-gradient(90deg, #a855f7 0%, #8b5cf6 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              does
            </span>
          </h1>

          {/* Subtext */}
          <p style={{
            fontSize: '16px',
            color: 'rgba(255,255,255,0.55)',
            lineHeight: 1.65,
            maxWidth: '480px',
            margin: '0 0 36px',
          }}>
            Ask Clark anything — scan wallets, find early pumps, track
            smart money, and get real-time onchain intelligence.
          </p>

          {/* Prompt box */}
          <div style={{
            width: '100%',
            maxWidth: '520px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(139,92,246,0.28)',
            borderRadius: '16px',
            padding: '20px 20px 16px',
            marginBottom: '28px',
          }}>

            {/* Action chips — 3 rows */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginBottom: '18px' }}>
              {CHIPS.map(chip => (
                <button
                  key={chip}
                  onClick={() => setQuery(chip)}
                  style={{
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '999px',
                    padding: '5px 13px',
                    fontSize: '9.5px',
                    fontWeight: 600,
                    letterSpacing: '0.10em',
                    color: 'rgba(255,255,255,0.7)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    transition: 'border-color 0.15s, color 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.borderColor = 'rgba(139,92,246,0.6)'
                    el.style.color = '#fff'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.borderColor = 'rgba(255,255,255,0.15)'
                    el.style.color = 'rgba(255,255,255,0.7)'
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.07)', marginBottom: '14px' }} />

            {/* Input row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Ask Clark — scan a wallet, find early pumps, track smart money..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'rgba(255,255,255,0.75)',
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  minWidth: 0,
                }}
              />
              <Link href="/terminal" style={{
                width: '34px',
                height: '34px',
                borderRadius: '50%',
                background: '#8b5cf6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                boxShadow: '0 0 16px rgba(139,92,246,0.5)',
                textDecoration: 'none',
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </Link>
            </div>

            {/* Box footer */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '12px',
            }}>
              <span style={{
                fontSize: '9px',
                fontWeight: 600,
                color: 'rgba(255,255,255,0.25)',
                letterSpacing: '0.13em',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
              }}>
                <span style={{ fontSize: '11px', opacity: 0.5 }}>⊙</span>
                CORTEX
              </span>
              <span style={{
                fontSize: '9px',
                color: 'rgba(255,255,255,0.2)',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>
                Ask anything — powered by CORTEX
              </span>
            </div>

          </div>

          {/* CTA buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>

            {/* Primary — Enter Terminal */}
            <Link href="/terminal" style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '10px',
              padding: '16px 40px',
              borderRadius: '12px',
              background: 'linear-gradient(90deg, #2DD4BF 0%, #8b5cf6 100%)',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 800,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              textDecoration: 'none',
              boxShadow: '0 0 36px rgba(45,212,191,0.5), 0 0 36px rgba(139,92,246,0.3)',
              transition: 'opacity 0.15s, box-shadow 0.15s, transform 0.15s',
            }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLAnchorElement
                el.style.opacity    = '0.92'
                el.style.transform  = 'translateY(-2px)'
                el.style.boxShadow  = '0 0 52px rgba(45,212,191,0.65), 0 0 52px rgba(139,92,246,0.4)'
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLAnchorElement
                el.style.opacity    = '1'
                el.style.transform  = 'translateY(0)'
                el.style.boxShadow  = '0 0 36px rgba(45,212,191,0.5), 0 0 36px rgba(139,92,246,0.3)'
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
                <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                <path d="M7 8l3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="13" y1="11" x2="17" y2="11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              Enter Terminal
            </Link>

            {/* Secondary pair */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                style={{
                  padding: '11px 28px',
                  borderRadius: '10px',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.65)',
                  fontSize: '12px',
                  fontWeight: 700,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  border: '1px solid rgba(255,255,255,0.18)',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s, color 0.15s',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.borderColor = 'rgba(255,255,255,0.38)'
                  el.style.color       = '#fff'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.borderColor = 'rgba(255,255,255,0.18)'
                  el.style.color       = 'rgba(255,255,255,0.65)'
                }}
              >
                Connect Wallet
              </button>
              <Link href="/app" style={{
                display: 'inline-block',
                padding: '11px 28px',
                borderRadius: '10px',
                background: 'rgba(139,92,246,0.18)',
                color: 'rgba(255,255,255,0.75)',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                textDecoration: 'none',
                border: '1px solid rgba(139,92,246,0.35)',
                transition: 'background 0.15s, color 0.15s',
              }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLAnchorElement
                  el.style.background = 'rgba(139,92,246,0.28)'
                  el.style.color      = '#fff'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLAnchorElement
                  el.style.background = 'rgba(139,92,246,0.18)'
                  el.style.color      = 'rgba(255,255,255,0.75)'
                }}
              >
                Start Free
              </Link>
            </div>
          </div>

        </main>

        {/* Bottom token ticker */}
        <div style={{
          position: 'relative',
          zIndex: 1,
          borderTop: '1px solid rgba(255,255,255,0.07)',
          background: '#05050c',
          height: '40px',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
        }}>
          {/* Double the list so the scroll loops seamlessly */}
          <div style={{
            display: 'flex',
            gap: '0',
            whiteSpace: 'nowrap',
            animation: 'ticker-scroll 40s linear infinite',
            willChange: 'transform',
          }}>
            {[...TICKER, ...TICKER].map((t, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '0 28px',
                  fontSize: '12px',
                  color: 'rgba(255,255,255,0.55)',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  borderRight: '1px solid rgba(255,255,255,0.07)',
                }}
              >
                <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{t.sym}</span>
                <span>{t.price}</span>
                <span style={{ color: '#4ade80', fontWeight: 600 }}>{t.pct}</span>
              </span>
            ))}
          </div>
        </div>

      </div>
    </>
  )
}
