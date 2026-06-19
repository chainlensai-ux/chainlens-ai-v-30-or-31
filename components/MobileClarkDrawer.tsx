'use client'

import { useEffect, useRef, useState } from 'react'
import { getClarkSessionId as getOrCreateSessionId, readClarkClientContext as getClientClarkContext, persistClarkMemoryEcho, persistClarkMomentumList } from '@/lib/client/clarkMemory'

type Message = { role: 'user' | 'clark'; text: string; pending?: boolean }

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
  return <div className="clark-loading-trace"><div className="clark-loading-stage">{stages[stage] ?? stages[0]}</div><div className="clark-loading-scan" /></div>
}

type ClarkOpenDetail = { prompt?: string; autoSend?: boolean; source?: string }

const INITIAL_ASSISTANT_MESSAGE = 'Ask me about Base tokens, wallets, whale alerts, or risk signals.'
const FALLBACK_ERROR_MESSAGE = 'Clark is unavailable right now. Try again in a moment.'

export default function MobileClarkDrawer() {
  const [expanded, setExpanded] = useState(false)
  const [showDock, setShowDock] = useState(false)
  const [miniInput, setMiniInput] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingKind, setLoadingKind] = useState<AnalysisKind>('general')
  const [lastAction, setLastAction] = useState('mounted')
  const [messages, setMessages] = useState<Message[]>([{ role: 'clark', text: INITIAL_ASSISTANT_MESSAGE }])
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)

  const debugClark = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debugClark') === 'true'

  useEffect(() => {
    const detect = () => {
      const touchCapable = navigator.maxTouchPoints > 0 || 'ontouchstart' in window
      const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
      const mobileishWidth = window.innerWidth <= 1200
      const shouldShow = Boolean(debugClark || touchCapable || mobileUA || mobileishWidth)
      setShowDock(shouldShow)
    }

    detect()
    window.addEventListener('resize', detect)
    return () => window.removeEventListener('resize', detect)
  }, [debugClark])

  const sendText = async (raw: string) => {
    const text = raw.trim()
    if (!text || loadingRef.current) return

    setError('')
    setInput('')
    setMiniInput('')
    setLoadingKind(inferAnalysisKind(text))
    setLoading(true)
    loadingRef.current = true
    setLastAction('send')
    setMessages((prev) => [...prev, { role: 'user', text }, { role: 'clark', text: 'Clark is thinking...' }])

    try {
      const history = messages
        .slice(-10)
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-clark-session': getOrCreateSessionId() },
        body: JSON.stringify({ feature: 'clark-ai', prompt: text, sessionId: getOrCreateSessionId(), clientContext: getClientClarkContext() }),
      })
      const json = await res.json().catch(() => ({}))
      const payload = (json?.data && typeof json.data === 'object') ? json.data : json
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
      setMessages((prev) => [...prev.slice(0, -1), { role: 'clark', text: reply }])
      setLastAction('send-success')
    } catch {
      setError(FALLBACK_ERROR_MESSAGE)
      setMessages((prev) => [...prev.slice(0, -1), { role: 'clark', text: FALLBACK_ERROR_MESSAGE }])
      setLastAction('send-fail')
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }

  const expandOnly = () => {
    setExpanded(true)
    setLastAction('expand')
  }

  const expandAndSend = (raw: string) => {
    const text = raw.trim()
    setExpanded(true)
    setLastAction(text ? 'expand-send' : 'expand')
    if (text) void sendText(text)
  }

  useEffect(() => {
    const onOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<ClarkOpenDetail>).detail ?? {}
      setExpanded(true)
      setLastAction(`event-${detail.source ?? 'unknown'}`)
      if (typeof detail.prompt === 'string') {
        setInput(detail.prompt)
        setMiniInput(detail.prompt)
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

  return (
    <>
      <style>{`
        .clark-loading-stage { color:#dbeafe; font:800 11px var(--font-plex-mono, monospace); letter-spacing:.04em; }
        .clark-loading-scan { position:relative; height:2px; margin-top:8px; overflow:hidden; background:rgba(148,163,184,.13); }
        .clark-loading-scan::before { content:''; position:absolute; inset:0 auto 0 0; width:45%; background:linear-gradient(90deg, transparent, rgba(45,212,191,.9), transparent); animation:clarkDrawerScan 1.15s linear infinite; }
        @keyframes clarkDrawerScan { from{ transform:translateX(-100%);} to{ transform:translateX(250%);} }
      `}</style>

      {debugClark && (
        <div className="fixed left-3 top-20 z-[99999] rounded bg-black/90 px-2 py-1 text-[10px] text-emerald-300">
          MobileClark mounted · mode: {expanded ? 'expanded' : 'compact'} · action: {lastAction}
        </div>
      )}

      {!expanded && (
        <div className="fixed bottom-4 right-4 z-[99999] flex h-12 w-[180px] items-center gap-2 rounded-2xl border border-white/10 bg-[#080c14] px-2 text-white shadow-2xl" style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.06), 0 12px 28px rgba(0,0,0,0.55), 0 0 24px rgba(139,92,246,0.28)' }}>
          <button type="button" className="shrink-0 rounded-lg bg-gradient-to-r from-[#2DD4BF] via-[#8b5cf6] to-[#ec4899] px-2 py-1 text-[10px] font-semibold" onClick={expandOnly}>Clark AI</button>
          <input
            value={miniInput}
            onChange={(e) => setMiniInput(e.target.value)}
            onFocus={expandOnly}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                expandAndSend(miniInput)
              }
            }}
            placeholder="Ask Clark..."
            className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-slate-400 outline-none"
          />
          <button type="button" aria-label="Open Clark" onClick={() => expandAndSend(miniInput)} className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs">↗</button>
        </div>
      )}

      {expanded && (
        <div className="fixed inset-x-0 bottom-0 z-[99999] flex text-white lg:inset-x-auto lg:right-4 lg:w-[430px]">
          <section className="flex min-h-[60dvh] max-h-[85dvh] w-full flex-col rounded-t-2xl border border-white/10 bg-[#050814] lg:rounded-2xl" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <p className="font-semibold text-white">Clark AI</p>
                <p className="text-xs text-slate-400">CORTEX assistant</p>
              </div>
              <button type="button" className="text-slate-300" onClick={() => { setExpanded(false); setLastAction('minimize') }}>Minimize</button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {messages.map((m, i) => {
                const isThinking = m.role === 'clark' && loading && m.text === 'Clark is thinking...'
                return (
                  <div key={i} className={`max-w-[86%] rounded-md border px-3 py-2 text-sm ${m.role === 'user' ? 'ml-auto border-cyan-300/20 bg-cyan-950/30 text-cyan-50' : 'mr-auto border-slate-600/30 bg-slate-950/80 text-slate-200'}`}>
                    <div className={`mb-1 font-mono text-[10px] font-extrabold uppercase tracking-[0.16em] ${m.role === 'user' ? 'text-cyan-200' : 'text-emerald-200'}`}>{m.role === 'user' ? 'USER' : 'CLARK'}</div>
                    {isThinking ? <ClarkLoadingTrace kind={loadingKind} /> : <div className="whitespace-pre-wrap break-words leading-relaxed">{m.text}</div>}
                  </div>
                )
              })}
              {error && <p className="text-sm text-rose-300">{error}</p>}
              <div ref={endRef} />
            </div>

            <div className="sticky bottom-0 flex gap-2 border-t border-white/10 bg-[#050814] p-3">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Clark anything…"
                rows={2}
                className="max-h-24 min-h-[44px] flex-1 resize-none rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendText(input)
                  }
                }}
              />
              <button type="button" disabled={loading} onClick={() => void sendText(input)} className="self-end rounded-xl border border-white/10 bg-cyan-500/20 px-3 py-2 text-sm text-white disabled:opacity-60">Send</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
