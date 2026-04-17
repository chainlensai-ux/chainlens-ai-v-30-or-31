'use client'

import { useState } from 'react'

const CHIPS = [
  'Scan Wallet',
  'Trending on Base',
]

const STATS = [
  {
    icon: (
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none">
        <path d="M6.5 1L7.9 4.6H11.7L8.7 6.8L9.9 10.4L6.5 8.2L3.1 10.4L4.3 6.8L1.3 4.6H5.1L6.5 1Z" fill="#2DD4BF"/>
      </svg>
    ),
    label: '12,847 scans today',
  },
  {
    icon: (
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none">
        <path d="M6.5 1.5L7.7 4.9H11.3L8.4 6.9L9.6 10.3L6.5 8.3L3.4 10.3L4.6 6.9L1.7 4.9H5.3L6.5 1.5Z" fill="#2DD4BF"/>
      </svg>
    ),
    label: '98.7% AI accuracy',
  },
  {
    icon: (
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none">
        <path d="M2 9L5 6L7.5 8.5L11 4" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M9 4H11V6" stroke="#2DD4BF" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    label: '150+ sources',
  },
]

interface HeroSectionProps {
  onTyping?: (typing: boolean) => void
}

export default function HeroSection({ onTyping }: HeroSectionProps) {
  const [query, setQuery] = useState('')

  return (
    <>
      <style>{`
        @keyframes liveBlink {
          0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(45,212,191,0.90); }
          50%       { opacity: 0.35; box-shadow: 0 0 3px rgba(45,212,191,0.25); }
        }
        @keyframes sendGlowPulse {
          0%, 100% { box-shadow: 0 0 10px rgba(236,72,153,0.40), 0 0 6px rgba(139,92,246,0.28); }
          50%       { box-shadow: 0 0 22px rgba(236,72,153,0.70), 0 0 16px rgba(139,92,246,0.50), 0 0 32px rgba(236,72,153,0.22); }
        }
        @keyframes arrowPulse {
          0%, 100% { opacity: 1; transform: translateX(0); }
          50%       { opacity: 0.70; transform: translateX(1.5px); }
        }
        .clark-send-btn {
          animation: sendGlowPulse 3s ease-in-out infinite;
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .clark-send-btn:hover {
          transform: scale(1.12);
          box-shadow: 0 0 30px rgba(236,72,153,0.80), 0 0 20px rgba(139,92,246,0.60) !important;
          animation: none;
        }
        .clark-send-arrow { animation: arrowPulse 2.5s ease-in-out infinite; display: inline-block; }
        .clark-chip {
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 6px;
          padding: 6px 20px;
          color: rgba(255,255,255,0.65);
          font-size: 11px;
          cursor: pointer;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: border-color 0.15s, color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.12s;
        }
        .clark-chip:hover {
          border-color: rgba(139,92,246,0.32);
          color: #a78bfa;
          background: rgba(139,92,246,0.08);
          box-shadow: 0 0 8px rgba(139,92,246,0.14), 0 0 5px rgba(236,72,153,0.07);
          transform: translateY(-1px);
        }
        .clark-box-input::placeholder { color: rgba(255,255,255,0.40); }
      `}</style>

      <section
        style={{
          paddingTop: '64px',
          paddingBottom: '28px',
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
            gap: '7px',
            background: 'rgba(45,212,191,0.07)',
            border: '1px solid rgba(45,212,191,0.16)',
            borderRadius: '100px',
            padding: '5px 12px',
            marginBottom: '20px',
          }}
        >
          <div
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#2DD4BF',
              animation: 'liveBlink 2.5s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF' }}>
            LIVE
          </span>
          <span style={{ fontSize: '9px', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.28)' }}>
            • POWERED BY CORTEX ENGINE
          </span>
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: 'clamp(30px, 4.2vw, 52px)',
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: '-0.025em',
            marginBottom: '16px',
            maxWidth: '720px',
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
            fontSize: '14px',
            lineHeight: 1.6,
            color: 'rgba(255,255,255,0.38)',
            maxWidth: '460px',
            marginBottom: '14px',
            fontFamily: 'var(--font-inter)',
            fontWeight: 400,
          }}
        >
          Track smart money, scan wallets, detect pumps, and discover Base
          opportunities in real time.
        </p>

        {/* Command box wrapper */}
        <div style={{ width: '100%', maxWidth: '580px', position: 'relative' }}>

          {/* Ambient glow */}
          <div
            style={{
              position: 'absolute',
              inset: '-48px',
              background: 'radial-gradient(ellipse 62% 52% at 50% 58%, rgba(236,72,153,0.10) 0%, rgba(139,92,246,0.10) 45%, transparent 100%)',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />

          {/* Gradient border wrapper — pink → purple → mint */}
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              padding: '1.5px',
              borderRadius: '17px',
              background: 'linear-gradient(135deg, rgba(236,72,153,0.55) 0%, rgba(139,92,246,0.55) 50%, rgba(45,212,191,0.40) 100%)',
              boxShadow: [
                '0 0 18px rgba(236,72,153,0.10)',
                '0 0 14px rgba(139,92,246,0.10)',
                '0 20px 60px rgba(0,0,0,0.60)',
              ].join(', '),
            }}
          >
            {/* Card */}
            <div
              style={{
                background: 'linear-gradient(160deg, #0c1828 0%, #080f1c 50%, #060b16 100%)',
                borderRadius: '16px',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                overflow: 'hidden',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.03) inset, 0 1px 0 rgba(255,255,255,0.06) inset',
              }}
            >
              {/* Top gradient accent line */}
              <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent, rgba(236,72,153,0.45), rgba(139,92,246,0.45), rgba(45,212,191,0.35), transparent)' }} />

              <div style={{ padding: '18px' }}>
                {/* Input row */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    background: 'rgba(5,8,22,0.60)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: '11px',
                    padding: '8px 8px 8px 12px',
                    marginBottom: '10px',
                    backdropFilter: 'blur(24px)',
                    WebkitBackdropFilter: 'blur(24px)',
                    boxShadow: 'inset 0 0 18px rgba(236,72,153,0.06), inset 0 0 12px rgba(45,212,191,0.05), inset 0 1px 0 rgba(255,255,255,0.06)',
                  }}
                >
                  {/* Sparkle orb */}
                  <div
                    style={{
                      width: '30px',
                      height: '30px',
                      borderRadius: '8px',
                      background: 'linear-gradient(135deg, rgba(139,92,246,0.28), rgba(236,72,153,0.16))',
                      border: '1px solid rgba(139,92,246,0.30)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      boxShadow: '0 0 10px rgba(139,92,246,0.18)',
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2L9.2 6.8H14L10.4 9.4L11.6 14L8 11.4L4.4 14L5.6 9.4L2 6.8H6.8L8 2Z" fill="#a78bfa"/>
                    </svg>
                  </div>

                  {/* Input */}
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      onTyping?.(e.target.value.length > 0)
                    }}
                    onBlur={() => { if (!query) onTyping?.(false) }}
                    placeholder="Ask Clark what whales are buying today..."
                    className="clark-box-input"
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#e2e8f0',
                      fontSize: '13px',
                      fontFamily: 'var(--font-inter)',
                      caretColor: '#a78bfa',
                    }}
                  />

                  {/* Send button */}
                  <button
                    className="clark-send-btn"
                    style={{
                      flexShrink: 0,
                      width: '34px',
                      height: '34px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
                      border: '1px solid rgba(236,72,153,0.50)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <span className="clark-send-arrow" style={{ color: '#fff', fontSize: '14px', lineHeight: 1 }}>→</span>
                  </button>
                </div>

                {/* Chips — 2 centered */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    gap: '5px',
                    marginBottom: '14px',
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
                    gap: '6px',
                    paddingTop: '12px',
                    borderTop: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  {STATS.map((stat, i) => (
                    <>
                      {i > 0 && (
                        <span key={`sep-${i}`} style={{ color: 'rgba(255,255,255,0.12)', fontSize: '10px' }}>•</span>
                      )}
                      <div key={stat.label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {stat.icon}
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.38)', fontFamily: 'var(--font-inter)', letterSpacing: '0.01em' }}>
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
