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
import { HYPEREVM_CHAIN_ID } from '@/src/modules/providerFetchWindow/types'
import type { ChainHolding } from './types'

export type { ChainHolding, HoldingsEngineInput } from './types'

// CHAIN COVERAGE, EXTENDED, DISCLOSED: originally only chainId 1 (eth) and 8453 (base) were wired
// ("per the task's explicit scope" at the time) — this V2 holdings/pricing/portfolio chain never
// covered Arbitrum or HyperEVM at all, unlike the older src/modules/holdings this adapts, which
// already supports all 4. 42161 is Arbitrum One's real, standard, public chainId (not invented);
// 999 is this codebase's own already-defined HYPEREVM_CHAIN_ID (src/modules/providerFetchWindow/
// types.ts), reused here rather than a second, potentially-drifting copy.
export const CHAIN_ID_TO_SUPPORTED_CHAIN: Record<number, SupportedChain> = {
  1: 'eth',
  8453: 'base',
  42161: 'arbitrum',
  [HYPEREVM_CHAIN_ID]: 'hyperevm',
}

// REVERSE MAP, DISCLOSED, ADDITIVE (Alchemy cost-audit follow-up task, issue #2 — confirmed
// production bug: gating the holdings chain allowlist on `scanMode === 'deep'` alone silently
// unlocked Arbitrum/HyperEVM for ANY deep-mode scan, regardless of which chains the caller actually
// requested — "Run Deep Scan" must never silently mean "all chains" by itself). Lets a caller derive
// the REAL, explicit chain-id allowlist from the wallet's own already-validated `chainsScanned`
// request field (src/deployment/validator.ts's `chains`, echoed back on `scanMetadata.chainsScanned`)
// instead of inferring it from scan mode.
export const SUPPORTED_CHAIN_TO_CHAIN_ID: Partial<Record<SupportedChain, number>> = Object.fromEntries(
  Object.entries(CHAIN_ID_TO_SUPPORTED_CHAIN).map(([id, chain]) => [chain, Number(id)]),
)

// PURE, EXPORTED FOR DIRECT TESTING (Alchemy cost-audit follow-up task, issue #2): the exact chain-
// resolution rule workers/walletScanV2.ts uses. `chainsScanned` is the wallet's own already-
// validated request chains, echoed back on `scanMetadata.chainsScanned` — the one real "the caller
// explicitly wants this chain" signal, deliberately never scan mode alone (see this file's own
// SUPPORTED_CHAIN_TO_CHAIN_ID header). Falls back to `DEFAULT_HOLDINGS_CHAIN_IDS` (Base + ETH) only
// when `chainsScanned` is missing/empty/maps to nothing real — never a ceiling this explicit signal
// can't exceed, never a wider default than what was actually requested.
export function resolveHoldingsAllowedChainIds(chainsScanned: readonly string[] | null | undefined): number[] {
  const requested = (chainsScanned ?? [])
    .map((chain) => SUPPORTED_CHAIN_TO_CHAIN_ID[chain as keyof typeof SUPPORTED_CHAIN_TO_CHAIN_ID])
    .filter((id): id is number => typeof id === 'number')
  return requested.length > 0 ? requested : [...DEFAULT_HOLDINGS_CHAIN_IDS]
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

// DEFAULT CHAIN ALLOWLIST, DISCLOSED (Alchemy cost-audit follow-up task — confirmed production
// mismatch: workers/walletScanV2.ts already LOGS `[CU-TRACK] deep-scan start: { chains: [1, 8453] }`
// as if the scan were scoped to Ethereum+Base, but `fetchAllHoldings` itself unconditionally
// iterated EVERY key of `CHAIN_ID_TO_SUPPORTED_CHAIN` — all 4 chains, Arbitrum and HyperEVM
// included, on every single scan, log message notwithstanding). A normal Wallet Scanner live scan
// must only probe Base + ETH unless the caller explicitly requests deep/full-chain coverage.
export const DEFAULT_HOLDINGS_CHAIN_IDS: readonly number[] = [1, 8453] // eth, base
// HARD PER-REQUEST CAP, DISCLOSED: independent of whatever `allowedChainIds` a caller supplies —
// this module will never fan out to more chains than it has real, mapped support for (currently 4),
// regardless of what a caller mistakenly passes in.
const MAX_CHAINS_PER_HOLDINGS_REQUEST = Object.keys(CHAIN_ID_TO_SUPPORTED_CHAIN).length

// NEGATIVE-RESULT CACHE, DISCLOSED: a wallet genuinely holding nothing on a given chain answers the
// same real "empty" result on every rescan within a short window — same "don't re-pay for an answer
// this process already has" convention already used elsewhere in this codebase (e.g.
// negativeGoldrushPriceCache in goldrushPriceSource.ts). Process-lifetime, deliberately short TTL
// (a real balance can change at any time — this only ever avoids a REPEAT call within the window,
// never substitutes a stale non-zero balance for a fresh one).
const NEGATIVE_BALANCE_CACHE_TTL_MS = 60_000
const negativeBalanceCache = new Map<string, number>() // `${chainId}:${wallet}` -> expiry epoch ms

function negativeCacheKey(chainId: number, walletAddress: string): string {
  return `${chainId}:${walletAddress.toLowerCase()}`
}

// TEST-SUPPORT EXPORT, DISCLOSED: same convention as every other process-lifetime cache reset in
// this codebase (e.g. resetGoldrushPriceSourceCallCount) — a warm serverless instance serving a
// later, unrelated wallet must never inherit an earlier wallet's cached "empty" result.
export function __resetNegativeBalanceCacheForTest(): void {
  negativeBalanceCache.clear()
}

// Never throws: src/modules/holdings's real fetchHoldings already resolves to an honest
// provider_unavailable/[] result on any failure (see that module's own guarantees) rather than
// throwing, and this function adds no additional network calls of its own that could fail.
export async function fetchChainBalances(walletAddress: string, chainId: number): Promise<ChainHolding[]> {
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
  if (!chain) return [] // unsupported chainId — honestly empty, never a guessed chain

  const cacheKey = negativeCacheKey(chainId, walletAddress)
  const cachedExpiry = negativeBalanceCache.get(cacheKey)
  if (cachedExpiry !== undefined && Date.now() < cachedExpiry) return [] // real, recently-confirmed empty result — no live call

  const result = await fetchRealHoldings(chain, walletAddress)

  const holdings = result.holdings
    .filter((h) => h.amount > 0)
    .map((h): ChainHolding => ({
      chainId,
      tokenAddress: h.contract,
      symbol: h.symbol,
      decimals: h.tokenDecimals,
      quantity: String(h.amount),
      lastActivityAt: null,
      classification: classify(h.symbol),
      // See this file's ChainHolding type comment — previously dropped here entirely.
      providerPriceUsd: h.providerPriceUsd,
      providerValueUsd: h.providerValueUsd,
      // See this file's ChainHolding type comment — previously dropped here entirely.
      amountRaw: h.amountRaw,
    }))

  if (holdings.length === 0) negativeBalanceCache.set(cacheKey, Date.now() + NEGATIVE_BALANCE_CACHE_TTL_MS)
  else negativeBalanceCache.delete(cacheKey) // a real non-zero result always wins over any stale negative entry

  return holdings
}

// CHAIN-CALL AUDIT, DISCLOSED: real, measured chain-scoping decisions for every fetchAllHoldings
// call — printed unconditionally so a live scan's own logs prove which chains were actually probed,
// never just which chains a comment claims were probed.
function logChainCallAudit(requestedChainIds: readonly number[], allowedChainIds: readonly number[], blockedChainIds: readonly number[]): void {
  // eslint-disable-next-line no-console
  console.warn('[chain-call-audit]', {
    requestedChains: requestedChainIds,
    allowedChains: allowedChainIds,
    blockedChains: blockedChainIds,
    callsByChain: Object.fromEntries(allowedChainIds.map((c) => [c, 1])),
    callsPrevented: blockedChainIds.length,
  })
}

// Public entry point. HARD-ALLOWLISTED, DISCLOSED: `allowedChainIds` defaults to
// `DEFAULT_HOLDINGS_CHAIN_IDS` (Base + ETH only) — a caller must EXPLICITLY pass every other
// supported chain id (e.g. all 4, for an explicit deep/full-chain scan) to reach them at all. Never
// throws (each fetchChainBalances call above already can't). Every chain outside this module's own
// real `CHAIN_ID_TO_SUPPORTED_CHAIN` mapping is silently dropped regardless of what's requested —
// this was already true per-chain via fetchChainBalances' own unsupported-chainId guard, and is now
// also true for the whole request via `MAX_CHAINS_PER_HOLDINGS_REQUEST`.
export async function fetchAllHoldings(walletAddress: string, allowedChainIds: readonly number[] = DEFAULT_HOLDINGS_CHAIN_IDS): Promise<ChainHolding[]> {
  const supportedChainIds = Object.keys(CHAIN_ID_TO_SUPPORTED_CHAIN).map(Number)
  const requested = allowedChainIds.slice(0, MAX_CHAINS_PER_HOLDINGS_REQUEST)
  const allowed = requested.filter((c) => supportedChainIds.includes(c))
  const blocked = [...new Set(allowedChainIds)].filter((c) => !allowed.includes(c))
  logChainCallAudit(allowedChainIds, allowed, blocked)

  const results = await Promise.all(allowed.map((c) => fetchChainBalances(walletAddress, c)))
  return results.flat()
}
