'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import HeroSection from '@/components/HeroSection'
import HomeTokenScreener from '@/components/HomeTokenScreener'

interface ClarkChatProps {
  active: string | null
  onTyping?: (typing: boolean) => void
  onSend?: (text: string) => void
  initialMessage?: string | null
  mode?: 'full' | 'panel' | 'hero'
}

interface Message {
  role: 'user' | 'clark'
  text: string
}

function parseMessage(raw: string): Record<string, string> {
  const t = raw.trim().toLowerCase()
  const addrMatch = raw.match(/0x[a-fA-F0-9]{40}/)
  const address = addrMatch?.[0]

  if (t.startsWith('scan token') && address)
    return { feature: 'token-scanner', tokenAddress: address }
  if (t.startsWith('scan wallet') && address)
    return { feature: 'wallet-scanner', walletAddress: address }
  if (t.startsWith('base radar') || t.includes('trending') || t.includes('what\'s hot') || t.includes('pumping'))
    return { feature: 'base-radar' }
  if (t.startsWith('liquidity') && address)
    return { feature: 'liquidity-safety', tokenAddress: address }
  if (t.startsWith('dev wallet') && address)
    return { feature: 'dev-wallet-detector', tokenAddress: address }
  if (t.startsWith('whale alert') && address)
    return { feature: 'whale-alerts', walletAddress: address }
  if (t.startsWith('pump') && address)
    return { feature: 'pump-alerts', tokenAddress: address }
  if (t.startsWith('clark ai:'))
    return { feature: 'clark-ai', prompt: raw.trim().slice(9).trim() }

  return { feature: 'clark-ai', prompt: raw.trim() }
}

function formatResponse(data: Record<string, unknown>): string {
  if (typeof data?.analysis === 'string') return data.analysis
  return JSON.stringify(data, null, 2)
}

export default function ClarkChat({ active, onTyping, onSend, initialMessage, mode = 'full' }: ClarkChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastSentInitialRef = useRef<string | null>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Stable send function — callable from both the UI and the initialMessage effect.
  // useState setters and refs are guaranteed stable by React, so [] deps is correct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const executeSend = useCallback(async (text: string) => {
    console.log('executeSend sending:', text)
    setMessages(prev => [...prev, { role: 'user', text }])
    setLoading(true)
    setMessages(prev => [...prev, { role: 'clark', text: 'Clark is thinking...' }])

    try {
      const body = parseMessage(text)
      console.log('POST → /api/clark')
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/api/clark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      console.log('Response status:', res.status)

      const json = await res.json()
      const reply = json.ok
        ? formatResponse(json.data as Record<string, unknown>)
        : (json.error ?? 'Something went wrong.')

      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: reply }
        return next
      })
    } catch {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: 'Clark backend unreachable.' }
        return next
      })
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }, [])

  // Fire once per unique initialMessage value — lets the homepage panel pre-send a query.
  useEffect(() => {
    if (initialMessage && initialMessage !== lastSentInitialRef.current) {
      lastSentInitialRef.current = initialMessage
      executeSend(initialMessage)
    }
  }, [initialMessage, executeSend])

  function handleSend() {
    console.log('handleSend fired with:', input)
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    executeSend(text)
  }

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
        .clark-msg-scroll::-webkit-scrollbar { width: 3px; }
        .clark-msg-scroll::-webkit-scrollbar-thumb {
          background: rgba(123,92,255,0.30);
          border-radius: 3px;
        }
        @keyframes clarkThinkingDot {
          0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
          40%            { opacity: 1;   transform: translateY(-3px); }
        }
        .clark-dot { display: inline-block; animation: clarkThinkingDot 1.2s ease-in-out infinite; }
        .clark-dot:nth-child(2) { animation-delay: 0.15s; }
        .clark-dot:nth-child(3) { animation-delay: 0.30s; }
      `}</style>

      <div className="flex-1 flex flex-col" style={{ background: '#050816' }}>

        {/* ── Terminal header bar ─────────────────────── */}
        <div style={{ position: 'sticky', top: 0, zIndex: 10, flexShrink: 0 }}>
          <div style={{
            height: '1.5px',
            background: 'linear-gradient(90deg, transparent 0%, #ff4b9a 25%, #7b5cff 55%, #4ef2c5 80%, transparent 100%)',
          }} />
          <div
            className="terminal-header-bar"
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '0 24px', height: '44px',
              background: 'rgba(5,8,22,0.94)',
              backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
              borderBottom: '1px solid rgba(123,92,255,0.13)',
            }}
          >
            <div style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: '#4ef2c5', flexShrink: 0,
              animation: 'terminalDotBlink 3s ease-in-out infinite',
            }} />
            <span style={{
              fontSize: '10px', fontWeight: 800, letterSpacing: '0.20em',
              color: '#ff4b9a', fontFamily: 'var(--font-plex-mono)',
              textShadow: '0 0 10px rgba(255,75,154,0.70), 0 0 4px rgba(255,75,154,0.40)',
            }}>LIVE</span>
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.18)', fontFamily: 'var(--font-plex-mono)' }}>/</span>
            <span style={{
              fontSize: '10px', fontWeight: 600, letterSpacing: '0.16em',
              color: '#4ef2c5', fontFamily: 'var(--font-plex-mono)',
              textShadow: '0 0 10px rgba(78,242,197,0.58), 0 0 4px rgba(139,92,246,0.22)',
            }}>CHAINLENS TERMINAL</span>
            <div style={{ flex: 1 }} />
            <span style={{
              fontSize: '9px', color: 'rgba(123,92,255,0.55)',
              fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.14em',
            }}>CORTEX v2</span>
          </div>
        </div>

        {/* ── Existing content ─────────────────────────── */}
        <HeroSection onTyping={onTyping} onSend={onSend} />
        <HomeTokenScreener />

        {/* ── Chat UI ──────────────────────────────────── */}
        {mode !== 'hero' && <div style={{
          display: 'flex', flexDirection: 'column',
          borderTop: '1px solid rgba(123,92,255,0.14)',
          background: 'rgba(5,8,22,0.80)',
        }}>

          {/* Chat label */}
          <div style={{
            padding: '10px 20px 0',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <span style={{
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
              color: 'rgba(123,92,255,0.50)', fontFamily: 'var(--font-plex-mono)',
              textTransform: 'uppercase',
            }}>Clark Chat</span>
            <div style={{ flex: 1, height: '1px', background: 'rgba(123,92,255,0.10)' }} />
          </div>

          {/* Message list */}
          <div
            ref={scrollRef}
            className="clark-msg-scroll"
            style={{
              height: '320px', overflowY: 'auto',
              padding: '14px 20px',
              display: 'flex', flexDirection: 'column', gap: '10px',
            }}
          >
            {messages.length === 0 && (
              <div style={{
                margin: 'auto', textAlign: 'center',
                color: 'rgba(255,255,255,0.18)', fontSize: '12px',
                fontFamily: 'var(--font-plex-mono)', lineHeight: 1.8,
              }}>
                Ask Clark anything.<br />
                <span style={{ color: 'rgba(78,242,197,0.35)' }}>
                  scan token 0x… · scan wallet 0x… · base radar · clark ai: …
                </span>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                {msg.role === 'clark' && (
                  <div style={{
                    width: '22px', height: '22px', borderRadius: '50%',
                    background: 'linear-gradient(135deg, #7b5cff, #4ef2c5)',
                    flexShrink: 0, marginRight: '8px', alignSelf: 'flex-end',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '9px', fontWeight: 800, color: '#050816',
                    fontFamily: 'var(--font-plex-mono)',
                  }}>C</div>
                )}

                <div style={{
                  maxWidth: '78%',
                  padding: '10px 14px',
                  borderRadius: msg.role === 'user'
                    ? '14px 14px 3px 14px'
                    : '14px 14px 14px 3px',
                  background: msg.role === 'user'
                    ? 'rgba(45,212,191,0.10)'
                    : 'rgba(123,92,255,0.10)',
                  border: `1px solid ${msg.role === 'user'
                    ? 'rgba(45,212,191,0.18)'
                    : 'rgba(123,92,255,0.18)'}`,
                  color: msg.text === 'Clark is thinking...'
                    ? 'rgba(255,255,255,0.40)'
                    : '#dde4f0',
                  fontSize: '12.5px',
                  lineHeight: 1.65,
                  fontFamily: msg.text.startsWith('{') || msg.text.startsWith('[')
                    ? 'var(--font-plex-mono)'
                    : 'var(--font-inter), Inter, sans-serif',
                  whiteSpace: msg.text.startsWith('{') || msg.text.startsWith('[')
                    ? 'pre-wrap'
                    : 'normal',
                  wordBreak: 'break-word',
                }}>
                  {msg.text === 'Clark is thinking...' ? (
                    <span>
                      Clark is thinking
                      <span className="clark-dot" style={{ marginLeft: '2px' }}>.</span>
                      <span className="clark-dot">.</span>
                      <span className="clark-dot">.</span>
                    </span>
                  ) : msg.text}
                </div>
              </div>
            ))}
          </div>

          {/* Input row — full mode only */}
          {mode === 'full' && (
            <div style={{
              padding: '10px 20px 18px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
              display: 'flex', gap: '8px', alignItems: 'center',
            }}>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !loading) handleSend() }}
                disabled={loading}
                placeholder="scan token 0x…  ·  base radar  ·  clark ai: …"
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: '10px',
                  background: 'rgba(5,8,22,0.70)',
                  border: '1px solid rgba(123,92,255,0.22)',
                  color: '#e2e8f0',
                  fontSize: '12.5px',
                  fontFamily: 'var(--font-inter), Inter, sans-serif',
                  outline: 'none',
                  opacity: loading ? 0.5 : 1,
                  transition: 'border-color 0.15s, opacity 0.15s',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(78,242,197,0.40)' }}
                onBlur={e => { e.currentTarget.style.borderColor = 'rgba(123,92,255,0.22)' }}
              />

              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                style={{
                  padding: '10px 18px',
                  borderRadius: '10px',
                  border: 'none',
                  background: loading || !input.trim()
                    ? 'rgba(123,92,255,0.20)'
                    : 'linear-gradient(135deg, #4ef2c5 0%, #7b5cff 100%)',
                  color: loading || !input.trim() ? 'rgba(255,255,255,0.35)' : '#050816',
                  fontSize: '12px',
                  fontWeight: 700,
                  fontFamily: 'var(--font-plex-mono)',
                  cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                  letterSpacing: '0.06em',
                  transition: 'background 0.15s, color 0.15s, opacity 0.15s',
                  flexShrink: 0,
                }}
              >
                SEND
              </button>
            </div>
          )}
        </div>}

      </div>
    </>
  )
}
