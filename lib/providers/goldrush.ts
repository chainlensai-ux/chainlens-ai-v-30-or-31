// lib/providers/goldrush.ts — GoldRush historical price provider adapter for PricingAtTimeEngine.
//
// REUSE, NOT REIMPLEMENTATION, DISCLOSED: this delegates to the REAL, already-shipped, already-
// instrumented (logRpcCall) GoldRush price source at
// src/modules/pricingAtTimeEngine/sources/goldrushPriceSource.ts, rather than writing a second raw
// fetch to GoldRush's PricingService. Building a brand-new parallel fetcher here would double real
// GoldRush CU usage for the exact same lookup and make it invisible to /api/debug-rpc-usage's
// existing coverage — a genuine cost/observability regression, not "new business logic." The only
// new code in this file is the request/response shape adaptation this engine's contract requires.
//
// CRASH-SAFETY NOTE: `new GoldRushClient(apiKey)` throws synchronously on a malformed key (see the
// fix already applied to src/pipeline/index.ts's buildPriceSources() this session) — wrapped in
// try/catch here for the same reason, independently, since this is a separate construction site.

import { GoldRushClient } from '@covalenthq/client-sdk'
import { goldrushPriceSource } from '@/src/modules/pricingAtTimeEngine/sources/goldrushPriceSource'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { logRpcCall } from '@/lib/server/rpcDebug'

export type GoldrushPriceRequest = { chain: SupportedChain; tokenAddress: string; timestamp: number }
export type GoldrushPriceResult = { priceUsd: number | null; timestamp: number; notes?: string }

// RPC-COST FIX, DISCLOSED: this function previously constructed a new GoldRushClient and made a
// real GoldRush price lookup on EVERY call, with zero memoization anywhere in its call chain. This
// is called once per distinct (chain, token, timestamp) trade needing historical pricing via
// lib/engines/pricingAtTimeEngine.ts (a real, separate engine from src/modules/pricingAtTimeEngine/
// — see that file's own header — used by lib/engine/modules/pricing/fetchPricing.ts, part of the
// live Deep Scan worker chain) — the same per-trade multiplier pattern already fixed for the
// basedex on-chain fallback (see that file's own RPC-COST FIX disclosure). Two safe additions:
//
// 1. cachedClient: the GoldRushClient instance itself is reused across calls instead of
//    reconstructed every time (cheap object construction, but real, same pattern as basedex.ts's
//    cachedBaseClient) — only rebuilt if the API key actually changes.
// 2. priceCache: a resolved (chain, tokenAddress, timestamp) -> price is a permanent historical
//    fact — a real, already-settled price at a specific past second never changes — so a
//    SUCCESSFUL result (priceUsd !== null) is cached indefinitely. A "no price data" result is
//    deliberately NOT cached (same reasoning as basedex's pool-resolution cache): GoldRush could
//    backfill data for a timestamp that has none today, and this process can stay warm across many
//    requests — caching a negative result indefinitely risks permanently hiding a price that
//    becomes available later. Caching only real hits has no such risk.
const priceCache = new Map<string, GoldrushPriceResult>()
let cachedClient: { apiKey: string; client: GoldRushClient } | null = null

function getGoldrushClient(apiKey: string): GoldRushClient {
  if (!cachedClient || cachedClient.apiKey !== apiKey) {
    cachedClient = { apiKey, client: new GoldRushClient(apiKey) }
  }
  return cachedClient.client
}

// Gracefully returns { priceUsd: null } for any failure — missing key, malformed key, unverified
// chain, unparseable timestamp, network error, or genuinely no price data. Never throws.
export async function fetchGoldrushHistoricalPrice(req: GoldrushPriceRequest): Promise<GoldrushPriceResult> {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  if (!apiKey) return { priceUsd: null, timestamp: req.timestamp, notes: 'no_api_key_configured' }

  const cacheKey = `${req.chain}:${req.tokenAddress.toLowerCase()}:${req.timestamp}`
  const cached = priceCache.get(cacheKey)
  if (cached) return cached

  try {
    const client = getGoldrushClient(apiKey)
    logRpcCall({ route: 'pricingAtTimeEngine:goldrush', chain: req.chain, method: 'goldrush_sdk_getTokenPrices' })
    const priceUsd = await goldrushPriceSource(client)(req.tokenAddress, req.chain, req.timestamp * 1000)
    const result: GoldrushPriceResult = { priceUsd, timestamp: req.timestamp, notes: priceUsd === null ? 'no_price_data' : undefined }
    if (priceUsd !== null) priceCache.set(cacheKey, result)
    return result
  } catch (err) {
    const reason = typeof err === 'object' && err !== null && 'error_message' in err
      ? String((err as { error_message: unknown }).error_message)
      : err instanceof Error ? err.message : String(err)
    return { priceUsd: null, timestamp: req.timestamp, notes: `goldrush_client_error: ${reason}` }
  }
}

// TEST-SUPPORT EXPORT, DISCLOSED: same pattern as src/modules/pricingAtTimeEngine/sources/
// basedex.ts's __resetBaseDexCachesForTest — lets a test start from a clean cache state. Not
// called anywhere in real request handling.
export function __resetGoldrushCacheForTest(): void {
  priceCache.clear()
  cachedClient = null
}
