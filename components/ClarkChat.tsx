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
    { sym: 'ONCHAIN', name: 'OnChain',      price: '$0.0019',  change: '-12%',   vol: '$38K',   signal: 'SELL',   up: false, color: '#475569' },
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
  HOT:    'text-amber-400   bg-amber-400/[0.08]   border-amber-400/[0.22]',
  BUY:    'text-[#2DD4BF]   bg-[#2DD4BF]/[0.08]   border-[#2DD4BF]/[0.22]',
  STRONG: 'text-emerald-400 bg-emerald-400/[0.08]  border-emerald-400/[0.22]',
  WATCH:  'text-sky-400     bg-sky-400/[0.08]      border-sky-400/[0.22]',
  SELL:   'text-rose-400    bg-rose-400/[0.08]     border-rose-400/[0.22]',
  NEW:    'text-violet-400  bg-violet-400/[0.08]   border-violet-400/[0.22]',
  HOLD:   'text-slate-400   bg-white/[0.04]        border-white/[0.1]',
}

const CHIPS = ['Scan Wallet', 'Analyze Token', 'Track Whales', "What's pumping on Base?"]
const TABS: Tab[] = ['Trending', 'New', 'Smart Money']

// ─── Sub-components ───────────────────────────────────────────────────────

function TokenAvatar({ sym, color }: { sym: string; color: string }) {
  return (
    <div
      className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold"
      style={{ background: `${color}18`, color, border: `1px solid ${color}38` }}
    >
      {sym.slice(0, 2)}
    </div>
  )
}

function SignalBadge({ signal }: { signal: string }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-md text-[10px] font-bold border tracking-wider ${SIGNAL_STYLES[signal] ?? SIGNAL_STYLES.HOLD}`}
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
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden rounded-xl" style={{ background: '#06090e', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-10 max-w-[760px] mx-auto w-full space-y-10">

          {/* ─── Clark Hero ─────────────────────────────────────── */}
          <div className="relative rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.09)' }}>

            {/* Ambient glow orbs */}
            <div
              className="absolute -top-24 -left-20 w-[420px] h-[340px] rounded-full blur-3xl pointer-events-none"
              style={{ background: 'rgba(45,212,191,0.13)', opacity: 0.7 }}
            />
            <div
              className="absolute -bottom-20 right-0 w-[380px] h-[300px] rounded-full blur-3xl pointer-events-none"
              style={{ background: 'rgba(139,92,246,0.11)', opacity: 0.8 }}
            />

            {/* Card surface */}
            <div className="relative" style={{ background: 'linear-gradient(150deg, #0d1628 0%, #090e1c 45%, #06090e 100%)' }}>

              {/* Top edge glow line */}
              <div
                className="absolute inset-x-0 top-0 h-px pointer-events-none"
                style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(45,212,191,0.6) 25%, rgba(139,92,246,0.5) 75%, transparent 100%)' }}
              />

              <div className="px-10 pt-12 pb-12">

                {/* CORTEX badge */}
                <div
                  className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full mb-8"
                  style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.22)' }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#a78bfa]"
                    style={{ boxShadow: '0 0 7px rgba(167,139,250,1)' }}
                  />
                  <span className="text-[11px] font-semibold text-[#a78bfa] tracking-wide">
                    CORTEX &middot; AI Intelligence Layer
                  </span>
                </div>

                {/* Headline */}
                <h1
                  className="font-extrabold leading-[1.05] tracking-[-0.02em] mb-5"
                  style={{ fontSize: '48px' }}
                >
                  <span className="text-white">Ask Clark</span>
                  <br />
                  <span
                    style={{
                      background: 'linear-gradient(90deg, #2DD4BF 0%, #818cf8 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                    }}
                  >
                    anything on Base
                  </span>
                </h1>

                {/* Subtitle */}
                <p
                  className="text-[16px] leading-relaxed mb-10"
                  style={{ color: '#94a3b8', maxWidth: '440px' }}
                >
                  Real-time wallet scanning, whale tracking, token analysis
                  <br />and momentum signals — all powered by CORTEX.
                </p>

                {/* Input */}
                <div className="relative mb-6">
                  <input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAsk() }}
                    placeholder="Ask a question or paste a contract / wallet address..."
                    disabled={busy}
                    className="w-full rounded-2xl pl-6 pr-44 py-5 text-[15px] text-white placeholder:text-[#2a3a50] outline-none focus:ring-2 focus:ring-[#2DD4BF]/[0.15] transition-all disabled:opacity-50"
                    style={{
                      background: 'rgba(4,7,15,0.85)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                  />
                  <button
                    onClick={handleAsk}
                    disabled={!query.trim() || busy}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 px-6 py-3 rounded-xl text-[13px] font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 active:opacity-75"
                    style={{
                      background: '#2DD4BF',
                      color: '#04070f',
                      boxShadow: '0 0 20px rgba(45,212,191,0.35)',
                    }}
                  >
                    Ask Clark
                  </button>
                </div>

                {/* Action chips */}
                <div className="flex gap-2 flex-wrap">
                  {CHIPS.map(chip => (
                    <button
                      key={chip}
                      onClick={() => setQuery(chip)}
                      className="text-[12px] font-medium px-4 py-2 rounded-full transition-all text-[#94a3b8] hover:text-[#2DD4BF] bg-white/[0.04] hover:bg-[#2DD4BF]/[0.08] border border-white/[0.09] hover:border-[#2DD4BF]/[0.3]"
                    >
                      {chip}
                    </button>
                  ))}
                </div>

                {/* Clark response */}
                {(busy || response) && (
                  <div
                    className="mt-8 flex gap-4 items-start p-5 rounded-xl"
                    style={{ background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.18)' }}
                  >
                    <div
                      className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5"
                      style={{ background: 'rgba(139,92,246,0.18)', border: '1px solid rgba(167,139,250,0.3)' }}
                    >
                      <span className="text-[11px] font-bold text-[#a78bfa]" style={{ fontFamily: 'var(--font-plex-mono)' }}>C</span>
                    </div>
                    <div className="flex-1 pt-0.5">
                      {busy ? (
                        <div className="flex items-center gap-2 py-1">
                          {[0, 0.15, 0.3].map((delay, i) => (
                            <div
                              key={i}
                              className="w-2 h-2 rounded-full animate-pulse"
                              style={{ background: 'rgba(139,92,246,0.7)', animationDelay: `${delay}s` }}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="text-[14px] leading-relaxed" style={{ color: '#94a3b8' }}>{response}</p>
                      )}
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>

          {/* ─── Token Screener ─────────────────────────────────── */}
          <div>

            {/* Heading row with inline tabs */}
            <div className="flex items-end justify-between mb-5">
              <div>
                <h2 className="text-[20px] font-bold text-white tracking-tight">
                  Base Token Screener
                </h2>
                <p className="text-[13px] mt-1" style={{ color: '#475569' }}>
                  Track what&apos;s moving on Base in real time
                </p>
              </div>
              <div
                className="flex gap-0.5 p-1 rounded-xl shrink-0"
                style={{ background: '#060912', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                {TABS.map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={[
                      'px-4 py-2 rounded-lg text-[12px] font-semibold transition-all',
                      tab === t
                        ? 'bg-[#0d1525] text-white border border-white/[0.1] shadow-[0_2px_8px_rgba(0,0,0,0.5)]'
                        : 'text-[#64748b] border border-transparent hover:text-[#94a3b8] hover:bg-white/[0.04]',
                    ].join(' ')}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Table card */}
            <div
              className="rounded-2xl overflow-hidden"
              style={{ background: '#060912', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              {/* Column headers */}
              <div
                className="flex items-center px-6 py-3.5"
                style={{ background: 'rgba(255,255,255,0.025)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex-1 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: '#475569' }}>Token</div>
                <div className="w-28 text-right text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: '#475569' }}>Price</div>
                <div className="w-20 text-right text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: '#475569' }}>24h</div>
                <div className="w-24 text-right text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: '#475569' }}>Volume</div>
                <div className="w-24 text-right text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: '#475569' }}>Signal</div>
              </div>

              {/* Rows */}
              {tokens.map((token, i) => (
                <div
                  key={token.sym}
                  className="relative group flex items-center px-6 py-5 cursor-pointer transition-colors hover:bg-white/[0.03]"
                  style={{ borderBottom: i < tokens.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}
                >
                  {/* Token color accent */}
                  <div
                    className="absolute inset-y-0 left-0 w-[3px] opacity-0 group-hover:opacity-100 transition-opacity rounded-r-sm"
                    style={{ background: token.color }}
                  />

                  {/* Token identity */}
                  <div className="flex-1 flex items-center gap-4 min-w-0 pl-1">
                    <TokenAvatar sym={token.sym} color={token.color} />
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-white leading-tight">{token.name}</p>
                      <p
                        className="text-[11px] mt-0.5"
                        style={{ fontFamily: 'var(--font-plex-mono)', color: '#475569' }}
                      >
                        {token.sym} · Base
                      </p>
                    </div>
                  </div>

                  {/* Price */}
                  <div
                    className="w-28 text-right text-[14px] font-medium"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: '#e2e8f0' }}
                  >
                    {token.price}
                  </div>

                  {/* Change */}
                  <div
                    className="w-20 text-right text-[14px] font-bold"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: token.up ? '#2DD4BF' : '#fb7185' }}
                  >
                    {token.change}
                  </div>

                  {/* Volume */}
                  <div
                    className="w-24 text-right text-[13px]"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: '#64748b' }}
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
