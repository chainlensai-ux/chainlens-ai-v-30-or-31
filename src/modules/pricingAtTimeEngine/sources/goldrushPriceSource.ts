// MODULE — pricingAtTimeEngine/sources: goldrushPriceSource
//
// CORRECTION TO THE REQUESTED SPEC (verified, not assumed): `import { GoldRush } from
// "@goldrush/api"` does not exist — there is no `@goldrush/api` package on the npm registry
// (confirmed via `npm view @goldrush/api`, which 404s). Covalent's actual, official GoldRush
// TypeScript SDK is `@covalenthq/client-sdk` (branded "GoldRush TS SDK" on goldrush.dev),
// exporting a `GoldRushClient` class, not `GoldRush`. Likewise, `gr.token.getHistoricalPrice({
// chain, contract, timestamp})` does not exist on the real client — inspected the published
// package's type declarations directly (PricingService.d.ts) and found no such method. The real,
// verified historical-pricing method is:
//
//   client.PricingService.getTokenPrices(chainName, quoteCurrency, contractAddress, { from, to })
//
// — a DATE-RANGE query (YYYY-MM-DD strings), not a single-millisecond-timestamp lookup, returning
// `GoldRushResponse<TokenPricesResponse[]>` where each response item has an `items: Price[]` array
// (one entry per day in the range), not a flat `{ priceUsd }`. This module adapts our
// PriceSourceFn contract onto the REAL API rather than implementing a method that doesn't exist.
//
// Added @covalenthq/client-sdk@3.0.6 as a real, installed dependency (package.json) — required to
// do this integration at all; there is no way to call a real SDK without it.

import { GoldRushClient } from '@covalenthq/client-sdk'
import type { Chain } from '@covalenthq/client-sdk'
import type { PriceSourceFn } from '../types'
import { logRpcCall } from '@/lib/server/rpcDebug'

// Real, verified GoldRush chain slugs (confirmed against the installed SDK's Generic.types.d.ts
// ChainName enum). Kept as this module's own literal copy — same "no runtime coupling between
// modules" convention providerFetchWindow/recoveryPolicy/holdings already use for their own
// GOLDRUSH_VERIFIED_CHAIN_SLUGS maps — rather than importing theirs.
//
// NOTE: while verifying this, the real SDK's ChainName enum turned out to include
// HYPEREVM_MAINNET = "hyperevm-mainnet" (chain ID 999, matching this codebase's own
// HYPEREVM_CHAIN_ID) — i.e. GoldRush DOES have a verified chain slug for HyperEVM. That contradicts
// the "no verified GoldRush slug for HyperEVM" assumption baked into
// providerFetchWindow/recoveryPolicy/holdings' own GOLDRUSH_VERIFIED_CHAIN_SLUGS maps from an
// earlier task. Not fixed here — out of scope for a pricing-source task — but worth a follow-up:
// those three files' HyperEVM gating could be loosened now that this is verified.
const GOLDRUSH_CHAIN_SLUGS: Record<string, Chain> = {
  eth: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-mainnet',
  hyperevm: 'hyperevm-mainnet',
}

// YYYY-MM-DD, exactly what getTokenPrices' from/to params require. Never infers a missing/invalid
// timestamp — an unparseable input returns null so the caller treats it as "no data", never a
// guessed date.
function toDateString(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs)) return null
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

// Builds a PriceSourceFn backed by a real GoldRushClient instance. Never fabricates a price: an
// unverified chain, an unparseable timestamp, a thrown/error response, or an empty/priceless
// result all resolve to null — never a guessed number.
export function goldrushPriceSource(client: GoldRushClient): PriceSourceFn {
  return async function priceAtTimestamp(token: string, chain: string, timestamp: number): Promise<number | null> {
    const chainSlug = GOLDRUSH_CHAIN_SLUGS[chain]
    if (!chainSlug) return null

    const dateString = toDateString(timestamp)
    if (!dateString) return null

    try {
      logRpcCall({ route: 'pricingAtTimeEngine:goldrushPriceSource', chain, method: 'goldrush_sdk_getTokenPrices' })
      const response = await client.PricingService.getTokenPrices(chainSlug, 'USD', token, {
        from: dateString,
        to: dateString,
      })

      if (response.error || !response.data) return null

      const items = response.data[0]?.items
      if (!Array.isArray(items) || items.length === 0) return null

      const price = items[0]?.price
      return typeof price === 'number' && Number.isFinite(price) ? price : null
    } catch {
      // GoldRush threw (network error, rate limit, invalid API key, etc.) — never a crash, never a
      // fabricated price.
      return null
    }
  }
}
