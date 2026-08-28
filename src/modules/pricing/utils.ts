// MODULE 11 — pricingEngine: the one network call this module makes — a public, no-key-required
// Dexscreener lookup, used only for tokens with no provider-supplied price. Never invents a price;
// returns null on any failure or when no liquid pair is found.

export type DexscreenerPriceReason = 'no_pairs_found' | 'http_error' | 'fetch_error' | 'unparseable_price'
export type DexscreenerPriceResult = { priceUsd: number | null; reason: DexscreenerPriceReason | null }

// DETAILED VARIANT, DISCLOSED, ADDITIVE (Wallet Scanner improvement audit — "classify spam/dead/
// unpriced tokens separately"): `no_pairs_found` is a real, structural signal (DexScreener's own
// response genuinely lists zero pairs for this token) distinct from a transient HTTP/network error —
// used by resolvePricesDetailed to tell "this token has never had a real liquid pair on any indexed
// DEX" apart from "this specific lookup failed." fetchDexscreenerPrice below is unchanged and keeps
// its exact original signature/behavior for any existing caller.
export async function fetchDexscreenerPriceDetailed(contractAddress: string): Promise<DexscreenerPriceResult> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return { priceUsd: null, reason: 'http_error' }
    const json = (await res.json()) as Record<string, unknown>
    const pairs = Array.isArray(json.pairs) ? (json.pairs as Record<string, unknown>[]) : []
    if (pairs.length === 0) return { priceUsd: null, reason: 'no_pairs_found' }

    // Most-liquid pair's current price is the best available approximation from this free source.
    const best = pairs.reduce((a, b) => {
      const aLiq = Number((a.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
      const bLiq = Number((b.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
      return bLiq > aLiq ? b : a
    })
    const price = Number(best.priceUsd)
    return Number.isFinite(price) && price > 0 ? { priceUsd: price, reason: null } : { priceUsd: null, reason: 'unparseable_price' }
  } catch {
    return { priceUsd: null, reason: 'fetch_error' }
  }
}

export async function fetchDexscreenerPrice(contractAddress: string): Promise<number | null> {
  const result = await fetchDexscreenerPriceDetailed(contractAddress)
  return result.priceUsd
}
