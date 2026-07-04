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

// Gracefully returns { priceUsd: null } for any failure — missing key, malformed key, unverified
// chain, unparseable timestamp, network error, or genuinely no price data. Never throws.
export async function fetchGoldrushHistoricalPrice(req: GoldrushPriceRequest): Promise<GoldrushPriceResult> {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY
  if (!apiKey) return { priceUsd: null, timestamp: req.timestamp, notes: 'no_api_key_configured' }

  try {
    const client = new GoldRushClient(apiKey)
    logRpcCall({ route: 'pricingAtTimeEngine:goldrush', chain: req.chain, method: 'goldrush_sdk_getTokenPrices' })
    const priceUsd = await goldrushPriceSource(client)(req.tokenAddress, req.chain, req.timestamp * 1000)
    return { priceUsd, timestamp: req.timestamp, notes: priceUsd === null ? 'no_price_data' : undefined }
  } catch (err) {
    const reason = typeof err === 'object' && err !== null && 'error_message' in err
      ? String((err as { error_message: unknown }).error_message)
      : err instanceof Error ? err.message : String(err)
    return { priceUsd: null, timestamp: req.timestamp, notes: `goldrush_client_error: ${reason}` }
  }
}
