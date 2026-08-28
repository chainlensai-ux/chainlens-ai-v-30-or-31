'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ThinkingOrb } from 'thinking-orbs'
import { supabase } from '@/lib/supabaseClient'
import { getClarkSessionId as getOrCreateSessionId, readClarkClientContext as getClientClarkContext, persistClarkMemoryEcho, persistClarkMomentumList, persistMarketMomentum, readMarketMomentum } from '@/lib/client/clarkMemory'
import {
  CLARK_FETCH_TIMEOUT_MS,
  CLARK_TIMEOUT_MESSAGE,
  FALLBACK_ERROR_MESSAGE,
  formatChainDisplay,
  formatLastTokenDisplay,
  formatLastWalletDisplay,
  formatMintAddressFromLastToken,
  intentBadgeForPrompt,
  isClarkTimeoutError,
  isMintAddressFollowup,
  isWalletLanguagePrompt,
  resolveClarkContextChain,
  uiModeHintForPrompt,
} from '@/lib/client/clarkAiLive'
import { CLARK_AI_PAGE_CSS } from './clarkAiPageCss'
import {
  ANALYSIS_STAGES,
  ANALYST_CHIPS,
  CHAT_CHIPS,
  inferAnalysisKind,
  MODES,
  QUICK_ACTIONS,
  START_WITH_CHIPS,
  bumpClarkUsage,
  decodePrompt,
  CLARK_DAILY_LIMITS,
  CLARK_LIMIT_UNAUTH,
  readClarkUsage,
  type AnalysisKind,
  type Mode,
} from './clarkAiPageConfig'
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

type ClarkAction = { label: string; href?: string; prompt?: string; kind?: 'link' | 'prompt'; requiresInput?: boolean }
type Message = { role: 'user' | 'clark'; text: string; intentBadge?: string | null; actions?: ClarkAction[] }
type UiTab   = 'analyst' | 'chat'

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

const THINKING_MESSAGE       = 'Clark is thinking...'

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

  const [folders, setFolders] = useState<ClarkChatFolder[]>([])
  const [chats, setChats] = useState<ClarkChatSummary[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const [historyErrorCode, setHistoryErrorCode] = useState<ClarkHistoryErrorCode | null>(null)
  const activeChatIdRef = useRef<string | null>(null)
  activeChatIdRef.current = activeChatId
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
    const sentForToken = chatSessionTokenRef.current
    const sendMode = uiModeHintForPrompt(text, activeMode)
    if (sendMode === 'wallet') setActiveMode('wallet')
    setLoadingKind(inferAnalysisKind(text, sendMode))
    setLoadingStage(0)
    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'clark', text: THINKING_MESSAGE }])
    setInput('')
    setLoading(true)
    const chatIdPromise = ensureActiveChat(text)
    try {
      const history = [...messages, { role: 'user', text }]
        .slice(-10)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
      const { data: { session: authSession } } = await supabase.auth.getSession()
      const accessToken = authSession?.access_token ?? null
      const clientClarkContext = getClientClarkContext()
      if (isMintAddressFollowup(text)) {
        const mintReply = formatMintAddressFromLastToken(clientClarkContext.lastToken)
        if (mintReply) {
          if (chatSessionTokenRef.current === sentForToken) {
            setMessages((prev) => {
              const next = [...prev]
              next[next.length - 1] = { role: 'clark', text: mintReply, intentBadge: 'TOKEN READ' }
              return next
            })
          }
          void chatIdPromise.then(async (chatId) => {
            if (!chatId) return
            await appendClarkMessage(chatId, 'user', text).catch(reportHistoryFailure)
            await appendClarkMessage(chatId, 'assistant', mintReply).catch(reportHistoryFailure)
            void refreshHistory()
          })
          return
        }
      }
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
      const resolvedChain = resolveClarkContextChain(clientClarkContext, text)
      const appContext = {
        route: pathname,
        ...(resolvedChain ? { chain: resolvedChain } : {}),
        activeFeature: sendMode ?? 'clark-ai',
        selectedToken: clarkContextRef.current.lastMarketList?.[0]?.tokenAddress ?? clientClarkContext.lastToken ?? null,
        selectedWallet: clientClarkContext.lastWallet ?? null,
        currentWalletAddress: (walletSummary?.address as string | undefined) ?? clientClarkContext.lastWallet ?? null,
        currentTokenAddress: (tokenSummary?.address as string | undefined) ?? clientClarkContext.lastToken ?? null,
        walletSummary,
        tokenSummary,
        marketContext: latestMarketContext,
        baseRadarSummary: clarkContextRef.current.lastMarketList ?? clientClarkContext.lastMomentumList ?? null,
        whaleSyncStatus: typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('chainlens:whale-alerts:sync-status') ?? 'unknown' : 'unknown',
        currentTool: sendMode ?? null,
      }
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clark-session': getOrCreateSessionId(),
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
        },
        signal: AbortSignal.timeout(CLARK_FETCH_TIMEOUT_MS),
        body: JSON.stringify({
          feature: 'clark-ai', message: text, prompt: text,
          mode: 'analyst', uiModeHint: sendMode,
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
      void chatIdPromise.then(async (chatId) => {
        if (!chatId) return
        await appendClarkMessage(chatId, 'user', text).catch(reportHistoryFailure)
        await appendClarkMessage(chatId, 'assistant', String(reply), payload).catch(reportHistoryFailure)
        void refreshHistory()
      })
    } catch (err) {
      const timedOut = isClarkTimeoutError(err)
      const errorText = timedOut ? CLARK_TIMEOUT_MESSAGE : FALLBACK_ERROR_MESSAGE
      const errorBadge = intentBadgeForPrompt(text)
      if (chatSessionTokenRef.current === sentForToken) {
        setMessages((prev) => { const next = [...prev]; next[next.length - 1] = { role: 'clark', text: errorText, intentBadge: errorBadge }; return next })
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

  const isLimited   = planLimit !== null && clarkUsed >= planLimit
  const usagePct    = planLimit ? Math.min(100, (clarkUsed / planLimit) * 100) : 0
  const chips       = uiTab === 'analyst' ? ANALYST_CHIPS : CHAT_CHIPS
  const hasMessages = messages.length > 0
  const clientContext = getClientClarkContext() as { lastToken?: unknown; lastWallet?: unknown; lastChain?: unknown }
  const formatContextValue = (value: unknown) => formatLastWalletDisplay(value)
  const contextChain = formatChainDisplay(resolveClarkContextChain(clientContext))
  const lastTokenDisplay = formatLastTokenDisplay(clientContext.lastToken)
  const startWithChips = START_WITH_CHIPS
  const recentTokens = (clarkContextRef.current.lastMarketList ?? []).slice(0, 3)
  const recentWalletValue = clientContext.lastWallet ? formatContextValue(clientContext.lastWallet) : null
  const quickActions = QUICK_ACTIONS
  void activeModeConfig; void applyMode; void handleImportFromRadar; void handlePasteContract; void handlePasteWallet; void chips

  return (
    <div className='clk-page'>
      <style>{CLARK_AI_PAGE_CSS}</style>

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
            <p className='clk-subtitle'>Base-native onchain analyst for tokens, wallets, liquidity, and risk.</p>
            <div className='clk-status-row' aria-label='Clark status'>
              <span className='clk-status-chip'><span className='clk-status-dot' style={{ background: '#22d3ee' }} />Base</span>
              <span className='clk-status-chip'><span className='clk-status-dot' style={{ background: (messages.length > 0 || clientContext.lastToken || clientContext.lastWallet) ? '#34d399' : '#475569' }} />Memory {(messages.length > 0 || clientContext.lastToken || clientContext.lastWallet) ? 'On' : 'Idle'}</span>
              <span className='clk-status-chip'><span className='clk-status-dot' style={{ background: '#a78bfa' }} />{activeMode === 'radar' ? 'Radar Mode' : 'Adaptive Mode'}</span>
              <span className='clk-status-chip'><span className='clk-status-dot' style={{ background: loading ? '#f59e0b' : '#5eead4' }} />{loading ? 'CORTEX Working' : 'CORTEX Ready'}</span>
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
              {!hasMessages && (
                <div className='clk-intro--empty'>
                  <div>
                    <p className='clk-intro-title'>Clark is ready.</p>
                    <p className='clk-intro-text'>Ask for a token read, wallet read, LP check, or Base market summary.</p>
                  </div>
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
              )}
              {messages.map((msg, idx) => {
                const isThinking = msg.role === 'clark' && loading && msg.text === THINKING_MESSAGE
                return (
                  <div key={idx} className={`clk-msg clk-msg--${msg.role}`}>
                    <span className='clk-msg-role' data-intent={msg.role === 'user' ? msg.text.slice(0, 34) : (msg.intentBadge ?? (isWalletLanguagePrompt(msg.text) || activeMode === 'wallet' ? 'WALLET READ' : activeMode === 'token' ? 'TOKEN READ' : activeMode === 'contract' ? 'RISK READ' : 'INTELLIGENCE'))}>{msg.role === 'user' ? 'USER' : 'CLARK'}</span>
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

            {!hasMessages && (
              <div className='clk-command'>
                <span className='clk-command-label'>Ask Clark</span>
                <p className='clk-command-line'>Ask about a token, wallet, LP position, or Base market move.</p>
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
                  placeholder='Ask Clark about a token, wallet, contract, or market move…'
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
              <p className='clk-intel-desc'>Recent Clark reads will appear here after scans or chats.</p>
            </div>
            {recentTokens.length === 0 && !recentWalletValue ? (
              <div className='clk-intel-empty-row'>Recent Clark reads will appear here after scans or chats.</div>
            ) : (
              <div className='clk-intel-grid'>
                {recentTokens.length > 0 ? (
                  recentTokens.map((t, idx) => (
                    <div className='clk-intel-card' key={`${t.symbol}-${idx}`} style={{ '--accent': '#22d3ee' } as CSSProperties}>
                      <span className='clk-intel-icon'>◎</span>
                      <div className='clk-intel-label'>{t.symbol}</div>
                      <div className='clk-intel-sub'>{t.reasonTag ?? 'From recent Base read'}</div>
                    </div>
                  ))
                ) : (
                  <div className='clk-intel-card clk-intel-card--empty'>
                    <span className='clk-intel-icon'>◎</span>
                    <div className='clk-intel-label'>No token read yet</div>
                    <div className='clk-intel-sub'>Run a token scan to populate this module.</div>
                  </div>
                )}
                {recentWalletValue ? (
                  <div className='clk-intel-card' style={{ '--accent': '#8b5cf6' } as CSSProperties}>
                    <span className='clk-intel-icon'>▣</span>
                    <div className='clk-intel-label'>{recentWalletValue}</div>
                    <div className='clk-intel-sub'>Last wallet read</div>
                  </div>
                ) : (
                  <div className='clk-intel-card clk-intel-card--empty'>
                    <span className='clk-intel-icon'>▣</span>
                    <div className='clk-intel-label'>No wallet read yet</div>
                    <div className='clk-intel-sub'>Scan a wallet to build wallet memory.</div>
                  </div>
                )}
                <div className='clk-intel-card clk-intel-card--empty'>
                  <span className='clk-intel-icon'>⌘</span>
                  <div className='clk-intel-label'>No LP check yet</div>
                  <div className='clk-intel-sub'>Run an LP check to track liquidity proof.</div>
                </div>
              </div>
            )}
          </section>
        </main>

        <aside className='clk-side'>
          <section className='clk-side-card'>
            <h2 className='clk-side-title'><svg width='19' height='19' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><circle cx='12' cy='12' r='2'/><path d='M16.24 7.76 14 10'/><path d='M8 16l2-2'/><path d='M14 14l2.24 2.24'/><path d='M7.76 7.76 10 10'/><circle cx='18' cy='6' r='2'/><circle cx='6' cy='18' r='2'/><circle cx='18' cy='18' r='2'/><circle cx='6' cy='6' r='2'/></svg>Context</h2>
            <div className='clk-context-row'><div className='clk-context-label'>Current Chain</div><div className='clk-context-value'>{contextChain.label}</div>{contextChain.id ? <div className='clk-context-sub'>Chain ID: {contextChain.id}</div> : <div className='clk-context-sub'>Follows last scanned chain</div>}</div>
            <div className='clk-context-row'><div className='clk-context-label'>Last Token</div><div className='clk-context-value'>{lastTokenDisplay}</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Last Wallet</div><div className='clk-context-value'>{formatLastWalletDisplay(clientContext.lastWallet)}</div></div>
            <div className='clk-context-row'><div className='clk-context-label'>Active Mode</div><div className='clk-context-value'>{activeMode === 'radar' ? 'Radar Mode' : 'Adaptive'}</div><div className='clk-context-sub'>Analysis adapts based on context & onchain data</div></div>
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
