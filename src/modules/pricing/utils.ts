// MODULE 11 — pricingEngine: the one network call this module makes — a public, no-key-required
// Dexscreener lookup, used only for tokens with no provider-supplied price. Never invents a price;
// returns null on any failure or when no liquid pair is found.

export type DexscreenerPriceReason = 'no_pairs_found' | 'http_error' | 'fetch_error' | 'unparseable_price' | 'liquidity_too_low'
export type DexscreenerPriceResult = { priceUsd: number | null; reason: DexscreenerPriceReason | null; liquidityUsd?: number | null }

// LIQUIDITY-VALIDITY GUARD, DISCLOSED (Wallet Scanner second-pass audit, task 2 — "only include if
// price is fresh and liquidity is valid"). A pair with near-zero real liquidity is trivially
// manipulable (a single small trade can move its quoted price arbitrarily) — accepting its price for
// official unrealized PnL would be the same class of risk as accepting an unverified outlier price
// (fifoEngine's own MIN_VALID_CURRENT_PRICE_USD/MAX_VALID_CURRENT_PRICE_USD guard, unchanged, still
// applies downstream). $1,000 is a deliberately low floor — high enough to reject a single-wallet
// fake pool, low enough that a genuine small/micro-cap token with real trading still prices normally.
export const MIN_VALID_LIQUIDITY_USD = 1_000

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
    const liquidityUsd = Number((best.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
    const price = Number(best.priceUsd)
    if (!(Number.isFinite(price) && price > 0)) return { priceUsd: null, reason: 'unparseable_price', liquidityUsd }
    if (!(Number.isFinite(liquidityUsd) && liquidityUsd >= MIN_VALID_LIQUIDITY_USD)) {
      return { priceUsd: null, reason: 'liquidity_too_low', liquidityUsd }
    }
    return { priceUsd: price, reason: null, liquidityUsd }
  } catch {
    return { priceUsd: null, reason: 'fetch_error' }
  }
}

export async function fetchDexscreenerPrice(contractAddress: string): Promise<number | null> {
  const result = await fetchDexscreenerPriceDetailed(contractAddress)
  return result.priceUsd
}
