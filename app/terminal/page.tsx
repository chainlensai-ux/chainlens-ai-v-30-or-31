'use client'

import { useState } from 'react'
import FeatureBar from '@/components/FeatureBar'
import ClarkChat from '@/components/ClarkChat'
import ClarkRadar from '@/components/ClarkRadar'

export default function TerminalPage() {
  const [active, setActive] = useState<string | null>('home')

  return (
    <div
      className="flex h-screen text-white overflow-hidden"
      style={{ background: '#05060a' }}
    >
      <FeatureBar active={active} onSelect={setActive} />

      {/* Content column */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden p-4 gap-4">

        {/* Topbar */}
        <header
          className="h-16 shrink-0 flex items-center justify-between px-6 rounded-2xl"
          style={{ background: '#0b1120', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Left — breadcrumb */}
          <div className="flex items-center gap-2">
            <span
              className="text-[13px] font-semibold"
              style={{ color: '#475569' }}
            >
              ChainLens
            </span>
            <span style={{ color: '#1e293b', fontSize: '14px' }}>/</span>
            <span
              className="text-[13px] font-semibold"
              style={{ color: '#94a3b8' }}
            >
              Terminal
            </span>
          </div>

          {/* Right — live + account */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div
                className="w-[7px] h-[7px] rounded-full bg-[#2DD4BF]"
                style={{ boxShadow: '0 0 8px rgba(45,212,191,0.9)' }}
              />
              <span
                className="text-[11px] font-semibold tracking-widest"
                style={{ color: '#2DD4BF', fontFamily: 'var(--font-plex-mono)' }}
              >
                LIVE
              </span>
            </div>

            <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.08)' }} />

            <button
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all hover:bg-white/[0.05]"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, rgba(139,92,246,0.35), rgba(45,212,191,0.25))',
                  border: '1px solid rgba(139,92,246,0.35)',
                }}
              >
                <span className="text-[10px] font-bold text-[#c4b5fd]">U</span>
              </div>
              <span className="text-[13px] font-medium" style={{ color: '#94a3b8' }}>
                Account
              </span>
            </button>
          </div>
        </header>

        {/* Main panels */}
        <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
          <ClarkChat active={active} toolLabel={active ?? 'Terminal'} />
          <ClarkRadar onSelectRadar={setActive} />
        </div>

      </div>
    </div>
  )
}
