'use client'

import { useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────

type Tab = 'Trending' | 'New' | 'Smart Money'

interface Token {
  sym:    string
  name:   string
  price:  string
  change: string
  vol:    string
  signal: string
  up:     boolean
  color:  string
}

// ─── Mock data ────────────────────────────────────────────────────────────

const SCREENER: Record<Tab, Token[]> = {
  Trending: [
    { sym: 'BRETT',   name: 'Brett',       price: '$0.1823',  change: '+18.4%', vol: '$2.1M',  signal: 'HOT',   up: true,  color: '#f97316' },
    { sym: 'VIRTUAL', name: 'Virtuals',    price: '$2.1420',  change: '+11.8%', vol: '$1.3M',  signal: 'BUY',   up: true,  color: '#6366f1' },
    { sym: 'AERO',    name: 'Aerodrome',   price: '$1.4230',  change: '+9.1%',  vol: '$890K',  signal: 'BUY',   up: true,  color: '#22d3ee' },
    { sym: 'TOSHI',   name: 'Toshi',       price: '$0.0008',  change: '+6.2%',  vol: '$521K',  signal: 'WATCH', up: true,  color: '#fb923c' },
    { sym: 'HIGHER',  name: 'Higher',      price: '$0.0031',  change: '+4.3%',  vol: '$340K',  signal: 'WATCH', up: true,  color: '#a78bfa' },
    { sym: 'DEGEN',   name: 'Degen',       price: '$0.0142',  change: '-4.2%',  vol: '$440K',  signal: 'SELL',  up: false, color: '#f43f5e' },
  ],
  New: [
    { sym: 'BOING',   name: 'Boing',       price: '$0.0001',  change: '+240%',  vol: '$89K',   signal: 'NEW',   up: true,  color: '#ec4899' },
    { sym: 'WARP',    name: 'Warpcast',    price: '$0.0032',  change: '+64%',   vol: '$124K',  signal: 'HOT',   up: true,  color: '#8b5cf6' },
    { sym: 'BASED',   name: 'Based',       price: '$0.0008',  change: '+31%',   vol: '$67K',   signal: 'WATCH', up: true,  color: '#0ea5e9' },
    { sym: 'FREN',    name: 'Fren',        price: '$0.0000',  change: '+180%',  vol: '$44K',   signal: 'NEW',   up: true,  color: '#10b981' },
    { sym: 'ONCHAIN', name: 'OnChain',     price: '$0.0019',  change: '-12%',   vol: '$38K',   signal: 'SELL',  up: false, color: '#64748b' },
    { sym: 'LAUNCH',  name: 'LaunchBase',  price: '$0.0041',  change: '+22%',   vol: '$91K',   signal: 'WATCH', up: true,  color: '#f59e0b' },
  ],
  'Smart Money': [
    { sym: 'CBBTC',   name: 'Coinbase BTC', price: '$67,420', change: '+1.2%',  vol: '$12.3M', signal: 'HOLD',  up: true,  color: '#f59e0b' },
    { sym: 'AERO',    name: 'Aerodrome',    price: '$1.4230', change: '+9.1%',  vol: '$890K',  signal: 'STRONG',up: true,  color: '#22d3ee' },
    { sym: 'BRETT',   name: 'Brett',        price: '$0.1823', change: '+18.4%', vol: '$2.1M',  signal: 'BUY',   up: true,  color: '#f97316' },
    { sym: 'MORPHO',  name: 'Morpho',       price: '$1.8940', change: '+3.4%',  vol: '$567K',  signal: 'BUY',   up: true,  color: '#10b981' },
    { sym: 'VIRTUAL', name: 'Virtuals',     price: '$2.1420', change: '+11.8%', vol: '$1.3M',  signal: 'WATCH', up: true,  color: '#6366f1' },
    { sym: 'EURC',    name: 'EURC',         price: '$1.0830', change: '+0.3%',  vol: '$2.8M',  signal: 'HOLD',  up: true,  color: '#3b82f6' },
  ],
}

const SIGNAL_STYLES: Record<string, string> = {
  HOT:    'text-amber-400  bg-amber-400/10   border-amber-400/20',
  BUY:    'text-[#2DD4BF]  bg-[#2DD4BF]/10   border-[#2DD4BF]/20',
  STRONG: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  WATCH:  'text-blue-400   bg-blue-400/10    border-blue-400/20',
  SELL:   'text-rose-400   bg-rose-400/10    border-rose-400/20',
  NEW:    'text-violet-400 bg-violet-400/10  border-violet-400/20',
  HOLD:   'text-[#64748b]  bg-white/[0.04]   border-white/10',
}

const CHIPS = ['Scan Wallet', 'Analyze Token', 'Track Whales', "What's pumping on Base?"]

const TABS: Tab[] = ['Trending', 'New', 'Smart Money']

// ─── Sub-components ───────────────────────────────────────────────────────

function TokenAvatar({ sym, color }: { sym: string; color: string }) {
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold"
      style={{ background: `${color}22`, color }}
    >
      {sym.slice(0, 2)}
    </div>
  )
}

function SignalBadge({ signal }: { signal: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold border ${SIGNAL_STYLES[signal] ?? SIGNAL_STYLES.HOLD}`}
      style={{ fontFamily: 'var(--font-plex-mono)' }}
    >
      {signal}
    </span>
  )
}

// ─── Main component ───────────────────────────────────────────────────────

interface Props {
  active:    string | null
  toolLabel: string
}

export default function ClarkChat({ active, toolLabel }: Props) {
  const [query,    setQuery]    = useState('')
  const [tab,      setTab]      = useState<Tab>('Trending')
  const [response, setResponse] = useState<string | null>(null)
  const [busy,     setBusy]     = useState(false)

  async function handleAsk() {
    const q = query.trim()
    if (!q || busy) return
    setBusy(true)
    setResponse(null)
    try {
      const res = await fetch('/api/claude', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `You are Clark, the AI inside ChainLens — a crypto intelligence terminal for Base chain. Active tool: ${active ?? 'general'}. Keep responses sharp, data-focused, and under 3 sentences.\n\nUser: ${q}\nClark:`,
          max_tokens: 300,
        }),
      })
      const data  = await res.json()
      setResponse((data.text || '').trim() || 'CORTEX is processing — try again in a moment.')
    } catch {
      setResponse('CORTEX unreachable — check your connection.')
    } finally {
      setBusy(false)
    }
  }

  const tokens = SCREENER[tab]

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#080c14] rounded-xl border border-white/[0.08]">
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-8 space-y-8 max-w-3xl mx-auto w-full">

          {/* ── Hero card ──────────────────────────────────────────── */}
          <div
            className="bg-[#06060a] rounded-2xl border border-white/[0.08] p-10"
            style={{ boxShadow: '0 0 60px rgba(45,212,191,0.05), 0 0 120px rgba(139,92,246,0.04)' }}
          >

            {/* CORTEX eyebrow */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#8b5cf6]/10 border border-[#8b5cf6]/20 mb-7">
              <div className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6]" />
              <span className="text-[11px] font-semibold text-[#8b5cf6] tracking-wide">
                Powered by CORTEX
              </span>
            </div>

            {/* Heading */}
            <h1 className="text-[32px] font-bold text-white leading-tight tracking-tight mb-2.5">
              Ask Clark anything{' '}
              <span className="text-[#2DD4BF]">on Base</span>
            </h1>
            <p className="text-[15px] text-[#64748b] mb-8 leading-relaxed">
              Scan wallets, track whales, analyze tokens, detect momentum
            </p>

            {/* Input */}
            <div className="flex gap-3 mb-4">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAsk() }}
                placeholder="Ask a question or paste a contract / wallet address..."
                disabled={busy}
                className="flex-1 min-w-0 bg-[#080c14] border border-white/[0.1] rounded-xl px-5 py-3.5 text-[14px] text-white placeholder:text-[#2d3f52] outline-none focus:border-[#2DD4BF]/50 focus:shadow-[0_0_0_3px_rgba(45,212,191,0.06)] transition-all disabled:opacity-50"
              />
              <button
                onClick={handleAsk}
                disabled={!query.trim() || busy}
                className="shrink-0 px-7 py-3.5 rounded-xl bg-[#2DD4BF] text-[#06060a] text-[14px] font-bold hover:bg-[#25bfac] active:bg-[#1fa898] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Ask
              </button>
            </div>

            {/* Action chips */}
            <div className="flex gap-2 flex-wrap">
              {CHIPS.map(chip => (
                <button
                  key={chip}
                  onClick={() => setQuery(chip)}
                  className="text-[12px] text-[#64748b] hover:text-[#94a3b8] border border-white/[0.08] hover:border-white/[0.15] bg-white/[0.03] hover:bg-white/[0.07] px-3.5 py-2 rounded-lg font-medium transition-all"
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Clark response */}
            {(busy || response) && (
              <div className="mt-5 flex gap-3 items-start p-4 bg-[#8b5cf6]/[0.06] border border-[#8b5cf6]/[0.15] rounded-xl">
                <div className="shrink-0 w-7 h-7 rounded-full bg-[#8b5cf6]/20 border border-[#8b5cf6]/30 flex items-center justify-center mt-0.5">
                  <span
                    className="text-[10px] font-bold text-[#8b5cf6]"
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    C
                  </span>
                </div>
                <div className="flex-1 pt-1">
                  {busy ? (
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6]/50 animate-pulse" />
                      <div className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6]/50 animate-pulse" style={{ animationDelay: '0.15s' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6]/50 animate-pulse" style={{ animationDelay: '0.3s' }} />
                    </div>
                  ) : (
                    <p className="text-[13px] text-[#94a3b8] leading-relaxed">{response}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Token Screener ─────────────────────────────────────── */}
          <div>

            {/* Section heading */}
            <div className="mb-5">
              <h2 className="text-[18px] font-bold text-white tracking-tight">
                Base Token Screener
              </h2>
              <p className="text-[13px] text-[#64748b] mt-1">
                Track what&apos;s moving on Base in real time
              </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-5 bg-[#06060a] border border-white/[0.08] rounded-xl p-1 w-fit">
              {TABS.map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={[
                    'px-5 py-2 rounded-lg text-[13px] font-medium transition-all',
                    tab === t
                      ? 'bg-[#080c14] text-white border border-white/[0.1] shadow-[0_1px_3px_rgba(0,0,0,0.4)]'
                      : 'text-[#64748b] hover:text-[#94a3b8] hover:bg-white/[0.03]',
                  ].join(' ')}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Token table */}
            <div className="bg-[#06060a] rounded-2xl border border-white/[0.08] overflow-hidden">

              {/* Column headers */}
              <div className="flex items-center px-5 py-3 border-b border-white/[0.06]">
                <div className="flex-1 text-[10px] font-semibold text-[#475569] uppercase tracking-widest">
                  Token
                </div>
                <div className="w-28 text-right text-[10px] font-semibold text-[#475569] uppercase tracking-widest">
                  Price
                </div>
                <div className="w-20 text-right text-[10px] font-semibold text-[#475569] uppercase tracking-widest">
                  24h
                </div>
                <div className="w-24 text-right text-[10px] font-semibold text-[#475569] uppercase tracking-widest">
                  Volume
                </div>
                <div className="w-20 text-right text-[10px] font-semibold text-[#475569] uppercase tracking-widest">
                  Signal
                </div>
              </div>

              {/* Rows */}
              {tokens.map((token, i) => (
                <div
                  key={token.sym}
                  className={`flex items-center px-5 py-4 hover:bg-white/[0.025] transition-colors cursor-pointer ${
                    i < tokens.length - 1 ? 'border-b border-white/[0.04]' : ''
                  }`}
                >
                  {/* Name */}
                  <div className="flex-1 flex items-center gap-3 min-w-0">
                    <TokenAvatar sym={token.sym} color={token.color} />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-white leading-tight">{token.name}</p>
                      <p
                        className="text-[10px] text-[#475569] mt-0.5"
                        style={{ fontFamily: 'var(--font-plex-mono)' }}
                      >
                        {token.sym} · Base
                      </p>
                    </div>
                  </div>

                  {/* Price */}
                  <div
                    className="w-28 text-right text-[13px] font-medium text-[#e2e8f0]"
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {token.price}
                  </div>

                  {/* Change */}
                  <div
                    className={`w-20 text-right text-[13px] font-semibold ${token.up ? 'text-[#2DD4BF]' : 'text-rose-400'}`}
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {token.change}
                  </div>

                  {/* Volume */}
                  <div
                    className="w-24 text-right text-[13px] text-[#64748b]"
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {token.vol}
                  </div>

                  {/* Signal */}
                  <div className="w-20 flex justify-end">
                    <SignalBadge signal={token.signal} />
                  </div>
                </div>
              ))}
            </div>

          </div>

        </div>
      </div>
    </div>
  )
}
