'use client'

import { usePathname } from 'next/navigation'
import FeatureBar from '@/components/FeatureBar'

const PATH_TO_KEY: Record<string, string> = {
  '/terminal':                  'dashboard',
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

  return (
    <div
      className="flex h-screen overflow-hidden text-white"
      style={{ background: '#050816' }}
    >
      <FeatureBar active={active} />
      <div className="flex-1 min-w-0 overflow-hidden relative">
        {children}
      </div>
    </div>
  )
}
