'use client'

import { useState } from 'react'

const CHIPS = [
  'Smart Money Flow',
  'Scan Wallet',
  'Trending on Base',
  'Pump Alerts',
  'Whale Alerts',
  'Token Scanner',
]

const STATS = [
  {
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M6.5 1L7.9 4.6H11.7L8.7 6.8L9.9 10.4L6.5 8.2L3.1 10.4L4.3 6.8L1.3 4.6H5.1L6.5 1Z" fill="#2DD4BF"/>
      </svg>
    ),
    label: '12,847 scans today',
  },
  {
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M6.5 1.5L7.7 4.9H11.3L8.4 6.9L9.6 10.3L6.5 8.3L3.4 10.3L4.6 6.9L1.7 4.9H5.3L6.5 1.5Z" fill="#2DD4BF"/>
      </svg>
    ),
    label: '98.7% AI accuracy',
  },
  {
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M2 9L5 6L7.5 8.5L11 4" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M9 4H11V6" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    label: '150+ sources',
  },
]

export default function HeroSection() {
  const [query, setQuery] = useState('')

  return (
    <section
      style={{
        padding: '88px 24px 120px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      {/* LIVE badge */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(45,212,191,0.07)',
          border: '1px solid rgba(45,212,191,0.18)',
          borderRadius: '100px',
          padding: '6px 14px',
          marginBottom: '32px',
        }}
      >
        <div
          style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: '#2DD4BF',
            boxShadow: '0 0 8px rgba(45,212,191,0.9)',
            animation: 'pulse 2s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontSize: '11px',
            fontFamily: 'var(--font-plex-mono)',
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: '#2DD4BF',
          }}
        >
          LIVE
        </span>
        <span
          style={{
            fontSize: '10px',
            fontFamily: 'var(--font-plex-mono)',
            letterSpacing: '0.1em',
            color: 'rgba(255,255,255,0.32)',
          }}
        >
          • POWERED BY CORTEX ENGINE
        </span>
      </div>

      {/* Headline */}
      <h1
        style={{
          fontSize: 'clamp(44px, 6vw, 76px)',
          fontWeight: 800,
          lineHeight: 1.08,
          letterSpacing: '-0.03em',
          marginBottom: '22px',
          maxWidth: '840px',
          fontFamily: 'var(--font-inter)',
        }}
      >
        <span style={{ color: '#ffffff' }}>See The </span>
        <span style={{ color: '#2DD4BF' }}>Market</span>
        <br />
        <span
          style={{
            background: 'linear-gradient(95deg, #8b5cf6 0%, #ec4899 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          Before It Moves
        </span>
      </h1>

      {/* Subheadline */}
      <p
        style={{
          fontSize: '17px',
          lineHeight: 1.65,
          color: 'rgba(255,255,255,0.42)',
          maxWidth: '520px',
          marginBottom: '48px',
          fontFamily: 'var(--font-inter)',
        }}
      >
        Track smart money, scan wallets, detect pumps, and discover Base
        opportunities in real time.
      </p>

      {/* Command box wrapper */}
      <div style={{ width: '100%', maxWidth: '582px', position: 'relative' }}>
        {/* Ambient glow */}
        <div
          style={{
            position: 'absolute',
            inset: '-48px',
            background:
              'radial-gradient(ellipse 60% 50% at 50% 60%, rgba(45,212,191,0.13) 0%, rgba(139,92,246,0.08) 55%, transparent 100%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />

        {/* Card */}
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            background: 'linear-gradient(160deg, #0c1828 0%, #080f1c 50%, #060b16 100%)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '20px',
            boxShadow:
              '0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04) inset, 0 1px 0 rgba(255,255,255,0.08) inset',
            overflow: 'hidden',
          }}
        >
          {/* Top gradient line */}
          <div
            style={{
              height: '1px',
              background:
                'linear-gradient(90deg, transparent, rgba(45,212,191,0.4), rgba(139,92,246,0.4), transparent)',
            }}
          />

          <div style={{ padding: '24px' }}>
            {/* Input row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '14px',
                padding: '10px 10px 10px 14px',
                marginBottom: '16px',
              }}
            >
              {/* Sparkle orb */}
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'linear-gradient(135deg, rgba(45,212,191,0.25), rgba(45,212,191,0.1))',
                  border: '1px solid rgba(45,212,191,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  boxShadow: '0 0 12px rgba(45,212,191,0.2)',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2L9.2 6.8H14L10.4 9.4L11.6 14L8 11.4L4.4 14L5.6 9.4L2 6.8H6.8L8 2Z" fill="#2DD4BF"/>
                </svg>
              </div>

              {/* Input */}
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask Clark what whales are buying today..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#e2e8f0',
                  fontSize: '14px',
                  fontFamily: 'var(--font-inter)',
                  caretColor: '#2DD4BF',
                }}
              />

              {/* Send button */}
              <button
                style={{
                  flexShrink: 0,
                  background: 'linear-gradient(135deg, #2DD4BF, #14b8a6)',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '8px 16px',
                  color: '#030f0e',
                  fontSize: '13px',
                  fontWeight: 700,
                  fontFamily: 'var(--font-inter)',
                  cursor: 'pointer',
                  letterSpacing: '0.02em',
                  boxShadow: '0 0 16px rgba(45,212,191,0.3)',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.85')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
              >
                Send →
              </button>
            </div>

            {/* Chips grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px',
                marginBottom: '20px',
              }}
            >
              {CHIPS.map((chip) => (
                <button
                  key={chip}
                  onClick={() => setQuery(chip)}
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    color: 'rgba(255,255,255,0.55)',
                    fontSize: '11px',
                    fontFamily: 'var(--font-inter)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(45,212,191,0.3)'
                    e.currentTarget.style.color = '#2DD4BF'
                    e.currentTarget.style.background = 'rgba(45,212,191,0.06)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                    e.currentTarget.style.color = 'rgba(255,255,255,0.55)'
                    e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Stats row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                paddingTop: '16px',
                borderTop: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {STATS.map((stat, i) => (
                <>
                  {i > 0 && (
                    <span
                      key={`sep-${i}`}
                      style={{ color: 'rgba(255,255,255,0.15)', fontSize: '12px' }}
                    >
                      •
                    </span>
                  )}
                  <div
                    key={stat.label}
                    style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
                  >
                    {stat.icon}
                    <span
                      style={{
                        fontSize: '11px',
                        color: 'rgba(255,255,255,0.45)',
                        fontFamily: 'var(--font-inter)',
                      }}
                    >
                      {stat.label}
                    </span>
                  </div>
                </>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
