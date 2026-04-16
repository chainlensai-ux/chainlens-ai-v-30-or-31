'use client'

import { useState } from 'react'
import FeatureBar from '@/components/FeatureBar'
import ClarkChat from '@/components/ClarkChat'
import ClarkRadar from '@/components/ClarkRadar'

const TOOL_LABELS: Record<string, string> = {
  'home':               'Dashboard',
  'token-scanner':      'Token Scanner',
  'wallet-scanner':     'Wallet Scanner',
  'dev-wallet':         'Dev Wallet Detector',
  'liquidity-scanner':  'Liquidity Safety',
  'whale-alerts':       'Whale Alerts',
  'pump-alerts':        'Pump Alerts',
  'base-radar':         'Base Radar',
  'clark-ai':           'Clark AI',
}

export default function TerminalPage() {
  const [active, setActive] = useState<string | null>('home')
  const toolLabel = active ? (TOOL_LABELS[active] ?? active) : 'Terminal'

  return (
    <div className="flex h-screen text-white overflow-hidden" style={{ background: '#05060b' }}>

      <FeatureBar active={active} onSelect={setActive} />

      {/* Content column — padded so panels float as cards */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden p-3 gap-3">

        {/* Topbar */}
        <header
          className="h-[52px] shrink-0 flex items-center justify-between px-5 rounded-xl"
          style={{ background: '#080c14', border: '1px solid rgba(255,255,255,0.08)' }}
        >

          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5">
            <span
              className="text-[11px]"
              style={{ fontFamily: 'var(--font-plex-mono)', color: '#475569' }}
            >
              terminal
            </span>
            <span className="text-[11px]" style={{ color: '#2a3a4a' }}>/</span>
            <span
              className="text-[11px] font-semibold"
              style={{ fontFamily: 'var(--font-plex-mono)', color: '#94a3b8' }}
            >
              {toolLabel}
            </span>
          </div>

          {/* Search */}
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 w-60 cursor-text"
            style={{ background: '#06090e', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span className="text-[12px]" style={{ color: '#2d3f52' }}>Search tokens, wallets...</span>
          </div>

          {/* Right */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div
                className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF]"
                style={{ boxShadow: '0 0 6px rgba(45,212,191,0.8)' }}
              />
              <span className="text-[11px] font-medium" style={{ color: '#475569' }}>CORTEX live</span>
            </div>
            <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.07)' }} />
            <button
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-all hover:bg-white/[0.06]"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.3)' }}
              >
                <span className="text-[9px] font-bold text-[#a78bfa]">U</span>
              </div>
              <span className="text-[12px] font-medium" style={{ color: '#64748b' }}>Account</span>
            </button>
          </div>
        </header>

        {/* Panels row — gap creates visible separation */}
        <div className="flex flex-1 gap-3 overflow-hidden min-h-0">
          <ClarkChat active={active} toolLabel={toolLabel} />
          <ClarkRadar onSelectRadar={setActive} />
        </div>

      </div>
    </div>
  )
}
