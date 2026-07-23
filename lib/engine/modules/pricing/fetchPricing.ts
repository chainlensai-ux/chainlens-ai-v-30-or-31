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
// TOKEN METADATA, UPDATED — PORTFOLIO-INTELLIGENCE $0 BUG FIX, DISCLOSED: this module previously
// never used `resolvePrices`'s own `knownPriceUsd` preference because "ChainHolding carries no
// price field at all" — that was true until lib/engine/modules/holdings/fetchHoldings.ts's own fix
// (same task): ChainHolding now carries `providerPriceUsd`/`providerValueUsd`, populated for free
// by the balances provider (GoldRush's balances_v2 call). `priceHoldings` below now short-circuits
// on that known price BEFORE ever calling `fetchTokenPriceUsd`'s DexScreener-only fallback — this
// was the actual root cause of Portfolio Intelligence showing $0/0 priced tokens for wallets whose
// tokens (e.g. low-liquidity Base tokens) failed that fallback, while the older src/modules/
// holdings-backed "Holdings V2" display showed real values because it never went through this
// weaker second lookup in the first place.
//
// CHAIN SUPPORT, DISCLOSED: chainId 1 (eth), 8453 (base), 42161 (arbitrum), and HYPEREVM_CHAIN_ID
// (999) are now all mapped (same CHAIN_ID_TO_SUPPORTED_CHAIN reused from lib/engine/modules/
// holdings/fetchHoldings.ts, extended there in this same fix). An unmapped chainId still honestly
// prices as null, never a guessed value.

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

// FALLBACK-LOOKUP CONCURRENCY CAP, DISCLOSED (provider-call-audit task): only the holdings that
// genuinely need `priceFn`'s DexScreener-only fallback (no free `providerPriceUsd`) reach this —
// previously ALL of them fired via one unbounded `Promise.all`, so a wallet with dozens of
// low-liquidity tokens with no provider price drove dozens of simultaneous DexScreener HTTP calls
// in one burst. Same bounded-concurrency pattern already used for the historical pricing pass
// (pricingAtTimeEngine/index.ts's PRICE_ENTRY_CONCURRENCY_LIMIT) — zero correctness change, every
// holding still gets the exact same lookup, only how many run AT ONCE changes.
const FALLBACK_PRICE_CONCURRENCY_LIMIT = 10

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

// DUST ELIGIBILITY, DISCLOSED (provider-call-audit follow-up task, confirmed real cause of "very
// large" DexScreener fan-out): every holding lacking a free `providerPriceUsd` was previously
// eligible for the fallback lookup, including obvious dust — a wallet can hold dozens of
// near-zero-quantity or already-known-negligible-value tokens (airdrops, LP dust, failed-swap
// remainders), each burning a real DexScreener call for a price that can never matter to the
// wallet's totals either way. Two REAL signals, never a fabricated one, decide eligibility:
//   1. `providerValueUsd` — when GoldRush's own balances_v2 call already reports SOME USD value
//      (even though `providerPriceUsd` itself didn't pass the `> 0` gate above, e.g. a value present
//      with a zero/negative rate edge case), a value under DUST_VALUE_USD_THRESHOLD is already known
//      to be negligible — no need to ask DexScreener too.
//   2. `quantity` — when there is NO provider value signal at all, an honest, disclosed limitation:
//      true USD-value dust can't be determined without a price (the exact thing being looked up), so
//      this only filters holdings whose human-readable quantity itself is at or near zero
//      (DUST_QUANTITY_FLOOR) — a real, bounded heuristic, not a substitute for an actual valuation.
// A holding this excludes gets priceUsd: null, same as any other honestly-unpriced holding — never
// zero, never fabricated.
const DUST_VALUE_USD_THRESHOLD = 1
const DUST_QUANTITY_FLOOR = 1e-6

function isEligibleForFallbackPricing(h: ChainHolding): boolean {
  if (h.providerPriceUsd != null && h.providerPriceUsd > 0) return false // already has a free price
  if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) return false
  const quantity = Number(h.quantity)
  if (!Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR) return false
  return true
}

// Public entry point. `priceHoldings(holdings)` — exactly the signature specified; the second
// parameter is an ADDITIVE, optional testing seam (defaults to the real fetchTokenPriceUsd above),
// added because node:test's `t.mock.module` proved unreliable under this project's tsx-based test
// runner (verified directly — it threw `t.mock.module is not a function` when actually run, not
// assumed) and a fabricated network-call double would be worse than a plain, explicit, optional
// parameter. Never throws: fetchTokenPriceUsd above already can't, and every step below is pure
// arithmetic over its result.
//
// DEDUPE + BOUNDED FALLBACK, DISCLOSED (provider-call-audit task, confirmed real duplicate-call
// source): holdings sharing the exact same (chainId, tokenAddress) — e.g. the same token tracked
// under two classification buckets — previously each fired their OWN independent `priceFn` call
// for an identical current-price lookup. Deduped here by resolving each distinct (chainId,
// tokenAddress) pair's fallback price exactly ONCE and reusing it across every holding that shares
// it — same real value either way, since it's the same token at the same instant, never a
// fabricated or stale substitute.
export async function priceHoldings(
  holdings: ChainHolding[],
  priceFn: (chainId: number, tokenAddress: string) => Promise<number | null> = fetchTokenPriceUsd,
): Promise<PricingEngineOutput> {
  // Only holdings genuinely eligible for the fallback (no free provider price, not dust) ever reach
  // priceFn — see isEligibleForFallbackPricing's own header for the two real signals used.
  const fallbackKeyOf = (h: ChainHolding) => `${h.chainId}:${h.tokenAddress.toLowerCase()}`
  const providerPriced = holdings.filter((h) => h.providerPriceUsd != null && h.providerPriceUsd > 0)
  const knownUnderDollarSkipped = holdings.filter(
    (h) => !(h.providerPriceUsd != null && h.providerPriceUsd > 0)
      && h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD,
  )
  const quantityDustSkipped = holdings.filter((h) => {
    if (h.providerPriceUsd != null && h.providerPriceUsd > 0) return false
    if (h.providerValueUsd != null && h.providerValueUsd > 0 && h.providerValueUsd < DUST_VALUE_USD_THRESHOLD) return false
    const quantity = Number(h.quantity)
    return !Number.isFinite(quantity) || quantity <= DUST_QUANTITY_FLOOR
  })
  const eligibleHoldings = holdings.filter(isEligibleForFallbackPricing)
  const distinctFallbackKeys = Array.from(new Set(eligibleHoldings.map(fallbackKeyOf)))

  // DIAGNOSTIC, DISCLOSED (provider-call-audit follow-up task, explicit "report before changing
  // thresholds" requirement): real counts only, no behavior change from this log — reports exactly
  // how many holdings fall into each eligibility bucket so a future pass can decide whether the
  // DUST_VALUE_USD_THRESHOLD/DUST_QUANTITY_FLOOR heuristics need adjusting, instead of guessing.
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] DexScreener fallback eligibility', {
    holdingsTotal: holdings.length,
    providerPriced: providerPriced.length,
    knownUnderDollarSkipped: knownUnderDollarSkipped.length,
    quantityDustSkipped: quantityDustSkipped.length,
    fallbackEligible: eligibleHoldings.length,
    uniqueFallbackEligible: distinctFallbackKeys.length,
    timestamp: Date.now(),
  })
  const fallbackPriceByKey = new Map<string, number | null>()
  const resolvedPrices = await mapWithConcurrencyLimit(distinctFallbackKeys, FALLBACK_PRICE_CONCURRENCY_LIMIT, async (key) => {
    const [chainIdStr, tokenAddress] = key.split(':')
    return priceFn(Number(chainIdStr), tokenAddress)
  })
  distinctFallbackKeys.forEach((key, i) => fallbackPriceByKey.set(key, resolvedPrices[i]))

  const pricedHoldings: PricedHolding[] = holdings.map((h): PricedHolding => {
    // Prefer the balances provider's own real, free price (see file header) — only fall through
    // to the weaker, capped, deduped DexScreener-only lookup when the provider genuinely didn't
    // supply one.
    const priceUsd = h.providerPriceUsd != null && h.providerPriceUsd > 0
      ? h.providerPriceUsd
      : fallbackPriceByKey.get(fallbackKeyOf(h)) ?? null
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
  })

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
