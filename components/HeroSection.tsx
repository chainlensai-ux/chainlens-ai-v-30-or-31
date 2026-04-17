'use client'

import { useState } from 'react'

const CHIPS = [
  'Scan Wallet',
  'Trending on Base',
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
    <>
      <style>{`
        @keyframes liveBlink {
          0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(45,212,191,0.95); }
          50%       { opacity: 0.35; box-shadow: 0 0 4px rgba(45,212,191,0.3); }
        }
        @keyframes sendGlowPulse {
          0%, 100% { box-shadow: 0 0 14px rgba(45,212,191,0.30); }
          50%       { box-shadow: 0 0 28px rgba(45,212,191,0.65), 0 0 10px rgba(45,212,191,0.40); }
        }
        .clark-send-btn {
          animation: sendGlowPulse 4s ease-in-out infinite;
          transition: opacity 0.15s, transform 0.12s;
        }
        .clark-send-btn:hover { opacity: 0.85; transform: scale(1.03); }
        .clark-chip {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 6px;
          padding: 7px 22px;
          color: rgba(255,255,255,0.70);
          font-size: 11px;
          cursor: pointer;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: border-color 0.15s, color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.12s;
        }
        .clark-chip:hover {
          border-color: rgba(139,92,246,0.35);
          color: #a78bfa;
          background: rgba(139,92,246,0.10);
          box-shadow: 0 0 10px rgba(139,92,246,0.15), 0 0 6px rgba(236,72,153,0.08);
          transform: translateY(-1px);
        }
        .clark-box-input::placeholder { color: rgba(255,255,255,0.30); }
      `}</style>

      <section
        style={{
          paddingTop: '144px',
          paddingBottom: '70px',
          paddingLeft: '24px',
          paddingRight: '24px',
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
            marginBottom: '36px',
          }}
        >
          <div
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: '#2DD4BF',
              animation: 'liveBlink 2.5s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '0.12em', color: '#2DD4BF' }}>
            LIVE
          </span>
          <span style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.32)' }}>
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
            marginBottom: '32px',
            maxWidth: '840px',
            fontFamily: 'var(--font-inter)',
          }}
        >
          <span style={{ color: '#ffffff' }}>See The </span>
          <span style={{ color: '#2DD4BF' }}>Market</span>
          <br />
          <span style={{ background: 'linear-gradient(95deg, #8b5cf6 0%, #ec4899 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
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
            marginBottom: '64px',
            fontFamily: 'var(--font-inter)',
          }}
        >
          Track smart money, scan wallets, detect pumps, and discover Base
          opportunities in real time.
        </p>

        {/* Command box wrapper */}
        <div style={{ width: '100%', maxWidth: '628px', position: 'relative' }}>

          {/* Ambient glow */}
          <div
            style={{
              position: 'absolute',
              inset: '-56px',
              background: 'radial-gradient(ellipse 65% 55% at 50% 58%, rgba(236,72,153,0.12) 0%, rgba(139,92,246,0.12) 45%, transparent 100%)',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />

          {/* Gradient border wrapper — pink→purple 1.5px */}
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              padding: '1.5px',
              borderRadius: '21px',
              background: 'linear-gradient(135deg, rgba(236,72,153,0.60) 0%, rgba(139,92,246,0.60) 50%, rgba(236,72,153,0.28) 100%)',
              boxShadow: [
                '0 0 22px rgba(236,72,153,0.12)',
                '0 0 16px rgba(139,92,246,0.12)',
                '0 32px 80px rgba(0,0,0,0.70)',
              ].join(', '),
            }}
          >
            {/* Card */}
            <div
              style={{
                background: 'linear-gradient(160deg, #0c1828 0%, #080f1c 50%, #060b16 100%)',
                borderRadius: '20px',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                overflow: 'hidden',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset, 0 1px 0 rgba(255,255,255,0.06) inset',
              }}
            >
              {/* Top gradient accent line */}
              <div
                style={{
                  height: '1px',
                  background: 'linear-gradient(90deg, transparent, rgba(236,72,153,0.5), rgba(139,92,246,0.5), transparent)',
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
                    border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: '14px',
                    padding: '10px 10px 10px 14px',
                    marginBottom: '14px',
                  }}
                >
                  {/* Sparkle orb */}
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '10px',
                      background: 'linear-gradient(135deg, rgba(139,92,246,0.30), rgba(236,72,153,0.18))',
                      border: '1px solid rgba(139,92,246,0.35)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      boxShadow: '0 0 14px rgba(139,92,246,0.22)',
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2L9.2 6.8H14L10.4 9.4L11.6 14L8 11.4L4.4 14L5.6 9.4L2 6.8H6.8L8 2Z" fill="#a78bfa"/>
                    </svg>
                  </div>

                  {/* Input */}
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Ask Clark what whales are buying today..."
                    className="clark-box-input"
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#e2e8f0',
                      fontSize: '14px',
                      fontFamily: 'var(--font-inter)',
                      caretColor: '#a78bfa',
                    }}
                  />

                  {/* Send button — mint gradient */}
                  <button
                    className="clark-send-btn"
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
                    }}
                  >
                    Send →
                  </button>
                </div>

                {/* Chips — 2 chips, centered flex */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    gap: '6px',
                    marginBottom: '20px',
                  }}
                >
                  {CHIPS.map((chip) => (
                    <button
                      key={chip}
                      className="clark-chip"
                      onClick={() => setQuery(chip)}
                      style={{ fontFamily: 'var(--font-inter)' }}
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
                        <span key={`sep-${i}`} style={{ color: 'rgba(255,255,255,0.15)', fontSize: '12px' }}>•</span>
                      )}
                      <div key={stat.label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        {stat.icon}
                        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', fontFamily: 'var(--font-inter)' }}>
                          {stat.label}
                        </span>
                      </div>
                    </>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
