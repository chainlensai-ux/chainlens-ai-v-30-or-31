
'use client'

import { useState } from 'react'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import HomeClarkPanel from '@/components/HomeClarkPanel'
import ConnectWallet from '@/components/ConnectWallet'

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
  const [showClarkPanel, setShowClarkPanel] = useState(false)
  const [initialClarkMessage, setInitialClarkMessage] = useState<string | null>(null)

  return (
    <>
      {/* Keyframes */}
      <style>{`
        @keyframes ticker-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        ::placeholder { color: rgba(255,255,255,0.3); }

        @keyframes orb-teal {
          0%,100% { transform: translate(0, 0) scale(1); opacity: 0.55; }
          33%      { transform: translate(60px, -40px) scale(1.12); opacity: 0.70; }
          66%      { transform: translate(-40px, 30px) scale(0.90); opacity: 0.45; }
        }
        @keyframes orb-purple {
          0%,100% { transform: translate(0, 0) scale(1); opacity: 0.45; }
          33%      { transform: translate(-50px, 50px) scale(1.08); opacity: 0.60; }
          66%      { transform: translate(70px, -30px) scale(0.92); opacity: 0.38; }
        }
        @keyframes input-glow {
          0%,100% { box-shadow: 0 0 0 0 rgba(45,212,191,0), inset 0 0 0 1px rgba(139,92,246,0.28); }
          50%      { box-shadow: 0 0 18px 4px rgba(45,212,191,0.18), inset 0 0 0 1px rgba(45,212,191,0.45); }
        }
        .clark-input-box {
          animation: input-glow 3s ease-in-out infinite;
        }
        @media (max-width: 767px) {
          .mob-hero-main { padding: 40px 16px 28px !important; }
          .mob-hero-chips { justify-content: flex-start !important; overflow-x: auto !important; flex-wrap: nowrap !important; padding-bottom: 4px !important; -webkit-overflow-scrolling: touch !important; }
        }
      `}</style>

      <Navbar />

      <div className="relative min-h-screen w-full bg-[#07070f]" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* Animated orb — teal */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '600px', height: '600px',
          borderRadius: '50%',
          top: '-120px', left: '10%',
          background: 'radial-gradient(circle, rgba(45,212,191,0.18) 0%, transparent 70%)',
          filter: 'blur(60px)',
          animation: 'orb-teal 14s ease-in-out infinite',
        }} />

        {/* Animated orb — purple */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '700px', height: '700px',
          borderRadius: '50%',
          top: '-80px', right: '5%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.16) 0%, transparent 70%)',
          filter: 'blur(80px)',
          animation: 'orb-purple 18s ease-in-out infinite',
        }} />

        {/* Subtle grid overlay */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 30%, black 20%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 30%, black 20%, transparent 80%)',
        }} />

        {/* Scattered-star background */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1,
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
        <main className="mob-hero-main" style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '76px 24px 52px',
          position: 'relative',
          zIndex: 1,
          textAlign: 'center',
        }}>

          {/* POWERED BY CORTEX ENGINE badge */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(139,92,246,0.30)',
            borderRadius: '999px',
            padding: '6px 18px',
            marginBottom: '24px',
            boxShadow: '0 0 24px rgba(139,92,246,0.10), 0 1px 0 rgba(255,255,255,0.04) inset',
          }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#4ade80',
              boxShadow: '0 0 8px rgba(74,222,128,0.8)',
              display: 'inline-block',
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.16em',
              color: 'rgba(255,255,255,0.70)',
              fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              textTransform: 'uppercase',
            }}>
              Powered by CORTEX ENGINE
            </span>
          </div>

          {/* Headline */}
          <h1 style={{
            fontSize: 'clamp(48px, 6.5vw, 76px)',
            fontWeight: 800,
            lineHeight: 1.06,
            letterSpacing: '-0.025em',
            margin: '0 0 20px',
            maxWidth: '780px',
          }}>
            {/* Line 1 — white */}
            <span style={{ color: '#f8fafc', display: 'block' }}>
              See what whales do
            </span>
            {/* Line 2 — pink → indigo gradient (merged with "does") */}
            <span style={{
              display: 'block',
              background: 'linear-gradient(95deg, #ec4899 0%, #a855f7 45%, #818cf8 80%, #6366f1 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              before everyone else does
            </span>
          </h1>

          {/* Subtext */}
          <p style={{
            fontSize: '17px',
            color: 'rgba(255,255,255,0.48)',
            lineHeight: 1.7,
            maxWidth: '520px',
            margin: '0 0 32px',
            fontWeight: 400,
          }}>
            Ask Clark anything — scan wallets, find early pumps, track
            smart money, and get real-time onchain intelligence.
          </p>

          {/* Prompt box */}
          <div className="clark-input-box" style={{
            width: '100%',
            maxWidth: '600px',
            background: 'rgba(255,255,255,0.025)',
            border: '1px solid rgba(139,92,246,0.25)',
            borderRadius: '18px',
            padding: '20px 20px 18px',
            marginBottom: '32px',
            boxShadow: '0 4px 40px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.04) inset',
          }}>

            {/* Action chips */}
            <div className="mob-hero-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', justifyContent: 'center', marginBottom: '18px' }}>
              {CHIPS.map(chip => (
                <button
                  key={chip}
                  onClick={() => setQuery(chip)}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: '999px',
                    padding: '6px 14px',
                    fontSize: '10px',
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    color: 'rgba(255,255,255,0.60)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    transition: 'border-color 0.15s, color 0.15s, background 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.borderColor = 'rgba(139,92,246,0.45)'
                    el.style.color = 'rgba(255,255,255,0.90)'
                    el.style.background = 'rgba(139,92,246,0.08)'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.borderColor = 'rgba(255,255,255,0.10)'
                    el.style.color = 'rgba(255,255,255,0.60)'
                    el.style.background = 'rgba(255,255,255,0.04)'
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', marginBottom: '14px' }} />

            {/* Input row */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '10px',
              padding: '8px 8px 8px 14px',
            }}>
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && query.trim()) {
                    setInitialClarkMessage(query.trim())
                    setShowClarkPanel(true)
                    setQuery('')
                    e.preventDefault()
                  }
                }}
                placeholder="Ask Clark — scan a wallet, find early pumps, track smart money..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'rgba(255,255,255,0.80)',
                  fontSize: '13px',
                  fontFamily: 'inherit',
                  minWidth: 0,
                }}
              />
              <button
                onClick={() => {
                  if (query.trim()) {
                    setInitialClarkMessage(query.trim())
                    setShowClarkPanel(true)
                    setQuery('')
                  }
                }}
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  boxShadow: '0 0 18px rgba(139,92,246,0.55)',
                  border: '1px solid rgba(139,92,246,0.50)',
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'box-shadow 0.15s, transform 0.15s',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M13 6l6 6-6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>

            {/* Box footer */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginTop: '12px',
            }}>
              <span style={{
                width: '5px', height: '5px', borderRadius: '50%',
                background: '#4ade80',
                boxShadow: '0 0 5px rgba(74,222,128,0.7)',
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: '9px',
                fontWeight: 600,
                color: 'rgba(255,255,255,0.22)',
                letterSpacing: '0.13em',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                textTransform: 'uppercase',
              }}>
                Live · Powered by CORTEX
              </span>
            </div>

          </div>

          {/* CTA buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>

            {/* Primary — Enter Terminal */}
            <Link href="/terminal" className="mob-cta-primary" style={{
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
            <div className="mob-cta-secondary" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <ConnectWallet />
              <Link href="/app" style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '11px 28px',
                borderRadius: '10px',
                background: 'rgba(139,92,246,0.12)',
                color: 'rgba(255,255,255,0.72)',
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                textDecoration: 'none',
                border: '1px solid rgba(139,92,246,0.28)',
                transition: 'background 0.15s, color 0.15s, border-color 0.15s',
              }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLAnchorElement
                  el.style.background   = 'rgba(139,92,246,0.24)'
                  el.style.color        = '#fff'
                  el.style.borderColor  = 'rgba(139,92,246,0.50)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLAnchorElement
                  el.style.background   = 'rgba(139,92,246,0.12)'
                  el.style.color        = 'rgba(255,255,255,0.72)'
                  el.style.borderColor  = 'rgba(139,92,246,0.28)'
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
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'linear-gradient(180deg, #04040b 0%, #05050c 100%)',
          height: '44px',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
        }}>
          {/* Edge fade — left */}
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: '80px',
            background: 'linear-gradient(90deg, #05050c 0%, transparent 100%)',
            zIndex: 2, pointerEvents: 'none',
          }} />
          {/* Edge fade — right */}
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '80px',
            background: 'linear-gradient(270deg, #05050c 0%, transparent 100%)',
            zIndex: 2, pointerEvents: 'none',
          }} />
          {/* Double the list so the scroll loops seamlessly */}
          <div style={{
            display: 'flex',
            gap: '0',
            whiteSpace: 'nowrap',
            animation: 'ticker-scroll 44s linear infinite',
            willChange: 'transform',
          }}>
            {[...TICKER, ...TICKER].map((t, i) => (
              <span
                key={i}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '7px',
                  padding: '0 32px',
                  fontSize: '11.5px',
                  color: 'rgba(255,255,255,0.45)',
                  fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                  borderRight: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <span style={{ fontWeight: 700, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.04em' }}>{t.sym}</span>
                <span style={{ color: 'rgba(255,255,255,0.40)' }}>{t.price}</span>
                <span style={{ color: '#4ade80', fontWeight: 600 }}>{t.pct}</span>
              </span>
            ))}
          </div>
        </div>

      </div>

      {/* Sliding Clark panel — triggered by Enter in the hero input */}
      <HomeClarkPanel
        open={showClarkPanel}
        initialMessage={initialClarkMessage}
        onClose={() => setShowClarkPanel(false)}
      />
    </>
 
  )
}
