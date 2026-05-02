'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

const HINT_CHIPS = [
  "What's pumping on Base?",
  'Scan a Base wallet',
  'New Base deployments',
  'Show Base whales',
]

interface Message {
  role: 'user' | 'clark'
  text: string
}
type ClarkMode = 'chat' | 'analyst'
type ClarkContextState = {
  lastMarketList?: Array<{
    rank: number
    symbol: string
    name?: string | null
    tokenAddress?: string | null
    poolAddress?: string | null
    reasonTag?: string | null
  }>
  lastIntent?: string | null
  previousIntent?: string | null
  lastSelectedRank?: number | null
  marketCursor?: {
    offset: number
    returnedCount: number
    requestedCount: number
    totalCandidates: number
  } | null
  seenMarketAddresses?: string[]
  seenMarketSymbols?: string[]
}

// Try to pull a token name from a message like "is brett safe?" or "toshi price"
function extractTokenQuery(text: string): string | null {
  const t = text.toLowerCase()
  const STOP = new Set(['a', 'an', 'the', 'this', 'that', 'it', 'is', 'are', 'be', 'me', 'my',
    'on', 'in', 'of', 'to', 'and', 'or', 'so', 'do', 'for', 'going', 'doing', 'there', 'here'])

  const cmd = t.match(/\b(?:scan|check|analyze|info\s+on|about)\s+([a-z][a-z0-9]{1,15})\b/)
  if (cmd && !STOP.has(cmd[1])) return cmd[1]

  const before = t.match(/\b([a-z][a-z0-9]{1,15})\s+(?:price|liquidity|volume|safe|safety|pools?|rug|chart|cap|analysis|pumping)\b/)
  if (before && !STOP.has(before[1])) return before[1]

  const afterIs = t.match(/\bis\s+([a-z][a-z0-9]{1,15})\b/)
  if (afterIs && !STOP.has(afterIs[1])) return afterIs[1]

  return null
}

function isMobileClient() {
  return typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
}

const WALLET_INTENT = /\b(wallet|balance|balances|holdings?|portfolio|hold\b|holds\b|copy[\s-]?trade?|copytrade|follow|smart\s+money|good\s+wallet|whale\s+wallet|wallet\s+quality)\b/i
const MARKET_INTENT = /\b(pumping|pump(?:ing)?|hot\b|moving\b|movers?|gainers?|runners?|new\s+launches?|new\s+tokens?|what\s+should\s+i\s+watch|what'?s\s+on\s+base)\b/i

function parseMessage(raw: string, clarkMode: ClarkMode): Record<string, string> {
  const t = raw.trim().toLowerCase()
  const addrMatch = raw.match(/0x[a-fA-F0-9]{40}/)
  const address = addrMatch?.[0]

  if (clarkMode === 'chat') {
    if (address) {
      // Wallet intent (balance/holdings/portfolio/wallet keywords) → wallet-scanner
      if (WALLET_INTENT.test(t)) {
        if (t.includes('dev wallet')) return { feature: 'dev-wallet-detector', tokenAddress: address, prompt: raw.trim() }
        return { feature: 'wallet-scanner', walletAddress: address, prompt: raw.trim() }
      }
      // Explicit scan keywords → scan-token
      const explicitScan = /\b(scan|analy[sz]e|check|risk|verdict|liquidity)\b/i.test(t)
      if (explicitScan) return { feature: 'scan-token', tokenAddress: address, prompt: raw.trim() }
    }
    return { feature: 'clark-ai', prompt: raw.trim() }
  }

  // Explicit wallet commands
  if (t.startsWith('scan wallet') && address)
    return { feature: 'wallet-scanner', walletAddress: address, prompt: raw.trim() }
  if (t.startsWith('dev wallet') && address)
    return { feature: 'dev-wallet-detector', tokenAddress: address }
  if (t.includes('whale') && address)
    return { feature: 'whale-alerts', walletAddress: address }

  // Wallet intent + address — higher priority than market check
  if (address && WALLET_INTENT.test(t))
    return { feature: 'wallet-scanner', walletAddress: address, prompt: raw.trim() }

  // Market / radar
  if (t.startsWith('base radar') || t.includes('trending') || t.includes('deployments') || t.includes('whales') || MARKET_INTENT.test(t))
    return { feature: 'base-radar' }

  // Bare address → scan-token
  if (address)
    return { feature: 'scan-token', tokenAddress: address, prompt: raw.trim() }

  // Token name + signal keyword → scan-token
  const TOKEN_SIGNALS = /\b(price|liquidity|volume|safe|safety|pools?|rug|trap|pump|pumping|dump|degen|volatile|volatility|risk|cap|chart|scan|check|analyze|analysis|verdict)\b/i
  if (TOKEN_SIGNALS.test(t)) {
    const name = extractTokenQuery(t)
    if (name) return { feature: 'scan-token', query: name, prompt: raw.trim() }
  }

  return { feature: 'clark-ai', prompt: raw.trim() }
}

function formatResponse(data: Record<string, unknown>): string {
  if (typeof data?.analysis === 'string') return data.analysis
  return JSON.stringify(data, null, 2)
}

interface ClarkRadarProps {
  onSelectRadar?: (val: string) => void
  pendingMessage?: string | null
}

export default function ClarkRadar({ onSelectRadar: _onSelectRadar, pendingMessage }: ClarkRadarProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [clarkMode, setClarkMode] = useState<ClarkMode>('chat')
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastSentRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const clarkContextRef = useRef<ClarkContextState>({})

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const sendToClark = useCallback(async (text: string) => {
    setMessages(prev => [...prev, { role: 'user', text }])
    setLoading(true)
    setMessages(prev => [...prev, { role: 'clark', text: 'Clark is thinking...' }])

    try {
      const body = parseMessage(text, clarkMode)
      const requestMode = body.feature === 'clark-ai' ? clarkMode : 'analyst'
      const history = [...messages, { role: 'user', text }]
        .slice(-30)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
      const res = await fetch(`/api/clark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          message: text,
          mode: requestMode,
          uiModeHint: clarkMode,
          context: null,
          history,
          clarkContext: clarkContextRef.current,
        }),
      })
      const json = await res.json()
      const payload = (json.data as Record<string, unknown>) ?? {}
      const marketContext = (payload.marketContext && typeof payload.marketContext === 'object')
        ? payload.marketContext as { items?: unknown }
        : null
      const nextItems = Array.isArray(marketContext?.items) ? marketContext?.items : null
      if (nextItems && nextItems.length > 0) {
        clarkContextRef.current.lastMarketList = nextItems as ClarkContextState['lastMarketList']
        const addrSet = new Set((clarkContextRef.current.seenMarketAddresses ?? []).map((x) => x.toLowerCase()))
        const symSet = new Set((clarkContextRef.current.seenMarketSymbols ?? []).map((x) => x.toUpperCase()))
        for (const item of nextItems as Array<Record<string, unknown>>) {
          const token = typeof item.tokenAddress === 'string' ? item.tokenAddress.toLowerCase() : null
          const pool = typeof item.poolAddress === 'string' ? item.poolAddress.toLowerCase() : null
          const sym = typeof item.symbol === 'string' ? item.symbol.toUpperCase() : null
          if (token) addrSet.add(token)
          if (pool) addrSet.add(pool)
          if (sym) symSet.add(sym)
        }
        clarkContextRef.current.seenMarketAddresses = [...addrSet]
        clarkContextRef.current.seenMarketSymbols = [...symSet]
      }
      const cursor = (marketContext && typeof marketContext === 'object' && (marketContext as Record<string, unknown>).cursor && typeof (marketContext as Record<string, unknown>).cursor === 'object')
        ? (marketContext as Record<string, unknown>).cursor as ClarkContextState['marketCursor']
        : null
      if (cursor) clarkContextRef.current.marketCursor = cursor
      clarkContextRef.current.previousIntent = clarkContextRef.current.lastIntent ?? null
      clarkContextRef.current.lastIntent = typeof payload.intent === 'string' ? payload.intent : clarkContextRef.current.lastIntent
      clarkContextRef.current.lastSelectedRank = /\b([1-9]\d{0,2})\b/.test(text) ? Number(text.match(/\b([1-9]\d{0,2})\b/)?.[1] ?? 0) || null : clarkContextRef.current.lastSelectedRank
      const reply = json.ok
        ? String(payload?.reply ?? formatResponse(payload))
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
  }, [clarkMode, messages])

  useEffect(() => {
    if (pendingMessage && pendingMessage !== lastSentRef.current) {
      lastSentRef.current = pendingMessage
      setClarkMode('analyst')
      sendToClark(pendingMessage)
    }
  }, [pendingMessage, sendToClark])

  function handleSend() {
    const text = input.trim()
    if (!text || loading) return
    if (isMobileClient()) {
      window.location.href = `/terminal/clark-ai?prompt=${encodeURIComponent(text)}&autosend=1`
      return
    }
    setInput('')
    sendToClark(text)
  }

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
        .clark-mode-toggle {
          display: inline-flex;
          gap: 5px;
          padding: 3px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(10,12,26,0.74);
        }
        .clark-mode-btn {
          border: none;
          border-radius: 999px;
          padding: 5px 9px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.55);
          background: transparent;
          cursor: pointer;
          transition: all 0.2s ease;
          white-space: nowrap;
        }
        .clark-mode-btn.active {
          color: #e2e8f0;
          background: linear-gradient(90deg, rgba(45,212,191,0.22), rgba(139,92,246,0.22));
          box-shadow: 0 0 12px rgba(45,212,191,0.24), 0 0 12px rgba(139,92,246,0.18);
        }
        @keyframes radarSendGlow {
          0%, 100% { box-shadow: 0 0 10px rgba(236,72,153,0.42), 0 0 6px rgba(139,92,246,0.30); }
          50%       { box-shadow: 0 0 22px rgba(236,72,153,0.72), 0 0 16px rgba(139,92,246,0.52), 0 0 30px rgba(236,72,153,0.20); }
        }
        @keyframes radarArrowPulse {
          0%, 100% { opacity: 1; transform: translateX(0); }
          50%       { opacity: 0.60; transform: translateX(1.5px); }
        }
        .clark-radar-send {
          animation: radarSendGlow 3s ease-in-out infinite;
          transition: transform 0.15s;
        }
        .clark-radar-send:hover {
          transform: scale(1.12);
          box-shadow: 0 0 28px rgba(236,72,153,0.82), 0 0 18px rgba(139,92,246,0.62) !important;
          animation: none;
        }
        .clark-radar-arrow { animation: radarArrowPulse 2.5s ease-in-out infinite; display: inline-flex; }
        .clark-radar-scroll::-webkit-scrollbar { width: 3px; }
        .clark-radar-scroll::-webkit-scrollbar-thumb {
          background: rgba(123,92,255,0.30);
          border-radius: 3px;
        }
        @keyframes radarThinkingDot {
          0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
          40%            { opacity: 1;   transform: translateY(-3px); }
        }
        .radar-dot { display: inline-block; animation: radarThinkingDot 1.2s ease-in-out infinite; }
        .radar-dot:nth-child(2) { animation-delay: 0.15s; }
        .radar-dot:nth-child(3) { animation-delay: 0.30s; }
        @keyframes clarkOrbFloat {
          0%,100% { transform: translateY(0px) scale(1); }
          50% { transform: translateY(-2px) scale(1.02); }
        }
        @keyframes clarkRadarPulse {
          0%,100% { opacity: 0.28; transform: scale(0.96); }
          50% { opacity: 0.55; transform: scale(1.04); }
        }
        .clark-orb { position: relative; border-radius: 999px; animation: clarkOrbFloat 4s ease-in-out infinite; }
        .clark-orb::before {
          content: ''; position: absolute; inset: -5px; border-radius: inherit;
          background: radial-gradient(circle, rgba(45,212,191,0.20) 0%, rgba(139,92,246,0.08) 52%, transparent 72%);
          opacity: 0; transform: scale(.95); pointer-events: none;
        }
        .clark-orb-thinking::before { animation: clarkRadarPulse 1.8s ease-in-out infinite; opacity: 1; }
        .clark-msg p { margin: 0; }
        .clark-msg strong { color: #e2e8f0; font-weight: 600; }
        .clark-msg-label { color: #c4b5fd; font-weight: 600; letter-spacing: 0.01em; }
        @media (prefers-reduced-motion: reduce) {
          .clark-orb, .clark-orb::before, .radar-dot, .clark-radar-send, .clark-radar-arrow { animation: none !important; }
        }
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
            padding: '0 12px',
            height: '44px',
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
                borderRadius: '50%',
                background: 'radial-gradient(circle at 35% 30%, rgba(17,24,39,0.98) 0%, rgba(8,13,30,0.97) 100%)',
                border: '1px solid rgba(103,232,249,0.40)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: 'inset 0 0 0 1px rgba(167,139,250,0.24), 0 0 14px rgba(139,92,246,0.26)',
                flexShrink: 0,
              }}
>
              <div style={{ position: 'absolute', inset: '5px', borderRadius: '50%', border: '1px solid rgba(167,139,250,0.24)' }} />
              <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 7px rgba(34,211,238,0.8)' }} />
              <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 7px rgba(192,132,252,0.78)', marginLeft: '4px' }} />
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className='clark-mode-toggle'>
              <button type='button' className={`clark-mode-btn ${clarkMode === 'chat' ? 'active' : ''}`} onClick={() => setClarkMode('chat')}>
                Chat
              </button>
              <button type='button' className={`clark-mode-btn ${clarkMode === 'analyst' ? 'active' : ''}`} onClick={() => setClarkMode('analyst')}>
                Analyst
              </button>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                background: 'rgba(139,92,246,0.09)',
                border: '1px solid rgba(139,92,246,0.22)',
                borderRadius: '100px',
                padding: '3px 9px',
                boxShadow: '0 0 10px rgba(139,92,246,0.12)',
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
        </div>

        {/* ── Messages area ───────────────────────────────── */}
        <div
          ref={scrollRef}
          className="clark-radar-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {messages.length === 0 ? (
            /* Empty state */
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
                className="clark-orb"
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 30% 28%, rgba(15,23,42,0.98) 0%, rgba(6,10,28,0.98) 100%)',
                  border: '1px solid rgba(103,232,249,0.34)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 22px rgba(139,92,246,0.18), 0 0 10px rgba(236,72,153,0.10)',
                }}
              >
                <div style={{ position: 'absolute', inset: '8px', borderRadius: '50%', border: '1px solid rgba(167,139,250,0.25)' }} />
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 10px rgba(34,211,238,0.72)' }} />
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 10px rgba(192,132,252,0.70)', marginLeft: '5px' }} />
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
                    onClick={() => sendToClark(chip)}
                  >
                    <span style={{ color: 'rgba(192,132,252,0.65)', fontSize: '11px', flexShrink: 0 }}>→</span>
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Message list */
            <>
              {messages.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  {msg.role === 'clark' && (
                    <div className={`clark-orb ${msg.text === 'Clark is thinking...' ? 'clark-orb-thinking' : ''}`} style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      background: 'radial-gradient(circle at 30% 30%, rgba(15,23,42,0.98) 0%, rgba(6,10,28,0.98) 100%)',
                      flexShrink: 0,
                      marginRight: '6px',
                      alignSelf: 'flex-end',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <div className={msg.role === 'clark' ? 'clark-msg' : undefined} style={{ position: 'absolute', inset: '3px', borderRadius: '50%', border: '1px solid rgba(167,139,250,0.26)' }} />
                      <div className={msg.role === 'clark' ? 'clark-msg' : undefined} style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 6px rgba(34,211,238,0.75)' }} />
                      <div className={msg.role === 'clark' ? 'clark-msg' : undefined} style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 6px rgba(192,132,252,0.72)', marginLeft: '3px' }} />
                    </div>
                  )}
                  <div className={msg.role === 'clark' ? 'clark-msg' : undefined} style={{
                    maxWidth: '82%',
                    padding: '9px 12px',
                    borderRadius: msg.role === 'user'
                      ? '12px 12px 3px 12px'
                      : '12px 12px 12px 3px',
                    background: msg.role === 'user'
                      ? 'rgba(45,212,191,0.10)'
                      : 'rgba(123,92,255,0.10)',
                    border: `1px solid ${msg.role === 'user'
                      ? 'rgba(45,212,191,0.18)'
                      : 'rgba(123,92,255,0.18)'}`,
                    color: msg.text === 'Clark is thinking...'
                      ? 'rgba(255,255,255,0.40)'
                      : '#dde4f0',
                    fontSize: '12px',
                    lineHeight: 1.65,
                    fontFamily: msg.text.startsWith('{') || msg.text.startsWith('[')
                      ? 'var(--font-plex-mono)'
                      : 'var(--font-inter), Inter, sans-serif',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                  }}>
                    {msg.text === 'Clark is thinking...' ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                        <span className="clark-orb clark-orb-thinking" style={{ width: '16px', height: '16px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span style={{ width: '3.5px', height: '3.5px', borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 6px rgba(34,211,238,0.75)' }} />
                          <span style={{ width: '3.5px', height: '3.5px', borderRadius: '50%', background: '#c084fc', boxShadow: '0 0 6px rgba(192,132,252,0.72)', marginLeft: '2px' }} />
                        </span>
                        Clark is thinking
                        <span className="radar-dot" style={{ marginLeft: '2px' }}>.</span>
                        <span className="radar-dot">.</span>
                        <span className="radar-dot">.</span>
                      </span>
                    ) : msg.role === 'clark' ? msg.text.split('\n').map((line, idx) => { const cleaned = line.trimStart(); const labels = ["Clark's read:", 'Next:', 'Top movers', 'Verdict:', 'Risk:']; const hit = labels.find((l) => cleaned.toLowerCase().startsWith(l.toLowerCase())); return <p key={idx}>{hit ? <><span className='clark-msg-label'>{line.slice(0, line.indexOf(':') + 1)}</span>{line.slice(line.indexOf(':') + 1)}</> : line || <span>&nbsp;</span>}</p> }) : msg.text}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── Input footer ────────────────────────────────── */}
        <div
          style={{
            flexShrink: 0,
            padding: '6px 10px 10px',
            borderTop: '1px solid rgba(139,92,246,0.12)',
            background: 'rgba(8,10,20,0.80)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              background: 'linear-gradient(135deg, rgba(5,8,22,0.65) 0%, rgba(45,212,191,0.04) 55%, rgba(139,92,246,0.03) 100%)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: '11px',
              padding: '7px 7px 7px 12px',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
              boxShadow: 'inset 0 0 20px rgba(45,212,191,0.08), inset 0 0 14px rgba(236,72,153,0.06), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 16px rgba(139,92,246,0.10), 0 0 8px rgba(45,212,191,0.06)',
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !loading) handleSend() }}
              disabled={loading}
              placeholder={clarkMode === 'chat' ? 'Ask Clark...' : 'Paste Base contract/wallet to analyze...'}
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
                opacity: loading ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className={input.trim() && !loading ? 'clark-radar-send' : undefined}
              style={{
                flexShrink: 0,
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: input.trim() && !loading
                  ? 'linear-gradient(135deg, #ec4899, #8b5cf6)'
                  : 'rgba(255,255,255,0.05)',
                border: input.trim() && !loading
                  ? '1px solid rgba(236,72,153,0.40)'
                  : '1px solid rgba(255,255,255,0.07)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: input.trim() && !loading ? 'pointer' : 'default',
              }}
            >
              <span className={input.trim() && !loading ? 'clark-radar-arrow' : undefined} style={{ display: 'inline-flex' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke={input.trim() && !loading ? '#fff' : 'rgba(255,255,255,0.22)'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
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
