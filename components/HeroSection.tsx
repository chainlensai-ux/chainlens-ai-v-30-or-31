'use client'

import { useState } from 'react'

const CHIPS = [
  'Scan a Base token',
  'Check wallet behavior',
  'Explain liquidity risk',
  'What can Clark do?',
]


interface HeroSectionProps {
  onTyping?: (typing: boolean) => void
  onSend?: (text: string) => void
}

export default function HeroSection({ onTyping, onSend }: HeroSectionProps) {
  const [query, setQuery] = useState('')
  const [sendClicks, setSendClicks] = useState(0)
  const [lastAction, setLastAction] = useState('idle')
  const [drawerEventDispatched, setDrawerEventDispatched] = useState(false)

  const isMobile = () => typeof window !== 'undefined' && window.innerWidth < 768
  const debugClark = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debugClark') === 'true'
  const debugLog = (event: string, meta?: Record<string, unknown>) => {
    if (!debugClark()) return
    console.info(event, meta ?? {})
  }

  const openDrawer = (prompt: string, autoSend = false) => {
    if (typeof window === 'undefined') return
    debugLog('hero_dispatch_chainlens_open_clark', { prompt: prompt.slice(0, 80), autoSend })
    window.dispatchEvent(new CustomEvent('chainlens:open-clark', { detail: { prompt, autoSend, source: 'hero' } }))
    setDrawerEventDispatched(true)
  }

  const handleHeroSend = (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.()
    const prompt = query.trim()
    setSendClicks(c => c + 1)
    setLastAction('send_click')
    debugLog('hero_send_button_clicked')
    debugLog('hero_clark_prompt_length', { length: prompt.length })
    if (isMobile()) {
      debugLog('mobile_drawer_open_requested')
      debugLog('mobile_drawer_send_requested', { autoSend: prompt.length > 0 })
      openDrawer(prompt, prompt.length > 0)
      if (prompt) {
        setQuery('')
        onTyping?.(false)
      }
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
      openDrawer(prompt, true)
      setQuery('')
      onTyping?.(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes liveBlink {
          0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(45,212,191,0.90); }
          50%       { opacity: 0.35; box-shadow: 0 0 3px rgba(45,212,191,0.25); }
        }
        @keyframes heroBlobMint {
          0%, 100% { transform: translate(0px, 0px) scale(1); }
          30%       { transform: translate(28px, -18px) scale(1.06); }
          65%       { transform: translate(-18px, 22px) scale(0.96); }
        }
        @keyframes heroBlobPink {
          0%, 100% { transform: translate(0px, 0px) scale(1); }
          40%       { transform: translate(-24px, 16px) scale(1.04); }
          75%       { transform: translate(20px, -14px) scale(0.97); }
        }
        @keyframes heroBlobPurple {
          0%, 100% { transform: translate(0px, 0px) scale(1); }
          50%       { transform: translate(16px, 24px) scale(1.05); }
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
          <div style={{
            position: 'absolute',
            top: '-40px',
            left: '-60px',
            width: '420px',
            height: '320px',
            borderRadius: '50%',
            background: 'rgba(45,212,191,0.10)',
            filter: 'blur(110px)',
            animation: 'heroBlobMint 26s ease-in-out infinite',
          }} />
          {/* Pink blob — bottom-right */}
          <div style={{
            position: 'absolute',
            bottom: '-30px',
            right: '-50px',
            width: '360px',
            height: '280px',
            borderRadius: '50%',
            background: 'rgba(236,72,153,0.08)',
            filter: 'blur(100px)',
            animation: 'heroBlobPink 32s ease-in-out infinite',
          }} />
          {/* Purple blob — center */}
          <div style={{
            position: 'absolute',
            top: '30%',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '400px',
            height: '260px',
            borderRadius: '50%',
            background: 'rgba(139,92,246,0.07)',
            filter: 'blur(120px)',
            animation: 'heroBlobPurple 22s ease-in-out infinite',
          }} />
        </div>

        {/* ── Content (above blobs) ── */}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>

        {/* LIVE badge */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '7px',
            background: 'rgba(45,212,191,0.07)',
            border: '1px solid rgba(45,212,191,0.18)',
            borderRadius: '100px',
            padding: '5px 12px',
            marginBottom: '16px',
            boxShadow: '0 0 16px rgba(45,212,191,0.14), inset 0 0 10px rgba(139,92,246,0.06)',
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
          <span style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)', fontWeight: 700, letterSpacing: '0.14em', color: '#2DD4BF', textShadow: '0 0 8px rgba(45,212,191,0.80)' }}>
            LIVE
          </span>
          <span style={{ fontSize: '9px', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.28)' }}>
            • POWERED BY CORTEX ENGINE
          </span>
        </div>

        {/* Headline */}
        <h1
          style={{
            fontSize: 'clamp(25px, 3.5vw, 44px)',
            fontWeight: 600,
            lineHeight: 1.04,
            letterSpacing: '-0.015em',
            marginBottom: '14px',
            maxWidth: '720px',
            fontFamily: 'var(--font-inter)',
            filter: 'drop-shadow(0 2px 20px rgba(139,92,246,0.24))',
          }}
        >
          <span style={{ color: '#ffffff' }}>See the </span>
          <span style={{ color: '#2DD4BF' }}>Market</span>
          <br />
          <span style={{ background: 'linear-gradient(95deg, #a274f8 0%, #e968b0 55%, #f472b6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
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
            color: 'rgba(255,255,255,0.28)',
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
              background: 'radial-gradient(ellipse 62% 52% at 50% 58%, rgba(236,72,153,0.07) 0%, rgba(139,92,246,0.07) 45%, transparent 100%)',
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
              background: 'linear-gradient(135deg, rgba(236,72,153,0.38) 0%, rgba(139,92,246,0.38) 50%, rgba(45,212,191,0.28) 100%)',
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
                    background: 'linear-gradient(135deg, rgba(5,8,22,0.65) 0%, rgba(45,212,191,0.04) 55%, rgba(139,92,246,0.03) 100%)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: '11px',
                    padding: '8px 8px 8px 12px',
                    marginBottom: '10px',
                    backdropFilter: 'blur(24px)',
                    WebkitBackdropFilter: 'blur(24px)',
                    boxShadow: 'inset 0 0 20px rgba(45,212,191,0.08), inset 0 0 14px rgba(236,72,153,0.06), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 16px rgba(139,92,246,0.10), 0 0 8px rgba(45,212,191,0.06)',
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
                    <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#a78bfa', boxShadow: '0 0 8px rgba(139,92,246,0.70)' }} />
                  </div>

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
                    onFocus={() => { if (isMobile()) { debugLog('hero_clark_focus'); openDrawer(query.trim(), false) } }}
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
                    type="button"
                    onClick={(e) => {
                      handleHeroSend(e)
                    }}
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


                {debugClark() && (
                  <div style={{ marginBottom: '10px', border: '1px solid rgba(45,212,191,0.35)', borderRadius: '10px', padding: '10px', background: 'rgba(2,6,23,0.9)', textAlign: 'left' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>inputValue: <span style={{ color: '#e2e8f0' }}>{query || '∅'}</span></div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>sendClicks: <span style={{ color: '#e2e8f0' }}>{sendClicks}</span></div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>lastAction: <span style={{ color: '#e2e8f0' }}>{lastAction}</span></div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>isMobile: <span style={{ color: '#e2e8f0' }}>{String(isMobile())}</span></div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>drawerEventDispatched: <span style={{ color: '#e2e8f0' }}>{drawerEventDispatched ? 'yes' : 'no'}</span></div>
                    <button type="button" onClick={() => openDrawer('debug hello', false)} style={{ marginTop: '8px', fontSize: '11px', color: '#67e8f9', border: '1px solid rgba(103,232,249,0.4)', borderRadius: '8px', padding: '6px 10px', background: 'rgba(8,12,24,0.9)' }}>Test dispatch Clark event</button>
                  </div>
                )}

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
                  <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'rgba(45,212,191,0.80)', boxShadow: '0 0 5px rgba(45,212,191,0.55)', flexShrink: 0 }} />
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.30)', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.07em' }}>
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
          background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.10), rgba(139,92,246,0.10), transparent)',
          pointerEvents: 'none',
          zIndex: 1,
        }} />
      </section>
    </>
  )
}
