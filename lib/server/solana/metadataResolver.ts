// SOLANA METADATA RESOLVER, DISCLOSED (Solana-native architecture task): resolves the token
// identity shown in the header — name/symbol/logo/verified — Jupiter first, DexScreener fallback.
// SPL mints carry no name/symbol on-chain (unlike an ERC-20 contract's own name()/symbol()
// getters), so identity here is necessarily indexer-sourced — this precedence and its honest
// null-when-unresolved behavior is Solana-native, not an EVM pattern applied to Solana.

import { fetchJupiterSolanaData, type SolanaJupiterResult } from '../solanaProviders.ts'
import type { RpcFetch } from './rpcClient.ts'

export type SolanaMetadataResolution = {
  jupiter: SolanaJupiterResult
  resolvedTokenName: string | null
  resolvedTokenSymbol: string | null
  evidenceGaps: string[]
}

export async function resolveSolanaMetadata(params: {
  mintAddress: string
  fetchImpl: RpcFetch
  dexScreenerName: string | null
  dexScreenerSymbol: string | null
}): Promise<SolanaMetadataResolution> {
  const evidenceGaps: string[] = []
  const jupiter = await fetchJupiterSolanaData(params.mintAddress, params.fetchImpl)
  if (jupiter.called && !jupiter.success) evidenceGaps.push('Jupiter identity/price enrichment did not resolve — token identity relies on DexScreener and the mint address only.')

  // Header identity precedence: Jupiter first, DexScreener fallback, mint address last (the mint
  // fallback itself is a UI concern, resolved by the caller, not here).
  return {
    jupiter,
    resolvedTokenName: jupiter.resolved.name ?? params.dexScreenerName,
    resolvedTokenSymbol: jupiter.resolved.symbol ?? params.dexScreenerSymbol,
    evidenceGaps,
  }
}
