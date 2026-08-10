'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ThinkingOrb } from 'thinking-orbs'
import { supabase } from '@/lib/supabaseClient'
import { getClarkSessionId as getOrCreateSessionId, readClarkClientContext as getClientClarkContext, persistClarkMemoryEcho, persistClarkMomentumList, persistMarketMomentum, readMarketMomentum } from '@/lib/client/clarkMemory'
import ClarkHistoryPanel from '@/components/ClarkHistoryPanel'
import {
  fetchClarkHistory, fetchClarkChatMessages, createClarkChat, createClarkFolder, appendClarkMessage,
  renameClarkChat, renameClarkFolder, moveClarkChatToFolder, deleteClarkChat, deleteClarkFolder,
  ClarkHistoryError, type ClarkChatFolder, type ClarkChatSummary, type ClarkHistoryErrorCode,
} from '@/lib/client/clarkHistoryClient'
import { generateChatTitle } from '@/lib/server/clarkHistory'

const ACTIVE_CHAT_ID_KEY = 'chainlens:clark:active-chat-id'

const HISTORY_STATUS_MESSAGE: Record<ClarkHistoryErrorCode, string> = {
  auth_missing: 'Sign in to save Clark history',
  auth_invalid: 'Sign in to save Clark history',
  table_missing: 'History tables not installed',
  rls_blocked: 'History save blocked by permissions',
  insert_failed: 'History temporarily unavailable',
  select_failed: 'History temporarily unavailable',
  network_error: 'History temporarily unavailable',
}

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

  // ── Persistent chat history (folders/chats/messages) ─────────────────────
  const [folders, setFolders] = useState<ClarkChatFolder[]>([])
  const [chats, setChats] = useState<ClarkChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const [historyErrorCode, setHistoryErrorCode] = useState<ClarkHistoryErrorCode | null>(null)
  const activeChatIdRef = useRef<string | null>(null)
  activeChatIdRef.current = activeChatId
  // BUG FIX, DISCLOSED (Clark chat history audit): previously, switching to a different chat (or
  // starting a new one) while Clark was still answering the PREVIOUS chat would show that delayed
  // answer appended to whichever chat was on screen when it arrived — the reply landed in the wrong
  // conversation. Persistence to the database was always correct (scoped by the chatId captured at
  // send-time), this was purely a live-UI display bug. Fixed by tagging each send with the
  // currently-displayed conversation's "session token" (bumped whenever the visible thread changes
  // to a different conversation) and only applying the reply to `messages` if that token is still
  // current when the response arrives — the DB save still always happens regardless.
  const chatSessionTokenRef = useRef(0)

  function reportHistoryFailure(err: unknown) {
    const code = err instanceof ClarkHistoryError ? err.code : 'network_error'
    setHistorySaveFailed(true)
    setHistoryErrorCode(code)
  }
  function reportHistoryOk() {
    setHistorySaveFailed(false)
    setHistoryErrorCode(null)
  }

  async function refreshHistory(query?: string) {
    try {
      const { folders: f, chats: c } = await fetchClarkHistory(query)
      setFolders(f); setChats(c); reportHistoryOk()
    } catch (err) { reportHistoryFailure(err) }
  }

  useEffect(() => {
    void refreshHistory()
    const savedChatId = typeof window !== 'undefined' ? sessionStorage.getItem(ACTIVE_CHAT_ID_KEY) : null
    if (savedChatId) void loadChat(savedChatId, false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadChat(chatId: string, persistAsActive = true) {
    try {
      const rows = await fetchClarkChatMessages(chatId)
      chatSessionTokenRef.current += 1
      setMessages(rows.map((r) => ({ role: r.role === 'assistant' ? 'clark' : 'user', text: r.content })))
      setActiveChatId(chatId)
      if (persistAsActive && typeof window !== 'undefined') sessionStorage.setItem(ACTIVE_CHAT_ID_KEY, chatId)
    } catch (err) { reportHistoryFailure(err) }
  }

  function handleNewChat() {
    chatSessionTokenRef.current += 1
    setMessages([])
    setActiveChatId(null)
    if (typeof window !== 'undefined') sessionStorage.removeItem(ACTIVE_CHAT_ID_KEY)
  }

  async function ensureActiveChat(firstPrompt: string): Promise<string | null> {
    if (activeChatIdRef.current) return activeChatIdRef.current
    try {
      const title = generateChatTitle(firstPrompt)
      const chat = await createClarkChat(title)
      setActiveChatId(chat.id)
      activeChatIdRef.current = chat.id
      if (typeof window !== 'undefined') sessionStorage.setItem(ACTIVE_CHAT_ID_KEY, chat.id)
      setChats((prev) => [chat, ...prev])
      return chat.id
    } catch (err) {
      reportHistoryFailure(err)
      return null
    }
  }

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
    // BUG FIX, DISCLOSED (Clark chat history audit) — see chatSessionTokenRef's own comment above.
    // Captured now, before any await, so it reflects exactly which conversation was on screen when
    // this send began.
    const sentForToken = chatSessionTokenRef.current
    setLoadingKind(inferAnalysisKind(text, activeMode))
    setLoadingStage(0)
    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'clark', text: THINKING_MESSAGE }])
    setInput('')
    setLoading(true)
    // History save is best-effort and must never block or break sending the message.
    const chatIdPromise = ensureActiveChat(text)
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
      // BUG FIX, DISCLOSED (Clark chat history audit): only apply the reply to the visible thread
      // if the user hasn't switched to a different conversation while this was in flight — see
      // chatSessionTokenRef's own comment. The history save below is unconditional either way, so
      // the message is never lost, just not shown in the wrong chat.
      if (chatSessionTokenRef.current === sentForToken) {
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
      }
      // Fire-and-forget: persist the exchange without blocking or affecting the Clark UI.
      // BUG FIX, DISCLOSED (Clark chat history audit): previously these two appends fired
      // concurrently (neither awaited before the next started). The server does a non-atomic
      // read-current-message_count -> insert -> write-count+1 for each — firing them at the same
      // time let both reads happen before either write landed, silently dropping one increment.
      // Awaiting the first before starting the second removes that race for this pair. Each is
      // still caught independently so a failure on one doesn't block attempting the other, matching
      // the original best-effort semantics. refreshHistory now runs after both are attempted
      // instead of racing ahead of them, which also fixes the sidebar briefly showing a stale
      // preview/count right after sending.
      void chatIdPromise.then(async (chatId) => {
        if (!chatId) return
        await appendClarkMessage(chatId, 'user', text).catch(reportHistoryFailure)
        await appendClarkMessage(chatId, 'assistant', String(reply), payload).catch(reportHistoryFailure)
        void refreshHistory()
      })
    } catch {
      // Same guard as the success path above — don't drop a stale error into a chat the user has
      // since switched away from.
      if (chatSessionTokenRef.current === sentForToken) {
        setMessages((prev) => { const next = [...prev]; next[next.length - 1] = { role: 'clark', text: FALLBACK_ERROR_MESSAGE }; return next })
      }
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
  const startWithChips = [
    { label: 'Token Reads', prompt: 'Scan token ' },
    { label: 'Wallet Analysis', prompt: 'Analyze wallet ' },
    { label: 'LP Checks', prompt: 'Check liquidity risk on ' },
    { label: 'Base Movers', prompt: "What's pumping on Base?" },
  ]
  const recentTokens = (clarkContextRef.current.lastMarketList ?? []).slice(0, 3)
  const recentWalletValue = clientContext.lastWallet ? formatContextValue(clientContext.lastWallet) : null
  const quickActions = [
    { title: "What's pumping on Base?", sub: 'Top tokens today', icon: '✧', accent: '#ec4899', prompt: "What's pumping on Base?" },
    { title: 'Scan BRETT', sub: 'Run Token Scanner', icon: '◎', accent: '#22d3ee', prompt: 'Scan BRETT' },
    { title: 'Show Base whales', sub: 'Open whale flow read', icon: '▣', accent: '#8b5cf6', prompt: 'Show Base whales' },
    { title: 'Liquidity check AERO', sub: 'Run LP safety check', icon: '⌘', accent: '#34d399', prompt: 'Liquidity check AERO' },
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
        .clk-grid { position:absolute; inset:0; pointer-events:none; background-image: linear-gradient(rgba(34,211,238,.028) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.028) 1px, transparent 1px), radial-gradient(rgba(148,163,184,.08) 1px, transparent 1.4px); background-size: 36px 36px, 36px 36px, 18px 18px; mask-image: radial-gradient(ellipse 60% 40% at 58% 5%, black 0%, transparent 76%); }
        .clk-glow { position:absolute; pointer-events:none; inset:0; background: radial-gradient(circle at 73% 12%, rgba(34,211,238,.08), transparent 20%), radial-gradient(circle at 88% 30%, rgba(168,85,247,.08), transparent 24%), radial-gradient(circle at 8% 60%, rgba(45,212,191,.04), transparent 30%); }
        .clk-shell { position:relative; z-index:1; width:100%; max-width: 1500px; margin:0 auto; padding: 22px 24px 44px; display:grid; grid-template-columns: minmax(0, 1fr) 320px; gap:20px; align-items:start; }
        .clk-main { min-width:0; }
        .clk-hero { display:flex; flex-direction:column; gap:12px; padding: 4px 0 14px; border-bottom:1px solid rgba(148,163,184,.12); }
        .clk-title-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
        .clk-title { margin:0; font-size: clamp(34px, 3.2vw, 46px); font-weight: 850; letter-spacing:-.04em; line-height:.98; color:#f8fafc; }
        .clk-title-ai { background: linear-gradient(110deg, #22d3ee 10%, #7c3aed 58%, #c084fc 96%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
        .clk-ready-pill { border:1px solid rgba(45,212,191,.32); border-radius:999px; padding:6px 13px; color:#5eead4; background:rgba(6,20,30,.6); font:700 10.5px var(--font-plex-mono, monospace); letter-spacing:.10em; }
        .clk-subtitle { margin:0; color:#93a2b7; font-size:14px; line-height:1.5; }
        .clk-status-strip { display:flex; align-items:center; flex-wrap:wrap; gap:0; border:1px solid rgba(148,163,184,.14); border-radius:11px; background:rgba(6,11,22,.6); padding:8px 4px; }
        .clk-status-item { display:flex; align-items:center; gap:7px; padding:0 14px; border-right:1px solid rgba(148,163,184,.12); }
        .clk-status-item:last-child { border-right:0; }
        .clk-status-item-dot { width:5px; height:5px; border-radius:999px; flex-shrink:0; }
        .clk-status-item-label { color:#7f8ea3; font:700 10px var(--font-plex-mono, monospace); letter-spacing:.06em; text-transform:uppercase; white-space:nowrap; }
        .clk-status-item-value { color:#cbd5e1; font:700 10px var(--font-plex-mono, monospace); letter-spacing:.02em; white-space:nowrap; }
        .clk-status-item-value--live { color:#34d399; }
        .clk-status-item-value--muted { color:#5b6b84; }
        .clk-live-cortex { margin-left:auto; padding:0 4px 0 14px; color:#6d7c94; font:700 9.5px var(--font-plex-mono, monospace); letter-spacing:.10em; white-space:nowrap; }
        .clk-actions-row { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:9px; margin:12px 0 14px; }
        .clk-quick-card { position:relative; height:100%; text-align:left; display:flex; gap:10px; align-items:center; border:1px solid rgba(148,163,184,.14); border-radius:10px; background:rgba(9,15,28,.6); padding:11px 13px; color:#f8fafc; cursor:pointer; transition: border-color .15s, background .15s; overflow:hidden; }
        .clk-quick-card:hover { border-color: color-mix(in srgb, var(--accent) 45%, rgba(148,163,184,.3)); background:rgba(13,21,38,.78); }
        .clk-quick-icon { width:22px; height:22px; border-radius:6px; display:grid; place-items:center; font-size:12px; border:1px solid color-mix(in srgb, var(--accent) 55%, rgba(255,255,255,.08)); color:var(--accent); background: color-mix(in srgb, var(--accent) 12%, rgba(2,6,23,.7)); flex:0 0 auto; }
        .clk-quick-copy { display:flex; min-width:0; flex:1 1 auto; flex-direction:column; justify-content:center; }
        .clk-quick-title { display:block; margin:0; font-weight:700; font-size:12.5px; line-height:1.3; letter-spacing:-.005em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .clk-quick-sub { display:block; margin:0; color:#71809a; font-size:10.5px; font-weight:600; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .clk-console { border:1px solid rgba(59,130,246,.16); border-radius:14px; background:rgba(6,11,22,.7); overflow:hidden; }
        .clk-tabs { display:grid; grid-template-columns:1fr 1fr; border-bottom:1px solid rgba(148,163,184,.12); }
        .clk-tab { min-height:42px; border:0; border-right:1px solid rgba(148,163,184,.1); background:transparent; color:#8794a8; font-weight:700; font-size:13px; cursor:pointer; display:flex; gap:8px; align-items:center; justify-content:center; transition:background .15s, color .15s; }
        .clk-tab:hover { color:#b7c2d4; }
        .clk-tab:last-child { border-right:0; }
        .clk-tab--active { color:#22d3ee; background:rgba(34,211,238,.06); box-shadow: inset 0 1px 0 rgba(34,211,238,.2); }
        .clk-tab svg { width:15px; height:15px; }
        .clk-thread { position:relative; min-height:0; max-height:560px; overflow-y:auto; padding:16px 22px 12px; display:flex; flex-direction:column; gap:14px; background-image: linear-gradient(rgba(34,211,238,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.014) 1px, transparent 1px); background-size:32px 32px, 32px 32px; }
        .clk-thread-top { display:flex; justify-content:flex-end; min-height:0; }
        .clk-clear-btn { border:0; background:transparent; color:#98a6ba; cursor:pointer; font-size:13px; }
        .clk-intro { display:flex; align-items:center; gap:13px; max-width:720px; padding:12px 15px; border:1px solid rgba(45,212,191,.16); border-radius:12px; background:rgba(12,20,36,.5); }
        .clk-intro-title { color:#67e8f9; font:800 11px var(--font-plex-mono, monospace); letter-spacing:.10em; text-transform:uppercase; margin:0 0 4px; }
        .clk-intro-text { margin:0; color:#98a7bb; line-height:1.45; font-size:12.5px; white-space:pre-line; }
        .clk-capabilities { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
        .clk-capability { border:1px solid rgba(45,212,191,.18); border-radius:999px; padding:3px 7px; color:#8fd6c2; background:rgba(45,212,191,.05); font:700 9px var(--font-plex-mono, monospace); letter-spacing:.06em; text-transform:uppercase; }
        .clk-intro--empty { align-items:flex-start; width:100%; max-width:none; padding:22px 24px; gap:18px; }
        .clk-intro-body { min-width:0; flex:1 1 auto; }
        .clk-start-with { margin-top:16px; }
        .clk-start-with-label { display:block; margin-bottom:8px; color:#5b6b84; font:750 10px var(--font-plex-mono, monospace); letter-spacing:.10em; text-transform:uppercase; }
        .clk-start-with-row { display:flex; flex-wrap:wrap; gap:8px; }
        .clk-start-chip { border:1px solid rgba(34,211,238,.24); border-radius:9px; background:rgba(34,211,238,.05); color:#a7e8f5; font-weight:700; font-size:12.5px; padding:8px 13px; cursor:pointer; transition:border-color .15s, background .15s, color .15s; }
        .clk-start-chip:hover { border-color:rgba(45,212,191,.5); background:rgba(45,212,191,.1); color:#ccfbf1; }
        .clk-msg { max-width:min(88%, 760px); padding:15px 17px; border-radius:20px; border:1px solid rgba(148,163,184,.13); background:linear-gradient(145deg, rgba(13,22,38,.92), rgba(6,11,24,.88)); box-shadow:0 14px 30px rgba(0,0,0,.18), inset 0 1px 0 rgba(255,255,255,.05); }
        .clk-msg--user { align-self:flex-end; border-color:rgba(34,211,238,.22); border-bottom-right-radius:8px; background:linear-gradient(145deg, rgba(9,44,55,.82), rgba(7,24,34,.76)); }
        .clk-msg--clark { align-self:flex-start; border-color:rgba(45,212,191,.18); border-bottom-left-radius:8px; }
        .clk-msg-role { display:flex; gap:8px; align-items:center; margin-bottom:8px; color:#67e8f9; font:750 11px var(--font-inter, sans-serif); letter-spacing:.02em; text-transform:none; }
        .clk-msg-role::after { content:attr(data-intent); color:#7c8aa1; font-weight:600; letter-spacing:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.72; }
        .clk-msg-text { margin:0; font-size:15px; line-height:1.68; color:#e1e9f5; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
        .clk-intent-badge { display:inline-flex; width:max-content; margin:0 0 8px; padding:4px 8px; border:1px solid rgba(45,212,191,.28); border-radius:999px; color:#67e8f9; background:rgba(45,212,191,.08); font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
        .clk-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
        .clk-action { border:1px solid rgba(45,212,191,.25); border-radius:999px; padding:7px 10px; color:#ccfbf1; background:rgba(45,212,191,.07); font-size:12px; font-weight:700; text-decoration:none; }
        .clk-action--disabled { opacity:.45; cursor:not-allowed; pointer-events:none; }
        .clk-action--btn { cursor:pointer; font-family:inherit; }
        .clk-thinking { display:flex; align-items:center; gap:12px; min-width:260px; }
        .clk-thinking-stage { color:#dbeafe; font:800 12px var(--font-plex-mono, monospace); letter-spacing:.04em; transition:opacity .2s; }
        .clk-scanline { position:relative; height:2px; margin-top:10px; overflow:hidden; background:rgba(148,163,184,.12); }
        .clk-scanline::before { content:''; position:absolute; inset:0 auto 0 0; width:42%; background:linear-gradient(90deg, transparent, rgba(45,212,191,.9), transparent); animation:clkScan 1.15s linear infinite; }
        @keyframes clkScan { from{ transform:translateX(-100%);} to{ transform:translateX(260%);} }
        .clk-input-wrap { margin:10px 18px 14px; border:1px solid rgba(34,211,238,.36); border-radius:14px; background:rgba(3,9,20,.9); }
        .clk-input-row { display:grid; grid-template-columns:40px minmax(0, 1fr) auto 46px; gap:10px; align-items:center; min-height:62px; padding:8px 10px 8px 12px; }
        .clk-prompt-mark { height:36px; border-radius:9px; display:grid; place-items:center; color:#22d3ee; font:900 15px var(--font-plex-mono, monospace); background:rgba(34,211,238,.06); border:1px solid rgba(34,211,238,.16); }
        .clk-panel-input { width:100%; background:transparent; border:0; outline:0; color:#e5edf8; font-size:15px; caret-color:#22d3ee; }
        .clk-panel-input::placeholder { color:#7d899c; }
        .clk-helper { color:#7f8ea3; font-size:11px; white-space:nowrap; }
        .clk-send-btn { width:36px; height:36px; border-radius:9px; border:1px solid rgba(34,211,238,.45); color:#67e8f9; background:rgba(34,211,238,.08); display:grid; place-items:center; cursor:pointer; transition:border-color .15s, background .15s; }
        .clk-send-btn:not(:disabled):hover { background:rgba(34,211,238,.14); border-color:rgba(94,234,212,.6); }
        .clk-send-btn:disabled { opacity:.35; cursor:not-allowed; }
        .clk-upgrade-note { margin:0 18px 12px; padding:11px 14px; border:1px solid rgba(139,92,246,.28); border-radius:12px; background:rgba(139,92,246,.08); color:#c4b5fd; display:flex; justify-content:space-between; gap:12px; font-size:13px; }
        .clk-upgrade-link { color:#e9d5ff; text-decoration:none; font-weight:800; }
        .clk-usage { display:flex; align-items:center; gap:10px; padding:0 18px 14px; }
        .clk-usage-label, .clk-usage-count { font:700 10px var(--font-plex-mono, monospace); color:#61708a; white-space:nowrap; }
        .clk-usage-track { flex:1; height:3px; border-radius:999px; background:rgba(148,163,184,.11); overflow:hidden; }
        .clk-usage-fill { height:100%; border-radius:999px; transition:width .5s; }
        .clk-intel { margin-top:16px; }
        .clk-intel-head { margin:0 0 10px; }
        .clk-intel-title { margin:0; color:#f1f5f9; font-size:15px; font-weight:850; letter-spacing:-.01em; }
        .clk-intel-desc { margin:3px 0 0; color:#8391a7; font-size:12px; }
        .clk-intel-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
        .clk-intel-card { position:relative; min-height:0; height:100%; display:flex; flex-direction:column; border:1px solid rgba(148,163,184,.14); border-radius:12px; background:linear-gradient(145deg, rgba(12,20,36,.82), rgba(5,10,22,.9)); padding:12px 13px; box-shadow: inset 0 1px 0 rgba(255,255,255,.045); overflow:hidden; }
        .clk-intel-card:not(.clk-intel-card--empty) { border-color: color-mix(in srgb, var(--accent) 38%, rgba(148,163,184,.2)); }
        .clk-intel-icon { display:inline-flex; width:22px; height:22px; border-radius:7px; align-items:center; justify-content:center; margin-bottom:8px; font-size:12px; color: var(--accent, #94a3b8); border:1px solid color-mix(in srgb, var(--accent, #475569) 45%, transparent); background: color-mix(in srgb, var(--accent, #475569) 10%, transparent); flex:0 0 auto; }
        .clk-intel-card--empty .clk-intel-icon { color:#7c8aa1; border-color:rgba(148,163,184,.22); background:rgba(148,163,184,.06); }
        .clk-intel-label { color:#e7edf6; font-weight:700; font-size:12.5px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-intel-card--empty .clk-intel-label { color:#9aa8bb; }
        .clk-intel-sub { color:#94a3b8; font-size:11.5px; line-height:1.4; margin:4px 0 0; white-space:normal; word-break:break-word; }
        .clk-intel-cta { position:relative; left:auto; right:auto; bottom:auto; margin-top:8px; padding-top:8px; border-top:1px solid rgba(148,163,184,.1); color:#67e8f9; font:800 9px var(--font-plex-mono, monospace); letter-spacing:.09em; text-transform:uppercase; opacity:.7; }
        .clk-intel-empty-row { border:1px dashed rgba(148,163,184,.18); border-radius:12px; background:rgba(148,163,184,.03); padding:14px 16px; color:#8391a7; font-size:12.5px; line-height:1.5; }
        .clk-side { display:flex; flex-direction:column; gap:14px; }
        .clk-side-card { border:1px solid rgba(148,163,184,.1); border-radius:13px; background:rgba(7,13,25,.6); padding:14px; }
        .clk-side-title { display:flex; align-items:center; gap:9px; margin:0 0 11px; padding-bottom:9px; border-bottom:1px solid rgba(148,163,184,.08); color:#dbe4f0; font-size:12px; font-weight:800; letter-spacing:.02em; text-transform:uppercase; }
        .clk-side-title svg { width:15px; height:15px; color:#22d3ee; }
        .clk-context-row { padding:0 0 8px; margin-bottom:8px; border-bottom:0; }
        .clk-context-row:last-child { margin-bottom:0; padding-bottom:0; }
        .clk-context-label { color:#7f8ea3; font:700 9.5px var(--font-plex-mono, monospace); letter-spacing:.08em; text-transform:uppercase; margin-bottom:4px; }
        .clk-context-value { color:#e5edf8; font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-context-sub { color:#6d7c94; font-size:10.5px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .clk-empty { margin:0; color:#7c8aa1; font-size:12px; line-height:1.5; padding:10px; border:1px dashed rgba(148,163,184,.16); border-radius:10px; background:rgba(148,163,184,.03); }
        .clk-memory-row { display:flex; align-items:center; gap:10px; padding-top:11px; margin-top:2px; border-top:1px solid rgba(148,163,184,.09); }
        .clk-memory-stat { display:flex; align-items:baseline; gap:5px; color:#6d7c94; font:700 10px var(--font-plex-mono, monospace); letter-spacing:.02em; }
        .clk-memory-stat strong { color:#5eead4; font-size:12px; }
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
        @media (max-width: 780px) { .clk-shell { padding:20px 14px 44px; } .clk-actions-row { grid-template-columns:1fr 1fr; } .clk-side { display:flex; } .clk-thread { min-height:0; padding:16px 14px 12px; } .clk-input-row { grid-template-columns:36px minmax(0,1fr) 44px; } .clk-helper { display:none; } .clk-intel-grid { grid-template-columns:1fr 1fr; } .clk-live-cortex { display:none; } }
        @media (max-width: 480px) { .clk-actions-row { grid-template-columns:1fr; } .clk-title { font-size:34px; } .clk-ready-pill { padding:5px 10px; } .clk-intel-grid { grid-template-columns:1fr; } .clk-status-item-label { display:none; } }
      `}</style>

      <div aria-hidden='true'>
        <div className='clk-grid' />
        <div className='clk-glow' />
      </div>

      <div className='clk-shell'>
        <main className='clk-main'>
          <section className='clk-hero'>
            <div className='clk-title-row'>
              <h1 className='clk-title'>Clark <span className='clk-title-ai'>AI</span></h1>
              <span className='clk-ready-pill'>CORTEX READY</span>
            </div>
            <p className='clk-subtitle'>Base-native AI analyst for tokens, wallets, liquidity, and onchain risk.</p>
            <div className='clk-status-strip' aria-label='CORTEX status'>
              <span className='clk-status-item'>
                <span className='clk-status-item-dot' style={{ background: '#10b981', boxShadow: '0 0 6px rgba(16,185,129,.7)' }} />
                <span className='clk-status-item-value clk-status-item-value--live'>LIVE</span>
              </span>
              {([
                ['Memory', messages.length > 0 ? 'Active' : 'Ready', messages.length > 0],
                ['Token', clientContext.lastToken ? 'Ready' : 'Standby', Boolean(clientContext.lastToken)],
                ['Wallet', clientContext.lastWallet ? 'Ready' : 'Standby', Boolean(clientContext.lastWallet)],
                ['Mode', activeMode === 'radar' ? 'Radar' : 'Adaptive', true],
                ['System', loading ? 'Working' : 'Online', true],
              ] as Array<[string, string, boolean]>).map(([label, value, isActive]) => (
                <span className='clk-status-item' key={label}>
                  <span className='clk-status-item-label'>{label}</span>
                  <span className={`clk-status-item-value${isActive ? '' : ' clk-status-item-value--muted'}`}>{value}</span>
                </span>
              ))}
              <span className='clk-live-cortex'>CORTEX ENGINE</span>
            </div>
          </section>

          <section className='clk-actions-row' aria-label='Clark quick actions'>
            {quickActions.map((action) => (
              <button
                key={action.title}
                className='clk-quick-card'
                style={{ '--accent': action.accent } as CSSProperties}
                onClick={() => { void handleSendText(action.prompt) }}
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
              {!hasMessages ? (
                <div className='clk-intro clk-intro--empty'>
                  <ClarkOrb size={44} thinking={loading} />
                  <div className='clk-intro-body'>
                    <div className='clk-intro-title'>Clark is ready.</div>
                    <p className='clk-intro-text'>Base-native analyst online. Give Clark a token, wallet, or contract — or start from a command below.</p>
                    <div className='clk-start-with' aria-label='Start with a command'>
                      <span className='clk-start-with-label'>Start with</span>
                      <div className='clk-start-with-row'>
                        {startWithChips.map((chip) => (
                          <button
                            key={chip.label}
                            type='button'
                            className='clk-start-chip'
                            onClick={() => setInput(chip.prompt)}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
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
              )}
              {messages.map((msg, idx) => {
                const isThinking = msg.role === 'clark' && loading && msg.text === THINKING_MESSAGE
                return (
                  <div key={idx} className={`clk-msg clk-msg--${msg.role}`}>
                    <span className='clk-msg-role' data-intent={msg.role === 'user' ? msg.text.slice(0, 34) : (msg.intentBadge ?? (activeMode === 'wallet' ? 'WALLET PROFILE' : activeMode === 'token' ? 'TOKEN READ' : activeMode === 'contract' ? 'RISK READ' : 'INTELLIGENCE'))}>{msg.role === 'user' ? 'USER' : 'CLARK'}</span>
                    {isThinking ? (
                      <div className='clk-thinking'>
                        <ThinkingOrb state="composing" size={64} speed={2.80} />
                        <div className='clk-thinking-stage'>{loadingStages[loadingStage] ?? loadingStages[0]}</div>
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
                  <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'><path d='M22 2 11 13'/><path d='m22 2-7 20-4-9-9-4Z'/></svg>
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
            {recentTokens.length === 0 && !recentWalletValue ? (
              <div className='clk-intel-empty-row'>Your latest token, wallet, and LP reads will appear here.</div>
            ) : (
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
            )}
          </section>
        </main>

        <aside className='clk-side'>
          <section className='clk-side-card'>
            <h2 className='clk-side-title'><svg width='19' height='19' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><circle cx='12' cy='12' r='2'/><path d='M16.24 7.76 14 10'/><path d='M8 16l2-2'/><path d='M14 14l2.24 2.24'/><path d='M7.76 7.76 10 10'/><circle cx='18' cy='6' r='2'/><circle cx='6' cy='18' r='2'/><circle cx='18' cy='18' r='2'/><circle cx='6' cy='6' r='2'/></svg>Context</h2>
            <div className='clk-context-row'><div className='clk-context-label'>Current Chain</div><div className='clk-context-value'>Base</div><div className='clk-context-sub'>Chain ID: 8453</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Last Token</div><div className='clk-context-value'>{formatContextValue(clientContext.lastToken)}</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Last Wallet</div><div className='clk-context-value'>{formatContextValue(clientContext.lastWallet)}</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Active Mode</div><div className='clk-context-value'>Adaptive Analysis</div><div className='clk-context-sub'>Analysis adapts based on context & onchain data</div></div>
            {/* DESIGN FIX, DISCLOSED (Clark AI polish): Memory was previously its own third
                side-card — task asks for max 2 primary sections (Context, Chat History). Same
                real memoryStats data, folded into Context as a compact stat row instead of a
                separate card. */}
            <div className='clk-memory-row'>
              {memoryStats.map((stat) => (
                <span className='clk-memory-stat' key={stat.label}><strong>{stat.value}</strong>{stat.label}</span>
              ))}
            </div>
          </section>

          <section className='clk-side-card'>
            <h2 className='clk-side-title'><svg width='19' height='19' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M3 12a9 9 0 1 0 3-6.7'/><path d='M3 3v6h6'/><path d='M12 7v5l3 2'/></svg>Chat History</h2>
            <ClarkHistoryPanel
              folders={folders}
              chats={chats}
              activeChatId={activeChatId}
              historySaveFailed={historySaveFailed}
              historyStatusMessage={historyErrorCode ? HISTORY_STATUS_MESSAGE[historyErrorCode] : null}
              onNewChat={handleNewChat}
              onSelectChat={(id) => { void loadChat(id) }}
              onSearch={(q) => { void refreshHistory(q || undefined) }}
              onCreateFolder={(name) => { createClarkFolder(name).then(() => refreshHistory()).catch(reportHistoryFailure) }}
              onRenameChat={(id, title) => { renameClarkChat(id, title).then(() => refreshHistory()).catch(reportHistoryFailure) }}
              onMoveChat={(id, folderId) => { moveClarkChatToFolder(id, folderId).then(() => refreshHistory()).catch(reportHistoryFailure) }}
              onDeleteChat={(id) => {
                deleteClarkChat(id).then(() => { if (id === activeChatId) handleNewChat(); return refreshHistory() }).catch(reportHistoryFailure)
              }}
              onDeleteFolder={(id) => { deleteClarkFolder(id).then(() => refreshHistory()).catch(reportHistoryFailure) }}
            />
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
