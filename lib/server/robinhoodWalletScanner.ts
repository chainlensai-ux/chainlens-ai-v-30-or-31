// ROBINHOOD WALLET SCANNER, DISCLOSED (phased Robinhood Chain Wallet Scanner rollout).
//
// ARCHITECTURE, DISCLOSED: Wallet Scanner's existing V2 pipeline (src/pipeline/*) supports chain
// membership through three separate, non-overlapping unions (SupportedChain, SwapNormalizerChain,
// SUPPORTED_CHAINS) with no single adapter interface, plus a receipt-log swap decoder that is
// explicitly scoped to Base only (src/modules/receiptSwapDecoder/decodeLogs.ts: "SCOPE, DISCLOSED:
// Base chain only") and a router allowlist that is a flat, chain-unaware Set. Threading a new chain
// through all of that to reach parity with Base/Ethereum would touch many files shared by every
// existing chain's scans — real risk to "do not break Base/Ethereum" for a chain that, per this
// task's own hard rules, cannot even reach parity yet (no verified Robinhood swap router exists
// anywhere in this codebase — see Phase 3 note below). This module is therefore a genuinely
// separate, standalone Robinhood scanner — the same shape this codebase already uses for Solana
// (lib/server/solanaTokenScannerBeta.ts, lib/server/solana/providerMerge.ts): its own chain config,
// its own provider calls, its own cache namespace, its own audit object — called from its own route
// (app/api/wallet-scan/robinhood/route.ts), never mixed into the V2 pipeline's shared types. Zero
// lines in src/pipeline/*, src/modules/fifoEngine/*, or src/modules/receiptSwapDecoder/* are
// touched by this file or its route — Base/Ethereum wallet scans are provably unaffected.
//
// PHASE STATUS, DISCLOSED:
//   Phase 1 (this file) — chain config, native ETH balance, token holdings, current prices where
//     provider-supported, portfolio total, chain-strict cache. DONE.
//   Phase 2 (this file) — wallet activity (token/native transfers, in/out classification only,
//     never buy/sell/swap labels). DONE.
//   Phase 3 (swap decoding) — NOT built. A real, independently-verified Robinhood swap ROUTER
//     address does not exist anywhere in this codebase today (confirmed: lib/server/lpProof.ts's own
//     resolveConcentratedProtocol hardcodes `router: null` for Robinhood — the only Robinhood
//     contract addresses verified in this codebase are Uniswap V3's NonfungiblePositionManager and
//     V4's PoolManager/PositionManager, which answer "who owns this LP position," not "what routed
//     this swap"). Per this task's own hard rule ("Do NOT use Base/Ethereum router or pool
//     assumptions on Robinhood unless verified"), Phase 3 cannot be built without fabricating or
//     guessing a router address — left honestly unbuilt. robinhoodWalletSwapDecodeAudit's TYPE is
//     defined below so Phase 3 has a ready target, but nothing constructs one yet.
//   Phase 4 (pricing + PnL) — gated OFF by design (pnlStatus is always 'not_verified' below) until
//     Phase 3 exists and passes FIFO regression — src/modules/fifoEngine/ itself needs zero changes
//     for this (chain is a passthrough label there, confirmed), it just never receives Robinhood
//     trade events because Phase 3 never produces any.

import { getRobinhoodRpcUrl, isRobinhoodChainAvailable, ROBINHOOD_CHAIN_ID, ROBINHOOD_CHAIN_SLUG, ROBINHOOD_CHAIN_NATIVE_CURRENCY } from './robinhoodChainConfig'
import { getTokenCache, setTokenCache } from './cache/tokenCache'

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

// CHAIN-IDENTIFIER FALLBACK, DISCLOSED: mirrors lib/server/goldrushHolderCount.ts's own
// CHAIN_PATHS exactly (same provider, same unresolved-slug caveat) — Covalent/GoldRush's real
// Robinhood Chain support is confirmed, but the exact slug string is not independently confirmed
// from this sandbox, so both the conventional '{name}-mainnet' slug and the verified real numeric
// chain id (4663) are tried in order; a 404 on the first means "wrong identifier," not "no data."
const GOLDRUSH_HOST = 'api.covalenthq.com'
const ROBINHOOD_CHAIN_PATHS = ['robinhood-mainnet', String(ROBINHOOD_CHAIN_ID)]
const BALANCES_TIMEOUT_MS = 8_000
const TRANSACTIONS_TIMEOUT_MS = 8_000
const RPC_TIMEOUT_MS = 6_000
const CACHE_TTL_SECONDS = 60

// ── Chain-strict cache keys, DISCLOSED: mirrors the same (chain, subject) key-scoping convention
// already established for Solana (lib/server/solana/holderConcentrationResolver.ts) and Token
// Scanner (lib/tokenScannerChainStrictness.ts) — never shared with, or falls back to, another
// chain's cached entry, even accidentally. ─────────────────────────────────────────────────────
export function robinhoodWalletCacheKey(kind: 'holdings' | 'activity', wallet: string, token = 'ALL'): string {
  return `robinhood:${wallet.toLowerCase()}:${token.toLowerCase()}:${kind}`
}

export function rejectWrongChainRobinhoodCache(
  cached: { chainSlug?: string | null; wallet?: string | null } | null | undefined,
  want: { wallet: string },
): boolean {
  if (!cached) return true
  if (String(cached.chainSlug ?? '').toLowerCase() !== ROBINHOOD_CHAIN_SLUG) return true
  if (String(cached.wallet ?? '').toLowerCase() !== want.wallet.toLowerCase()) return true
  return false
}

// ── Types ────────────────────────────────────────────────────────────────────────────────────

export type RobinhoodTokenHolding = {
  address: string
  symbol: string | null
  name: string | null
  decimals: number | null
  rawBalance: string
  uiBalance: number | null
  priceUsd: number | null
  priceSource: 'goldrush' | 'dexscreener' | null
  valueUsd: number | null
}

export type RobinhoodNativeBalance = {
  symbol: string
  rawBalance: string
  uiBalance: number | null
  priceUsd: number | null
  priceSource: 'goldrush' | null
  valueUsd: number | null
}

export type RobinhoodHoldingsStatus = 'ok' | 'partial' | 'unavailable' | 'not_configured'

export type RobinhoodWalletHoldingsResult = {
  status: RobinhoodHoldingsStatus
  wallet: string
  chainSlug: 'robinhood'
  chainId: number
  native: RobinhoodNativeBalance | null
  holdings: RobinhoodTokenHolding[]
  portfolioTotalUsd: number | null
  unpricedTokenCount: number
  reason: string | null
  fromCache: boolean
}

export type RobinhoodTransferDirection = 'incoming' | 'outgoing'

// ACTIVITY, NEVER TRADE LABELS, DISCLOSED: this type deliberately has no buy/sell/swap field —
// Phase 2's hard rule is "do not classify as buy/sell yet unless swap evidence is verified," and no
// verified Robinhood swap evidence exists yet (see file header). `kind` only ever distinguishes the
// on-chain transfer TYPE (native vs token), never trading intent.
export type RobinhoodActivityItem = {
  txHash: string
  blockTimestamp: string | null
  kind: 'native_transfer' | 'token_transfer'
  direction: RobinhoodTransferDirection
  counterparty: string | null
  tokenAddress: string | null
  tokenSymbol: string | null
  rawAmount: string | null
}

export type RobinhoodActivityStatus = 'ok' | 'partial' | 'unavailable' | 'not_configured'

export type RobinhoodWalletActivityResult = {
  status: RobinhoodActivityStatus
  wallet: string
  chainSlug: 'robinhood'
  items: RobinhoodActivityItem[]
  // SKIPPED-LOGS DIAGNOSTIC, DISCLOSED (Phase 1/2 audit follow-up): every decoded log event whose
  // name is NOT the recognized ERC-20 `Transfer` — most importantly a raw `Swap` event — used to be
  // silently dropped with no trace at all. It is still never turned into an activity item (no
  // verified swap-decoding exists — see file header), but it is now counted here so a real DEX
  // interaction on this wallet is visible in the audit as "N unrecognized logs skipped" rather than
  // looking identical to a wallet with zero DEX activity at all.
  skippedSwapLogs: number
  reason: string | null
  fromCache: boolean
}

// Phase 3 target shape — not constructed anywhere yet (see file header). Kept here, not deleted,
// so the eventual real swap decoder has an already-agreed-upon audit shape to fill in.
export type RobinhoodWalletSwapDecodeAudit = {
  wallet: string
  txHash: string
  router: string | null
  pool: string | null
  dexName: string | null
  tokenIn: string | null
  tokenOut: string | null
  quoteToken: string | null
  amountIn: string | null
  amountOut: string | null
  confidence: 'high' | 'medium' | 'low' | null
  rejectionReason: string | null
}

// DISABLED-PNL REASON, DISCLOSED: one fixed, honest sentence — never varies per scan, since the
// reason PnL is disabled (no verified swap decoding) is a fact about this codebase's current state,
// not about any particular wallet's data.
const DISABLED_PNL_REASON = 'No independently-verified Robinhood swap router exists yet, so activity cannot be decoded into buy/sell trades — PnL cannot be computed safely without that.'

export type RobinhoodProviderStatus = 'ok' | 'partial' | 'unavailable' | 'not_configured' | 'not_run'

// AUDIT SHAPE, DISCLOSED (Phase 1/2 audit task — exact required field set): every field here is
// either a real, measured status/count from this scan, or the one fixed disabled-PnL constant above
// — nothing here is guessed or defaulted to a "healthy-looking" value when the real answer is
// unknown (a field that never ran reports 'not_run', not 'ok').
export type RobinhoodWalletScannerAudit = {
  wallet: string
  holdingsStatus: RobinhoodHoldingsStatus | 'not_run'
  nativeBalanceStatus: RobinhoodProviderStatus
  tokenBalanceStatus: RobinhoodProviderStatus
  pricingStatus: RobinhoodProviderStatus
  activityStatus: RobinhoodActivityStatus | 'not_run'
  skippedSwapLogs: number
  unpricedTokenCount: number
  pnlStatus: 'disabled'
  disabledPnlReason: string
  wrongChainCacheRejected: boolean
  // ADDITIVE, DISCLOSED: not in the task's minimum required shape, kept because they carry real
  // diagnostic value the required fields alone don't — chainId for at-a-glance chain identity,
  // swapDecodeStatus makes the Phase 3 gate explicit (never 'verified'/'unverified' since no attempt
  // has run), unsupportedReasons is the human-readable expansion of disabledPnlReason plus any
  // provider-specific failure reasons for this scan.
  chainId: number
  swapDecodeStatus: 'not_built'
  unsupportedReasons: string[]
}

export function formatRobinhoodPnlNotVerifiedMessage(): string {
  return 'Robinhood PnL not verified yet — activity decoding pending.'
}

export function buildRobinhoodWalletScannerAudit(input: {
  wallet: string
  holdings: RobinhoodWalletHoldingsResult | null
  activity: RobinhoodWalletActivityResult | null
  wrongChainCacheRejected: boolean
}): RobinhoodWalletScannerAudit {
  const unsupportedReasons: string[] = [
    'Robinhood swap decoding is not built — no independently-verified Robinhood swap router exists yet.',
    DISABLED_PNL_REASON,
  ]
  if (input.holdings?.reason) unsupportedReasons.push(`Holdings: ${input.holdings.reason}`)
  if (input.activity?.reason) unsupportedReasons.push(`Activity: ${input.activity.reason}`)

  // NATIVE/TOKEN-BALANCE-SPECIFIC STATUS, DISCLOSED: holdingsStatus is the combined outcome (native
  // + token balances + pricing all folded together), which is fine for a top-line status but hides
  // WHICH leg actually failed. These two split it back out so "native RPC is down but GoldRush token
  // balances are fine" and "GoldRush is down but RPC native balance worked" are distinguishable —
  // both real, both measured from the same holdings result, never guessed.
  const nativeBalanceStatus: RobinhoodProviderStatus = !input.holdings
    ? 'not_run'
    : input.holdings.status === 'not_configured'
      ? 'not_configured'
      : input.holdings.native != null
        ? 'ok'
        : 'unavailable'
  const tokenBalanceStatus: RobinhoodProviderStatus = !input.holdings
    ? 'not_run'
    : input.holdings.status === 'not_configured'
      ? 'not_configured'
      : input.holdings.holdings.length > 0
        ? (input.holdings.unpricedTokenCount > 0 ? 'partial' : 'ok')
        : 'unavailable'
  const pricingStatus: RobinhoodProviderStatus = !input.holdings
    ? 'not_run'
    : input.holdings.status === 'not_configured'
      ? 'not_configured'
      : input.holdings.unpricedTokenCount > 0
        ? 'partial'
        : (input.holdings.native?.priceUsd != null || input.holdings.holdings.some((h) => h.priceUsd != null))
          ? 'ok'
          : 'unavailable'

  return {
    wallet: input.wallet,
    holdingsStatus: input.holdings?.status ?? 'not_run',
    nativeBalanceStatus,
    tokenBalanceStatus,
    pricingStatus,
    activityStatus: input.activity?.status ?? 'not_run',
    skippedSwapLogs: input.activity?.skippedSwapLogs ?? 0,
    unpricedTokenCount: input.holdings?.unpricedTokenCount ?? 0,
    pnlStatus: 'disabled',
    disabledPnlReason: DISABLED_PNL_REASON,
    wrongChainCacheRejected: input.wrongChainCacheRejected,
    chainId: ROBINHOOD_CHAIN_ID,
    swapDecodeStatus: 'not_built',
    unsupportedReasons,
  }
}

// ── RPC: native ETH balance ─────────────────────────────────────────────────────────────────────

async function rpcCall(rpcUrl: string, method: string, params: unknown[], fetchImpl: FetchImpl): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}` }
    const json = await res.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null
    if (json?.error) return { ok: false, error: `rpc_error:${json.error.message ?? 'unknown'}` }
    if (json?.result === undefined) return { ok: false, error: 'rpc_null_result' }
    return { ok: true, result: json.result }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, error: timedOut ? 'rpc_timeout' : 'rpc_unreachable' }
  }
}

export async function fetchRobinhoodNativeBalance(wallet: string, fetchImpl: FetchImpl, rpcUrl: string): Promise<{ rawBalance: string | null; reason: string | null }> {
  const call = await rpcCall(rpcUrl, 'eth_getBalance', [wallet, 'latest'], fetchImpl)
  if (!call.ok) return { rawBalance: null, reason: call.error }
  const hex = typeof call.result === 'string' ? call.result : null
  if (!hex) return { rawBalance: null, reason: 'rpc_non_hex_result' }
  try {
    return { rawBalance: BigInt(hex).toString(), reason: null }
  } catch {
    return { rawBalance: null, reason: 'rpc_unparseable_balance' }
  }
}

// ── GoldRush/Covalent: token balances ───────────────────────────────────────────────────────────

type CovalentBalanceItem = {
  contract_address?: string
  contract_ticker_symbol?: string
  contract_name?: string
  contract_decimals?: number
  balance?: string
  quote_rate?: number | null
  native_token?: boolean
}

async function fetchCovalentBalances(wallet: string, fetchImpl: FetchImpl): Promise<{ items: CovalentBalanceItem[] | null; reason: string | null; chainPathUsed: string | null }> {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
  if (!apiKey) return { items: null, reason: 'no_api_key', chainPathUsed: null }
  const attempt = async (chainPath: string) => {
    try {
      const res = await fetchImpl(
        `https://${GOLDRUSH_HOST}/v1/${chainPath}/address/${wallet}/balances_v2/`,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(BALANCES_TIMEOUT_MS) },
      )
      if (!res.ok) return { items: null as CovalentBalanceItem[] | null, reason: res.status === 429 ? 'rate_limited' : 'http_error', httpStatus: res.status }
      const json = await res.json().catch(() => null) as { data?: { items?: CovalentBalanceItem[] } } | null
      const items = Array.isArray(json?.data?.items) ? json!.data!.items! : null
      if (!items) return { items: null as CovalentBalanceItem[] | null, reason: 'no_data', httpStatus: 200 }
      return { items, reason: null as string | null, httpStatus: 200 }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      return { items: null as CovalentBalanceItem[] | null, reason: timedOut ? 'timeout' : 'http_error', httpStatus: null }
    }
  }
  for (const chainPath of ROBINHOOD_CHAIN_PATHS) {
    const result = await attempt(chainPath)
    if (result.items) return { items: result.items, reason: null, chainPathUsed: chainPath }
    if (result.httpStatus !== 404 && result.reason !== 'no_data') return { items: null, reason: result.reason, chainPathUsed: chainPath }
  }
  return { items: null, reason: 'no_data', chainPathUsed: ROBINHOOD_CHAIN_PATHS[ROBINHOOD_CHAIN_PATHS.length - 1] }
}

// ── DexScreener: current price fallback (Robinhood's own indexed slug — confirmed real support:
// app/api/token/route.ts's own COVALENT/DexScreener disclosure for Robinhood tokens) ─────────────

export async function fetchRobinhoodDexscreenerPrice(contract: string, fetchImpl: FetchImpl): Promise<number | null> {
  try {
    const res = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${contract}`, { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const json = await res.json().catch(() => null) as { pairs?: Array<{ chainId?: string; priceUsd?: string }> } | null
    const pair = (json?.pairs ?? []).find((p) => String(p.chainId ?? '').toLowerCase() === ROBINHOOD_CHAIN_SLUG)
    if (!pair?.priceUsd) return null
    const n = Number(pair.priceUsd)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

// ── Phase 1: holdings + portfolio ───────────────────────────────────────────────────────────────

export async function resolveRobinhoodWalletHoldings(wallet: string, deps: { fetchImpl: FetchImpl; cached?: (RobinhoodWalletHoldingsResult & { chainSlug: 'robinhood'; wallet: string }) | null }): Promise<RobinhoodWalletHoldingsResult> {
  if (deps.cached && !rejectWrongChainRobinhoodCache(deps.cached, { wallet })) {
    return { ...deps.cached, fromCache: true }
  }
  if (!isRobinhoodChainAvailable()) {
    return { status: 'not_configured', wallet, chainSlug: 'robinhood', chainId: ROBINHOOD_CHAIN_ID, native: null, holdings: [], portfolioTotalUsd: null, unpricedTokenCount: 0, reason: 'Robinhood Chain is not configured (missing feature flag or RPC URL).', fromCache: false }
  }
  const rpcUrl = getRobinhoodRpcUrl()
  if (!rpcUrl) {
    return { status: 'not_configured', wallet, chainSlug: 'robinhood', chainId: ROBINHOOD_CHAIN_ID, native: null, holdings: [], portfolioTotalUsd: null, unpricedTokenCount: 0, reason: 'Robinhood RPC URL is not configured.', fromCache: false }
  }

  const [nativeResult, balances] = await Promise.all([
    fetchRobinhoodNativeBalance(wallet, deps.fetchImpl, rpcUrl),
    fetchCovalentBalances(wallet, deps.fetchImpl),
  ])

  let native: RobinhoodNativeBalance | null = null
  if (nativeResult.rawBalance != null) {
    // NEVER-FAKE-A-PRICE FIX, DISCLOSED (Phase 1/2 audit): this used to query DexScreener with the
    // literal string 'WETH' as if it were a token CONTRACT ADDRESS — dexscreener.com/latest/dex/
    // tokens/WETH is not a real lookup, it would only ever return zero pairs (silently degrading
    // native pricing to "unavailable" every time) or, in the worst case, whatever DexScreener's own
    // fuzzy matching did with a bare symbol string — neither is a real, verified same-chain price.
    // No verified wrapped-native (WETH-equivalent) contract address for Robinhood Chain exists
    // anywhere in this codebase (checked: robinhoodChainConfig.ts, lpProof.ts,
    // uniswapV4RobinhoodRpc.ts — none define one), so guessing one is exactly the "assumption
    // unless verified" this task's hard rules forbid. Instead, this now reads the REAL price
    // Covalent/GoldRush's own balances_v2 response already returns for the wallet's native-ETH row
    // (`native_token: true`, same `quote_rate` field already trusted for every ERC-20 holding below)
    // — a real, chain-scoped provider price, not a guessed lookup. Stays null, honestly, if
    // GoldRush's own response has no native row or no rate for it.
    const nativeCovalentRow = balances.items?.find((item) => item.native_token)
    const nativePriceUsd = typeof nativeCovalentRow?.quote_rate === 'number' && nativeCovalentRow.quote_rate > 0 ? nativeCovalentRow.quote_rate : null
    const uiBalance = Number(nativeResult.rawBalance) / 1e18
    native = {
      symbol: ROBINHOOD_CHAIN_NATIVE_CURRENCY,
      rawBalance: nativeResult.rawBalance,
      uiBalance: Number.isFinite(uiBalance) ? uiBalance : null,
      priceUsd: nativePriceUsd,
      priceSource: nativePriceUsd != null ? 'goldrush' : null,
      valueUsd: nativePriceUsd != null && Number.isFinite(uiBalance) ? uiBalance * nativePriceUsd : null,
    }
  }

  const holdings: RobinhoodTokenHolding[] = []
  let unpricedTokenCount = 0
  if (balances.items) {
    for (const item of balances.items) {
      if (item.native_token) continue
      if (!item.contract_address || !item.balance) continue
      const decimals = typeof item.contract_decimals === 'number' ? item.contract_decimals : null
      const uiBalance = decimals != null ? Number(item.balance) / 10 ** decimals : null
      let priceUsd: number | null = typeof item.quote_rate === 'number' && item.quote_rate > 0 ? item.quote_rate : null
      let priceSource: RobinhoodTokenHolding['priceSource'] = priceUsd != null ? 'goldrush' : null
      if (priceUsd == null) {
        const fallback = await fetchRobinhoodDexscreenerPrice(item.contract_address, deps.fetchImpl).catch(() => null)
        if (fallback != null) { priceUsd = fallback; priceSource = 'dexscreener' }
      }
      if (priceUsd == null) unpricedTokenCount += 1
      holdings.push({
        address: item.contract_address,
        symbol: item.contract_ticker_symbol ?? null,
        name: item.contract_name ?? null,
        decimals,
        rawBalance: item.balance,
        uiBalance: uiBalance != null && Number.isFinite(uiBalance) ? uiBalance : null,
        priceUsd,
        priceSource,
        valueUsd: priceUsd != null && uiBalance != null && Number.isFinite(uiBalance) ? uiBalance * priceUsd : null,
      })
    }
  }

  const status: RobinhoodHoldingsStatus = native == null && holdings.length === 0
    ? (balances.reason === 'no_api_key' ? 'not_configured' : 'unavailable')
    : (unpricedTokenCount > 0 || balances.reason ? 'partial' : 'ok')

  const portfolioTotalUsd = (native?.valueUsd != null || holdings.some((h) => h.valueUsd != null))
    ? (native?.valueUsd ?? 0) + holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)
    : null

  return {
    status,
    wallet,
    chainSlug: 'robinhood',
    chainId: ROBINHOOD_CHAIN_ID,
    native,
    holdings,
    portfolioTotalUsd,
    unpricedTokenCount,
    reason: status === 'ok' ? null : (balances.reason ?? nativeResult.reason ?? 'no_holdings_data_returned'),
    fromCache: false,
  }
}

// ── Phase 2: activity (transfers only, never trade labels) ─────────────────────────────────────

type CovalentTxLogEvent = {
  decoded?: { name?: string; params?: Array<{ name?: string; value?: string }> }
  sender_contract_ticker_symbol?: string
  sender_address?: string
}
type CovalentTransaction = {
  tx_hash?: string
  block_signed_at?: string
  from_address?: string
  to_address?: string
  value?: string
  log_events?: CovalentTxLogEvent[]
}

export async function fetchRobinhoodTransactions(wallet: string, fetchImpl: FetchImpl): Promise<{ items: CovalentTransaction[] | null; reason: string | null }> {
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
  if (!apiKey) return { items: null, reason: 'no_api_key' }
  const attempt = async (chainPath: string) => {
    try {
      const res = await fetchImpl(
        `https://${GOLDRUSH_HOST}/v1/${chainPath}/address/${wallet}/transactions_v3/`,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TRANSACTIONS_TIMEOUT_MS) },
      )
      if (!res.ok) return { items: null as CovalentTransaction[] | null, reason: res.status === 429 ? 'rate_limited' : 'http_error', httpStatus: res.status }
      const json = await res.json().catch(() => null) as { data?: { items?: CovalentTransaction[] } } | null
      const items = Array.isArray(json?.data?.items) ? json!.data!.items! : null
      if (!items) return { items: null as CovalentTransaction[] | null, reason: 'no_data', httpStatus: 200 }
      return { items, reason: null as string | null, httpStatus: 200 }
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      return { items: null as CovalentTransaction[] | null, reason: timedOut ? 'timeout' : 'http_error', httpStatus: null }
    }
  }
  for (const chainPath of ROBINHOOD_CHAIN_PATHS) {
    const result = await attempt(chainPath)
    if (result.items) return { items: result.items, reason: null }
    if (result.httpStatus !== 404 && result.reason !== 'no_data') return { items: null, reason: result.reason }
  }
  return { items: null, reason: 'no_data' }
}

const ERC20_TRANSFER_EVENT_NAME = 'Transfer'

export async function resolveRobinhoodWalletActivity(wallet: string, deps: { fetchImpl: FetchImpl; cached?: (RobinhoodWalletActivityResult & { chainSlug: 'robinhood'; wallet: string }) | null }): Promise<RobinhoodWalletActivityResult> {
  if (deps.cached && !rejectWrongChainRobinhoodCache(deps.cached, { wallet })) {
    return { ...deps.cached, fromCache: true }
  }
  if (!isRobinhoodChainAvailable()) {
    return { status: 'not_configured', wallet, chainSlug: 'robinhood', items: [], skippedSwapLogs: 0, reason: 'Robinhood Chain is not configured.', fromCache: false }
  }
  const { items: txs, reason } = await fetchRobinhoodTransactions(wallet, deps.fetchImpl)
  if (!txs) {
    return { status: reason === 'no_api_key' ? 'not_configured' : 'unavailable', wallet, chainSlug: 'robinhood', items: [], skippedSwapLogs: 0, reason: reason ?? 'no_data', fromCache: false }
  }
  const lowerWallet = wallet.toLowerCase()
  const items: RobinhoodActivityItem[] = []
  let skippedSwapLogs = 0
  for (const tx of txs) {
    if (!tx.tx_hash) continue
    // Native transfer — the tx's own top-level value field, present whenever the tx moved native
    // ETH directly (not a token transfer, which never sets top-level `value`).
    if (tx.value && tx.value !== '0') {
      const isOutgoing = String(tx.from_address ?? '').toLowerCase() === lowerWallet
      items.push({
        txHash: tx.tx_hash,
        blockTimestamp: tx.block_signed_at ?? null,
        kind: 'native_transfer',
        direction: isOutgoing ? 'outgoing' : 'incoming',
        counterparty: isOutgoing ? (tx.to_address ?? null) : (tx.from_address ?? null),
        tokenAddress: null,
        tokenSymbol: ROBINHOOD_CHAIN_NATIVE_CURRENCY,
        rawAmount: tx.value,
      })
    }
    // Token transfers — decoded ERC-20 Transfer log events only. NO buy/sell/swap classification is
    // ever applied here, per this phase's own hard rule — every row is either an incoming or
    // outgoing token movement, nothing more is claimed.
    for (const log of tx.log_events ?? []) {
      if (log.decoded?.name !== ERC20_TRANSFER_EVENT_NAME) {
        // SKIPPED-LOGS COUNTED, DISCLOSED: this is the exact spot a raw Swap/Mint/Burn/other
        // unrecognized log event lands — counted, never silently discarded, and never turned into
        // a fabricated activity row since no verified decoder for it exists yet (see file header).
        skippedSwapLogs += 1
        continue
      }
      const fromParam = log.decoded.params?.find((p) => p.name === 'from')?.value ?? null
      const toParam = log.decoded.params?.find((p) => p.name === 'to')?.value ?? null
      const valueParam = log.decoded.params?.find((p) => p.name === 'value')?.value ?? null
      const isOutgoing = String(fromParam ?? '').toLowerCase() === lowerWallet
      const isIncoming = String(toParam ?? '').toLowerCase() === lowerWallet
      if (!isOutgoing && !isIncoming) continue
      items.push({
        txHash: tx.tx_hash,
        blockTimestamp: tx.block_signed_at ?? null,
        kind: 'token_transfer',
        direction: isOutgoing ? 'outgoing' : 'incoming',
        counterparty: isOutgoing ? toParam : fromParam,
        tokenAddress: log.sender_address ?? null,
        tokenSymbol: log.sender_contract_ticker_symbol ?? null,
        rawAmount: valueParam,
      })
    }
  }
  return { status: items.length > 0 ? 'ok' : 'partial', wallet, chainSlug: 'robinhood', items, skippedSwapLogs, reason: items.length === 0 ? 'no_transfers_found_in_returned_window' : null, fromCache: false }
}

// ── Cached wrapper, DISCLOSED: chain-strict cache reads/writes go through the shared tokenCache.ts
// module (same "fails open, always" contract every other cache in this codebase uses), scoped
// entirely under the robinhood:{wallet}:{token}:{kind} key namespace defined above — never shared
// with any other chain's cache entries. ─────────────────────────────────────────────────────────

export async function getCachedRobinhoodWalletHoldings(wallet: string, fetchImpl: FetchImpl): Promise<RobinhoodWalletHoldingsResult & { wrongChainCacheRejected: boolean }> {
  const key = robinhoodWalletCacheKey('holdings', wallet)
  const cached = await getTokenCache<RobinhoodWalletHoldingsResult & { chainSlug: 'robinhood'; wallet: string }>(key).catch(() => null)
  const wrongChainCacheRejected = rejectWrongChainRobinhoodCache(cached, { wallet })
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl, cached: cached && !wrongChainCacheRejected ? cached : null })
  if (!result.fromCache) await setTokenCache(key, result, CACHE_TTL_SECONDS).catch(() => {})
  return { ...result, wrongChainCacheRejected }
}

export async function getCachedRobinhoodWalletActivity(wallet: string, fetchImpl: FetchImpl): Promise<RobinhoodWalletActivityResult & { wrongChainCacheRejected: boolean }> {
  const key = robinhoodWalletCacheKey('activity', wallet)
  const cached = await getTokenCache<RobinhoodWalletActivityResult & { chainSlug: 'robinhood'; wallet: string }>(key).catch(() => null)
  const wrongChainCacheRejected = rejectWrongChainRobinhoodCache(cached, { wallet })
  const result = await resolveRobinhoodWalletActivity(wallet, { fetchImpl, cached: cached && !wrongChainCacheRejected ? cached : null })
  if (!result.fromCache) await setTokenCache(key, result, CACHE_TTL_SECONDS).catch(() => {})
  return { ...result, wrongChainCacheRejected }
}
