// SOLANA HOLDER CONCENTRATION RESOLVER, DISCLOSED (Solana Token Scanner holder-reliability task).
// Reported symptom: Solana scans sometimes show "Top-account concentration unavailable" / "Top
// token accounts could not be read (rpc_error: Internal error)" — a raw provider error surfaced
// straight to the public UI, with no fallback and no clean explanation.
//
// resolveSolanaHolderConcentration() is the single, real fallback chain this task specifies, tried
// in order until one produces usable evidence:
//   1. a cached fresh holder snapshot for the SAME (chainSlug, mintAddress) pair — never another
//      chain's or another mint's data (see isCacheEntryValid below).
//   2. Helius's token-accounts endpoint (fetchHeliusTopAccounts, solanaProviders.ts), when
//      ENABLE_HELIUS_SOLANA/HELIUS_API_KEY are configured.
//   3. Solana RPC getTokenLargestAccounts (the existing, already-retried primary source).
//   4. a supply-only degrade: if the mint's total supply is confirmed but no top-account list
//      could be read from either provider, that is reported honestly as 'partial' evidence (some
//      real data — the mint exists and has a known supply — is still better than nothing), never
//      upgraded to a fabricated concentration percentage.
//   5. an honest failure, with a clean public-safe reason and the real technical reason kept
//      separate for debug/admin use only.
//
// HARD RULE, DISCLOSED: no code path in this file ever returns a percentage without real
// numerator/denominator evidence — every early-return before a percentage is computed uses `null`
// for top1Percent/top10Percent/top20Percent, never `0`. A 0% concentration would read as "supply is
// perfectly distributed," a claim this resolver has no evidence for when it hasn't actually read
// any accounts.

import { getTokenCache, setTokenCache } from '../cache/tokenCache.ts'
import { fetchHeliusTopAccounts } from '../solanaProviders.ts'
import { solanaRpc, type RpcFetch } from './rpcClient.ts'
import type { SolanaTopAccountShare } from './types.ts'

export type SolanaHolderConcentrationStatus =
  | 'verified'
  | 'partial'
  | 'provider_unavailable'
  | 'rpc_failed'
  | 'not_returned'

export type SolanaHolderConcentrationSource = 'cache' | 'helius' | 'rpc_largest_accounts' | 'supply_only' | 'none'

export interface SolanaHolderConcentrationResult {
  status: SolanaHolderConcentrationStatus
  topAccounts: SolanaTopAccountShare[]
  top1Percent: number | null
  top10Percent: number | null
  top20Percent: number | null
  /** Exact base-unit total supply, when known — string to avoid precision loss on large u64 supplies. */
  totalSupply: string | null
  source: SolanaHolderConcentrationSource
  confidence: 'high' | 'medium' | 'low'
  /** Clean, public-safe explanation — always present when status !== 'verified'. Never a raw RPC/provider error string. */
  publicReason: string | null
  /** Raw provider/RPC error detail (e.g. "rpc_error:Internal error") — debug/admin surfaces only, never sent to public UI. */
  technicalReason: string | null
}

export interface SolanaHolderConcentrationAudit {
  mintAddress: string
  cacheHit: boolean
  heliusAttempted: boolean
  heliusStatus: string
  rpcLargestAccountsAttempted: boolean
  rpcLargestAccountsStatus: string
  totalSupplyStatus: 'known' | 'unknown'
  selectedSource: SolanaHolderConcentrationSource
  holderStatus: SolanaHolderConcentrationStatus
  topAccountsCount: number
  publicReason: string | null
  technicalReason: string | null
  confidenceImpact: 'none' | 'reduced' | 'severely_reduced'
}

const CACHE_VERSION = 'v1'
const CACHE_TTL_SECONDS = 90

export function solanaHolderConcentrationCacheKey(chainSlug: 'solana', mintAddress: string): string {
  return `solana:holderConcentration:${CACHE_VERSION}:${chainSlug}:${mintAddress.toLowerCase()}`
}

const PUBLIC_NOT_RETURNED_REASON = 'Top token accounts were not returned by the Solana provider this scan.'
const PUBLIC_UNAVAILABLE_REASON = 'Holder concentration unavailable — Solana provider did not return top token accounts.'

function computeConcentration(
  accounts: Array<{ address: string; amountRaw: string }>,
  rawSupply: number | null,
  rawSupplyExact?: string | null,
): { top1Percent: number | null; top10Percent: number | null; top20Percent: number | null; topAccounts: SolanaTopAccountShare[] } {
  const ZERO = BigInt(0)
  const rawSupplyBig = (() => {
    if (rawSupplyExact) {
      try {
        const v = BigInt(rawSupplyExact)
        if (v > ZERO) return v
      } catch {
        /* fall through to the lossy number below */
      }
    }
    return rawSupply != null && rawSupply > 0 ? BigInt(Math.trunc(rawSupply)) : null
  })()
  const pct = (sumRaw: bigint): number | null =>
    rawSupplyBig != null && rawSupplyBig > ZERO
      ? Math.round(Number((sumRaw * BigInt(1000000)) / rawSupplyBig)) / 10000
      : null
  const rawAmounts = accounts.map((a) => {
    try {
      return BigInt(a.amountRaw)
    } catch {
      return ZERO
    }
  })
  const sumOf = (n: number) => rawAmounts.slice(0, n).reduce((s, v) => s + v, ZERO)
  return {
    top1Percent: pct(sumOf(1)),
    top10Percent: pct(sumOf(10)),
    top20Percent: pct(sumOf(20)),
    topAccounts: accounts.slice(0, 20).map((a, i) => ({
      rank: i + 1,
      address: a.address,
      amountRaw: a.amountRaw,
      percentOfSupply: pct(rawAmounts[i] ?? ZERO),
    })),
  }
}

// CHAIN/MINT-STRICT CACHE READ, DISCLOSED (hard rule test: "cached holder snapshot is chain/mint
// strict"): even though the cache KEY already scopes to (chainSlug, mintAddress), this re-validates
// the cached VALUE's own recorded fields against the current request before trusting it — the same
// defense-in-depth pattern already used for Token Scanner's chain-strictness cache
// (lib/tokenScannerChainStrictness.ts's isCacheHitValid) — so a hypothetical key collision or a
// stale/mismatched cached shape can never leak another mint's concentration numbers into this scan.
function isCacheEntryValid(
  cached: { mintAddress?: string; chainSlug?: string } | null,
  mintAddress: string,
  chainSlug: 'solana',
): boolean {
  if (!cached) return false
  return cached.mintAddress?.toLowerCase() === mintAddress.toLowerCase() && cached.chainSlug === chainSlug
}

export async function resolveSolanaHolderConcentration(params: {
  mintAddress: string
  chainSlug: 'solana'
  rpcUrl: string
  fetchImpl: RpcFetch
  rawSupply: number | null
  rawSupplyExact?: string | null
  /** Optional in-process snapshot the caller already has (e.g. from the same scan's earlier read) — checked before this resolver does its own KV lookup. */
  cachedSnapshot?: (SolanaHolderConcentrationResult & { mintAddress: string; chainSlug: 'solana' }) | null
}): Promise<{ result: SolanaHolderConcentrationResult; audit: SolanaHolderConcentrationAudit }> {
  const { mintAddress, chainSlug, rpcUrl, fetchImpl, rawSupply, rawSupplyExact } = params
  const totalSupply = rawSupplyExact ?? (rawSupply != null && rawSupply > 0 ? String(Math.trunc(rawSupply)) : null)
  const totalSupplyStatus: 'known' | 'unknown' = totalSupply != null ? 'known' : 'unknown'
  const cacheKey = solanaHolderConcentrationCacheKey(chainSlug, mintAddress)

  let heliusAttempted = false
  let heliusStatus = 'not_attempted'
  let rpcLargestAccountsAttempted = false
  let rpcLargestAccountsStatus = 'not_attempted'

  // ── Step 1: cached fresh holder snapshot for the SAME mint ─────────────────────────────────
  const providedSnapshot = params.cachedSnapshot && isCacheEntryValid(params.cachedSnapshot, mintAddress, chainSlug)
    ? params.cachedSnapshot
    : null
  const storedSnapshot = providedSnapshot
    ? null
    : await getTokenCache<SolanaHolderConcentrationResult & { mintAddress: string; chainSlug: 'solana' }>(cacheKey).catch(() => null)
  const cached = providedSnapshot ?? (isCacheEntryValid(storedSnapshot, mintAddress, chainSlug) ? storedSnapshot : null)
  if (cached && (cached.status === 'verified' || cached.status === 'partial') && cached.topAccounts.length > 0) {
    const result: SolanaHolderConcentrationResult = {
      status: cached.status,
      topAccounts: cached.topAccounts,
      top1Percent: cached.top1Percent,
      top10Percent: cached.top10Percent,
      top20Percent: cached.top20Percent,
      totalSupply: cached.totalSupply ?? totalSupply,
      source: 'cache',
      confidence: cached.confidence,
      publicReason: cached.publicReason,
      technicalReason: null,
    }
    return {
      result,
      audit: {
        mintAddress, cacheHit: true, heliusAttempted, heliusStatus, rpcLargestAccountsAttempted, rpcLargestAccountsStatus,
        totalSupplyStatus, selectedSource: 'cache', holderStatus: result.status, topAccountsCount: result.topAccounts.length,
        publicReason: result.publicReason, technicalReason: null, confidenceImpact: 'none',
      },
    }
  }

  // ── Step 2: Helius token-accounts endpoint, if configured ──────────────────────────────────
  heliusAttempted = true
  const helius = await fetchHeliusTopAccounts(mintAddress, fetchImpl)
  heliusStatus = helius.called ? (helius.success ? 'ok' : 'failed') : 'not_configured'
  if (helius.success && helius.accounts.length > 0) {
    const conc = computeConcentration(helius.accounts, rawSupply, rawSupplyExact)
    const status: SolanaHolderConcentrationStatus = helius.isLowerBound ? 'partial' : 'verified'
    const result: SolanaHolderConcentrationResult = {
      status,
      topAccounts: conc.topAccounts,
      top1Percent: conc.top1Percent,
      top10Percent: conc.top10Percent,
      top20Percent: conc.top20Percent,
      totalSupply,
      source: 'helius',
      confidence: helius.isLowerBound ? 'medium' : 'high',
      publicReason: helius.isLowerBound ? 'Top accounts reflect the first page of Solana holder data — this mint may have more accounts than sampled.' : null,
      technicalReason: null,
    }
    await setTokenCache(cacheKey, { ...result, mintAddress, chainSlug }, CACHE_TTL_SECONDS).catch(() => {})
    return {
      result,
      audit: {
        mintAddress, cacheHit: false, heliusAttempted, heliusStatus, rpcLargestAccountsAttempted, rpcLargestAccountsStatus,
        totalSupplyStatus, selectedSource: 'helius', holderStatus: status, topAccountsCount: result.topAccounts.length,
        publicReason: result.publicReason, technicalReason: null, confidenceImpact: status === 'partial' ? 'reduced' : 'none',
      },
    }
  }

  // ── Step 3: Solana RPC getTokenLargestAccounts ──────────────────────────────────────────────
  rpcLargestAccountsAttempted = true
  type LargestResp = { value?: Array<{ address?: string; amount?: string }> }
  const largest = await solanaRpc<LargestResp>(rpcUrl, 'getTokenLargestAccounts', [mintAddress], fetchImpl, 9000, 2)
  rpcLargestAccountsStatus = largest.ok ? 'ok' : largest.error
  if (largest.ok && Array.isArray(largest.result?.value) && largest.result.value.length > 0) {
    // ADDRESS-OPTIONAL, DISCLOSED: getTokenLargestAccounts rows are keyed by pubkey but this
    // engine's own established convention (see the pre-existing inline computation this replaced)
    // never required `address` to filter a row IN — only `amount` is load-bearing for computing a
    // real percentage. Filtering out rows with no address would silently drop real balance data
    // from the concentration sum, undercounting top1/top10/top20 without any evidence gap raised.
    const accounts = largest.result.value
      .filter((r): r is { address?: string; amount: string } => typeof r.amount === 'string')
      .map((r) => ({ address: typeof r.address === 'string' ? r.address : '', amountRaw: r.amount }))
    // NO-FABRICATED-ZERO GUARD, DISCLOSED: only compute (and cache) a concentration result when
    // there is at least one real account balance to sum — an empty `accounts` array here (every raw
    // row failed the `amount` shape check) must fall through to steps 4/5 below, never compute a
    // top1Percent of 0 against zero real evidence.
    if (accounts.length > 0) {
      const conc = computeConcentration(accounts, rawSupply, rawSupplyExact)
      const result: SolanaHolderConcentrationResult = {
        status: 'verified',
        topAccounts: conc.topAccounts,
        top1Percent: conc.top1Percent,
        top10Percent: conc.top10Percent,
        top20Percent: conc.top20Percent,
        totalSupply,
        source: 'rpc_largest_accounts',
        confidence: 'high',
        publicReason: null,
        technicalReason: null,
      }
      await setTokenCache(cacheKey, { ...result, mintAddress, chainSlug }, CACHE_TTL_SECONDS).catch(() => {})
      return {
        result,
        audit: {
          mintAddress, cacheHit: false, heliusAttempted, heliusStatus, rpcLargestAccountsAttempted, rpcLargestAccountsStatus,
          totalSupplyStatus, selectedSource: 'rpc_largest_accounts', holderStatus: 'verified', topAccountsCount: result.topAccounts.length,
          publicReason: null, technicalReason: null, confidenceImpact: 'none',
        },
      }
    }
  }

  const technicalReason = [
    heliusAttempted && !helius.success ? `helius:${helius.errorReason ?? 'unknown'}` : null,
    rpcLargestAccountsAttempted && !largest.ok ? `rpc:${largest.error}` : null,
  ].filter((v): v is string => v !== null).join('; ') || null

  // ── Step 4: supply-only degrade — some real evidence (the mint's total supply) even without accounts ──
  if (totalSupplyStatus === 'known') {
    const result: SolanaHolderConcentrationResult = {
      status: 'partial',
      topAccounts: [],
      top1Percent: null,
      top10Percent: null,
      top20Percent: null,
      totalSupply,
      source: 'supply_only',
      confidence: 'low',
      publicReason: PUBLIC_NOT_RETURNED_REASON,
      technicalReason,
    }
    return {
      result,
      audit: {
        mintAddress, cacheHit: false, heliusAttempted, heliusStatus, rpcLargestAccountsAttempted, rpcLargestAccountsStatus,
        totalSupplyStatus, selectedSource: 'supply_only', holderStatus: 'partial', topAccountsCount: 0,
        publicReason: PUBLIC_NOT_RETURNED_REASON, technicalReason, confidenceImpact: 'reduced',
      },
    }
  }

  // ── Step 5: honest failure — clean public reason, real reason kept debug-only ──────────────
  const status: SolanaHolderConcentrationStatus =
    heliusAttempted && rpcLargestAccountsAttempted && !helius.success && !largest.ok
      ? 'provider_unavailable'
      : rpcLargestAccountsAttempted && !largest.ok
        ? 'rpc_failed'
        : 'not_returned'
  const result: SolanaHolderConcentrationResult = {
    status,
    topAccounts: [],
    top1Percent: null,
    top10Percent: null,
    top20Percent: null,
    totalSupply: null,
    source: 'none',
    confidence: 'low',
    publicReason: PUBLIC_UNAVAILABLE_REASON,
    technicalReason,
  }
  return {
    result,
    audit: {
      mintAddress, cacheHit: false, heliusAttempted, heliusStatus, rpcLargestAccountsAttempted, rpcLargestAccountsStatus,
      totalSupplyStatus, selectedSource: 'none', holderStatus: status, topAccountsCount: 0,
      publicReason: PUBLIC_UNAVAILABLE_REASON, technicalReason, confidenceImpact: 'severely_reduced',
    },
  }
}
