// MODULE — cheap, zero-provider-call chain-discovery pre-scan for native-balance (eth_getBalance)
// checks.
//
// CU-LEAK PREVENTION, DISCLOSED (this task): the prior investigation pass found no EXISTING
// blind "check eth_getBalance across every supported chain" loop in this codebase — see that
// task's own commit message for the full disclosure. This module exists so that any FUTURE
// native-balance-check feature has a ready-made, already-tested, zero-extra-call way to scope
// itself to chains the wallet is actually active on, rather than being tempted to loop over every
// ALCHEMY_SUPPORTED_CHAINS entry by default. Any real balance-check call site should call
// `discoverActiveChains` first and only issue eth_getBalance for its returned `activeChains`.
//
// ZERO NEW PROVIDER CALLS, DISCLOSED: every evidence input here is data the caller ALREADY fetched
// for another reason (provider activity, an existing holdings/portfolio response, a cached prior
// discovery) — this module only ever reads/merges/caches, never calls out itself.
//
// MONOTONIC "NEVER REMOVE A PROVEN-ACTIVE CHAIN", DISCLOSED: the cache (activeChainCache.ts) is a
// UNION accumulator, not a plain TTL replace-on-write cache — merging fresh evidence with whatever
// was cached before only ever grows the active set (until an explicit reset), so a chain that was
// genuinely active once is never silently dropped just because this particular request's evidence
// happened not to re-surface it (e.g. a quiet period on an otherwise real chain).
//
// FALLBACK, DISCLOSED: when there is truly no evidence at all (no activity, no holdings, no cache,
// no explicit selection, not a Full Deep Scan), the safe default is Base + Ethereum ONLY — never
// silently all supported chains.

import { ALCHEMY_SUPPORTED_CHAINS, isAlchemySupportedChain, type AlchemySupportedChain } from './alchemySupportedChains'

export type ChainDiscoveryEvidenceSource =
  | 'provider_activity'
  | 'holdings'
  | 'cached_active'
  | 'explicit_chain'
  | 'fallback_base_eth'
  | 'full_deep_scan'

export type ChainDiscoveryInput = {
  walletAddress: string
  // Chains with ALREADY-FETCHED provider activity (never a new fetch triggered here).
  activityChains?: readonly string[]
  // Chains with ALREADY-FETCHED holdings/portfolio coverage (never a new fetch triggered here).
  holdingsChains?: readonly string[]
  // Explicit user-selected chain (e.g. a chain filter in the UI) — always included when supported,
  // regardless of any other evidence.
  explicitChain?: string | null
  // Set true ONLY for an explicit Full Deep Scan request — bypasses discovery entirely and returns
  // every supported chain, exactly matching "Keep Full Deep Scan able to check all supported
  // chains explicitly."
  fullDeepScan?: boolean
  // Whatever this wallet's discovery previously resolved to (from activeChainCache.ts) — merged in,
  // never overridden away from.
  cachedActiveChains?: readonly string[]
}

export type ChainDiscoveryResult = {
  walletAddress: string
  // Every chain this app has real Alchemy integration for, in the canonical, deterministic order —
  // "every chain considered", not just the ones that turned out active.
  candidateChains: AlchemySupportedChain[]
  // Chains eth_getBalance should actually be called for, deterministically ordered.
  activeChains: AlchemySupportedChain[]
  // candidateChains minus activeChains, same deterministic order.
  skippedInactiveChains: AlchemySupportedChain[]
  // Which evidence source(s) actually contributed a chain to the result — bounded, typed, never a
  // free-text description.
  evidenceSources: ChainDiscoveryEvidenceSource[]
}

const FALLBACK_CHAINS: readonly AlchemySupportedChain[] = ['base', 'eth']

function canonicalOrder(chains: ReadonlySet<AlchemySupportedChain>): AlchemySupportedChain[] {
  return ALCHEMY_SUPPORTED_CHAINS.filter((c) => chains.has(c))
}

// PURE, DISCLOSED: no I/O — every input is data the caller already has in hand. Deterministic:
// identical input always produces an identical result, regardless of the order evidence arrays
// were built in.
export function discoverActiveChains(input: ChainDiscoveryInput): ChainDiscoveryResult {
  const candidateChains = [...ALCHEMY_SUPPORTED_CHAINS]

  if (input.fullDeepScan) {
    return {
      walletAddress: input.walletAddress,
      candidateChains,
      activeChains: candidateChains,
      skippedInactiveChains: [],
      evidenceSources: ['full_deep_scan'],
    }
  }

  const active = new Set<AlchemySupportedChain>()
  const evidenceSources: ChainDiscoveryEvidenceSource[] = []

  const fromActivity = (input.activityChains ?? []).filter(isAlchemySupportedChain)
  if (fromActivity.length > 0) {
    fromActivity.forEach((c) => active.add(c))
    evidenceSources.push('provider_activity')
  }

  const fromHoldings = (input.holdingsChains ?? []).filter(isAlchemySupportedChain)
  if (fromHoldings.length > 0) {
    fromHoldings.forEach((c) => active.add(c))
    evidenceSources.push('holdings')
  }

  if (input.explicitChain && isAlchemySupportedChain(input.explicitChain)) {
    if (!active.has(input.explicitChain)) evidenceSources.push('explicit_chain')
    active.add(input.explicitChain)
  }

  // MONOTONIC MERGE, DISCLOSED: cached chains are folded in AFTER fresh-evidence chains are
  // collected, so we can tell (for the evidenceSources list) whether the cache contributed a chain
  // fresh evidence didn't already re-surface — never a reason to remove anything.
  const fromCache = (input.cachedActiveChains ?? []).filter(isAlchemySupportedChain)
  const cacheAddedSomethingNew = fromCache.some((c) => !active.has(c))
  fromCache.forEach((c) => active.add(c))
  if (cacheAddedSomethingNew) evidenceSources.push('cached_active')

  if (active.size === 0) {
    FALLBACK_CHAINS.forEach((c) => active.add(c))
    evidenceSources.push('fallback_base_eth')
  }

  const activeChains = canonicalOrder(active)
  const skippedInactiveChains = candidateChains.filter((c) => !active.has(c))

  return { walletAddress: input.walletAddress, candidateChains, activeChains, skippedInactiveChains, evidenceSources }
}
