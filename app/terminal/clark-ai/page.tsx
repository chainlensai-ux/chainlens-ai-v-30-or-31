'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'next/navigation'

type Message = { role: 'user' | 'clark'; text: string }

function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return 'ssr'
  const key = 'chainlens:clark-session-id'
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem(key, id)
  }
  return id
}
function getClientClarkContext() {
  if (typeof window === 'undefined') return {}
  try {
    return {
      lastMomentumList: JSON.parse(sessionStorage.getItem('chainlens:clark:last-momentum-list') ?? 'null') ?? undefined,
      lastToken: JSON.parse(sessionStorage.getItem('chainlens:clark:last-token') ?? 'null') ?? undefined,
      lastWallet: JSON.parse(sessionStorage.getItem('chainlens:clark:last-wallet') ?? 'null') ?? undefined,
    }
  } catch { return {} }
}
type ClarkContextState = {
  lastMarketList?: Array<{
    rank: number
    symbol: string
    name?: string | null
    tokenAddress?: string | null
    poolAddress?: string | null
    reasonTag?: string | null
    price?: number | null
    liquidity?: number | null
    volume24h?: number | null
    change24h?: number | null
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

type Mode = {
  key: 'token' | 'wallet' | 'contract' | 'radar'
  label: string
  helper: string
  prompt: string
  icon: string
}

const MODES: Mode[] = [
  {
    key: 'token',
    label: 'Token Analysis',
    helper: 'Evaluate token quality, momentum, and risk on Base.',
    prompt: 'Analyze this Base token and give me WATCH, AVOID, or SCAN DEEPER with key reasons.',
    icon: '◈',
  },
  {
    key: 'wallet',
    label: 'Wallet Analysis',
    helper: 'Break down holdings, behavior, concentration, and recent activity.',
    prompt: 'Analyze this Base wallet. Focus on behavior, concentration risk, and recent activity.',
    icon: '◎',
  },
  {
    key: 'contract',
    label: 'Contract Risk',
    helper: 'Review privilege flags, liquidity traps, and suspicious mechanics.',
    prompt: 'Run a contract risk analysis on this Base token contract. Highlight red flags clearly.',
    icon: '⚠',
  },
  {
    key: 'radar',
    label: 'Base Radar',
    helper: 'Use imported Base Radar signal context for a concise verdict.',
    prompt: 'Use my imported Base Radar context and give a concise WATCH / AVOID / SCAN DEEPER verdict.',
    icon: '⟲',
  },
]

const SUGGESTED_PROMPTS = [
  'What\'s pumping on Base?',
  'Scan BRETT',
  'Show Base whales',
  'Liquidity check AERO',
  'Who deployed VIRTUAL?',
  'Scan wallet 0x...',
]

const EMPTY_STATE_CHIPS = [
  {
    label: 'What\'s pumping on Base?',
    prompt: 'What\'s pumping on Base?',
  },
  {
    label: 'Scan BRETT',
    prompt: 'Scan BRETT',
  },
  {
    label: 'Liquidity check AERO',
    prompt: 'Liquidity check AERO',
  },
]
const FALLBACK_ERROR_MESSAGE = 'Clark is unavailable right now. Try again in a moment.'
const THINKING_MESSAGE = 'Clark is thinking...'

function decodePrompt(value: string | null): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function ClarkOrb({ size = 44, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <div className={`clark-orb-shell${thinking ? ' thinking' : ''}`} style={{ width: size, height: size }}>
      <div className='clark-orb-ring' />
      <div className='clark-orb-core'>
        <span className='clark-orb-dot clark-orb-dot-a' />
        <span className='clark-orb-dot clark-orb-dot-b' />
      </div>
    </div>
  )
}

function ClarkAiContent() {
  const searchParams = useSearchParams()
  const importedPrompt = useMemo(() => decodePrompt(searchParams.get('prompt')), [searchParams])
  const autoSendRequested = searchParams.get('autoSend') === '1' || searchParams.get('autosend') === '1'
  const [messages, setMessages] = useState<Message[]>([])
  const [activeMode, setActiveMode] = useState<Mode['key']>(importedPrompt ? 'radar' : 'token')
  const [input, setInput] = useState(importedPrompt ?? '')
  const [loading, setLoading] = useState(false)
  const clarkContextRef = useRef<ClarkContextState>({})
  const autoSentRef = useRef(false)

  useEffect(() => {
    if (importedPrompt) {
      queueMicrotask(() => {
        setInput((prev) => (prev.trim() ? prev : importedPrompt))
        setActiveMode('radar')
      })
    }
  }, [importedPrompt])

  const activeModeConfig = MODES.find((mode) => mode.key === activeMode) ?? MODES[0]

  function applyMode(mode: Mode) {
    setActiveMode(mode.key)
    setInput((prev) => (prev.trim() ? prev : mode.prompt))
  }

  function handleImportFromRadar() {
    if (importedPrompt) {
      setInput(importedPrompt)
      setActiveMode('radar')
      return
    }
    const fallback = 'Import the most recent Base Radar context and provide a concise risk-aware verdict.'
    setInput(fallback)
    setActiveMode('radar')
  }

  function handlePasteContract() {
    setInput('I want a contract risk analysis on Base. Contract: 0x... (paste contract)')
    setActiveMode('contract')
  }

  function handlePasteWallet() {
    setInput('I want a wallet analysis on Base. Wallet: 0x... (paste wallet)')
    setActiveMode('wallet')
  }

  function handleClear() {
    setMessages([])
    setInput('')
  }

  async function handleSendText(raw: string) {
    const text = raw.trim()
    if (!text || loading) return

    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'clark', text: THINKING_MESSAGE }])
    setInput('')
    setLoading(true)

    try {
      const history = [...messages, { role: 'user', text }]
        .slice(-10)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
      if (process.env.NODE_ENV === 'development') {
        console.log('[clark] request context', {
          moversCount: clarkContextRef.current.lastMarketList?.length ?? 0,
          lastSelectedRank: clarkContextRef.current.lastSelectedRank ?? null,
        })
      }
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-clark-session': getOrCreateSessionId() },
        body: JSON.stringify({
          feature: 'clark-ai',
          message: text,
          prompt: text,
          mode: 'unified',
          uiModeHint: activeMode,
          context: null,
          history,
          clarkContext: clarkContextRef.current,
          recentMovers: clarkContextRef.current.lastMarketList ?? [],
          moversContext: { items: clarkContextRef.current.lastMarketList ?? [] },
          marketContext: { items: clarkContextRef.current.lastMarketList ?? [] },
          clientContext: getClientClarkContext(),
        }),
      })
      const json = await res.json()
      const payload = (json.data as Record<string, unknown>) ?? {}
      const marketContext = (payload.marketContext && typeof payload.marketContext === 'object')
        ? payload.marketContext as { items?: unknown }
        : null
      const nextItems = Array.isArray(marketContext?.items) ? marketContext?.items : null
      if (nextItems && nextItems.length > 0) {
        sessionStorage.setItem('chainlens:clark:last-momentum-list', JSON.stringify(nextItems))
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
      const reply = json.ok ? (payload?.reply ?? payload?.analysis ?? payload?.response ?? 'No response.') : (json.error ?? 'Something went wrong.')
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: String(reply) }
        return next
      })
    } catch {
      setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { role: 'clark', text: FALLBACK_ERROR_MESSAGE }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  async function handleSend() {
    await handleSendText(input)
  }

  useEffect(() => {
    if (!autoSendRequested || !importedPrompt || loading || autoSentRef.current) return
    autoSentRef.current = true
    setInput(importedPrompt)
    queueMicrotask(() => {
      void handleSendText(importedPrompt)
    })
  }, [autoSendRequested, importedPrompt, loading])

  return (
    <div style={pageStyle}>
      <style>{`
        .clark-shell {
          max-width: 1280px;
          margin: 0 auto;
          padding: 30px 20px 24px;
        }
        .clark-grid-bg {
          background-image:
            linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px);
          background-size: 32px 32px;
          background-position: center;
        }
        .clark-main-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.8fr) minmax(320px, 1fr);
          gap: 18px;
          align-items: start;
        }
        .clark-panel {
          border: 1px solid rgba(148,163,184,0.18);
          border-radius: 18px;
          background: linear-gradient(180deg, rgba(15,23,42,0.72), rgba(2,6,23,0.86));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 20px 50px rgba(0,0,0,0.28);
        }
        .clark-mode-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 12px;
        }
        .clark-mode {
          border-radius: 14px;
          border: 1px solid rgba(148,163,184,0.2);
          background: linear-gradient(180deg, rgba(15,23,42,0.65), rgba(15,23,42,0.35));
          text-align: left;
          padding: 11px 12px;
          cursor: pointer;
          transition: all .2s ease;
        }
        .clark-mode:hover {
          border-color: rgba(45,212,191,0.52);
          transform: translateY(-1px) scale(1.01);
          box-shadow: 0 8px 20px rgba(3,7,18,0.45), 0 0 20px rgba(45,212,191,0.14);
        }
        .clark-mode.active {
          border-color: rgba(45,212,191,0.74);
          box-shadow: 0 0 0 1px rgba(45,212,191,0.26), 0 0 24px rgba(45,212,191,0.2), 0 0 30px rgba(139,92,246,0.14);
          background: linear-gradient(180deg, rgba(45,212,191,0.22), rgba(139,92,246,0.18));
        }
        .clark-send-button:hover:not(:disabled) {
          transform: scale(1.06);
          filter: saturate(1.1) brightness(1.06);
          box-shadow: 0 0 28px rgba(45,212,191,0.62), 0 0 36px rgba(236,72,153,0.5), 0 0 0 1px rgba(255,255,255,0.14) !important;
        }
        .clark-send-button:active:not(:disabled) {
          transform: scale(1.02);
        }
        .clark-orb-shell {
          border-radius: 999px;
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: radial-gradient(circle at 30% 25%, rgba(148,163,184,0.24), rgba(2,6,23,0.96) 62%);
          border: 1px solid rgba(148,163,184,0.34);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 0 20px rgba(45,212,191,0.22), 0 0 28px rgba(139,92,246,0.2);
          overflow: hidden;
        }
        .clark-orb-ring {
          position: absolute; inset: 3px; border-radius: 999px;
          border: 1px solid rgba(45,212,191,0.25);
          opacity: .9;
        }
        .clark-orb-core { position: relative; width: 100%; height: 100%; border-radius: 999px; }
        .clark-orb-dot { position: absolute; width: 7px; height: 7px; border-radius: 999px; filter: blur(.1px); }
        .clark-orb-dot-a { left: 34%; top: 44%; background: #67e8f9; box-shadow: 0 0 16px rgba(103,232,249,.95); animation: clarkDotA 2.4s ease-in-out infinite; }
        .clark-orb-dot-b { right: 30%; top: 44%; background: #c4b5fd; box-shadow: 0 0 16px rgba(196,181,253,.9); animation: clarkDotB 2.1s ease-in-out infinite; }
        .clark-orb-shell.thinking::after {
          content: ''; position: absolute; inset: -6px; border-radius: 999px;
          border: 1px solid rgba(45,212,191,0.22); animation: clarkPulse 1.6s ease-out infinite;
        }
        @keyframes clarkDotA { 0%,100%{ transform: translate(0,0) scale(1);} 50% { transform: translate(2px,-2px) scale(1.18);} }
        @keyframes clarkDotB { 0%,100%{ transform: translate(0,0) scale(1);} 50% { transform: translate(-2px,2px) scale(1.16);} }
        @keyframes clarkPulse { 0%{ transform: scale(.94); opacity:.7;} 100%{ transform: scale(1.08); opacity:0;} }
        @media (prefers-reduced-motion: reduce) {
          .clark-orb-dot, .clark-orb-shell.thinking::after { animation: none !important; }
        }
        @media (max-width: 1080px) {
          .clark-main-grid { grid-template-columns: 1fr; }
          .clark-mode-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 680px) {
          .clark-shell { padding-inline: 14px; padding-bottom: 96px; }
          .clark-mode-grid { grid-template-columns: 1fr; }
          .clark-input-wrap { height: auto !important; border-radius: 14px !important; flex-direction: column; align-items: stretch !important; padding: 10px !important; }
          .clark-send-button { width: 100%; }
        }
      `}</style>

      <div className='clark-shell clark-grid-bg'>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <ClarkOrb />
            <div>
              <h1 style={{ margin: 0, fontSize: '26px', letterSpacing: '-0.02em', color: '#e2e8f0' }}>Clark AI</h1>
              <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#94a3b8' }}>Base-native AI analyst for tokens, wallets, and on-chain risk.</p>
            </div>
          </div>
          <span style={liveBadgeStyle}>LIVE • Powered by CORTEX</span>
        </header>

        <div className='clark-main-grid'>
          <section>
            <div className='clark-mode-grid'>
              {MODES.map((mode) => (
                <button
                  key={mode.key}
                  className={`clark-mode${activeMode === mode.key ? ' active' : ''}`}
                  onClick={() => applyMode(mode)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ width: '30px', height: '30px', borderRadius: '10px', border: `1px solid ${activeMode === mode.key ? 'rgba(45,212,191,0.62)' : 'rgba(148,163,184,0.32)'}`, background: activeMode === mode.key ? 'linear-gradient(180deg, rgba(45,212,191,0.22), rgba(139,92,246,0.14))' : 'rgba(15,23,42,0.5)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: activeMode === mode.key ? '#99f6e4' : '#cbd5e1', boxShadow: activeMode === mode.key ? '0 0 14px rgba(45,212,191,0.28)' : 'none' }}>
                      {mode.icon}
                    </span>
                    <span style={{ fontSize: '13px', color: activeMode === mode.key ? '#99f6e4' : '#94a3b8', fontWeight: 700 }}>↗</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <p style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#e2e8f0' }}>{mode.label}</p>
                    {activeMode === mode.key && (
                      <span style={{ fontSize: '9px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.45)', borderRadius: '999px', padding: '1px 6px', letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)' }}>ACTIVE</span>
                    )}
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '11px', lineHeight: 1.35, color: '#94a3b8' }}>{mode.helper}</p>
                </button>
              ))}
            </div>

            <div className='clark-panel' style={{ borderColor: 'rgba(45,212,191,0.38)', boxShadow: '0 0 0 1px rgba(236,72,153,0.16), 0 0 48px rgba(45,212,191,0.12), 0 22px 56px rgba(0,0,0,0.35)' }}>
              <div style={{ padding: '14px 14px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                  <h2 style={{ margin: 0, fontSize: '15px', color: '#e2e8f0' }}>Ask Clark</h2>
                  <span style={{ fontSize: '10px', color: '#99f6e4', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em' }}>{activeModeConfig.label}</span>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <button onClick={handleImportFromRadar} style={chipButtonStyle}>Import from Base Radar</button>
                  <button onClick={handlePasteContract} style={chipButtonStyle}>Paste Contract</button>
                  <button onClick={handlePasteWallet} style={chipButtonStyle}>Paste Wallet</button>
                  <button onClick={handleClear} style={chipButtonStyle}>Clear</button>
                </div>

                <div style={{ height: '360px', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.10)', background: 'linear-gradient(180deg, rgba(2,6,23,0.58), rgba(2,6,23,0.80))', padding: '12px', overflowY: 'auto' }}>
                  {messages.length === 0 ? (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#94a3b8' }}>
                      <div style={{ marginBottom: '10px' }}><ClarkOrb size={58} /></div>
                      <p style={{ margin: 0, fontSize: '14px', color: '#cbd5e1' }}>Scan a token, wallet, liquidity, dev wallet, or ask what's pumping on Base.</p>
                      <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                        Clark reads token risk, wallet behavior, LP depth, deployer signals, and whale flow on Base.
                      </p>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '12px' }}>
                        {EMPTY_STATE_CHIPS.map((chip) => (
                          <button key={chip.label} onClick={() => setInput(chip.prompt)} style={emptyStateChipStyle}>
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {messages.map((msg, idx) => {
                        const isThinking = msg.role === 'clark' && loading && msg.text === THINKING_MESSAGE
                        return (<div key={idx} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', padding: '10px 11px', borderRadius: '12px', border: '1px solid', borderColor: msg.role === 'user' ? 'rgba(45,212,191,0.35)' : 'rgba(148,163,184,0.20)', background: msg.role === 'user' ? 'rgba(45,212,191,0.14)' : 'rgba(15,23,42,0.72)' }}>
                          <p style={{ margin: '0 0 4px', fontSize: '10px', color: msg.role === 'user' ? '#99f6e4' : '#94a3b8', fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.08em' }}>
                            {msg.role === 'user' ? 'YOU' : 'CLARK'}
                          </p>
                          {isThinking && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                              <ClarkOrb size={24} thinking />
                              <span style={{ fontSize: '12px', color: '#94a3b8' }}>Clark is thinking…</span>
                            </div>
                          )}
                          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.45, color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{msg.text}</p>
                        </div>)})}
                    </div>
                  )}
                </div>

                <div className="clark-input-wrap" style={{ marginTop: '12px', height: '58px', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(2,6,23,0.72)', display: 'flex', alignItems: 'center', padding: '8px 8px 8px 14px', gap: '8px', marginBottom: '14px' }}>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !loading) handleSend()
                    }}
                    disabled={loading}
                    placeholder='Ask Clark to scan a token, wallet, whale flow, liquidity, dev wallet, or Base movers.'
                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e2e8f0', fontSize: '14px' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={loading || !input.trim()}
                    className='clark-send-button'
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '999px',
                      border: 'none',
                      background: loading || !input.trim() ? 'rgba(148,163,184,0.28)' : 'linear-gradient(135deg, #2DD4BF 0%, #8B5CF6 55%, #EC4899 100%)',
                      color: loading || !input.trim() ? '#475569' : '#f8fafc',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                      fontSize: '17px',
                      boxShadow: loading || !input.trim() ? 'inset 0 1px 1px rgba(255,255,255,0.08)' : '0 0 24px rgba(45,212,191,0.55), 0 0 32px rgba(236,72,153,0.44), 0 0 0 1px rgba(255,255,255,0.12)',
                      transition: 'transform .16s ease, box-shadow .16s ease, filter .16s ease',
                    }}
                    aria-label='Send prompt'
                  >
                    ↗
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside style={{ display: 'grid', gap: '10px' }}>
            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>Context</p>
              {importedPrompt ? (
                <>
                  <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#c4b5fd' }}>Imported from Base Radar</p>
                  <div style={contextPreviewStyle}>{importedPrompt}</div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>No context imported.</p>
              )}
            </div>

            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>Analysis Modes</p>
              <div style={{ display: 'grid', gap: '7px' }}>
                {MODES.map((mode) => (
                  <button
                    key={`aside-${mode.key}`}
                    onClick={() => applyMode(mode)}
                    style={{
                      ...asideButtonStyle,
                      borderColor: activeMode === mode.key ? 'rgba(45,212,191,0.7)' : 'rgba(148,163,184,0.2)',
                      background: activeMode === mode.key ? 'linear-gradient(180deg, rgba(45,212,191,0.18), rgba(139,92,246,0.14))' : 'rgba(15,23,42,0.5)',
                      color: activeMode === mode.key ? '#99f6e4' : '#cbd5e1',
                      boxShadow: activeMode === mode.key ? '0 0 0 1px rgba(45,212,191,0.18), 0 0 16px rgba(45,212,191,0.12)' : 'none',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                      {activeMode === mode.key && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2dd4bf', boxShadow: '0 0 10px rgba(45,212,191,0.75)' }} />}
                      {mode.label}
                      {activeMode === mode.key && (
                        <span style={{ fontSize: '9px', color: '#99f6e4', border: '1px solid rgba(45,212,191,0.45)', borderRadius: '999px', padding: '1px 6px', letterSpacing: '0.08em', fontFamily: 'var(--font-plex-mono)' }}>ACTIVE</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>CORTEX Status</p>
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '6px' }}>
                {['Online', 'Base data enabled', 'CoinGecko Terminal active', 'Clark ready'].map((item) => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#cbd5e1' }}>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2dd4bf', boxShadow: '0 0 10px rgba(45,212,191,0.8)' }} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className='clark-panel' style={{ padding: '12px' }}>
              <p style={asideTitleStyle}>Suggested Prompts</p>
              <div style={{ display: 'grid', gap: '7px' }}>
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button key={prompt} onClick={() => setInput(prompt)} style={asideButtonStyle}>{prompt}</button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

const pageStyle: CSSProperties = {
  height: '100%',
  overflowY: 'auto',
  overflowX: 'hidden',
  color: '#e2e8f0',
  background:
    'radial-gradient(circle at 12% 12%, rgba(45,212,191,0.16), transparent 40%), radial-gradient(circle at 86% 10%, rgba(236,72,153,0.14), transparent 40%), radial-gradient(circle at 60% 0%, rgba(139,92,246,0.20), transparent 36%), linear-gradient(180deg, #030712 0%, #040815 45%, #030611 100%)',
}


const chipButtonStyle: CSSProperties = {
  borderRadius: '999px',
  border: '1px solid rgba(148,163,184,0.28)',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
  color: '#cbd5e1',
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.08em',
  padding: '7px 12px',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-plex-mono)',
  cursor: 'pointer',
}

const emptyStateChipStyle: CSSProperties = {
  borderRadius: '999px',
  border: '1px solid rgba(148,163,184,0.28)',
  background: 'rgba(15,23,42,0.65)',
  color: '#cbd5e1',
  fontSize: '11px',
  padding: '6px 11px',
  cursor: 'pointer',
  transition: 'border-color .16s ease, box-shadow .16s ease',
}

const liveBadgeStyle: CSSProperties = {
  borderRadius: '999px',
  border: '1px solid rgba(45,212,191,0.34)',
  background: 'rgba(45,212,191,0.10)',
  color: '#99f6e4',
  fontSize: '10px',
  letterSpacing: '0.1em',
  fontFamily: 'var(--font-plex-mono)',
  padding: '5px 10px',
  whiteSpace: 'nowrap',
}

const asideTitleStyle: CSSProperties = {
  margin: '0 0 10px',
  fontSize: '11px',
  color: '#94a3b8',
  letterSpacing: '0.08em',
  fontFamily: 'var(--font-plex-mono)',
  textTransform: 'uppercase',
}

const asideButtonStyle: CSSProperties = {
  width: '100%',
  borderRadius: '10px',
  border: '1px solid rgba(148,163,184,0.2)',
  background: 'rgba(15,23,42,0.5)',
  color: '#cbd5e1',
  fontSize: '12px',
  textAlign: 'left',
  padding: '8px 10px',
  cursor: 'pointer',
}

const contextPreviewStyle: CSSProperties = {
  borderRadius: '10px',
  border: '1px solid rgba(196,181,253,0.34)',
  background: 'rgba(196,181,253,0.08)',
  color: '#ddd6fe',
  fontSize: '12px',
  lineHeight: 1.4,
  padding: '8px 10px',
  maxHeight: '84px',
  display: '-webkit-box',
  WebkitLineClamp: 4,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

export default function ClarkAiPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading Clark AI...</div>}>
      <ClarkAiContent />
    </Suspense>
  )
}
