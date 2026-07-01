// MODULE 1 — providerFetchWindow: type definitions.
// This module fetches the shallow (30-40 day) base window only. It never deep-pages and never
// fetches receipts outside that window — see Architecture Step 1 / Step 8 §1.

export type ProviderName = 'goldrush' | 'alchemy'

export type ProviderStatus = 'ok' | 'partial' | 'provider_unavailable'

export type SupportedChain = 'base' | 'eth' | 'arbitrum'

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

// Architecture Step 1: provider fetch window is fixed within [30, 40] days.
export const PROVIDER_FETCH_WINDOW_DAYS_MIN = 30
export const PROVIDER_FETCH_WINDOW_DAYS_MAX = 40
export const PROVIDER_FETCH_WINDOW_DAYS_DEFAULT = 35

// Architecture Step 1/8: base fetch never deep-pages. One bounded page per provider per chain.
export const MAX_RAW_EVENTS_PER_PROVIDER = 200
