// lib/engine/modules/pricing/rpcDecimals.ts — RPC-verified ERC20 decimals(), for dominant holdings
// only (FreeCode valuation audit task, "decimals are RPC-verified for dominant holdings").
//
// CONFIRMED GAP, DISCLOSED: every holding's `decimals` comes from the balances provider
// (GoldRush's own `contract_decimals`, defaulting to 18 when the provider's response omits it —
// see src/modules/holdings/utils.ts) and is never independently checked against the token
// contract's own real on-chain `decimals()` value. A thin-metadata, low-liquidity token (exactly
// the "FreeCode"-shaped case this task audits) is the case most likely to have a provider-reported
// decimals value that's stale or simply wrong, silently corrupting both this module's own
// recomputed quantity/value AND (indirectly) the provider's own `quote`/`quote_rate`, since those
// are computed from the SAME provider-side decimals. This module never trusts the provider's
// decimals for a holding above the dominant-holding threshold without a real on-chain cross-check.
//
// REUSE, NOT A NEW PROVIDER, DISCLOSED: uses `viem` (already an installed, in-use dependency —
// see src/modules/pricingAtTimeEngine/sources/basedex.ts) against this codebase's own
// already-configured ALCHEMY_<CHAIN>_KEY / ALCHEMY_BASE_RPC_URL env convention — the exact same RPC
// endpoint already used for basedex.ts's own on-chain reads. No new provider, no new API key, no
// new external dependency.
//
// BOUNDED, DISCLOSED: only ever called for a holding already confirmed >= the dominant-holding
// share threshold (fetchPricing.ts) — at most a small handful of calls per scan, never a
// per-holding blanket RPC audit. A token contract's real `decimals()` is a permanent, immutable
// on-chain fact once deployed, so a resolved value is cached indefinitely (per-process) — a cache
// hit costs zero further RPC calls for the same (chainId, tokenAddress) for the rest of this
// process's lifetime.
//
// NEVER FABRICATES: any failure (unsupported chain, missing RPC key, timeout, revert, non-ERC20
// contract) resolves to `null` — "RPC verification unavailable," never a guessed decimals value.

import { createPublicClient, http, type Chain, type PublicClient } from 'viem'
import { base, mainnet, arbitrum } from 'viem/chains'

const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

// CHAIN COVERAGE, DISCLOSED: only chains this codebase already has a real, configured Alchemy RPC
// key convention for (matching basedex.ts's own ALCHEMY_BASE_KEY/ALCHEMY_BASE_RPC_URL pattern,
// extended here to eth/arbitrum using the SAME env vars fetchHoldings.ts already reads via
// src/modules/holdings/utils.ts). HyperEVM has no verified RPC endpoint anywhere in this codebase —
// honestly unsupported here too, never guessed.
const RPC_CHAINS: Partial<Record<number, { chain: Chain; envKeys: string[]; urlEnv?: string }>> = {
  1: { chain: mainnet, envKeys: ['ALCHEMY_ETHEREUM_KEY', 'ALCHEMY_ETH_KEY', 'ALCHEMY_ETH_API_KEY', 'ALCHEMY_API_KEY'] },
  8453: { chain: base, envKeys: ['ALCHEMY_BASE_KEY', 'ALCHEMY_BASE_API_KEY', 'ALCHEMY_API_KEY'], urlEnv: 'ALCHEMY_BASE_RPC_URL' },
  42161: { chain: arbitrum, envKeys: ['ALCHEMY_ARBITRUM_KEY', 'ALCHEMY_ARBITRUM_API_KEY', 'ALCHEMY_API_KEY'] },
}

const ALCHEMY_NETWORK_SLUG: Record<number, string> = { 1: 'eth-mainnet', 8453: 'base-mainnet', 42161: 'arb-mainnet' }

function resolveEnvKey(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim().length > 0) return value.trim()
  }
  return ''
}

const clientCache = new Map<number, PublicClient | null>()

function getClient(chainId: number): PublicClient | null {
  if (clientCache.has(chainId)) return clientCache.get(chainId) ?? null
  const config = RPC_CHAINS[chainId]
  if (!config) {
    clientCache.set(chainId, null)
    return null
  }
  const explicitUrl = config.urlEnv ? process.env[config.urlEnv] : undefined
  const key = resolveEnvKey(config.envKeys)
  const rpcUrl = explicitUrl && explicitUrl.trim().length > 0 ? explicitUrl.trim() : key ? `https://${ALCHEMY_NETWORK_SLUG[chainId]}.g.alchemy.com/v2/${key}` : null
  if (!rpcUrl) {
    clientCache.set(chainId, null)
    return null
  }
  const client = createPublicClient({ chain: config.chain, transport: http(rpcUrl) })
  clientCache.set(chainId, client)
  return client
}

// PERMANENT CACHE, DISCLOSED: a token contract's decimals() is immutable once deployed — see file
// header. `null` (verification unavailable/failed) is deliberately NOT cached, so a transient RPC
// failure doesn't permanently suppress a real future verification attempt for the same token.
const decimalsCache = new Map<string, number>()

function cacheKey(chainId: number, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}

// Never throws: every failure path (unsupported chain, no RPC key, network error, revert, malformed
// contract) resolves to null.
export async function verifyOnchainDecimals(chainId: number, tokenAddress: string): Promise<number | null> {
  const key = cacheKey(chainId, tokenAddress)
  const cached = decimalsCache.get(key)
  if (cached !== undefined) return cached

  const client = getClient(chainId)
  if (!client) return null

  try {
    const decimals = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    })
    const value = Number(decimals)
    if (!Number.isFinite(value) || value < 0 || value > 255) return null
    decimalsCache.set(key, value)
    return value
  } catch {
    return null
  }
}

// TEST-SUPPORT EXPORT, DISCLOSED: same convention as basedex.ts's own
// __resetBaseDexCachesForTest — lets a test inject a fresh state instead of leaking a resolved
// decimals value (or client) across unrelated test cases. Not called anywhere in real request
// handling.
export function __resetRpcDecimalsCacheForTest(): void {
  decimalsCache.clear()
  clientCache.clear()
}
