// FAST DEPLOYER RESOLVER, DISCLOSED (reported live: Clark asked "who deployed this token 0x..."
// and replied "DEPLOYER LOOKUP — UNAVAILABLE... deployer lookup timed out"). Root cause: Clark's
// ONLY path to a deployer address was the full /api/dev-wallet route (bytecode reads, linked-wallet
// cluster analysis, holder-overlap checks) called over HTTP with a 25s budget — real, useful work,
// but far more than "who deployed this token" needs, and slow enough that a single provider hiccup
// blew the whole budget and produced a bare timeout with no partial answer.
//
// This module is a deliberately narrow, fast, in-process alternative: ONLY resolves a deployer/
// creator address (nothing else — no cluster analysis, no verdict), tries the cheapest real sources
// first, gives each source its OWN short timeout so one slow provider can't consume the whole
// budget, and is chain-scoped by construction (chainSlug is a required parameter threaded through
// every request URL and cache key — never a shared mutable "current chain" the way the legacy
// discoverOrigin() in app/api/dev-wallet/route.ts uses, which is a latent wrong-chain risk under
// concurrent requests to the same serverless instance). The full /api/dev-wallet route is untouched
// and still used by Token Scanner and for deeper analysis (linked wallets, rug verdict) — this
// module only replaces the "just tell me the deployer address, fast" path.

import { RPC } from '@/lib/rpc'
import { getRobinhoodRpcUrl } from '@/lib/server/robinhoodChainConfig'

export type DeployerConfidence = 'high' | 'medium' | 'low'
export type DeployerEvidenceSource =
  | 'internal_cache'
  | 'explorer_creation_lookup'
  | 'rpc_earliest_transfer'
  | 'none'

export type ResolverChainSlug = 'base' | 'eth' | 'bnb' | 'robinhood'

export interface ResolveTokenDeployerInput {
  chainSlug: ResolverChainSlug
  chainId: number
  tokenAddress: string
}

export interface ResolveTokenDeployerResult {
  deployerAddress: string | null
  creatorAddress: string | null
  confidence: DeployerConfidence
  evidenceSource: DeployerEvidenceSource
  explorerUrl: string | null
  sourcesAttempted: string[]
  sourcesSucceeded: string[]
  failureReason: string | null
  durationMs: number
}

// WRONG-CHAIN GUARD, DISCLOSED (hard rule: "Do NOT silently default to Base if chain is ambiguous"):
// every chain this resolver supports has its own explicit chainId — an unrecognized/ambiguous chain
// is rejected by the caller before this module is ever invoked (see resolveDeployerChain below in
// the Clark route), never silently coerced to Base here.
const EXPLORER_CONFIG: Record<ResolverChainSlug, {
  explorerName: string
  explorerUrl: string
  buildCreationLookupUrl: (address: string, apiKey: string) => string
  apiKey: () => string | null
  parseCreationLookup: (json: unknown) => string | null
} | null> = {
  base: {
    explorerName: 'Basescan',
    explorerUrl: 'https://basescan.org',
    apiKey: () => process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || null,
    buildCreationLookupUrl: (address, apiKey) =>
      `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${apiKey}`,
    parseCreationLookup: json => {
      const j = json as { status?: string; result?: Array<{ contractCreator?: string }> }
      return j?.status === '1' ? (j.result?.[0]?.contractCreator ?? null) : null
    },
  },
  eth: {
    explorerName: 'Etherscan',
    explorerUrl: 'https://etherscan.io',
    apiKey: () => process.env.ETHERSCAN_API_KEY || null,
    buildCreationLookupUrl: (address, apiKey) =>
      `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${apiKey}`,
    parseCreationLookup: json => {
      const j = json as { status?: string; result?: Array<{ contractCreator?: string }> }
      return j?.status === '1' ? (j.result?.[0]?.contractCreator ?? null) : null
    },
  },
  bnb: {
    explorerName: 'BscScan (Etherscan V2)',
    explorerUrl: 'https://bscscan.com',
    // Etherscan's V2 API is a real multi-chain endpoint keyed by chainid — the same ETHERSCAN_API_KEY
    // already used for 'eth' above works across chains it supports, BNB (56) included.
    apiKey: () => process.env.ETHERSCAN_API_KEY || null,
    buildCreationLookupUrl: (address, apiKey) =>
      `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${apiKey}`,
    parseCreationLookup: json => {
      const j = json as { status?: string; result?: Array<{ contractCreator?: string }> }
      return j?.status === '1' ? (j.result?.[0]?.contractCreator ?? null) : null
    },
  },
  robinhood: {
    explorerName: 'Robinhood Chain Blockscout',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    // Blockscout's own REST API needs no key — real, public, per-chain instance.
    apiKey: () => 'none',
    buildCreationLookupUrl: address => `https://robinhoodchain.blockscout.com/api/v2/addresses/${address}`,
    parseCreationLookup: json => {
      const j = json as { creator_address_hash?: string | null }
      return j?.creator_address_hash ?? null
    },
  },
}

function rpcUrlFor(chainSlug: ResolverChainSlug): string | null {
  if (chainSlug === 'robinhood') return getRobinhoodRpcUrl()
  const url = RPC[chainSlug]
  return typeof url === 'string' && url.length > 0 ? url : null
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(v) ? v : null
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
function isUsableCandidate(address: string | null, tokenAddress: string): address is string {
  if (!address) return false
  return address !== ZERO_ADDRESS && address !== tokenAddress.toLowerCase()
}

// PER-SOURCE TIMEOUT, DISCLOSED (requested: "add per-source timeout and fallback, not one global
// timeout that kills everything"). Each tier gets its own short budget; a slow/hanging source is
// abandoned and the NEXT source is tried, rather than one global deadline killing every source at
// once (which is what made a single provider hiccup read as a total, unexplained timeout before).
const EXPLORER_TIMEOUT_MS = 1_800
const RPC_TIMEOUT_MS = 1_800

// RESULT CACHE, DISCLOSED (fallback tier: "internal cached Token Scanner dev/deployer result" /
// "cached token scan result"). Chain-scoped cache key — an address on two different chains is two
// distinct cache entries, never shared. Successes cache for a day (a contract's deployer never
// changes); a genuine "not found" is cached briefly so a bad token isn't hammered every message in
// the same conversation, but not so long that a transient provider outage looks permanent.
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const NOT_FOUND_TTL_MS = 5 * 60 * 1000
const resolverCache = new Map<string, { exp: number; result: ResolveTokenDeployerResult }>()

function cacheKey(chainSlug: ResolverChainSlug, tokenAddress: string): string {
  return `${chainSlug}:${tokenAddress.toLowerCase()}`
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return null
  }
}

async function tryExplorerCreationLookup(
  chainSlug: ResolverChainSlug, tokenAddress: string,
): Promise<{ address: string | null; attempted: boolean; succeeded: boolean }> {
  const cfg = EXPLORER_CONFIG[chainSlug]
  if (!cfg) return { address: null, attempted: false, succeeded: false }
  const apiKey = cfg.apiKey()
  if (!apiKey) return { address: null, attempted: false, succeeded: false }
  const url = cfg.buildCreationLookupUrl(tokenAddress, apiKey)
  const res = await fetchWithTimeout(url, EXPLORER_TIMEOUT_MS)
  if (!res || !res.ok) return { address: null, attempted: true, succeeded: false }
  try {
    const json = await res.json()
    const raw = cfg.parseCreationLookup(json)
    const addr = normalizeAddress(raw)
    if (isUsableCandidate(addr, tokenAddress)) return { address: addr, attempted: true, succeeded: true }
    return { address: null, attempted: true, succeeded: false }
  } catch {
    return { address: null, attempted: true, succeeded: false }
  }
}

async function alchemyCall(rpcUrl: string, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
      cache: 'no-store',
    })
    const json = await r.json() as { result?: unknown; error?: unknown }
    if (json.error) return null
    return json.result ?? null
  } catch {
    return null
  } finally {
    clearTimeout(tid)
  }
}

async function tryRpcEarliestTransfer(
  chainSlug: ResolverChainSlug, tokenAddress: string,
): Promise<{ address: string | null; attempted: boolean; succeeded: boolean }> {
  const rpcUrl = rpcUrlFor(chainSlug)
  if (!rpcUrl) return { address: null, attempted: false, succeeded: false }
  const result = await alchemyCall(rpcUrl, 'alchemy_getAssetTransfers', [{
    fromBlock: '0x0', toBlock: 'latest',
    category: ['erc20'], contractAddresses: [tokenAddress],
    order: 'asc', maxCount: '0x14', withMetadata: false,
  }], RPC_TIMEOUT_MS) as { transfers?: Array<{ from?: string; to?: string }> } | null
  const transfers = result?.transfers ?? []
  const first = transfers.find(t => isUsableCandidate(normalizeAddress(t.from), tokenAddress) || isUsableCandidate(normalizeAddress(t.to), tokenAddress))
  if (!first) return { address: null, attempted: true, succeeded: false }
  const addr = isUsableCandidate(normalizeAddress(first.from), tokenAddress) ? normalizeAddress(first.from) : normalizeAddress(first.to)
  if (!addr) return { address: null, attempted: true, succeeded: false }
  return { address: addr, attempted: true, succeeded: true }
}

/**
 * Fast, chain-strict deployer/creator resolution — deliberately narrower than a full token scan.
 * Target: resolve well under the ~25s a full /api/dev-wallet call could take; in practice a cache
 * hit or a healthy explorer response lands in well under 2s, though a cold lookup that must fall
 * through to the RPC tier (each source has its own ~1.8s budget) can take longer under real network
 * conditions — still bounded by per-source timeouts, never one global deadline that kills every
 * source at once.
 */
export async function resolveTokenDeployer(input: ResolveTokenDeployerInput): Promise<ResolveTokenDeployerResult> {
  const startedAt = Date.now()
  const tokenAddress = input.tokenAddress.toLowerCase()
  const key = cacheKey(input.chainSlug, tokenAddress)
  const cached = resolverCache.get(key)
  if (cached && cached.exp > Date.now()) {
    return { ...cached.result, evidenceSource: cached.result.deployerAddress ? 'internal_cache' : cached.result.evidenceSource, durationMs: Date.now() - startedAt }
  }

  const sourcesAttempted: string[] = []
  const sourcesSucceeded: string[] = []

  const explorer = await tryExplorerCreationLookup(input.chainSlug, tokenAddress)
  if (explorer.attempted) sourcesAttempted.push('explorer_creation_lookup')
  if (explorer.succeeded && explorer.address) {
    sourcesSucceeded.push('explorer_creation_lookup')
    const result: ResolveTokenDeployerResult = {
      deployerAddress: explorer.address, creatorAddress: explorer.address,
      confidence: 'high', evidenceSource: 'explorer_creation_lookup',
      explorerUrl: EXPLORER_CONFIG[input.chainSlug]?.explorerUrl ?? null,
      sourcesAttempted, sourcesSucceeded, failureReason: null, durationMs: Date.now() - startedAt,
    }
    resolverCache.set(key, { exp: Date.now() + SUCCESS_TTL_MS, result })
    return result
  }

  const rpcFallback = await tryRpcEarliestTransfer(input.chainSlug, tokenAddress)
  if (rpcFallback.attempted) sourcesAttempted.push('rpc_earliest_transfer')
  if (rpcFallback.succeeded && rpcFallback.address) {
    sourcesSucceeded.push('rpc_earliest_transfer')
    const result: ResolveTokenDeployerResult = {
      deployerAddress: rpcFallback.address, creatorAddress: rpcFallback.address,
      confidence: 'low', evidenceSource: 'rpc_earliest_transfer',
      explorerUrl: EXPLORER_CONFIG[input.chainSlug]?.explorerUrl ?? null,
      sourcesAttempted, sourcesSucceeded, failureReason: null, durationMs: Date.now() - startedAt,
    }
    resolverCache.set(key, { exp: Date.now() + SUCCESS_TTL_MS, result })
    return result
  }

  const failureReason = sourcesAttempted.length === 0
    ? `No deployer-resolution source is configured for ${input.chainSlug} (missing explorer API key and RPC URL).`
    : 'No source returned a usable creation/earliest-activity record for this contract within the fast-lookup budget.'
  const result: ResolveTokenDeployerResult = {
    deployerAddress: null, creatorAddress: null, confidence: 'low', evidenceSource: 'none',
    explorerUrl: EXPLORER_CONFIG[input.chainSlug]?.explorerUrl ?? null,
    sourcesAttempted, sourcesSucceeded, failureReason, durationMs: Date.now() - startedAt,
  }
  resolverCache.set(key, { exp: Date.now() + NOT_FOUND_TTL_MS, result })
  return result
}
