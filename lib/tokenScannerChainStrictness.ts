// TOKEN SCANNER CHAIN STRICTNESS, DISCLOSED (reported bug: "selected Ethereum, entered a Base
// contract, Token Scanner scanned it successfully as Base" — a hard rule violation: one chain
// selection must produce exactly one chain's result, never a silent switch). Root cause lived in
// app/api/token/route.ts: on zero indexed GeckoTerminal pools for the selected chain, the route used
// to probe the opposite chain and, if pools existed there, silently reassign the scan's own `chain`
// variable and continue the ENTIRE scan as that other chain — wrong RPC, wrong holders, wrong
// everything, with the user never told.
//
// This module is the pure decision core extracted out of that route so it can be unit-tested without
// a real network: given already-fetched existence probes (pool count + RPC bytecode) for the selected
// chain and any candidate chains, it decides whether to block, and builds the exact audit object and
// user-facing copy this fix specifies. It never fetches anything itself and never mutates a "selected
// chain" — the caller is the one place that may act on the decision, and even then only by returning
// an error to the user, never by re-running the scan on another chain automatically.

export type EvmChainSlug = 'eth' | 'base' | 'bnb' | 'robinhood'

export const EVM_CHAIN_SLUGS: EvmChainSlug[] = ['base', 'eth', 'bnb', 'robinhood']

export const CHAIN_ID_BY_SLUG: Record<EvmChainSlug, number> = { eth: 1, base: 8453, bnb: 56, robinhood: 4663 }

export const CHAIN_DISPLAY_NAME_BY_SLUG: Record<EvmChainSlug, string> = {
  eth: 'Ethereum',
  base: 'Base',
  bnb: 'BNB Chain',
  robinhood: 'Robinhood Chain',
}

export interface ChainExistenceProbe {
  chain: EvmChainSlug
  // Number of indexed liquidity pools found for this (chain, address) pair — 0 is a real, valid
  // result (a token can be legitimately deployed with no pool yet), not itself proof of absence.
  poolCount: number
  // Raw eth_getCode result: null = RPC call did not resolve (not configured, timed out, network
  // error) — inconclusive, never treated as proof of absence. "0x" = the RPC call succeeded and
  // definitively found no contract code at this address on this chain. Anything else = confirmed
  // contract code exists.
  bytecode: string | null
}

export interface TokenScannerChainStrictnessAudit {
  userSelectedChain: string
  requestedChainSlug: EvmChainSlug
  requestedChainId: number
  inputAddress: string
  normalizedAddress: string
  tokenExistsOnSelectedChain: boolean | null
  crossChainCandidateFound: boolean
  crossChainCandidateChain: EvmChainSlug | null
  autoSwitchedChain: boolean
  cacheKey: string
  cacheHit: boolean
  cacheChainMatched: boolean
  finalChainSlug: EvmChainSlug
  finalChainId: number
  blockedReason: string | null
}

export interface TokenScanChainDecision {
  blocked: boolean
  errorMessage: string | null
  audit: TokenScannerChainStrictnessAudit
}

export function buildTokenScanCacheKey(chainSlug: EvmChainSlug, chainId: number, tokenAddress: string): string {
  return `tokenScan:${chainSlug}:${chainId}:${tokenAddress.toLowerCase()}`
}

// Reject-cache-hit rule as its own pure, directly-testable function: a cached result is only ever
// usable for the EXACT (chainSlug, chainId, normalized address) it was produced for — same address on
// a different chain, or a mismatched chainId for the same slug, is never treated as a hit.
export function isCacheHitValid(
  cached: { chainSlug: string; chainId: number; tokenAddress: string },
  selected: { chainSlug: string; chainId: number; tokenAddress: string }
): boolean {
  return (
    cached.chainSlug === selected.chainSlug &&
    cached.chainId === selected.chainId &&
    cached.tokenAddress.toLowerCase() === selected.tokenAddress.toLowerCase()
  )
}

export function resolveTokenScanChainDecision(input: {
  userSelectedChain: string
  requestedChainSlug: EvmChainSlug
  inputAddress: string
  normalizedAddress: string
  selectedProbe: ChainExistenceProbe
  // Candidate probes the caller already ran for OTHER chains — only consulted when the selected
  // chain's own existence is inconclusive-or-absent; never used to pick a chain to scan.
  candidateProbes?: ChainExistenceProbe[]
}): TokenScanChainDecision {
  const { requestedChainSlug, selectedProbe } = input
  const requestedChainId = CHAIN_ID_BY_SLUG[requestedChainSlug]
  const normalizedAddress = input.normalizedAddress.toLowerCase()
  const cacheKey = buildTokenScanCacheKey(requestedChainSlug, requestedChainId, normalizedAddress)

  const confirmedAbsentOnSelectedChain = selectedProbe.bytecode === '0x'
  const tokenExistsOnSelectedChain = selectedProbe.bytecode == null ? null : !confirmedAbsentOnSelectedChain

  let crossChainCandidateFound = false
  let crossChainCandidateChain: EvmChainSlug | null = null
  if (confirmedAbsentOnSelectedChain || selectedProbe.poolCount === 0) {
    const candidate = (input.candidateProbes ?? []).find((p) => {
      const bytecodeExists = p.bytecode != null && p.bytecode !== '0x'
      return bytecodeExists || p.poolCount > 0
    })
    if (candidate) {
      crossChainCandidateFound = true
      crossChainCandidateChain = candidate.chain
    }
  }

  const blocked = confirmedAbsentOnSelectedChain
  const blockedReason = blocked
    ? (crossChainCandidateFound ? 'confirmed_absent_cross_chain_candidate' : 'confirmed_absent_no_candidate')
    : null

  const errorMessage = blocked
    ? (crossChainCandidateFound && crossChainCandidateChain
      ? `Token not found on ${CHAIN_DISPLAY_NAME_BY_SLUG[requestedChainSlug]}. This contract may exist on ${CHAIN_DISPLAY_NAME_BY_SLUG[crossChainCandidateChain]}. Switch to ${CHAIN_DISPLAY_NAME_BY_SLUG[crossChainCandidateChain]} to scan it.`
      : `Token not found on ${CHAIN_DISPLAY_NAME_BY_SLUG[requestedChainSlug]}.`)
    : null

  const audit: TokenScannerChainStrictnessAudit = {
    userSelectedChain: input.userSelectedChain,
    requestedChainSlug,
    requestedChainId,
    inputAddress: input.inputAddress,
    normalizedAddress,
    tokenExistsOnSelectedChain,
    crossChainCandidateFound,
    crossChainCandidateChain,
    // Always false — this fix's entire point is that the resolver/route never reassigns the chain
    // it scans on, regardless of what it finds on other chains.
    autoSwitchedChain: false,
    cacheKey,
    cacheHit: false,
    cacheChainMatched: true,
    finalChainSlug: requestedChainSlug,
    finalChainId: requestedChainId,
    blockedReason,
  }

  return { blocked, errorMessage, audit }
}
