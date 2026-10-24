'use client'

import { useState } from 'react'
import { QUICK_PROMPTS } from '@/lib/clark/knowledge'
import ClarkOrb from '@/components/ClarkOrb'

const CHIPS = QUICK_PROMPTS.heroChips


interface HeroSectionProps {
  onTyping?: (typing: boolean) => void
  onSend?: (text: string) => void
}

export default function HeroSection({ onTyping, onSend }: HeroSectionProps) {
  const [query, setQuery] = useState('')
  const [sendClicks, setSendClicks] = useState(0)
  const [lastAction, setLastAction] = useState('idle')
  const [mobileRedirectArmed, setMobileRedirectArmed] = useState(false)

  const isMobile = () => typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
  const debugClark = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debugClark') === 'true'
  const debugLog = (event: string, meta?: Record<string, unknown>) => {
    if (!debugClark()) return
    console.info(event, meta ?? {})
  }

  const handleHeroSend = (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.()
    const prompt = query.trim()
    setSendClicks(c => c + 1)
    setLastAction('send_click')
    debugLog('hero_send_button_clicked')
    debugLog('hero_clark_prompt_length', { length: prompt.length })
    if (isMobile()) {
      setMobileRedirectArmed(true)
      const next = prompt
        ? `/terminal/clark-ai?prompt=${encodeURIComponent(prompt)}&autosend=1`
        : '/terminal/clark-ai'
      window.location.href = next
      return
    }
    if (prompt && onSend) {
      debugLog('hero_desktop_onSend_called', { prompt: prompt.slice(0, 80) })
      onSend(prompt)
      setQuery('')
      onTyping?.(false)
      return
    }
    if (prompt) {
      setQuery('')
      onTyping?.(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes liveBlink {
          0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(31,214,220,0.90); }
          50%       { opacity: 0.35; box-shadow: 0 0 3px rgba(31,214,220,0.25); }
        }
        @keyframes heroBlobMint {
          0%, 100% { transform: translate(0px, 0px) scale(1); }
          30%       { transform: translate(28px, -18px) scale(1.06); }
          65%       { transform: translate(-18px, 22px) scale(0.96); }
        }
        @keyframes sendGlowPulse {
          0%, 100% { box-shadow: 0 0 0 3px rgba(31,214,220,0.06), 0 0 12px rgba(31,214,220,0.22); }
          50%       { box-shadow: 0 0 0 3px rgba(31,214,220,0.08), 0 0 20px rgba(31,214,220,0.36); }
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
          transform: translateY(-1px);
          border-color: #6ff3f3 !important;
          box-shadow: 0 0 0 3px rgba(31,214,220,0.10), 0 0 26px rgba(31,214,220,0.45) !important;
          animation: none;
        }
        .clark-send-arrow { animation: arrowPulse 2.5s ease-in-out infinite; display: inline-block; }
        @keyframes taglineFadeUp {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .clark-tagline {
          animation: taglineFadeUp 300ms ease-out 200ms both;
          transition: opacity 0.25s ease;
        }
        .clark-tagline:hover { opacity: 0.85; }
        .clark-chip {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 8px;
          padding: 6px 20px;
          color: rgba(220,226,230,0.86);
          font-size: 11px;
          cursor: pointer;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          transition: border-color 0.15s, color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.12s;
        }
        .clark-chip:hover {
          border-color: rgba(31,214,220,0.36);
          color: #dff8f9;
          background: rgba(31,214,220,0.06);
          transform: translateY(-1px);
        }
        .clark-box-input::placeholder { color: rgba(255,255,255,0.40); }
        /* Hide expensive GPU layers on mobile */
        @media (max-width: 767px) {
          .hero-blob { display: none !important; }
          .hero-card-blur { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
          .hero-input-blur { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .clark-orb, .clark-send-btn, .clark-send-arrow { animation: none !important; }
        }
      `}</style>

      <section
        style={{
          paddingTop: '52px',
          paddingBottom: '20px',
          paddingLeft: '24px',
          paddingRight: '24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* ── Gradient mesh blobs ── */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {/* Mint blob — top-left */}
          <div className="hero-blob" style={{
            position: 'absolute',
            top: '-40px',
            left: '-60px',
            width: '420px',
            height: '320px',
            borderRadius: '50%',
            background: 'rgba(31,214,220,0.06)',
            filter: 'blur(110px)',
            animation: 'heroBlobMint 26s ease-in-out infinite',
          }} />
          {/* Thin silver / mint wave strands at the edges (static), echoing the homepage hero. */}
          <svg className="hero-blob" width="100%" height="100%" viewBox="0 0 900 520" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, opacity: 0.6 }}>
            <path d="M-20 300 C 140 230, 220 380, 380 330" stroke="rgba(31,214,220,0.32)" strokeWidth="1" fill="none" />
            <path d="M-20 312 C 140 246, 220 392, 380 344" stroke="rgba(205,213,218,0.10)" strokeWidth="1" fill="none" />
            <path d="M-20 324 C 140 262, 220 404, 380 358" stroke="rgba(205,213,218,0.08)" strokeWidth="1" fill="none" />
            <path d="M-20 336 C 140 278, 220 416, 380 372" stroke="rgba(205,213,218,0.06)" strokeWidth="1" fill="none" />
            <path d="M920 150 C 780 110, 700 240, 540 190" stroke="rgba(31,214,220,0.28)" strokeWidth="1" fill="none" />
            <path d="M920 162 C 780 126, 700 254, 540 204" stroke="rgba(205,213,218,0.09)" strokeWidth="1" fill="none" />
            <path d="M920 174 C 780 142, 700 268, 540 218" stroke="rgba(205,213,218,0.07)" strokeWidth="1" fill="none" />
            <path d="M920 186 C 780 158, 700 282, 540 232" stroke="rgba(205,213,218,0.05)" strokeWidth="1" fill="none" />
          </svg>
        </div>

        {/* ── Content (above blobs) ── */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>

        {/* LIVE badge */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '7px',
            background: 'linear-gradient(180deg, rgba(22,24,26,0.7), rgba(8,9,10,0.8))',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: '100px',
            padding: '5px 12px',
            marginBottom: '16px',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
          }}
        >
          <div
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#1fd6dc',
              animation: 'liveBlink 2.5s ease-in-out infinite',
            }}
          />
          <span style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '0.14em', color: '#1fd6dc' }}>
            LIVE
          </span>
          <span style={{ fontSize: '9px', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.1em', color: 'rgba(196,204,210,0.55)' }}>
            • POWERED BY CORTEX ENGINE
          </span>
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: 'clamp(26px, 3.6vw, 46px)',
            fontWeight: 800,
            lineHeight: 1.06,
            letterSpacing: '-0.02em',
            marginBottom: '14px',
            maxWidth: '720px',
            fontFamily: "var(--font-sora, 'Sora', sans-serif)",
            filter: 'drop-shadow(0 2px 14px rgba(0,0,0,0.6))',
          }}
        >
          <span style={{ color: '#f4f6f7' }}>See the Market</span>
          <br />
          <span style={{ color: '#1fd6dc' }}>
            Before It Moves
          </span>
        </h1>

        {/* Subheadline */}
        <p
          style={{
            fontSize: '14px',
            lineHeight: 1.6,
            color: 'rgba(196,204,210,0.72)',
            maxWidth: '460px',
            marginBottom: '10px',
            fontFamily: 'var(--font-inter)',
            fontWeight: 400,
          }}
        >
          Track smart money, scan wallets, detect pumps, and discover Base
          opportunities in real time.
        </p>

        {/* Supporting tagline */}
        <p
          className="clark-tagline"
          style={{
            fontSize: '12px',
            color: 'rgba(196,204,210,0.5)',
            fontFamily: 'var(--font-inter)',
            fontWeight: 400,
            letterSpacing: '0.01em',
            marginBottom: '16px',
          }}
        >
          Clark processes the data. You press the buttons.
        </p>

        {/* Command box wrapper */}
        <div style={{ width: '100%', maxWidth: '580px', position: 'relative' }}>

          {/* Ambient glow */}
          <div
            style={{
              position: 'absolute',
              inset: '-48px',
              background: 'radial-gradient(ellipse 62% 52% at 50% 58%, rgba(31,214,220,0.05) 0%, transparent 100%)',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />

          {/* Hairline silver border */}
          <div
            style={{
              position: 'relative',
              zIndex: 1,
              padding: '1.5px',
              borderRadius: '17px',
              background: 'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.06) 100%)',
              boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(31,214,220,0.04)',
            }}
          >
            {/* Card */}
            <div
              className="hero-card-blur"
              style={{
                background: 'linear-gradient(180deg, #141618 0%, #0a0b0c 100%)',
                borderRadius: '16px',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                overflow: 'hidden',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.03) inset, 0 1px 0 rgba(255,255,255,0.06) inset',
              }}
            >
              {/* Top gradient accent line */}
              <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent 12%, rgba(98,241,241,0.55) 50%, transparent 88%)' }} />

              <div style={{ padding: '18px' }}>
                {/* Input row */}
                <div
                  className="hero-input-blur"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    background: '#050606',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: '11px',
                    padding: '8px 8px 8px 12px',
                    marginBottom: '10px',
                    backdropFilter: 'blur(24px)',
                    WebkitBackdropFilter: 'blur(24px)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                  }}
                >
                  <ClarkOrb size={30} className="clark-orb" style={{ flexShrink: 0 }} />

                  {/* Input */}
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setLastAction('input_change')
                      debugLog('hero_input_change', { prompt: e.target.value.slice(0, 80) })
                      onTyping?.(e.target.value.length > 0)
                    }}
                    onBlur={() => { if (!query) onTyping?.(false) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        setLastAction('enter_pressed')
                        debugLog('hero_enter_pressed')
                        handleHeroSend(e)
                      }
                    }}
                    placeholder="Ask Clark what whales are buying today..."
                    className="clark-box-input"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#e9edef',
                      fontSize: '16px',
                      fontFamily: 'var(--font-inter)',
                      caretColor: '#1fd6dc',
                    }}
                  />

                  {/* Send button */}
                  <button
                    className="clark-send-btn"
                    type="button"
                    onClick={(e) => {
                      handleHeroSend(e)
                    }}
                    style={{
                      flexShrink: 0,
                      width: '34px',
                      height: '34px',
                      borderRadius: '10px',
                      background: 'radial-gradient(120% 150% at 50% -10%, rgba(92,240,240,0.30) 0%, rgba(31,214,220,0.08) 50%, rgba(3,9,10,0.92) 100%)',
                      border: '1.5px solid #2ad8df',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <span className="clark-send-arrow" style={{ color: '#fff', fontSize: '14px', lineHeight: 1 }}>→</span>
                  </button>
                </div>


                {debugClark() && (
                  <div style={{ marginBottom: '10px', border: '1px solid rgba(31,214,220,0.35)', borderRadius: '10px', padding: '10px', background: 'rgba(3,4,4,0.9)', textAlign: 'left' }}>
                    <div style={{ fontSize: '11px', color: '#a9b2b8' }}>inputValue: <span style={{ color: '#e9edef' }}>{query || '∅'}</span></div>
                    <div style={{ fontSize: '11px', color: '#a9b2b8' }}>sendClicks: <span style={{ color: '#e9edef' }}>{sendClicks}</span></div>
                    <div style={{ fontSize: '11px', color: '#a9b2b8' }}>lastAction: <span style={{ color: '#e9edef' }}>{lastAction}</span></div>
                    <div style={{ fontSize: '11px', color: '#a9b2b8' }}>isMobile: <span style={{ color: '#e9edef' }}>{String(isMobile())}</span></div>
                    <div style={{ fontSize: '11px', color: '#a9b2b8' }}>mobileRedirectArmed: <span style={{ color: '#e9edef' }}>{mobileRedirectArmed ? 'yes' : 'no'}</span></div>
                  </div>
                )}

                {/* Chips — 2 centered */}
                <div
                  className="clark-chip-row"
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    flexWrap: 'wrap',
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

                {/* Info footer */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '7px',
                    paddingTop: '12px',
                    borderTop: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'rgba(31,214,220,0.80)', boxShadow: '0 0 5px rgba(31,214,220,0.55)', flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: 'rgba(196,204,210,0.48)', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.07em' }}>
                    POWERED BY CORTEX ENGINE&nbsp;&nbsp;•&nbsp;&nbsp;LIVE BASE DATA
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        </div>{/* end content wrapper */}

        {/* Base-themed accent line under hero */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: '10%',
          right: '10%',
          height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.10), rgba(31,214,220,0.14), rgba(255,255,255,0.10), transparent)',
          pointerEvents: 'none',
          zIndex: 1,
        }} />
      </section>
    </>
  )
}
