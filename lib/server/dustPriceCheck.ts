// lib/server/dustPriceCheck.ts — cheap, cached, CURRENT-price-only lookup used exclusively to
// decide upstream dust-suppression eligibility in src/pipeline/index.ts, before priceLotsForWallet
// is called.
//
// DELIBERATELY INDEPENDENT OF pricingAtTimeEngine'S OWN SOURCES, DISCLOSED: the task explicitly
// forbids this cheap check from using bisects, poolPrice/slot0, GoldRush, or "fallback pricing" —
// i.e. it must not be (or depend on) src/modules/pricingAtTimeEngine/sources/{basedex,
// goldrushPriceSource,multiProviderPriceSource,dexscreener}.ts, all of which live under the
// protected src/modules/* tree and are what "fallback pricing" refers to. This file calls
// DexScreener's public token-pairs endpoint directly, via its own standalone fetch — the exact same
// real, public, no-API-key endpoint app/api/radar/route.ts's getDexMarketCapRescue() already calls
// for an unrelated feature (Base Radar), and the same one src/modules/pricingAtTimeEngine/sources/
// dexscreener.ts itself wraps — but this is a fresh, separate implementation, not an import of or
// dependency on that protected module, matching this codebase's existing "no runtime coupling
// between modules, keep your own literal copy" convention (see providerFetchWindow/recoveryPolicy/
// holdings' own independently-duplicated GOLDRUSH_VERIFIED_CHAIN_SLUGS for precedent).
//
// CURRENT PRICE ONLY, NEVER HISTORICAL: DexScreener's public API only exposes live pair state, not
// a historical/candle endpoint — this function is only ever used to answer "does ANY market exist
// for this token right now, and if so, what's it worth", never to price a specific past trade.
//
// NEVER FEEDS FIFO/PNL/COST BASIS, DISCLOSED: this module's result is consumed ONLY by
// src/pipeline/index.ts's dust-suppression decision (isSuppressibleDustToken) — it is not, and must
// never be, wired into priceUsdLookup/currentPriceUsdLookup, matchedLots, or evidenceMissingCount.
//
// RESIDUAL RISK, HONESTLY DISCLOSED (not hidden): a token DexScreener has no listing for is not
// PROVABLY worthless — it's possible (though rare in practice) GoldRush's date-indexed historical
// data or basedex's on-chain pool search would have found real value DexScreener doesn't index.
// Suppressing based on this cheap signal accepts that narrow, disclosed risk in exchange for
// skipping the full historical pricing pass for genuinely-dust tokens (the overwhelming majority of
// airdrop-only, zero-real-market spam tokens). This is the real, accepted tradeoff of doing a cheap
// upstream check at all — it cannot be "byte-for-byte identical in literally every possible case"
// the way the display-only, post-hoc suppression (already shipped) provably is; only "identical for
// every case this session's tests can exercise, safe-by-construction for the overwhelming majority."

import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'

const DEXSCREENER_CHAIN_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  // hyperevm intentionally omitted — no verified DexScreener chainId confirmed for it (matching
  // this codebase's existing convention elsewhere: never guess an unverified provider slug).
}

const CHEAP_PRICE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes — matches this codebase's existing
// negative-cache TTL convention (goldrushPriceSource.ts, basedex.ts) for the same reason: a token
// with no market now could get one later, so this is a bounded delay, never a permanent verdict.

export type CheapDustPriceResult = {
  hasAnyPriceSource: boolean
  priceUsdPerToken: number | null
}

const cheapPriceCache = new Map<string, { value: CheapDustPriceResult; expiresAt: number }>()
const inFlightLookups = new Map<string, Promise<CheapDustPriceResult>>()

// TEST-SUPPORT EXPORT, DISCLOSED: same reasoning as this codebase's other cache modules
// (__resetBaseDexCachesForTest, __resetGoldrushPriceSourceCachesForTest) — lets a test start each
// case from a clean cache state. Not called anywhere in real request handling.
export function __resetDustPriceCheckCacheForTest(): void {
  cheapPriceCache.clear()
  inFlightLookups.clear()
}

// Never throws, never fabricates a price: any failure (unverified chain, network error, non-OK
// response, unparseable body, no matching pair) resolves to { hasAnyPriceSource: false,
// priceUsdPerToken: null } — the same "no evidence found" shape callers already treat as "unknown,
// don't suppress" unless every other dust-eligibility condition also independently holds.
export async function getCheapCurrentPriceForDustCheck(
  tokenAddress: string,
  chain: SupportedChain,
): Promise<CheapDustPriceResult> {
  const key = `${chain}:${tokenAddress.toLowerCase()}`

  const cached = cheapPriceCache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.value

  const inFlight = inFlightLookups.get(key)
  if (inFlight) return inFlight

  const lookup = (async (): Promise<CheapDustPriceResult> => {
    const chainId = DEXSCREENER_CHAIN_IDS[chain]
    if (!chainId) {
      const result: CheapDustPriceResult = { hasAnyPriceSource: false, priceUsdPerToken: null }
      cheapPriceCache.set(key, { value: result, expiresAt: Date.now() + CHEAP_PRICE_CACHE_TTL_MS })
      return result
    }

    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4_000), // short timeout — this is a cheap, best-effort check,
        // never worth blocking the pipeline on; a timeout resolves to "no evidence found" below.
      })
      if (!res.ok) {
        const result: CheapDustPriceResult = { hasAnyPriceSource: false, priceUsdPerToken: null }
        cheapPriceCache.set(key, { value: result, expiresAt: Date.now() + CHEAP_PRICE_CACHE_TTL_MS })
        return result
      }

      const data = (await res.json()) as {
        pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }>
      }
      const candidates = (data.pairs ?? []).filter((p) => p.chainId === chainId && p.priceUsd)
      if (candidates.length === 0) {
        const result: CheapDustPriceResult = { hasAnyPriceSource: false, priceUsdPerToken: null }
        cheapPriceCache.set(key, { value: result, expiresAt: Date.now() + CHEAP_PRICE_CACHE_TTL_MS })
        return result
      }

      const best = candidates.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a))
      const price = Number(best.priceUsd)
      const result: CheapDustPriceResult = Number.isFinite(price)
        ? { hasAnyPriceSource: true, priceUsdPerToken: price }
        : { hasAnyPriceSource: false, priceUsdPerToken: null }
      cheapPriceCache.set(key, { value: result, expiresAt: Date.now() + CHEAP_PRICE_CACHE_TTL_MS })
      return result
    } catch {
      // Network error/timeout — deliberately NOT cached (same reasoning as
      // goldrushPriceSource.ts's own catch block: a transient failure says nothing about whether
      // this token genuinely has no market, so caching it as "no price" could wrongly suppress a
      // token that would resolve fine a moment later).
      return { hasAnyPriceSource: false, priceUsdPerToken: null }
    }
  })()

  inFlightLookups.set(key, lookup)
  try {
    return await lookup
  } finally {
    inFlightLookups.delete(key)
  }
}
