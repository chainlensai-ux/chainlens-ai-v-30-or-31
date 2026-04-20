import { defaultWagmiConfig } from '@web3modal/wagmi/react/config'
import { base } from 'viem/chains'

export const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID!

export const wagmiConfig = defaultWagmiConfig({
  projectId,
  chains: [base],
  metadata: {
    name: 'ChainLens AI',
    description: 'AI-powered Base analytics',
    url: 'https://chainlens.ai',
    icons: ['https://chainlens.ai/icon.png']
  }
})
