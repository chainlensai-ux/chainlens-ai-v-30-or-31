'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Syne } from 'next/font/google'

const syne = Syne({ subsets: ['latin'], weight: ['700', '800'] })

export default function HomePage() {
  const [email,   setEmail]   = useState('')
  const [msg,     setMsg]     = useState<{ text: string; ok: boolean } | null>(null)
  const [busy,    setBusy]    = useState(false)
  const [joined,  setJoined]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setMsg({ text: 'Please enter a valid email address.', ok: false })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res  = await fetch('/api/waitlist', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: trimmed }),
      })
      const data = await res.json()
      if (res.ok) {
        setMsg({ text: "You're on the list! We'll be in touch.", ok: true })
        setEmail('')
        setJoined(true)
      } else {
        setMsg({ text: data.error || 'Something went wrong. Please try again.', ok: false })
        setBusy(false)
      }
    } catch {
      setMsg({ text: 'Network error. Please try again.', ok: false })
      setBusy(false)
    }
  }

  return (
    <>
      {/* Global page styles */}
      <style>{`
        body {
          background: #0a0a0a;
          margin: 0;
          padding: 0;
        }
      `}</style>

      {/* Full-viewport centered layout */}
      <div
        style={{
          minHeight: '100vh',
          background: '#0a0a0a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1.25rem',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background radial glows */}
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: [
              'radial-gradient(ellipse 60% 40% at 30% 20%, rgba(100,255,218,0.10) 0%, transparent 70%)',
              'radial-gradient(ellipse 50% 35% at 75% 75%, rgba(236,72,153,0.11) 0%, transparent 70%)',
            ].join(', '),
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />

        {/* Content card */}
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            maxWidth: '520px',
            width: '100%',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          {/* Logo */}
          <Image
            src="/cl-logo.png"
            alt="ChainLens logo"
            width={120}
            height={120}
            style={{
              marginBottom: '1.75rem',
              filter: 'drop-shadow(0 0 18px rgba(139,92,246,0.45))',
            }}
          />

          {/* Brand name */}
          <h1
            className={syne.className}
            style={{
              fontSize: 'clamp(2.6rem, 8vw, 3.75rem)',
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              marginBottom: '1rem',
              background: 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 50%, #64ffda 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            ChainLens
          </h1>

          {/* Tagline */}
          <p
            style={{
              fontSize: '1.125rem',
              fontWeight: 400,
              color: 'rgba(255,255,255,0.72)',
              letterSpacing: '0.01em',
              marginBottom: '2.5rem',
              lineHeight: 1.5,
            }}
          >
            See the market before it moves
          </p>

          {/* Waitlist form */}
          <form
            onSubmit={handleSubmit}
            noValidate
            style={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              marginBottom: '2rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.625rem', width: '100%', flexWrap: 'wrap' }}>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                autoComplete="email"
                disabled={busy || joined}
                aria-label="Email address"
                style={{
                  flex: '1 1 160px',
                  minWidth: 0,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(139,92,246,0.3)',
                  borderRadius: '10px',
                  padding: '0.8125rem 1rem',
                  fontSize: '0.9375rem',
                  fontFamily: 'Inter, sans-serif',
                  color: '#ffffff',
                  outline: 'none',
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = 'rgba(139,92,246,0.65)'
                  e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(139,92,246,0.15)'
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = 'rgba(139,92,246,0.3)'
                  e.currentTarget.style.boxShadow   = 'none'
                }}
              />
              <button
                type="submit"
                disabled={busy || joined}
                style={{
                  flexShrink: 0,
                  padding: '0.8125rem 1.375rem',
                  borderRadius: '10px',
                  border: 'none',
                  cursor: busy || joined ? 'not-allowed' : 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: '0.9375rem',
                  fontWeight: 600,
                  background: '#8b5cf6',
                  color: '#ffffff',
                  whiteSpace: 'nowrap',
                  boxShadow: '0 4px 20px rgba(139,92,246,0.35)',
                  opacity: busy || joined ? 0.55 : 1,
                  transition: 'background 0.18s, opacity 0.18s, transform 0.18s, box-shadow 0.18s',
                }}
                onMouseEnter={e => {
                  if (!busy && !joined) {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.background  = '#ec4899'
                    el.style.boxShadow   = '0 6px 28px rgba(236,72,153,0.5)'
                    el.style.transform   = 'translateY(-1px)'
                  }
                }}
                onMouseLeave={e => {
                  if (!busy && !joined) {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.background  = '#8b5cf6'
                    el.style.boxShadow   = '0 4px 20px rgba(139,92,246,0.35)'
                    el.style.transform   = 'translateY(0)'
                  }
                }}
              >
                {joined ? 'Joined!' : busy ? 'Joining…' : 'Join Waitlist'}
              </button>
            </div>

            {/* Status message */}
            {msg && (
              <p
                style={{
                  fontSize: '0.875rem',
                  color: msg.ok ? '#64ffda' : '#ec4899',
                  margin: 0,
                }}
              >
                {msg.text}
              </p>
            )}
          </form>

          {/* Launch badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: 'rgba(45,212,191,0.08)',
              border: '1px solid rgba(45,212,191,0.22)',
              borderRadius: '999px',
              padding: '0.4rem 1rem',
              fontSize: '0.8125rem',
              color: '#2DD4BF',
              letterSpacing: '0.04em',
              fontWeight: 500,
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: '#2DD4BF',
                boxShadow: '0 0 8px #2DD4BF',
                display: 'inline-block',
                animation: 'pulse 2s ease-in-out infinite',
              }}
            />
            Launching April
          </div>

        </div>
      </div>

      {/* Keyframe for pulsing dot */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1;   transform: scale(1);    }
          50%       { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>
    </>
  )
}
