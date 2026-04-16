'use client'

import { useState } from 'react'
import FeatureBar from '@/components/FeatureBar'
import ClarkChat from '@/components/ClarkChat'
import ClarkRadar from '@/components/ClarkRadar'

export default function TerminalPage() {
  const [active, setActive] = useState('dashboard')

  return (
    <div
      className="flex h-screen text-white overflow-hidden"
      style={{ background: '#0f1117' }}
    >
      <FeatureBar active={active} onSelect={setActive} />

      <main className="flex-1 overflow-y-auto min-w-0">
        <ClarkChat active={active} />
      </main>

      <aside
        className="w-[310px] shrink-0 overflow-y-auto"
        style={{ borderLeft: '1px solid rgba(255,255,255,0.07)', background: '#0f1117' }}
      >
        <ClarkRadar onSelectRadar={setActive} />
      </aside>
    </div>
  )
}
