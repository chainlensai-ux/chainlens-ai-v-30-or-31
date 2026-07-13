// MODULE — fallbackPricing/baseScanClient
//
// Real BaseScan (Etherscan-family, Base network) integration for a CURRENT (not historical) USD
// token price. NEVER FABRICATES: any failure at any step returns null with a structured reason —
// same convention as this codebase's other real price sources (dexscreener.ts, coingecko.ts,
// basedex.ts, providers/geckoTerminalPriceSource.ts).
//
// ENDPOINT UNCERTAINTY, HONESTLY DISCLOSED (same caveat this codebase's own
// providers/geckoTerminalPriceSource.ts already applies to itself): BaseScan does not have a
// well-known, free-tier "arbitrary ERC-20 token USD price" endpoint the way GoldRush/DexScreener
// do. The one documented candidate in Etherscan-family APIs is
// `module=token&action=tokeninfo&contractaddress={address}` (returns a `tokenPriceUSD` field in
// its response for some Etherscan-family explorers) — but this is documented as a "Pro" endpoint
// on Etherscan itself, and BaseScan's own free-tier availability for it is NOT verified from this
// sandbox (no outbound network access to api.basescan.org here). This client calls that real,
// documented shape and treats ANY deviation (missing field, non-numeric value, non-200 response,
// missing API key) as a real, honest miss — never a guessed/fabricated price.
//
// API KEY, DISCLOSED: requires BASESCAN_API_KEY (or ETHERSCAN_API_KEY as an Etherscan-family
// fallback env var, since BaseScan migrated to a unified Etherscan API key system) — when neither
// is configured, this always returns null with 'no_api_key', exactly like this codebase's other
// env-key-gated sources (e.g. src/pipeline/index.ts's buildPriceSources() GoldRush gate).

export type BaseScanPriceResult = { priceUsd: number | null; reason: string | null }

type TokenInfoResponse = {
  status?: string
  message?: string
  result?: Array<{ tokenPriceUSD?: string }>
}

function safeParsedUsdPrice(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

export class BaseScanClient {
  constructor(private readonly apiKey: string | undefined = process.env.BASESCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY) {}

  async getTokenPriceUsd(tokenAddress: string): Promise<number | null> {
    const result = await this.getTokenPriceUsdDetailed(tokenAddress)
    return result.priceUsd
  }

  // Detailed variant — exposed for tests/observability that want the real failure reason, not just
  // null. getTokenPriceUsd above is the literal spec-required signature.
  async getTokenPriceUsdDetailed(tokenAddress: string): Promise<BaseScanPriceResult> {
    if (!this.apiKey) return { priceUsd: null, reason: 'no_api_key' }

    try {
      const url = `https://api.basescan.org/api?module=token&action=tokeninfo&contractaddress=${tokenAddress}&apikey=${this.apiKey}`
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

      const data = (await res.json()) as TokenInfoResponse
      if (data.status !== '1') return { priceUsd: null, reason: data.message ?? 'basescan_status_not_1' }

      const raw = data.result?.[0]?.tokenPriceUSD
      const priceUsd = safeParsedUsdPrice(raw)
      if (priceUsd === null) return { priceUsd: null, reason: 'no_tokenPriceUSD_field' }

      return { priceUsd, reason: null }
    } catch (err) {
      return { priceUsd: null, reason: err instanceof Error ? err.message : 'unknown_error' }
    }
  }
}
