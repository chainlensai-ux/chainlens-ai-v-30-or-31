'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'

const CORRECT_CODE = 'CHAINLENS2026'
const SESSION_KEY = 'chainlens_beta_access'
const SESSION_VALUE = 'granted'

const PARTICLES = Array.from({ length: 48 }, (_, i) => {
  const seed = i * 7919
  return {
    x: ((seed * 1301) % 1000) / 10,
    y: ((seed * 1999) % 1000) / 10,
    r: 1 + ((seed * 2539) % 20) / 10,
    o: 0.06 + ((seed * 3301) % 30) / 100,
    d: 2.5 + ((seed * 4001) % 40) / 10,
  }
})

export default function BetaPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shaking, setShaking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hasAccess, setHasAccess] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function resolveNextPath() {
    const next = searchParams.get('next')
    if (next && next.startsWith('/') && !next.startsWith('//')) return next
    return '/'
  }

  useEffect(() => {
    const granted = sessionStorage.getItem(SESSION_KEY) === SESSION_VALUE
    if (granted) {
      router.replace(resolveNextPath())
      return
    }
    setLoading(false)
    setTimeout(() => inputRef.current?.focus(), 60)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, searchParams])

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    const trimmed = code.trim().toUpperCase()
    if (trimmed === CORRECT_CODE) {
      sessionStorage.setItem(SESSION_KEY, SESSION_VALUE)
      setError(null)
      router.replace(resolveNextPath())
      return
    }

    setError('Incorrect beta password.')
    setShaking(true)
    setTimeout(() => setShaking(false), 500)
  }

  if (loading) return null

  return (
    <main>
      <style>{`
        @keyframes beta-float {
          0%, 100% { transform: translateY(0px); }
          50%       { transform: translateY(-6px); }
        }
        @keyframes beta-shake {
          0%,100% { transform: translateX(0); }
          20%     { transform: translateX(-7px); }
          40%     { transform: translateX(7px); }
          60%     { transform: translateX(-5px); }
          80%     { transform: translateX(5px); }
        }
        @keyframes beta-pulse-dot {
          0%,100% { opacity: var(--op); }
          50%     { opacity: calc(var(--op) * 0.3); }
        }
        @keyframes beta-glow-breathe {
          0%,100% { opacity: 0.55; transform: scale(1); }
          50%     { opacity: 0.80; transform: scale(1.06); }
        }
        .beta-card-shake { animation: beta-shake 0.45s ease; }
        .beta-input:focus {
          border-color: rgba(45,212,191,0.60) !important;
          box-shadow: 0 0 0 3px rgba(45,212,191,0.10) !important;
        }
        .beta-btn:hover:not(:disabled) {
          background: #25c0a8 !important;
          box-shadow: 0 0 28px rgba(45,212,191,0.45), 0 0 10px rgba(45,212,191,0.25) !important;
        }
        .beta-btn:active:not(:disabled) { transform: scale(0.97); }
      `}</style>

      <div style={{
        minHeight: '100vh', width: '100%',
        background: '#06060a',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px 16px',
        position: 'relative', overflow: 'hidden',
        fontFamily: 'var(--font-inter), Inter, sans-serif',
      }}>
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
          {PARTICLES.map((p, i) => (
            <div key={i} style={{
              position: 'absolute',
              left: `${p.x}%`, top: `${p.y}%`,
              width: `${p.r * 2}px`, height: `${p.r * 2}px`,
              borderRadius: '50%',
              background: i % 3 === 0 ? '#2DD4BF' : i % 3 === 1 ? '#8b5cf6' : '#94a3b8',
              // @ts-ignore
              '--op': p.o,
              opacity: p.o,
              animation: `beta-pulse-dot ${p.d}s ease-in-out infinite`,
              animationDelay: `${(i * 0.23) % p.d}s`,
            } as React.CSSProperties} />
          ))}
        </div>

        <div style={{
          position: 'absolute', zIndex: 0,
          width: '560px', height: '420px',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(45,212,191,0.13) 0%, transparent 68%)',
          filter: 'blur(48px)',
          animation: 'beta-glow-breathe 4s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', zIndex: 0,
          width: '400px', height: '320px',
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(139,92,246,0.09) 0%, transparent 68%)',
          filter: 'blur(56px)',
          transform: 'translate(160px, 80px)',
          pointerEvents: 'none',
        }} />

        <div
          className={shaking ? 'beta-card-shake' : ''}
          style={{
            position: 'relative', zIndex: 1,
            width: '100%', maxWidth: '400px',
            background: 'rgba(8,12,20,0.92)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '22px',
            padding: '44px 36px 36px',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.04) inset, 0 32px 80px rgba(0,0,0,0.60), 0 0 60px rgba(45,212,191,0.06)',
            animation: 'beta-float 5.5s ease-in-out infinite',
          }}
        >
          <div style={{
            position: 'absolute', top: 0, left: '12%', right: '12%', height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(45,212,191,0.55), rgba(139,92,246,0.45), transparent)',
          }} />

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '28px' }}>
            <div style={{
              width: '72px', height: '72px', borderRadius: '18px',
              background: 'rgba(45,212,191,0.07)',
              border: '1px solid rgba(45,212,191,0.16)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 24px rgba(45,212,191,0.15)',
            }}>
              <Image src="/cl-logo.png" alt="ChainLens" width={52} height={52} />
            </div>
          </div>

          <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#f1f5f9', margin: '0 0 8px', textAlign: 'center', letterSpacing: '-0.01em' }}>
            Beta Access
          </h1>
          <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 32px', textAlign: 'center', lineHeight: 1.6 }}>
            Enter your beta access code to continue.
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              ref={inputRef}
              className="beta-input"
              type="password"
              value={code}
              onChange={e => { setCode(e.target.value); setError(null) }}
              placeholder="Access code"
              autoComplete="off"
              spellCheck={false}
              style={{
                width: '100%', padding: '12px 16px',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: '11px',
                color: '#e2e8f0', fontSize: '15px',
                fontFamily: 'var(--font-plex-mono, "IBM Plex Mono", monospace)',
                letterSpacing: '0.12em',
                outline: 'none', boxSizing: 'border-box',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
            />

            {error && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '7px',
                padding: '9px 12px', borderRadius: '9px',
                background: 'rgba(239,68,68,0.09)',
                border: '1px solid rgba(239,68,68,0.22)',
                color: '#fca5a5', fontSize: '12px',
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" stroke="#fca5a5" strokeWidth="2"/>
                  <path d="M12 8v4M12 16h.01" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                {error}
              </div>
            )}

                <button
                  type="submit"
                  className="beta-btn"
                  disabled={!code.trim()}
                  style={{
                    width: '100%', padding: '12px 16px',
                    borderRadius: '11px', border: 'none',
                    background: code.trim() ? '#2DD4BF' : 'rgba(45,212,191,0.25)',
                    color: code.trim() ? '#04101a' : 'rgba(255,255,255,0.30)',
                    fontSize: '12px', fontWeight: 800,
                    letterSpacing: '0.14em', textTransform: 'uppercase',
                    cursor: code.trim() ? 'pointer' : 'not-allowed',
                    fontFamily: 'var(--font-plex-mono, "IBM Plex Mono", monospace)',
                    boxShadow: code.trim() ? '0 0 20px rgba(45,212,191,0.28), 0 0 8px rgba(45,212,191,0.16)' : 'none',
                    transition: 'background 0.15s, box-shadow 0.15s, color 0.15s, transform 0.10s',
                  }}
                >
                  Enter
                </button>
              </form>
            </>
          ) : (
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#f1f5f9', margin: 0 }}>Beta Unlocked</h1>
              <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0, lineHeight: 1.65 }}>
                Welcome to ChainLens beta. Your access is active for this browser session.
              </p>
              <button
                type="button"
                onClick={handleLock}
                style={{
                  marginTop: '8px',
                  width: '100%', padding: '12px 16px',
                  borderRadius: '11px',
                  border: '1px solid rgba(239,68,68,0.30)',
                  background: 'rgba(239,68,68,0.10)',
                  color: '#fca5a5',
                  fontSize: '12px',
                  fontWeight: 800,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                Lock Beta
              </button>
            </div>
          )}

          <div style={{
            position: 'absolute', bottom: 0, left: '15%', right: '15%', height: '1px',
            background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.30), rgba(45,212,191,0.30), transparent)',
          }} />
        </div>
      </div>
    </main>
  )
}
