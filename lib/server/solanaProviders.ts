// SOLANA PROVIDER WIRING, DISCLOSED (Solana provider wiring task).
//
// Jupiter and Helius enrichment for the Solana Beta scan path. Each function here is INDEPENDENT
// and defensive: a missing key, a disabled flag, or a network failure never throws — it always
// resolves to a typed "not called" / "failed" shape so scanSolanaTokenBeta can merge it safely and
// the caller never sees a crash from an optional provider. Every failure carries a short,
// non-secret `errorReason` string (never a raw error object, never a URL or key).
//
// COST DISCLOSURE: Helius here calls ONLY the standard `getSignaturesForAddress` RPC method — never
// the Enhanced Transactions API (parsed dev/creator history), which is far more expensive per call.
// `enhancedTransactionsUsed` is hardcoded false in the return shape below; nothing in this module
// can set it true. A future deep-analysis path may add that call explicitly and gated, but it does
// not exist here.

import { isHeliusConfigured, isJupiterConfigured, getHeliusApiKey } from './solanaChainConfig.ts'

type FetchImpl = typeof fetch

// ── Jupiter: token identity + price fallback ────────────────────────────────────

export type SolanaJupiterResult = {
  called: boolean
  success: boolean
  resolved: {
    name: string | null
    symbol: string | null
    logo: string | null
    verified: boolean | null
    price: number | null
  }
  errorReason: string | null
}

function emptyJupiterResult(called: boolean, errorReason: string | null): SolanaJupiterResult {
  return { called, success: false, resolved: { name: null, symbol: null, logo: null, verified: null, price: null }, errorReason }
}

export async function fetchJupiterSolanaData(mintAddress: string, fetchImpl: FetchImpl): Promise<SolanaJupiterResult> {
  if (!isJupiterConfigured()) return emptyJupiterResult(false, 'Jupiter Solana enrichment is not enabled (ENABLE_JUPITER_SOLANA is not "true").')

  let name: string | null = null
  let symbol: string | null = null
  let logo: string | null = null
  let verified: boolean | null = null
  let price: number | null = null
  let metadataOk = false
  let priceOk = false
  const errors: string[] = []

  try {
    const res = await fetchImpl(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`, { signal: AbortSignal.timeout(7000) })
    if (res.ok) {
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      if (json) {
        name = typeof json.name === 'string' ? json.name : null
        symbol = typeof json.symbol === 'string' ? json.symbol : null
        logo = typeof json.logoURI === 'string' ? json.logoURI : null
        const tags = Array.isArray(json.tags) ? json.tags as unknown[] : null
        verified = tags ? tags.some((t) => typeof t === 'string' && t.toLowerCase() === 'verified') : null
        metadataOk = name != null || symbol != null
      }
    } else {
      errors.push(`jupiter_metadata_http_${res.status}`)
    }
  } catch {
    errors.push('jupiter_metadata_unreachable')
  }

  try {
    const res = await fetchImpl(`https://lite-api.jup.ag/price/v2?ids=${mintAddress}`, { signal: AbortSignal.timeout(7000) })
    if (res.ok) {
      const json = await res.json().catch(() => null) as { data?: Record<string, { price?: string | number } | undefined> } | null
      const entry = json?.data?.[mintAddress]
      const raw = entry?.price
      const num = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
      price = Number.isFinite(num) ? num : null
      priceOk = price != null
    } else {
      errors.push(`jupiter_price_http_${res.status}`)
    }
  } catch {
    errors.push('jupiter_price_unreachable')
  }

  const success = metadataOk || priceOk
  return {
    called: true,
    success,
    resolved: { name, symbol, logo, verified, price },
    errorReason: success ? null : (errors[0] ?? 'jupiter_no_data'),
  }
}

// ── Helius: lightweight activity signal (never Enhanced Transactions) ──────────

export type SolanaHeliusResult = {
  called: boolean
  success: boolean
  enhancedTransactionsUsed: false
  estimatedCredits: number
  resolved: {
    parsedActivity: boolean | null
    creatorSignals: string | null
    devActivity: string | null
    recentTransfers: number | null
  }
  errorReason: string | null
}

function emptyHeliusResult(called: boolean, errorReason: string | null): SolanaHeliusResult {
  return {
    called, success: false, enhancedTransactionsUsed: false, estimatedCredits: 0,
    resolved: { parsedActivity: null, creatorSignals: null, devActivity: null, recentTransfers: null },
    errorReason,
  }
}

export async function fetchHeliusSolanaActivity(mintAddress: string, fetchImpl: FetchImpl): Promise<SolanaHeliusResult> {
  if (!isHeliusConfigured()) return emptyHeliusResult(false, 'Helius Solana enrichment is not enabled (ENABLE_HELIUS_SOLANA is not "true", or HELIUS_API_KEY is missing).')

  const apiKey = getHeliusApiKey()
  if (!apiKey) return emptyHeliusResult(false, 'HELIUS_API_KEY missing.')

  // Standard JSON-RPC method, NOT the paid Enhanced Transactions API — a small, fixed-size,
  // read-only lookup used purely as a "does this mint have on-chain activity" signal.
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mintAddress, { limit: 10 }] }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return emptyHeliusResult(true, `helius_http_${res.status}`)
    const json = await res.json().catch(() => null) as { result?: unknown[]; error?: { message?: string } } | null
    if (!json) return emptyHeliusResult(true, 'helius_bad_json')
    if (json.error) return emptyHeliusResult(true, `helius_rpc_error:${json.error.message ?? 'unknown'}`)
    const signatures = Array.isArray(json.result) ? json.result : []
    return {
      called: true,
      success: true,
      enhancedTransactionsUsed: false,
      // A single lightweight signature-list call — a small, fixed estimate for the audit trail,
      // not a billed figure from Helius itself (this codebase has no live credit-metering hook).
      estimatedCredits: 1,
      resolved: {
        parsedActivity: signatures.length > 0,
        // Creator/dev-wallet identity requires parsed (Enhanced) transaction data, which this
        // lightweight call deliberately does not fetch — reported as a real gap, not guessed.
        creatorSignals: null,
        devActivity: null,
        recentTransfers: signatures.length,
      },
      errorReason: null,
    }
  } catch {
    return emptyHeliusResult(true, 'helius_unreachable')
  }
}

// ── GoldRush / Covalent: no confirmed working Solana endpoint in this codebase ──

export type SolanaGoldrushResult = {
  called: boolean
  success: boolean
  chainSlugOrIdUsed: string | null
  resolved: {
    indexedHolders: boolean | null
    holderCount: number | null
    history: boolean | null
    transfers: boolean | null
  }
  errorReason: string | null
}

/**
 * Deliberately never calls out — see solanaChainConfig.ts's isGoldrushKeyPresent header for why:
 * no GOLDRUSH_VERIFIED_CHAIN_SLUGS map in this codebase lists a Solana slug, so calling GoldRush
 * here would mean guessing one. `called` stays false until a verified slug is added; this keeps
 * the "unsupported, marked cleanly" contract instead of a silent no-op.
 */
export function solanaGoldrushEnrichment(): SolanaGoldrushResult {
  return {
    called: false,
    success: false,
    chainSlugOrIdUsed: null,
    resolved: { indexedHolders: null, holderCount: null, history: null, transfers: null },
    errorReason: 'No verified GoldRush/Covalent Solana chain slug exists in this codebase — skipped rather than guessed.',
  }
}
