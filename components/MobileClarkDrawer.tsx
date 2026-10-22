'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { ThinkingOrb } from 'thinking-orbs'
import { getClarkSessionId as getOrCreateSessionId, readClarkClientContext as getClientClarkContext, persistClarkMemoryEcho, persistClarkMomentumList } from '@/lib/client/clarkMemory'
import { clarkFetchSignal, clientTimeoutReply, createClarkRequestGate } from '@/lib/client/clarkRequestLifecycle'
import { CLARK_FETCH_TIMEOUT_MS } from '@/lib/client/clarkAiLive'

type Message = { role: 'user' | 'clark'; text: string; pending?: boolean; requestId?: string }

type AnalysisKind = 'token' | 'wallet' | 'lp' | 'general'
const ANALYSIS_STAGES: Record<AnalysisKind, string[]> = {
  token: ['Analyzing token...', 'Checking liquidity...', 'Reviewing holder distribution...', 'Inspecting security signals...', 'Building CORTEX summary...'],
  wallet: ['Loading portfolio...', 'Reviewing activity...', 'Checking chain exposure...', 'Building wallet profile...', 'Preparing intelligence report...'],
  lp: ['Reviewing liquidity...', 'Checking LP control...', 'Analyzing concentrated positions...', 'Preparing LP report...'],
  general: ['Parsing request...', 'Loading CORTEX context...', 'Reviewing Base signals...', 'Preparing intelligence report...'],
}
function inferAnalysisKind(text: string): AnalysisKind {
  const t = text.toLowerCase()
  if (/\b(wallet|portfolio|holdings?|pnl|whale)\b/.test(t)) return 'wallet'
  if (/\b(lp|liquidity|pool|lock|unlock|concentrated)\b/.test(t)) return 'lp'
  if (/\b(token|contract|ca\b|holders?|deployer|rug|safe|scan)\b/.test(t)) return 'token'
  return 'general'
}
function ClarkLoadingTrace({ kind }: { kind: AnalysisKind }) {
  const stages = ANALYSIS_STAGES[kind]
  const [stage, setStage] = useState(0)
  useEffect(() => {
    setStage(0)
    const id = window.setInterval(() => setStage((current) => Math.min(current + 1, stages.length - 1)), 1200)
    return () => window.clearInterval(id)
  }, [kind, stages.length])
  return (
    <div className="clark-loading-trace">
      <ThinkingOrb state="composing" size={64} speed={2.80} />
      <div className="clark-loading-stage">{stages[stage] ?? stages[0]}</div>
    </div>
  )
}

type ClarkOpenDetail = { prompt?: string; autoSend?: boolean; source?: string }

const INITIAL_ASSISTANT_MESSAGE = 'Ask me about Base tokens, wallets, whale alerts, or risk signals.'
const FALLBACK_ERROR_MESSAGE = 'Clark is unavailable right now. Try again in a moment.'

export default function MobileClarkDrawer() {
  const pathname = usePathname()
  const [expanded, setExpanded] = useState(false)
  const [showDock, setShowDock] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingKind, setLoadingKind] = useState<AnalysisKind>('general')
  const [lastAction, setLastAction] = useState('mounted')
  const [messages, setMessages] = useState<Message[]>([{ role: 'clark', text: INITIAL_ASSISTANT_MESSAGE }])
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)
  const requestGateRef = useRef(createClarkRequestGate())

  const debugClark = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debugClark') === 'true'

  useEffect(() => {
    const detect = () => {
      const touchCapable = navigator.maxTouchPoints > 0 || 'ontouchstart' in window
      const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
      const mobileishWidth = window.innerWidth <= 1023
      const shouldShow = Boolean(debugClark || ((touchCapable || mobileUA || mobileishWidth) && window.innerWidth <= 1023))
      setShowDock(shouldShow)
    }

    detect()
    window.addEventListener('resize', detect)
    return () => window.removeEventListener('resize', detect)
  }, [debugClark])

  const sendText = async (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const begun = requestGateRef.current.begin(text)
    if (!begun.proceed) return
    const requestId = begun.requestId

    setError('')
    setInput('')
    setLoadingKind(inferAnalysisKind(text))
    setLoading(true)
    loadingRef.current = true
    setLastAction('send')
    setMessages((prev) => {
      const withoutStaleThinking = prev.filter((m) => !(m.role === 'clark' && m.text === 'Clark is thinking...' && m.requestId && m.requestId !== requestId))
      return [...withoutStaleThinking, { role: 'user', text, requestId }, { role: 'clark', text: 'Clark is thinking...', requestId }]
    })

    try {
      const history = messages
        .slice(-10)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-clark-session': getOrCreateSessionId() },
        signal: clarkFetchSignal(begun.abortSignal, CLARK_FETCH_TIMEOUT_MS),
        body: JSON.stringify({ feature: 'clark-ai', prompt: text, message: text, requestId, messageId: requestId, sessionId: getOrCreateSessionId(), clientContext: getClientClarkContext() }),
      })
      const json = await res.json().catch(() => ({}))
      const payload = (json?.data && typeof json.data === 'object') ? json.data : json
      const echoedId = payload && typeof payload === 'object' && typeof (payload as { requestId?: unknown }).requestId === 'string'
        ? (payload as { requestId: string }).requestId
        : requestId
      if (echoedId !== requestId || !requestGateRef.current.shouldApply(requestId)) return
      const marketItems = payload?.marketContext && typeof payload.marketContext === 'object' && Array.isArray((payload.marketContext as { items?: unknown[] }).items)
        ? (payload.marketContext as { items?: unknown[] }).items
        : null
      if (marketItems && marketItems.length > 0) {
        persistClarkMomentumList(marketItems)
      }
      // Cross-surface sync: persist this response's wallet/token memory through the same shared
      // helper every Clark surface uses.
      persistClarkMemoryEcho(payload)
      const reply = typeof payload?.reply === 'string' && payload.reply.trim()
        ? payload.reply
        : (typeof payload?.analysis === 'string' && payload.analysis.trim() ? payload.analysis : FALLBACK_ERROR_MESSAGE)
      setMessages((prev) => {
        const next = [...prev]
        const idx = next.findLastIndex((m) => m.role === 'clark' && m.requestId === requestId)
        if (idx < 0) return prev
        next[idx] = { role: 'clark', text: reply, requestId }
        return next
      })
      setLastAction('send-success')
    } catch {
      if (!requestGateRef.current.shouldApply(requestId)) return
      const fallback = clientTimeoutReply(text)
      setError(fallback.text)
      setMessages((prev) => {
        const next = [...prev]
        const idx = next.findLastIndex((m) => m.role === 'clark' && m.requestId === requestId)
        if (idx < 0) return prev
        next[idx] = { role: 'clark', text: fallback.text, requestId }
        return next
      })
      setLastAction('send-fail')
    } finally {
      if (requestGateRef.current.complete(requestId)) {
        setLoading(false)
        loadingRef.current = false
      }
    }
  }

  useEffect(() => {
    const onOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<ClarkOpenDetail>).detail ?? {}
      setExpanded(true)
      setLastAction(`event-${detail.source ?? 'unknown'}`)
      if (typeof detail.prompt === 'string') {
        setInput(detail.prompt)
      }
      if (detail.autoSend && detail.prompt?.trim()) {
        void sendText(detail.prompt)
      }
    }

    window.addEventListener('chainlens:open-clark', onOpenEvent)
    return () => window.removeEventListener('chainlens:open-clark', onOpenEvent)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, expanded])

  if (!showDock) return null
  if (pathname === '/terminal/clark-ai' || pathname === '/auth' || pathname === '/sign-in' || pathname === '/sign-up' || pathname === '/reset-password' || pathname === '/login' || pathname === '/pricing') return null

  return (
    <>
      <style>{`
        .clark-loading-trace { display:flex; align-items:center; gap:10px; }
        .clark-loading-stage { color:#dbeafe; font:800 11px var(--font-plex-mono, monospace); letter-spacing:.04em; }
        .clark-loading-scan { position:relative; height:2px; margin-top:8px; overflow:hidden; background:rgba(148,163,184,.13); }
        .clark-loading-scan::before { content:''; position:absolute; inset:0 auto 0 0; width:45%; background:linear-gradient(90deg, transparent, rgba(45,212,191,.9), transparent); animation:clarkDrawerScan 1.15s linear infinite; }
        @keyframes clarkDrawerScan { from{ transform:translateX(-100%);} to{ transform:translateX(250%);} }
        .clark-drawer { position:fixed; z-index:99999; left:0; right:0; bottom:0; display:flex; color:#fff; }
        .clark-drawer-panel { display:flex; flex-direction:column; width:100%; min-height:60dvh; max-height:85dvh; padding-bottom:env(safe-area-inset-bottom); border:1px solid rgba(255,255,255,0.1); border-radius:16px 16px 0 0; background:#050814; box-shadow:0 -12px 40px rgba(0,0,0,0.6); box-sizing:border-box; font-family:var(--font-jakarta, 'Plus Jakarta Sans', sans-serif); }
        @media (min-width:1024px) { .clark-drawer { left:auto; right:16px; bottom:16px; width:430px; } .clark-drawer-panel { border-radius:16px; } }
        .clark-drawer-head { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.1); }
        .clark-drawer-head p { margin:0; }
        .clark-drawer-title { font-weight:600; font-size:15px; color:#fff; }
        .clark-drawer-sub { font-size:12px; color:#94a3b8; }
        .clark-drawer-min { background:none; border:0; color:#cbd5e1; font-size:14px; cursor:pointer; padding:6px 4px; }
        .clark-drawer-messages { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding:12px 16px; }
        .clark-msg { max-width:86%; border-radius:8px; border:1px solid; padding:8px 12px; font-size:14px; }
        .clark-msg--user { margin-left:auto; border-color:rgba(103,232,249,0.2); background:rgba(8,51,68,0.3); color:#ecfeff; }
        .clark-msg--clark { margin-right:auto; border-color:rgba(71,85,105,0.3); background:rgba(2,6,23,0.8); color:#e2e8f0; }
        .clark-msg-role { margin-bottom:4px; font:800 10px/1.2 var(--font-plex-mono, monospace); letter-spacing:.16em; text-transform:uppercase; }
        .clark-msg--user .clark-msg-role { color:#a5f3fc; }
        .clark-msg--clark .clark-msg-role { color:#a7f3d0; }
        .clark-msg-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.6; }
        .clark-drawer-error { margin:0; font-size:14px; color:#fda4af; }
        .clark-drawer-compose { position:sticky; bottom:0; display:flex; gap:8px; padding:12px; border-top:1px solid rgba(255,255,255,0.1); background:#050814; }
        .clark-drawer-input { flex:1; min-height:44px; max-height:96px; resize:none; padding:8px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:#020617; color:#fff; font-size:14px; line-height:1.4; font-family:inherit; outline:none; box-sizing:border-box; }
        .clark-drawer-send { align-self:flex-end; min-height:44px; min-width:44px; padding:8px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); background:rgba(6,182,212,0.2); color:#fff; font-size:14px; cursor:pointer; }
        .clark-drawer-send:disabled { opacity:.6; }
      `}</style>

      {debugClark && (
        <div className="fixed left-3 top-20 z-[99999] rounded bg-black/90 px-2 py-1 text-[10px] text-emerald-300">
          MobileClark mounted · mode: {expanded ? 'expanded' : 'compact'} · action: {lastAction}
        </div>
      )}

      {expanded && (
        <div className="clark-drawer">
          <section className="clark-drawer-panel">
            <div className="clark-drawer-head">
              <div>
                <p className="clark-drawer-title">Clark AI</p>
                <p className="clark-drawer-sub">CORTEX assistant</p>
              </div>
              <button type="button" className="clark-drawer-min" onClick={() => { setExpanded(false); setLastAction('minimize') }}>Minimize</button>
            </div>

            <div className="clark-drawer-messages">
              {messages.map((m, i) => {
                const isThinking = m.role === 'clark' && loading && m.text === 'Clark is thinking...'
                return (
                  <div key={i} className={`clark-msg ${m.role === 'user' ? 'clark-msg--user' : 'clark-msg--clark'}`}>
                    <div className="clark-msg-role">{m.role === 'user' ? 'USER' : 'CLARK'}</div>
                    {isThinking ? <ClarkLoadingTrace kind={loadingKind} /> : <div className="clark-msg-text">{m.text}</div>}
                  </div>
                )
              })}
              {error && <p className="clark-drawer-error">{error}</p>}
              <div ref={endRef} />
            </div>

            <div className="clark-drawer-compose">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Clark anything…"
                rows={2}
                className="clark-drawer-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendText(input)
                  }
                }}
              />
              <button type="button" disabled={loading} onClick={() => void sendText(input)} className="clark-drawer-send">Send</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
