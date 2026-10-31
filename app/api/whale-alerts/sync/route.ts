import { NextResponse } from 'next/server'
import { clearWhaleFeedCache } from '@/lib/server/whaleAlertCache'
import { createClient } from '@supabase/supabase-js'
import { logRpcCall } from '@/lib/server/rpcDebug'
import { goldrushPricingGate } from '@/src/lib/providerGates'
import { targetedSyncAllowed } from '@/lib/server/whaleTargetedSync'
import { activityCursorMs, checkWalletActivity, whaleAlchemyBaseRpcUrl } from '@/lib/server/whaleActivityCheck'
import { priceAlertsAtIngestion, type SyncPricingResult } from '@/lib/server/whaleSyncPricing'
import { fetchBaseDexScreenerPrices } from '@/lib/server/whaleDexPrices'
import { resolveTokenDecimals } from '@/src/modules/normalization/canonicalDecimals'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { cronNextOffset, cronRotationStart } from '@/lib/server/whaleCronRotation'
import { selectWalletBatch, splitFreshWallets } from '@/lib/server/whaleWalletOrder'
import { classifyWallets, MINT_BURN_ADDRESSES } from '@/lib/server/whaleWalletKind'
import { alertOwnerForWallet, BASE_WETH_ADDRESS, NATIVE_ETH_SENTINEL } from '@/lib/server/whaleAlertIdentity'
import { persistWhaleAlerts, type WhaleAlertsDb, type WhaleAlertWritePath } from '@/lib/server/whaleAlertPersist'
import { BASE_WHALE_CHAIN_ID, dedupeTrackedWallets, isMissingOwnershipColumn, userOrSystemScope } from '@/lib/server/whaleAlertScope'

type TrackedWallet = {
  address: string
  user_id: string | null
  label: string | null
  category: string | null
  confidence: number | null
  source: string | null
  is_active: boolean
  last_scanned_at?: string | null
}

type CovalentLogEvent = {
  sender_address?: string | null
  sender_contract_ticker_symbol?: string | null
  sender_contract_decimals?: number | null
  decoded?: {
    name?: string
    params?: Array<{ name?: string; value?: string }>
  } | null
}

type CovalentTx = {
  tx_hash?: string
  block_signed_at?: string
  successful?: boolean
  from_address?: string | null
  to_address?: string | null
  value?: string | null
  log_events?: CovalentLogEvent[]
}

const COVALENT_BASE = 'https://api.covalenthq.com/v1/base-mainnet'
// HOST FALLBACK FIX, DISCLOSED (whale-alerts "no alerts loading" diagnosis): production logs
// showed providerErrors == walletsChecked (every single wallet in a batch failing, e.g. "10 source
// delays" out of 10 checked) — a much higher failure rate than this same GoldRush/Covalent
// transactions_v3 endpoint sees elsewhere in this codebase. lib/server/walletSnapshot.ts's
// fetchGoldrushPnlEvents already tries api.covalenthq.com first and falls back to api.goldrush.dev
// on failure for this exact endpoint — proof that api.covalenthq.com alone is not reliable enough
// on its own for this provider. This route previously had no such fallback: one failed request to
// api.covalenthq.com permanently failed that wallet for the whole batch. Bringing over the same
// two-host retry this codebase already relies on elsewhere.
const COVALENT_HOSTS = ['api.covalenthq.com', 'api.goldrush.dev'] as const
const PROVIDER_CHAIN = 'base'
const PROVIDER_PAGE_SIZE = 100
const PROVIDER_ENDPOINT_PATH = `/v1/base-mainnet/address/{wallet}/transactions_v3/?page-number=0&page-size=${PROVIDER_PAGE_SIZE}&with-logs=true`
// 40 wallets per request: most are covered by the cheap activity check (whaleActivityCheck.ts), only
// active ones reach GoldRush (waves at concurrency 10); the safety timeout still bounds a batch.
const DEFAULT_LIMIT = 40
const MAX_LIMIT = 40
const DEFAULT_OFFSET = 0
const SAFETY_TIMEOUT_MS = 19_500
// Live: single GoldRush transactions_v3 pages (with logs) took 1.1–6.3s; at 6s, ordinary pages for busy
// wallets timed out and were reported as "source delays".
const PER_WALLET_TIMEOUT_MS = 10_000
const CONCURRENCY = 10
const PRO_SYNC_COOLDOWN_MS = 60 * 1000
const ELITE_SYNC_COOLDOWN_MS = 30 * 1000
const DEV_SYNC_COOLDOWN_MS = 10 * 1000
const WALLET_TX_SYNC_CACHE_TTL_MS = 60 * 1000
// PAGINATION: up to MAX_PROVIDER_PAGES pages per wallet (newest first, following links.prev to
// older pages), stopping once the oldest tx is outside the window. A further page is only started
// while the wallet is inside WALLET_PAGE_BUDGET_MS, so one wallet costs at most budget + one page
// (2 hosts x PER_WALLET_TIMEOUT_MS), keeping a batch well under the 60s maxDuration.
const MAX_PROVIDER_PAGES = 3
const RATE_LIMIT_BASE_BACKOFF_MS = 600
const RATE_LIMIT_MAX_BACKOFF_MS = 2_000
const WALLET_PAGE_BUDGET_MS = 8_000
// Native ETH movements (tx.value) use NATIVE_ETH_SENTINEL; WETH on Base is BASE_WETH_ADDRESS.
const syncRate = new Map<string, { count: number; resetAt: number; lastRunAt: number }>()
const SYNC_RATE_BY_PLAN: Record<string, number> = { free: 2, pro: 6, elite: 15 }
function syncIp(req: Request): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
function syncAllowed(
  plan: 'free' | 'pro' | 'elite',
  req: Request,
  mode: 'batch' | 'full',
  isContinuation = false,
): { ok: boolean; cooldown: boolean; retryAfterMs?: number } {
  // Continuations always allowed — they finish a scan already started
  if (isContinuation) return { ok: true, cooldown: false }
  const key = `${mode}:${plan}:${syncIp(req)}`
  const now = Date.now()
  const cur = syncRate.get(key)
  const lim = SYNC_RATE_BY_PLAN[plan]
  const cooldownMs = process.env.NODE_ENV === 'development'
    ? DEV_SYNC_COOLDOWN_MS
    : plan === 'elite'
      ? ELITE_SYNC_COOLDOWN_MS
      : PRO_SYNC_COOLDOWN_MS
  if (cur && now - cur.lastRunAt < cooldownMs) {
    return { ok: false, cooldown: true, retryAfterMs: cooldownMs - (now - cur.lastRunAt) }
  }
  if (!cur || cur.resetAt <= now) {
    syncRate.set(key, { count: 1, resetAt: now + 60_000, lastRunAt: now })
    return { ok: true, cooldown: false }
  }
  if (cur.count >= lim) return { ok: false, cooldown: false }
  cur.count += 1
  cur.lastRunAt = now
  return { ok: true, cooldown: false }
}

type SyncWindow = '24h' | '3d' | '7d'

const WINDOW_MS: Record<SyncWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

type SkipReason =
  | 'olderThan24h'
  | 'olderThanWindow'
  | 'noTokenMovements'
  | 'missingTokenAddress'
  | 'missingUsdValue'
  | 'belowThreshold'
  | 'duplicate'
  | 'unclassified'
  | 'dbSkipped'
  | 'mintBurnNoise'
  | 'other'

type SkipSummary = Record<SkipReason, number>

type SkipSample = {
  wallet: string
  txHash: string | null
  reason: SkipReason
  tokenSymbol: string | null
  tokenAddressShort: string | null
  amountUsd: number | null
  alertType: string | null
  side: string | null
  occurredAt: string | null
}

type FinalPipelineSummary = {
  candidatesSeen: number
  attemptedInsert: number
  inserted: number
  duplicateSkipped: number
  dbInsertFailed: number
  missingRequiredField: number
  belowThresholdSkipped: number
  unknownSkipped: number
}

function makeSkipSummary(): SkipSummary {
  return {
    olderThan24h: 0,
    olderThanWindow: 0,
    noTokenMovements: 0,
    missingTokenAddress: 0,
    missingUsdValue: 0,
    belowThreshold: 0,
    duplicate: 0,
    unclassified: 0,
    dbSkipped: 0,
    mintBurnNoise: 0,
    other: 0,
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function shortHash(hash: string | null) {
  if (!hash) return null
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`
}

function parseNumeric(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function severityFromUsd(amountUsd: number | null): string | null {
  if (amountUsd === null) return null
  if (amountUsd >= 25000) return 'major'
  if (amountUsd >= 10000) return 'large'
  if (amountUsd >= 5000) return 'medium'
  if (amountUsd >= 1000) return 'small'
  return null
}

type ProviderErrorSample = {
  wallet: string
  provider: 'goldrush'
  endpointPath: string
  statusCode?: number | null
  reason: string
  responseKeys?: string[]
}

function pushProviderErrorSample(
  samples: ProviderErrorSample[],
  sample: ProviderErrorSample,
) {
  if (samples.length >= 5) return
  samples.push(sample)
}

function pushSkipSample(samples: SkipSample[], sample: SkipSample) {
  if (samples.length >= 5) return
  samples.push(sample)
}

function makeFinalPipelineSummary(): FinalPipelineSummary {
  return {
    candidatesSeen: 0,
    attemptedInsert: 0,
    inserted: 0,
    duplicateSkipped: 0,
    dbInsertFailed: 0,
    missingRequiredField: 0,
    belowThresholdSkipped: 0,
    unknownSkipped: 0,
  }
}


type ProviderPayload = {
  data?: {
    items?: CovalentTx[]
    links?: { prev?: string | null; next?: string | null } | null
  }
}

type WalletFetchOutcome =
  | { ok: true; payload: ProviderPayload }
  | { ok: false; error: ProviderRequestError }

type WalletTransactionCacheEntry = {
  payload: ProviderPayload
  expiresAt: number
}

type SyncProviderDebug = {
  walletsProcessed: number
  providerCallsAttempted: number
  providerCallsSavedByCache: number
  providerCallsSavedByDedupe: number
  cacheHits: number
  cacheMisses: number
  errorCount: number
  providerErrorSamples: ProviderErrorSample[]
}

const walletTransactionCache = new Map<string, WalletTransactionCacheEntry>()
const walletTransactionInFlight = new Map<string, Promise<WalletFetchOutcome>>()

// ── INCREMENTAL SYNC CHECKPOINT (whale sync performance task) ───────────────
// Per-wallet last-seen activity timestamp, module-lifetime (per serverless instance). On a repeat
// sync, a wallet whose provider page contains NOTHING newer than its checkpoint still gets fully
// fetched from the provider (page-size window is fixed) but its transactions older than the
// checkpoint skip parsing/classification entirely — the expensive part — while any NEW tx after
// the checkpoint is always classified, so no real alert can be missed. A wider/older-than-
// checkpoint scan (mode=full, or first sight of the wallet) bypasses the checkpoint entirely.
// Never persisted: a cold instance simply has no checkpoints and behaves exactly like before.
const walletLastSeenActivityMs = new Map<string, number>()
let adaptiveConcurrency = CONCURRENCY

// Keyed by scan window: a checkpoint only proves the txs before it were classified against THIS
// window. A 24h scan never classified a 3-day-old tx, so a later 7d batch must not skip it.
function checkpointKey(address: string, windowMs: number) {
  return `${PROVIDER_CHAIN}:${address.toLowerCase()}:window=${windowMs}`
}

function walletTransactionCacheKey(address: string, windowMs: number) {
  return `${PROVIDER_CHAIN}:${address.toLowerCase()}:page-size=${PROVIDER_PAGE_SIZE}:window=${windowMs}`
}

class ProviderRequestError extends Error {
  statusCode: number | null
  responseKeys: string[]

  constructor(statusCode: number | null, reason: string, responseKeys: string[] = []) {
    super(reason)
    this.statusCode = statusCode
    this.responseKeys = responseKeys
  }
}

function classifyProviderError(statusCode: number | null): string {
  if (statusCode === 400) return 'bad_request_params'
  if (statusCode === 401) return 'auth_invalid'
  if (statusCode === 403) return 'forbidden_or_allowlist'
  if (statusCode === 404) return 'endpoint_or_chain_invalid'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode !== null && statusCode >= 500) return 'provider_unavailable'
  return 'network_error'
}

async function fetchWalletTransactions(
  address: string,
  apiKey: string,
  syncDebug: SyncProviderDebug,
  windowMs: number,
): Promise<WalletFetchOutcome> {
  const cacheKey = walletTransactionCacheKey(address, windowMs)
  const now = Date.now()
  const cached = walletTransactionCache.get(cacheKey)

  if (cached && cached.expiresAt > now) {
    syncDebug.cacheHits += 1
    syncDebug.providerCallsSavedByCache += 1
    return { ok: true, payload: cached.payload }
  }

  if (cached) walletTransactionCache.delete(cacheKey)
  syncDebug.cacheMisses += 1

  const activeFetch = walletTransactionInFlight.get(cacheKey)
  if (activeFetch) {
    syncDebug.providerCallsSavedByDedupe += 1
    return activeFetch
  }

  syncDebug.providerCallsAttempted += 1
  const fetchPromise = fetchWalletTransactionsFromProvider(address, apiKey, Date.now() - windowMs)
    .then((payload): WalletFetchOutcome => {
      walletTransactionCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + WALLET_TX_SYNC_CACHE_TTL_MS,
      })
      return { ok: true, payload }
    })
    .catch((error): WalletFetchOutcome => ({
      ok: false,
      error: error instanceof ProviderRequestError
        ? error
        : new ProviderRequestError(null, 'provider_fetch_failed', []),
    }))
    .finally(() => {
      if (walletTransactionInFlight.get(cacheKey) === fetchPromise) {
        walletTransactionInFlight.delete(cacheKey)
      }
    })

  walletTransactionInFlight.set(cacheKey, fetchPromise)
  return fetchPromise
}

function buildProviderUrl(host: string, address: string, pageUrl?: string | null): string {
  if (pageUrl) {
    // Older page (links.prev). Same path on both hosts; only the hostname differs.
    const paged = new URL(pageUrl, `https://${host}`)
    paged.protocol = 'https:'
    paged.host = host
    paged.searchParams.set('with-logs', 'true')
    return paged.toString()
  }
  const base = host === 'api.covalenthq.com' ? COVALENT_BASE : `https://${host}/v1/base-mainnet`
  const url = new URL(`${base}/address/${address}/transactions_v3/`)
  url.searchParams.set('page-number', '0')
  url.searchParams.set('page-size', String(PROVIDER_PAGE_SIZE))
  // WITH-LOGS FIX, DISCLOSED (empty-whale-feed diagnosis): GoldRush's transactions_v3 endpoint does
  // NOT include decoded log_events by default — without this param every tx comes back with no
  // log_events, extractAlerts()'s `movements.size === 0` check below fires for every transaction on
  // every wallet, and zero alerts are ever produced regardless of real whale activity (68/68 wallets
  // "scanned" successfully, 0 candidates ever generated). Confirmed against this codebase's own
  // working reference call (lib/server/walletSnapshot.ts's fetchGoldrushTransactionsPage), which
  // already sets this same param on the same endpoint for the same reason.
  url.searchParams.set('with-logs', 'true')
  return url.toString()
}

async function fetchWalletTransactionsFromProvider(address: string, apiKey: string, sinceMs: number): Promise<ProviderPayload> {
  const walletStartedAt = Date.now()
  const first = await fetchProviderPage(address, apiKey, null)
  const items: CovalentTx[] = [...(first.data?.items ?? [])]
  let prevLink = first.data?.links?.prev ?? null
  for (let page = 1; page < MAX_PROVIDER_PAGES; page += 1) {
    if (!prevLink || items.length === 0) break
    if (Date.now() - walletStartedAt >= WALLET_PAGE_BUDGET_MS) break
    let oldest = Number.POSITIVE_INFINITY
    for (const tx of items) {
      const t = tx.block_signed_at ? new Date(tx.block_signed_at).getTime() : Number.NaN
      if (Number.isFinite(t) && t < oldest) oldest = t
    }
    if (oldest < sinceMs) break
    try {
      const next = await fetchProviderPage(address, apiKey, prevLink)
      const nextItems = next.data?.items ?? []
      if (nextItems.length === 0) break
      items.push(...nextItems)
      prevLink = next.data?.links?.prev ?? null
    } catch {
      // A failed older page never fails the wallet; keep what the newer pages returned.
      break
    }
  }
  return { data: { items } }
}

async function fetchProviderPage(address: string, apiKey: string, pageUrl: string | null): Promise<ProviderPayload> {
  let lastError: ProviderRequestError = new ProviderRequestError(null, 'network_error', [])

  // HOST FALLBACK FIX, DISCLOSED (whale-alerts "no alerts loading" diagnosis): see COVALENT_HOSTS's
  // own comment. Only retries the NEXT host on a real failure (network error, non-2xx, bad JSON) —
  // a successful response short-circuits immediately, so this never doubles latency/cost for the
  // common case where the first host works.
  for (const host of COVALENT_HOSTS) {
    const url = buildProviderUrl(host, address, pageUrl)
    let response: Response | null = null
    // RATE-LIMIT RETRY: a 429 gets ONE retry on the same host after a short backoff (Retry-After
    // when given, capped; else jittered), then falls through to the next host. Bounded so a single
    // wallet can never stall the batch past its time budget.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // SHARED GOLDRUSH PACING: one process-wide gate for this key (src/lib/providerGates.ts). Live: a
        // burst of 10 wallets at once returned 10 × 429 + 10 timeouts; the same 20 requests paced did not.
        await goldrushPricingGate.wait()
        logRpcCall({ route: '/api/whale-alerts/sync', chain: PROVIDER_CHAIN, method: 'goldrush_transactions_v3' })
        response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(PER_WALLET_TIMEOUT_MS),
        })
      } catch {
        response = null
        break
      }
      if (response.status !== 429 || attempt === 1) break
      const retryAfterSec = Number(response.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(RATE_LIMIT_MAX_BACKOFF_MS, retryAfterSec * 1000)
        : RATE_LIMIT_BASE_BACKOFF_MS + Math.floor(Math.random() * RATE_LIMIT_BASE_BACKOFF_MS)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
    if (!response) {
      lastError = new ProviderRequestError(null, 'network_error', [])
      continue
    }

    if (!response.ok) {
      let responseKeys: string[] = []
      try {
        const payload = (await response.json()) as Record<string, unknown>
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          responseKeys = Object.keys(payload).slice(0, 8)
        }
      } catch {
        responseKeys = []
      }
      lastError = new ProviderRequestError(response.status, classifyProviderError(response.status), responseKeys)
      // ADAPTIVE THROTTLE (whale sync performance task): a provider rate-limit means the current
      // concurrency is too hot — step it down for the remainder of this instance's lifetime so
      // subsequent batches back off instead of failing whole wallets. Concurrency recovers by one
      // step per successful batch (see Phase 1). Never fails the sync.
      if (response.status === 429) {
        adaptiveConcurrency = Math.max(2, adaptiveConcurrency - 2)
      }
      // Auth/allowlist failures are the same on every host (same key) — no point retrying those.
      // The second host shares the same key and quota: a 429 there is the same 429, twice the calls.
      if (response.status === 401 || response.status === 403 || response.status === 429) break
      continue
    }

    try {
      return (await response.json()) as ProviderPayload
    } catch {
      lastError = new ProviderRequestError(null, 'invalid_provider_json', [])
      continue
    }
  }

  throw lastError
}

// Parse ERC-20 Transfer events from Covalent log_events.
// Aggregates multiple Transfer hops for the same (token, direction) within one tx —
// a multi-hop DEX route produces one representative row per token per side.
// Only creates alerts for transfers where the tracked wallet is the from or to address.
function extractAlerts(wallet: TrackedWallet, txs: CovalentTx[], windowMs: number, selectedWindow: SyncWindow) {
  const since = Date.now() - windowMs
  const alerts: Array<Record<string, unknown>> = []
  const skipSummary = makeSkipSummary()
  let parsedMovementCount = 0

  for (const tx of txs) {
    const occurredAt = tx.block_signed_at ? new Date(tx.block_signed_at).getTime() : Number.NaN
    if (!Number.isFinite(occurredAt) || occurredAt < since) {
      skipSummary.olderThanWindow += 1
      if (selectedWindow === '24h') skipSummary.olderThan24h += 1
      continue
    }

    if (tx.successful === false || !tx.tx_hash) {
      skipSummary.unclassified += 1
      continue
    }

    const walletLower = wallet.address.toLowerCase()
    const occurredAtIso = new Date(occurredAt).toISOString()

    // Collect transfers by (token_address, side) so multi-hop routes don't
    // produce duplicate rows for the same token in the same direction.
    const movements = new Map<string, {
      tokenAddress: string
      tokenSymbol: string | null
      /** null when the token's decimals are unknown: the movement is real, its size is not known. */
      amountToken: number | null
      side: 'buy' | 'sell'
      counterparties: Set<string>
    }>()

    for (const event of tx.log_events ?? []) {
      if (event.decoded?.name !== 'Transfer') continue
      const params = event.decoded.params ?? []
      const fromParam = params.find(p => p.name === 'from')?.value?.toLowerCase()
      const toParam   = params.find(p => p.name === 'to')?.value?.toLowerCase()
      const valueParam = params.find(p => p.name === 'value')?.value

      if (!fromParam || !toParam || !valueParam) continue

      const isReceive = toParam === walletLower
      const isSend    = fromParam === walletLower
      if (!isReceive && !isSend) continue

      const tokenAddress = event.sender_address?.toLowerCase()
      if (!tokenAddress) continue

      // DECIMALS: canonical first (corrects a provider that is wrong about e.g. USDC), then the
      // provider's own value. Unknown is stored as an unknown amount, never scaled by a guessed 18.
      const decimalsResolution = resolveTokenDecimals({ chain: 'base', token: event.sender_address ?? null, providerDecimals: event.sender_contract_decimals ?? null })
      const decimals   = decimalsResolution.source === 'fallback_18' ? null : decimalsResolution.decimals
      const rawAmount  = Number(valueParam)
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue
      const amountToken = decimals == null ? null : rawAmount / Math.pow(10, decimals)
      if (amountToken != null && (!Number.isFinite(amountToken) || amountToken <= 0)) continue

      const side: 'buy' | 'sell' = isReceive ? 'buy' : 'sell'
      const counterparty = isReceive ? fromParam : toParam
      const key = `${tokenAddress}::${side}`
      const existing = movements.get(key)
      if (existing) {
        existing.amountToken = existing.amountToken == null || amountToken == null ? null : existing.amountToken + amountToken
        existing.counterparties.add(counterparty)
      } else {
        movements.set(key, {
          tokenAddress,
          tokenSymbol: event.sender_contract_ticker_symbol ?? null,
          amountToken,
          side,
          counterparties: new Set([counterparty]),
        })
      }
    }

    // NATIVE ETH: tx.value moved by/to the tracked wallet. Skipped when a WETH Transfer for the same
    // side is already in this tx's logs, so a wrap/unwrap or WETH-routed swap is not double-counted.
    const nativeWei = Number(tx.value ?? 0)
    if (Number.isFinite(nativeWei) && nativeWei > 0) {
      const fromLower = (tx.from_address ?? '').toLowerCase()
      const toLower = (tx.to_address ?? '').toLowerCase()
      const nativeSide: 'buy' | 'sell' | null = fromLower === walletLower ? 'sell' : toLower === walletLower ? 'buy' : null
      const amountEth = nativeWei / 1e18
      const hasWethSameSide = nativeSide !== null && (
        movements.has(`${BASE_WETH_ADDRESS}::${nativeSide}`) ||
        [...movements.values()].some(m => m.side === nativeSide && (m.tokenSymbol ?? '').toUpperCase() === 'WETH')
      )
      if (nativeSide && !hasWethSameSide && Number.isFinite(amountEth) && amountEth > 0) {
        movements.set(`${NATIVE_ETH_SENTINEL}::${nativeSide}`, {
          tokenAddress: NATIVE_ETH_SENTINEL,
          tokenSymbol: 'ETH',
          amountToken: amountEth,
          side: nativeSide,
          counterparties: new Set([nativeSide === 'sell' ? toLower : fromLower]),
        })
      }
    }

    // MINT/BURN NOISE: a leg whose only counterparty is the zero/burn address is a mint or burn,
    // not a trade with anyone. Dropped when the tx proves it is not a trade: it is the only
    // movement (bridge mint/burn, airdrop mint), an LP-token mint while two+ tokens went out (add
    // liquidity), or an LP-token burn while two+ tokens came in (remove liquidity). A mint paired
    // with a single payment (bonding-curve style buy) is kept.
    const legs = [...movements.entries()]
    const outCount = legs.filter(([, m]) => m.side === 'sell').length
    const inCount = legs.filter(([, m]) => m.side === 'buy').length
    for (const [key, m] of legs) {
      const isMintBurn = [...m.counterparties].every(c => MINT_BURN_ADDRESSES.has(c))
      if (!isMintBurn) continue
      const lone = legs.length === 1
      const lpAdd = m.side === 'buy' && outCount >= 2
      const lpRemove = m.side === 'sell' && inCount >= 2
      if (lone || lpAdd || lpRemove) {
        movements.delete(key)
        skipSummary.mintBurnNoise += 1
      }
    }

    if (movements.size === 0) {
      skipSummary.noTokenMovements += 1
      continue
    }

    parsedMovementCount += 1
    for (const mv of movements.values()) {
      const dirVerb = mv.side === 'buy' ? 'received' : 'sent'
      alerts.push({
        wallet_address: wallet.address,
        wallet_label: wallet.label,
        token_address: mv.tokenAddress,
        token_symbol: mv.tokenSymbol,
        token_name: null,
        alert_type: 'token_transfer',
        side: mv.side,
        amount_usd: null,
        amount_token: mv.amountToken,
        tx_hash: tx.tx_hash,
        chain: 'base',
        severity: null,
        summary: `${wallet.label ?? 'Tracked wallet'} ${dirVerb} ${mv.amountToken == null ? 'an unknown amount of' : mv.amountToken.toFixed(4)} ${mv.tokenSymbol ?? 'tokens'}`,
        occurred_at: occurredAtIso,
      })
    }
  }

  return { alerts, skipSummary, parsedMovementCount }
}

type SyncActor =
  | { kind: 'user'; userId: string; plan: 'free' | 'pro' | 'elite' }
  | { kind: 'system' }

export async function POST(request: Request) {
  const authenticatedUser = await requireAuthenticatedUser(request)
  if (!authenticatedUser) return unauthorizedResponse()
  return runWhaleSync(request, { kind: 'user', userId: authenticatedUser.userId, plan: authenticatedUser.plan })
}

// Vercel Cron entry point (see vercel.json). Vercel sends `Authorization: Bearer ${CRON_SECRET}`.
// Scans only the shared system wallet set (tracked_wallets.user_id IS NULL) on Base and writes
// system-owned alerts (owner_user_id NULL). Loops batches until done or the time budget runs out.
// Only START another batch inside this budget: one batch is bounded (~20s safety + one wallet's
// page budget + a page), so the whole invocation stays under the 60s maxDuration.
const CRON_TIME_BUDGET_MS = 10_000
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const startedAt = Date.now()
  const baseUrl = new URL(request.url)
  const runCron = (offset: number, limit: number) => {
    const url = new URL(baseUrl.toString())
    // Batch mode: stalest wallets first when last_scanned_at exists (offset only counts progress);
    // otherwise the same offset slicing as before, driven by the daily rotation below.
    url.searchParams.set('mode', 'batch')
    url.searchParams.set('window', '7d')
    url.searchParams.set('minUsd', url.searchParams.get('minUsd') ?? '0')
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('limit', String(limit))
    return runWhaleSync(new Request(url.toString(), { method: 'GET', headers: request.headers }), { kind: 'system' })
  }
  // Rotate today's starting slice (see lib/server/whaleCronRotation.ts). The size probe is the
  // route's cheap "offset beyond the list" path: one wallet-list query, no provider calls.
  const probe = await runCron(Number.MAX_SAFE_INTEGER, MAX_LIMIT)
  const probeJson = (await probe.json().catch(() => null)) as Record<string, unknown> | null
  if (!probe.ok || !probeJson || probeJson.ok === false) {
    return NextResponse.json({ ok: false, source: 'cron', batches: 0, inserted: 0, last: probeJson }, { status: probe.ok ? 500 : probe.status })
  }
  const start = cronRotationStart(Date.now(), Number(probeJson.trackedWalletsTotal ?? 0))
  let offset = start
  let wrapped = false
  let batches = 0
  let inserted = 0
  let last: Record<string, unknown> | null = null
  let status = 200
  while (Date.now() - startedAt < CRON_TIME_BUDGET_MS) {
    const limit = wrapped ? Math.max(1, Math.min(MAX_LIMIT, start - offset)) : MAX_LIMIT
    const res = await runCron(offset, limit)
    status = res.status
    last = (await res.json().catch(() => null)) as Record<string, unknown> | null
    batches += 1
    if (!res.ok || !last || last.ok === false) break
    inserted += Number(last.inserted ?? 0)
    const next = cronNextOffset(start, last.done === true || !last.hasMore || last.nextOffset == null ? null : Number(last.nextOffset), wrapped)
    if (!next) break
    offset = next.offset
    wrapped = next.wrapped
  }
  console.log('[whale-alerts-cron]', { start, lastOffset: offset, wrapped, batches, inserted, status, durationMs: Date.now() - startedAt })
  const ok = status < 400 && !!last && last.ok !== false
  return NextResponse.json(
    { ok, source: 'cron', rotationStart: start, batches, inserted, lastOffset: offset, wrapped, last },
    { status: ok ? 200 : status },
  )
}

async function runWhaleSync(request: Request, actor: SyncActor) {
  const requestUrl = new URL(request.url)
  const mode = requestUrl.searchParams.get('mode') === 'full' ? 'full' : 'batch'
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  const providerKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY

  let body: Record<string, unknown> = {}
  try {
    if (request.headers.get('content-type')?.includes('application/json')) {
      body = (await request.json()) as Record<string, unknown>
    }
  } catch {
    body = {}
  }

  const debug = requestUrl.searchParams.get('debug') === 'true'
  const queryWindow = requestUrl.searchParams.get('window')
  const bodyWindow = typeof body.window === 'string' ? body.window : null
  const requestedWindow = queryWindow ?? bodyWindow
  const selectedWindow: SyncWindow = requestedWindow === '3d' || requestedWindow === '7d' ? requestedWindow : '24h'
  const windowMs = WINDOW_MS[selectedWindow]

  const queryLimit = parseInteger(requestUrl.searchParams.get('limit'))
  const bodyLimit = parseInteger(body.limit)
  const defaultLimitForMode = mode === 'full' ? MAX_LIMIT : DEFAULT_LIMIT
  const rawLimit = queryLimit ?? bodyLimit ?? defaultLimitForMode
  const limit = Math.max(1, Math.min(MAX_LIMIT, rawLimit))

  const queryMinUsdRaw = requestUrl.searchParams.get('minUsd')
  const bodyMinUsdRaw = body.minUsd
  const parsedQueryMinUsd = queryMinUsdRaw === null ? null : Number(queryMinUsdRaw)
  const parsedBodyMinUsd = typeof bodyMinUsdRaw === 'number' || typeof bodyMinUsdRaw === 'string' ? Number(bodyMinUsdRaw) : null
  const selectedMinUsd = Math.max(0, Number.isFinite(parsedQueryMinUsd as number) ? (parsedQueryMinUsd as number) : (Number.isFinite(parsedBodyMinUsd as number) ? (parsedBodyMinUsd as number) : 0))

  const queryOffset = parseInteger(requestUrl.searchParams.get('offset'))
  const bodyOffset = parseInteger(body.offset)
  const rawOffset = queryOffset ?? bodyOffset ?? DEFAULT_OFFSET
  const offset = Math.max(0, rawOffset)
  const isFullContinuation = mode === 'full' && offset > 0
  const isBatchContinuation = mode === 'batch' && offset > 0
  const isContinuation = isFullContinuation || isBatchContinuation
  const rawTarget = requestUrl.searchParams.get('wallet') ?? (typeof body.wallet === 'string' ? body.wallet : null)
  const targetWallet = rawTarget && /^0x[a-fA-F0-9]{40}$/.test(rawTarget.trim()) ? rawTarget.trim().toLowerCase() : null
  if (rawTarget && !targetWallet) return NextResponse.json({ ok: false, error: 'invalid_wallet' }, { status: 400 })
  if (targetWallet && actor.kind === 'user') {
    if (actor.plan === 'free') return NextResponse.json({ ok: false, mode, error: 'Included in Pro and Elite.' }, { status: 403 })
    const allowTarget = targetedSyncAllowed(actor.userId, targetWallet)
    if (!allowTarget.ok) return NextResponse.json({ ok: false, mode, error: 'This wallet was just synced. Try again shortly.', retryAfterMs: allowTarget.retryAfterMs ?? null }, { status: 429 })
  } else if (actor.kind === 'user') {
    const verifiedPlan = actor.plan
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[sync] route=/api/whale-alerts/sync verifiedPlan=${verifiedPlan}`)
    }
    if (verifiedPlan === 'free') return NextResponse.json({ ok: false, mode, error: 'Included in Pro and Elite.', planGate: { verifiedPlan, requiredPlan: 'pro' } }, { status: 403 })
    const allow = syncAllowed(verifiedPlan, request, mode, isContinuation)
    if (!allow.ok) return NextResponse.json({ ok: false, mode, error: allow.cooldown ? "Sync cooldown active. Try again later." : "Rate limit reached. Try again shortly.", retryAfterMs: allow.retryAfterMs ?? null }, { status: 429 })
  }
  const usingAutomaticBatch = queryOffset === null && bodyOffset === null
  void usingAutomaticBatch  // retained for compatibility — wallet fetch now uses explicit slicing

  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: 'missing_supabase_env' }, { status: 503 })
  }
  if (!providerKey) {
    return NextResponse.json({ ok: false, error: 'missing_provider_key' }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRole)
  // Fetch all active wallets up-front so trackedWalletsTotal is exact and
  // progress math never depends on Supabase's count field (which can be null).
  // last_scanned_at (docs/migrations/20261015_tracked_wallets_last_scanned.sql) drives stalest-first
  // batches. If the column is not there yet, the same query runs without it (offset slicing).
  const loadWallets = (columns: string) => {
    const walletQuery = supabase
      .from('tracked_wallets')
      .select(columns)
      .eq('chain_id', BASE_WHALE_CHAIN_ID)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
    return actor.kind === 'user'
      ? walletQuery.or(userOrSystemScope('user_id', actor.userId))
      : walletQuery.is('user_id', null)
  }
  let lastScannedAvailable = true
  let scopedWalletResult = await loadWallets('address,user_id,label,category,confidence,source,is_active,last_scanned_at')
  if (isMissingOwnershipColumn(scopedWalletResult.error, ['last_scanned_at'])) {
    lastScannedAvailable = false
    scopedWalletResult = await loadWallets('address,user_id,label,category,confidence,source,is_active')
  }
  let walletError = scopedWalletResult.error
  let allWalletRows = (scopedWalletResult.data ?? []) as unknown as TrackedWallet[]

  if (isMissingOwnershipColumn(walletError, ['user_id', 'chain_id'])) {
    // Pre-migration compatibility. A schema without user_id cannot contain private FOMO rows, so
    // the legacy table is necessarily the shared system set and is safe to scan for this user.
    const legacy = await supabase
      .from('tracked_wallets')
      .select('address,label,category,confidence,source,is_active')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
    allWalletRows = (legacy.data ?? []) as unknown as TrackedWallet[]
    walletError = legacy.error
    console.warn('[whale-alerts-sync] ownership columns unavailable; used legacy system-wallet set')
  }

  if (walletError) {
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  // The user's private list may contain a wallet already present in the system set. Scan it once.
  // A targeted sync only ever scans a wallet already in the caller's own scoped set (their private
  // FOMO wallets + the shared system set) — never an arbitrary address.
  const allWallets = dedupeTrackedWallets(allWalletRows)
    .filter(w => !targetWallet || w.address.trim().toLowerCase() === targetWallet)
  if (targetWallet && allWallets.length === 0) {
    return NextResponse.json({ ok: false, error: 'wallet_not_tracked', wallet: targetWallet }, { status: 404 })
  }
  const trackedWalletsTotal = allWallets.length

  if (trackedWalletsTotal === 0) {
    return NextResponse.json({ ok: false, error: 'no_active_wallets', trackedWalletsTotal: 0, done: true }, { status: 404 })
  }

  if (offset >= trackedWalletsTotal) {
    return NextResponse.json({
      ok: true, mode, trackedWalletsTotal, offset, requestedLimit: limit,
      walletsChecked: 0, processed: 0, processedTotal: offset,
      inserted: 0, skipped: 0, nextOffset: null, hasMore: false, done: true,
      noFreshSignal: true, refreshStatus: 'complete',
      message: 'All wallets have already been checked.',
    })
  }

  // Batch mode (the "Sync wallets"/"Continue refresh" button and the cron) takes the stalest wallets;
  // offset then only counts progress. Full mode keeps stable created_at order + offsets.
  const stalestFirst = lastScannedAvailable && mode === 'batch' && !targetWallet
  const orderedBatch = selectWalletBatch(allWallets, { offset, limit, stalestFirst })
  // ONLY STALE WALLETS: in a stalest-first batch, a wallet scanned within the last 10 minutes is already
  // covered — skipped with no provider call — and every wallet after it is fresher, so the round ends.
  const freshSplit = stalestFirst ? splitFreshWallets(orderedBatch, Date.now()) : { stale: orderedBatch, fresh: [] as TrackedWallet[], reachedFresh: false }
  const selectedBatch = freshSplit.stale

  // Routers, bridges and other contracts are not whales: skip them (lookup failure = scan anyway).
  const walletKinds = await classifyWallets(selectedBatch.map(w => w.address))
  const skippedNonWallets = selectedBatch.filter(w => {
    const kind = walletKinds.get(w.address.toLowerCase())
    return kind === 'contract' || kind === 'infra'
  })
  const walletBatch = selectedBatch.filter(w => !skippedNonWallets.includes(w))

  // INCREMENTAL: one cheap Alchemy activity check per wallet since its cursor (window start, or last
  // successful scan − 10 min for the standard 24h sync). Quiet wallets are covered without a GoldRush
  // call; errors / unknown answers are fetched as before (whaleActivityCheck.ts).
  const windowStartMs = Date.now() - windowMs
  const activity = await checkWalletActivity(
    walletBatch.map(w => ({
      address: w.address,
      sinceMs: activityCursorMs({ windowStartMs, lastScannedAt: w.last_scanned_at, useLastScan: mode !== 'full' && selectedWindow === '24h' && !targetWallet }),
    })),
    { rpcUrl: whaleAlchemyBaseRpcUrl() },
  )
  const quietWallets = walletBatch.filter(w => activity.inactive.has(w.address.toLowerCase()))
  const fetchBatch = walletBatch.filter(w => !activity.inactive.has(w.address.toLowerCase()))
  const stageMs = { activityCheck: activity.ms, providerFetch: 0, classify: 0, pricing: 0, db: 0 }

  const startedAt = Date.now()
  let processed = 0
  let earlyStopped = false
  let inserted = 0
  let skipped = 0
  let providerErrors = 0
  let fetchedTxCount = 0
  let parsedMovementCount = 0
  let alertCandidateCount = 0
  let newestAlertAtTs = 0
  const insertedSymbols = new Set<string>()
  const providerErrorSamples: ProviderErrorSample[] = []
  const syncDebug: SyncProviderDebug = {
    walletsProcessed: 0,
    providerCallsAttempted: 0,
    providerCallsSavedByCache: 0,
    providerCallsSavedByDedupe: 0,
    cacheHits: 0,
    cacheMisses: 0,
    errorCount: 0,
    providerErrorSamples,
  }
  const skipSummary = makeSkipSummary()
  const skipSamples: SkipSample[] = []
  const finalPipelineSummary = makeFinalPipelineSummary()
  const dbInsertErrorSamples: Array<Record<string, string | null>> = []
  // Alerts from a user's private (FOMO) wallet — never written without their owner column.
  const privateAlerts = new WeakSet<object>()
  let dbWritePath: WhaleAlertWritePath | null = null
  let dbWritePrivateDropped = 0

  // ── Phase 1: Parallel fetch — CONCURRENCY wallets at a time ─────────────────
  type FetchResult =
    | { wallet: TrackedWallet; txItems: CovalentTx[]; ok: true }
    | { wallet: TrackedWallet; error: unknown; ok: false }

  const fetchResults: FetchResult[] = []
  const batchChunks: TrackedWallet[][] = []
  // ADAPTIVE CONCURRENCY (whale sync performance task): chunk size follows the adaptive cap —
  // reduced on provider 429s (see fetch error handling), recovering one step per clean batch.
  const effectiveConcurrency = Math.max(2, Math.min(CONCURRENCY, adaptiveConcurrency))
  for (let i = 0; i < fetchBatch.length; i += effectiveConcurrency) {
    batchChunks.push(fetchBatch.slice(i, i + effectiveConcurrency))
  }
  const providerFetchStartedAt = Date.now()

  for (const chunk of batchChunks) {
    if (Date.now() - startedAt >= SAFETY_TIMEOUT_MS) { earlyStopped = true; break }

    const settled = await Promise.allSettled(
      chunk.map(wallet =>
        fetchWalletTransactions(wallet.address, providerKey, syncDebug, windowMs)
          .then(result => result.ok
            ? {
                wallet,
                txItems: (result.payload.data?.items ?? []) as CovalentTx[],
                ok: true as const,
              }
            : { wallet, error: result.error, ok: false as const }
          )
      )
    )
    // Clean batch with zero errors → let concurrency creep back up one step (bounded).
    if (!settled.some(s => s.status === 'fulfilled' && s.value.ok === false)) {
      adaptiveConcurrency = Math.min(CONCURRENCY, adaptiveConcurrency + 1)
    }

    for (const r of settled) {
      // Inner promise always resolves (error caught inside map); fulfilled === always
      fetchResults.push(r.status === 'fulfilled' ? r.value : { wallet: chunk[0], error: r.reason, ok: false })
    }
  }

  stageMs.providerFetch = Date.now() - providerFetchStartedAt
  const classifyStartedAt = Date.now()
  // ── Phase 2: Process results, collect filtered alerts ────────────────────────
  const allFilteredAlerts: Array<Record<string, unknown>> = []
  // INCREMENTAL SYNC + PERFORMANCE AUDIT counters (whale sync performance task)
  let walletsSkippedByCheckpoint = 0
  let walletsWithNewActivity = 0
  const syncStartedAtMs = startedAt
  let timeToFirstAlertMs: number | null = null

  for (const result of fetchResults) {
    processed += 1
    const walletShort = shortAddress(result.wallet.address)

    if (!result.ok) {
      const err = (result as { wallet: TrackedWallet; error: unknown; ok: false }).error
      providerErrors += 1
      syncDebug.errorCount += 1
      const statusCode = err instanceof ProviderRequestError ? err.statusCode : null
      const reason     = err instanceof ProviderRequestError ? err.message : 'provider_fetch_failed'
      const responseKeys = err instanceof ProviderRequestError ? err.responseKeys : []
      pushProviderErrorSample(providerErrorSamples, {
        wallet: walletShort,
        provider: 'goldrush',
        endpointPath: PROVIDER_ENDPOINT_PATH,
        statusCode,
        reason,
        responseKeys,
      })
      continue
    }

    const { txItems } = result as { wallet: TrackedWallet; txItems: CovalentTx[]; ok: true }
    fetchedTxCount += txItems.length

    // INCREMENTAL SYNC (whale sync performance task): on a repeat sync (not mode=full), skip
    // classification for transactions at or before this wallet's last-seen activity checkpoint.
    // The provider page is still fetched in full (fixed window) — only the expensive
    // parse/classify stage is skipped. Checkpoint is bypassed entirely when absent or stale
    // (older than the scan window), so coverage is never reduced and no alert can be missed.
    let effectiveTxItems = txItems
    const ck = checkpointKey(result.wallet.address, windowMs)
    const checkpointMs = mode === 'full' ? null : (walletLastSeenActivityMs.get(ck) ?? null)
    const checkpointValid =
      checkpointMs != null &&
      Number.isFinite(checkpointMs) &&
      checkpointMs > Date.now() - windowMs
    if (checkpointValid && checkpointMs != null) {
      const cp = checkpointMs
      const fresh = txItems.filter(tx => {
        const t = tx.block_signed_at ? new Date(tx.block_signed_at).getTime() : Number.NaN
        return Number.isFinite(t) && t > cp
      })
      if (fresh.length === 0) {
        walletsSkippedByCheckpoint += 1
        skipSummary.olderThanWindow += txItems.length
        if (selectedWindow === '24h') skipSummary.olderThan24h += txItems.length
        continue
      }
      if (fresh.length < txItems.length) {
        // Partial skip: wallet still processed, older txs just bypass classification.
        effectiveTxItems = fresh
        skipSummary.olderThanWindow += txItems.length - fresh.length
      }
      walletsWithNewActivity += 1
    } else {
      walletsWithNewActivity += 1
    }

    const extracted = extractAlerts(result.wallet, effectiveTxItems, windowMs, selectedWindow)
    parsedMovementCount += extracted.parsedMovementCount
    alertCandidateCount += extracted.alerts.length

    for (const [reason, value] of Object.entries(extracted.skipSummary) as Array<[SkipReason, number]>) {
      skipSummary[reason] += value
    }

    finalPipelineSummary.candidatesSeen += extracted.alerts.length

    for (const alert of extracted.alerts) {
      const usd = parseNumeric(alert.amount_usd)
      const walletAddress = (alert.wallet_address as string | null) ?? null
      const alertType     = (alert.alert_type as string | null) ?? null
      const occurredAt    = (alert.occurred_at as string | null) ?? null
      const tokenAddress  = (alert.token_address as string | null) ?? null

      if (!walletAddress || !alertType || !occurredAt || !tokenAddress) {
        finalPipelineSummary.missingRequiredField += 1
        skipSummary.missingTokenAddress += 1
        pushSkipSample(skipSamples, {
          wallet: walletShort,
          txHash: shortHash((alert.tx_hash as string | null) ?? null),
          reason: 'missingTokenAddress',
          tokenSymbol: (alert.token_symbol as string | null) ?? null,
          tokenAddressShort: shortHash(tokenAddress),
          amountUsd: usd,
          alertType,
          side: (alert.side as string | null) ?? null,
          occurredAt,
        })
        continue
      }

      if (usd === null) {
        skipSummary.missingUsdValue += 1
      } else if (usd < selectedMinUsd) {
        finalPipelineSummary.belowThresholdSkipped += 1
        skipSummary.belowThreshold += 1
        pushSkipSample(skipSamples, {
          wallet: walletShort,
          txHash: shortHash((alert.tx_hash as string | null) ?? null),
          reason: 'belowThreshold',
          tokenSymbol: (alert.token_symbol as string | null) ?? null,
          tokenAddressShort: shortHash((alert.token_address as string | null) ?? null),
          amountUsd: usd,
          alertType,
          side: (alert.side as string | null) ?? null,
          occurredAt,
        })
        continue
      }

      const severity = severityFromUsd(usd) ?? (selectedMinUsd < 1000 && usd !== null && usd >= selectedMinUsd ? 'watch' : null)
      // Owner follows the wallet, not the caller: a system wallet's movement is one shared row
      // whoever synced it (previously each user stored a private copy, which the feed then merged
      // with the cron/webhook row into a fake two-leg swap). Private FOMO wallets stay private.
      const row = { ...alert, amount_usd: usd, severity, owner_user_id: alertOwnerForWallet(result.wallet) }
      if (result.wallet.user_id) privateAlerts.add(row)
      allFilteredAlerts.push(row)
      if (timeToFirstAlertMs == null) timeToFirstAlertMs = Date.now() - syncStartedAtMs
    }
  }

  // INCREMENTAL SYNC: advance each successfully-processed wallet's checkpoint to the newest tx
  // timestamp seen in its provider page — but only after classification succeeded, and only for
  // wallets that produced no filtered alerts this round (a wallet WITH alerts keeps its old
  // checkpoint so a near-term repeat sync can still re-confirm the same recent activity).
  if (earlyStopped === false) {
    for (const result of fetchResults) {
      if (!result.ok) continue
      const { wallet, txItems } = result as { wallet: TrackedWallet; txItems: CovalentTx[]; ok: true }
      const hasAlertsThisRound = allFilteredAlerts.some(a => String(a.wallet_address ?? '').toLowerCase() === wallet.address.toLowerCase())
      if (hasAlertsThisRound) continue
      let newest = 0
      for (const tx of txItems) {
        const t = tx.block_signed_at ? new Date(tx.block_signed_at).getTime() : Number.NaN
        if (Number.isFinite(t) && t > newest) newest = t
      }
      if (newest > 0) {
        const ck2 = checkpointKey(wallet.address, windowMs)
        const prev = walletLastSeenActivityMs.get(ck2) ?? 0
        if (newest > prev) walletLastSeenActivityMs.set(ck2, newest)
      }
    }
  }

  // ── Phase 3: Single bulk upsert for all alerts from this batch ───────────────
  // Price at ingestion (stablecoins exactly, fresh trades at the market price) so the feed reads a
  // stored value instead of re-pricing every alert on every load. Existing rows are never overwritten.
  stageMs.classify = Date.now() - classifyStartedAt
  let syncPricing: SyncPricingResult = { stablecoin: 0, market: 0, tooOld: 0, unpriced: 0 }
  const pricingStartedAt = Date.now()
  if (allFilteredAlerts.length > 0) {
    syncPricing = await priceAlertsAtIngestion(allFilteredAlerts, Date.now(), (addresses) => fetchBaseDexScreenerPrices(addresses))
    for (const alert of allFilteredAlerts) {
      if (alert.severity == null && typeof alert.amount_usd === 'number') alert.severity = severityFromUsd(alert.amount_usd)
    }
    for (const alert of allFilteredAlerts) {
      const sym = ((alert.token_symbol as string | null) ?? '').toUpperCase().trim()
      if (sym) insertedSymbols.add(sym)
      const ts = alert.occurred_at ? new Date(String(alert.occurred_at)).getTime() : 0
      if (Number.isFinite(ts) && ts > newestAlertAtTs) newestAlertAtTs = ts
    }

    finalPipelineSummary.attemptedInsert += allFilteredAlerts.length
    stageMs.pricing = Date.now() - pricingStartedAt
    const dbStartedAt = Date.now()
    const write = await persistWhaleAlerts(supabase as unknown as WhaleAlertsDb, allFilteredAlerts, {
      isPrivate: row => privateAlerts.has(row),
    })
    inserted = write.inserted
    skipped = write.skipped
    stageMs.db = Date.now() - dbStartedAt
    dbWritePath = write.path
    dbWritePrivateDropped = write.privateDropped
    for (const recovered of write.recovered) {
      console.warn('[whale-alerts-sync] whale_alerts write degraded', write.path, recovered.code, recovered.message)
    }
    if (write.error) {
      const error = write.error
      console.error('[whale-alerts-sync] whale_alerts insert failed', error.code, error.message)
      finalPipelineSummary.dbInsertFailed += allFilteredAlerts.length
      skipped = allFilteredAlerts.length
      if (dbInsertErrorSamples.length < 3) {
        dbInsertErrorSamples.push({
          code: error.code ?? null,
          message: error.message ?? null,
          hint: error.hint ?? null,
          details: error.details ?? null,
        })
      }
    }

    finalPipelineSummary.inserted         = inserted
    finalPipelineSummary.duplicateSkipped = skipped
    skipSummary.duplicate = skipped
    skipSummary.dbSkipped = skipped
  }

  // LAST SCANNED: stamp every wallet this batch actually covered — fetched OK, or skipped as a
  // contract/infra address — so the next batch moves on to staler wallets. Provider failures and a
  // failed alert write are NOT stamped: those wallets stay stalest and are retried first.
  let lastScannedUpdated = 0
  let lastScannedError: string | null = null
  if (lastScannedAvailable) {
    const coveredAddresses = finalPipelineSummary.dbInsertFailed > 0
      ? skippedNonWallets.map(w => w.address)
      : [
          ...fetchResults.filter(r => r.ok).map(r => r.wallet.address),
          ...quietWallets.map(w => w.address),
          ...skippedNonWallets.map(w => w.address),
        ]
    if (coveredAddresses.length > 0) {
      const stamp = await supabase
        .from('tracked_wallets')
        .update({ last_scanned_at: new Date().toISOString() })
        .in('address', [...new Set(coveredAddresses)])
        .eq('chain_id', BASE_WHALE_CHAIN_ID)
        .select('address')
      if (stamp.error) {
        lastScannedError = stamp.error.code ?? 'update_failed'
        console.error('[whale-alerts-sync] last_scanned_at update failed', stamp.error.code, stamp.error.message)
      } else {
        lastScannedUpdated = stamp.data?.length ?? 0
      }
    }
  }

  // walletsChecked = wallets this batch covered: attempted fetches (fewer than the batch only when
  // the safety timeout fired) plus contract/infra addresses skipped without a provider call.
  // Quiet wallets were checked (Alchemy: no transfer since their cursor), so they count as covered.
  const walletsChecked = processed + quietWallets.length + skippedNonWallets.length + freshSplit.fresh.length
  syncDebug.walletsProcessed = walletsChecked
  const processedTotal = offset + walletsChecked
  // Reaching an already-fresh wallet means the rest of the stalest-first order is fresh too.
  const done = processedTotal >= trackedWalletsTotal || (freshSplit.reachedFresh && !earlyStopped)
  const nextOffset = done ? null : processedTotal
  const hasMore = !done
  const noFreshSignal = inserted === 0
  const refreshStatus =
    walletsChecked === 0
      ? 'empty'
      : mode === 'full' && hasMore
        ? 'full_in_progress'
        : hasMore
          ? 'partial_complete'
          : mode === 'full'
            ? 'full_complete'
            : 'complete'
  const walletsList = walletBatch
  const response: Record<string, unknown> = {
    ok: true,
    mode,
    trackedWalletsTotal,
    offset,
    requestedLimit: limit,
    walletsChecked,
    processed: walletsChecked,
    // Covered without a provider call: scanned within the last 10 minutes.
    walletsSkippedFresh: freshSplit.fresh.length,
    // Covered by the activity check alone: no transfer since the cursor, no GoldRush call made.
    walletsQuiet: quietWallets.length,
    // Targeted (FOMO + Add) sync: what happened to that one wallet, so the board shows a real status.
    ...(targetWallet ? {
      target: {
        wallet: targetWallet,
        status: fetchResults.some(r => !r.ok) ? 'failed'
          : finalPipelineSummary.dbInsertFailed > 0 ? 'failed'
          : quietWallets.length > 0 ? 'no_new_activity'
          : skippedNonWallets.length > 0 ? 'skipped_contract'
          : earlyStopped && fetchResults.length === 0 ? 'pending'
          : 'synced',
        alertsStored: inserted,
      },
    } : {}),
    walletsFetched: fetchResults.length,
    activityCheckCalls: activity.calls,
    activityUnknown: activity.unknown.size,
    stageMs,
    pricedAtSync: syncPricing,
    processedTotal,
    inserted,
    skipped,
    nextOffset,
    hasMore,
    done,
    earlyStopped,
    earlyStopReason: earlyStopped ? 'safety_timeout' : null,
    noFreshSignal,
    insertedCount: inserted,
    refreshStatus,
    providerErrors,
    skipReasons: skipSummary,
    // Always-on pipeline diagnostics (codes/counts only; no keys, hints or row data).
    fetchedTxCount,
    alertCandidateCount,
    dbInsertFailed: finalPipelineSummary.dbInsertFailed,
    dbInsertErrorSamples: dbInsertErrorSamples.slice(0, 3).map(e => ({ code: e.code ?? null, message: e.message ?? null })),
    providerErrorSamples: providerErrorSamples.slice(0, 5).map(e => ({ statusCode: e.statusCode ?? null, reason: e.reason })),
    // Wallet rotation: 'stalest_first' when tracked_wallets.last_scanned_at exists, else 'offset'.
    walletOrdering: stalestFirst ? 'stalest_first' : 'offset',
    lastScannedAvailable,
    lastScannedUpdated,
    lastScannedError,
    skippedNonWallets: skippedNonWallets.map(w => ({ wallet: shortAddress(w.address), kind: walletKinds.get(w.address.toLowerCase()) ?? null })),
    // Which write path persisted this batch. 'legacy_no_owner' means whale_alerts has no
    // owner_user_id column: docs/migrations/20260904_fomo_user_scoped_tracked_wallets.sql is unapplied.
    dbWritePath,
    dbWritePrivateDropped,
    message: walletsChecked === 0
      ? 'No active wallets were scanned in this batch.'
      : finalPipelineSummary.dbInsertFailed > 0
        ? `Found ${finalPipelineSummary.dbInsertFailed} qualifying alert${finalPipelineSummary.dbInsertFailed === 1 ? '' : 's'} but saving failed (${dbInsertErrorSamples[0]?.code ?? 'db error'}).`
      : inserted > 0
        ? `Checked ${walletsChecked} wallet${walletsChecked === 1 ? '' : 's'}. Found ${inserted} qualifying alert${inserted === 1 ? '' : 's'}.`
        : done
          ? 'No fresh signal in the checked window.'
          : `Checked ${walletsChecked} of ${trackedWalletsTotal} wallets. No fresh signal yet — continue to scan more.`,
  }
  const newestAlertAt = newestAlertAtTs > 0 ? new Date(newestAlertAtTs).toISOString() : null
  const tokenSymbolsInserted = [...insertedSymbols].slice(0, 10)
  response.newestAlertAt = newestAlertAt
  response.tokenSymbolsInserted = tokenSymbolsInserted

  // WHALE SYNC PERFORMANCE AUDIT (whale sync performance task): always-on, read-only receipt of
  // where sync time went and what the incremental layer did. Changes no behavior; enables
  // before/after comparison of alerts count/IDs/dedupe keys vs duration/provider calls.
  const totalDurationMs = Date.now() - startedAt
  const cacheTotal = syncDebug.cacheHits + syncDebug.cacheMisses
  response.whaleSyncPerformanceAudit = {
    syncId: `sync_${startedAt}_${trackedWalletsTotal}`,
    trackedWalletCount: trackedWalletsTotal,
    chainsScanned: [PROVIDER_CHAIN],
    totalDurationMs,
    timeToFirstAlertMs,
    walletsProcessed: walletsChecked,
    walletsSkippedByCache: syncDebug.providerCallsSavedByCache + syncDebug.providerCallsSavedByDedupe,
    walletsSkippedByCheckpoint,
    walletsWithNewActivity,
    walletsWithAlerts: inserted > 0 ? allFilteredAlerts.length : 0,
    providerCallsTotal: syncDebug.providerCallsAttempted,
    providerCallsByProvider: { goldrush: syncDebug.providerCallsAttempted },
    providerCallsByChain: { [PROVIDER_CHAIN]: syncDebug.providerCallsAttempted },
    providerCallsSavedBySingleflight: syncDebug.providerCallsSavedByDedupe,
    providerLatencyMsByProvider: { goldrush: null }, // per-call latency not tracked without added overhead
    tokenEnrichmentMs: null, // enrichment happens in the feed route, not during sync
    priceLookupMs: null,     // USD values come embedded from provider log data
    alertClassificationMs: null, // folded into totalDurationMs — classification is CPU-bound and sub-millisecond per tx
    dbReadMs: null,
    dbWriteBatches: allFilteredAlerts.length > 0 ? 1 : 0,
    duplicateAlertsRemoved: skipped,
    cacheHitRate: cacheTotal > 0 ? Math.round((syncDebug.cacheHits / cacheTotal) * 100) : 0,
    rateLimitEvents: providerErrorSamples.filter(s => s.statusCode === 429).length,
    adaptiveConcurrency,
    failedWallets: providerErrors,
    partialFailures: earlyStopped ? 1 : 0,
    bottleneckStage:
      earlyStopped ? 'safety_timeout'
      : providerErrors > walletsChecked / 2 ? 'provider_fetch'
      : totalDurationMs > 10_000 ? 'provider_fetch'
      : 'none',
  }

  if (debug) {
    response._debug = {
      routeName: `/api/whale-alerts/sync/${mode}`,
      cacheHit: false,
      alchemyConfigured: false,
      alchemyCallsAttempted: 0,
      alchemyCallsSucceeded: 0,
      alchemyCallsFailed: 0,
      rpcMethodsUsed: [],
      skippedReason: 'route_uses_goldrush_not_alchemy',
      fallbackUsed: false,
      requestDurationMs: Date.now() - startedAt,
      whaleSync: {
        walletsProcessed: syncDebug.walletsProcessed,
        providerCallsAttempted: syncDebug.providerCallsAttempted,
        providerCallsSavedByCache: syncDebug.providerCallsSavedByCache,
        providerCallsSavedByDedupe: syncDebug.providerCallsSavedByDedupe,
        cacheHits: syncDebug.cacheHits,
        cacheMisses: syncDebug.cacheMisses,
        errorCount: syncDebug.errorCount,
        providerErrorSamples: providerErrorSamples.slice(0, 5),
      },
    }
    response._diagnostics = {
      syncProvider: {
        walletsProcessed: syncDebug.walletsProcessed,
        providerCallsAttempted: syncDebug.providerCallsAttempted,
        providerCallsSavedByCache: syncDebug.providerCallsSavedByCache,
        providerCallsSavedByDedupe: syncDebug.providerCallsSavedByDedupe,
        cacheHits: syncDebug.cacheHits,
        cacheMisses: syncDebug.cacheMisses,
        errorCount: syncDebug.errorCount,
        providerErrorSamples: providerErrorSamples.slice(0, 5),
      },
      providerErrorCount: providerErrors,
      providerErrorSamples: providerErrorSamples.slice(0, 5).map(s => ({
        statusCode: s.statusCode ?? null,
        reason: s.reason,
      })),
      skipReasons: skipSummary,
      qualifyingTransferCount: alertCandidateCount,
      duplicateCount: finalPipelineSummary.duplicateSkipped,
      firstWalletChecked: walletsList[0] ? shortAddress(walletsList[0].address) : null,
      lastWalletChecked: walletsList.length > 0 ? shortAddress(walletsList[walletsList.length - 1].address) : null,
      thresholdSummary: {
        selectedMinUsd,
        fetchedTxCount,
        parsedMovementCount,
        alertCandidateCount,
      },
      skipSamples,
      finalPipelineSummary,
      dbInsertErrorSamples,
    }
  }

  clearWhaleFeedCache()
  return NextResponse.json(response)
}
