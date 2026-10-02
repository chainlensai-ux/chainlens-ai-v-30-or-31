// MODULE 10 — holdingsEngine: type definitions.
//
// Fetches CURRENT token balances for a wallet — this is a genuinely separate concern from
// providerFetchWindow (which fetches historical transfer events over a 80-100 day window).
// Current balance cannot be reliably derived from that shallow transfer window alone (a token
// bought before the window would show no buy event but could still be held), so this module
// makes its own single, bounded, per-chain snapshot query. No pagination, no historical depth.

import type { ProviderStatus, SupportedChain } from '../providerFetchWindow/types'

export type TokenHolding = {
  chain: SupportedChain
  contract: string
  symbol: string
  name: string | null
  amount: number
  amountRaw: string | null
  tokenDecimals: number
  // Populated only when the balances provider itself returned a price/value alongside the
  // balance (GoldRush's balances_v2 does, for free, in the same call) — never fabricated here.
  providerPriceUsd: number | null
  providerValueUsd: number | null
  // False when `tokenDecimals` is an ASSUMED default (Alchemy's balance call carries no metadata, so 18 is
  // assumed). Optional: undefined means the provider reported decimals itself. A quantity derived from
  // assumed decimals is never valued and never used to call a holding "dust".
  decimalsKnown?: boolean
}

// Why GoldRush's balances call failed — kept distinct so a transient 5xx is never reported (or cached)
// as an auth/billing problem or a confirmed-empty wallet.
export type GoldrushFailureKind =
  | 'not_configured' // no API key / no verified chain slug
  | 'auth_config' // 401 / 403
  | 'billing' // 402
  | 'rate_limited' // 429
  | 'transient_provider' // 5xx, timeout, network error
  | 'request_rejected' // any other 4xx
  | 'provider_error' // 2xx with an error body / unparseable response

export type HoldingsFetchResult = {
  chain: SupportedChain
  providerStatus: ProviderStatus
  holdings: TokenHolding[]
  // GoldRush's balances call is the only holdings source that includes the NATIVE balance (Alchemy's
  // alchemy_getTokenBalances is ERC-20 only). When it failed, the holdings list cannot be complete.
  nativeBalanceCovered?: boolean
  goldrushFailure?: { kind: GoldrushFailureKind; httpStatus: number | null } | null
}
