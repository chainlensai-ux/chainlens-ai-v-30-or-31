// MODULE — pricingAtTimeEngine/sources: coingecko
//
// Split out of multiProviderPriceSource.ts for modularization. Logic is unchanged from that file.
//
// Uses CoinGecko's real, documented /coins/{platform}/contract/{address}/market_chart/range
// endpoint, which genuinely supports a historical date range (unlike DexScreener's public API) —
// this is a real price-at-timestamp lookup, not a current-price approximation.

import type { SupportedChain } from '../../providerFetchWindow/types'

const COINGECKO_PLATFORM_IDS: Partial<Record<SupportedChain, string>> = {
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum-one',
  // hyperevm intentionally omitted — not a verified CoinGecko asset platform id.
}

const COINGECKO_RANGE_WINDOW_SECONDS = 24 * 60 * 60 // +/- 1 day around the target timestamp

export type CoingeckoPriceResult = { priceUsd: number | null; reason: string | null }

// SCAN-LEVEL CIRCUIT BREAKER, DISCLOSED (source-retry-avoidance task, explicit "skip CoinGecko
// after the first 429 circuit-breaker event" requirement): CoinGecko's real public API enforces a
// well-known per-minute rate limit. A wallet with many historical recovery candidates fans out many
// of these calls (bounded by this pipeline's own concurrency caps, but still real volume); once the
// first 429 is observed, every rate-limit window for the rest of this scan is already exhausted or
// about to be — retrying is predictably going to keep hitting the same limit, not a genuine
// per-token/per-timestamp question CoinGecko might still answer differently for. Opens on the FIRST
// http_429, stays open until explicitly reset (per-scan, alongside every other per-job reset this
// codebase already applies — see resetCoingeckoCircuitBreaker's own header). NEVER FABRICATES: the
// short-circuited result is the same honest `null` a real rate-limited call would have produced
// anyway, just without paying for the network round-trip first.
let coingeckoCircuitOpen = false

// PER-SCAN RESET, DISCLOSED: same convention as goldrushPriceSource.ts's own
// resetGoldrushPriceSourceCallCount / dexscreener.ts's resetDexscreenerCallCount — called once per
// real scan (src/modules/walletScanWorker.ts) so a warm serverless instance's PREVIOUS scan hitting
// a real 429 never silently disables CoinGecko for an unrelated later scan of a different wallet.
export function resetCoingeckoCircuitBreaker(): void {
  coingeckoCircuitOpen = false
}

// TEST-SUPPORT EXPORT, DISCLOSED: read-only observability, same convention as
// goldrushPriceSource.ts's isGoldrushBreakerOpenForTest.
export function isCoingeckoCircuitOpenForTest(): boolean {
  return coingeckoCircuitOpen
}

// Detailed variant — used by the orchestrator (getPriceAtTime) for structured debug output.
export async function fetchCoingeckoPriceDetailed(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<CoingeckoPriceResult> {
  const platform = COINGECKO_PLATFORM_IDS[chain]
  if (!platform) return { priceUsd: null, reason: 'unverified_chain_for_coingecko' }

  // BREAKER SHORT-CIRCUIT: checked before any network call — see coingeckoCircuitOpen's own
  // declaration above for the full reasoning.
  if (coingeckoCircuitOpen) return { priceUsd: null, reason: 'coingecko_circuit_open_after_429' }

  const targetSec = Math.floor(timestamp / 1000)
  const url = new URL(
    `https://api.coingecko.com/api/v3/coins/${platform}/contract/${token.toLowerCase()}/market_chart/range`,
  )
  url.searchParams.set('vs_currency', 'usd')
  url.searchParams.set('from', String(targetSec - COINGECKO_RANGE_WINDOW_SECONDS))
  url.searchParams.set('to', String(targetSec + COINGECKO_RANGE_WINDOW_SECONDS))

  const apiKey = process.env.COINGECKO_API_KEY

  try {
    const res = await fetch(url.toString(), {
      headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 429) {
      // TRIP THE BREAKER, DISCLOSED: the first real 429 this scan is trusted evidence the rate
      // limit is exhausted — never waits for a second confirming 429 (unlike GoldRush's
      // consecutive-miss threshold, which distinguishes "temporarily slow" from "structurally not
      // answering"; a 429 IS the rate limiter answering, definitively, right now).
      coingeckoCircuitOpen = true
      return { priceUsd: null, reason: 'http_429' }
    }
    if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

    const data = (await res.json()) as { prices?: Array<[number, number]> }
    const prices = data.prices ?? []
    if (prices.length === 0) return { priceUsd: null, reason: 'no_price_series_in_range' }

    const closest = prices.reduce((a, b) => (Math.abs(b[0] - timestamp) < Math.abs(a[0] - timestamp) ? b : a))
    return Number.isFinite(closest[1]) ? { priceUsd: closest[1], reason: null } : { priceUsd: null, reason: 'unparseable_price' }
  } catch (err) {
    return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// NATIVE-ASSET HISTORY, DISCLOSED (ETH native-routing-mismatch fix): CoinGecko indexes native ETH
// under its own coin id ("ethereum") via the real, documented `/coins/{id}/history` endpoint — a
// DIFFERENT, more complete dataset than the CONTRACT-address-based `/coins/{platform}/contract/
// {address}/market_chart/range` endpoint above (that one is a secondary, contract-derived dataset;
// querying it with WETH's contract address on mainnet can genuinely miss dates the coin's own
// primary history has). Single-day precision (`date=DD-MM-YYYY`), matching this function's own
// historical-lookup contract — never a current-price fallback, never applied to any date but the
// one requested. Shares the SAME circuit breaker as the contract-based function above (same
// CoinGecko rate-limit bucket).
export async function fetchCoingeckoNativeEthPriceDetailed(timestamp: number): Promise<CoingeckoPriceResult> {
  if (coingeckoCircuitOpen) return { priceUsd: null, reason: 'coingecko_circuit_open_after_429' }

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return { priceUsd: null, reason: 'invalid_timestamp' }
  const dateString = `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`

  const url = new URL('https://api.coingecko.com/api/v3/coins/ethereum/history')
  url.searchParams.set('date', dateString)
  url.searchParams.set('localization', 'false')

  const apiKey = process.env.COINGECKO_API_KEY

  try {
    const res = await fetch(url.toString(), {
      headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 429) {
      coingeckoCircuitOpen = true
      return { priceUsd: null, reason: 'http_429' }
    }
    if (!res.ok) return { priceUsd: null, reason: `http_${res.status}` }

    const data = (await res.json()) as { market_data?: { current_price?: { usd?: number } } }
    const price = data.market_data?.current_price?.usd
    return typeof price === 'number' && Number.isFinite(price) ? { priceUsd: price, reason: null } : { priceUsd: null, reason: 'no_price_for_date' }
  } catch (err) {
    return { priceUsd: null, reason: `fetch_error:${err instanceof Error ? err.message : 'unknown'}` }
  }
}

// Public export matching this codebase's PriceSourceFn contract exactly (token, chain, timestamp)
// -> number | null — a clean USD price or null, never a fabricated value.
export async function fetchCoingeckoPrice(
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<number | null> {
  const result = await fetchCoingeckoPriceDetailed(token, chain, timestamp)
  return result.priceUsd
}
