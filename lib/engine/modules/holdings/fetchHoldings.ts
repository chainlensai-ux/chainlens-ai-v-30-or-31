// lib/engine/modules/holdings/fetchHoldings.ts — new ChainHolding-shaped holdings module.
//
// REUSE, NOT REIMPLEMENTATION, DISCLOSED: the task asked to "use existing RPC/Alchemy helpers
// already in the project" — the real, existing, already-tested balance-fetching logic is
// src/modules/holdings's `fetchHoldings(chain, walletAddress)` (GoldRush primary, Alchemy
// fallback, real token metadata — symbol/decimals/contract — straight from those providers'
// balances calls). This file is a thin ADAPTER over that real function, mapping its real
// `TokenHolding[]` output into the new `ChainHolding` shape this task specifies — it does not
// duplicate any network-call logic, per this session's standing "don't build a second
// implementation of something that already exists" convention.
//
// CHAIN MAPPING, DISCLOSED: the task specifies numeric chainIds (1 = Ethereum, 8453 = Base). The
// real underlying module keys everything by `SupportedChain` string ('eth' | 'base' | 'arbitrum' |
// 'hyperevm') — CHAIN_ID_TO_SUPPORTED_CHAIN below is the (real, standard, well-known) mapping
// between the two; only 1 and 8453 are wired per the task's explicit "support chainId 1 and 8453"
// scope.
//
// CLASSIFICATION, DISCLOSED: STABLE_SYMBOLS and BLUE_CHIP_SYMBOLS below are real, reasonable lists
// matching the task's own examples. No "existing meme list" or "known LP contract" address list
// exists anywhere in this codebase (verified by search before writing this file) — the task's own
// instructions for those two ("if any") anticipated this. Rather than fabricate a meme-token list
// or an LP-address registry that doesn't exist, every holding that isn't stable/blue-chip
// classifies honestly as "other" — never a guessed "meme" or "lp" label.
//
// lastActivityAt, DISCLOSED: no existing "latest tx timestamp per token" indexer is wired at this
// level (TokenHolding is a pure current-balance snapshot — see src/modules/holdings/types.ts's own
// header on why it's deliberately separate from the transfer-history modules). Per the task's own
// "otherwise null" fallback, this is always null here — not fabricated from unrelated data.

import { fetchHoldings as fetchRealHoldings } from '@/src/modules/holdings'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import type { ChainHolding } from './types'

export type { ChainHolding, HoldingsEngineInput } from './types'

// Exported so lib/engine/modules/pricing/fetchPricing.ts can reuse the exact same mapping rather
// than maintaining a second, potentially-drifting copy.
export const CHAIN_ID_TO_SUPPORTED_CHAIN: Record<number, SupportedChain> = {
  1: 'eth',
  8453: 'base',
}

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'USDBC', 'TUSD'])
const BLUE_CHIP_SYMBOLS = new Set(['ETH', 'WETH', 'WBTC'])

function classify(symbol: string): ChainHolding['classification'] {
  const upper = symbol.toUpperCase()
  if (STABLE_SYMBOLS.has(upper)) return 'stable'
  if (BLUE_CHIP_SYMBOLS.has(upper)) return 'blue_chip'
  // No real meme-token list or LP-contract-address registry exists in this codebase — see file
  // header. Never guessed.
  return 'other'
}

// Never throws: src/modules/holdings's real fetchHoldings already resolves to an honest
// provider_unavailable/[] result on any failure (see that module's own guarantees) rather than
// throwing, and this function adds no additional network calls of its own that could fail.
export async function fetchChainBalances(walletAddress: string, chainId: number): Promise<ChainHolding[]> {
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
  if (!chain) return [] // unsupported chainId — honestly empty, never a guessed chain

  const result = await fetchRealHoldings(chain, walletAddress)

  return result.holdings
    .filter((h) => h.amount > 0)
    .map((h): ChainHolding => ({
      chainId,
      tokenAddress: h.contract,
      symbol: h.symbol,
      decimals: h.tokenDecimals,
      quantity: String(h.amount),
      lastActivityAt: null,
      classification: classify(h.symbol),
    }))
}

// Public entry point, exactly as specified. Runs both chains in parallel; never throws (each
// fetchChainBalances call above already can't).
export async function fetchAllHoldings(walletAddress: string): Promise<ChainHolding[]> {
  const chains = [1, 8453]
  const results = await Promise.all(chains.map((c) => fetchChainBalances(walletAddress, c)))
  return results.flat()
}
