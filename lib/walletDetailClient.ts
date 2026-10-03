import { createWalletDetailCache } from './walletDetailCache'
import type { WalletBalanceSnapshot } from './walletDetailEvidence'

const cache = createWalletDetailCache<WalletBalanceSnapshot>()
export const unavailableWalletBalance: WalletBalanceSnapshot = { tokenBalanceRaw: null, tokenBalanceSucceeded: false, nativeBalance: null, nativeBalanceSucceeded: false }
export function loadSelectedWalletBalance(chain: string, token: string, wallet: string): Promise<WalletBalanceSnapshot> {
  return cache.get(`${chain}:${token.toLowerCase()}:${wallet.toLowerCase()}`, async () => {
    try {
      const params = new URLSearchParams({ chain, tokenAddress: token, walletAddress: wallet })
      const res = await fetch(`/api/deployer-balance?${params}`, { signal: AbortSignal.timeout(12_000) })
      if (!res.ok) return unavailableWalletBalance
      const json = await res.json()
      return json?.ok ? json : unavailableWalletBalance
    } catch { return unavailableWalletBalance }
  })
}
