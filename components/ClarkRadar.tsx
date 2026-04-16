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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Header ──────────────────────────────────────── */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 18px',
          height: '56px',
          background: '#0a0d16',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        {/* Left — icon + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '9px',
              background: 'linear-gradient(135deg, rgba(139,92,246,0.28), rgba(45,212,191,0.18))',
              border: '1px solid rgba(139,92,246,0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 12px rgba(139,92,246,0.22)',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 2L9.2 6.8H14L10.4 9.4L11.6 14L8 11.4L4.4 14L5.6 9.4L2 6.8H6.8L8 2Z" fill="#a78bfa"/>
            </svg>
          </div>
          <span
            style={{
              fontSize: '14px',
              fontWeight: 700,
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
            gap: '6px',
            background: 'rgba(45,212,191,0.07)',
            border: '1px solid rgba(45,212,191,0.18)',
            borderRadius: '100px',
            padding: '4px 10px',
          }}
        >
          <div
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#2DD4BF',
              boxShadow: '0 0 6px rgba(45,212,191,0.9)',
              animation: 'clarkOnlinePulse 3s ease-in-out infinite',
            }}
          />
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: '#2DD4BF',
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
          padding: '24px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
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
            padding: '40px 16px',
            gap: '16px',
          }}
        >
          {/* Orb */}
          <div
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(45,212,191,0.12))',
              border: '1px solid rgba(139,92,246,0.28)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 24px rgba(139,92,246,0.18), 0 0 8px rgba(45,212,191,0.1)',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
              <path d="M8 2L9.2 6.8H14L10.4 9.4L11.6 14L8 11.4L4.4 14L5.6 9.4L2 6.8H6.8L8 2Z" fill="#a78bfa"/>
            </svg>
          </div>

          <div>
            <p
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'rgba(255,255,255,0.65)',
                fontFamily: 'var(--font-inter)',
                marginBottom: '8px',
                lineHeight: 1.5,
              }}
            >
              Ask Clark anything about wallets,<br />
              smart money, tokens, or market moves.
            </p>
            <p
              style={{
                fontSize: '11px',
                color: 'rgba(255,255,255,0.28)',
                fontFamily: 'var(--font-inter)',
                lineHeight: 1.6,
              }}
            >
              Responses will appear here
            </p>
          </div>

          {/* Hint chips */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              width: '100%',
              marginTop: '8px',
            }}
          >
            {HINT_CHIPS.map((chip) => (
              <button
                key={chip}
                onClick={() => setInput(chip)}
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: '9px',
                  padding: '9px 12px',
                  color: 'rgba(255,255,255,0.45)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-inter)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'border-color 0.15s, color 0.15s, background 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.borderColor = 'rgba(139,92,246,0.28)'
                  el.style.color       = 'rgba(255,255,255,0.75)'
                  el.style.background  = 'rgba(139,92,246,0.06)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.borderColor = 'rgba(255,255,255,0.07)'
                  el.style.color       = 'rgba(255,255,255,0.45)'
                  el.style.background  = 'rgba(255,255,255,0.03)'
                }}
              >
                <span style={{ color: 'rgba(139,92,246,0.6)', fontSize: '12px', flexShrink: 0 }}>→</span>
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
          padding: '12px 14px 16px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          background: '#0a0d16',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: '12px',
            padding: '9px 9px 9px 13px',
          }}
        >
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask Clark..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#e2e8f0',
              fontSize: '13px',
              fontFamily: 'var(--font-inter)',
              caretColor: '#a78bfa',
              minWidth: 0,
            }}
          />
          <button
            style={{
              flexShrink: 0,
              width: '30px',
              height: '30px',
              borderRadius: '8px',
              background: input.trim()
                ? 'linear-gradient(135deg, #8b5cf6, #7c3aed)'
                : 'rgba(255,255,255,0.05)',
              border: input.trim()
                ? '1px solid rgba(139,92,246,0.5)'
                : '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: input.trim() ? 'pointer' : 'default',
              transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
              boxShadow: input.trim() ? '0 0 14px rgba(139,92,246,0.35)' : 'none',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke={input.trim() ? '#fff' : 'rgba(255,255,255,0.25)'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <p
          style={{
            marginTop: '8px',
            fontSize: '10px',
            color: 'rgba(255,255,255,0.18)',
            fontFamily: 'var(--font-plex-mono)',
            textAlign: 'center',
            letterSpacing: '0.08em',
          }}
        >
          POWERED BY CORTEX ENGINE
        </p>
      </div>

      {/* Keyframe for online dot */}
      <style>{`
        @keyframes clarkOnlinePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(45,212,191,0.9); }
          50%       { opacity: 0.5; box-shadow: 0 0 3px rgba(45,212,191,0.4); }
        }
      `}</style>

    </div>
  )
}
