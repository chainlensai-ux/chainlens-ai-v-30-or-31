'use client'

import { useEffect, useRef, useState } from 'react'

type Message = { role: 'user' | 'clark'; text: string; pending?: boolean }
type ClarkOpenDetail = { prompt?: string; autoSend?: boolean; source?: string }

const INITIAL_ASSISTANT_MESSAGE = 'Ask me about Base tokens, wallets, whale alerts, or risk signals.'
const FALLBACK_ERROR_MESSAGE = 'Clark is unavailable right now. Try again in a moment.'

export default function MobileClarkDrawer() {
  const [isOpen, setIsOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([{ role: 'clark', text: INITIAL_ASSISTANT_MESSAGE }])
  const endRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)

  const sendText = async (raw: string) => {
    const text = raw.trim()
    if (!text || loadingRef.current) return

    setInput('')
    setLoading(true)
    loadingRef.current = true
    setMessages((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'clark', text: 'Clark is thinking...', pending: true },
    ])

    try {
      const res = await fetch('/api/clark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: 'clark-ai', prompt: text }),
      })
      const json = await res.json().catch(() => ({}))
      const reply = typeof json?.reply === 'string' && json.reply.trim() ? json.reply : FALLBACK_ERROR_MESSAGE
      setMessages((prev) => [...prev.slice(0, -1), { role: 'clark', text: reply }])
    } catch {
      setMessages((prev) => [...prev.slice(0, -1), { role: 'clark', text: FALLBACK_ERROR_MESSAGE }])
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }

  useEffect(() => {
    const onOpenEvent = (event: Event) => {
      const detail = (event as CustomEvent<ClarkOpenDetail>).detail ?? {}
      setIsOpen(true)
      if (typeof detail.prompt === 'string') setInput(detail.prompt)
      if (detail.autoSend && detail.prompt?.trim()) {
        void sendText(detail.prompt)
      }
    }

    window.addEventListener('chainlens:open-clark', onOpenEvent)
    return () => window.removeEventListener('chainlens:open-clark', onOpenEvent)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, isOpen])

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          className="fixed bottom-5 right-5 z-[10000] rounded-full bg-gradient-to-r from-[#8b5cf6] via-[#ec4899] to-[#2DD4BF] px-5 py-3 text-sm font-semibold text-white shadow-2xl md:hidden"
          onClick={() => setIsOpen(true)}
          aria-label="Open Clark"
        >
          Clark
        </button>
      )}

      <div data-open={isOpen ? 'true' : 'false'} className={`mobile-clark-drawer fixed inset-0 z-[10001] md:hidden ${isOpen ? 'flex' : 'hidden'}`}>
        <section
          className="fixed inset-x-0 bottom-0 z-[10001] flex min-h-[60dvh] max-h-[85dvh] flex-col rounded-t-2xl border-t border-white/10 bg-[#050814] text-white"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <p className="font-semibold text-white">Clark AI</p>
              <p className="text-xs text-slate-400">CORTEX onchain assistant</p>
            </div>
            <button type="button" className="text-slate-300" onClick={() => setIsOpen(false)}>
              Close
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-cyan-500/20 text-cyan-100' : 'bg-slate-900 text-slate-200'}`}
              >
                {m.text}
              </div>
            ))}
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
            <button
              type="button"
              disabled={loading}
              onClick={() => void sendText(input)}
              className="self-end rounded-xl border border-white/10 bg-cyan-500/20 px-3 py-2 text-sm text-white disabled:opacity-60"
            >
              Send
            </button>
          </div>
        </section>
      </div>
    </>
  )
}
