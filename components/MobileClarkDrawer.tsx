'use client'

import { useEffect, useRef, useState } from 'react'

type Message = { role: 'user' | 'clark'; text: string }

type ClarkOpenDetail = { prompt?: string; autoSend?: boolean; source?: string }

export default function MobileClarkDrawer() {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement | null>(null)

  const isMobile = () => typeof window !== 'undefined' && window.innerWidth < 768
  const debug = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debugClark') === 'true'
  const log = (event: string, meta?: Record<string, unknown>) => {
    if (!debug()) return
    console.info(event, meta ?? {})
  }

  const sendText = async (raw: string) => {
    const text = raw.trim()
    if (!text || loading) return
    setError('')
    setLoading(true)
    setMessages(prev => [...prev, { role: 'user', text }, { role: 'clark', text: 'Clark is thinking...' }])
    log('clark_send_start', { prompt: text.slice(0, 80) })
    try {
      const res = await fetch('/api/clark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature: 'clark-ai', prompt: text }) })
      const json = await res.json()
      const reply = typeof json?.reply === 'string' ? json.reply : 'Clark is unavailable right now. Try again in a moment.'
      setMessages(prev => [...prev.slice(0, -1), { role: 'clark', text: reply }])
      log('clark_send_success', { status: res.status })
    } catch {
      setError('Clark is unavailable right now. Try again in a moment.')
      setMessages(prev => [...prev.slice(0, -1), { role: 'clark', text: 'Clark is unavailable right now. Try again in a moment.' }])
      log('clark_send_error')
    } finally { setLoading(false) }
  }

  useEffect(() => {
    const openDrawer = (detail: ClarkOpenDetail = {}) => {
      if (!isMobile()) return
      setOpen(true)
      log('mobile_drawer_open', { source: detail.source ?? 'unknown' })
      if (detail.prompt) setInput(detail.prompt)
      if (detail.autoSend && detail.prompt) void sendText(detail.prompt)
    }

    const onOpenEvent = (event: Event) => openDrawer((event as CustomEvent<ClarkOpenDetail>).detail)

    const onFocus = (event: Event) => {
      const target = event.target as HTMLInputElement | HTMLTextAreaElement | null
      if (!target || !isMobile()) return
      const p = (target.placeholder || '').toLowerCase()
      if (p.includes('ask clark')) {
        log('clark_entry_focus')
        openDrawer({ prompt: target.value || '', source: 'focus' })
      }
    }

    const onSubmit = (event: Event) => {
      if (!isMobile()) return
      const form = event.target as HTMLFormElement | null
      if (!form) return
      const field = form.querySelector('input[placeholder*="Ask Clark" i], textarea[placeholder*="Ask Clark" i]') as HTMLInputElement | HTMLTextAreaElement | null
      if (!field) return
      event.preventDefault()
      log('clark_entry_submit', { prompt: (field.value || '').slice(0, 80) })
      openDrawer({ prompt: field.value || '', autoSend: true, source: 'submit' })
    }

    const onClick = (event: Event) => {
      if (!isMobile()) return
      const el = (event.target as HTMLElement | null)?.closest('button,a,[role="button"]') as HTMLElement | null
      if (!el) return
      const label = (el.textContent || '').toLowerCase()
      if (label.includes('ask clark') || label.includes('clark ai')) {
        openDrawer({ source: 'button' })
      }
    }

    window.addEventListener('chainlens:open-clark', onOpenEvent)
    window.addEventListener('focusin', onFocus)
    window.addEventListener('submit', onSubmit, true)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('chainlens:open-clark', onOpenEvent)
      window.removeEventListener('focusin', onFocus)
      window.removeEventListener('submit', onSubmit, true)
      window.removeEventListener('click', onClick)
    }
  }, [loading])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9999] md:hidden">
      <button className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} aria-label="Close Clark drawer" />
      <section className="absolute inset-x-0 bottom-0 min-h-[60dvh] max-h-[85dvh] rounded-t-2xl border-t border-white/10 bg-[#050814] shadow-2xl flex flex-col overflow-hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div><p className="text-white font-semibold">Clark AI</p><p className="text-xs text-slate-400">CORTEX onchain assistant</p></div>
          <button className="text-slate-300" onClick={() => setOpen(false)}>Close</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && <p className="text-slate-400 text-sm">Ask Clark anything.</p>}
          {messages.map((m, i) => <div key={i} className={`rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-cyan-500/20 text-cyan-100' : 'bg-slate-900 text-slate-200'}`}>{m.text}</div>)}
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          <div ref={endRef} />
        </div>
        <div className="sticky bottom-0 border-t border-white/10 bg-[#050814] p-3 flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Clark anything…" className="flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
          <button disabled={loading} onClick={() => void sendText(input)} className="rounded-xl border border-white/10 bg-cyan-500/20 px-3 py-2 text-sm text-white">Send</button>
        </div>
      </section>
    </div>
  )
}
