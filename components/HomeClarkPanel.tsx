'use client'

import ClarkChat from '@/components/ClarkChat'

interface HomeClarkPanelProps {
  open: boolean
  initialMessage: string | null
  onClose: () => void
}

export default function HomeClarkPanel({ open, initialMessage, onClose }: HomeClarkPanelProps) {
  return (
    <>
      <style>{`
        @keyframes panel-dot-blink {
          0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(45,212,191,0.90); }
          50%       { opacity: 0.35; box-shadow: 0 0 3px rgba(45,212,191,0.30); }
        }
        @keyframes panel-top-glow {
          0%, 100% { opacity: 0.60; }
          50%       { opacity: 1; }
        }
      `}</style>

      {/* Backdrop — only visible when open */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0,
            zIndex: 109,
            background: 'rgba(0,0,0,0.35)',
            backdropFilter: 'blur(2px)',
            WebkitBackdropFilter: 'blur(2px)',
          }}
        />
      )}

      {/* Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          width: open ? '420px' : '0',
          overflow: 'hidden',
          transition: 'width 320ms cubic-bezier(0.4, 0, 0.2, 1)',
          zIndex: 110,
          background: '#06060e',
          borderLeft: open ? '1px solid rgba(45,212,191,0.15)' : 'none',
          boxShadow: open ? '-16px 0 60px rgba(0,0,0,0.70), -2px 0 0 rgba(45,212,191,0.06)' : 'none',
        }}
      >
        {/* Fixed-width inner so content never collapses during animation */}
        <div style={{ width: '420px', height: '100%', display: 'flex', flexDirection: 'column' }}>

          {/* ── Premium header ─────────────────────────── */}
          <div style={{ flexShrink: 0 }}>
            {/* Animated gradient top line */}
            <div style={{
              height: '1.5px',
              background: 'linear-gradient(90deg, transparent 0%, rgba(45,212,191,0.70) 35%, rgba(139,92,246,0.55) 65%, transparent 100%)',
              animation: 'panel-top-glow 4s ease-in-out infinite',
            }} />

            {/* Header bar */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '0 18px',
              height: '56px',
              background: 'rgba(6,6,18,0.96)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
            }}>
              {/* Clark avatar */}
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%',
                background: 'linear-gradient(135deg, #2DD4BF 0%, #8b5cf6 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '11px', fontWeight: 800, color: '#04101a',
                fontFamily: 'var(--font-plex-mono)',
                flexShrink: 0,
                boxShadow: '0 0 12px rgba(45,212,191,0.35)',
              }}>C</div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
                <span style={{
                  fontSize: '13px', fontWeight: 700,
                  color: '#f1f5f9',
                  fontFamily: 'var(--font-inter, Inter, sans-serif)',
                  letterSpacing: '0.01em',
                }}>Clark AI</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div style={{
                    width: '5px', height: '5px', borderRadius: '50%',
                    background: '#2DD4BF',
                    animation: 'panel-dot-blink 3s ease-in-out infinite',
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: '9px', fontWeight: 600, letterSpacing: '0.14em',
                    color: 'rgba(45,212,191,0.65)',
                    fontFamily: 'var(--font-plex-mono)',
                    textTransform: 'uppercase',
                  }}>Online · CORTEX v2</span>
                </div>
              </div>

              {/* Close button */}
              <button
                onClick={onClose}
                style={{
                  width: '30px', height: '30px',
                  borderRadius: '8px',
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.45)',
                  cursor: 'pointer',
                  fontSize: '16px', lineHeight: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget
                  el.style.background = 'rgba(255,255,255,0.10)'
                  el.style.color = '#fff'
                  el.style.borderColor = 'rgba(255,255,255,0.18)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget
                  el.style.background = 'rgba(255,255,255,0.05)'
                  el.style.color = 'rgba(255,255,255,0.45)'
                  el.style.borderColor = 'rgba(255,255,255,0.08)'
                }}
                aria-label="Close panel"
              >
                ×
              </button>
            </div>
          </div>

          {/* ── Chat body ──────────────────────────────── */}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ClarkChat mode="chat-only" active={null} initialMessage={initialMessage} />
          </div>

        </div>
      </div>
    </>
  )
}
