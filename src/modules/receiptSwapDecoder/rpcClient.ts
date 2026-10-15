// MODULE — receiptSwapDecoder: shared Base RPC client.
//
// Single cached viem PublicClient, reused by poolValidator.ts (pool-factory validation) and
// receiptAcquisition.ts (eth_getTransactionReceipt) — "use the existing configured Base RPC
// client" means one client instance, not two independently-cached ones. Same
// ALCHEMY_BASE_RPC_URL/ALCHEMY_BASE_KEY convention already verified and shipped in basedex.ts.

import { createPublicClient, http, type PublicClient } from 'viem'
import { base, mainnet } from 'viem/chains'

let cachedClient: PublicClient | null = null

export function getSharedBaseClient(): PublicClient | null {
  const rpcUrl = process.env.ALCHEMY_BASE_RPC_URL
    ?? (process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null)
  if (!rpcUrl) return null
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: base, transport: http(rpcUrl) })
  }
  return cachedClient
}

let cachedEthereumClient: PublicClient | null = null

// Ethereum mainnet, same Alchemy key names providerFetchWindow already uses for Ethereum history.
export function getSharedEthereumClient(): PublicClient | null {
  const key = ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY']
    .map((name) => process.env[name]?.trim() ?? '').find((value) => value.length > 0)
  const rpcUrl = process.env.ALCHEMY_ETH_RPC_URL ?? (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : null)
  if (!rpcUrl) return null
  if (!cachedEthereumClient) {
    cachedEthereumClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) }) as PublicClient
  }
  return cachedEthereumClient
}
