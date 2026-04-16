'use client'

import type { ReactNode } from 'react'

const LIVE_SIGNALS = [
  { pair: 'BRETT/WETH',  chain: 'Base', change: '+18.4%', signal: 'BUY',   up: true  },
  { pair: 'TOSHI/WETH',  chain: 'Base', change: '+6.2%',  signal: 'WATCH', up: true  },
  { pair: 'VIRTUAL/ETH', chain: 'Base', change: '-3.1%',  signal: 'SELL',  up: false },
]

const WALLET_ACTIVITY = [
  { addr: '0x7a25...88D',  action: 'Bought 2.4 ETH of BRETT', time: '2m ago'  },
  { addr: '0xd8dA...6045', action: 'Sold 50K TOSHI',          time: '7m ago'  },
  { addr: '0xAb5C...4Fe2', action: 'Added $120K LP on Base',  time: '14m ago' },
  { addr: '0x1f98...4B5a', action: 'Bridged 18 ETH to Base',  time: '21m ago' },
]

const TOKEN_MOMENTUM = [
  { sym: 'BRETT',  pct: '+18.4%', vol: '$2.1M', up: true,  bar: 74 },
  { sym: 'AERO',   pct: '+9.1%',  vol: '$890K', up: true,  bar: 36 },
  { sym: 'HIGHER', pct: '+4.3%',  vol: '$340K', up: true,  bar: 17 },
  { sym: 'DEGEN',  pct: '-4.2%',  vol: '$440K', up: false, bar: 17 },
]

const AI_NOTES = [
  'Smart money rotating into Base meme layer — watch the BRETT cluster.',
  'Unusual LP removal on VIRTUAL/WETH. Rug risk elevated.',
  'BTC dominance rising. Alt momentum may stall in 24–48h.',
]

const SIGNAL_BADGE: Record<string, string> = {
  BUY:   'text-[#2DD4BF] bg-[#2DD4BF]/[0.1]  border-[#2DD4BF]/[0.2]',
  WATCH: 'text-amber-400 bg-amber-400/[0.1]   border-amber-400/[0.2]',
  SELL:  'text-rose-400  bg-rose-400/[0.1]    border-rose-400/[0.2]',
}

// Card wrapper for each section
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-[#06060a] rounded-xl border border-white/[0.07] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.015]">
        <span className="text-[10px] font-bold text-[#64748b] uppercase tracking-[0.12em]">
          {title}
        </span>
      </div>
      <div className="p-3.5">
        {children}
      </div>
    </div>
  )
}

export default function ClarkRadar({ onSelectRadar }: { onSelectRadar: (val: string) => void }) {
  return (
    <aside className="w-[280px] shrink-0 flex flex-col bg-[#080c14] rounded-xl border border-white/[0.08] overflow-hidden">

      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-5 h-12 border-b border-white/[0.07]">
        <span className="text-[13px] font-semibold text-[#94a3b8]">Radar</span>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF]" style={{ boxShadow: '0 0 6px rgba(45,212,191,0.7)' }} />
          <span className="text-[11px] text-[#475569] font-medium tracking-wide">LIVE</span>
        </div>
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto px-3 py-3.5 space-y-3">

        {/* Live Signal */}
        <Card title="Live Signal">
          <div className="space-y-1.5">
            {LIVE_SIGNALS.map((s, i) => (
              <button
                key={i}
                onClick={() => onSelectRadar(s.pair.split('/')[0].toLowerCase())}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] transition-colors"
              >
                <div className="flex-1 min-w-0 text-left">
                  <div
                    className="text-[12px] font-semibold text-[#94a3b8] truncate"
                    style={{ fontFamily: 'var(--font-plex-mono)' }}
                  >
                    {s.pair}
                  </div>
                  <div className="text-[10px] text-[#475569] mt-0.5">{s.chain}</div>
                </div>
                <span
                  className={`text-[11px] font-bold shrink-0 ${s.up ? 'text-[#2DD4BF]' : 'text-rose-400'}`}
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  {s.change}
                </span>
                <span
                  className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md border shrink-0 ${SIGNAL_BADGE[s.signal]}`}
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  {s.signal}
                </span>
              </button>
            ))}
          </div>
        </Card>

        {/* Wallet Activity */}
        <Card title="Wallet Activity">
          <div className="space-y-3">
            {WALLET_ACTIVITY.map((w, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-[#475569] mt-1.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-[11px] font-medium text-[#64748b] truncate"
                      style={{ fontFamily: 'var(--font-plex-mono)' }}
                    >
                      {w.addr}
                    </span>
                    <span
                      className="text-[10px] text-[#475569] shrink-0"
                      style={{ fontFamily: 'var(--font-plex-mono)' }}
                    >
                      {w.time}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#475569] mt-0.5 leading-snug truncate">
                    {w.action}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Token Momentum */}
        <Card title="Token Momentum">
          <div className="space-y-2.5">
            {TOKEN_MOMENTUM.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <span
                  className="text-[11px] font-bold text-[#64748b] w-[46px] shrink-0"
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  {t.sym}
                </span>
                <div className="flex-1 h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full ${t.up ? 'bg-[#2DD4BF]/50' : 'bg-rose-400/50'}`}
                    style={{ width: `${t.bar}%` }}
                  />
                </div>
                <span
                  className={`text-[10px] font-bold w-[40px] text-right shrink-0 ${t.up ? 'text-[#2DD4BF]' : 'text-rose-400'}`}
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  {t.pct}
                </span>
                <span
                  className="text-[10px] text-[#475569] w-[34px] text-right shrink-0"
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  {t.vol}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* AI Notes */}
        <Card title="AI Notes">
          <div className="space-y-2">
            {AI_NOTES.map((note, i) => (
              <div key={i} className="flex gap-2.5 items-start px-3 py-2.5 rounded-lg bg-[#8b5cf6]/[0.05] border border-[#8b5cf6]/[0.1]">
                <span
                  className="shrink-0 text-[9px] font-bold text-[#8b5cf6] mt-0.5"
                  style={{ fontFamily: 'var(--font-plex-mono)' }}
                >
                  AI
                </span>
                <p className="text-[11px] text-[#64748b] leading-snug">{note}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 px-1">
            <div className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF]" />
            <span className="text-[11px] text-[#475569]">CORTEX monitoring live</span>
          </div>
        </Card>

      </div>
    </aside>
  )
}
