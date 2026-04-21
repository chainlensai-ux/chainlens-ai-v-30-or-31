'use client'

import { useWeb3Modal } from '@web3modal/wagmi/react'
import { useAccount } from '@wagmi/react'

export default function ConnectWallet() {
  const { open } = useWeb3Modal()
  const { address, isConnected } = useAccount()

  if (isConnected && address) {
    return (
      <button className="px-4 py-2 rounded-lg bg-green-600 text-white">
        {address.slice(0, 6)}...{address.slice(-4)}
      </button>
    )
  }

  return (
    <button
      onClick={() => open()}
      className="px-4 py-2 rounded-lg bg-blue-600 text-white"
    >
      Connect Wallet
    </button>
  )
}
