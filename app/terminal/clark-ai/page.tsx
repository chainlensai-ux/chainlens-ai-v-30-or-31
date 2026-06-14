'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

// ── Types ─────────────────────────────────────────────────────────────────────
type ClarkAction = { label: string; href: string; requiresInput?: boolean }
type Message = { role: 'user' | 'clark'; text: string; intentBadge?: string | null; actions?: ClarkAction[] }
type UiTab   = 'analyst' | 'chat'

// ── Session / context helpers (unchanged) ────────────────────────────────────
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
      lastToken:        JSON.parse(sessionStorage.getItem('chainlens:clark:last-token') ?? 'null') ?? undefined,
      lastWallet:       JSON.parse(sessionStorage.getItem('chainlens:clark:last-wallet') ?? 'null') ?? undefined,
      lastMomentumShownCount: Number(sessionStorage.getItem('chainlens:clark:last-momentum-shown-count') ?? '0') || 0,
    }
  } catch { return {} }
}
type ClarkContextState = {
  lastMarketList?: Array<{
    rank: number; symbol: string; name?: string | null; tokenAddress?: string | null
    poolAddress?: string | null; reasonTag?: string | null; price?: number | null
    liquidity?: number | null; volume24h?: number | null; change24h?: number | null
  }>
  lastIntent?: string | null; previousIntent?: string | null
  lastSelectedRank?: number | null
  marketCursor?: { offset: number; returnedCount: number; requestedCount: number; totalCandidates: number } | null
  seenMarketAddresses?: string[]; seenMarketSymbols?: string[]
}

// ── Mode config (unchanged — used internally for API uiModeHint) ──────────────
type Mode = { key: 'token' | 'wallet' | 'contract' | 'radar'; label: string; helper: string; prompt: string; icon: string }
const MODES: Mode[] = [
  { key: 'token',    label: 'Token Analysis', helper: 'Evaluate token quality, momentum, and risk on Base.',          prompt: 'Analyze this Base token and give me WATCH, AVOID, or SCAN DEEPER with key reasons.', icon: '◈' },
  { key: 'wallet',   label: 'Wallet Analysis', helper: 'Break down holdings, behavior, concentration, and recent activity.', prompt: 'Analyze this Base wallet. Focus on behavior, concentration risk, and recent activity.', icon: '◎' },
  { key: 'contract', label: 'Contract Risk',   helper: 'Review privilege flags, liquidity traps, and suspicious mechanics.', prompt: 'Run a contract risk analysis on this Base token contract. Highlight red flags clearly.', icon: '⚠' },
  { key: 'radar',    label: 'Base Radar',       helper: 'Use imported Base Radar signal context for a concise verdict.',       prompt: 'Use my imported Base Radar context and give a concise WATCH / AVOID / SCAN DEEPER verdict.', icon: '⟲' },
]

// ── UI chips per tab ─────────────────────────────────────────────────────────
const ANALYST_CHIPS = [
  { label: "What's pumping on Base?", prompt: "What's pumping on Base?" },
  { label: 'Scan wallet',             prompt: 'Scan wallet '             },
  { label: 'Check liquidity',         prompt: 'Check liquidity '         },
  { label: 'Analyze token',           prompt: 'Analyze token '           },
]
const CHAT_CHIPS = [
  { label: 'Who deployed VIRTUAL?',  prompt: 'Who deployed VIRTUAL?'         },
  { label: 'Show Base whales',        prompt: 'Show Base whales'              },
  { label: 'Top movers today',        prompt: 'Top movers on Base today'       },
  { label: 'Base activity',           prompt: 'Latest activity on Base?'      },
]

// ── Usage helpers (unchanged) ────────────────────────────────────────────────
const FALLBACK_ERROR_MESSAGE = 'Clark is unavailable right now. Try again in a moment.'
const THINKING_MESSAGE       = 'Clark is thinking...'
const CLARK_DAILY_LIMITS: Record<string, number> = { free: 5, pro: 50, elite: 300 }
const CLARK_LIMIT_UNAUTH = 3
function getTodayStr() { return new Date().toISOString().slice(0, 10) }
function readClarkUsage(): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = localStorage.getItem('chainlens:clark:daily-usage')
    if (!raw) return 0
    const { date, count } = JSON.parse(raw) as { date: string; count: number }
    return date === getTodayStr() ? (count || 0) : 0
  } catch { return 0 }
}
function bumpClarkUsage(): number {
  try {
    const next = readClarkUsage() + 1
    localStorage.setItem('chainlens:clark:daily-usage', JSON.stringify({ date: getTodayStr(), count: next }))
    return next
  } catch { return 0 }
}
function decodePrompt(value: string | null): string | null {
  if (!value) return null
  try { return decodeURIComponent(value) } catch { return value }
}

// ── Clark Orb (unchanged visual) ─────────────────────────────────────────────
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

// ── Main content ─────────────────────────────────────────────────────────────
function ClarkAiContent() {
  const pathname          = usePathname()
  const searchParams      = useSearchParams()
  const importedPrompt    = useMemo(() => decodePrompt(searchParams.get('prompt')), [searchParams])
  const autoSendRequested = searchParams.get('autoSend') === '1' || searchParams.get('autosend') === '1'

  const [messages,  setMessages]  = useState<Message[]>([])
  const [uiTab,     setUiTab]     = useState<UiTab>('analyst')
  const [activeMode, setActiveMode] = useState<Mode['key']>(importedPrompt ? 'radar' : 'token')
  const [input,     setInput]     = useState(importedPrompt ?? '')
  const [loading,   setLoading]   = useState(false)
  const [clarkUsed, setClarkUsed] = useState(0)
  const [planLimit, setPlanLimit] = useState<number | null>(null)
  const clarkContextRef = useRef<ClarkContextState>({})
  const autoSentRef     = useRef(false)
  const threadRef       = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (importedPrompt) {
      queueMicrotask(() => {
        setInput((prev) => (prev.trim() ? prev : importedPrompt))
        setActiveMode('radar')
      })
    }
  }, [importedPrompt])

  useEffect(() => {
    setClarkUsed(readClarkUsage())
    supabase.auth.getSession().then(async ({ data }) => {
      const token = data.session?.access_token
      if (!token) { setPlanLimit(CLARK_LIMIT_UNAUTH); return }
      try {
        const res = await fetch('/api/user-settings', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) {
          const json = await res.json() as Record<string, unknown>
          const p = String(json?.plan ?? json?.effectivePlan ?? (json?.settings as Record<string, unknown>)?.plan ?? '')
          setPlanLimit(CLARK_DAILY_LIMITS[p] ?? CLARK_DAILY_LIMITS.free)
        } else { setPlanLimit(CLARK_DAILY_LIMITS.free) }
      } catch { setPlanLimit(CLARK_DAILY_LIMITS.free) }
    })
  }, [])

  // Auto-scroll thread to latest message
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [messages])

  const activeModeConfig = MODES.find((m) => m.key === activeMode) ?? MODES[0]

  function applyMode(mode: Mode) {
    setActiveMode(mode.key)
    setInput((prev) => (prev.trim() ? prev : mode.prompt))
  }
  function handleImportFromRadar() {
    if (importedPrompt) { setInput(importedPrompt); setActiveMode('radar'); return }
    setInput('Import the most recent Base Radar context and provide a concise risk-aware verdict.')
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
  function handleClear() { setMessages([]); setInput('') }

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
      const { data: { session: authSession } } = await supabase.auth.getSession()
      const accessToken = authSession?.access_token ?? null
      const clientClarkContext = getClientClarkContext()
      const appContext = {
        route: pathname,
        chain: 'base',
        selectedToken: clarkContextRef.current.lastMarketList?.[0]?.tokenAddress ?? clientClarkContext.lastToken ?? null,
        selectedWallet: clientClarkContext.lastWallet ?? null,
        baseRadarSummary: clarkContextRef.current.lastMarketList ?? clientClarkContext.lastMomentumList ?? null,
        whaleSyncStatus: typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('chainlens:whale-alerts:sync-status') ?? 'unknown' : 'unknown',
        currentTool: activeMode ?? null,
      }
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clark-session': getOrCreateSessionId(),
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          feature: 'clark-ai', message: text, prompt: text,
          mode: 'analyst', uiModeHint: activeMode,
          context: null, history,
          clarkContext: clarkContextRef.current,
          recentMovers: clarkContextRef.current.lastMarketList ?? [],
          moversContext: { items: clarkContextRef.current.lastMarketList ?? [] },
          marketContext: { items: clarkContextRef.current.lastMarketList ?? [] },
          clientContext: clientClarkContext,
          appContext,
        }),
      })
      const json = await res.json()
      if (res.status !== 429 && json.quotaConsumed !== false) setClarkUsed(bumpClarkUsage())
      const payload = (json.data as Record<string, unknown>) ?? {}
      const marketContext = (payload.marketContext && typeof payload.marketContext === 'object')
        ? payload.marketContext as { items?: unknown } : null
      const nextItems = Array.isArray(marketContext?.items) ? marketContext?.items : null
      if (nextItems && nextItems.length > 0) {
        sessionStorage.setItem('chainlens:clark:last-momentum-list', JSON.stringify(nextItems))
        sessionStorage.setItem('chainlens:clark:last-momentum-shown-count', String(Math.min(7, nextItems.length)))
        clarkContextRef.current.lastMarketList = nextItems as ClarkContextState['lastMarketList']
        const addrSet = new Set((clarkContextRef.current.seenMarketAddresses ?? []).map((x) => x.toLowerCase()))
        const symSet  = new Set((clarkContextRef.current.seenMarketSymbols ?? []).map((x) => x.toUpperCase()))
        for (const item of nextItems as Array<Record<string, unknown>>) {
          const token = typeof item.tokenAddress === 'string' ? item.tokenAddress.toLowerCase() : null
          const pool  = typeof item.poolAddress  === 'string' ? item.poolAddress.toLowerCase()  : null
          const sym   = typeof item.symbol       === 'string' ? item.symbol.toUpperCase()       : null
          if (token) addrSet.add(token); if (pool) addrSet.add(pool); if (sym) symSet.add(sym)
        }
        clarkContextRef.current.seenMarketAddresses = [...addrSet]
        clarkContextRef.current.seenMarketSymbols   = [...symSet]
      }
      const cursor = (marketContext && typeof marketContext === 'object' && (marketContext as Record<string, unknown>).cursor && typeof (marketContext as Record<string, unknown>).cursor === 'object')
        ? (marketContext as Record<string, unknown>).cursor as ClarkContextState['marketCursor'] : null
      if (cursor) clarkContextRef.current.marketCursor = cursor
      clarkContextRef.current.previousIntent  = clarkContextRef.current.lastIntent ?? null
      clarkContextRef.current.lastIntent      = typeof payload.intent === 'string' ? payload.intent : clarkContextRef.current.lastIntent
      clarkContextRef.current.lastSelectedRank = /\b([1-9]\d{0,2})\b/.test(text) ? Number(text.match(/\b([1-9]\d{0,2})\b/)?.[1] ?? 0) || null : clarkContextRef.current.lastSelectedRank
      const reply = json.ok
        ? (payload?.reply ?? payload?.analysis ?? payload?.response ?? json.reply ?? json.analysis ?? 'No response from Clark.')
        : (json.error ?? 'Something went wrong.')
      const ui = payload.ui && typeof payload.ui === 'object' ? payload.ui as { intentBadge?: unknown; actions?: unknown } : null
      const actions = Array.isArray(ui?.actions) ? ui.actions.filter((a): a is ClarkAction => Boolean(a && typeof a === 'object' && typeof (a as ClarkAction).label === 'string' && typeof (a as ClarkAction).href === 'string')) : []
      setMessages((prev) => { const next = [...prev]; next[next.length - 1] = { role: 'clark', text: String(reply), intentBadge: typeof ui?.intentBadge === 'string' ? ui.intentBadge : null, actions }; return next })
    } catch {
      setMessages((prev) => { const next = [...prev]; next[next.length - 1] = { role: 'clark', text: FALLBACK_ERROR_MESSAGE }; return next })
    } finally { setLoading(false) }
  }

  async function handleSend() { await handleSendText(input) }

  useEffect(() => {
    if (!autoSendRequested || !importedPrompt || loading || autoSentRef.current) return
    autoSentRef.current = true
    setInput(importedPrompt)
    queueMicrotask(() => { void handleSendText(importedPrompt) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSendRequested, importedPrompt, loading])

  // ── Derived UI values ─────────────────────────────────────────────────────
  const isLimited   = planLimit !== null && clarkUsed >= planLimit
  const usagePct    = planLimit ? Math.min(100, (clarkUsed / planLimit) * 100) : 0
  const chips       = uiTab === 'analyst' ? ANALYST_CHIPS : CHAT_CHIPS
  const placeholder = uiTab === 'analyst'
    ? 'Ask Clark anything about tokens, wallets, liquidity, dev wallets, or Base movers...'
    : 'Chat with Clark about Base, wallets, tokens, or risk...'
  const hasMessages = messages.length > 0
  void activeModeConfig; void applyMode; void handleImportFromRadar; void handlePasteContract; void handlePasteWallet

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className='clk-page'>
      <style>{`
        /* ── Page shell ────────────────────────────────────────── */
        .clk-page {
          position: relative;
          min-height: 100%;
          overflow-x: hidden;
          color: #e2e8f0;
          background:
            radial-gradient(ellipse 55% 40% at 8% 60%, rgba(45,212,191,.13) 0%, transparent 100%),
            radial-gradient(ellipse 50% 40% at 92% 55%, rgba(139,92,246,.15) 0%, transparent 100%),
            radial-gradient(ellipse 60% 30% at 50% 0%,  rgba(139,92,246,.10) 0%, transparent 100%),
            linear-gradient(180deg, #030712 0%, #050a18 50%, #030610 100%);
        }

        /* ── Animated background blobs ─────────────────────────── */
        .clk-blob {
          position: absolute;
          border-radius: 50%;
          pointer-events: none;
          filter: blur(80px);
          will-change: transform;
        }
        .clk-blob-teal {
          width: 520px; height: 420px;
          left: -120px; top: 20%;
          background: radial-gradient(circle, rgba(45,212,191,.22) 0%, transparent 70%);
          animation: clkBlobT 14s ease-in-out infinite;
        }
        .clk-blob-purple {
          width: 480px; height: 400px;
          right: -100px; top: 28%;
          background: radial-gradient(circle, rgba(139,92,246,.20) 0%, transparent 70%);
          animation: clkBlobP 18s ease-in-out infinite;
        }
        @keyframes clkBlobT {
          0%,100% { transform: translateY(0px) scale(1); }
          40%     { transform: translateY(-30px) scale(1.06); }
          70%     { transform: translateY(16px) scale(0.96); }
        }
        @keyframes clkBlobP {
          0%,100% { transform: translateY(0px) scale(1); }
          35%     { transform: translateY(24px) scale(1.05); }
          65%     { transform: translateY(-18px) scale(0.97); }
        }

        /* ── Wave SVG ──────────────────────────────────────────── */
        .clk-waves {
          position: absolute;
          left: 0; top: 0;
          width: 100%; height: 600px;
          pointer-events: none;
          overflow: visible;
        }
        .clk-wave-l {
          animation: clkWaveFloat 12s ease-in-out infinite;
          transform-origin: center;
        }
        .clk-wave-r {
          animation: clkWaveFloat 16s ease-in-out infinite reverse;
          transform-origin: center;
        }
        @keyframes clkWaveFloat {
          0%,100% { transform: translateY(0px); }
          40%     { transform: translateY(-18px); }
          70%     { transform: translateY(12px); }
        }

        /* ── Subtle dot grid overlay ───────────────────────────── */
        .clk-grid {
          position: absolute;
          inset: 0; pointer-events: none;
          background-image:
            radial-gradient(circle, rgba(148,163,184,.07) 1px, transparent 1px);
          background-size: 36px 36px;
          mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 80%);
        }

        /* ── Content column ────────────────────────────────────── */
        .clk-content {
          position: relative;
          z-index: 1;
          max-width: 860px;
          margin: 0 auto;
          padding: 40px 24px 64px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0;
        }

        /* ── Hero ──────────────────────────────────────────────── */
        .clk-hero {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 0;
          margin-bottom: 28px;
          animation: clkFadeDown .7s ease-out both;
        }
        @keyframes clkFadeDown {
          from { opacity: 0; transform: translateY(-20px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .clk-orb-wrap { margin-bottom: 22px; }

        .clk-title {
          margin: 0 0 14px;
          font-size: clamp(48px, 7vw, 72px);
          font-weight: 900;
          letter-spacing: -0.03em;
          line-height: 1;
          color: #f8fafc;
        }
        .clk-title-ai {
          background: linear-gradient(120deg, #67e8f9 0%, #818cf8 45%, #c084fc 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .clk-subtitle {
          margin: 0 0 18px;
          font-size: clamp(14px, 2vw, 16px);
          color: #94a3b8;
          max-width: 480px;
          line-height: 1.55;
        }

        /* ── LIVE badge row ────────────────────────────────────── */
        .clk-live-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-family: var(--font-plex-mono, monospace);
          letter-spacing: .14em;
          color: #64748b;
          margin-bottom: 32px;
          text-transform: uppercase;
        }
        .clk-live-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          background: #2dd4bf;
          box-shadow: 0 0 6px rgba(45,212,191,.8), 0 0 12px rgba(45,212,191,.5);
          animation: clkLivePulse 2.2s ease-in-out infinite;
          flex-shrink: 0;
        }
        @keyframes clkLivePulse {
          0%,100% { box-shadow: 0 0 4px rgba(45,212,191,.8), 0 0 8px rgba(45,212,191,.4); }
          50%     { box-shadow: 0 0 8px rgba(45,212,191,1),  0 0 18px rgba(45,212,191,.6), 0 0 28px rgba(45,212,191,.25); }
        }
        .clk-live-label { color: #2dd4bf; font-weight: 700; letter-spacing: .1em; }
        .clk-live-sep   { color: #1e293b; }
        .clk-live-cortex { color: #64748b; }

        /* ── Mode tabs ─────────────────────────────────────────── */
        .clk-tabs {
          display: flex;
          gap: 6px;
          background: rgba(5,10,24,.65);
          border: 1px solid rgba(148,163,184,.14);
          border-radius: 999px;
          padding: 6px;
          backdrop-filter: blur(8px);
        }
        .clk-tab {
          display: inline-flex;
          align-items: center;
          gap: 9px;
          border-radius: 999px;
          border: 1px solid transparent;
          background: transparent;
          color: #64748b;
          font-size: 16px;
          font-weight: 600;
          letter-spacing: 0.01em;
          padding: 12px 34px;
          cursor: pointer;
          transition: all .22s ease;
          white-space: nowrap;
          min-height: 48px;
        }
        .clk-tab:hover:not(.clk-tab--analyst):not(.clk-tab--chat) {
          color: #cbd5e1;
          border-color: rgba(148,163,184,.22);
          background: rgba(255,255,255,.04);
        }
        .clk-tab--analyst {
          background: linear-gradient(135deg, rgba(45,212,191,.24) 0%, rgba(99,102,241,.20) 100%);
          border-color: rgba(45,212,191,.60);
          color: #5eead4;
          box-shadow: 0 0 22px rgba(45,212,191,.26), 0 0 0 1px rgba(45,212,191,.20) inset;
          text-shadow: 0 0 20px rgba(45,212,191,.40);
        }
        .clk-tab--chat {
          background: linear-gradient(135deg, rgba(139,92,246,.24) 0%, rgba(236,72,153,.18) 100%);
          border-color: rgba(139,92,246,.60);
          color: #c4b5fd;
          box-shadow: 0 0 22px rgba(139,92,246,.26), 0 0 0 1px rgba(139,92,246,.18) inset;
          text-shadow: 0 0 20px rgba(139,92,246,.40);
        }
        .clk-tab-icon { opacity: .85; flex-shrink: 0; }

        /* ── Message thread wrap (visually connected to panel) ─── */
        .clk-thread-wrap {
          width: 100%;
          border: 1px solid rgba(45,212,191,.22);
          border-bottom: none;
          border-radius: 24px 24px 0 0;
          background: linear-gradient(180deg, rgba(6,12,26,.82) 0%, rgba(4,9,22,.90) 100%);
          padding: 14px 18px 4px;
          box-shadow:
            0 0 0 1px rgba(139,92,246,.08),
            0 -4px 24px rgba(45,212,191,.06);
        }

        /* ── Message thread ────────────────────────────────────── */
        .clk-thread {
          width: 100%;
          max-height: 400px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding-right: 4px;
          scrollbar-width: thin;
          scrollbar-color: rgba(148,163,184,.2) transparent;
        }
        .clk-thread::-webkit-scrollbar { width: 4px; }
        .clk-thread::-webkit-scrollbar-track { background: transparent; }
        .clk-thread::-webkit-scrollbar-thumb { background: rgba(148,163,184,.2); border-radius: 999px; }
        .clk-thread-header {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 8px;
        }
        .clk-clear-btn {
          font-size: 11px;
          color: #475569;
          background: transparent;
          border: 1px solid rgba(148,163,184,.18);
          border-radius: 999px;
          padding: 4px 12px;
          cursor: pointer;
          font-family: var(--font-plex-mono, monospace);
          letter-spacing: .08em;
          transition: color .16s, border-color .16s;
        }
        .clk-clear-btn:hover { color: #94a3b8; border-color: rgba(148,163,184,.38); }

        .clk-msg {
          max-width: 86%;
          padding: 10px 13px;
          border-radius: 14px;
          border: 1px solid;
        }
        .clk-msg--user {
          align-self: flex-end;
          border-color: rgba(45,212,191,.32);
          background: rgba(45,212,191,.10);
        }
        .clk-msg--clark {
          align-self: flex-start;
          border-color: rgba(148,163,184,.18);
          background: linear-gradient(180deg, rgba(15,23,42,.75), rgba(5,10,24,.85));
        }
        .clk-msg-role {
          display: block;
          font-size: 9px;
          letter-spacing: .14em;
          font-family: var(--font-plex-mono, monospace);
          margin-bottom: 5px;
        }
        .clk-msg--user .clk-msg-role { color: #5eead4; }
        .clk-msg--clark .clk-msg-role { color: #64748b; }
        .clk-intent-badge { display:inline-flex; width:max-content; margin: 0 0 8px; padding: 4px 8px; border: 1px solid rgba(45,212,191,.28); border-radius: 999px; color: #67e8f9; background: rgba(45,212,191,.08); font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
        .clk-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
        .clk-action { border:1px solid rgba(45,212,191,.25); border-radius:999px; padding:7px 10px; color:#ccfbf1; background:rgba(45,212,191,.07); font-size:12px; font-weight:700; text-decoration:none; }
        .clk-action--disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .clk-msg-text {
          margin: 0;
          font-size: 13.5px;
          line-height: 1.55;
          color: #e2e8f0;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        .clk-thinking {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .clk-thinking-text { font-size: 13px; color: #64748b; }

        /* ── Glass input panel ─────────────────────────────────── */
        .clk-panel {
          width: 100%;
          border-radius: 24px;
          border: 1px solid rgba(45,212,191,.30);
          background: linear-gradient(165deg, rgba(8,16,34,.90) 0%, rgba(4,9,22,.94) 100%);
          box-shadow:
            0 0 0 1px rgba(139,92,246,.14),
            0 0 48px rgba(45,212,191,.12),
            0 28px 64px rgba(0,0,0,.44),
            inset 0 1px 0 rgba(255,255,255,.05);
          padding: 22px 22px 18px;
          animation: clkFadeUp .8s ease-out .15s both;
          margin-bottom: 24px;
        }
        .clk-panel--connected {
          border-top: 1px solid rgba(45,212,191,.18);
          border-radius: 0 0 24px 24px;
          box-shadow:
            0 0 0 1px rgba(139,92,246,.10),
            0 0 40px rgba(45,212,191,.10),
            0 28px 64px rgba(0,0,0,.44),
            inset 0 1px 0 rgba(255,255,255,.03);
        }
        @keyframes clkFadeUp {
          from { opacity: 0; transform: translateY(28px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .clk-panel-input-row {
          display: flex;
          align-items: center;
          gap: 14px;
          min-height: 56px;
          padding: 4px 0;
          margin-bottom: 20px;
        }
        .clk-panel-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #e2e8f0;
          font-size: 16px;
          line-height: 1.5;
          caret-color: #2dd4bf;
          min-width: 0;
        }
        .clk-panel-input::placeholder { color: #3d526a; }

        .clk-send-btn {
          width: 48px; height: 48px;
          flex-shrink: 0;
          border-radius: 50%;
          border: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform .16s ease, box-shadow .16s ease, filter .16s ease;
        }
        .clk-send-btn:not(:disabled) {
          background: linear-gradient(135deg, #2DD4BF 0%, #8B5CF6 55%, #EC4899 100%);
          color: #fff;
          box-shadow: 0 0 22px rgba(45,212,191,.55), 0 0 30px rgba(236,72,153,.40), 0 0 0 1px rgba(255,255,255,.12);
        }
        .clk-send-btn:not(:disabled):hover {
          transform: scale(1.08);
          filter: brightness(1.08) saturate(1.1);
          box-shadow: 0 0 30px rgba(45,212,191,.70), 0 0 40px rgba(236,72,153,.55), 0 0 0 1px rgba(255,255,255,.16);
        }
        .clk-send-btn:not(:disabled):active { transform: scale(1.02); }
        .clk-send-btn:disabled {
          background: rgba(148,163,184,.18);
          color: #334155;
          cursor: not-allowed;
          box-shadow: none;
        }

        /* ── Divider inside panel ──────────────────────────────── */
        .clk-panel-divider {
          height: 1px;
          background: rgba(148,163,184,.10);
          margin-bottom: 14px;
        }

        /* ── Upgrade notice ────────────────────────────────────── */
        .clk-upgrade-note {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          margin-bottom: 16px;
          padding: 11px 16px;
          border-radius: 14px;
          border: 1px solid rgba(139,92,246,.32);
          background: rgba(139,92,246,.08);
          font-size: 12.5px;
          color: #a78bfa;
          line-height: 1.5;
        }
        .clk-upgrade-link {
          color: #c4b5fd;
          font-size: 12px;
          font-weight: 700;
          text-decoration: none;
          white-space: nowrap;
          border: 1px solid rgba(196,181,253,.30);
          border-radius: 999px;
          padding: 4px 12px;
          transition: background .16s, color .16s;
        }
        .clk-upgrade-link:hover {
          background: rgba(139,92,246,.18);
          color: #e9d5ff;
        }

        /* ── Suggestion chips ──────────────────────────────────── */
        .clk-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 16px;
        }
        .clk-chip {
          border-radius: 999px;
          border: 1px solid rgba(148,163,184,.22);
          background: rgba(12,20,38,.65);
          color: #94a3b8;
          font-size: 12.5px;
          padding: 7px 15px;
          cursor: pointer;
          transition: border-color .16s, color .16s, box-shadow .16s, background .16s;
          white-space: nowrap;
          max-width: 100%;
        }
        .clk-chip:hover {
          border-color: rgba(45,212,191,.48);
          color: #99f6e4;
          background: rgba(45,212,191,.06);
          box-shadow: 0 0 12px rgba(45,212,191,.14);
        }

        /* ── Usage row ─────────────────────────────────────────── */
        .clk-usage {
          display: flex;
          align-items: center;
          gap: 12px;
          padding-top: 2px;
        }
        .clk-usage-label {
          font-size: 11.5px;
          color: #64748b;
          font-family: var(--font-plex-mono, monospace);
          white-space: nowrap;
        }
        .clk-usage-track {
          flex: 1;
          height: 5px;
          border-radius: 999px;
          background: rgba(148,163,184,.12);
          overflow: hidden;
          min-width: 60px;
        }
        .clk-usage-fill {
          height: 100%;
          border-radius: 999px;
          transition: width .6s ease;
          min-width: 0;
        }
        .clk-usage-count {
          font-size: 11.5px;
          font-family: var(--font-plex-mono, monospace);
          white-space: nowrap;
          min-width: 44px;
          text-align: right;
        }

        /* ── Footer note ───────────────────────────────────────── */
        .clk-footer {
          font-size: 12px;
          color: #334155;
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 0;
        }

        /* ── Orb (unchanged) ───────────────────────────────────── */
        .clark-orb-shell {
          border-radius: 999px; position: relative;
          display: inline-flex; align-items: center; justify-content: center;
          background: radial-gradient(circle at 30% 25%, rgba(148,163,184,.24), rgba(2,6,23,.96) 62%);
          border: 1px solid rgba(148,163,184,.34);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 0 20px rgba(45,212,191,.22), 0 0 28px rgba(139,92,246,.20);
          overflow: hidden; flex-shrink: 0;
        }
        .clark-orb-ring {
          position: absolute; inset: 3px; border-radius: 999px;
          border: 1px solid rgba(45,212,191,.25); opacity: .9;
        }
        .clark-orb-core { position: relative; width: 100%; height: 100%; border-radius: 999px; }
        .clark-orb-dot { position: absolute; width: 7px; height: 7px; border-radius: 999px; filter: blur(.1px); }
        .clark-orb-dot-a { left: 34%; top: 44%; background: #67e8f9; box-shadow: 0 0 16px rgba(103,232,249,.95); animation: clarkDotA 2.4s ease-in-out infinite; }
        .clark-orb-dot-b { right: 30%; top: 44%; background: #c4b5fd; box-shadow: 0 0 16px rgba(196,181,253,.9);  animation: clarkDotB 2.1s ease-in-out infinite; }
        .clark-orb-shell.thinking::after {
          content: ''; position: absolute; inset: -6px; border-radius: 999px;
          border: 1px solid rgba(45,212,191,.22); animation: clarkPulse 1.6s ease-out infinite;
        }
        @keyframes clarkDotA { 0%,100%{ transform:translate(0,0) scale(1);} 50%{ transform:translate(2px,-2px) scale(1.18);} }
        @keyframes clarkDotB { 0%,100%{ transform:translate(0,0) scale(1);} 50%{ transform:translate(-2px,2px) scale(1.16);} }
        @keyframes clarkPulse { 0%{ transform:scale(.94); opacity:.7;} 100%{ transform:scale(1.08); opacity:0;} }

        /* ── Reduced motion ────────────────────────────────────── */
        @media (prefers-reduced-motion: reduce) {
          .clark-orb-dot, .clark-orb-shell.thinking::after,
          .clk-blob-teal, .clk-blob-purple,
          .clk-wave-l, .clk-wave-r, .clk-live-dot { animation: none !important; }
          .clk-hero, .clk-panel { animation: none !important; opacity: 1 !important; transform: none !important; }
        }

        /* ── Responsive ────────────────────────────────────────── */
        @media (max-width: 680px) {
          .clk-content { padding: 28px 14px 80px; }
          .clk-title { font-size: 44px; }
          .clk-hero { margin-bottom: 22px; }
          .clk-tabs { gap: 4px; padding: 5px; }
          .clk-tab { font-size: 15px; padding: 10px 22px; min-height: 44px; }
          .clk-thread-wrap { border-radius: 18px 18px 0 0; padding: 12px 14px 4px; }
          .clk-panel { border-radius: 18px; padding: 16px 14px 14px; }
          .clk-panel--connected { border-radius: 0 0 18px 18px; }
          .clk-panel-input-row { gap: 10px; min-height: 48px; margin-bottom: 16px; }
          .clk-panel-input { font-size: 16px; }
          .clk-chips { gap: 6px; }
          .clk-chip { font-size: 12px; padding: 7px 13px; }
          .clk-send-btn { width: 44px; height: 44px; }
          .clk-thread { max-height: 300px; }
          .clk-upgrade-note { font-size: 12px; padding: 10px 13px; }
        }
        @media (max-width: 420px) {
          .clk-tabs { border-radius: 18px; }
          .clk-tab { padding: 10px 18px; }
          .clk-chip { white-space: normal; text-align: center; }
        }
      `}</style>

      {/* ── Cinematic background ─────────────────────────────────── */}
      <div aria-hidden='true'>
        <div className='clk-blob clk-blob-teal' />
        <div className='clk-blob clk-blob-purple' />
        <div className='clk-grid' />
        <svg className='clk-waves' viewBox='0 0 1440 600' preserveAspectRatio='xMidYMid slice' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
          <defs>
            <linearGradient id='clwg1' x1='0%' y1='0%' x2='100%' y2='0%'>
              <stop offset='0%'   stopColor='#2DD4BF' stopOpacity='.55'/>
              <stop offset='60%'  stopColor='#8B5CF6' stopOpacity='.28'/>
              <stop offset='100%' stopColor='#8B5CF6' stopOpacity='.06'/>
            </linearGradient>
            <linearGradient id='clwg2' x1='0%' y1='0%' x2='100%' y2='0%'>
              <stop offset='0%'   stopColor='#2DD4BF' stopOpacity='.10'/>
              <stop offset='45%'  stopColor='#8B5CF6' stopOpacity='.38'/>
              <stop offset='100%' stopColor='#EC4899' stopOpacity='.28'/>
            </linearGradient>
            <linearGradient id='clwg3' x1='0%' y1='0%' x2='100%' y2='0%'>
              <stop offset='0%'   stopColor='#2DD4BF' stopOpacity='.16'/>
              <stop offset='100%' stopColor='#2DD4BF' stopOpacity='.04'/>
            </linearGradient>
          </defs>
          {/* Left / teal wave cluster */}
          <g className='clk-wave-l'>
            <path d='M-240 370 C60 300 240 440 520 330 S820 290 1100 370 S1380 320 1680 370' stroke='url(#clwg1)' strokeWidth='2.2' fill='none' strokeLinecap='round' opacity='.8'/>
            <path d='M-240 395 C60 325 240 460 520 355 S820 315 1100 395 S1380 345 1680 395' stroke='#2DD4BF'       strokeWidth='1'   fill='none' strokeLinecap='round' opacity='.28'/>
            <path d='M-240 350 C80 285 260 415 540 310 S840 270 1120 350 S1400 300 1700 350' stroke='url(#clwg3)'    strokeWidth='.8'  fill='none' strokeLinecap='round' opacity='.35'/>
          </g>
          {/* Right / purple wave cluster */}
          <g className='clk-wave-r'>
            <path d='M-240 250 C80 318 340 192 620 268 S940 330 1220 240 S1500 298 1780 250' stroke='url(#clwg2)' strokeWidth='2.2' fill='none' strokeLinecap='round' opacity='.70'/>
            <path d='M-240 272 C80 340 340 212 620 290 S940 352 1220 262 S1500 320 1780 272' stroke='#8B5CF6'       strokeWidth='1'   fill='none' strokeLinecap='round' opacity='.28'/>
            <path d='M-240 228 C80 296 340 170 620 246 S940 308 1220 218 S1500 276 1780 228' stroke='#EC4899'       strokeWidth='.8'  fill='none' strokeLinecap='round' opacity='.18'/>
          </g>
        </svg>
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className='clk-content'>

        {/* Hero */}
        <section className='clk-hero'>
          <div className='clk-orb-wrap'><ClarkOrb size={72} thinking={loading && !hasMessages} /></div>
          <h1 className='clk-title'>Clark <span className='clk-title-ai'>AI</span></h1>
          <p className='clk-subtitle'>Base-native AI analyst for tokens, wallets, and onchain risk.</p>
          <div className='clk-live-row'>
            <span className='clk-live-dot' />
            <span className='clk-live-label'>LIVE</span>
            <span className='clk-live-sep'>·</span>
            <span className='clk-live-cortex'>POWERED BY CORTEX ENGINE</span>
          </div>

          {/* Analyst / Chat tabs */}
          <div className='clk-tabs'>
            <button
              className={`clk-tab${uiTab === 'analyst' ? ' clk-tab--analyst' : ''}`}
              onClick={() => setUiTab('analyst')}
            >
              <svg className='clk-tab-icon' width='17' height='17' viewBox='0 0 15 15' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
                <path d='M7.5 1L9.18 5.31L14 5.69L10.55 8.67L11.63 13.38L7.5 11L3.37 13.38L4.45 8.67L1 5.69L5.82 5.31L7.5 1Z' stroke='currentColor' strokeWidth='1.3' strokeLinejoin='round' fill='none'/>
              </svg>
              Analyst
            </button>
            <button
              className={`clk-tab${uiTab === 'chat' ? ' clk-tab--chat' : ''}`}
              onClick={() => setUiTab('chat')}
            >
              <svg className='clk-tab-icon' width='17' height='17' viewBox='0 0 15 15' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
                <path d='M13 2H2C1.45 2 1 2.45 1 3V10C1 10.55 1.45 11 2 11H4V13.5L7.5 11H13C13.55 11 14 10.55 14 10V3C14 2.45 13.55 2 13 2Z' stroke='currentColor' strokeWidth='1.3' strokeLinejoin='round' strokeLinecap='round' fill='none'/>
              </svg>
              Chat
            </button>
          </div>
        </section>

        {/* Message thread — wrapped to visually connect with panel below */}
        {hasMessages && (
          <div className='clk-thread-wrap'>
            <div className='clk-thread' ref={threadRef}>
              <div className='clk-thread-header'>
                <button onClick={handleClear} className='clk-clear-btn'>Clear</button>
              </div>
              {messages.map((msg, idx) => {
                const isThinking = msg.role === 'clark' && loading && msg.text === THINKING_MESSAGE
                return (
                  <div key={idx} className={`clk-msg clk-msg--${msg.role}`}>
                    <span className='clk-msg-role'>{msg.role === 'user' ? 'YOU' : 'CLARK'}</span>
                    {isThinking ? (
                      <div className='clk-thinking'>
                        <ClarkOrb size={22} thinking />
                        <span className='clk-thinking-text'>Clark is thinking…</span>
                      </div>
                    ) : (
                      <>
                        {msg.intentBadge && <span className='clk-intent-badge'>{msg.intentBadge}</span>}
                        <p className='clk-msg-text'>{msg.text}</p>
                        {msg.actions && msg.actions.length > 0 && (
                          <div className='clk-actions'>
                            {msg.actions.map((action) => (
                              <a key={`${action.label}-${action.href}`} className={`clk-action${action.requiresInput ? ' clk-action--disabled' : ''}`} href={action.requiresInput ? undefined : action.href} aria-disabled={action.requiresInput || undefined}>
                                {action.label}
                              </a>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Glass input panel — top corners flatten when thread is above */}
        <div className={`clk-panel${hasMessages ? ' clk-panel--connected' : ''}`}>
          <div className='clk-panel-input-row'>
            <ClarkOrb size={40} thinking={loading && hasMessages} />
            <input
              className='clk-panel-input'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !loading) { e.preventDefault(); void handleSend() } }}
              disabled={loading}
              placeholder={placeholder}
            />
            <button
              className='clk-send-btn'
              onClick={() => void handleSend()}
              disabled={loading || !input.trim() || isLimited}
              aria-label='Send'
            >
              <svg width='17' height='17' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.4' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
                <line x1='22' y1='2' x2='11' y2='13'/>
                <polygon points='22 2 15 22 11 13 2 9 22 2'/>
              </svg>
            </button>
          </div>

          <div className='clk-panel-divider' />

          {/* Upgrade notice — shown only when daily limit reached */}
          {isLimited && (
            <div className='clk-upgrade-note'>
              <span>Base momentum preview is available on Pro and Elite. Upgrade to unlock the full market read.</span>
              <a href='/pricing' className='clk-upgrade-link'>Upgrade →</a>
            </div>
          )}

          {/* Suggestion chips */}
          <div className='clk-chips'>
            {chips.map((chip) => (
              <button key={chip.label} className='clk-chip' onClick={() => setInput(chip.prompt)}>
                {chip.label}
              </button>
            ))}
          </div>

          {/* Usage bar */}
          <div className='clk-usage'>
            <span className='clk-usage-label'>Usage today</span>
            <div className='clk-usage-track'>
              <div
                className='clk-usage-fill'
                style={{
                  width: `${usagePct}%`,
                  background: isLimited
                    ? 'linear-gradient(90deg,#ef4444,#f43f5e)'
                    : planLimit !== null && clarkUsed / planLimit >= 0.8
                      ? 'linear-gradient(90deg,#f59e0b,#ef4444)'
                      : 'linear-gradient(90deg,#2dd4bf,#8b5cf6)',
                }}
              />
            </div>
            <span
              className='clk-usage-count'
              style={{
                color: isLimited
                  ? '#fb7185'
                  : planLimit !== null && clarkUsed / planLimit >= 0.8
                    ? '#fbbf24'
                    : '#64748b',
              }}
            >
              {clarkUsed} / {planLimit ?? '...'}
            </span>
          </div>
        </div>

        {/* Footer note */}
        <p className='clk-footer'>
          <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
            <rect x='3' y='11' width='18' height='11' rx='2' ry='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/>
          </svg>
          Your data is encrypted and never shared.
        </p>

      </div>
    </div>
  )
}

export default function ClarkAiPage() {
  return (
    <Suspense fallback={<div style={{ padding: 32, color: '#94a3b8' }}>Loading Clark AI...</div>}>
      <ClarkAiContent />
    </Suspense>
  )
}
