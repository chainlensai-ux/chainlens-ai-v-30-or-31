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
}

export type HoldingsFetchResult = {
  chain: SupportedChain
  providerStatus: ProviderStatus
  holdings: TokenHolding[]
}
