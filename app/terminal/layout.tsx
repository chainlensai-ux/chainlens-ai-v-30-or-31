'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import FeatureBar from '@/components/FeatureBar'

const PATH_TO_KEY: Record<string, string> = {
  '/terminal':                  'dashboard',
  '/terminal/portfolio':        'portfolio',
  '/terminal/token-scanner':    'token-scanner',
  '/terminal/wallet-scanner':   'wallet-scanner',
  '/terminal/dev-wallet':       'dev-wallet-detector',
  '/terminal/liquidity':        'liquidity-safety',
  '/terminal/whale-alerts':     'whale-alerts',
  '/terminal/pump-alerts':      'pump-alerts',
  '/terminal/base-radar':       'base-radar',
  '/terminal/clark-ai':         'clark-ai',
  '/terminal/settings':         'settings',
}

export default function TerminalLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const active = PATH_TO_KEY[pathname] ?? 'dashboard'
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    setSidebarOpen(false)
    document.body.style.overflow = ''
  }, [pathname])

  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [sidebarOpen])

  return (
    <div
      className={`flex min-h-dvh overflow-hidden text-white${sidebarOpen ? ' mob-sidebar-open' : ''}`}
      style={{ background: '#050816' }}
    >
      {/* Mobile backdrop — closes sidebar on tap */}
      {sidebarOpen && (
        <div
          className="mob-sidebar-overlay"
          style={{ zIndex: 30 }}
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <FeatureBar active={active} onWalletOpen={() => setSidebarOpen(false)} />

      <div className="flex-1 min-w-0 overflow-hidden relative">
        {/* Mobile sidebar toggle button */}
        <button
          className="mob-sidebar-btn"
          style={{ zIndex: 35 }}
          onClick={() => setSidebarOpen(o => !o)}
          aria-label="Toggle sidebar"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6"  x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        {children}
      </div>
    </div>
  )
}
