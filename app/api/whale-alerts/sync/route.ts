import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getVerifiedUserPlan } from '@/lib/supabase/userSettings'

type TrackedWallet = {
  address: string
  label: string | null
  category: string | null
  confidence: number | null
  source: string | null
  is_active: boolean
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
  log_events?: CovalentLogEvent[]
}

const COVALENT_BASE = 'https://api.covalenthq.com/v1/base-mainnet'
const PROVIDER_ENDPOINT_PATH = '/v1/base-mainnet/address/{wallet}/transactions_v3/?page-number=0&page-size=100'
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 15
const AUTO_BATCH_MAX_TOTAL = 25
const DEFAULT_OFFSET = 0
const SAFETY_TIMEOUT_MS = 19_500
const PER_WALLET_TIMEOUT_MS = 8_000
const SYNC_COOLDOWN_MS = 10 * 60 * 1000
const FULL_SYNC_COOLDOWN_MS = 45 * 60 * 1000
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
  const cooldownMs = mode === 'full' ? FULL_SYNC_COOLDOWN_MS : SYNC_COOLDOWN_MS
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

async function fetchWalletTransactions(address: string, apiKey: string) {
  const url = new URL(`${COVALENT_BASE}/address/${address}/transactions_v3/`)
  url.searchParams.set('page-number', '0')
  url.searchParams.set('page-size', '100')

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(PER_WALLET_TIMEOUT_MS),
    })
  } catch {
    throw new ProviderRequestError(null, 'network_error', [])
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

    throw new ProviderRequestError(response.status, classifyProviderError(response.status), responseKeys)
  }

  return response.json()
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
      amountToken: number
      side: 'buy' | 'sell'
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

      const decimals   = event.sender_contract_decimals ?? 18
      const rawAmount  = Number(valueParam)
      if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue
      const amountToken = rawAmount / Math.pow(10, decimals)
      if (!Number.isFinite(amountToken) || amountToken <= 0) continue

      const side: 'buy' | 'sell' = isReceive ? 'buy' : 'sell'
      const key = `${tokenAddress}::${side}`
      const existing = movements.get(key)
      if (existing) {
        existing.amountToken += amountToken
      } else {
        movements.set(key, {
          tokenAddress,
          tokenSymbol: event.sender_contract_ticker_symbol ?? null,
          amountToken,
          side,
        })
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
        summary: `${wallet.label ?? 'Tracked wallet'} ${dirVerb} ${mv.amountToken.toFixed(4)} ${mv.tokenSymbol ?? 'tokens'}`,
        occurred_at: occurredAtIso,
      })
    }
  }

  return { alerts, skipSummary, parsedMovementCount }
}

export async function POST(request: Request) {
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
  const verifiedPlan = await getVerifiedUserPlan(request)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[sync] route=/api/whale-alerts/sync verifiedPlan=${verifiedPlan}`)
  }
  if (verifiedPlan === 'free') return NextResponse.json({ ok: false, mode, error: 'Included in Pro and Elite.', planGate: { verifiedPlan, requiredPlan: 'pro' } }, { status: 403 })
  const allow = syncAllowed(verifiedPlan, request, mode, isContinuation)
  if (!allow.ok) return NextResponse.json({ ok: false, mode, error: allow.cooldown ? "Sync cooldown active. Try again later." : "Rate limit reached. Try again shortly.", retryAfterMs: allow.retryAfterMs ?? null }, { status: 429 })
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
  const { data: allWalletData, error: walletError } = await supabase
    .from('tracked_wallets')
    .select('address,label,category,confidence,source,is_active')
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  if (walletError) {
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  const allWallets = (allWalletData ?? []) as TrackedWallet[]
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

  const walletBatch = allWallets.slice(offset, offset + limit)

  const startedAt = Date.now()
  let processed = 0
  let inserted = 0
  let skipped = 0
  let providerErrors = 0
  let fetchedTxCount = 0
  let parsedMovementCount = 0
  let alertCandidateCount = 0
  const providerErrorSamples: ProviderErrorSample[] = []
  const skipSummary = makeSkipSummary()
  const skipSamples: SkipSample[] = []
  const finalPipelineSummary = makeFinalPipelineSummary()
  const dbInsertErrorSamples: Array<Record<string, string | null>> = []

  for (const wallet of walletBatch) {
    if (Date.now() - startedAt >= SAFETY_TIMEOUT_MS) break

    processed += 1
    const short = shortAddress(wallet.address)

    try {
      const payload = await fetchWalletTransactions(wallet.address, providerKey)
      const txItems = (payload?.data?.items ?? []) as CovalentTx[]
      fetchedTxCount += txItems.length

      const extracted = extractAlerts(wallet, txItems, windowMs, selectedWindow)
      parsedMovementCount += extracted.parsedMovementCount
      alertCandidateCount += extracted.alerts.length

      for (const [reason, value] of Object.entries(extracted.skipSummary) as Array<[SkipReason, number]>) {
        skipSummary[reason] += value
      }

      finalPipelineSummary.candidatesSeen += extracted.alerts.length
      const filteredAlerts: Array<Record<string, unknown>> = []
      for (const alert of extracted.alerts) {
        const usd = parseNumeric(alert.amount_usd)
        const walletAddress = (alert.wallet_address as string | null) ?? null
        const alertType = (alert.alert_type as string | null) ?? null
        const occurredAt = (alert.occurred_at as string | null) ?? null

        const tokenAddress = (alert.token_address as string | null) ?? null
        if (!walletAddress || !alertType || !occurredAt || !tokenAddress) {
          finalPipelineSummary.missingRequiredField += 1
          skipSummary.missingTokenAddress += 1
          pushSkipSample(skipSamples, {
            wallet: short,
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
            wallet: short,
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
        filteredAlerts.push({
          ...alert,
          amount_usd: usd,
          severity,
        })
      }

      let walletInserted = 0
      if (filteredAlerts.length > 0) {
        finalPipelineSummary.attemptedInsert += filteredAlerts.length
        const { data, error } = await supabase
          .from('whale_alerts')
          .upsert(filteredAlerts, {
            onConflict: 'tx_hash,wallet_address,token_address,alert_type',
            ignoreDuplicates: true,
          })
          .select('id')

        if (!error) {
          walletInserted = data?.length ?? 0
        } else {
          finalPipelineSummary.dbInsertFailed += filteredAlerts.length
          if (dbInsertErrorSamples.length < 3) {
            dbInsertErrorSamples.push({
              code: error.code ?? null,
              message: error.message ?? null,
              hint: error.hint ?? null,
              details: error.details ?? null,
            })
          }
        }
      }

      const walletSkipped = Math.max(filteredAlerts.length - walletInserted, 0)
      inserted += walletInserted
      skipped += walletSkipped
      finalPipelineSummary.inserted += walletInserted
      finalPipelineSummary.duplicateSkipped += walletSkipped
      skipSummary.duplicate += walletSkipped
      skipSummary.dbSkipped += walletSkipped
      if (walletSkipped > 0 && skipSamples.length < 5) {
        for (const alert of filteredAlerts.slice(0, Math.min(walletSkipped, 5 - skipSamples.length))) {
          pushSkipSample(skipSamples, {
            wallet: short,
            txHash: shortHash((alert.tx_hash as string | null) ?? null),
            reason: 'duplicate',
            tokenSymbol: (alert.token_symbol as string | null) ?? null,
            tokenAddressShort: shortHash((alert.token_address as string | null) ?? null),
            amountUsd: parseNumeric(alert.amount_usd),
            alertType: (alert.alert_type as string | null) ?? null,
            side: (alert.side as string | null) ?? null,
            occurredAt: (alert.occurred_at as string | null) ?? null,
          })
        }
      }
    } catch (error) {
      providerErrors += 1
      const statusCode = error instanceof ProviderRequestError ? error.statusCode : null
      const reason = error instanceof ProviderRequestError ? error.message : 'provider_fetch_failed'
      const responseKeys = error instanceof ProviderRequestError ? error.responseKeys : []
      pushProviderErrorSample(providerErrorSamples, {
        wallet: short,
        provider: 'goldrush',
        endpointPath: PROVIDER_ENDPOINT_PATH,
        statusCode,
        reason,
        responseKeys,
      })
    }
  }

  const processedTotal = offset + processed
  const done = processedTotal >= trackedWalletsTotal
  const nextOffset = done ? null : processedTotal
  const hasMore = !done
  const noFreshSignal = inserted === 0
  const refreshStatus =
    processed === 0
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
    walletsChecked: processed,
    processed,
    processedTotal,
    inserted,
    skipped,
    nextOffset,
    hasMore,
    done,
    noFreshSignal,
    refreshStatus,
    providerErrors,
    skipReasons: skipSummary,
    message: processed === 0
      ? 'No active wallets were scanned in this batch.'
      : inserted > 0
        ? `Checked ${processed} wallet${processed === 1 ? '' : 's'}. Found ${inserted} qualifying alert${inserted === 1 ? '' : 's'}.`
        : done
          ? 'No fresh signal in the checked window.'
          : `Checked ${processed} of ${trackedWalletsTotal} wallets. No fresh signal yet — continue to scan more.`,
  }

  if (debug) {
    response._diagnostics = {
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

  return NextResponse.json(response)
}
