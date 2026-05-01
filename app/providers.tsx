'use client'

import { WagmiProvider } from 'wagmi'
import { createWeb3Modal } from '@web3modal/wagmi/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig, projectId, walletConnectEnabled } from '@/lib/wallet'
import { useEffect, useRef } from 'react'

const queryClient = new QueryClient()

export function Providers({ children }: { children: React.ReactNode }) {
  const modalInitRef = useRef(false)

  useEffect(() => {
    if (!walletConnectEnabled || typeof window === 'undefined' || modalInitRef.current) return
    modalInitRef.current = true
    createWeb3Modal({
      wagmiConfig,
      projectId,
    })
  }, [])

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
