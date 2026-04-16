'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'

// ─── Types ────────────────────────────────────────────────────────────────

type ChainFilter = 'All Chains' | 'Ethereum' | 'Solana' | 'Arbitrum' | 'Base'
type TimeFilter  = '1H' | '24H' | '7D' | '30D'

interface Token {
  rank:      number
  chain:     string
  sym:       string
  name:      string
  price:     string
  change:    string
  volume:    string
  liquidity: string
  up:        boolean
  color:     string
}

// ─── Mock data ────────────────────────────────────────────────────────────

const TOKENS: Token[] = [
  { rank: 1, chain: 'Base',     sym: 'BRETT',   name: 'Brett',       price: '$0.1823',  change: '+18.4%', volume: '$2.1M',  liquidity: '$8.4M',   up: true,  color: '#f97316' },
  { rank: 2, chain: 'Ethereum', sym: 'VIRTUAL', name: 'Virtuals',    price: '$2.1420',  change: '+11.8%', volume: '$1.3M',  liquidity: '$12.1M',  up: true,  color: '#6366f1' },
  { rank: 3, chain: 'Base',     sym: 'AERO',    name: 'Aerodrome',   price: '$1.4230',  change: '+9.1%',  volume: '$890K',  liquidity: '$24.8M',  up: true,  color: '#22d3ee' },
  { rank: 4, chain: 'Solana',   sym: 'BONK',    name: 'Bonk',        price: '$0.00002', change: '+7.3%',  volume: '$4.2M',  liquidity: '$32.1M',  up: true,  color: '#f59e0b' },
  { rank: 5, chain: 'Base',     sym: 'TOSHI',   name: 'Toshi',       price: '$0.0008',  change: '+6.2%',  volume: '$521K',  liquidity: '$3.2M',   up: true,  color: '#fb923c' },
  { rank: 6, chain: 'Arbitrum', sym: 'ARB',     name: 'Arbitrum',    price: '$0.8840',  change: '-2.4%',  volume: '$3.8M',  liquidity: '$67.2M',  up: false, color: '#64748b' },
  { rank: 7, chain: 'Base',     sym: 'HIGHER',  name: 'Higher',      price: '$0.0031',  change: '+4.3%',  volume: '$340K',  liquidity: '$1.8M',   up: true,  color: '#a78bfa' },
  { rank: 8, chain: 'Ethereum', sym: 'UNI',     name: 'Uniswap',     price: '$8.2400',  change: '-1.1%',  volume: '$18.4M', liquidity: '$124M',   up: false, color: '#ff007a' },
]

const CHAIN_COLORS: Record<string, string> = {
  Base:     '#2DD4BF',
  Ethereum: '#627EEA',
  Solana:   '#9945FF',
  Arbitrum: '#12AAFF',
}

const CHAINS: ChainFilter[] = ['All Chains', 'Ethereum', 'Solana', 'Arbitrum', 'Base']
const TIMES:  TimeFilter[]  = ['1H', '24H', '7D', '30D']

const CHIPS = [
  { label: 'Scan Whale Wallet',  rgba: '236,72,153',  text: '#f472b6' },
  { label: 'Smart Money Flow',   rgba: '45,212,191',  text: '#4de8d8' },
  { label: 'Trending on Base',   rgba: '45,212,191',  text: '#4de8d8' },
  { label: 'Early Pump Signals', rgba: '236,72,153',  text: '#f472b6' },
  { label: 'Meme Rotation',      rgba: '139,92,246',  text: '#b89dfc' },
  { label: 'Whale Alerts',       rgba: '236,72,153',  text: '#f472b6' },
]

// ─── Main component ───────────────────────────────────────────────────────

interface Props {
  active: string | null
}

export default function ClarkChat({ active }: Props) {
  const [query,    setQuery]    = useState('')
  const [chain,    setChain]    = useState<ChainFilter>('All Chains')
  const [time,     setTime]     = useState<TimeFilter>('24H')
  const [response,  setResponse]  = useState<string | null>(null)
  const [busy,      setBusy]      = useState(false)
  const [fastMode,  setFastMode]  = useState(false)
  const [tradeMode, setTradeMode] = useState(false)

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

  const filtered = chain === 'All Chains' ? TOKENS : TOKENS.filter(t => t.chain === chain)

  return (
    <div className="w-full flex flex-col" style={{ padding: '28px', gap: '24px' }}>

      {/* ─── Clark AI Command Box ──────────────── */}
      <div className="relative">

        {/* Behind-card ambient glow */}
        <div
          className="absolute pointer-events-none"
          style={{
            inset: '-48px',
            borderRadius: '48px',
            background: 'radial-gradient(ellipse at 20% 50%, rgba(45,212,191,0.09) 0%, transparent 55%), radial-gradient(ellipse at 80% 50%, rgba(139,92,246,0.09) 0%, transparent 55%)',
            filter: 'blur(28px)',
          }}
        />

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.42, ease: 'easeOut' }}
          className="relative rounded-2xl overflow-hidden"
          style={{
            background: 'linear-gradient(160deg, #0c1828 0%, #080e1c 55%, #060b16 100%)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 32px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07)',
          }}
        >
          {/* Top edge gradient line */}
          <div
            className="absolute inset-x-0 top-0 pointer-events-none"
            style={{
              height: '1.5px',
              background: 'linear-gradient(90deg, transparent 0%, #2DD4BF 35%, #8B5CF6 65%, transparent 100%)',
            }}
          />

          <div className="px-8 pt-8 pb-7">

            {/* ── Header ── */}
            <div className="flex items-start justify-between mb-7">
              <div>
                {/* Live indicator */}
                <div className="flex items-center gap-2 mb-2.5">
                  <div
                    className="w-2 h-2 rounded-full bg-[#2DD4BF] animate-pulse"
                    style={{ boxShadow: '0 0 8px rgba(45,212,191,0.9)' }}
                  />
                  <span style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    letterSpacing: '0.14em',
                    color: '#2DD4BF',
                    fontFamily: 'var(--font-plex-mono)',
                  }}>
                    LIVE
                  </span>
                </div>
                <h1 style={{
                  fontSize: '30px',
                  fontWeight: 800,
                  color: '#f8fafc',
                  fontFamily: 'var(--font-inter)',
                  letterSpacing: '-0.03em',
                  lineHeight: 1.1,
                }}>
                  Clark AI
                </h1>
                <p style={{
                  fontSize: '12px',
                  color: '#3e5c78',
                  fontFamily: 'var(--font-plex-mono)',
                  marginTop: '5px',
                }}>
                  Powered by CORTEX Engine
                </p>
              </div>

              {/* CORTEX badge */}
              <div style={{
                background: 'rgba(139,92,246,0.1)',
                border: '1px solid rgba(139,92,246,0.22)',
                borderRadius: '8px',
                padding: '5px 12px',
                fontSize: '10px',
                fontWeight: 700,
                color: '#a78bfa',
                fontFamily: 'var(--font-plex-mono)',
                letterSpacing: '0.1em',
              }}>
                CORTEX v2
              </div>
            </div>

            {/* ── Main input ── */}
            <div className="relative mb-5">
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAsk() }}
                placeholder="Ask Clark what whales are buying..."
                disabled={busy}
                className="w-full outline-none disabled:opacity-50"
                style={{
                  padding: '18px 72px 18px 22px',
                  fontSize: '15px',
                  background: 'rgba(3,6,18,0.92)',
                  border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: '14px',
                  color: '#f1f5f9',
                  fontFamily: 'var(--font-inter)',
                  boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.4)',
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onFocus={e => {
                  e.currentTarget.style.borderColor = 'rgba(45,212,191,0.5)'
                  e.currentTarget.style.boxShadow   = 'inset 0 2px 8px rgba(0,0,0,0.4), 0 0 0 3px rgba(45,212,191,0.08)'
                }}
                onBlur={e => {
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'
                  e.currentTarget.style.boxShadow   = 'inset 0 2px 8px rgba(0,0,0,0.4)'
                }}
              />
              {/* Arrow send button */}
              <motion.button
                onClick={handleAsk}
                disabled={!query.trim() || busy}
                className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center disabled:opacity-30"
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '11px',
                  background: 'linear-gradient(135deg, #2DD4BF 0%, #0ea5e9 100%)',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 0 20px rgba(45,212,191,0.4)',
                  color: '#031412',
                  flexShrink: 0,
                }}
                whileHover={{ scale: 1.06, boxShadow: '0 0 32px rgba(45,212,191,0.65)' } as never}
                whileTap={{ scale: 0.95 } as never}
                transition={{ duration: 0.12 }}
              >
                {busy ? (
                  <div
                    className="rounded-full border-2 border-t-transparent animate-spin"
                    style={{ width: '16px', height: '16px', borderColor: '#031412', borderTopColor: 'transparent' }}
                  />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="13 6 19 12 13 18"/>
                  </svg>
                )}
              </motion.button>
            </div>

            {/* ── Clark response bubble ── */}
            {(busy || response) && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="flex gap-3 items-start p-4 rounded-xl mb-5"
                style={{
                  background: 'rgba(139,92,246,0.07)',
                  border: '1px solid rgba(139,92,246,0.18)',
                }}
              >
                <div
                  className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
                  style={{ background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(167,139,250,0.3)' }}
                >
                  <span className="text-[10px] font-bold text-[#a78bfa]" style={{ fontFamily: 'var(--font-plex-mono)' }}>C</span>
                </div>
                <div className="flex-1 pt-0.5">
                  {busy ? (
                    <div className="flex items-center gap-2 py-1">
                      {[0, 0.15, 0.3].map((delay, i) => (
                        <div
                          key={i}
                          className="w-1.5 h-1.5 rounded-full animate-pulse"
                          style={{ background: 'rgba(139,92,246,0.7)', animationDelay: `${delay}s` }}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-[13px] leading-relaxed" style={{ color: '#94a3b8', fontFamily: 'var(--font-inter)' }}>
                      {response}
                    </p>
                  )}
                </div>
              </motion.div>
            )}

            {/* ── Quick action chips — 3×2 pill grid ── */}
            <div className="grid grid-cols-3 gap-2 mb-6">
              {CHIPS.map((chip, i) => (
                <motion.button
                  key={chip.label}
                  onClick={() => setQuery(chip.label)}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: i * 0.04 }}
                  className="px-4 py-2.5 text-left truncate"
                  style={{
                    borderRadius: '100px',
                    background: `rgba(${chip.rgba}, 0.07)`,
                    border: `1px solid rgba(${chip.rgba}, 0.16)`,
                    color: chip.text,
                    fontSize: '12px',
                    fontWeight: 500,
                    fontFamily: 'var(--font-inter)',
                    cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  }}
                  whileHover={{ scale: 1.02 } as never}
                  onMouseEnter={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.background   = `rgba(${chip.rgba}, 0.15)`
                    el.style.borderColor  = `rgba(${chip.rgba}, 0.32)`
                    el.style.boxShadow    = `0 0 18px rgba(${chip.rgba}, 0.14)`
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget as HTMLButtonElement
                    el.style.background   = `rgba(${chip.rgba}, 0.07)`
                    el.style.borderColor  = `rgba(${chip.rgba}, 0.16)`
                    el.style.boxShadow    = 'none'
                  }}
                >
                  {chip.label}
                </motion.button>
              ))}
            </div>

            {/* ── Bottom utility bar ── */}
            <div
              className="flex items-center justify-between pt-4"
              style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}
            >
              {/* Mode toggles */}
              <div className="flex items-center gap-2">
                {([
                  { key: 'fast',  label: 'Fast Mode',  active: fastMode,  set: () => setFastMode(v  => !v)  },
                  { key: 'trade', label: 'Trade Mode', active: tradeMode, set: () => setTradeMode(v => !v) },
                ] as const).map(m => (
                  <motion.button
                    key={m.key}
                    onClick={m.set}
                    className="flex items-center gap-1.5 px-3 py-1.5"
                    style={{
                      borderRadius: '100px',
                      background: m.active ? 'rgba(45,212,191,0.12)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${m.active ? 'rgba(45,212,191,0.28)' : 'rgba(255,255,255,0.08)'}`,
                      cursor: 'pointer',
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                    whileHover={{ scale: 1.03 } as never}
                    transition={{ duration: 0.1 }}
                  >
                    <div style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: m.active ? '#2DD4BF' : 'rgba(255,255,255,0.18)',
                      boxShadow: m.active ? '0 0 6px rgba(45,212,191,0.8)' : 'none',
                      transition: 'all 0.15s',
                    }}/>
                    <span style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      color: m.active ? '#2DD4BF' : '#4a6380',
                      fontFamily: 'var(--font-inter)',
                      transition: 'color 0.15s',
                    }}>
                      {m.label}
                    </span>
                  </motion.button>
                ))}
              </div>

              {/* Query counter */}
              <div className="flex items-center gap-0.5" style={{ fontFamily: 'var(--font-plex-mono)' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#6a8da8' }}>7</span>
                <span style={{ fontSize: '13px', color: '#2e4a62' }}>/20</span>
                <span style={{ fontSize: '11px', color: '#243848', marginLeft: '3px' }}>queries</span>
              </div>
            </div>

          </div>
        </motion.div>
      </div>

      {/* ─── Token Screener ────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, delay: 0.1, ease: 'easeOut' }}
      >

        {/* Section header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2
              className="tracking-tight"
              style={{
                fontSize: '18px',
                fontWeight: 800,
                color: '#f1f5f9',
                fontFamily: 'var(--font-inter)',
              }}
            >
              Token Screener
            </h2>
            {/* LIVE badge */}
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(45,212,191,0.1)', border: '1px solid rgba(45,212,191,0.2)' }}
            >
              <div
                className="w-1 h-1 rounded-full bg-[#2DD4BF]"
                style={{ boxShadow: '0 0 4px rgba(45,212,191,1)' }}
              />
              <span
                className="text-[9px] font-bold text-[#2DD4BF] tracking-wider"
                style={{ fontFamily: 'var(--font-plex-mono)' }}
              >
                LIVE
              </span>
            </div>
          </div>

          {/* Time filter — pill-style */}
          <div
            className="flex gap-0.5 p-1 rounded-lg shrink-0"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            {TIMES.map(t => (
              <button
                key={t}
                onClick={() => setTime(t)}
                className="px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all"
                style={
                  time === t
                    ? { background: 'rgba(45,212,191,0.14)', color: '#2DD4BF', border: '1px solid rgba(45,212,191,0.24)' }
                    : { color: '#5a7290', border: '1px solid transparent' }
                }
                onMouseEnter={e => {
                  if (time !== t) (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'
                }}
                onMouseLeave={e => {
                  if (time !== t) (e.currentTarget as HTMLButtonElement).style.color = '#475569'
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Chain filter pills */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {CHAINS.map(c => (
            <button
              key={c}
              onClick={() => setChain(c)}
              className="px-3.5 py-1.5 rounded-lg text-[12px] font-medium transition-all"
              style={
                chain === c
                  ? { background: 'rgba(45,212,191,0.12)', color: '#2DD4BF',  border: '1px solid rgba(45,212,191,0.25)' }
                  : { background: 'rgba(255,255,255,0.04)', color: '#5a7290', border: '1px solid rgba(255,255,255,0.07)' }
              }
              onMouseEnter={e => {
                if (chain !== c) {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.color = '#94a3b8'
                  el.style.borderColor = 'rgba(255,255,255,0.13)'
                }
              }}
              onMouseLeave={e => {
                if (chain !== c) {
                  const el = e.currentTarget as HTMLButtonElement
                  el.style.color = '#475569'
                  el.style.borderColor = 'rgba(255,255,255,0.07)'
                }
              }}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Table container */}
        <div
          className="rounded-2xl overflow-hidden"
          style={{ background: '#070d1a', border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 8px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}
        >

          {/* Column headers */}
          <div
            className="grid items-center px-5 py-3"
            style={{
              gridTemplateColumns: '40px 1fr 88px 110px 100px 100px 100px',
              background: 'rgba(255,255,255,0.032)',
              borderBottom: '1px solid rgba(255,255,255,0.09)',
            }}
          >
            {['#', 'Token', 'Chain', 'Price', '24H Change', 'Volume', 'Liquidity'].map((h, i) => (
              <div
                key={h}
                className={`uppercase ${i === 0 ? 'text-center' : i === 1 ? 'text-left' : 'text-right'}`}
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                  color: '#3d5e7a',
                  fontFamily: 'var(--font-plex-mono)',
                }}
              >
                {h}
              </div>
            ))}
          </div>

          {/* Rows */}
          {filtered.map((token, i) => (
            <motion.div
              key={token.sym}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.28, delay: i * 0.04 }}
              className="relative group grid items-center px-5 cursor-pointer"
              style={{
                gridTemplateColumns: '40px 1fr 88px 110px 100px 100px 100px',
                paddingTop: '19px',
                paddingBottom: '19px',
                borderBottom: i < filtered.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              {/* Left accent bar — opacity 0 → 1 on group hover */}
              <div
                className="absolute inset-y-0 left-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-r-full"
                style={{ width: '3px', background: token.color }}
              />

              {/* Rank */}
              <div
                className="text-center"
                style={{ fontSize: '12px', fontFamily: 'var(--font-plex-mono)', color: '#3e5c78' }}
              >
                {token.rank}
              </div>

              {/* Token identity */}
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Token avatar — 32px circle */}
                <div
                  className="flex items-center justify-center shrink-0 text-[10px] font-bold"
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: `${token.color}18`,
                    color: token.color,
                    border: `1px solid ${token.color}30`,
                    fontFamily: 'var(--font-plex-mono)',
                  }}
                >
                  {token.sym.slice(0, 2)}
                </div>
                <div className="min-w-0">
                  <p
                    className="leading-tight"
                    style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0', fontFamily: 'var(--font-inter)' }}
                  >
                    {token.name}
                  </p>
                  <p
                    className="mt-0.5"
                    style={{ fontSize: '10px', fontFamily: 'var(--font-plex-mono)', color: '#3e5c78' }}
                  >
                    {token.sym}
                  </p>
                </div>
              </div>

              {/* Chain badge — colored text on tinted bg, monospace pill */}
              <div className="flex justify-end">
                <span
                  className="font-semibold px-2 py-0.5 rounded-md"
                  style={{
                    fontSize: '10px',
                    fontFamily: 'var(--font-plex-mono)',
                    color:      CHAIN_COLORS[token.chain] ?? '#64748b',
                    background: `${CHAIN_COLORS[token.chain] ?? '#64748b'}14`,
                    border:     `1px solid ${CHAIN_COLORS[token.chain] ?? '#64748b'}28`,
                  }}
                >
                  {token.chain}
                </span>
              </div>

              {/* Price */}
              <div
                className="text-right font-medium"
                style={{ fontSize: '13px', fontFamily: 'var(--font-plex-mono)', color: '#e2e8f0' }}
              >
                {token.price}
              </div>

              {/* 24H Change */}
              <div
                className="text-right font-bold"
                style={{
                  fontSize: '13px',
                  fontFamily: 'var(--font-plex-mono)',
                  color: token.up ? '#2DD4BF' : '#fb7185',
                }}
              >
                {token.change}
              </div>

              {/* Volume */}
              <div
                className="text-right"
                style={{ fontSize: '12px', fontFamily: 'var(--font-plex-mono)', color: '#5a7290' }}
              >
                {token.volume}
              </div>

              {/* Liquidity */}
              <div
                className="text-right"
                style={{ fontSize: '12px', fontFamily: 'var(--font-plex-mono)', color: '#3d5268' }}
              >
                {token.liquidity}
              </div>

            </motion.div>
          ))}

        </div>
      </motion.div>

    </div>
  )
}
