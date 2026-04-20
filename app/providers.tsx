'use client'

import { WagmiProvider } from 'wagmi'
import { Web3Modal } from '@web3modal/wagmi/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig, projectId } from '@/lib/wallet'

const queryClient = new QueryClient()

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Web3Modal projectId={projectId} wagmiConfig={wagmiConfig} />
      </QueryClientProvider>
    </WagmiProvider>
  )
}
