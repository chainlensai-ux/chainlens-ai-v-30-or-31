// MODULE 1 — providerFetchWindow: type definitions.
// This module fetches the shallow (80-100 day) base window only. It never deep-pages and never
// fetches receipts outside that window — see Architecture Step 1 / Step 8 §1.
//
// WINDOW EXPANSION (base window 35 -> 90 days, intel window 90 -> 180 days): widened the allowed
// range and default here, and doubled MAX_RAW_EVENTS_PER_PROVIDER / the GoldRush page-size /
// Alchemy maxCount in utils.ts so the single bounded page each provider fetches can still plausibly
// cover the larger window for an active wallet. This module still fetches exactly ONE page per
// provider per chain — "extended pagination" is handled by making that one page wider, not by
// deep-paging, which stays forbidden at this stage (recoveryPolicy remains the only module allowed
// to fetch beyond it).

export type ProviderName = 'goldrush' | 'alchemy'

export type ProviderStatus = 'ok' | 'partial' | 'provider_unavailable'

export type SupportedChain = 'base' | 'eth' | 'arbitrum' | 'hyperevm'

// HyperEVM (Hyperliquid's EVM), per its publicly documented chain registry entry — this is a
// real, verifiable chain ID, not something invented for this codebase.
export const HYPEREVM_CHAIN_ID = 999

// GoldRush (Covalent) and Alchemy do not have a codebase-verified chain slug for HyperEVM (unlike
// base/eth/arbitrum's slugs, which are documented, checkable provider conventions). Rather than
// guess a slug and silently hit a wrong/broken URL, both provider fetchers (utils.ts in this
// module, recoveryPolicy, and holdings) gate on this set and return an honest
// 'chain_not_verified_for_provider' result for any chain not in it — see
// GOLDRUSH_VERIFIED_CHAINS / ALCHEMY_VERIFIED_CHAINS in utils.ts.
//
// TODO: HyperEVM native-RPC-based event fetcher (using HYPEREVM_RPC_URL + eth_getLogs against the
// standard ERC-20 Transfer topic) would let this module fetch real HyperEVM data without GoldRush/
// Alchemy support, but requires a verified HyperEVM block-time/block-range estimate for windowing
// 90 days of blocks, which is not available in this codebase or environment — not built here to
// avoid guessing at a block range and silently mis-windowing the fetch.

// Raw, provider-tagged transfer event. Deliberately NOT normalized yet (no computed `direction`,
// no dedupe applied across providers) — normalization is module 2's responsibility only.
export type RawProviderEvent = {
  provider: ProviderName
  chain: SupportedChain
  txHash: string | null
  timestamp: string | null
  fromAddress: string | null
  toAddress: string | null
  contract: string | null
  symbol: string | null
  amountRaw: string | null
  tokenDecimals: number | null
}

export type SingleProviderFetchResult = {
  provider: ProviderName
  ok: boolean
  events: RawProviderEvent[]
  errorReason: string | null
}

export type ProviderFetchWindowResult = {
  chain: SupportedChain
  providerStatus: ProviderStatus
  rawEvents: RawProviderEvent[]
  // Additive diagnostic detail — per-provider outcome, so a caller can see *why* providerStatus
  // resolved the way it did without re-deriving it.
  providerResults: {
    goldrush: SingleProviderFetchResult
    alchemy: SingleProviderFetchResult
  }
  providerFetchWindowDays: number
}

// Architecture Step 1: provider fetch window is fixed within [80, 100] days.
export const PROVIDER_FETCH_WINDOW_DAYS_MIN = 80
export const PROVIDER_FETCH_WINDOW_DAYS_MAX = 100
export const PROVIDER_FETCH_WINDOW_DAYS_DEFAULT = 90

// Architecture Step 1/8: base fetch never deep-pages. One bounded page per provider per chain.
// Doubled alongside the window expansion (35->90 days) so the single page can still plausibly
// reach across a wallet's full base window rather than truncating earlier within it.
export const MAX_RAW_EVENTS_PER_PROVIDER = 400
