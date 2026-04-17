'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

const FREE_TOOLS = [
  { icon: '🛡', name: 'BearProof Score™', desc: 'Portfolio crash resilience' },
  { icon: '🏆', name: 'GlobalRank™', desc: 'Prediction leaderboard' },
]

const PRO_TOOLS = [
  { icon: '🔍', name: 'EdgeScan™ AI', desc: 'Live AI crypto analysis' },
  { icon: '👻', name: 'GhostTrade™', desc: '$50K paper trading' },
  { icon: '📡', name: 'DipRadar™', desc: 'AI dip scanner' },
  { icon: '🎯', name: 'TradeCoach™', desc: 'AI pattern coaching' },
  { icon: '📊', name: 'SentimentPulse™', desc: 'Fear & Greed + AI' },
  { icon: '🧾', name: 'TaxMate™', desc: 'Crypto tax AI guidance' },
  { icon: '🔔', name: 'Price Alerts', desc: 'In-browser notifications' },
  { icon: '🔓', name: 'Token Unlocks™', desc: 'Unlock risk AI scoring' },
]

const ELITE_TOOLS = [
  { icon: '🔭', name: 'WalletScan™', desc: 'Multi-chain wallet intel' },
  { icon: '⚡', name: 'SignalBreaker™', desc: 'AI buy/sell signals' },
  { icon: '🚨', name: 'PumpAlert™', desc: 'Early pump detection' },
  { icon: '🌊', name: 'NarrativeRank™', desc: 'Sector momentum' },
  { icon: '💎', name: 'Smart Wallets™', desc: 'Track elite wallets' },
  { icon: '⛓', name: 'ProofVault™', desc: 'On-chain prediction proof' },
]

const gradText: React.CSSProperties = {
  background: 'linear-gradient(135deg, #ec4899, #8b5cf6, #64ffda)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
}

type Tool = { icon: string; name: string; desc: string }

function MegaCol({ label, color, tools }: { label: string; color: string; tools: Tool[] }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{
        fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)',
        fontSize: '10px',
        fontWeight: 700,
        color,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        marginBottom: '12px',
      }}>
        {label}
      </div>
      {tools.map(t => (
        <Link
          key={t.name}
          href="/app"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '7px 8px',
            borderRadius: '8px',
            textDecoration: 'none',
            color: 'inherit',
            marginBottom: '2px',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.1)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <span style={{ fontSize: '16px', flexShrink: 0 }}>{t.icon}</span>
          <div>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>{t.name}</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginTop: '1px' }}>{t.desc}</div>
          </div>
        </Link>
      ))}
    </div>
  )
}

export default function Navbar() {
  const [megaOpen, setMegaOpen] = useState(false)

  return (
    <nav style={{
      width: '100%',
      position: 'sticky',
      top: 0,
      zIndex: 100,
      background: 'rgba(6,6,10,0.92)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderBottom: '1px solid rgba(139,92,246,0.14)',
    }}>
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '0 24px',
        height: '64px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '24px',
      }}>

        {/* Logo */}
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', flexShrink: 0 }}>
          <Image src="/cl-logo.png" alt="ChainLens AI" width={40} height={40} />
          <div>
            <div style={{ fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)', fontWeight: 700, fontSize: '15px', lineHeight: 1.2 }}>
              <span style={{ color: '#fff' }}>Chain</span>
              <span style={gradText}>Lens</span>
            </div>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              AI Intelligence
            </div>
          </div>
        </Link>

        {/* Nav links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '28px' }}>

          {/* Tools dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setMegaOpen(o => !o)}
              onBlur={e => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setMegaOpen(false) }}
              style={{
                background: 'none',
                border: 'none',
                color: megaOpen ? '#fff' : 'rgba(255,255,255,0.65)',
                cursor: 'pointer',
                fontSize: '14px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                padding: '8px 0',
                fontFamily: 'inherit',
              }}
            >
              Tools
              <svg
                width="10" height="6" viewBox="0 0 10 6" fill="none"
                style={{ transition: 'transform 0.2s', transform: megaOpen ? 'rotate(180deg)' : 'none' }}
              >
                <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {megaOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 10px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: '#0b0910',
                  border: '1px solid rgba(139,92,246,0.28)',
                  borderRadius: '16px',
                  padding: '20px',
                  width: '660px',
                  display: 'flex',
                  gap: '20px',
                  boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
                }}
                onMouseDown={e => e.preventDefault()}
              >
                <MegaCol label="Free"  color="#64ffda" tools={FREE_TOOLS} />
                <div style={{ width: '1px', background: 'rgba(139,92,246,0.15)', flexShrink: 0 }} />
                <MegaCol label="Pro"   color="#2DD4BF" tools={PRO_TOOLS} />
                <div style={{ width: '1px', background: 'rgba(139,92,246,0.15)', flexShrink: 0 }} />
                <MegaCol label="Elite" color="#8b5cf6" tools={ELITE_TOOLS} />
              </div>
            )}
          </div>

          <Link href="/app" style={{ color: 'rgba(255,255,255,0.65)', textDecoration: 'none', fontSize: '14px' }}>Signals</Link>
          <Link href="/app" style={{ color: 'rgba(255,255,255,0.65)', textDecoration: 'none', fontSize: '14px' }}>Pricing</Link>
          <Link href="/app" style={{ color: 'rgba(255,255,255,0.65)', textDecoration: 'none', fontSize: '14px' }}>Wallets</Link>
        </div>

        {/* Auth buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <Link href="/auth" style={{
            padding: '7px 16px',
            border: '1px solid rgba(139,92,246,0.28)',
            borderRadius: '8px',
            background: 'transparent',
            color: 'rgba(255,255,255,0.65)',
            fontSize: '12px',
            fontWeight: 700,
            textDecoration: 'none',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}>
            Sign In
          </Link>
          <Link href="/app" style={{
            padding: '7px 16px',
            borderRadius: '8px',
            background: '#8b5cf6',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 700,
            textDecoration: 'none',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            boxShadow: '0 0 20px rgba(139,92,246,0.35)',
          }}>
            Get Access
          </Link>
          <Link href="/terminal" style={{
            padding: '7px 18px',
            borderRadius: '8px',
            background: 'linear-gradient(90deg, #2DD4BF 0%, #8b5cf6 100%)',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 700,
            textDecoration: 'none',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            boxShadow: '0 0 22px rgba(45,212,191,0.45), 0 0 22px rgba(139,92,246,0.25)',
            whiteSpace: 'nowrap',
          }}>
            Enter Terminal
          </Link>
        </div>

      </div>
    </nav>
  )
}
