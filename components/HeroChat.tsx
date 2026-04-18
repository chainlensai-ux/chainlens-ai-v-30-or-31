'use client'

import { useState, useRef, useEffect } from 'react'

const PILLS = [
  "What's pumping right now?",
  'Scan a whale wallet',
  'Is BTC a buy right now?',
  'Show me smart money moves',
  'Best performer this week?',
  "What's the market sentiment?",
]

const SYSTEM = `You are Clark, the AI assistant powering ChainLens — a Base-native crypto intelligence terminal. You are answering a question on the ChainLens AI landing page. Keep responses to 2-3 sharp sentences. If the user asks to scan a specific wallet address, explain that live wallet scanning is available in the app — describe what ChainLens would show them (portfolio breakdown, smart money signals, transaction history) and encourage them to sign up free. Be direct, crypto-native, and compelling.`

type Msg = { role: 'user' | 'bot'; text: string }

export default function HeroChat() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPills, setShowPills] = useState(true)
  const msgsEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, busy])

  function autoResize() {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px'
  }

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy) return
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setShowPills(false)
    setMsgs(prev => [...prev, { role: 'user', text: q }])
    setBusy(true)
    try {
      const res = await fetch(`/api/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: SYSTEM + '\n\nUser: ' + q + '\nClark:',
          max_tokens: 400,
        }),
      })
      const data = await res.json()
      const reply = (data.text || '').trim() || "Connect your wallet inside the app for full live analysis."
      setMsgs(prev => [...prev, { role: 'bot', text: reply }])
    } catch {
      setMsgs(prev => [...prev, { role: 'bot', text: "Couldn't reach CORTEX right now — try again in a moment." }])
    } finally {
      setBusy(false)
    }
  }

  const hasMsgs = msgs.length > 0 || busy

  return (
    <div style={{
      position: 'relative',
      maxWidth: '620px',
      margin: '0 auto 32px',
      background: 'rgba(11,9,16,0.78)',
      border: '1px solid rgba(139,92,246,0.38)',
      borderRadius: '20px',
      backdropFilter: 'blur(28px)',
      WebkitBackdropFilter: 'blur(28px)',
      boxShadow: '0 0 0 1px rgba(139,92,246,0.08), 0 8px 40px rgba(0,0,0,0.45), 0 0 80px rgba(139,92,246,0.1)',
      overflow: 'hidden',
    }}>
      {/* Top gradient line */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '1px',
        background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.7), rgba(100,255,218,0.45), transparent)',
        pointerEvents: 'none',
      }} />

      {/* Messages area */}
      {hasMsgs && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '16px 18px 4px',
          maxHeight: '220px', overflowY: 'auto',
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(139,92,246,0.2) transparent',
        }}>
          {msgs.map((m, i) => (
            <div key={i} style={{
              fontSize: '13px', lineHeight: 1.65,
              padding: '9px 13px',
              borderRadius: '12px',
              borderBottomRightRadius: m.role === 'user' ? '4px' : '12px',
              borderBottomLeftRadius: m.role === 'bot' ? '4px' : '12px',
              maxWidth: '88%', wordBreak: 'break-word',
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              background: m.role === 'user' ? 'rgba(139,92,246,0.18)' : 'rgba(139,92,246,0.1)',
              border: m.role === 'user'
                ? '1px solid rgba(139,92,246,0.32)'
                : '1px solid rgba(139,92,246,0.22)',
              color: m.role === 'user' ? '#fff' : 'rgba(255,255,255,0.8)',
            }}>
              {m.text}
            </div>
          ))}
          {busy && (
            <div style={{
              display: 'flex', gap: '3px', alignItems: 'center',
              padding: '10px 13px', alignSelf: 'flex-start',
              background: 'rgba(139,92,246,0.1)',
              border: '1px solid rgba(139,92,246,0.22)',
              borderRadius: '12px', borderBottomLeftRadius: '4px',
            }}>
              {[0, 200, 400].map((delay, i) => (
                <span key={i} style={{
                  display: 'inline-block', width: '5px', height: '5px',
                  background: 'rgba(167,139,250,0.8)', borderRadius: '50%',
                  animation: `clarkDot 1.2s ${delay}ms infinite`,
                }} />
              ))}
            </div>
          )}
          <div ref={msgsEndRef} />
        </div>
      )}

      {/* Quick prompt pills */}
      {showPills && (
        <div style={{
          display: 'flex', gap: '7px',
          padding: '16px 18px 4px',
          flexWrap: 'wrap', justifyContent: 'center',
        }}>
          {PILLS.map(p => (
            <button
              key={p}
              onClick={() => send(p)}
              style={{
                padding: '6px 14px',
                background: 'rgba(139,92,246,0.06)',
                border: '1px solid rgba(139,92,246,0.28)',
                borderRadius: '20px',
                fontFamily: 'var(--font-inter, Inter, sans-serif)',
                fontSize: '11.5px', fontWeight: 500,
                color: 'rgba(255,255,255,0.7)',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(139,92,246,0.14)'
                e.currentTarget.style.borderColor = 'rgba(139,92,246,0.55)'
                e.currentTarget.style.color = '#fff'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgba(139,92,246,0.06)'
                e.currentTarget.style.borderColor = 'rgba(139,92,246,0.28)'
                e.currentTarget.style.color = 'rgba(255,255,255,0.7)'
                e.currentTarget.style.transform = 'none'
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: '10px',
        padding: '10px 14px',
        borderTop: '1px solid rgba(139,92,246,0.12)',
        marginTop: '12px',
      }}>
        <textarea
          ref={textareaRef}
          value={input}
          rows={1}
          placeholder="Ask Clark — scan a wallet, find early pumps, track smart money..."
          onChange={e => { setInput(e.target.value); autoResize() }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none', outline: 'none', resize: 'none',
            fontFamily: 'var(--font-inter, Inter, sans-serif)',
            fontSize: '14px', color: '#fff',
            lineHeight: 1.5, maxHeight: '100px',
          }}
        />
        <button
          onClick={() => send(input)}
          disabled={busy}
          aria-label="Send to Clark"
          style={{
            width: '38px', height: '38px', flexShrink: 0,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #ec4899, #8b5cf6, #64ffda)',
            border: 'none',
            cursor: busy ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: busy ? 0.5 : 1,
            animation: busy ? 'none' : 'cl-send-pulse 2.8s ease-in-out infinite',
            transition: 'transform 0.2s, opacity 0.15s',
          }}
          onMouseEnter={e => { if (!busy) e.currentTarget.style.transform = 'scale(1.1)' }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
        >
          <svg viewBox="0 0 24 24" style={{ width: '15px', height: '15px', fill: '#050407' }}>
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 18px 12px',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono, IBM Plex Mono, monospace)',
          fontSize: '9px', fontWeight: 700,
          letterSpacing: '2.5px', textTransform: 'uppercase',
          background: 'linear-gradient(135deg, #ec4899, #8b5cf6, #64ffda)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          opacity: 0.8,
        }}>
          ⬡ CORTEX
        </span>
        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)' }}>
          Ask anything — powered by CORTEX
        </span>
      </div>
    </div>
  )
}
