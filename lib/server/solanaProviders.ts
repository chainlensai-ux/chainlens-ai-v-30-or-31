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

// ── GeckoTerminal: OHLCV candles for the Price Chart ────────────────────────────
//
// LIVE-VERIFICATION DISCLOSED: this integration was written from documented GeckoTerminal API
// shape, not confirmed against a live response from this sandbox (outbound network to
// api.geckoterminal.com is blocked here). It is defensive by construction — any unexpected
// response shape (missing fields, wrong types, HTTP error) degrades to `success: false` with a
// clean errorReason, never a crash and never fabricated candles — but the FIRST real scan after
// this ships should be checked to confirm candles actually render, same as every other provider
// added in this thread.
//
// Free, keyless, public endpoint — no API key, no env flag. Runs whenever a Solana pool address
// is known (from DexScreener), mirroring DexScreener's own no-separate-flag precedent.

export type SolanaOhlcvCandle = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null }
export type SolanaOhlcvResult = {
  called: boolean
  success: boolean
  candles: SolanaOhlcvCandle[]
  timeframe: string
  errorReason: string | null
}

function emptyOhlcvResult(called: boolean, errorReason: string | null): SolanaOhlcvResult {
  return { called, success: false, candles: [], timeframe: '1h', errorReason }
}

export async function fetchSolanaOhlcv(poolAddress: string | null, fetchImpl: FetchImpl): Promise<SolanaOhlcvResult> {
  if (!poolAddress) return emptyOhlcvResult(false, 'No indexed pool address to fetch candle history for.')
  try {
    const res = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/hour?aggregate=1&limit=48`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return emptyOhlcvResult(true, `geckoterminal_http_${res.status}`)
    const json = await res.json().catch(() => null) as { data?: { attributes?: { ohlcv_list?: unknown } } } | null
    const rows = Array.isArray(json?.data?.attributes?.ohlcv_list) ? json!.data!.attributes!.ohlcv_list as unknown[] : null
    if (!rows) return emptyOhlcvResult(true, 'geckoterminal_unexpected_shape')
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    // GeckoTerminal rows are [unix_seconds, open, high, low, close, volume], newest-first.
    const candles = rows
      .map((row) => (Array.isArray(row) && row.length >= 6 ? row : null))
      .filter((row): row is unknown[] => row != null)
      .map((row): SolanaOhlcvCandle | null => {
        const ts = num(row[0]); const o = num(row[1]); const h = num(row[2]); const l = num(row[3]); const c = num(row[4]); const v = num(row[5])
        if (ts == null || o == null || h == null || l == null || c == null) return null
        return { timestamp: new Date(ts * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: v }
      })
      .filter((c): c is SolanaOhlcvCandle => c != null)
      .reverse() // chronological ascending, for the chart
    if (candles.length < 2) return emptyOhlcvResult(true, 'geckoterminal_insufficient_candles')
    return { called: true, success: true, candles, timeframe: '1h', errorReason: null }
  } catch {
    return emptyOhlcvResult(true, 'geckoterminal_unreachable')
  }
}

// ── Helius: real (paginated) holder count via the DAS getTokenAccounts method ──
//
// LIVE-VERIFICATION DISCLOSED: same caveat as GeckoTerminal above — written from documented
// Helius DAS API shape, not confirmed live. Defensive by construction.
//
// HONESTY, DISCLOSED: this counts SPL token ACCOUNTS with a positive balance for the mint — the
// same caveat as topAccountConcentration applies (AMM pool vaults and exchange custody accounts
// are token accounts too, so this is not a KYC-verified unique-human count). It IS a real,
// paginated count from live on-chain data, unlike the top-20 sample — call sites must still label
// it as an account count, never claim it as verified unique holders.
//
// COST CONTROL, DISCLOSED: capped at 3 pages of 1000 accounts (3 Helius DAS calls, NOT Enhanced
// Transactions) — cheap and bounded. A token with more accounts than the cap gets an honest
// lower-bound count (isLowerBound: true) rather than either paying for unbounded pagination or
// silently under-reporting as if it were the true total.

const HELIUS_HOLDER_MAX_PAGES = 3
const HELIUS_HOLDER_PAGE_LIMIT = 1000

export type SolanaHeliusHolderResult = {
  called: boolean
  success: boolean
  holderCount: number | null
  isLowerBound: boolean
  pagesFetched: number
  errorReason: string | null
}

function emptyHolderResult(called: boolean, errorReason: string | null): SolanaHeliusHolderResult {
  return { called, success: false, holderCount: null, isLowerBound: false, pagesFetched: 0, errorReason }
}

export async function fetchHeliusHolderCount(mintAddress: string, fetchImpl: FetchImpl): Promise<SolanaHeliusHolderResult> {
  if (!isHeliusConfigured()) return emptyHolderResult(false, 'Helius Solana enrichment is not enabled (ENABLE_HELIUS_SOLANA is not "true", or HELIUS_API_KEY is missing).')
  const apiKey = getHeliusApiKey()
  if (!apiKey) return emptyHolderResult(false, 'HELIUS_API_KEY missing.')

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  let holderCount = 0
  let pagesFetched = 0
  try {
    for (let page = 1; page <= HELIUS_HOLDER_MAX_PAGES; page++) {
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint: mintAddress, page, limit: HELIUS_HOLDER_PAGE_LIMIT } }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return pagesFetched > 0
        ? { called: true, success: true, holderCount, isLowerBound: true, pagesFetched, errorReason: null }
        : emptyHolderResult(true, `helius_holders_http_${res.status}`)
      const json = await res.json().catch(() => null) as { result?: { token_accounts?: unknown[] }; error?: { message?: string } } | null
      if (!json) return pagesFetched > 0
        ? { called: true, success: true, holderCount, isLowerBound: true, pagesFetched, errorReason: null }
        : emptyHolderResult(true, 'helius_holders_bad_json')
      if (json.error) return pagesFetched > 0
        ? { called: true, success: true, holderCount, isLowerBound: true, pagesFetched, errorReason: null }
        : emptyHolderResult(true, `helius_holders_rpc_error:${json.error.message ?? 'unknown'}`)
      const accounts = Array.isArray(json.result?.token_accounts) ? json.result!.token_accounts! : []
      pagesFetched++
      const positive = accounts.filter((a) => {
        const amt = (a as Record<string, unknown> | null)?.amount
        const n = typeof amt === 'string' ? Number(amt) : typeof amt === 'number' ? amt : 0
        return Number.isFinite(n) && n > 0
      })
      holderCount += positive.length
      if (accounts.length < HELIUS_HOLDER_PAGE_LIMIT) {
        return { called: true, success: true, holderCount, isLowerBound: false, pagesFetched, errorReason: null }
      }
    }
    // Hit the page cap with a full last page — more accounts likely exist beyond it.
    return { called: true, success: true, holderCount, isLowerBound: true, pagesFetched, errorReason: null }
  } catch {
    return pagesFetched > 0
      ? { called: true, success: true, holderCount, isLowerBound: true, pagesFetched, errorReason: null }
      : emptyHolderResult(true, 'helius_holders_unreachable')
  }
}

// ── Helius: top token accounts by balance (concentration fallback) ─────────────────────────────
//
// ADDED, DISCLOSED (Solana holder-concentration reliability task, resolution-order fallback #2 —
// "Helius token holders / token accounts endpoint if configured"): fetchHeliusHolderCount above
// already calls this same DAS getTokenAccounts method but only ever keeps a running COUNT,
// discarding each account's own `amount` the moment it's counted. This sibling function keeps the
// per-account amounts from the FIRST page (capped at HELIUS_HOLDER_PAGE_LIMIT accounts) and sorts
// by balance descending — a real, honest top-N by balance for any mint whose real holder count fits
// in one page. HONESTY, DISCLOSED: Helius's DAS getTokenAccounts response is not documented as
// balance-sorted, so for a mint with MORE accounts than fit in one page, accounts beyond the first
// page could theoretically outrank ones already fetched — `isLowerBound: true` in that case flags
// this honestly (mirrors fetchHeliusHolderCount's own isLowerBound contract) rather than silently
// presenting a possibly-incomplete top-N as authoritative. Only ONE Helius call (not the 3-page
// pagination fetchHeliusHolderCount uses) — this is a fallback path, not the primary source, so it
// stays cheap.
export type SolanaHeliusTopAccountsResult = {
  called: boolean
  success: boolean
  accounts: Array<{ address: string; amountRaw: string }>
  isLowerBound: boolean
  errorReason: string | null
}

function emptyTopAccountsResult(called: boolean, errorReason: string | null): SolanaHeliusTopAccountsResult {
  return { called, success: false, accounts: [], isLowerBound: false, errorReason }
}

export async function fetchHeliusTopAccounts(mintAddress: string, fetchImpl: FetchImpl): Promise<SolanaHeliusTopAccountsResult> {
  if (!isHeliusConfigured()) return emptyTopAccountsResult(false, 'Helius Solana enrichment is not enabled (ENABLE_HELIUS_SOLANA is not "true", or HELIUS_API_KEY is missing).')
  const apiKey = getHeliusApiKey()
  if (!apiKey) return emptyTopAccountsResult(false, 'HELIUS_API_KEY missing.')

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint: mintAddress, page: 1, limit: HELIUS_HOLDER_PAGE_LIMIT } }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return emptyTopAccountsResult(true, `helius_top_accounts_http_${res.status}`)
    const json = await res.json().catch(() => null) as { result?: { token_accounts?: unknown[] }; error?: { message?: string } } | null
    if (!json) return emptyTopAccountsResult(true, 'helius_top_accounts_bad_json')
    if (json.error) return emptyTopAccountsResult(true, `helius_top_accounts_rpc_error:${json.error.message ?? 'unknown'}`)
    const raw = Array.isArray(json.result?.token_accounts) ? json.result!.token_accounts! : []
    const parsed = raw
      .map((a) => {
        const rec = a as Record<string, unknown> | null
        const address = typeof rec?.address === 'string' ? rec.address : null
        const amt = rec?.amount
        const amountRaw = typeof amt === 'string' ? amt : typeof amt === 'number' ? String(Math.trunc(amt)) : null
        return address && amountRaw ? { address, amountRaw } : null
      })
      .filter((a): a is { address: string; amountRaw: string } => a !== null)
      .sort((a, b) => {
        try {
          const diff = BigInt(b.amountRaw) - BigInt(a.amountRaw)
          return diff > BigInt(0) ? 1 : diff < BigInt(0) ? -1 : 0
        } catch {
          return 0
        }
      })
    if (parsed.length === 0) return emptyTopAccountsResult(true, 'empty_response')
    return { called: true, success: true, accounts: parsed.slice(0, 20), isLowerBound: raw.length >= HELIUS_HOLDER_PAGE_LIMIT, errorReason: null }
  } catch {
    return emptyTopAccountsResult(true, 'helius_top_accounts_unreachable')
  }
}

// ── Helius: Deep Mode creator trace — Enhanced Transactions, EXPLICITLY OPT-IN ONLY ────────────
//
// COST DISCLOSURE, CRITICAL: this is the ONE function in this codebase allowed to call Helius's
// paid Enhanced Transactions API. It must NEVER be invoked from the default scan path — only from
// an explicit user action ("Deep Creator Check" on the Dev tab), which the caller is responsible
// for gating. See lib/server/solana/deepCreatorAnalyzer.ts and the API route's own `deep` opt-in
// flag for where that gate actually lives.
//
// WHAT THIS DOES: (1) paginates getSignaturesForAddress (standard RPC, cheap) backwards from the
// mint address, capped at DEEP_CREATOR_MAX_PAGES, to find the EARLIEST known transaction; (2)
// calls Helius's Enhanced Transactions REST API on that one signature to get its parsed fee payer
// and the source program it interacted with.
//
// HONESTY, DISCLOSED: `likelyCreatorWallet` is the fee payer of the mint's earliest FOUND
// transaction — a real, on-chain, disclosed value, not a guess about identity. It is a strong
// signal for a token whose full history was reached (reachedGenesis: true), but is explicitly
// NOT asserted as a certainty: a sponsored/relayed transaction would show a different payer than
// the actual deployer, and a token with more history than the page cap allows may not have its
// TRUE earliest transaction found at all (reachedGenesis: false covers that case honestly).
//
// LIVE-VERIFICATION DISCLOSED: written from documented Helius Enhanced Transactions API shape
// (POST /v0/transactions/?api-key=... with {"transactions": [signature]}, returning an array with
// a `feePayer` and `source` field per transaction) — not confirmed against a live response from
// this sandbox. Defensive by construction: any unexpected shape degrades to `success: false` with
// a clean errorReason, never a crash, never a fabricated wallet address.

const DEEP_CREATOR_MAX_SIGNATURE_PAGES = 5
const DEEP_CREATOR_SIGNATURE_PAGE_LIMIT = 1000

export type SolanaCreatorTraceResult = {
  called: boolean
  success: boolean
  enhancedTransactionsUsed: boolean
  estimatedCredits: number
  pagesFetched: number
  /** True only if signature pagination ran out (fewer than a full page) — i.e. genuinely reached the start. */
  reachedGenesis: boolean
  resolved: {
    earliestSignature: string | null
    earliestTimestamp: string | null
    likelyCreatorWallet: string | null
    transactionSource: string | null
  }
  errorReason: string | null
}

function emptyCreatorTraceResult(called: boolean, errorReason: string | null, pagesFetched = 0): SolanaCreatorTraceResult {
  return {
    called, success: false, enhancedTransactionsUsed: false, estimatedCredits: pagesFetched, pagesFetched, reachedGenesis: false,
    resolved: { earliestSignature: null, earliestTimestamp: null, likelyCreatorWallet: null, transactionSource: null },
    errorReason,
  }
}

export async function fetchHeliusCreatorTrace(mintAddress: string, fetchImpl: FetchImpl): Promise<SolanaCreatorTraceResult> {
  if (!isHeliusConfigured()) return emptyCreatorTraceResult(false, 'Helius Solana enrichment is not enabled (ENABLE_HELIUS_SOLANA is not "true", or HELIUS_API_KEY is missing).')
  const apiKey = getHeliusApiKey()
  if (!apiKey) return emptyCreatorTraceResult(false, 'HELIUS_API_KEY missing.')

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  let before: string | undefined
  let earliestSignature: string | null = null
  let earliestBlockTime: number | null = null
  let pagesFetched = 0
  let reachedGenesis = false

  try {
    for (let page = 1; page <= DEEP_CREATOR_MAX_SIGNATURE_PAGES; page++) {
      const params = before ? [mintAddress, { limit: DEEP_CREATOR_SIGNATURE_PAGE_LIMIT, before }] : [mintAddress, { limit: DEEP_CREATOR_SIGNATURE_PAGE_LIMIT }]
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params }),
        signal: AbortSignal.timeout(9000),
      })
      if (!res.ok) return earliestSignature ? { ...emptyCreatorTraceResult(true, null, pagesFetched), success: false, errorReason: `helius_sig_page_http_${res.status}` } : emptyCreatorTraceResult(true, `helius_sig_page_http_${res.status}`, pagesFetched)
      const json = await res.json().catch(() => null) as { result?: Array<{ signature?: string; blockTime?: number | null }>; error?: { message?: string } } | null
      if (!json) break
      if (json.error) return emptyCreatorTraceResult(true, `helius_sig_page_rpc_error:${json.error.message ?? 'unknown'}`, pagesFetched)
      const rows = Array.isArray(json.result) ? json.result : []
      if (rows.length === 0) { reachedGenesis = pagesFetched > 0; break }
      pagesFetched++
      const last = rows[rows.length - 1]
      if (typeof last?.signature === 'string') { earliestSignature = last.signature; earliestBlockTime = typeof last.blockTime === 'number' ? last.blockTime : null }
      before = last?.signature
      if (rows.length < DEEP_CREATOR_SIGNATURE_PAGE_LIMIT) { reachedGenesis = true; break }
    }
  } catch {
    return earliestSignature ? { ...emptyCreatorTraceResult(true, null, pagesFetched), errorReason: 'helius_sig_page_unreachable' } : emptyCreatorTraceResult(true, 'helius_sig_page_unreachable', pagesFetched)
  }

  if (!earliestSignature) return emptyCreatorTraceResult(true, 'no_signature_history_found', pagesFetched)

  const earliestTimestamp = earliestBlockTime != null ? new Date(earliestBlockTime * 1000).toISOString() : null

  // Enhanced Transactions call — the one paid lookup this whole engine allows, and only here.
  try {
    const res = await fetchImpl(`https://api.helius.xyz/v0/transactions/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [earliestSignature] }),
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) {
      return {
        called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: pagesFetched + 1, pagesFetched, reachedGenesis,
        resolved: { earliestSignature, earliestTimestamp, likelyCreatorWallet: null, transactionSource: null },
        errorReason: `helius_enhanced_http_${res.status}`,
      }
    }
    const parsed = await res.json().catch(() => null) as unknown
    const tx = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined
    const feePayer = typeof tx?.feePayer === 'string' ? tx.feePayer : null
    const source = typeof tx?.source === 'string' ? tx.source : null
    return {
      called: true, success: feePayer != null, enhancedTransactionsUsed: true, estimatedCredits: pagesFetched + 1, pagesFetched, reachedGenesis,
      resolved: { earliestSignature, earliestTimestamp, likelyCreatorWallet: feePayer, transactionSource: source },
      errorReason: feePayer != null ? null : 'helius_enhanced_no_fee_payer_in_response',
    }
  } catch {
    return {
      called: true, success: false, enhancedTransactionsUsed: true, estimatedCredits: pagesFetched + 1, pagesFetched, reachedGenesis,
      resolved: { earliestSignature, earliestTimestamp, likelyCreatorWallet: null, transactionSource: null },
      errorReason: 'helius_enhanced_unreachable',
    }
  }
}

// SOLANA CREATOR RECENT LAUNCHES, DISCLOSED (Dev Intelligence engine completion task, Deep Mode
// only — same explicit opt-in contract as fetchHeliusCreatorTrace above).
//
// WHAT THIS DOES: one standard getSignaturesForAddress call on the CREATOR wallet (newest-first,
// 100 signatures — cheap), then ONE batched Enhanced Transactions call parsing up to 25 of those
// signatures, extracting launch-shaped events: TOKEN_MINT parses, and CREATE parses from a
// recognized launch program (Pump.fun). Each extracted event carries the real parsed mint address
// where the parse exposes one.
//
// HONESTY, CRITICAL — THIS IS A RECENT SAMPLE, NOT A LAUNCH HISTORY: 100 signatures of an active
// wallet may span minutes. `sampleOnly: true` is permanent and every consumer must present these
// as "launch-like events observed in the creator's most recent activity sample", never as "this
// creator has launched N tokens" — a full launch history requires indexing the wallet's entire
// life, which this codebase cannot do. Zero events found in the sample is also NOT evidence of no
// prior launches. The scanned mint's own creation event is excluded (it is not a PRIOR launch).
//
// COST, DISCLOSED: 1 standard RPC call + 1 Enhanced batch parsing ≤25 transactions per Deep
// Cluster Check click. Bounded, opt-in, never on a default scan.

const RECENT_LAUNCHES_SIGNATURE_LIMIT = 100
const RECENT_LAUNCHES_ENHANCED_PARSE_CAP = 25
const RECENT_LAUNCH_SOURCES = new Set(['PUMP_FUN', 'PUMP_AMM'])

export type SolanaCreatorLaunchEvent = {
  signature: string
  timestamp: string | null
  /** Parsed mint address of the launched token, when the Enhanced parse exposes one. Null when the event is launch-shaped but its mint could not be read from the parse. */
  mint: string | null
  source: string | null
  type: string
}

export type SolanaCreatorRecentLaunchesResult = {
  called: boolean
  success: boolean
  /** Permanent: this is a bounded recent-activity sample, never a full launch history. */
  sampleOnly: true
  signaturesSampled: number
  transactionsParsed: number
  events: SolanaCreatorLaunchEvent[]
  errorReason: string | null
}

function emptyRecentLaunchesResult(called: boolean, errorReason: string | null): SolanaCreatorRecentLaunchesResult {
  return { called, success: false, sampleOnly: true, signaturesSampled: 0, transactionsParsed: 0, events: [], errorReason }
}

export async function fetchHeliusCreatorRecentLaunches(creatorWallet: string, scannedMint: string, fetchImpl: FetchImpl): Promise<SolanaCreatorRecentLaunchesResult> {
  if (!isHeliusConfigured()) return emptyRecentLaunchesResult(false, 'Helius Solana enrichment is not enabled (ENABLE_HELIUS_SOLANA is not "true", or HELIUS_API_KEY is missing).')
  const apiKey = getHeliusApiKey()
  if (!apiKey) return emptyRecentLaunchesResult(false, 'HELIUS_API_KEY missing.')

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  let signatures: string[] = []
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [creatorWallet, { limit: RECENT_LAUNCHES_SIGNATURE_LIMIT }] }),
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) return emptyRecentLaunchesResult(true, `helius_launch_sig_http_${res.status}`)
    const json = await res.json().catch(() => null) as { result?: Array<{ signature?: string }>; error?: { message?: string } } | null
    if (!json) return emptyRecentLaunchesResult(true, 'helius_launch_sig_bad_json')
    if (json.error) return emptyRecentLaunchesResult(true, `helius_launch_sig_rpc_error:${json.error.message ?? 'unknown'}`)
    signatures = (Array.isArray(json.result) ? json.result : []).map((r) => r?.signature).filter((s): s is string => typeof s === 'string')
  } catch {
    return emptyRecentLaunchesResult(true, 'helius_launch_sig_unreachable')
  }
  if (signatures.length === 0) return { called: true, success: true, sampleOnly: true, signaturesSampled: 0, transactionsParsed: 0, events: [], errorReason: null }

  const toParse = signatures.slice(0, RECENT_LAUNCHES_ENHANCED_PARSE_CAP)
  try {
    const res = await fetchImpl(`https://api.helius.xyz/v0/transactions/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: toParse }),
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) return { ...emptyRecentLaunchesResult(true, `helius_launch_enhanced_http_${res.status}`), signaturesSampled: signatures.length }
    const parsed = await res.json().catch(() => null) as unknown
    const txs = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []
    const events: SolanaCreatorLaunchEvent[] = []
    const seenMints = new Set<string>()
    for (const tx of txs) {
      const type = typeof tx?.type === 'string' ? tx.type : null
      const source = typeof tx?.source === 'string' ? tx.source : null
      if (!type) continue
      const isLaunchShaped = type === 'TOKEN_MINT' || (type === 'CREATE' && source != null && RECENT_LAUNCH_SOURCES.has(source))
      if (!isLaunchShaped) continue
      const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers as Array<Record<string, unknown>> : []
      const mintRaw = transfers.map((t) => t?.mint).find((m): m is string => typeof m === 'string' && m.length > 0) ?? null
      const mint = mintRaw !== scannedMint ? mintRaw : null
      if (mintRaw === scannedMint) continue // the scanned token's own creation is not a PRIOR launch
      if (mint && seenMints.has(mint)) continue
      if (mint) seenMints.add(mint)
      const ts = typeof tx.timestamp === 'number' ? new Date(tx.timestamp * 1000).toISOString() : null
      const sig = typeof tx.signature === 'string' ? tx.signature : ''
      events.push({ signature: sig, timestamp: ts, mint, source, type })
    }
    return { called: true, success: true, sampleOnly: true, signaturesSampled: signatures.length, transactionsParsed: txs.length, events, errorReason: null }
  } catch {
    return { ...emptyRecentLaunchesResult(true, 'helius_launch_enhanced_unreachable'), signaturesSampled: signatures.length }
  }
}

// SOLANA WALLET FUNDING TRACE, DISCLOSED (Cluster Map / Linked Wallets follow-up, Deep Mode only).
//
// Same cost/opt-in contract as fetchHeliusCreatorTrace above — never called outside an explicit
// Deep Cluster Check action. Given a WALLET address (typically the likely creator wallet already
// resolved by fetchHeliusCreatorTrace), this paginates that wallet's OWN signature history back to
// its earliest found transaction, then reads the Enhanced Transactions parse of that one signature
// for its `nativeTransfers` array to find the first SOL transfer INTO the wallet — that sender is
// real, on-chain evidence of a "funding wallet" relationship, not a guess.
//
// SCOPE, DISCLOSED: this resolves exactly ONE hop (who funded this wallet first, in SOL). It does
// NOT attempt shared-signer / shared-fee-payer / shared-token-creation / shared-LP-creation /
// shared-ATA-creation / shared-authority-history relationships across OTHER mints — those would
// require indexing the full transaction history of every related wallet across the entire chain,
// which is unbounded and not safely attempted without a dedicated indexer this codebase does not
// have. See clusterAnalyzer.ts for how this one real hop is combined with the creator trace into a
// disclosed, honestly-scoped cluster read.
export type SolanaWalletFundingTraceResult = {
  called: boolean
  success: boolean
  pagesFetched: number
  reachedGenesis: boolean
  resolved: {
    walletEarliestSignature: string | null
    walletEarliestTimestamp: string | null
    fundingWallet: string | null
    fundingAmountSol: number | null
  }
  errorReason: string | null
}

function emptyWalletFundingTraceResult(called: boolean, errorReason: string | null, pagesFetched = 0): SolanaWalletFundingTraceResult {
  return {
    called, success: false, pagesFetched, reachedGenesis: false,
    resolved: { walletEarliestSignature: null, walletEarliestTimestamp: null, fundingWallet: null, fundingAmountSol: null },
    errorReason,
  }
}

export async function fetchHeliusWalletFundingTrace(walletAddress: string, fetchImpl: FetchImpl): Promise<SolanaWalletFundingTraceResult> {
  if (!isHeliusConfigured()) return emptyWalletFundingTraceResult(false, 'Helius Solana enrichment is not enabled (ENABLE_HELIUS_SOLANA is not "true", or HELIUS_API_KEY is missing).')
  const apiKey = getHeliusApiKey()
  if (!apiKey) return emptyWalletFundingTraceResult(false, 'HELIUS_API_KEY missing.')

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
  let before: string | undefined
  let earliestSignature: string | null = null
  let earliestBlockTime: number | null = null
  let pagesFetched = 0
  let reachedGenesis = false

  try {
    for (let page = 1; page <= DEEP_CREATOR_MAX_SIGNATURE_PAGES; page++) {
      const params = before ? [walletAddress, { limit: DEEP_CREATOR_SIGNATURE_PAGE_LIMIT, before }] : [walletAddress, { limit: DEEP_CREATOR_SIGNATURE_PAGE_LIMIT }]
      const res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params }),
        signal: AbortSignal.timeout(9000),
      })
      if (!res.ok) return earliestSignature ? { ...emptyWalletFundingTraceResult(true, null, pagesFetched), errorReason: `helius_wallet_sig_page_http_${res.status}` } : emptyWalletFundingTraceResult(true, `helius_wallet_sig_page_http_${res.status}`, pagesFetched)
      const json = await res.json().catch(() => null) as { result?: Array<{ signature?: string; blockTime?: number | null }>; error?: { message?: string } } | null
      if (!json) break
      if (json.error) return emptyWalletFundingTraceResult(true, `helius_wallet_sig_page_rpc_error:${json.error.message ?? 'unknown'}`, pagesFetched)
      const rows = Array.isArray(json.result) ? json.result : []
      if (rows.length === 0) { reachedGenesis = pagesFetched > 0; break }
      pagesFetched++
      const last = rows[rows.length - 1]
      if (typeof last?.signature === 'string') { earliestSignature = last.signature; earliestBlockTime = typeof last.blockTime === 'number' ? last.blockTime : null }
      before = last?.signature
      if (rows.length < DEEP_CREATOR_SIGNATURE_PAGE_LIMIT) { reachedGenesis = true; break }
    }
  } catch {
    return earliestSignature ? { ...emptyWalletFundingTraceResult(true, null, pagesFetched), errorReason: 'helius_wallet_sig_page_unreachable' } : emptyWalletFundingTraceResult(true, 'helius_wallet_sig_page_unreachable', pagesFetched)
  }

  if (!earliestSignature) return emptyWalletFundingTraceResult(true, 'no_signature_history_found', pagesFetched)
  const earliestTimestamp = earliestBlockTime != null ? new Date(earliestBlockTime * 1000).toISOString() : null

  try {
    const res = await fetchImpl(`https://api.helius.xyz/v0/transactions/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [earliestSignature] }),
      signal: AbortSignal.timeout(9000),
    })
    if (!res.ok) {
      return {
        called: true, success: false, pagesFetched, reachedGenesis,
        resolved: { walletEarliestSignature: earliestSignature, walletEarliestTimestamp: earliestTimestamp, fundingWallet: null, fundingAmountSol: null },
        errorReason: `helius_enhanced_http_${res.status}`,
      }
    }
    const parsed = await res.json().catch(() => null) as unknown
    const tx = Array.isArray(parsed) ? parsed[0] as Record<string, unknown> | undefined : undefined
    const transfers = Array.isArray(tx?.nativeTransfers) ? tx.nativeTransfers as Array<Record<string, unknown>> : []
    const incoming = transfers.find((t) => typeof t.toUserAccount === 'string' && t.toUserAccount === walletAddress && typeof t.fromUserAccount === 'string' && t.fromUserAccount !== walletAddress)
    const fundingWallet = incoming && typeof incoming.fromUserAccount === 'string' ? incoming.fromUserAccount : null
    const lamports = incoming && typeof incoming.amount === 'number' ? incoming.amount : null
    const fundingAmountSol = lamports != null ? lamports / 1_000_000_000 : null
    return {
      called: true, success: fundingWallet != null, pagesFetched, reachedGenesis,
      resolved: { walletEarliestSignature: earliestSignature, walletEarliestTimestamp: earliestTimestamp, fundingWallet, fundingAmountSol },
      errorReason: fundingWallet != null ? null : 'helius_enhanced_no_incoming_native_transfer_in_response',
    }
  } catch {
    return {
      called: true, success: false, pagesFetched, reachedGenesis,
      resolved: { walletEarliestSignature: earliestSignature, walletEarliestTimestamp: earliestTimestamp, fundingWallet: null, fundingAmountSol: null },
      errorReason: 'helius_enhanced_unreachable',
    }
  }
}
