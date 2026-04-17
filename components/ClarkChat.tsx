'use client'

import HeroSection from '@/components/HeroSection'
import HomeTokenScreener from '@/components/HomeTokenScreener'

interface ClarkChatProps {
  active: string | null
  onTyping?: (typing: boolean) => void
}

export default function ClarkChat({ active, onTyping }: ClarkChatProps) {
  return (
    <>
      <style>{`
        @keyframes terminalDotBlink {
          0%, 100% { opacity: 1; box-shadow: 0 0 7px rgba(78,242,197,0.95); }
          50%       { opacity: 0.35; box-shadow: 0 0 3px rgba(78,242,197,0.3); }
        }
        @keyframes terminalHeaderGlow {
          0%, 100% { box-shadow: 0 1px 24px rgba(123,92,255,0.10), 0 1px 8px rgba(255,75,154,0.06); }
          50%       { box-shadow: 0 1px 36px rgba(123,92,255,0.20), 0 1px 14px rgba(255,75,154,0.12); }
        }
        .terminal-header-bar {
          animation: terminalHeaderGlow 4s ease-in-out infinite;
        }
      `}</style>

      <div className="flex-1 flex flex-col" style={{ background: '#050816' }}>

        {/* ── Terminal header bar ─────────────────────── */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            flexShrink: 0,
          }}
        >
          {/* Gradient accent line — pink → purple → mint */}
          <div
            style={{
              height: '1.5px',
              background:
                'linear-gradient(90deg, transparent 0%, #ff4b9a 25%, #7b5cff 55%, #4ef2c5 80%, transparent 100%)',
            }}
          />

          {/* Header row */}
          <div
            className="terminal-header-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '0 24px',
              height: '44px',
              background: 'rgba(5,8,22,0.94)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              borderBottom: '1px solid rgba(123,92,255,0.13)',
            }}
          >
            {/* Mint status dot */}
            <div
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#4ef2c5',
                flexShrink: 0,
                animation: 'terminalDotBlink 3s ease-in-out infinite',
              }}
            />

            {/* LIVE — pink */}
            <span
              style={{
                fontSize: '10px',
                fontWeight: 800,
                letterSpacing: '0.20em',
                color: '#ff4b9a',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              LIVE
            </span>

            {/* Separator */}
            <span
              style={{
                fontSize: '12px',
                color: 'rgba(255,255,255,0.18)',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              /
            </span>

            {/* CHAINLENS TERMINAL — mint */}
            <span
              style={{
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.16em',
                color: '#4ef2c5',
                fontFamily: 'var(--font-plex-mono)',
              }}
            >
              CHAINLENS TERMINAL
            </span>

            <div style={{ flex: 1 }} />

            {/* CORTEX label */}
            <span
              style={{
                fontSize: '9px',
                color: 'rgba(123,92,255,0.55)',
                fontFamily: 'var(--font-plex-mono)',
                letterSpacing: '0.14em',
              }}
            >
              CORTEX v2
            </span>
          </div>
        </div>

        {/* ── Content ─────────────────────────────────── */}
        <HeroSection onTyping={onTyping} />
        <HomeTokenScreener />

      </div>
    </>
  )
}
