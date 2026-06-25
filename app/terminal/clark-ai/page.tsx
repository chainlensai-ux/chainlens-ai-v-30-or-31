'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { getClarkSessionId as getOrCreateSessionId, readClarkClientContext as getClientClarkContext, persistClarkMemoryEcho, persistClarkMomentumList, persistMarketMomentum, readMarketMomentum } from '@/lib/client/clarkMemory'

// ── Types ─────────────────────────────────────────────────────────────────────
type ClarkAction = { label: string; href?: string; prompt?: string; kind?: 'link' | 'prompt'; requiresInput?: boolean }
type Message = { role: 'user' | 'clark'; text: string; intentBadge?: string | null; actions?: ClarkAction[] }
type UiTab   = 'analyst' | 'chat'

// ── Session / context helpers: shared across every Clark surface, see lib/client/clarkMemory.ts ──
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

type AnalysisKind = 'token' | 'wallet' | 'lp' | 'general'
const ANALYSIS_STAGES: Record<AnalysisKind, string[]> = {
  token: ['Analyzing token...', 'Checking liquidity...', 'Reviewing holder distribution...', 'Inspecting security signals...', 'Building CORTEX summary...'],
  wallet: ['Loading portfolio...', 'Reviewing activity...', 'Checking chain exposure...', 'Building wallet profile...', 'Preparing intelligence report...'],
  lp: ['Reviewing liquidity...', 'Checking LP control...', 'Analyzing concentrated positions...', 'Preparing LP report...'],
  general: ['Parsing request...', 'Loading CORTEX context...', 'Reviewing Base signals...', 'Preparing intelligence report...'],
}
function inferAnalysisKind(text: string, mode?: Mode['key']): AnalysisKind {
  const t = text.toLowerCase()
  if (mode === 'wallet' || /\b(wallet|portfolio|holdings?|pnl|whale)\b/.test(t)) return 'wallet'
  if (/\b(lp|liquidity|pool|lock|unlock|concentrated)\b/.test(t)) return 'lp'
  if (mode === 'token' || mode === 'contract' || /\b(token|contract|ca\b|holders?|deployer|rug|safe|scan)\b/.test(t)) return 'token'
  return 'general'
}
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
  const [loadingKind, setLoadingKind] = useState<AnalysisKind>('general')
  const [loadingStage, setLoadingStage] = useState(0)
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
  const loadingStages = ANALYSIS_STAGES[loadingKind] ?? ANALYSIS_STAGES.general

  useEffect(() => {
    if (!loading) { setLoadingStage(0); return }
    const id = window.setInterval(() => {
      setLoadingStage((stage) => Math.min(stage + 1, loadingStages.length - 1))
    }, 1200)
    return () => window.clearInterval(id)
  }, [loading, loadingStages.length])

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
    setLoadingKind(inferAnalysisKind(text, activeMode))
    setLoadingStage(0)
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
      // Pull the latest safe Wallet/Token scan summaries the scanner pages persisted, so Clark can
      // answer "explain this / why is pnl locked / what are the risks" without pasted JSON.
      const readJson = (key: string): Record<string, unknown> | null => {
        try {
          if (typeof localStorage === 'undefined') return null
          const raw = localStorage.getItem(key)
          return raw ? JSON.parse(raw) as Record<string, unknown> : null
        } catch { return null }
      }
      const walletSummary = readJson('chainlens:clark:lastWalletSummary')
      const tokenSummary = readJson('chainlens:clark:lastTokenSummary')
      const persistedMomentum = readMarketMomentum()
      const latestMarketContext = clarkContextRef.current.lastMarketList?.length
        ? { items: clarkContextRef.current.lastMarketList }
        : persistedMomentum?.length
          ? { items: persistedMomentum }
          : null
      const appContext = {
        route: pathname,
        chain: 'base',
        activeFeature: activeMode ?? 'clark-ai',
        selectedToken: clarkContextRef.current.lastMarketList?.[0]?.tokenAddress ?? clientClarkContext.lastToken ?? null,
        selectedWallet: clientClarkContext.lastWallet ?? null,
        currentWalletAddress: (walletSummary?.address as string | undefined) ?? clientClarkContext.lastWallet ?? null,
        currentTokenAddress: (tokenSummary?.address as string | undefined) ?? clientClarkContext.lastToken ?? null,
        walletSummary,
        tokenSummary,
        marketContext: latestMarketContext,
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
          sessionId: getOrCreateSessionId(),
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
        persistClarkMomentumList(nextItems)
        persistMarketMomentum((nextItems as Array<Record<string, unknown>>).map((item, i) => ({
          rank: typeof item.rank === 'number' ? item.rank : i + 1,
          symbol: typeof item.symbol === 'string' ? item.symbol : '?',
          name: typeof item.name === 'string' ? item.name : null,
          chain: 'base',
          tokenAddress: typeof item.tokenAddress === 'string' ? item.tokenAddress : null,
          poolAddress: typeof item.poolAddress === 'string' ? item.poolAddress : null,
          scanTarget: typeof item.scanTarget === 'string' ? item.scanTarget : (typeof item.tokenAddress === 'string' ? item.tokenAddress : (typeof item.poolAddress === 'string' ? item.poolAddress : null)),
          scanTargetType: typeof item.scanTargetType === 'string' ? item.scanTargetType : null,
          liquidity: typeof item.liquidity === 'number' ? item.liquidity : null,
          volume24h: typeof item.volume24h === 'number' ? item.volume24h : null,
          change24h: typeof item.change24h === 'number' ? item.change24h : null,
          tag: typeof item.reasonTag === 'string' ? item.reasonTag : null,
        })))
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
      // Redundancy layer for the server-side in-memory session map, and the cross-surface sync
      // mechanism: every Clark surface persists memoryEcho through the same shared helper, so a
      // wallet/token scanned here is immediately visible to every other Clark surface.
      persistClarkMemoryEcho(payload)
      clarkContextRef.current.previousIntent  = clarkContextRef.current.lastIntent ?? null
      clarkContextRef.current.lastIntent      = typeof payload.intent === 'string' ? payload.intent : clarkContextRef.current.lastIntent
      clarkContextRef.current.lastSelectedRank = /\b([1-9]\d{0,2})\b/.test(text) ? Number(text.match(/\b([1-9]\d{0,2})\b/)?.[1] ?? 0) || null : clarkContextRef.current.lastSelectedRank
      const reply = json.ok
        ? (payload?.reply ?? payload?.analysis ?? payload?.response ?? json.reply ?? json.analysis ?? 'No response from Clark.')
        : (json.error ?? 'Something went wrong.')
      const ui = payload.ui && typeof payload.ui === 'object' ? payload.ui as { intentBadge?: unknown; actions?: unknown } : null
      const actions = Array.isArray(ui?.actions) ? ui.actions.filter((a): a is ClarkAction => {
        if (!a || typeof a !== 'object' || typeof (a as ClarkAction).label !== 'string') return false
        const href = (a as ClarkAction).href
        const prompt = (a as ClarkAction).prompt
        return typeof href === 'string' || typeof prompt === 'string'
      }) : []
      const statusMessage = typeof payload.clarkFollowupStatusMessage === 'string' ? payload.clarkFollowupStatusMessage : null
      setMessages((prev) => {
        const next = [...prev]
        const finalMsg: Message = { role: 'clark', text: String(reply), intentBadge: typeof ui?.intentBadge === 'string' ? ui.intentBadge : null, actions }
        if (statusMessage) {
          next[next.length - 1] = { role: 'clark', text: statusMessage }
          next.push(finalMsg)
        } else {
          next[next.length - 1] = finalMsg
        }
        return next
      })
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
  const historyRows = messages
    .filter((msg) => msg.role === 'user' && msg.text.trim())
    .slice(-5)
    .reverse()
  const memoryStats = [
    { label: 'Tokens analyzed', value: clarkContextRef.current.lastMarketList?.length ?? 0 },
    { label: 'Wallet scanned', value: getClientClarkContext().lastWallet ? 1 : 0 },
    { label: 'Messages', value: messages.length },
  ]
  const clientContext = getClientClarkContext() as { lastToken?: unknown; lastWallet?: unknown }
  const formatContextValue = (value: unknown) => {
    if (!value) return 'None yet'
    if (typeof value === 'string') return value
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      return String(record.symbol ?? record.address ?? record.tokenAddress ?? record.wallet ?? 'Available')
    }
    return String(value)
  }
  const recentTokens = (clarkContextRef.current.lastMarketList ?? []).slice(0, 3)
  const recentWalletValue = clientContext.lastWallet ? formatContextValue(clientContext.lastWallet) : null
  const quickActions = [
    { title: 'Scan Token', sub: 'Analyze any token', icon: '◎', accent: '#22d3ee', prompt: 'Analyze token ' },
    { title: 'Check LP', sub: 'Verify liquidity', icon: '⌘', accent: '#34d399', prompt: 'Check LP lock ' },
    { title: 'Wallet PnL', sub: 'Analyze performance', icon: '▣', accent: '#8b5cf6', prompt: 'Analyze wallet PnL ' },
    { title: 'Base Movers', sub: 'Top tokens today', icon: '✧', accent: '#ec4899', prompt: "What's pumping on Base?" },
  ]
  void activeModeConfig; void applyMode; void handleImportFromRadar; void handlePasteContract; void handlePasteWallet; void chips

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className='clk-page'>
      <style>{`
        .clk-page {
          position: relative;
          min-height: 100%;
          overflow-x: hidden;
          color: #e5edf8;
          background:
            radial-gradient(circle at 78% 10%, rgba(76, 29, 149, .22), transparent 30%),
            radial-gradient(circle at 18% 2%, rgba(20, 184, 166, .13), transparent 28%),
            linear-gradient(180deg, #020611 0%, #050914 46%, #02040b 100%);
        }
        .clk-grid { position:absolute; inset:0; pointer-events:none; background-image: linear-gradient(rgba(34,211,238,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.055) 1px, transparent 1px), radial-gradient(rgba(148,163,184,.16) 1px, transparent 1.4px); background-size: 36px 36px, 36px 36px, 18px 18px; mask-image: radial-gradient(ellipse 74% 50% at 58% 5%, black 0%, transparent 76%); }
        .clk-glow { position:absolute; pointer-events:none; inset:0; background: radial-gradient(circle at 73% 12%, rgba(34,211,238,.14), transparent 20%), radial-gradient(circle at 88% 30%, rgba(168,85,247,.14), transparent 24%), radial-gradient(circle at 8% 60%, rgba(45,212,191,.06), transparent 30%); }
        .clk-shell { position:relative; z-index:1; width:100%; max-width: 1500px; margin:0 auto; padding: 24px 24px 48px; display:grid; grid-template-columns: minmax(0, 1fr) 340px; gap:22px; align-items:start; }
        .clk-main { min-width:0; }
        .clk-hero { display:grid; grid-template-columns: minmax(0, 1fr) 200px; gap:18px; align-items:center; padding: 8px 0 18px; border-bottom:1px solid rgba(148,163,184,.12); }
        .clk-title-row { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
        .clk-title { margin:0; font-size: clamp(42px, 4vw, 58px); font-weight: 850; letter-spacing:-.045em; line-height:.98; color:#f8fafc; }
        .clk-title-ai { background: linear-gradient(110deg, #22d3ee 10%, #7c3aed 58%, #c084fc 96%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
        .clk-ready-pill { border:1px solid rgba(45,212,191,.36); border-radius:999px; padding:10px 18px; color:#5eead4; background:rgba(6,20,30,.72); font:700 12px var(--font-plex-mono, monospace); letter-spacing:.12em; box-shadow: inset 0 1px 0 rgba(255,255,255,.04); }
        .clk-subtitle { margin:18px 0 16px; color:#a8b4c7; font-size:17px; line-height:1.55; }
        .clk-live-row { display:flex; align-items:center; gap:12px; color:#7c8aa1; font:700 12px var(--font-plex-mono, monospace); letter-spacing:.12em; text-transform:uppercase; }
        .clk-live-dot { width:10px; height:10px; border-radius:999px; background:#10b981; box-shadow:0 0 0 6px rgba(16,185,129,.12), 0 0 20px rgba(16,185,129,.65); }
        .clk-live-label { color:#34d399; }
        .clk-live-sep { color:#334155; }
        .clk-live-cortex { color:#22d3ee; }
        .clk-cortex-card { justify-self:end; width:190px; min-height:96px; border:1px solid rgba(148,163,184,.18); border-radius:14px; background:linear-gradient(180deg, rgba(7,13,24,.96), rgba(2,6,14,.98)); box-shadow:inset 0 1px 0 rgba(255,255,255,.05), 0 18px 38px -28px rgba(0,0,0,.9); padding:12px; overflow:hidden; position:relative; }
        .clk-cortex-card::after { content:''; position:absolute; inset:0; pointer-events:none; background:repeating-linear-gradient(180deg, rgba(255,255,255,.025) 0 1px, transparent 1px 6px); opacity:.45; }
        .clk-cortex-title { color:#e2e8f0; font:900 11px var(--font-plex-mono, monospace); letter-spacing:.14em; margin-bottom:8px; }
        .clk-cortex-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; padding:4px 0; border-top:1px solid rgba(148,163,184,.10); font:700 10px var(--font-plex-mono, monospace); text-transform:uppercase; }
        .clk-cortex-label { color:#7f8ea3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-cortex-value { color:#34d399; }
        .clk-cortex-value--muted { color:#94a3b8; }
        .clk-actions-row { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; margin:14px 0 18px; }
        .clk-quick-card { position:relative; min-height:96px; height:100%; text-align:left; display:flex; gap:14px; align-items:center; border:1px solid rgba(148,163,184,.14); border-radius:16px; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, rgba(11,18,32,.86)) 0%, rgba(4,9,20,.9) 58%, rgba(2,6,14,.96) 100%); padding:18px 20px; color:#f8fafc; cursor:pointer; transition: border-color .18s, transform .18s, background .18s, box-shadow .18s; box-shadow: inset 0 1px 0 rgba(255,255,255,.055), 0 18px 34px -24px rgba(0,0,0,.85); overflow:hidden; }
        .clk-quick-card::before { content:''; position:absolute; inset:0; border-radius:inherit; padding:1px; background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 42%, transparent), rgba(148,163,184,.08), rgba(236,72,153,.14)); -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor; mask-composite:exclude; opacity:.62; pointer-events:none; }
        .clk-quick-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 55%, rgba(148,163,184,.35)); background:linear-gradient(135deg, color-mix(in srgb, var(--accent) 15%, rgba(13,24,42,.94)), rgba(5,12,25,.96)); box-shadow: inset 0 1px 0 rgba(255,255,255,.07), 0 16px 34px -14px color-mix(in srgb, var(--accent) 48%, transparent); }
        .clk-quick-icon { width:44px; height:44px; border-radius:13px; display:grid; place-items:center; border:1px solid color-mix(in srgb, var(--accent) 72%, rgba(255,255,255,.08)); color:var(--accent); background: color-mix(in srgb, var(--accent) 13%, rgba(2,6,23,.7)); box-shadow:0 0 18px -8px var(--accent); flex:0 0 auto; }
        .clk-quick-copy { display:flex; min-width:0; flex:1 1 auto; flex-direction:column; justify-content:center; }
        .clk-quick-title { display:block; margin:0 0 4px; font-weight:820; font-size:15px; line-height:1.3; letter-spacing:-.01em; white-space:normal; word-break:break-word; }
        .clk-quick-sub { display:block; margin:0; color:#98a7bb; font-size:12px; font-weight:650; line-height:1.4; white-space:normal; word-break:break-word; }
        .clk-console { border:1px solid rgba(59,130,246,.22); border-radius:20px; background:linear-gradient(180deg, rgba(8,15,30,.86), rgba(3,7,17,.95)); box-shadow:0 24px 60px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.045); overflow:hidden; }
        .clk-tabs { display:grid; grid-template-columns:1fr 1fr; border-bottom:1px solid rgba(148,163,184,.14); }
        .clk-tab { min-height:58px; border:0; border-right:1px solid rgba(148,163,184,.12); background:rgba(15,23,42,.22); color:#b7c2d4; font-weight:750; font-size:16px; cursor:pointer; display:flex; gap:10px; align-items:center; justify-content:center; }
        .clk-tab:last-child { border-right:0; }
        .clk-tab--active { color:#22d3ee; background:linear-gradient(180deg, rgba(34,211,238,.10), rgba(34,211,238,.025)); box-shadow: inset 0 1px 0 rgba(34,211,238,.24); }
        .clk-thread { position:relative; min-height:230px; max-height:430px; overflow-y:auto; padding:20px 20px 14px; display:flex; flex-direction:column; gap:14px; background-image: linear-gradient(rgba(34,211,238,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.028) 1px, transparent 1px), repeating-linear-gradient(180deg, rgba(255,255,255,.018) 0 1px, transparent 1px 7px); background-size:32px 32px, 32px 32px, 100% 8px; }
        .clk-thread-top { display:flex; justify-content:flex-end; }
        .clk-clear-btn { border:0; background:transparent; color:#98a6ba; cursor:pointer; font-size:13px; }
        .clk-intro { display:grid; grid-template-columns:38px minmax(0,1fr); gap:14px; max-width:720px; padding:16px; border:1px solid rgba(45,212,191,.18); border-radius:16px; background:linear-gradient(135deg, rgba(14,24,42,.78), rgba(4,9,20,.78)); box-shadow:inset 0 1px 0 rgba(255,255,255,.045); }
        .clk-intro-title { color:#67e8f9; font:800 12px var(--font-plex-mono, monospace); letter-spacing:.12em; text-transform:uppercase; margin:2px 0 7px; }
        .clk-intro-text { margin:0; color:#c4cede; line-height:1.55; font-size:14px; white-space:pre-line; }
        .clk-capabilities { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
        .clk-capability { border:1px solid rgba(45,212,191,.22); border-radius:999px; padding:5px 8px; color:#a7f3d0; background:rgba(45,212,191,.07); font:800 10px var(--font-plex-mono, monospace); letter-spacing:.08em; text-transform:uppercase; }
        .clk-msg { max-width:84%; padding:10px 12px; border-radius:8px; border:1px solid rgba(148,163,184,.14); background:rgba(8,13,24,.82); box-shadow:inset 0 1px 0 rgba(255,255,255,.035); }
        .clk-msg--user { align-self:flex-end; border-color:rgba(34,211,238,.20); background:rgba(7,24,34,.72); }
        .clk-msg--clark { align-self:flex-start; border-left-color:rgba(45,212,191,.34); }
        .clk-msg-role { display:flex; gap:8px; align-items:center; margin-bottom:7px; color:#22d3ee; font:800 10px var(--font-plex-mono, monospace); letter-spacing:.14em; text-transform:uppercase; }
        .clk-msg-role::after { content:attr(data-intent); color:#64748b; font-weight:700; letter-spacing:.10em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-msg-text { margin:0; font-size:14px; line-height:1.62; color:#dbe6f6; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
        .clk-intent-badge { display:inline-flex; width:max-content; margin:0 0 8px; padding:4px 8px; border:1px solid rgba(45,212,191,.28); border-radius:999px; color:#67e8f9; background:rgba(45,212,191,.08); font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
        .clk-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
        .clk-action { border:1px solid rgba(45,212,191,.25); border-radius:999px; padding:7px 10px; color:#ccfbf1; background:rgba(45,212,191,.07); font-size:12px; font-weight:700; text-decoration:none; }
        .clk-action--disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .clk-action--btn { cursor:pointer; font-family:inherit; }
        .clk-thinking { display:block; min-width:260px; }
        .clk-thinking-stage { color:#dbeafe; font:800 12px var(--font-plex-mono, monospace); letter-spacing:.04em; transition:opacity .2s; }
        .clk-scanline { position:relative; height:2px; margin-top:10px; overflow:hidden; background:rgba(148,163,184,.12); }
        .clk-scanline::before { content:''; position:absolute; inset:0 auto 0 0; width:42%; background:linear-gradient(90deg, transparent, rgba(45,212,191,.9), transparent); animation:clkScan 1.15s linear infinite; }
        @keyframes clkScan { from{ transform:translateX(-100%);} to{ transform:translateX(260%);} }
        .clk-input-wrap { margin:0 18px 16px; border:1px solid rgba(34,211,238,.50); border-radius:14px; background:linear-gradient(180deg, rgba(2,8,20,.86), rgba(2,6,16,.94)); box-shadow:0 0 24px rgba(34,211,238,.09), inset 0 1px 0 rgba(255,255,255,.045); }
        .clk-input-row { display:grid; grid-template-columns:42px minmax(0, 1fr) auto 46px; gap:10px; align-items:center; min-height:62px; padding:8px 10px 8px 12px; }
        .clk-prompt-mark { height:34px; border-radius:10px; display:grid; place-items:center; color:#22d3ee; font:900 16px var(--font-plex-mono, monospace); background:rgba(34,211,238,.08); border:1px solid rgba(34,211,238,.18); box-shadow:inset 0 1px 0 rgba(255,255,255,.04); }
        .clk-panel-input { width:100%; background:transparent; border:0; outline:0; color:#e5edf8; font-size:16px; caret-color:#22d3ee; }
        .clk-panel-input::placeholder { color:#8d99ab; }
        .clk-helper { color:#94a3b8; font-size:12px; white-space:nowrap; }
        .clk-send-btn { width:42px; height:42px; border-radius:12px; border:1px solid rgba(34,211,238,.62); color:#67e8f9; background:linear-gradient(180deg, rgba(34,211,238,.14), rgba(14,22,36,.72)); display:grid; place-items:center; cursor:pointer; transition:transform .16s, box-shadow .16s, border-color .16s, background .16s; }
        .clk-send-btn:not(:disabled):hover { transform:translateY(-1px); box-shadow:0 0 22px rgba(34,211,238,.24); border-color:rgba(94,234,212,.74); }
        .clk-send-btn:disabled { opacity:.38; cursor:not-allowed; box-shadow:none; }
        .clk-upgrade-note { margin:0 18px 12px; padding:11px 14px; border:1px solid rgba(139,92,246,.28); border-radius:12px; background:rgba(139,92,246,.08); color:#c4b5fd; display:flex; justify-content:space-between; gap:12px; font-size:13px; }
        .clk-upgrade-link { color:#e9d5ff; text-decoration:none; font-weight:800; }
        .clk-usage { display:flex; align-items:center; gap:12px; padding:0 18px 18px; }
        .clk-usage-label, .clk-usage-count { font:700 11px var(--font-plex-mono, monospace); color:#728198; white-space:nowrap; }
        .clk-usage-track { flex:1; height:5px; border-radius:999px; background:rgba(148,163,184,.13); overflow:hidden; }
        .clk-usage-fill { height:100%; border-radius:999px; transition:width .5s; }
        .clk-intel { margin-top:20px; }
        .clk-intel-head { margin:0 0 12px; }
        .clk-intel-title { margin:0; color:#f1f5f9; font-size:17px; font-weight:850; letter-spacing:-.01em; }
        .clk-intel-desc { margin:4px 0 0; color:#8391a7; font-size:13px; }
        .clk-intel-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; }
        .clk-intel-card { position:relative; min-height:158px; height:100%; display:flex; flex-direction:column; border:1px solid rgba(148,163,184,.14); border-radius:16px; background:linear-gradient(145deg, rgba(12,20,36,.82), rgba(5,10,22,.9)); padding:20px; box-shadow: inset 0 1px 0 rgba(255,255,255,.045), 0 18px 36px -28px rgba(0,0,0,.8); overflow:hidden; }
        .clk-intel-card:not(.clk-intel-card--empty) { border-color: color-mix(in srgb, var(--accent) 38%, rgba(148,163,184,.2)); }
        .clk-intel-icon { display:inline-flex; width:30px; height:30px; border-radius:9px; align-items:center; justify-content:center; margin-bottom:14px; color: var(--accent, #94a3b8); border:1px solid color-mix(in srgb, var(--accent, #475569) 45%, transparent); background: color-mix(in srgb, var(--accent, #475569) 10%, transparent); flex:0 0 auto; }
        .clk-intel-card--empty .clk-intel-icon { color:#7c8aa1; border-color:rgba(148,163,184,.22); background:rgba(148,163,184,.06); }
        .clk-intel-label { color:#e7edf6; font-weight:700; font-size:14px; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-intel-card--empty .clk-intel-label { color:#9aa8bb; }
        .clk-intel-sub { color:#94a3b8; font-size:13px; line-height:1.55; margin:8px 0 0; white-space:normal; word-break:break-word; }
        .clk-intel-cta { position:relative; left:auto; right:auto; bottom:auto; margin-top:auto; padding-top:14px; border-top:1px solid rgba(148,163,184,.12); color:#67e8f9; font:800 10px var(--font-plex-mono, monospace); letter-spacing:.10em; text-transform:uppercase; opacity:.78; }
        .clk-side { display:flex; flex-direction:column; gap:16px; }
        .clk-side-card { border:1px solid rgba(148,163,184,.16); border-radius:16px; background:linear-gradient(180deg, rgba(10,18,34,.8), rgba(3,7,17,.94)); padding:20px; box-shadow: inset 0 1px 0 rgba(255,255,255,.045), 0 14px 32px -16px rgba(0,0,0,.55); }
        .clk-side-card:hover { border-color: rgba(34,211,238,.22); }
        .clk-side-title { display:flex; align-items:center; gap:11px; margin:0 0 16px; padding-bottom:14px; border-bottom:1px solid rgba(148,163,184,.12); color:#f1f5f9; font-size:15px; font-weight:850; letter-spacing:-.01em; }
        .clk-side-title svg { color:#22d3ee; }
        .clk-context-row { padding:0 0 15px; margin-bottom:15px; border-bottom:1px solid rgba(148,163,184,.11); }
        .clk-context-row:last-child { margin-bottom:0; padding-bottom:0; border-bottom:0; }
        .clk-context-label { color:#a5b4c8; font:700 11px var(--font-plex-mono, monospace); letter-spacing:.10em; text-transform:uppercase; margin-bottom:8px; }
        .clk-context-value { color:#f8fafc; font-size:17px; font-weight:780; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-context-sub { color:#93a2b7; font-size:13px; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-history-list { display:flex; flex-direction:column; gap:12px; }
        .clk-history-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; color:#cbd5e1; font-size:14px; }
        .clk-history-row span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-history-time { color:#94a3b8; font-size:12px; }
        .clk-empty { margin:0; color:#8795aa; font-size:13px; line-height:1.55; padding:12px; border:1px dashed rgba(148,163,184,.18); border-radius:12px; background:rgba(148,163,184,.035); }
        .clk-memory-stat { display:flex; justify-content:space-between; gap:12px; color:#cbd5e1; font-size:14px; padding:8px 0; }
        .clk-memory-stat strong { color:#34d399; }
        .clark-orb-shell { border-radius:999px; position:relative; display:inline-flex; align-items:center; justify-content:center; background:radial-gradient(circle at 30% 25%, rgba(148,163,184,.24), rgba(2,6,23,.96) 62%); border:1px solid rgba(148,163,184,.34); box-shadow:inset 0 1px 0 rgba(255,255,255,.08), 0 0 20px rgba(45,212,191,.22), 0 0 28px rgba(139,92,246,.20); overflow:hidden; flex-shrink:0; }
        .clark-orb-ring { position:absolute; inset:3px; border-radius:999px; border:1px solid rgba(45,212,191,.25); opacity:.9; }
        .clark-orb-core { position:relative; width:100%; height:100%; border-radius:999px; }
        .clark-orb-dot { position:absolute; width:7px; height:7px; border-radius:999px; filter:blur(.1px); }
        .clark-orb-dot-a { left:34%; top:44%; background:#67e8f9; box-shadow:0 0 16px rgba(103,232,249,.95); animation:clarkDotA 2.4s ease-in-out infinite; }
        .clark-orb-dot-b { right:30%; top:44%; background:#c4b5fd; box-shadow:0 0 16px rgba(196,181,253,.9); animation:clarkDotB 2.1s ease-in-out infinite; }
        .clark-orb-shell.thinking::after { content:''; position:absolute; inset:-6px; border-radius:999px; border:1px solid rgba(45,212,191,.22); animation:clarkPulse 1.6s ease-out infinite; }
        @keyframes clarkDotA { 0%,100%{ transform:translate(0,0) scale(1);} 50%{ transform:translate(2px,-2px) scale(1.18);} }
        @keyframes clarkDotB { 0%,100%{ transform:translate(0,0) scale(1);} 50%{ transform:translate(-2px,2px) scale(1.16);} }
        @keyframes clarkPulse { 0%{ transform:scale(.94); opacity:.7;} 100%{ transform:scale(1.08); opacity:0;} }
        @media (max-width: 1100px) { .clk-shell { grid-template-columns:1fr; } .clk-side { grid-template-columns:repeat(3, minmax(0,1fr)); display:grid; } }
        @media (max-width: 780px) { .clk-shell { padding:20px 14px 44px; } .clk-hero { grid-template-columns:1fr; } .clk-cortex-card { justify-self:stretch; width:auto; } .clk-actions-row { grid-template-columns:1fr 1fr; } .clk-side { display:flex; } .clk-thread { min-height:220px; padding:16px 14px 12px; } .clk-input-row { grid-template-columns:36px minmax(0,1fr) 44px; } .clk-helper { display:none; } .clk-intel-grid { grid-template-columns:1fr 1fr; } }
        @media (max-width: 480px) { .clk-actions-row { grid-template-columns:1fr; } .clk-title { font-size:40px; } .clk-ready-pill { padding:8px 12px; } .clk-intel-grid { grid-template-columns:1fr; } }
      `}</style>

      <div aria-hidden='true'>
        <div className='clk-grid' />
        <div className='clk-glow' />
      </div>

      <div className='clk-shell'>
        <main className='clk-main'>
          <section className='clk-hero'>
            <div>
              <div className='clk-title-row'>
                <h1 className='clk-title'>Clark <span className='clk-title-ai'>AI</span></h1>
                <span className='clk-ready-pill'>CORTEX READY</span>
              </div>
              <p className='clk-subtitle'>Base-native AI analyst for tokens, wallets, liquidity, and onchain risk.</p>
              <div className='clk-live-row'>
                <span className='clk-live-dot' />
                <span className='clk-live-label'>LIVE</span>
                <span className='clk-live-sep'>|</span>
                <span className='clk-live-cortex'>POWERED BY CORTEX ENGINE</span>
              </div>
            </div>
            <div className='clk-cortex-card' aria-label='CORTEX status'>
              <div className='clk-cortex-title'>CORTEX STATUS</div>
              {[
                ['Memory Engine', messages.length > 0 ? 'Active' : 'Ready'],
                ['Token Context', clientContext.lastToken ? 'Ready' : 'Standby'],
                ['Wallet Context', clientContext.lastWallet ? 'Ready' : 'Standby'],
                ['Analysis Mode', activeMode === 'radar' ? 'Radar' : 'Adaptive'],
                ['System', loading ? 'Working' : 'Online'],
              ].map(([label, value]) => (
                <div className='clk-cortex-row' key={label}>
                  <span className='clk-cortex-label'>{label}</span>
                  <span className={`clk-cortex-value${value === 'Standby' ? ' clk-cortex-value--muted' : ''}`}>{value}</span>
                </div>
              ))}
            </div>
          </section>

          <section className='clk-actions-row' aria-label='Clark quick actions'>
            {quickActions.map((action) => (
              <button
                key={action.title}
                className='clk-quick-card'
                style={{ '--accent': action.accent } as CSSProperties}
                onClick={() => setInput(action.prompt)}
              >
                <span className='clk-quick-icon'>{action.icon}</span>
                <span className='clk-quick-copy'>
                  <span className='clk-quick-title'>{action.title}</span>
                  <span className='clk-quick-sub'>{action.sub}</span>
                </span>
              </button>
            ))}
          </section>

          <section className='clk-console'>
            <div className='clk-tabs'>
              <button className={`clk-tab${uiTab === 'analyst' ? ' clk-tab--active' : ''}`} onClick={() => setUiTab('analyst')}>
                <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M3 17l6-6 4 4 7-8'/><path d='M14 7h6v6'/></svg>
                Analyst
              </button>
              <button className={`clk-tab${uiTab === 'chat' ? ' clk-tab--active' : ''}`} onClick={() => setUiTab('chat')}>
                <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'/></svg>
                Chat
              </button>
            </div>

            <div className='clk-thread' ref={threadRef}>
              <div className='clk-thread-top'>
                {hasMessages && <button onClick={handleClear} className='clk-clear-btn'>Clear conversation</button>}
              </div>
              <div className='clk-intro'>
                <ClarkOrb size={38} thinking={loading && !hasMessages} />
                <div>
                  <div className='clk-intro-title'>Clark is ready.</div>
                  <p className='clk-intro-text'>System boot complete. Ask Clark for token reads, wallet behavior, liquidity checks, or current Base movers.</p>
                  <div className='clk-capabilities' aria-label='Clark capabilities'>
                    <span className='clk-capability'>Token reads</span>
                    <span className='clk-capability'>Wallet analysis</span>
                    <span className='clk-capability'>LP checks</span>
                    <span className='clk-capability'>Base movers</span>
                  </div>
                </div>
              </div>
              {messages.map((msg, idx) => {
                const isThinking = msg.role === 'clark' && loading && msg.text === THINKING_MESSAGE
                return (
                  <div key={idx} className={`clk-msg clk-msg--${msg.role}`}>
                    <span className='clk-msg-role' data-intent={msg.role === 'user' ? msg.text.slice(0, 34) : (msg.intentBadge ?? (activeMode === 'wallet' ? 'WALLET PROFILE' : activeMode === 'token' ? 'TOKEN READ' : activeMode === 'contract' ? 'RISK READ' : 'INTELLIGENCE'))}>{msg.role === 'user' ? 'USER' : 'CLARK'}</span>
                    {isThinking ? (
                      <div className='clk-thinking'>
                        <div className='clk-thinking-stage'>{loadingStages[loadingStage] ?? loadingStages[0]}</div>
                        <div className='clk-scanline' />
                      </div>
                    ) : (
                      <>
                        {msg.intentBadge && <span className='clk-intent-badge'>{msg.intentBadge}</span>}
                        <p className='clk-msg-text'>{msg.text}</p>
                        {msg.actions && msg.actions.length > 0 && (
                          <div className='clk-actions'>
                            {msg.actions.map((action) => action.kind === 'prompt' && action.prompt ? (
                              <button
                                key={`${action.label}-${action.prompt}`}
                                type='button'
                                className='clk-action clk-action--btn'
                                onClick={() => { void handleSendText(action.prompt as string) }}
                              >
                                {action.label}
                              </button>
                            ) : (
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

            {isLimited && (
              <div className='clk-upgrade-note'>
                <span>Base momentum preview is available on Pro and Elite. Upgrade to unlock the full market read.</span>
                <a href='/pricing' className='clk-upgrade-link'>Upgrade →</a>
              </div>
            )}

            <div className='clk-input-wrap'>
              <div className='clk-input-row'>
                <span className='clk-prompt-mark'>›</span>
                <input
                  className='clk-panel-input'
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !loading) { e.preventDefault(); void handleSend() } }}
                  disabled={loading}
                  placeholder='Enter onchain command…'
                />
                <span className='clk-helper'>Shift + Enter for new line</span>
                <button className='clk-send-btn' onClick={() => void handleSend()} disabled={loading || !input.trim() || isLimited} aria-label='Send'>
                  <svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M22 2 11 13'/><path d='m22 2-7 20-4-9-9-4Z'/></svg>
                </button>
              </div>
            </div>

            <div className='clk-usage'>
              <span className='clk-usage-label'>Usage today</span>
              <div className='clk-usage-track'>
                <div className='clk-usage-fill' style={{ width: `${usagePct}%`, background: isLimited ? 'linear-gradient(90deg,#ef4444,#f43f5e)' : planLimit !== null && clarkUsed / planLimit >= 0.8 ? 'linear-gradient(90deg,#f59e0b,#ef4444)' : 'linear-gradient(90deg,#2dd4bf,#8b5cf6)' }} />
              </div>
              <span className='clk-usage-count'>{clarkUsed} / {planLimit ?? '...'}</span>
            </div>
          </section>

          <section className='clk-intel'>
            <div className='clk-intel-head'>
              <h2 className='clk-intel-title'>Recent Intelligence</h2>
              <p className='clk-intel-desc'>Your latest Clark reads will appear here.</p>
            </div>
            <div className='clk-intel-grid'>
              {recentTokens.length > 0 ? (
                recentTokens.map((t, idx) => (
                  <div className='clk-intel-card' key={`${t.symbol}-${idx}`} style={{ '--accent': '#22d3ee' } as CSSProperties}>
                    <span className='clk-intel-icon'>◎</span>
                    <div className='clk-intel-label'>{t.symbol}</div>
                    <div className='clk-intel-sub'>{t.reasonTag ?? 'From recent Base read'}</div><div className='clk-intel-cta'>Open latest context</div>
                  </div>
                ))
              ) : (
                <div className='clk-intel-card clk-intel-card--empty'>
                  <span className='clk-intel-icon'>◎</span>
                  <div className='clk-intel-label'>No token read yet</div>
                  <div className='clk-intel-sub'>Run a token scan to populate this module.</div><div className='clk-intel-cta'>Awaiting first read</div>
                </div>
              )}
              {recentWalletValue ? (
                <div className='clk-intel-card' style={{ '--accent': '#8b5cf6' } as CSSProperties}>
                  <span className='clk-intel-icon'>▣</span>
                  <div className='clk-intel-label'>{recentWalletValue}</div>
                  <div className='clk-intel-sub'>Last wallet read</div><div className='clk-intel-cta'>Wallet memory active</div>
                </div>
              ) : (
                <div className='clk-intel-card clk-intel-card--empty'>
                  <span className='clk-intel-icon'>▣</span>
                  <div className='clk-intel-label'>No wallet read yet</div>
                  <div className='clk-intel-sub'>Scan a wallet to build wallet memory.</div><div className='clk-intel-cta'>Awaiting wallet</div>
                </div>
              )}
              <div className='clk-intel-card clk-intel-card--empty'>
                <span className='clk-intel-icon'>⌘</span>
                <div className='clk-intel-label'>No LP check yet</div>
                <div className='clk-intel-sub'>Run an LP check to track liquidity proof.</div><div className='clk-intel-cta'>Awaiting proof</div>
              </div>
            </div>
          </section>
        </main>

        <aside className='clk-side'>
          <section className='clk-side-card'>
            <h2 className='clk-side-title'><svg width='19' height='19' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><circle cx='12' cy='12' r='2'/><path d='M16.24 7.76 14 10'/><path d='M8 16l2-2'/><path d='M14 14l2.24 2.24'/><path d='M7.76 7.76 10 10'/><circle cx='18' cy='6' r='2'/><circle cx='6' cy='18' r='2'/><circle cx='18' cy='18' r='2'/><circle cx='6' cy='6' r='2'/></svg>Context</h2>
            <div className='clk-context-row'><div className='clk-context-label'>Current Chain</div><div className='clk-context-value'>Base</div><div className='clk-context-sub'>Chain ID: 8453</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Last Token</div><div className='clk-context-value'>{formatContextValue(clientContext.lastToken)}</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Last Wallet</div><div className='clk-context-value'>{formatContextValue(clientContext.lastWallet)}</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Active Mode</div><div className='clk-context-value'>Adaptive Analysis</div><div className='clk-context-sub'>Analysis adapts based on context & onchain data</div></div>
          </section>

          <section className='clk-side-card'>
            <h2 className='clk-side-title'><svg width='19' height='19' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M3 12a9 9 0 1 0 3-6.7'/><path d='M3 3v6h6'/><path d='M12 7v5l3 2'/></svg>Clark Conversation History</h2>
            {historyRows.length > 0 ? (
              <div className='clk-history-list'>
                {historyRows.map((row, idx) => <div className='clk-history-row' key={`${row.text}-${idx}`}><span>{row.text}</span><span className='clk-history-time'>Recent</span></div>)}
              </div>
            ) : <p className='clk-empty'>No Clark history yet. Start a scan to build context.</p>}
          </section>

          <section className='clk-side-card'>
            <h2 className='clk-side-title'><svg width='19' height='19' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><ellipse cx='12' cy='5' rx='9' ry='3'/><path d='M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5'/><path d='M3 12c0 1.7 4 3 9 3s9-1.3 9-3'/></svg>Memory <span style={{ color: '#94a3b8', fontWeight: 500 }}>(This Session)</span></h2>
            {memoryStats.map((stat) => <div className='clk-memory-stat' key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong></div>)}
          </section>
        </aside>
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
