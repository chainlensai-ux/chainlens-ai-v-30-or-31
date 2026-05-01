'use client'

import { useEffect, useState } from 'react'

export default function MobileTestPage() {
  const [width, setWidth] = useState(0)
  const [safeMode, setSafeMode] = useState(false)

  useEffect(() => {
    const update = () => {
      setWidth(window.innerWidth)
      setSafeMode(document.documentElement.classList.contains('android-safe-mode') || document.body.classList.contains('android-safe-mode'))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return (
    <main className="min-h-dvh w-full max-w-full overflow-x-hidden bg-slate-950 px-4 py-8 text-white">
      <div className="mx-auto w-full max-w-xl space-y-4">
        <h1 className="text-2xl font-bold">ChainLens</h1>
        <p className="text-slate-300">Mobile test page</p>
        <div className="rounded-2xl border border-white/10 bg-slate-900 p-4">
          <p className="text-sm text-slate-300">Viewport width: <span className="text-white">{width}px</span></p>
          <p className="text-sm text-slate-300">Android safe mode: <span className="text-white">{safeMode ? 'active' : 'inactive'}</span></p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-slate-900 p-4 text-slate-300">Static diagnostic card 1</div>
        <div className="rounded-2xl border border-white/10 bg-slate-900 p-4 text-slate-300">Static diagnostic card 2</div>
      </div>
    </main>
  )
}
