'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import HeroSection from '@/components/HeroSection'
import HomeTokenScreener from '@/components/HomeTokenScreener'

interface ClarkChatProps {
  active: string | null
  onTyping?: (typing: boolean) => void
  onSend?: (text: string) => void
  initialMessage?: string | null
  prefillOnlyInitial?: boolean
  mode?: 'full' | 'panel' | 'hero' | 'chat-only'
}

interface Message {
  role: 'user' | 'clark'
  text: string
}

// Try to pull a token name from a message like "is brett safe?" or "toshi price"
function extractTokenQuery(text: string): string | null {
  const t = text.toLowerCase()
  const STOP = new Set(['a', 'an', 'the', 'this', 'that', 'it', 'is', 'are', 'be', 'me', 'my',
    'on', 'in', 'of', 'to', 'and', 'or', 'so', 'do', 'for', 'going', 'doing', 'there', 'here'])

  // "scan brett" / "check toshi" / "analyze doginme"
  const cmd = t.match(/\b(?:scan|check|analyze|info\s+on|about)\s+([a-z][a-z0-9]{1,15})\b/)
  if (cmd && !STOP.has(cmd[1])) return cmd[1]

  // "brett price" / "toshi liquidity" / "based volume"
  const before = t.match(/\b([a-z][a-z0-9]{1,15})\s+(?:price|liquidity|volume|safe|safety|pools?|rug|chart|cap|analysis|pumping)\b/)
  if (before && !STOP.has(before[1])) return before[1]

  // "is brett safe?" / "is toshi a rug?"
  const afterIs = t.match(/\bis\s+([a-z][a-z0-9]{1,15})\b/)
  if (afterIs && !STOP.has(afterIs[1])) return afterIs[1]

  return null
}

const WALLET_INTENT = /\b(wallet|balance|balances|holdings?|portfolio|hold\b|holds\b|copy[\s-]?trade?|copytrade|follow|smart\s+money|good\s+wallet|whale\s+wallet|wallet\s+quality)\b/i
const MARKET_INTENT = /\b(pumping|pump(?:ing)?|hot\b|moving\b|movers?|gainers?|runners?|new\s+launches?|new\s+tokens?|what\s+should\s+i\s+watch|what'?s\s+on\s+base)\b/i

function parseMessage(raw: string): Record<string, string> {
  const t = raw.trim().toLowerCase()
  const addrMatch = raw.match(/0x[a-fA-F0-9]{40}/)
  const address = addrMatch?.[0]

  // Explicit wallet commands
  if (t.startsWith('scan wallet') && address)
    return { feature: 'wallet-scanner', walletAddress: address }
  if (t.startsWith('dev wallet') && address)
    return { feature: 'dev-wallet-detector', tokenAddress: address }
  if (t.startsWith('whale alert') && address)
    return { feature: 'whale-alerts', walletAddress: address }

  // Market / radar — check BEFORE bare address so "what's pumping?" never hits scan-token
  if (t.startsWith('base radar') || t.includes('trending') || t.includes("what's hot") || MARKET_INTENT.test(t))
    return { feature: 'base-radar' }

  // Bare address: wallet intent → wallet-scanner, otherwise → scan-token
  if (address) {
    if (WALLET_INTENT.test(t))
      return { feature: 'wallet-scanner', walletAddress: address, prompt: raw.trim() }
    return { feature: 'scan-token', tokenAddress: address, prompt: raw.trim() }
  }

  // Token name + signal keyword → scan-token
  const TOKEN_SIGNALS = /\b(price|liquidity|volume|safe|safety|pools?|rug|trap|pump|pumping|dump|degen|volatile|volatility|risk|cap|chart|scan|check|analyze|analysis|is\s+it|verdict)\b/i
  if (TOKEN_SIGNALS.test(t)) {
    const name = extractTokenQuery(t)
    if (name) return { feature: 'scan-token', query: name, prompt: raw.trim() }
  }

  if (t.startsWith('clark ai:'))
    return { feature: 'clark-ai', prompt: raw.trim().slice(9).trim() }

  return { feature: 'clark-ai', prompt: raw.trim() }
}

function formatResponse(data: Record<string, unknown>): string {
  if (typeof data?.analysis === 'string') return data.analysis
  return JSON.stringify(data, null, 2)
}

export default function ClarkChat({
  active,
  onTyping,
  onSend,
  initialMessage,
  prefillOnlyInitial = false,
  mode = 'full',
}: ClarkChatProps) {
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
      const res = await fetch(`/api/clark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, message: text, mode: body.feature, context: null }),
      })
      console.log('Response status:', res.status)

      const json = await res.json()
      const reply = json.ok
        ? (String((json.data as Record<string, unknown>)?.reply ?? formatResponse(json.data as Record<string, unknown>)))
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

  // Fire once per unique initialMessage value.
  useEffect(() => {
    if (initialMessage && initialMessage !== lastSentInitialRef.current) {
      lastSentInitialRef.current = initialMessage
      if (prefillOnlyInitial) {
        setInput(initialMessage)
      } else {
        executeSend(initialMessage)
      }
    }
  }, [initialMessage, executeSend, prefillOnlyInitial])

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
        @keyframes clarkThinkingShimmer {
          0%, 100% { background: rgba(0,0,0,0.30); box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
          50%       { background: rgba(123,92,255,0.08); box-shadow: 0 8px 40px rgba(123,92,255,0.18); }
        }
        @keyframes chat-orb-teal {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.18; }
          50%       { transform: translate(18px, -24px) scale(1.12); opacity: 0.28; }
        }
        @keyframes chat-orb-purple {
          0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.14; }
          50%       { transform: translate(-14px, 18px) scale(1.10); opacity: 0.22; }
        }
        @keyframes clark-dot-pulse {
          0%, 100% { box-shadow: 0 0 6px rgba(45,212,191,0.80), 0 0 14px rgba(45,212,191,0.40); opacity: 1; }
          50%       { box-shadow: 0 0 12px rgba(45,212,191,1.0), 0 0 24px rgba(45,212,191,0.65); opacity: 0.85; }
        }
        @media (max-width: 768px) {
          .clark-chat-shell { padding-bottom: 96px; }
          .clark-chat-input-row {
            position: sticky !important;
            bottom: 0 !important;
            z-index: 15 !important;
            background: linear-gradient(180deg, rgba(5,8,22,0.65), rgba(5,8,22,0.95)) !important;
          }
        }
      `}</style>

      <div className="flex-1 flex flex-col" style={{ background: '#050816', minHeight: 0 }}>

        {/* ── Terminal header bar — hidden in chat-only (panel has its own) ── */}
        {mode !== 'chat-only' && (
          <div style={{ flexShrink: 0, zIndex: 10 }}>
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
              }}>CLARK AI</span>
              <div style={{ flex: 1 }} />
              <span style={{
                fontSize: '9px', color: 'rgba(123,92,255,0.55)',
                fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.14em',
              }}>CORTEX v2</span>
            </div>
          </div>
        )}

        {/* ── Hero + screener — hidden in chat-only mode ── */}
        {mode !== 'chat-only' && (
          <>
            <HeroSection onTyping={onTyping} onSend={onSend} />
            <HomeTokenScreener />
          </>
        )}

        {/* ── Chat UI ──────────────────────────────────── */}
        {mode !== 'hero' && <div className="clark-chat-shell" style={{
          display: 'flex', flexDirection: 'column',
          flex: mode === 'chat-only' ? 1 : 'none',
          minHeight: 0,
          position: 'relative',
          borderTop: mode !== 'chat-only' ? '1px solid rgba(123,92,255,0.14)' : 'none',
          background: mode === 'chat-only' ? '#06060e' : 'rgba(5,8,22,0.80)',
          overflow: 'hidden',
        }}>

          {/* Animated background orbs — chat-only panel */}
          {mode === 'chat-only' && <>
            <div style={{
              position: 'absolute', pointerEvents: 'none', zIndex: 0,
              width: '300px', height: '300px', borderRadius: '50%',
              top: '-60px', left: '-60px',
              background: 'radial-gradient(circle, rgba(45,212,191,0.16) 0%, transparent 70%)',
              filter: 'blur(40px)',
              animation: 'chat-orb-teal 12s ease-in-out infinite',
            }} />
            <div style={{
              position: 'absolute', pointerEvents: 'none', zIndex: 0,
              width: '360px', height: '360px', borderRadius: '50%',
              bottom: '60px', right: '-80px',
              background: 'radial-gradient(circle, rgba(139,92,246,0.14) 0%, transparent 70%)',
              filter: 'blur(50px)',
              animation: 'chat-orb-purple 16s ease-in-out infinite',
            }} />
          </>}

          {/* Chat label — only in non-panel modes */}
          {mode !== 'chat-only' && (
            <div style={{
              padding: '10px 20px 0', flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              <span style={{
                fontSize: '9px', fontWeight: 700, letterSpacing: '0.18em',
                color: 'rgba(123,92,255,0.50)', fontFamily: 'var(--font-plex-mono)',
                textTransform: 'uppercase',
              }}>Clark Chat</span>
              <div style={{ flex: 1, height: '1px', background: 'rgba(123,92,255,0.10)' }} />
            </div>
          )}

          {/* Message list */}
          <div
            ref={scrollRef}
            className="clark-msg-scroll"
            style={{
              flex: mode === 'chat-only' ? 1 : 'none',
              height: mode === 'chat-only' ? undefined : 'min(380px, 48vh)',
              overflowY: 'auto',
              padding: mode === 'chat-only' ? '20px 16px' : '16px 20px',
              display: 'flex', flexDirection: 'column', gap: '14px',
              minHeight: 0,
              position: 'relative', zIndex: 1,
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

            {messages.map((msg, i) => {
              const isThinking = msg.role === 'clark' && msg.text === 'Clark is thinking...'
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  {msg.role === 'clark' && (
                    <div style={{
                      width: '9px', height: '9px', borderRadius: '50%',
                      background: '#2DD4BF',
                      flexShrink: 0, marginRight: '8px', alignSelf: 'flex-end', marginBottom: '6px',
                      animation: 'clark-dot-pulse 3s ease-in-out infinite',
                    }} />
                  )}

                  {isThinking ? (
                    <div style={{
                      backdropFilter: 'blur(12px)',
                      WebkitBackdropFilter: 'blur(12px)',
                      border: '1px solid rgba(255,255,255,0.10)',
                      borderRadius: '12px',
                      padding: '10px 16px',
                      display: 'flex', alignItems: 'center', gap: '2px',
                      animation: 'clarkThinkingShimmer 2s ease-in-out infinite',
                    }}>
                      <span style={{
                        fontSize: '12px', color: 'rgba(255,255,255,0.45)',
                        fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.04em',
                      }}>Clark is thinking</span>
                      <span className="clark-dot" style={{ marginLeft: '2px', color: 'rgba(78,242,197,0.70)' }}>.</span>
                      <span className="clark-dot" style={{ color: 'rgba(78,242,197,0.70)' }}>.</span>
                      <span className="clark-dot" style={{ color: 'rgba(78,242,197,0.70)' }}>.</span>
                    </div>
                  ) : (
                    <div style={{
                      maxWidth: '88%',
                      paddingTop: '10px',
                      paddingBottom: '10px',
                      paddingRight: '14px',
                      paddingLeft: msg.role === 'clark' ? '12px' : '14px',
                      borderRadius: msg.role === 'user'
                        ? '14px 14px 3px 14px'
                        : '14px 14px 14px 3px',
                      background: msg.role === 'user'
                        ? 'rgba(45,212,191,0.10)'
                        : 'rgba(123,92,255,0.10)',
                      borderTop: `1px solid ${msg.role === 'user' ? 'rgba(45,212,191,0.18)' : 'rgba(123,92,255,0.18)'}`,
                      borderRight: `1px solid ${msg.role === 'user' ? 'rgba(45,212,191,0.18)' : 'rgba(123,92,255,0.18)'}`,
                      borderBottom: `1px solid ${msg.role === 'user' ? 'rgba(45,212,191,0.18)' : 'rgba(123,92,255,0.18)'}`,
                      borderLeft: msg.role === 'clark'
                        ? '2px solid rgba(0,82,255,0.40)'
                        : '1px solid rgba(45,212,191,0.18)',
                      color: '#dde4f0',
                      fontSize: msg.role === 'clark' ? '15px' : '12.5px',
                      lineHeight: msg.role === 'clark' ? 1.75 : 1.65,
                      fontFamily: msg.text.startsWith('{') || msg.text.startsWith('[')
                        ? 'var(--font-plex-mono)'
                        : 'var(--font-inter), Inter, sans-serif',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      overflowWrap: 'anywhere',
                    }}>
                      {msg.text}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Input row — full and chat-only modes */}
          {(mode === 'full' || mode === 'chat-only') && (
            <div className="clark-chat-input-row" style={{
              padding: '10px 14px 14px',
              borderTop: '1px solid rgba(255,255,255,0.05)',
              position: 'relative', zIndex: 1,
              flexShrink: 0,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center',
                background: 'rgba(8,8,20,0.85)',
                border: `1px solid ${input.trim() ? 'rgba(45,212,191,0.30)' : 'rgba(255,255,255,0.10)'}`,
                borderRadius: '999px',
                padding: '5px 5px 5px 14px',
                gap: '8px',
                transition: 'border-color 0.2s',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
              }}
                onFocus={() => {}}
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !loading) handleSend() }}
                  disabled={loading}
                  placeholder="Ask Clark anything…"
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: '#e2e8f0',
                    fontSize: '12px',
                    fontFamily: 'var(--font-inter), Inter, sans-serif',
                    opacity: loading ? 0.5 : 1,
                    minWidth: 0,
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={loading || !input.trim()}
                  style={{
                    width: '30px', height: '30px',
                    borderRadius: '50%',
                    border: 'none',
                    background: loading || !input.trim()
                      ? 'rgba(45,212,191,0.12)'
                      : '#2DD4BF',
                    color: loading || !input.trim() ? 'rgba(45,212,191,0.35)' : '#04101a',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                    transition: 'background 0.15s, color 0.15s',
                    flexShrink: 0,
                    boxShadow: input.trim() ? '0 0 12px rgba(45,212,191,0.40)' : 'none',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2"
                      strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>}

      </div>
    </>
  )
}
