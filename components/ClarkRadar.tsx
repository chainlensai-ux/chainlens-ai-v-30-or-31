'use client'

import { useState } from 'react'

const HINT_CHIPS = [
  'What are whales buying?',
  'Scan a wallet',
  'Trending on Base',
  'Top pump signals',
]

export default function ClarkRadar({ onSelectRadar }: { onSelectRadar?: (val: string) => void }) {
  const [input, setInput] = useState('')

  return (
    <>
      <style>{`
        @keyframes clarkOnlinePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(139,92,246,0.9); }
          50%       { opacity: 0.5; box-shadow: 0 0 3px rgba(139,92,246,0.4); }
        }
        @keyframes clarkPanelGlow {
          0%, 100% {
            box-shadow:
              inset 0 0 50px rgba(139,92,246,0.09),
              inset 0 0 26px rgba(236,72,153,0.05);
          }
          50% {
            box-shadow:
              inset 0 0 80px rgba(139,92,246,0.18),
              inset 0 0 42px rgba(236,72,153,0.10);
          }
        }
        .clark-panel-glow {
          animation: clarkPanelGlow 4s ease-in-out infinite;
        }
        .clark-hint-chip {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 7px 10px;
          color: rgba(255,255,255,0.40);
          font-size: 11px;
          font-family: var(--font-inter);
          cursor: pointer;
          text-align: left;
          display: flex;
          align-items: center;
          gap: 7px;
          width: 100%;
          transition: border-color 0.15s, color 0.15s, background 0.15s, box-shadow 0.15s;
        }
        .clark-hint-chip:hover {
          border-color: rgba(139,92,246,0.32);
          color: rgba(255,255,255,0.80);
          background: rgba(139,92,246,0.08);
          box-shadow: 0 0 10px rgba(139,92,246,0.12), 0 0 6px rgba(236,72,153,0.06);
        }
        .clark-panel-input::placeholder { color: rgba(255,255,255,0.40); }
      `}</style>

      <div
        className="clark-panel-glow"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          background: 'rgba(5,8,22,0.72)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
      >
        {/* Top gradient accent line */}
        <div
          style={{
            height: '1.5px',
            background: 'linear-gradient(90deg, transparent 0%, #ff4b9a 25%, #7b5cff 55%, #4ef2c5 80%, transparent 100%)',
            flexShrink: 0,
          }}
        />

        {/* ── Header ──────────────────────────────────────── */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            height: '48px',
            background: 'rgba(8,10,20,0.90)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}
        >
          {/* Left — icon + title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
            <div
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, rgba(236,72,153,0.25), rgba(139,92,246,0.30))',
                border: '1px solid rgba(139,92,246,0.40)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 12px rgba(139,92,246,0.24), 0 0 5px rgba(236,72,153,0.10)',
                flexShrink: 0,
              }}
            >
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 7px rgba(45,212,191,0.75)' }} />
            </div>
            <span
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#f1f5f9',
                fontFamily: 'var(--font-inter)',
                letterSpacing: '-0.01em',
              }}
            >
              Clark AI
            </span>
          </div>

          {/* Right — Online badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              background: 'rgba(139,92,246,0.09)',
              border: '1px solid rgba(139,92,246,0.22)',
              borderRadius: '100px',
              padding: '3px 9px',
            }}
          >
            <div
              style={{
                width: '5px',
                height: '5px',
                borderRadius: '50%',
                background: '#a78bfa',
                animation: 'clarkOnlinePulse 3s ease-in-out infinite',
              }}
            />
            <span
              style={{
                fontSize: '9px',
                fontWeight: 700,
                letterSpacing: '0.10em',
                color: '#a78bfa',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              ONLINE
            </span>
          </div>
        </div>

        {/* ── Messages area ───────────────────────────────── */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {/* Empty state */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: '24px 12px',
              gap: '10px',
            }}
          >
            {/* Orb */}
            <div
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '14px',
                background: 'linear-gradient(135deg, rgba(236,72,153,0.18), rgba(139,92,246,0.22))',
                border: '1px solid rgba(139,92,246,0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 22px rgba(139,92,246,0.18), 0 0 10px rgba(236,72,153,0.10)',
              }}
            >
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#2DD4BF', boxShadow: '0 0 10px rgba(45,212,191,0.65)' }} />
            </div>

            <div>
              <p
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  color: 'rgba(255,255,255,0.55)',
                  fontFamily: 'var(--font-inter)',
                  marginBottom: '6px',
                  lineHeight: 1.5,
                }}
              >
                Ask Clark anything about wallets,<br />
                smart money, tokens, or market moves.
              </p>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.24)', fontFamily: 'var(--font-inter)', lineHeight: 1.6 }}>
                Responses will appear here
              </p>
            </div>

            {/* Hint chips */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%', marginTop: '6px' }}>
              {HINT_CHIPS.map((chip) => (
                <button
                  key={chip}
                  className="clark-hint-chip"
                  onClick={() => setInput(chip)}
                >
                  <span style={{ color: 'rgba(192,132,252,0.65)', fontSize: '11px', flexShrink: 0 }}>→</span>
                  {chip}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Input footer ────────────────────────────────── */}
        <div
          style={{
            flexShrink: 0,
            padding: '8px 12px 12px',
            borderTop: '1px solid rgba(139,92,246,0.12)',
            background: 'rgba(8,10,20,0.80)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              background: 'rgba(5,8,22,0.60)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '11px',
              padding: '7px 7px 7px 12px',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              boxShadow: 'inset 0 0 16px rgba(139,92,246,0.07), inset 0 0 10px rgba(236,72,153,0.04), inset 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask Clark..."
              className="clark-panel-input"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#e2e8f0',
                fontSize: '12px',
                fontFamily: 'var(--font-inter)',
                caretColor: '#a78bfa',
                minWidth: 0,
              }}
            />
            <button
              style={{
                flexShrink: 0,
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: input.trim()
                  ? 'linear-gradient(135deg, #ec4899, #8b5cf6)'
                  : 'rgba(255,255,255,0.05)',
                border: input.trim()
                  ? '1px solid rgba(236,72,153,0.40)'
                  : '1px solid rgba(255,255,255,0.07)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: input.trim() ? 'pointer' : 'default',
                transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.12s',
                boxShadow: input.trim()
                  ? '0 0 12px rgba(139,92,246,0.35), 0 0 5px rgba(236,72,153,0.18)'
                  : 'none',
              }}
              onMouseEnter={e => {
                if (input.trim()) {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.transform = 'scale(1.10)'
                  el.style.boxShadow = '0 0 20px rgba(139,92,246,0.55), 0 0 10px rgba(236,72,153,0.30)'
                }
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLButtonElement
                el.style.transform = 'scale(1)'
                el.style.boxShadow = input.trim()
                  ? '0 0 12px rgba(139,92,246,0.35), 0 0 5px rgba(236,72,153,0.18)'
                  : 'none'
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke={input.trim() ? '#fff' : 'rgba(255,255,255,0.22)'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <p
            style={{
              marginTop: '6px',
              fontSize: '9px',
              color: 'rgba(255,255,255,0.15)',
              fontFamily: 'var(--font-plex-mono)',
              textAlign: 'center',
              letterSpacing: '0.08em',
            }}
          >
            POWERED BY CORTEX ENGINE
          </p>
        </div>

      </div>
    </>
  )
}
