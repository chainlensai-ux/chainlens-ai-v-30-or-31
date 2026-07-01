// MODULE — networkDiagnostics
//
// Standalone diagnostics tool — NOT part of runWalletScan()/the pipeline, and not imported by it.
// Manually invoked (today, only via app/api/diagnostics/pricing/route.ts) to verify whether the
// pricing sources actually configured in src/pipeline/index.ts's PRICE_SOURCES are really being
// called and returning usable data. Does NOT modify fifoEngine or pricingAtTimeEngine — it calls
// the exact same injected PriceSourceFn functions those modules already use, read-only.
//
// HONESTY NOTE ON "raw JSON response" — this codebase's PriceSourceFn contract
// (src/modules/pricingAtTimeEngine/types.ts) is `(token, chain, timestamp) => number | null`. It
// does not return or expose the underlying provider's raw HTTP/JSON response — only the already-
// parsed price. That is a real, structural limitation of the current abstraction, not something
// this diagnostics module can see around without modifying pricingAtTimeEngine or
// goldrushPriceSource (both explicitly out of scope for this task). So `response` below is never a
// fabricated provider payload — it honestly reports the one real thing this module has access to
// (the parsed price the source function returned, or the real thrown error), with a note
// explaining why the raw payload isn't present.

import type { PriceSourceFn, PriceSources } from '../pricingAtTimeEngine/types'
import type { SupportedChain } from '../providerFetchWindow/types'

export type PriceSourceCallLog = {
  called: boolean
  startedAt: string | null
  durationMs: number | null
  requestParams: { token: string; chain: SupportedChain; timestamp: number } | null
  // Never a fabricated provider payload — see module header. Either the real parsed price (with a
  // note on why the raw HTTP/JSON body isn't available) or null when the source wasn't called.
  response: { note: string; priceReturned: number | null } | null
  price: number | null
  error: string | null
}

export type DiagnosticsResult = {
  chain: SupportedChain
  contract: string
  timestamp: number
  primary: PriceSourceCallLog
  fallback: PriceSourceCallLog
}

const NOT_CALLED_LOG: PriceSourceCallLog = {
  called: false,
  startedAt: null,
  durationMs: null,
  requestParams: null,
  response: null,
  price: null,
  error: null,
}

const RAW_RESPONSE_NOTE =
  'The PriceSourceFn contract (src/modules/pricingAtTimeEngine/types.ts) returns only a parsed ' +
  'price, never the provider\'s raw HTTP/JSON response — this diagnostics module has no access to ' +
  'that payload without modifying pricingAtTimeEngine, which is out of scope here.'

// Calls one price source function (primary or fallback), logging start time, request params,
// duration, and outcome to the console AND returning the same facts as a structured log entry.
// Never throws — a thrown error from the source function is caught and recorded, never crashes
// the diagnostics call itself.
async function callAndLog(
  label: 'primary' | 'fallback',
  fn: PriceSourceFn | undefined,
  token: string,
  chain: SupportedChain,
  timestamp: number,
): Promise<PriceSourceCallLog> {
  if (typeof fn !== 'function') {
    // eslint-disable-next-line no-console
    console.warn(`[networkDiagnostics] ${label}: no source function configured — skipped`)
    return { ...NOT_CALLED_LOG, error: 'no source function configured' }
  }

  const requestParams = { token, chain, timestamp }
  const startedAt = new Date().toISOString()
  const startMs = Date.now()

  // eslint-disable-next-line no-console
  console.log(`[networkDiagnostics] ${label}: calling`, requestParams)

  try {
    const price = await fn(token, chain, timestamp)
    const durationMs = Date.now() - startMs
    const usable = price !== null

    // eslint-disable-next-line no-console
    console.log(`[networkDiagnostics] ${label}: responded in ${durationMs}ms — usable=${usable}`, { price })

    return {
      called: true,
      startedAt,
      durationMs,
      requestParams,
      response: { note: RAW_RESPONSE_NOTE, priceReturned: price },
      price,
      error: null,
    }
  } catch (err) {
    const durationMs = Date.now() - startMs
    const message = err instanceof Error ? err.message : 'unknown_error'

    // eslint-disable-next-line no-console
    console.error(`[networkDiagnostics] ${label}: threw after ${durationMs}ms`, message)

    return {
      called: true,
      startedAt,
      durationMs,
      requestParams,
      response: null,
      price: null,
      error: message,
    }
  }
}

// Calls priceSources.primary first; only calls priceSources.fallback if primary resolved to null
// (no usable price) — mirrors pricingAtTimeEngine's own resolvePriceForEntry fallback rule exactly,
// so this diagnostic reflects the real production call pattern. Never throws.
export async function runPricingDiagnostics(params: {
  chain: SupportedChain
  contract: string
  timestamp: number
  priceSources: PriceSources | undefined
}): Promise<DiagnosticsResult> {
  const primary = await callAndLog('primary', params.priceSources?.primary, params.contract, params.chain, params.timestamp)

  const fallback = primary.price === null
    ? await callAndLog('fallback', params.priceSources?.fallback, params.contract, params.chain, params.timestamp)
    : { ...NOT_CALLED_LOG }

  return {
    chain: params.chain,
    contract: params.contract,
    timestamp: params.timestamp,
    primary,
    fallback,
  }
}
