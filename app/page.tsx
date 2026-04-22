
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

// ─── Feature cards ────────────────────────────────────────────────────────────

const FEATURES = [
  {
    accent: '#2DD4BF',
    grad: 'linear-gradient(90deg, #2DD4BF 0%, #22d3ee 100%)',
    borderColor: 'rgba(45,212,191,0.16)',
    hoverBorder: 'rgba(45,212,191,0.42)',
    hoverShadow: '0 16px 56px rgba(45,212,191,0.18), 0 0 32px rgba(45,212,191,0.12), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Scan Wallets Instantly',
    body: 'See everything inside any wallet — tokens, positions, PnL, behavior patterns, smart money tags, and chain activity.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="16" cy="15" r="1.5"/>
      </svg>
    ),
  },
  {
    accent: '#ec4899',
    grad: 'linear-gradient(90deg, #ec4899 0%, #f472b6 100%)',
    borderColor: 'rgba(236,72,153,0.16)',
    hoverBorder: 'rgba(236,72,153,0.42)',
    hoverShadow: '0 16px 56px rgba(236,72,153,0.12), 0 0 28px rgba(45,212,191,0.10), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Real-Time Onchain Intelligence',
    body: 'Track whale movements, early pumps, deployer activity, and market shifts as they happen — not after.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
  },
  {
    accent: '#8b5cf6',
    grad: 'linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%)',
    borderColor: 'rgba(139,92,246,0.16)',
    hoverBorder: 'rgba(139,92,246,0.42)',
    hoverShadow: '0 16px 56px rgba(139,92,246,0.14), 0 0 28px rgba(45,212,191,0.10), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Advanced Token Scanner',
    body: 'Paste any contract and get instant AI analysis: price, liquidity, holders, deployer history, risk score, bytecode flags, and social momentum.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><path d="M11 8v6M8 11h6"/>
      </svg>
    ),
  },
  {
    accent: '#60a5fa',
    grad: 'linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)',
    borderColor: 'rgba(96,165,250,0.16)',
    hoverBorder: 'rgba(96,165,250,0.42)',
    hoverShadow: '0 16px 56px rgba(96,165,250,0.12), 0 0 28px rgba(45,212,191,0.10), 0 4px 20px rgba(0,0,0,0.45)',
    title: 'Liquidity Safety Engine',
    body: 'Detect rugs before they happen. ChainLens checks LP locks, ownership, burns, mint functions, suspicious patterns, and contract risks.',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>
      </svg>
    ),
  },
]

const PREVIEWS = [
  {
    accent: '#2DD4BF',
    title: 'Trending Tokens',
    desc: "A clean overview of what's moving on-chain. Shows which tokens are gaining attention, volume, or momentum.",
  },
  {
    accent: '#ec4899',
    title: 'Smart Money Moves',
    desc: 'A preview of how ChainLens will track high-value wallets and their actions in real time.',
  },
  {
    accent: '#8b5cf6',
    title: 'Liquidity Scanner',
    desc: 'An overview of how ChainLens will analyze liquidity health, LP status, and contract safety.',
  },
  {
    accent: '#60a5fa',
    title: 'Token Scan + Clark AI',
    desc: 'A preview of how ChainLens AI will break down any token and provide insights, risks, and context.',
  },
]

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
          0%,100% { box-shadow: 0 0 0 0 rgba(45,212,191,0), 0 0 0 1px rgba(139,92,246,0.28); }
          50%      { box-shadow: 0 0 22px 5px rgba(45,212,191,0.20), 0 0 0 1px rgba(45,212,191,0.55); }
        }
        .clark-input-box {
          animation: input-glow 3s ease-in-out infinite;
        }
        @keyframes feat-in {
          from { opacity: 0; transform: translateY(22px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .feat-card {
          transition: transform 0.24s cubic-bezier(0.22,1,0.36,1),
                      box-shadow 0.24s ease, border-color 0.24s ease;
          animation: feat-in 0.55s ease-out both;
        }
        .feat-card:hover { transform: translateY(-6px); }
        @media (max-width: 767px) {
          .mob-hero-main { padding: 40px 16px 28px !important; }
          .mob-hero-chips { justify-content: flex-start !important; overflow-x: auto !important; flex-wrap: nowrap !important; padding-bottom: 4px !important; -webkit-overflow-scrolling: touch !important; }
          .feat-grid { grid-template-columns: 1fr !important; }
          .feat-section { padding: 56px 16px 64px !important; }
        }

        /* CRT scanline sweep */
        @keyframes scanlines-move {
          from { background-position: 0 0; }
          to   { background-position: 0 80px; }
        }
        .scanline-overlay {
          position: fixed; inset: 0; pointer-events: none; z-index: 9998;
          background-image: repeating-linear-gradient(
            0deg,
            transparent,
            transparent 3px,
            rgba(255,255,255,0.016) 3px,
            rgba(255,255,255,0.016) 4px
          );
          animation: scanlines-move 14s linear infinite;
        }

        /* CORTEX badge teal pulse */
        @keyframes cortex-pulse {
          0%,100% {
            box-shadow: 0 0 12px rgba(45,212,191,0.16), 0 1px 0 rgba(255,255,255,0.04) inset;
            border-color: rgba(45,212,191,0.32);
          }
          50% {
            box-shadow: 0 0 38px rgba(45,212,191,0.52), 0 0 76px rgba(45,212,191,0.20), 0 1px 0 rgba(255,255,255,0.04) inset;
            border-color: rgba(45,212,191,0.68);
          }
        }
        .cortex-badge { animation: cortex-pulse 2.8s ease-in-out infinite; }

        /* Particle twinkle */
        @keyframes particle-twinkle {
          0%,100% { opacity: 0.10; transform: scale(1); }
          50%      { opacity: 0.38; transform: scale(1.9); }
        }

        /* Section heading teal glow */
        .section-heading {
          text-shadow: 0 0 40px rgba(45,212,191,0.30), 0 0 80px rgba(45,212,191,0.12);
        }

        /* Capability card top border slides in on hover */
        .feat-top-line {
          transform: scaleX(0);
          transform-origin: left center;
          transition: transform 0.34s cubic-bezier(0.22,1,0.36,1);
        }
        .feat-card:hover .feat-top-line { transform: scaleX(1); }
      `}</style>

      <Navbar />

      {/* CRT scanline overlay — covers entire page */}
      <div className="scanline-overlay" />

      <div className="relative min-h-screen w-full bg-[#07070f]" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* Animated orb — teal left */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '900px', height: '900px',
          borderRadius: '50%',
          top: '-200px', left: '-5%',
          background: 'radial-gradient(circle, rgba(45,212,191,0.10) 0%, transparent 68%)',
          filter: 'blur(70px)',
          animation: 'orb-teal 14s ease-in-out infinite',
        }} />

        {/* Animated orb — purple right */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '1000px', height: '1000px',
          borderRadius: '50%',
          top: '-150px', right: '-8%',
          background: 'radial-gradient(circle, rgba(139,92,246,0.10) 0%, transparent 68%)',
          filter: 'blur(90px)',
          animation: 'orb-purple 18s ease-in-out infinite',
        }} />

        {/* Static orb — teal bottom-left */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '800px', height: '800px',
          borderRadius: '50%',
          bottom: '-200px', left: '-100px',
          background: 'radial-gradient(circle, rgba(45,212,191,0.15) 0%, transparent 65%)',
          filter: 'blur(90px)',
        }} />

        {/* Static orb — purple bottom-right */}
        <div style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 0,
          width: '900px', height: '900px',
          borderRadius: '50%',
          bottom: '-250px', right: '-150px',
          background: 'radial-gradient(circle, rgba(139,92,246,0.10) 0%, transparent 65%)',
          filter: 'blur(100px)',
        }} />

        {/* Terminal grid overlay — fixed, full page */}
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
          backgroundImage: `
            linear-gradient(rgba(45,212,191,0.028) 1px, transparent 1px),
            linear-gradient(90deg, rgba(45,212,191,0.028) 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
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

          {/* Animated particle field */}
          {[
            { x: '7%',  y: '14%', dur: '6.2s', del: '0s',   sz: 1.5 },
            { x: '17%', y: '44%', dur: '9.1s', del: '1.3s', sz: 1   },
            { x: '31%', y: '21%', dur: '7.4s', del: '2.6s', sz: 2   },
            { x: '46%', y: '70%', dur: '11s',  del: '0.9s', sz: 1.5 },
            { x: '57%', y: '11%', dur: '8.2s', del: '3.2s', sz: 1   },
            { x: '70%', y: '37%', dur: '10.3s',del: '1.8s', sz: 2   },
            { x: '81%', y: '76%', dur: '6.8s', del: '4.3s', sz: 1   },
            { x: '91%', y: '27%', dur: '9.7s', del: '0.5s', sz: 1.5 },
            { x: '24%', y: '86%', dur: '7.8s', del: '2.1s', sz: 1   },
            { x: '63%', y: '54%', dur: '8.7s', del: '3.7s', sz: 2   },
            { x: '39%', y: '31%', dur: '12s',  del: '1.1s', sz: 1   },
            { x: '14%', y: '63%', dur: '9.4s', del: '5.1s', sz: 1.5 },
            { x: '75%', y: '17%', dur: '7.2s', del: '2.9s', sz: 1   },
            { x: '51%', y: '89%', dur: '10.6s',del: '0.7s', sz: 2   },
            { x: '87%', y: '51%', dur: '8.4s', del: '4.9s', sz: 1   },
            { x: '3%',  y: '50%', dur: '11.2s',del: '1.5s', sz: 1.5 },
            { x: '95%', y: '72%', dur: '7.0s', del: '3.4s', sz: 1   },
            { x: '42%', y: '6%',  dur: '9.8s', del: '6.0s', sz: 1.5 },
          ].map((p, i) => (
            <div key={i} style={{
              position: 'absolute',
              left: p.x, top: p.y,
              width: `${p.sz}px`, height: `${p.sz}px`,
              borderRadius: '50%',
              background: '#fff',
              pointerEvents: 'none',
              animation: `particle-twinkle ${p.dur} ease-in-out infinite ${p.del}`,
            }} />
          ))}

          {/* POWERED BY CORTEX ENGINE badge */}
          <div className="cortex-badge" style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(45,212,191,0.05)',
            border: '1px solid rgba(45,212,191,0.32)',
            borderRadius: '999px',
            padding: '6px 18px',
            marginBottom: '24px',
            boxShadow: '0 0 12px rgba(45,212,191,0.16), 0 1px 0 rgba(255,255,255,0.04) inset',
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
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '999px',
                    padding: '6px 14px',
                    fontSize: '10px',
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    color: 'rgba(255,255,255,0.90)',
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

        {/* ── What ChainLens Does ──────────────────────────────────────────── */}
        <section className="feat-section" style={{
          position: 'relative', zIndex: 1,
          padding: '88px 24px 96px',
          maxWidth: '1120px',
          margin: '0 auto',
          width: '100%',
        }}>
          {/* Top separator */}
          <div style={{
            position: 'absolute', top: 0, left: '10%', right: '10%', height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.25), rgba(139,92,246,0.25), transparent)',
          }} />

          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: '60px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              marginBottom: '16px',
            }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #2DD4BF)' }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#2DD4BF', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>Capabilities</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #2DD4BF, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{
              fontSize: 'clamp(30px, 4vw, 44px)', fontWeight: 800,
              letterSpacing: '-0.02em', lineHeight: 1.1,
              color: '#f8fafc', margin: '0 0 16px',
            }}>
              What ChainLens Does
            </h2>
            <p style={{
              fontSize: '16px', color: 'rgba(255,255,255,0.42)',
              maxWidth: '460px', margin: '0 auto', lineHeight: 1.65,
            }}>
              Eight features. One terminal. Built natively on Base.
            </p>
          </div>

          {/* 2 × 2 grid */}
          <div className="feat-grid" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '20px',
          }}>
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className="feat-card"
                style={{
                  background: 'linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
                  border: `1px solid ${f.borderColor}`,
                  borderRadius: '20px',
                  padding: '32px 28px',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.30)',
                  animationDelay: `${i * 0.10}s`,
                  position: 'relative',
                  overflow: 'hidden',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.borderColor = f.hoverBorder
                  el.style.boxShadow   = f.hoverShadow
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.borderColor = f.borderColor
                  el.style.boxShadow   = '0 4px 24px rgba(0,0,0,0.30)'
                }}
              >
                {/* Top accent line — slides in on hover */}
                <div className="feat-top-line" style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: `linear-gradient(90deg, transparent 0%, ${f.accent}88 50%, transparent 100%)`,
                }} />

                {/* Icon */}
                <div style={{
                  width: '48px', height: '48px', borderRadius: '14px',
                  background: `rgba(${f.accent === '#2DD4BF' ? '45,212,191' : f.accent === '#ec4899' ? '236,72,153' : f.accent === '#8b5cf6' ? '139,92,246' : '96,165,250'}, 0.10)`,
                  border: `1px solid ${f.borderColor}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: f.accent,
                  marginBottom: '20px',
                  boxShadow: `0 0 20px ${f.accent}22`,
                  flexShrink: 0,
                }}>
                  {f.icon}
                </div>

                {/* Title */}
                <h3 style={{
                  fontSize: '17px', fontWeight: 700,
                  letterSpacing: '-0.01em', lineHeight: 1.2,
                  margin: '0 0 10px',
                  background: f.grad,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}>
                  {f.title}
                </h3>

                {/* Body */}
                <p style={{
                  fontSize: '14px', lineHeight: 1.7,
                  color: 'rgba(255,255,255,0.45)',
                  margin: 0,
                  fontWeight: 400,
                }}>
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Live Intelligence Preview ─────────────────────────────────────── */}
        <section style={{
          position: 'relative', zIndex: 1,
          padding: '0 24px 96px',
          maxWidth: '1120px',
          margin: '0 auto',
          width: '100%',
        }}>
          {/* Section header */}
          <div style={{ textAlign: 'center', marginBottom: '52px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '7px',
              marginBottom: '16px',
            }}>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, transparent, #ec4899)' }} />
              <span style={{
                fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em',
                color: '#ec4899', textTransform: 'uppercase',
                fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
              }}>Live Preview</span>
              <div style={{ height: '1px', width: '28px', background: 'linear-gradient(90deg, #ec4899, transparent)' }} />
            </div>
            <h2 className="section-heading" style={{
              fontSize: 'clamp(28px, 3.8vw, 42px)', fontWeight: 800,
              letterSpacing: '-0.02em', lineHeight: 1.1,
              color: '#f8fafc', margin: '0 0 14px',
            }}>
              Live Intelligence Preview
            </h2>
            <p style={{
              fontSize: '15px', color: 'rgba(255,255,255,0.38)',
              maxWidth: '420px', margin: '0 auto', lineHeight: 1.65,
            }}>
              A glimpse of the intelligence ChainLens surfaces — live, onchain, and AI-powered.
            </p>
          </div>

          {/* 2 × 2 grid */}
          <div className="feat-grid" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '20px',
          }}>
            {PREVIEWS.map((p, i) => (
              <div
                key={p.title}
                className="feat-card"
                style={{
                  background: 'linear-gradient(145deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '20px',
                  padding: '28px',
                  backdropFilter: 'blur(12px)',
                  WebkitBackdropFilter: 'blur(12px)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.28)',
                  animationDelay: `${i * 0.10}s`,
                  position: 'relative',
                  overflow: 'hidden',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.borderColor = `${p.accent}44`
                  el.style.boxShadow = `0 16px 48px ${p.accent}12, 0 4px 16px rgba(0,0,0,0.40)`
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLDivElement
                  el.style.borderColor = 'rgba(255,255,255,0.07)'
                  el.style.boxShadow = '0 4px 24px rgba(0,0,0,0.28)'
                }}
              >
                {/* Top accent line — slides in on hover */}
                <div className="feat-top-line" style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
                  background: `linear-gradient(90deg, transparent, ${p.accent}88, transparent)`,
                }} />

                {/* Card header */}
                <div style={{ marginBottom: '20px' }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    marginBottom: '8px',
                  }}>
                    <div style={{
                      width: '6px', height: '6px', borderRadius: '50%',
                      background: p.accent,
                      boxShadow: `0 0 8px ${p.accent}99`,
                    }} />
                    <span style={{
                      fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
                      color: p.accent, textTransform: 'uppercase',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                    }}>Preview</span>
                  </div>
                  <h3 style={{
                    fontSize: '16px', fontWeight: 700,
                    color: '#f1f5f9', margin: '0 0 8px',
                    letterSpacing: '-0.01em',
                  }}>
                    {p.title}
                  </h3>
                  <p style={{
                    fontSize: '13px', lineHeight: 1.65,
                    color: 'rgba(255,255,255,0.38)',
                    margin: 0,
                  }}>
                    {p.desc}
                  </p>
                </div>

                {/* Placeholder box */}
                <div style={{
                  height: '180px',
                  borderRadius: '12px',
                  background: 'linear-gradient(160deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.008) 100%)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  position: 'relative',
                  overflow: 'hidden',
                }}>
                  {/* Faint dot grid */}
                  <div style={{
                    position: 'absolute', inset: 0, pointerEvents: 'none',
                    backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
                    backgroundSize: '20px 20px',
                  }} />
                  {/* Center label */}
                  <div style={{
                    position: 'relative', zIndex: 1,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
                  }}>
                    <div style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      background: '#2DD4BF',
                      boxShadow: '0 0 8px rgba(45,212,191,0.6)',
                      animation: 'cl-pulse 2s ease-in-out infinite',
                    }} />
                    <span style={{
                      fontSize: '12px', color: '#475569',
                      fontFamily: 'var(--font-plex-mono, IBM Plex Mono, monospace)',
                      letterSpacing: '0.04em',
                    }}>
                      Coming Soon
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

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
