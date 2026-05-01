'use client'

import { WagmiProvider } from 'wagmi'
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig, projectId, walletConnectEnabled } from '@/lib/wallet'
import { useEffect, useRef, useState } from 'react'

const queryClient = new QueryClient()


function shouldEnableAndroidSafeMode(): { safeMode: boolean; debugMode: boolean } {
  const ua = navigator.userAgent
  const isAndroid = /Android/i.test(ua)
  const isMobile = window.innerWidth < 768
  const debugMode = new URLSearchParams(window.location.search).get('mobileSafe') === 'android'
  return { safeMode: (isAndroid && isMobile) || debugMode, debugMode }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const modalInitRef = useRef(false)
  const [androidDebugBadge, setAndroidDebugBadge] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const { safeMode, debugMode } = shouldEnableAndroidSafeMode()
    document.body.classList.toggle('android-safe-mode', safeMode)
    setAndroidDebugBadge(debugMode)

    return () => {
      document.body.classList.remove('android-safe-mode')
    }
  }, [])

  useEffect(() => {
    if (!walletConnectEnabled || typeof window === 'undefined' || modalInitRef.current) return
    modalInitRef.current = true
    try {
      createWeb3Modal({
        wagmiConfig,
        projectId,
      })
    } catch (error) {
      console.error('Web3 modal initialization failed:', error)
    }
  }, [])

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        {androidDebugBadge && (
          <div className="fixed bottom-5 right-4 z-[9999] rounded-full border border-cyan-400/40 bg-slate-950/90 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-cyan-300 pointer-events-none">
            Android safe mode
          </div>
        )}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
