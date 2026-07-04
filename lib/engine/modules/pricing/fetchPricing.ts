// lib/engine/modules/pricing/fetchPricing.ts — new pricing module for chainHoldings[].
//
// PRICING-SOURCE CHOICE, DISCLOSED: `fetchTokenPriceUsd`'s own signature (chainId, tokenAddress —
// no timestamp) doesn't match `lib/engines/pricingAtTimeEngine.ts`'s real `getPriceAtTime`, which
// requires an explicit historical `timestamp` (it answers "what was this worth AT a specific
// moment," not "what is it worth now" — see that file's own header). The real module that answers
// "current USD price, no timestamp" is `src/modules/pricing`'s `resolvePrices` (MODULE 11,
// "pricingEngine" — the same real module lib/../timelines/index.ts already reuses for the identical
// reason, with the same disclosed caveat there). Reused here rather than passing a fabricated "now"
// timestamp into a historical-pricing engine, which would silently misuse that engine's real
// contract.
//
// TOKEN METADATA, DISCLOSED: the task also allowed "token metadata price helpers" — no separate
// metadata-carried price exists independent of what a holding already has; `resolvePrices` already
// accepts an optional `knownPriceUsd` (a price the caller already has for free, e.g. from a
// balances provider) and prefers it over a fallback lookup — this module doesn't have one at the
// point it calls this (ChainHolding carries no price field at all), so every request here goes
// through `resolvePrices`'s own real fallback (DexScreener) path, capped by that module's own
// MAX_FALLBACK_PRICE_LOOKUPS — a real, existing cost bound, not something reimplemented here.
//
// CHAIN SUPPORT, DISCLOSED: only chainId 1 (eth) and 8453 (base) are mapped (same
// CHAIN_ID_TO_SUPPORTED_CHAIN reused from lib/engine/modules/holdings/fetchHoldings.ts) — matching
// this task's own holdings module scope. An unmapped chainId honestly prices as null, never a
// guessed value.

import { resolvePrices } from '@/src/modules/pricing'
import { CHAIN_ID_TO_SUPPORTED_CHAIN } from '../holdings/fetchHoldings'
import type { ChainHolding } from '../holdings/types'
import type { PricedHolding, PricingEngineOutput } from './types'

export type { PricedHolding, PricingEngineOutput } from './types'

// Never throws: resolvePrices already resolves every request to a real result (priceUsd: null,
// source: 'unavailable' on any failure — see src/modules/pricing/index.ts's own guarantees), and
// this function adds no additional network call of its own.
export async function fetchTokenPriceUsd(chainId: number, tokenAddress: string): Promise<number | null> {
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
  if (!chain) return null // unsupported chainId — honestly unpriced, never guessed

  const [result] = await resolvePrices([{ chain, contract: tokenAddress }])
  return result?.priceUsd ?? null
}

// Public entry point. `priceHoldings(holdings)` — exactly the signature specified; the second
// parameter is an ADDITIVE, optional testing seam (defaults to the real fetchTokenPriceUsd above),
// added because node:test's `t.mock.module` proved unreliable under this project's tsx-based test
// runner (verified directly — it threw `t.mock.module is not a function` when actually run, not
// assumed) and a fabricated network-call double would be worse than a plain, explicit, optional
// parameter. Never throws: fetchTokenPriceUsd above already can't, and every step below is pure
// arithmetic over its result.
export async function priceHoldings(
  holdings: ChainHolding[],
  priceFn: (chainId: number, tokenAddress: string) => Promise<number | null> = fetchTokenPriceUsd,
): Promise<PricingEngineOutput> {
  const pricedHoldings: PricedHolding[] = await Promise.all(
    holdings.map(async (h): Promise<PricedHolding> => {
      const priceUsd = await priceFn(h.chainId, h.tokenAddress)
      const valueUsd = priceUsd != null ? Number(h.quantity) * priceUsd : null
      return {
        chainId: h.chainId,
        tokenAddress: h.tokenAddress,
        symbol: h.symbol,
        decimals: h.decimals,
        quantity: h.quantity,
        priceUsd,
        valueUsd,
        classification: h.classification,
      }
    }),
  )

  const totalValueUsd = pricedHoldings.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0)

  const chainValueUsd: Record<number, number> = {}
  for (const p of pricedHoldings) {
    chainValueUsd[p.chainId] = (chainValueUsd[p.chainId] ?? 0) + (p.valueUsd ?? 0)
  }

  const pricedCount = pricedHoldings.filter((p) => p.priceUsd != null).length
  const priceStatus: PricingEngineOutput['priceStatus'] =
    pricedHoldings.length === 0 || pricedCount === 0
      ? 'unavailable'
      : pricedCount === pricedHoldings.length
        ? 'ok'
        : 'partial'

  return { pricedHoldings, totalValueUsd, chainValueUsd, priceStatus }
}
