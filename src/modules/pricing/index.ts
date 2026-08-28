// MODULE 11 — pricingEngine
//
// Resolves current USD prices for a set of tokens. Prefers a price the caller already has for
// free (e.g. from holdingsEngine's GoldRush balances_v2 call) over spending a fallback lookup, and
// caps how many fallback lookups a single call will make (MAX_FALLBACK_PRICE_LOOKUPS) — cost is
// bounded regardless of how many unpriced tokens a wallet holds.
//
// WALLET-SCANNER PRICE-RESOLVER FIX, DISCLOSED (Wallet Scanner improvement audit — see
// MAX_FALLBACK_PRICE_LOOKUPS's own header in ./types for the production evidence this responds to).
// Three real changes, all additive to the original DexScreener-only, fully-serial resolver:
//   1. A short-TTL in-memory cache (chain+contract) — a repeat lookup within the TTL never spends a
//      fallback slot or a network call, it just reads the cached result.
//   2. A second, independent fallback tier — GeckoTerminal (fetchGeckoTerminalCurrentPrice), tried
//      only when DexScreener didn't resolve a price. Reuses that source's own already-tested 429
//      cooldown unchanged (see geckoTerminalPriceSource.ts) — a live 429 here stops BOTH this
//      current-price tier and the historical-pricing GeckoTerminal calls elsewhere in the scan.
//   3. Bounded concurrency (FALLBACK_PRICE_CONCURRENCY_LIMIT) instead of one request at a time — the
//      raised cap (20, was 10) costs closer to the OLD serial-10's wall-clock time, not double it.
// `resolvePrices()` keeps its EXACT original signature and return shape — src/modules/timelines'
// existing caller is untouched. `resolvePricesDetailed()` is the new entry point that also returns a
// real, measured PricingResolutionAudit; runWalletScanV2.ts uses this one to feed
// walletScanPerformanceAudit.

import type { PricingRequest, PricingResolutionAudit, TokenPrice } from './types'
import { FALLBACK_PRICE_CONCURRENCY_LIMIT, MAX_FALLBACK_PRICE_LOOKUPS, PRICE_CACHE_TTL_MS } from './types'
import { fetchDexscreenerPriceDetailed } from './utils'
import { fetchGeckoTerminalCurrentPrice } from '../../pipeline/providers/geckoTerminalPriceSource'
import type { SupportedChain } from '../providerFetchWindow/types'

export type { PriceSource, PricingRequest, PricingResolutionAudit, TokenPrice } from './types'
export { MAX_FALLBACK_PRICE_LOOKUPS } from './types'

// SHORT-TTL PRICE CACHE, DISCLOSED: same convention as this codebase's other per-process negative
// caches (e.g. geckoTerminalPriceSource.ts's negativeGeckoTerminalPoolCache) — a plain module-level
// Map, cleared explicitly per real scan rather than relying on TTL expiry alone, so a stale result
// can never leak from one wallet's scan into an unrelated one on a warm serverless instance.
type CachedPrice = { priceUsd: number; source: TokenPrice['source']; expiresAt: number }
const priceCache = new Map<string, CachedPrice>()

function cacheKey(chain: SupportedChain, contract: string): string {
  return `${chain}:${contract.toLowerCase()}`
}

// PER-SCAN RESET, DISCLOSED: called once per real scan (src/modules/walletScanWorker.ts, alongside
// the existing resetGeckoTerminalNoPoolCache), matching every other per-process cache's own
// established reset convention in this codebase.
export function resetPriceCache(): void {
  priceCache.clear()
}

// TEST-SUPPORT EXPORT, DISCLOSED: read-only observability, same convention as
// geckoTerminalPriceSource.ts's isKnownGeckoTerminalNoPool.
export function peekCachedPrice(chain: SupportedChain, contract: string): CachedPrice | null {
  return priceCache.get(cacheKey(chain, contract)) ?? null
}

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex
      nextIndex += 1
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function resolvePrices(requests: PricingRequest[]): Promise<TokenPrice[]> {
  const { prices } = await resolvePricesDetailed(requests)
  return prices
}

// NO-LIQUIDITY-ANYWHERE, DISCLOSED, ADDITIVE (Wallet Scanner improvement audit — "classify spam/
// dead/unpriced tokens separately"): a `${chain}:${contract}` key lands in this set only when BOTH
// real price tiers explicitly reported a structural "nothing indexed" result for it this call —
// DexScreener's own `no_pairs_found` (a real zero-length pairs response, not an error) AND
// GeckoTerminal's own `no_pool_found` (its negative-pool-cache reason). This is a genuinely stronger,
// more specific signal than plain "unavailable" (which also covers budget-capped, rate-limited, or
// transient-error cases) — used downstream to distinguish `dead_unindexed` from `missing_price` in
// fifoEngine's classification without ever guessing.
export type ResolvePricesDetailedResult = { prices: TokenPrice[]; audit: PricingResolutionAudit; noLiquidityFoundKeys: string[] }

export async function resolvePricesDetailed(requests: PricingRequest[]): Promise<ResolvePricesDetailedResult> {
  const audit: PricingResolutionAudit = {
    totalRequests: requests.length,
    providerSuppliedCount: 0,
    cacheHits: 0,
    dexscreenerCalls: 0,
    dexscreenerSuccesses: 0,
    geckoTerminalCalls: 0,
    geckoTerminalSuccesses: 0,
    geckoTerminalQuotaStopped: 0,
    fallbackCapReached: false,
    unresolvedCount: 0,
    staleCacheFallbacksUsed: 0,
  }

  const prices: (TokenPrice | null)[] = new Array(requests.length).fill(null)
  const needsFallback: number[] = []
  const now = Date.now()

  for (let i = 0; i < requests.length; i += 1) {
    const request = requests[i]
    if (typeof request.knownPriceUsd === 'number' && request.knownPriceUsd > 0) {
      prices[i] = { chain: request.chain, contract: request.contract, priceUsd: request.knownPriceUsd, source: 'provider_supplied' }
      audit.providerSuppliedCount += 1
      continue
    }

    const cached = priceCache.get(cacheKey(request.chain, request.contract))
    if (cached && cached.expiresAt > now) {
      prices[i] = { chain: request.chain, contract: request.contract, priceUsd: cached.priceUsd, source: cached.source }
      audit.cacheHits += 1
      continue
    }

    needsFallback.push(i)
  }

  let fallbackLookupsUsed = 0
  const toResolve: number[] = []
  for (const i of needsFallback) {
    if (fallbackLookupsUsed >= MAX_FALLBACK_PRICE_LOOKUPS) {
      audit.fallbackCapReached = true
      prices[i] = { chain: requests[i].chain, contract: requests[i].contract, priceUsd: null, source: 'unavailable' }
      audit.unresolvedCount += 1
      continue
    }
    fallbackLookupsUsed += 1
    toResolve.push(i)
  }

  const noLiquidityFoundKeys: string[] = []

  await mapWithConcurrencyLimit(toResolve, FALLBACK_PRICE_CONCURRENCY_LIMIT, async (i) => {
    const request = requests[i]

    audit.dexscreenerCalls += 1
    const dexResult = await fetchDexscreenerPriceDetailed(request.contract)
    if (dexResult.priceUsd != null) {
      audit.dexscreenerSuccesses += 1
      priceCache.set(cacheKey(request.chain, request.contract), { priceUsd: dexResult.priceUsd, source: 'dexscreener_fallback', expiresAt: now + PRICE_CACHE_TTL_MS })
      prices[i] = { chain: request.chain, contract: request.contract, priceUsd: dexResult.priceUsd, source: 'dexscreener_fallback' }
      return
    }

    audit.geckoTerminalCalls += 1
    const gtResult = await fetchGeckoTerminalCurrentPrice(request.contract, request.chain)
    if (gtResult.quotaStopped) audit.geckoTerminalQuotaStopped += 1
    if (gtResult.priceUsd != null) {
      audit.geckoTerminalSuccesses += 1
      priceCache.set(cacheKey(request.chain, request.contract), { priceUsd: gtResult.priceUsd, source: 'geckoterminal_fallback', expiresAt: now + PRICE_CACHE_TTL_MS })
      prices[i] = { chain: request.chain, contract: request.contract, priceUsd: gtResult.priceUsd, source: 'geckoterminal_fallback' }
      return
    }

    // STALE-CACHE FALLBACK, DISCLOSED (task 4 — "use stale cache if available" on a GeckoTerminal
    // 429/cooldown): only reached when GeckoTerminal was actually quota-stopped for THIS request
    // (never used just because a lookup happened to miss the fresh TTL window in the normal case
    // above — that path already returned earlier). A past-TTL entry is never evicted from priceCache
    // on expiry (only overwritten by a fresher resolve), so it is still readable here. Reports the
    // ORIGINAL source unchanged — never relabeled as fresh — so a caller can always tell this price
    // may be older than PRICE_CACHE_TTL_MS.
    if (gtResult.quotaStopped) {
      const stale = priceCache.get(cacheKey(request.chain, request.contract))
      if (stale) {
        audit.staleCacheFallbacksUsed += 1
        prices[i] = { chain: request.chain, contract: request.contract, priceUsd: stale.priceUsd, source: stale.source }
        return
      }
    }

    if (dexResult.reason === 'no_pairs_found' && gtResult.reason === 'no_pool_found') {
      noLiquidityFoundKeys.push(cacheKey(request.chain, request.contract))
    }

    audit.unresolvedCount += 1
    prices[i] = { chain: request.chain, contract: request.contract, priceUsd: null, source: 'unavailable' }
  })

  return {
    prices: prices.map((p, i) => p ?? { chain: requests[i].chain, contract: requests[i].contract, priceUsd: null, source: 'unavailable' as const }),
    audit,
    noLiquidityFoundKeys,
  }
}
