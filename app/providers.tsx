'use client'

import { WagmiProvider, type State } from 'wagmi'
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig, projectId, walletConnectEnabled } from '@/lib/wallet'
import { useEffect, useState } from 'react'

const queryClient = new QueryClient()

let web3ModalInitialized = false
if (walletConnectEnabled && !web3ModalInitialized) {
  try {
    createWeb3Modal({ wagmiConfig, projectId })
    web3ModalInitialized = true
  } catch (error) {
    console.error('Web3 modal initialization failed:', error)
  }
}


function shouldEnableAndroidSafeMode() {
  const ua = navigator.userAgent
  const isAndroid = /Android/i.test(ua)
  const isMobile = window.innerWidth < 768
  const params = new URLSearchParams(window.location.search)
  const forcedAndroidSafe = params.get('mobileSafe') === 'android'
  const debugAndroid = params.get('debugAndroid') === 'true'
  const safeMode = (isAndroid && isMobile) || forcedAndroidSafe

  return {
    safeMode,
    debugMode: forcedAndroidSafe || debugAndroid,
    diagnostics: {
      isAndroid,
      isMobile,
      innerWidth: window.innerWidth,
      userAgentSnippet: ua.slice(0, 120),
    },
  }
}

export function Providers({ children, initialState }: { children: React.ReactNode; initialState?: State }) {
  const [androidDebugBadge, setAndroidDebugBadge] = useState(false)
  const [androidDebugText, setAndroidDebugText] = useState('')

  useEffect(() => {
    if (typeof window === 'undefined') return

    const { safeMode, debugMode, diagnostics } = shouldEnableAndroidSafeMode()
    document.documentElement.classList.toggle('android-safe-mode', safeMode)
    document.body.classList.toggle('android-safe-mode', safeMode)
    const hasAndroidSafeClass = document.body.classList.contains('android-safe-mode')
    setAndroidDebugBadge(debugMode)
    setAndroidDebugText(`${hasAndroidSafeClass ? 'active' : 'inactive'} · ${diagnostics.innerWidth}px · Android ${diagnostics.isAndroid ? 'yes' : 'no'} · ${new Date().toISOString()}`)

    if (debugMode) {
      console.info('Android safe diagnostics', {
        ...diagnostics,
        hasAndroidSafeClass,
      })
    }

    return () => {
      document.documentElement.classList.remove('android-safe-mode')
      document.body.classList.remove('android-safe-mode')
    }
  }, [])


  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        {children}
        {androidDebugBadge && (
          <div className="fixed bottom-5 right-4 z-[9999] rounded-full border border-cyan-400/40 bg-slate-950/90 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-cyan-300 pointer-events-none">
            Android safe mode {androidDebugText}
          </div>
        )}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
