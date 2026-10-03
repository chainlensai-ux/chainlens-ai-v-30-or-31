import { createWalletDetailCache } from '../walletDetailCache'
import type { WalletBalanceSnapshot } from '../walletDetailEvidence'
import { getRobinhoodRpcUrl, isRobinhoodChainAvailable } from './robinhoodChainConfig'

export function walletDetailChain(chain: string): { chainId: number; rpcUrl: string | null; nativeSymbol: string } | null {
  const env = process.env
  if (chain === 'robinhood') return isRobinhoodChainAvailable() ? { chainId: 4663, rpcUrl: getRobinhoodRpcUrl(), nativeSymbol: 'ETH' } : null
  const config = {
    eth: { chainId: 1, domain: 'eth-mainnet', url: env.ALCHEMY_ETH_RPC_URL || env.ETH_RPC_URL, key: env.ALCHEMY_ETHEREUM_KEY || env.ALCHEMY_ETH_KEY || env.ALCHEMY_API_KEY, nativeSymbol: 'ETH' },
    base: { chainId: 8453, domain: 'base-mainnet', url: env.ALCHEMY_BASE_RPC_URL || env.BASE_RPC_URL, key: env.ALCHEMY_BASE_KEY || env.ALCHEMY_API_KEY, nativeSymbol: 'ETH' },
    polygon: { chainId: 137, domain: 'polygon-mainnet', url: null, key: env.ALCHEMY_POLYGON_KEY, nativeSymbol: 'POL' },
    bnb: { chainId: 56, domain: 'bnb-mainnet', url: null, key: env.ALCHEMY_BNB_KEY, nativeSymbol: 'BNB' },
  }[chain]
  if (!config) return null
  return { chainId: config.chainId, nativeSymbol: config.nativeSymbol, rpcUrl: config.url || (config.key ? `https://${config.domain}.g.alchemy.com/v2/${config.key}` : chain === 'base' ? 'https://mainnet.base.org' : null) }
}

export function createWalletBalanceReader(fetcher: typeof fetch = fetch, now = Date.now) {
  const tokenCache = createWalletDetailCache<string | null>(60_000, 200, now)
  const nativeCache = createWalletDetailCache<string | null>(60_000, 200, now)
  async function rpc(url: string, method: string, params: unknown[]): Promise<string | null> {
    try {
      const res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000), cache: 'no-store' })
      if (!res.ok) return null
      const json = await res.json()
      // Empty return data, reverted calls and malformed hex are unavailable, never zero.
      if (json.error || typeof json.result !== 'string' || !/^0x[\da-f]+$/i.test(json.result)) return null
      if (method === 'eth_call' && !/^0x[\da-f]{64}$/i.test(json.result)) return null
      return BigInt(json.result).toString()
    } catch { return null }
  }
  return async (config: { chainId: number; rpcUrl: string; nativeSymbol: string }, token: string, wallet: string): Promise<WalletBalanceSnapshot> => {
    const address = wallet.toLowerCase()
    const contract = token.toLowerCase()
    const [tokenBalanceRaw, nativeRaw] = await Promise.all([
      tokenCache.get(`${config.chainId}:${contract}:${address}`, () => rpc(config.rpcUrl, 'eth_call', [{ to: contract, data: `0x70a08231${address.slice(2).padStart(64, '0')}` }, 'latest'])),
      nativeCache.get(`${config.chainId}:${address}`, () => rpc(config.rpcUrl, 'eth_getBalance', [address, 'latest'])),
    ])
    return { tokenBalanceRaw, tokenBalanceSucceeded: tokenBalanceRaw !== null, nativeBalance: nativeRaw == null ? null : Number(nativeRaw) / 1e18, nativeBalanceSucceeded: nativeRaw !== null, nativeSymbol: config.nativeSymbol, checkedAt: new Date(now()).toISOString() }
  }
}
export const readWalletBalance = createWalletBalanceReader()
