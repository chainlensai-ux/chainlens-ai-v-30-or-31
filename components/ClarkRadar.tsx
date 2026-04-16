'use client'

import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

// ─── Mock data ────────────────────────────────────────────────────────────

const LIVE_SIGNALS = [
  { pair: 'BRETT/WETH',  chain: 'Base', change: '+18.4%', signal: 'BUY',   up: true  },
  { pair: 'TOSHI/WETH',  chain: 'Base', change: '+6.2%',  signal: 'WATCH', up: true  },
  { pair: 'VIRTUAL/ETH', chain: 'Base', change: '-3.1%',  signal: 'SELL',  up: false },
]

const WHALE_ACTIVITY = [
  { addr: '0x7a25...88D',  action: 'Bought 2.4 ETH of BRETT', time: '2m'  },
  { addr: '0xd8dA...6045', action: 'Sold 50K TOSHI',          time: '7m'  },
  { addr: '0xAb5C...4Fe2', action: 'Added $120K LP on Base',  time: '14m' },
  { addr: '0x1f98...4B5a', action: 'Bridged 18 ETH to Base',  time: '21m' },
]

const TOKEN_MOMENTUM = [
  { sym: 'BRETT',  pct: '+18.4%', up: true,  bar: 74 },
  { sym: 'AERO',   pct: '+9.1%',  up: true,  bar: 36 },
  { sym: 'HIGHER', pct: '+4.3%',  up: true,  bar: 17 },
  { sym: 'DEGEN',  pct: '-4.2%',  up: false, bar: 17 },
]

const AI_NOTES = [
  { text: 'Smart money rotating into Base meme layer — watch the BRETT cluster.', tag: 'ALPHA' },
  { text: 'Unusual LP removal on VIRTUAL/WETH. Rug risk elevated.',               tag: 'RISK'  },
  { text: 'BTC dominance rising. Alt momentum may stall in 24–48h.',             tag: 'MACRO' },
]

const SIG_STYLE: Record<string, string> = {
  BUY:   'text-[#2DD4BF] bg-[#2DD4BF]/[0.1]  border-[#2DD4BF]/[0.2]',
  WATCH: 'text-amber-400 bg-amber-400/[0.1]   border-amber-400/[0.2]',
  SELL:  'text-rose-400  bg-rose-400/[0.1]    border-rose-400/[0.2]',
}

const NOTE_TAG: Record<string, string> = {
  ALPHA: 'text-[#2DD4BF] bg-[#2DD4BF]/[0.08] border-[#2DD4BF]/[0.2]',
  RISK:  'text-rose-400  bg-rose-400/[0.08]   border-rose-400/[0.2]',
  MACRO: 'text-amber-400 bg-amber-400/[0.08]  border-amber-400/[0.2]',
}

// ─── Card ─────────────────────────────────────────────────────────────────

function Card({
  title,
  accent,
  children,
  delay = 0,
}: {
  title: string
  accent?: string
  children: ReactNode
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
      className="rounded-2xl overflow-hidden"
      style={{ background: '#080e1a', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(255,255,255,0.025)',
        }}
      >
        <span
          className="text-[10px] font-bold uppercase tracking-[0.15em]"
          style={{ color: '#64748b' }}
        >
          {title}
        </span>
        {accent && (
          <span
            className="text-[9px] font-bold tracking-wider"
            style={{ fontFamily: 'var(--font-plex-mono)', color: '#2DD4BF' }}
          >
            {accent}
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </motion.div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────

export default function ClarkRadar({ onSelectRadar }: { onSelectRadar: (val: string) => void }) {
  return (
    <aside
      className="w-[320px] shrink-0 flex flex-col rounded-2xl overflow-hidden"
      style={{ background: '#0b1120', border: '1px solid rgba(255,255,255,0.07)' }}
    >

      {/* Panel header */}
      <div
        className="shrink-0 flex items-center justify-between px-5 h-14"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
      >
        <span
          className="text-[14px] font-bold tracking-tight"
          style={{ color: '#f1f5f9' }}
        >
          Radar
        </span>
        <div className="flex items-center gap-2">
          <div
            className="w-[7px] h-[7px] rounded-full bg-[#2DD4BF]"
            style={{ boxShadow: '0 0 8px rgba(45,212,191,0.9)' }}
          />
          <span
            className="text-[10px] font-bold text-[#2DD4BF] tracking-widest"
            style={{ fontFamily: 'var(--font-plex-mono)' }}
          >
            LIVE
          </span>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">

        {/* ── Clark AI Profile Card ────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="rounded-2xl p-4 relative overflow-hidden"
          style={{ background: '#080e1a', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Background glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse at 80% 20%, rgba(139,92,246,0.12) 0%, transparent 60%)',
            }}
          />
          <div className="relative">
            <div className="flex items-center gap-3.5 mb-3.5">
              {/* Avatar */}
              <div
                className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                style={{
                  background: 'linear-gradient(135deg, rgba(45,212,191,0.25), rgba(139,92,246,0.25))',
                  border: '1px solid rgba(45,212,191,0.25)',
                  boxShadow: '0 0 20px rgba(45,212,191,0.15)',
                }}
              >
                <span
                  className="text-[20px] font-black"
                  style={{
                    background: 'linear-gradient(135deg, #2DD4BF, #8B5CF6)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                  }}
                >
                  C
                </span>
              </div>
              <div>
                <p
                  className="text-[14px] font-bold"
                  style={{ color: '#f1f5f9' }}
                >
                  Clark AI
                </p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div
                    className="w-[6px] h-[6px] rounded-full bg-emerald-400"
                    style={{ boxShadow: '0 0 6px rgba(52,211,153,0.9)' }}
                  />
                  <span className="text-[11px]" style={{ color: '#64748b' }}>Online</span>
                </div>
              </div>
            </div>
            <p
              className="text-[12px] leading-relaxed"
              style={{ color: '#64748b' }}
            >
              CORTEX-powered intelligence for Base chain. Tracking 2.4M wallets in real time.
            </p>
            <div
              className="mt-3.5 flex items-center gap-3 pt-3"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div>
                <p
                  className="text-[13px] font-bold"
                  style={{ color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}
                >
                  2.4M
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: '#475569' }}>Wallets</p>
              </div>
              <div
                className="w-px h-6"
                style={{ background: 'rgba(255,255,255,0.07)' }}
              />
              <div>
                <p
                  className="text-[13px] font-bold"
                  style={{ color: '#f1f5f9', fontFamily: 'var(--font-plex-mono)' }}
                >
                  99.8%
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: '#475569' }}>Uptime</p>
              </div>
              <div
                className="w-px h-6"
                style={{ background: 'rgba(255,255,255,0.07)' }}
              />
              <div>
                <p
                  className="text-[13px] font-bold"
                  style={{ color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}
                >
                  LIVE
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: '#475569' }}>Status</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ── Live Signals ──────────────────────────────────── */}
        <Card title="Live Signals" accent="BASE" delay={0.05}>
          <div className="space-y-2">
            {LIVE_SIGNALS.map((s, i) => (
              <button
                key={i}
                onClick={() => onSelectRadar(s.pair.split('/')[0].toLowerCase())}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all hover:bg-white/[0.04]"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.07)'
                }}
              >
                <div
                  className="shrink-0 w-[3px] h-8 rounded-full"
                  style={{ background: s.up ? 'rgba(45,212,191,0.75)' : 'rgba(251,113,133,0.75)' }}
                />
                <div className="flex-1 min-w-0 text-left">
                  <div
                    className="text-[12px] font-semibold truncate leading-tight"
                    style={{ color: '#e2e8f0', fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {s.pair}
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: '#475569' }}>{s.chain}</div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <span
                    className="text-[12px] font-bold"
                    style={{ fontFamily: 'var(--font-plex-mono)', color: s.up ? '#2DD4BF' : '#fb7185' }}
                  >
                    {s.change}
                  </span>
                  <span
                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${SIG_STYLE[s.signal]}`}
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {s.signal}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* ── Whale Activity ────────────────────────────────── */}
        <Card title="Whale Activity" delay={0.1}>
          <div className="space-y-3">
            {WHALE_ACTIVITY.map((w, i) => (
              <div key={i} className="flex items-start gap-3">
                <div
                  className="shrink-0 w-[3px] rounded-full mt-1.5"
                  style={{ background: 'rgba(255,255,255,0.2)', minHeight: '30px' }}
                />
                <div className="flex-1 min-w-0">
                  <p
                    className="text-[12px] font-semibold leading-tight"
                    style={{ color: '#e2e8f0' }}
                  >
                    {w.action}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className="text-[10px] truncate"
                      style={{ fontFamily: 'var(--font-plex-mono)', color: '#4d6280' }}
                    >
                      {w.addr}
                    </span>
                    <span
                      className="text-[10px] shrink-0"
                      style={{ fontFamily: 'var(--font-plex-mono)', color: '#334155' }}
                    >
                      {w.time} ago
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* ── Token Momentum ────────────────────────────────── */}
        <Card title="Momentum" delay={0.15}>
          <div className="space-y-3.5">
            {TOKEN_MOMENTUM.map((t, i) => (
              <div key={i} className="flex items-center gap-3">
                <span
                  className="text-[11px] font-bold w-12 shrink-0"
                  style={{ fontFamily: 'var(--font-plex-mono)', color: '#94a3b8' }}
                >
                  {t.sym}
                </span>
                <div
                  className="flex-1 h-[6px] rounded-full overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                >
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${t.bar}%`,
                      background: t.up
                        ? 'linear-gradient(90deg, #2DD4BF60, #2DD4BF)'
                        : 'linear-gradient(90deg, #fb718560, #fb7185)',
                    }}
                  />
                </div>
                <span
                  className="text-[11px] font-bold w-14 text-right shrink-0"
                  style={{ fontFamily: 'var(--font-plex-mono)', color: t.up ? '#2DD4BF' : '#fb7185' }}
                >
                  {t.pct}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* ── CORTEX Notes ──────────────────────────────────── */}
        <Card title="CORTEX Notes" delay={0.2}>
          <div className="space-y-2">
            {AI_NOTES.map((note, i) => (
              <div
                key={i}
                className="flex gap-3 items-start px-3 py-3 rounded-xl"
                style={{
                  background: 'rgba(139,92,246,0.05)',
                  border: '1px solid rgba(139,92,246,0.1)',
                }}
              >
                <span
                  className={`shrink-0 text-[8px] font-bold px-1.5 py-0.5 rounded border mt-0.5 ${NOTE_TAG[note.tag]}`}
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  {note.tag}
                </span>
                <p
                  className="text-[12px] leading-relaxed"
                  style={{ color: '#7d99b5' }}
                >
                  {note.text}
                </p>
              </div>
            ))}
          </div>
          <div
            className="mt-4 flex items-center gap-2 pt-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div
              className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF]"
              style={{ boxShadow: '0 0 5px rgba(45,212,191,0.8)' }}
            />
            <span className="text-[11px]" style={{ color: '#64748b' }}>
              CORTEX monitoring live
            </span>
          </div>
        </Card>

      </div>
    </aside>
  )
}
