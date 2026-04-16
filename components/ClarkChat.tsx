'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'

// ─── Types ────────────────────────────────────────────────────────────────

type Tab = 'Trending' | 'New' | 'Smart Money'

interface Token {
  chain:  string
  sym:    string
  name:   string
  price:  string
  change: string
  mcap:   string
  vol:    string
  signal: string
  up:     boolean
  color:  string
}

// ─── Mock data ────────────────────────────────────────────────────────────

const SCREENER: Record<Tab, Token[]> = {
  Trending: [
    { chain: 'Base', sym: 'BRETT',   name: 'Brett',        price: '$0.1823',  change: '+18.4%', mcap: '$182M',  vol: '$2.1M',  signal: 'HOT',   up: true,  color: '#f97316' },
    { chain: 'Base', sym: 'VIRTUAL', name: 'Virtuals',     price: '$2.1420',  change: '+11.8%', mcap: '$2.1B',  vol: '$1.3M',  signal: 'BUY',   up: true,  color: '#6366f1' },
    { chain: 'Base', sym: 'AERO',    name: 'Aerodrome',    price: '$1.4230',  change: '+9.1%',  mcap: '$890M',  vol: '$890K',  signal: 'BUY',   up: true,  color: '#22d3ee' },
    { chain: 'Base', sym: 'TOSHI',   name: 'Toshi',        price: '$0.0008',  change: '+6.2%',  mcap: '$80M',   vol: '$521K',  signal: 'WATCH', up: true,  color: '#fb923c' },
    { chain: 'Base', sym: 'HIGHER',  name: 'Higher',       price: '$0.0031',  change: '+4.3%',  mcap: '$31M',   vol: '$340K',  signal: 'WATCH', up: true,  color: '#a78bfa' },
    { chain: 'Base', sym: 'DEGEN',   name: 'Degen',        price: '$0.0142',  change: '-4.2%',  mcap: '$142M',  vol: '$440K',  signal: 'SELL',  up: false, color: '#f43f5e' },
  ],
  New: [
    { chain: 'Base', sym: 'BOING',   name: 'Boing',        price: '$0.0001',  change: '+240%',  mcap: '$1.2M',  vol: '$89K',   signal: 'NEW',   up: true,  color: '#ec4899' },
    { chain: 'Base', sym: 'WARP',    name: 'Warpcast',     price: '$0.0032',  change: '+64%',   mcap: '$4.8M',  vol: '$124K',  signal: 'HOT',   up: true,  color: '#8b5cf6' },
    { chain: 'Base', sym: 'BASED',   name: 'Based',        price: '$0.0008',  change: '+31%',   mcap: '$2.1M',  vol: '$67K',   signal: 'WATCH', up: true,  color: '#0ea5e9' },
    { chain: 'Base', sym: 'FREN',    name: 'Fren',         price: '$0.0000',  change: '+180%',  mcap: '$620K',  vol: '$44K',   signal: 'NEW',   up: true,  color: '#10b981' },
    { chain: 'Base', sym: 'ONCHAIN', name: 'OnChain',      price: '$0.0019',  change: '-12%',   mcap: '$3.4M',  vol: '$38K',   signal: 'SELL',  up: false, color: '#475569' },
    { chain: 'Base', sym: 'LAUNCH',  name: 'LaunchBase',   price: '$0.0041',  change: '+22%',   mcap: '$6.1M',  vol: '$91K',   signal: 'WATCH', up: true,  color: '#f59e0b' },
  ],
  'Smart Money': [
    { chain: 'Base', sym: 'CBBTC',   name: 'Coinbase BTC', price: '$67,420',  change: '+1.2%',  mcap: '$4.2B',  vol: '$12.3M', signal: 'HOLD',  up: true,  color: '#f59e0b' },
    { chain: 'Base', sym: 'AERO',    name: 'Aerodrome',    price: '$1.4230',  change: '+9.1%',  mcap: '$890M',  vol: '$890K',  signal: 'STRONG',up: true,  color: '#22d3ee' },
    { chain: 'Base', sym: 'BRETT',   name: 'Brett',        price: '$0.1823',  change: '+18.4%', mcap: '$182M',  vol: '$2.1M',  signal: 'BUY',   up: true,  color: '#f97316' },
    { chain: 'Base', sym: 'MORPHO',  name: 'Morpho',       price: '$1.8940',  change: '+3.4%',  mcap: '$1.1B',  vol: '$567K',  signal: 'BUY',   up: true,  color: '#10b981' },
    { chain: 'Base', sym: 'VIRTUAL', name: 'Virtuals',     price: '$2.1420',  change: '+11.8%', mcap: '$2.1B',  vol: '$1.3M',  signal: 'WATCH', up: true,  color: '#6366f1' },
    { chain: 'Base', sym: 'EURC',    name: 'EURC',         price: '$1.0830',  change: '+0.3%',  mcap: '$840M',  vol: '$2.8M',  signal: 'HOLD',  up: true,  color: '#3b82f6' },
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

const CHIPS = [
  'Scan Whale Wallet',
  "What's Pumping on Base?",
  'Analyze This Token',
  'What Are Whales Buying?',
]

const TABS: Tab[] = ['Trending', 'New', 'Smart Money']

// ─── Sub-components ───────────────────────────────────────────────────────

function TokenAvatar({ sym, color }: { sym: string; color: string }) {
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold"
      style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}
    >
      {sym.slice(0, 2)}
    </div>
  )
}

function SignalBadge({ signal }: { signal: string }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-[3px] rounded-md text-[9px] font-bold border tracking-wider ${SIGNAL_STYLES[signal] ?? SIGNAL_STYLES.HOLD}`}
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
      const data = await res.json()
      setResponse((data.text || '').trim() || 'CORTEX is processing — try again in a moment.')
    } catch {
      setResponse('CORTEX unreachable — check your connection.')
    } finally {
      setBusy(false)
    }
  }

  const tokens = SCREENER[tab]

  return (
    <div
      className="flex-1 flex flex-col min-w-0 overflow-hidden rounded-2xl"
      style={{ background: '#0b1120', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-8 max-w-[860px] mx-auto w-full space-y-10">

          {/* ─── Clark Hero ──────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            className="relative rounded-2xl overflow-hidden"
            style={{ border: '1px solid rgba(255,255,255,0.09)' }}
          >
            {/* Glow orbs */}
            <div
              className="absolute -top-32 -left-28 w-[500px] h-[400px] rounded-full blur-3xl pointer-events-none"
              style={{ background: 'rgba(45,212,191,0.13)' }}
            />
            <div
              className="absolute -bottom-20 right-0 w-[420px] h-[340px] rounded-full blur-3xl pointer-events-none"
              style={{ background: 'rgba(139,92,246,0.12)' }}
            />

            {/* Surface */}
            <div
              className="relative"
              style={{ background: 'linear-gradient(150deg, #0d1c2e 0%, #0a1220 50%, #080e1a 100%)' }}
            >
              {/* Top edge glow */}
              <div
                className="absolute inset-x-0 top-0 h-px pointer-events-none"
                style={{
                  background: 'linear-gradient(90deg, transparent 0%, rgba(45,212,191,0.65) 30%, rgba(139,92,246,0.6) 70%, transparent 100%)',
                }}
              />

              <div className="px-10 pt-12 pb-12">

                {/* CORTEX badge */}
                <div
                  className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full mb-7"
                  style={{
                    background: 'rgba(139,92,246,0.1)',
                    border: '1px solid rgba(139,92,246,0.22)',
                  }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#a78bfa]"
                    style={{ boxShadow: '0 0 7px rgba(167,139,250,1)' }}
                  />
                  <span className="text-[11px] font-semibold text-[#a78bfa] tracking-wide">
                    POWERED BY CORTEX ENGINE
                  </span>
                </div>

                {/* Headline */}
                <h1
                  className="font-extrabold leading-[1.05] tracking-[-0.03em] mb-5"
                  style={{ fontSize: '50px' }}
                >
                  <span style={{ color: '#f8fafc' }}>Ask </span>
                  <span
                    style={{
                      background: 'linear-gradient(88deg, #2DD4BF 0%, #60a5fa 50%, #a78bfa 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                    }}
                  >
                    Clark
                  </span>
                  <span style={{ color: '#f8fafc' }}> anything on </span>
                  <span
                    style={{
                      background: 'linear-gradient(88deg, #60a5fa 0%, #2DD4BF 100%)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                    }}
                  >
                    Base
                  </span>
                </h1>

                {/* Subtitle */}
                <p
                  className="text-[16px] leading-relaxed mb-9"
                  style={{ color: '#94a3b8', maxWidth: '480px' }}
                >
                  Scan wallets, track whales, discover pumps, analyze tokens
                  with real-time AI intelligence.
                </p>

                {/* Input */}
                <div className="relative mb-5">
                  <input
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAsk() }}
                    placeholder="Ask Clark anything..."
                    disabled={busy}
                    className="w-full rounded-2xl text-[15px] outline-none transition-all disabled:opacity-50"
                    style={{
                      padding: '18px 172px 18px 22px',
                      background: 'rgba(5,8,18,0.9)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                      color: '#f1f5f9',
                    }}
                    onFocus={e => {
                      e.currentTarget.style.borderColor = 'rgba(45,212,191,0.5)'
                      e.currentTarget.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 3px rgba(45,212,191,0.08)'
                    }}
                    onBlur={e => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                      e.currentTarget.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.04)'
                    }}
                  />
                  <button
                    onClick={handleAsk}
                    disabled={!query.trim() || busy}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-6 py-2.5 rounded-xl text-[13px] font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 active:scale-[0.97]"
                    style={{
                      background: 'linear-gradient(90deg, #2DD4BF 0%, #8B5CF6 100%)',
                      color: '#ffffff',
                      boxShadow: '0 0 22px rgba(45,212,191,0.35)',
                    }}
                  >
                    Ask Clark
                  </button>
                </div>

                {/* Action chips */}
                <div className="flex gap-2.5 flex-wrap">
                  {CHIPS.map(chip => (
                    <motion.button
                      key={chip}
                      onClick={() => setQuery(chip)}
                      className="text-[12px] font-medium px-4 py-2.5 rounded-xl transition-colors"
                      style={{
                        color: '#94a3b8',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.1)',
                      }}
                      whileHover={{ scale: 1.02 }}
                      transition={{ duration: 0.1 }}
                      onMouseEnter={e => {
                        const el = e.currentTarget as HTMLButtonElement
                        el.style.color = '#2DD4BF'
                        el.style.borderColor = 'rgba(45,212,191,0.4)'
                        el.style.background = 'rgba(45,212,191,0.07)'
                        el.style.boxShadow = '0 0 20px rgba(45,212,191,0.12)'
                      }}
                      onMouseLeave={e => {
                        const el = e.currentTarget as HTMLButtonElement
                        el.style.color = '#94a3b8'
                        el.style.borderColor = 'rgba(255,255,255,0.1)'
                        el.style.background = 'rgba(255,255,255,0.04)'
                        el.style.boxShadow = 'none'
                      }}
                    >
                      {chip}
                    </motion.button>
                  ))}
                </div>

                {/* Clark response */}
                {(busy || response) && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="mt-7 flex gap-4 items-start p-5 rounded-2xl"
                    style={{
                      background: 'rgba(139,92,246,0.07)',
                      border: '1px solid rgba(139,92,246,0.18)',
                    }}
                  >
                    <div
                      className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5"
                      style={{
                        background: 'rgba(139,92,246,0.2)',
                        border: '1px solid rgba(167,139,250,0.3)',
                      }}
                    >
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
                          {[0, 0.15, 0.3].map((delay, i) => (
                            <div
                              key={i}
                              className="w-2 h-2 rounded-full animate-pulse"
                              style={{ background: 'rgba(139,92,246,0.7)', animationDelay: `${delay}s` }}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="text-[14px] leading-relaxed" style={{ color: '#94a3b8' }}>
                          {response}
                        </p>
                      )}
                    </div>
                  </motion.div>
                )}

              </div>
            </div>
          </motion.div>

          {/* ─── Token Screener ──────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.1, ease: 'easeOut' }}
          >
            {/* Heading row */}
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="flex items-center gap-3">
                  <h2
                    className="text-[20px] font-bold tracking-tight"
                    style={{ color: '#f8fafc' }}
                  >
                    Token Screener
                  </h2>
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full"
                    style={{ background: 'rgba(45,212,191,0.1)', border: '1px solid rgba(45,212,191,0.2)' }}
                  >
                    <div
                      className="w-1 h-1 rounded-full bg-[#2DD4BF]"
                      style={{ boxShadow: '0 0 5px rgba(45,212,191,0.9)' }}
                    />
                    <span
                      className="text-[9px] font-bold text-[#2DD4BF] tracking-wider"
                      style={{ fontFamily: 'var(--font-plex-mono)' }}
                    >
                      LIVE
                    </span>
                  </div>
                </div>
                <p className="text-[13px] mt-1" style={{ color: '#64748b' }}>
                  Real-time movements on Base
                </p>
              </div>

              {/* Tabs */}
              <div
                className="flex gap-0.5 p-1 rounded-xl shrink-0"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                {TABS.map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className="px-4 py-2 rounded-lg text-[12px] font-semibold transition-all"
                    style={
                      tab === t
                        ? {
                            background: '#0f1b2e',
                            color: '#ffffff',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                            border: '1px solid rgba(255,255,255,0.1)',
                          }
                        : { color: '#64748b', border: '1px solid transparent' }
                    }
                    onMouseEnter={e => {
                      if (tab !== t) (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'
                    }}
                    onMouseLeave={e => {
                      if (tab !== t) (e.currentTarget as HTMLButtonElement).style.color = '#64748b'
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Table */}
            <div
              className="rounded-2xl overflow-hidden"
              style={{ background: '#080e1a', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              {/* Column headers */}
              <div
                className="grid items-center px-6 py-3.5"
                style={{
                  gridTemplateColumns: '1fr 110px 72px 96px 88px 82px',
                  background: 'rgba(255,255,255,0.02)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {['Token', 'Price', '24H', 'MCAP', 'Volume', 'Signal'].map(h => (
                  <div
                    key={h}
                    className="text-[10px] font-bold uppercase tracking-[0.14em] text-right first:text-left"
                    style={{ color: '#475569' }}
                  >
                    {h}
                  </div>
                ))}
              </div>

              {/* Rows */}
              {tokens.map((token, i) => (
                <motion.div
                  key={token.sym}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.04 }}
                  className="relative group grid items-center px-6 cursor-pointer transition-colors hover:bg-white/[0.035]"
                  style={{
                    gridTemplateColumns: '1fr 110px 72px 96px 88px 82px',
                    paddingTop: '18px',
                    paddingBottom: '18px',
                    borderBottom: i < tokens.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  }}
                >
                  {/* Hover accent */}
                  <div
                    className="absolute inset-y-0 left-0 w-[3px] opacity-0 group-hover:opacity-100 transition-opacity rounded-r-full"
                    style={{ background: token.color }}
                  />

                  {/* Token identity */}
                  <div className="flex items-center gap-3.5 min-w-0 pl-1">
                    <TokenAvatar sym={token.sym} color={token.color} />
                    <div className="min-w-0">
                      <p
                        className="text-[13px] font-semibold leading-tight"
                        style={{ color: '#f1f5f9' }}
                      >
                        {token.name}
                      </p>
                      <p
                        className="text-[10px] mt-0.5"
                        style={{ fontFamily: 'var(--font-plex-mono)', color: '#3d5268' }}
                      >
                        {token.sym}
                      </p>
                    </div>
                  </div>

                  {/* Price */}
                  <div
                    className="text-right text-[13px] font-medium"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: '#e2e8f0' }}
                  >
                    {token.price}
                  </div>

                  {/* Change */}
                  <div
                    className="text-right text-[13px] font-bold"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: token.up ? '#2DD4BF' : '#fb7185' }}
                  >
                    {token.change}
                  </div>

                  {/* MCAP */}
                  <div
                    className="text-right text-[12px]"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: '#64748b' }}
                  >
                    {token.mcap}
                  </div>

                  {/* Volume */}
                  <div
                    className="text-right text-[12px]"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: '#4d6280' }}
                  >
                    {token.vol}
                  </div>

                  {/* Signal */}
                  <div className="flex justify-end">
                    <SignalBadge signal={token.signal} />
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* ─── Bottom Analytics Row ─────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.2, ease: 'easeOut' }}
            className="grid grid-cols-3 gap-4"
          >

            {/* Market Sentiment */}
            <motion.div
              whileHover={{ y: -2 }}
              transition={{ duration: 0.15 }}
              className="rounded-2xl p-6"
              style={{ background: '#080e1a', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <p
                className="text-[10px] font-bold uppercase tracking-[0.14em] mb-4"
                style={{ color: '#475569' }}
              >
                Market Sentiment
              </p>
              <p
                className="text-[28px] font-black leading-none tracking-tight mb-1"
                style={{
                  background: 'linear-gradient(90deg, #2DD4BF, #60a5fa)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                BULLISH
              </p>
              <p className="text-[12px] mt-3" style={{ color: '#64748b' }}>
                74% of wallets accumulating
              </p>
              <div
                className="mt-4 h-1.5 rounded-full overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.07)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: '74%', background: 'linear-gradient(90deg, #2DD4BF80, #2DD4BF)' }}
                />
              </div>
            </motion.div>

            {/* Top Gainer 24H */}
            <motion.div
              whileHover={{ y: -2 }}
              transition={{ duration: 0.15 }}
              className="rounded-2xl p-6"
              style={{ background: '#080e1a', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <p
                className="text-[10px] font-bold uppercase tracking-[0.14em] mb-4"
                style={{ color: '#475569' }}
              >
                Top Gainer 24H
              </p>
              <div className="flex items-center gap-3 mb-2">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                  style={{ background: 'rgba(249,115,22,0.15)', color: '#f97316', border: '1px solid rgba(249,115,22,0.3)' }}
                >
                  BR
                </div>
                <div>
                  <p className="text-[15px] font-bold" style={{ color: '#f1f5f9' }}>BRETT</p>
                  <p
                    className="text-[22px] font-black leading-none"
                    style={{ color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}
                  >
                    +18.4%
                  </p>
                </div>
              </div>
              <p className="text-[11px] mt-2" style={{ color: '#475569', fontFamily: 'var(--font-plex-mono)' }}>
                $0.1823 · MCAP $182M
              </p>
            </motion.div>

            {/* BTC Dominance */}
            <motion.div
              whileHover={{ y: -2 }}
              transition={{ duration: 0.15 }}
              className="rounded-2xl p-6"
              style={{ background: '#080e1a', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <p
                className="text-[10px] font-bold uppercase tracking-[0.14em] mb-4"
                style={{ color: '#475569' }}
              >
                BTC Dominance
              </p>
              <p
                className="text-[36px] font-black leading-none tracking-tight"
                style={{ color: '#f8fafc', fontFamily: 'var(--font-plex-mono)' }}
              >
                54.8<span className="text-[24px] text-[#64748b]">%</span>
              </p>
              <div className="flex items-center gap-2 mt-3">
                <span
                  className="text-[12px] font-bold"
                  style={{ color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}
                >
                  +0.3%
                </span>
                <span className="text-[12px]" style={{ color: '#475569' }}>vs yesterday</span>
              </div>
              <p className="text-[11px] mt-2" style={{ color: '#475569' }}>
                Alts may see pressure in 24–48h
              </p>
            </motion.div>

          </motion.div>

        </div>
      </div>
    </div>
  )
}
