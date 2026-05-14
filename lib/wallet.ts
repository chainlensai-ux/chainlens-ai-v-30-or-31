import { defaultWagmiConfig } from '@web3modal/wagmi/react/config'
import { base } from 'viem/chains'
import { createConfig, createStorage, http } from 'wagmi'
import { cookieStorage } from 'wagmi'
import { injected } from 'wagmi/connectors'

export const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
  process.env.NEXT_PUBLIC_WALLETCONNECT_ID ??
  ''
export const walletConnectEnabled = projectId.length > 0

const persistOptions = {
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
} as const

export const wagmiConfig = walletConnectEnabled
  ? defaultWagmiConfig({
      projectId,
      chains: [base],
      storage: createStorage({ storage: cookieStorage }),
      metadata: {
        name: 'ChainLens AI',
        description: 'AI-powered Base analytics',
        url: 'https://chainlens.ai',
        icons: ['https://chainlens.ai/icon.png'],
      },
      ...persistOptions,
    })
  : createConfig({
      chains: [base],
      storage: createStorage({ storage: cookieStorage }),
      connectors: [injected()],
      transports: {
        [base.id]: http(),
      },
      ...persistOptions,
    })
