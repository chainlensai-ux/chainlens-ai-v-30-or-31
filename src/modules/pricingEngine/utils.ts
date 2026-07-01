// MODULE 11 — pricingEngine: the one network call this module makes — a public, no-key-required
// Dexscreener lookup, used only for tokens with no provider-supplied price. Never invents a price;
// returns null on any failure or when no liquid pair is found.

export async function fetchDexscreenerPrice(contractAddress: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as Record<string, unknown>
    const pairs = Array.isArray(json.pairs) ? (json.pairs as Record<string, unknown>[]) : []
    if (pairs.length === 0) return null

    // Most-liquid pair's current price is the best available approximation from this free source.
    const best = pairs.reduce((a, b) => {
      const aLiq = Number((a.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
      const bLiq = Number((b.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)
      return bLiq > aLiq ? b : a
    })
    const price = Number(best.priceUsd)
    return Number.isFinite(price) && price > 0 ? price : null
  } catch {
    return null
  }
}
