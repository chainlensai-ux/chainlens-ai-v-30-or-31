import { defaultWagmiConfig } from '@web3modal/wagmi/react/config'
import { base } from 'viem/chains'
import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'

export const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ??
  process.env.NEXT_PUBLIC_WALLETCONNECT_ID ??
  ''
export const walletConnectEnabled = projectId.length > 0

export const wagmiConfig = walletConnectEnabled
  ? defaultWagmiConfig({
      projectId,
      chains: [base],
      metadata: {
        name: 'ChainLens AI',
        description: 'AI-powered Base analytics',
        url: 'https://chainlens.ai',
        icons: ['https://chainlens.ai/icon.png'],
      },
    })
  : createConfig({
      chains: [base],
      connectors: [injected()],
      transports: {
        [base.id]: http(),
      },
    })
