'use client'

import { useState } from 'react'
import FeatureBar from '@/components/FeatureBar'
import ClarkChat from '@/components/ClarkChat'
import ClarkRadar from '@/components/ClarkRadar'

export default function TerminalPage() {
  const [active, setActive] = useState('dashboard')

  return (
    <>
      <style>{`
        @keyframes terminalAmbient {
          0%, 100% { opacity: 0.55; }
          50%       { opacity: 1; }
        }
        .terminal-ambient {
          animation: terminalAmbient 5s ease-in-out infinite;
          pointer-events: none;
        }
      `}</style>

      <div
        className="flex h-screen text-white overflow-hidden"
        style={{ background: '#050816', position: 'relative' }}
      >
        {/* Neon ambient glow — fixed, behind everything */}
        <div
          className="terminal-ambient"
          style={{
            position: 'fixed',
            top: '35%',
            left: '55%',
            transform: 'translate(-50%, -50%)',
            width: '700px',
            height: '420px',
            borderRadius: '50%',
            background:
              'radial-gradient(ellipse, rgba(123,92,255,0.08) 0%, rgba(255,75,154,0.05) 45%, transparent 72%)',
            zIndex: 0,
          }}
        />

        <FeatureBar active={active} onSelect={setActive} />

        <main
          className="flex-1 overflow-y-auto min-w-0 flex flex-col"
          style={{ position: 'relative', zIndex: 1 }}
        >
          <ClarkChat active={active} />
        </main>

        <aside
          className="w-[310px] shrink-0 overflow-y-auto"
          style={{
            borderLeft: '1px solid rgba(123,92,255,0.18)',
            background: '#050816',
            position: 'relative',
            zIndex: 1,
          }}
        >
          <ClarkRadar onSelectRadar={setActive} />
        </aside>
      </div>
    </>
  )
}
