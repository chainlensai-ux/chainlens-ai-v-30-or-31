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
    { sym: 'BRETT',   name: 'Brett',        price: '$0.1823',  change: '+18.4%', vol: '$2.1M',  signal: 'HOT',    up: true,  color: '#f97316' },
    { sym: 'VIRTUAL', name: 'Virtuals',     price: '$2.1420',  change: '+11.8%', vol: '$1.3M',  signal: 'BUY',    up: true,  color: '#6366f1' },
    { sym: 'AERO',    name: 'Aerodrome',    price: '$1.4230',  change: '+9.1%',  vol: '$890K',  signal: 'BUY',    up: true,  color: '#22d3ee' },
    { sym: 'TOSHI',   name: 'Toshi',        price: '$0.0008',  change: '+6.2%',  vol: '$521K',  signal: 'WATCH',  up: true,  color: '#fb923c' },
    { sym: 'HIGHER',  name: 'Higher',       price: '$0.0031',  change: '+4.3%',  vol: '$340K',  signal: 'WATCH',  up: true,  color: '#a78bfa' },
    { sym: 'DEGEN',   name: 'Degen',        price: '$0.0142',  change: '-4.2%',  vol: '$440K',  signal: 'SELL',   up: false, color: '#f43f5e' },
  ],
  New: [
    { sym: 'BOING',   name: 'Boing',        price: '$0.0001',  change: '+240%',  vol: '$89K',   signal: 'NEW',    up: true,  color: '#ec4899' },
    { sym: 'WARP',    name: 'Warpcast',     price: '$0.0032',  change: '+64%',   vol: '$124K',  signal: 'HOT',    up: true,  color: '#8b5cf6' },
    { sym: 'BASED',   name: 'Based',        price: '$0.0008',  change: '+31%',   vol: '$67K',   signal: 'WATCH',  up: true,  color: '#0ea5e9' },
    { sym: 'FREN',    name: 'Fren',         price: '$0.0000',  change: '+180%',  vol: '$44K',   signal: 'NEW',    up: true,  color: '#10b981' },
    { sym: 'ONCHAIN', name: 'OnChain',      price: '$0.0019',  change: '-12%',   vol: '$38K',   signal: 'SELL',   up: false, color: '#64748b' },
    { sym: 'LAUNCH',  name: 'LaunchBase',   price: '$0.0041',  change: '+22%',   vol: '$91K',   signal: 'WATCH',  up: true,  color: '#f59e0b' },
  ],
  'Smart Money': [
    { sym: 'CBBTC',   name: 'Coinbase BTC', price: '$67,420',  change: '+1.2%',  vol: '$12.3M', signal: 'HOLD',   up: true,  color: '#f59e0b' },
    { sym: 'AERO',    name: 'Aerodrome',    price: '$1.4230',  change: '+9.1%',  vol: '$890K',  signal: 'STRONG', up: true,  color: '#22d3ee' },
    { sym: 'BRETT',   name: 'Brett',        price: '$0.1823',  change: '+18.4%', vol: '$2.1M',  signal: 'BUY',    up: true,  color: '#f97316' },
    { sym: 'MORPHO',  name: 'Morpho',       price: '$1.8940',  change: '+3.4%',  vol: '$567K',  signal: 'BUY',    up: true,  color: '#10b981' },
    { sym: 'VIRTUAL', name: 'Virtuals',     price: '$2.1420',  change: '+11.8%', vol: '$1.3M',  signal: 'WATCH',  up: true,  color: '#6366f1' },
    { sym: 'EURC',    name: 'EURC',         price: '$1.0830',  change: '+0.3%',  vol: '$2.8M',  signal: 'HOLD',   up: true,  color: '#3b82f6' },
  ],
}

const SIGNAL_STYLES: Record<string, string> = {
  HOT:    'text-amber-400   bg-amber-400/10    border-amber-400/30',
  BUY:    'text-[#2DD4BF]   bg-[#2DD4BF]/10    border-[#2DD4BF]/30',
  STRONG: 'text-emerald-400 bg-emerald-400/10  border-emerald-400/30',
  WATCH:  'text-blue-400    bg-blue-400/10     border-blue-400/30',
  SELL:   'text-rose-400    bg-rose-400/10     border-rose-400/30',
  NEW:    'text-violet-400  bg-violet-400/10   border-violet-400/30',
  HOLD:   'text-[#64748b]   bg-white/[0.04]    border-white/10',
}

const CHIPS = ['Scan Wallet', 'Analyze Token', 'Track Whales', "What's pumping on Base?"]
const TABS: Tab[] = ['Trending', 'New', 'Smart Money']

// ─── Sub-components ───────────────────────────────────────────────────────

function TokenAvatar({ sym, color }: { sym: string; color: string }) {
  return (
    <div
      className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold"
      style={{ background: `${color}1a`, color, border: `1px solid ${color}40` }}
    >
      {sym.slice(0, 2)}
    </div>
  )
}

function SignalBadge({ signal }: { signal: string }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-md text-[10px] font-bold border ${SIGNAL_STYLES[signal] ?? SIGNAL_STYLES.HOLD}`}
      style={{ fontFamily: 'var(--font-plex-mono)', letterSpacing: '0.06em' }}
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
        <div className="px-8 py-10 space-y-10 max-w-3xl mx-auto w-full">

          {/* ── Hero card ──────────────────────────────────────────── */}
          <div
            className="bg-[#06060a] rounded-2xl border border-white/[0.1] p-12"
            style={{
              boxShadow: [
                '0 0 0 1px rgba(45,212,191,0.07)',
                '0 0 80px rgba(45,212,191,0.1)',
                '0 0 180px rgba(139,92,246,0.07)',
              ].join(', '),
            }}
          >

            {/* CORTEX badge */}
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#8b5cf6]/10 border border-[#8b5cf6]/25 mb-8">
              <div
                className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6]"
                style={{ boxShadow: '0 0 6px rgba(139,92,246,0.9)' }}
              />
              <span className="text-[11px] font-semibold text-[#a78bfa] tracking-wide">
                Powered by CORTEX
              </span>
            </div>

            {/* Heading */}
            <h1 className="text-[42px] font-bold text-white leading-[1.1] tracking-tight mb-4">
              Ask Clark anything
              <br />
              <span className="text-[#2DD4BF]">on Base</span>
            </h1>
            <p className="text-[16px] text-[#94a3b8] mb-10 leading-relaxed">
              Scan wallets &middot; track whales &middot; analyze tokens &middot; detect momentum
            </p>

            {/* Input — Ask button floated inside */}
            <div className="relative mb-5">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAsk() }}
                placeholder="Ask a question or paste a contract / wallet address..."
                disabled={busy}
                className="w-full bg-[#080c14] border border-white/[0.12] rounded-2xl pl-6 pr-32 py-5 text-[15px] text-white placeholder:text-[#334155] outline-none focus:border-[#2DD4BF]/50 transition-all disabled:opacity-50"
                style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.025)' }}
              />
              <button
                onClick={handleAsk}
                disabled={!query.trim() || busy}
                className="absolute right-3 top-1/2 -translate-y-1/2 px-5 py-2.5 rounded-xl bg-[#2DD4BF] text-[#06060a] text-[13px] font-bold hover:bg-[#25bfac] active:bg-[#1fa898] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Ask Clark
              </button>
            </div>

            {/* Action chips — pill style */}
            <div className="flex gap-2 flex-wrap">
              {CHIPS.map(chip => (
                <button
                  key={chip}
                  onClick={() => setQuery(chip)}
                  className="text-[12px] font-medium text-[#94a3b8] hover:text-[#2DD4BF] border border-white/[0.1] hover:border-[#2DD4BF]/40 bg-white/[0.03] hover:bg-[#2DD4BF]/[0.07] px-4 py-2 rounded-full transition-all"
                >
                  {chip}
                </button>
              ))}
            </div>

            {/* Clark response */}
            {(busy || response) && (
              <div className="mt-8 flex gap-4 items-start p-5 bg-[#8b5cf6]/[0.07] border border-[#8b5cf6]/[0.2] rounded-xl">
                <div className="shrink-0 w-8 h-8 rounded-full bg-[#8b5cf6]/20 border border-[#8b5cf6]/30 flex items-center justify-center mt-0.5">
                  <span
                    className="text-[11px] font-bold text-[#a78bfa]"
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    C
                  </span>
                </div>
                <div className="flex-1 pt-0.5">
                  {busy ? (
                    <div className="flex items-center gap-2 py-1">
                      <div className="w-2 h-2 rounded-full bg-[#8b5cf6]/60 animate-pulse" />
                      <div className="w-2 h-2 rounded-full bg-[#8b5cf6]/60 animate-pulse" style={{ animationDelay: '0.15s' }} />
                      <div className="w-2 h-2 rounded-full bg-[#8b5cf6]/60 animate-pulse" style={{ animationDelay: '0.3s' }} />
                    </div>
                  ) : (
                    <p className="text-[14px] text-[#94a3b8] leading-relaxed">{response}</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Token Screener ─────────────────────────────────────── */}
          <div>

            {/* Section heading */}
            <div className="mb-6">
              <h2 className="text-[22px] font-bold text-white tracking-tight">
                Base Token Screener
              </h2>
              <p className="text-[14px] text-[#64748b] mt-1.5">
                Track what&apos;s moving on Base in real time
              </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-6 bg-[#06060a] border border-white/[0.08] rounded-xl p-1.5 w-fit">
              {TABS.map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={[
                    'px-5 py-2.5 rounded-lg text-[13px] font-semibold transition-all',
                    tab === t
                      ? 'bg-[#080c14] text-white border border-white/[0.1] shadow-[0_2px_8px_rgba(0,0,0,0.5)]'
                      : 'text-[#64748b] hover:text-[#94a3b8] hover:bg-white/[0.04]',
                  ].join(' ')}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Token table */}
            <div className="bg-[#06060a] rounded-2xl border border-white/[0.08] overflow-hidden">

              {/* Column headers */}
              <div className="flex items-center px-6 py-3.5 border-b border-white/[0.08] bg-white/[0.02]">
                <div className="flex-1 text-[10px] font-bold text-[#64748b] uppercase tracking-[0.12em]">Token</div>
                <div className="w-28 text-right text-[10px] font-bold text-[#64748b] uppercase tracking-[0.12em]">Price</div>
                <div className="w-20 text-right text-[10px] font-bold text-[#64748b] uppercase tracking-[0.12em]">24h</div>
                <div className="w-24 text-right text-[10px] font-bold text-[#64748b] uppercase tracking-[0.12em]">Volume</div>
                <div className="w-24 text-right text-[10px] font-bold text-[#64748b] uppercase tracking-[0.12em]">Signal</div>
              </div>

              {/* Rows */}
              {tokens.map((token, i) => (
                <div
                  key={token.sym}
                  className={`relative group flex items-center px-6 py-5 hover:bg-white/[0.035] transition-all cursor-pointer ${
                    i < tokens.length - 1 ? 'border-b border-white/[0.05]' : ''
                  }`}
                >
                  {/* Left color accent on hover */}
                  <div
                    className="absolute inset-y-0 left-0 w-[3px] rounded-r-sm opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ background: token.color }}
                  />

                  {/* Token name + avatar */}
                  <div className="flex-1 flex items-center gap-3.5 min-w-0 pl-1">
                    <TokenAvatar sym={token.sym} color={token.color} />
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-white leading-tight">{token.name}</p>
                      <p
                        className="text-[11px] text-[#475569] mt-0.5"
                        style={{ fontFamily: 'var(--font-plex-mono)' }}
                      >
                        {token.sym} · Base
                      </p>
                    </div>
                  </div>

                  {/* Price */}
                  <div
                    className="w-28 text-right text-[14px] font-medium text-[#e2e8f0]"
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {token.price}
                  </div>

                  {/* Change */}
                  <div
                    className={`w-20 text-right text-[14px] font-bold ${token.up ? 'text-[#2DD4BF]' : 'text-rose-400'}`}
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
                  <div className="w-24 flex justify-end">
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
