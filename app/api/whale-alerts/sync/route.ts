import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type TrackedWallet = {
  address: string
  label: string | null
  category: string | null
  confidence: number | null
  source: string | null
  is_active: boolean
}

type CovalentTx = {
  tx_hash?: string
  block_signed_at?: string
  successful?: boolean
  log_events?: Array<{
    sender_address?: string | null
    decoded?: {
      name?: string
      params?: Array<{ name?: string; value?: string }>
    } | null
  }>
}

const COVALENT_BASE = 'https://api.covalenthq.com/v1/base-mainnet'
const PROVIDER_ENDPOINT_PATH = '/v1/base-mainnet/address/{wallet}/transactions_v3/?page-number=0&page-size=100'
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 25
const AUTO_BATCH_MAX_TOTAL = 25
const DEFAULT_OFFSET = 0
const SAFETY_TIMEOUT_MS = 19_500
const SYNC_COOLDOWN_MS = 10 * 60 * 1000
const FULL_SYNC_COOLDOWN_MS = 45 * 60 * 1000
const syncRate = new Map<string, { count: number; resetAt: number; lastRunAt: number }>()
const SYNC_RATE_BY_PLAN: Record<string, number> = { free: 2, pro: 6, elite: 15 }
function syncPlan(req: Request): 'free' | 'pro' | 'elite' { const p=(req.headers.get('x-user-plan')??'').toLowerCase(); return p==='elite'?'elite':p==='pro'?'pro':'free' }
function syncIp(req: Request): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
function syncAllowed(req: Request, mode: 'batch' | 'full', isFullContinuation = false): { ok: boolean; cooldown: boolean } { const plan=syncPlan(req); const key=`${mode}:${plan}:${syncIp(req)}`; const now=Date.now(); const cur=syncRate.get(key); const lim=mode === 'full' ? 1 : SYNC_RATE_BY_PLAN[plan]; const cooldownMs = mode === 'full' ? FULL_SYNC_COOLDOWN_MS : SYNC_COOLDOWN_MS; if(mode === 'full' && isFullContinuation){ if(!cur||cur.resetAt<=now){ syncRate.set(key,{count:1,resetAt:now+60000,lastRunAt:now}); return { ok:true, cooldown:false } } if(cur.count>=lim) return { ok:false, cooldown:false }; cur.count+=1; cur.lastRunAt=now; return { ok:true, cooldown:false } } if(cur && now-cur.lastRunAt < cooldownMs) return { ok:false, cooldown:true }; if(!cur||cur.resetAt<=now){ syncRate.set(key,{count:1,resetAt:now+60000,lastRunAt:now}); return { ok:true, cooldown:false } } if(cur.count>=lim) return { ok:false, cooldown:false }; cur.count+=1; cur.lastRunAt=now; return { ok:true, cooldown:false } }

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

    parsedMovementCount += 1

    alerts.push({
      wallet_address: wallet.address,
      wallet_label: wallet.label,
      token_address: null,
      token_symbol: null,
      token_name: null,
      alert_type: 'token_transfer',
      side: null,
      amount_usd: null,
      amount_token: null,
      tx_hash: tx.tx_hash,
      chain: 'base',
      severity: null,
      summary: `Recent token transfer activity (${tx.log_events?.length ?? 0} events)`,
      occurred_at: new Date(occurredAt).toISOString(),
    })
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
  const selectedMinUsd = Math.max(0, Number.isFinite(parsedQueryMinUsd as number) ? (parsedQueryMinUsd as number) : (Number.isFinite(parsedBodyMinUsd as number) ? (parsedBodyMinUsd as number) : 1000))

  const queryOffset = parseInteger(requestUrl.searchParams.get('offset'))
  const bodyOffset = parseInteger(body.offset)
  const rawOffset = queryOffset ?? bodyOffset ?? DEFAULT_OFFSET
  const offset = Math.max(0, rawOffset)
  const isFullContinuation = mode === 'full' && offset > 0
  const allow = syncAllowed(request, mode, isFullContinuation)
  if (!allow.ok) return NextResponse.json({ ok: false, mode, error: allow.cooldown ? "Sync cooldown active. Try again later." : "Rate limit reached. Try again shortly." }, { status: 429 })
  const usingAutomaticBatch = queryOffset === null && bodyOffset === null

  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: 'missing_supabase_env' }, { status: 503 })
  }
  if (!providerKey) {
    return NextResponse.json({ ok: false, error: 'missing_provider_key' }, { status: 503 })
  }

  const supabase = createClient(supabaseUrl, serviceRole)
  const { data: wallets, error: walletError, count } = await supabase
    .from('tracked_wallets')
    .select('address,label,category,confidence,source,is_active', { count: 'exact' })
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .range(
      usingAutomaticBatch ? DEFAULT_OFFSET : offset,
      (usingAutomaticBatch ? DEFAULT_OFFSET : offset) + (usingAutomaticBatch ? Math.min(limit, AUTO_BATCH_MAX_TOTAL) : limit) - 1,
    )

  if (walletError) {
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  const trackedWalletsTotal = count ?? 0
  const effectiveOffset = usingAutomaticBatch ? DEFAULT_OFFSET : offset
  if (!wallets || wallets.length === 0) {
    return NextResponse.json({ ok: false, error: 'no_active_wallets', trackedWallets: 0 }, { status: 404 })
  }

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

  for (const wallet of wallets as TrackedWallet[]) {
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

        if (!walletAddress || !alertType || !occurredAt) {
          finalPipelineSummary.missingRequiredField += 1
          skipSummary.other += 1
          pushSkipSample(skipSamples, {
            wallet: short,
            txHash: shortHash((alert.tx_hash as string | null) ?? null),
            reason: 'other',
            tokenSymbol: (alert.token_symbol as string | null) ?? null,
            tokenAddressShort: shortHash((alert.token_address as string | null) ?? null),
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

  const nextOffset = effectiveOffset + processed < trackedWalletsTotal ? effectiveOffset + processed : null
  const hasMore = nextOffset !== null
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
  const response: Record<string, unknown> = {
    ok: true,
    mode,
    selectedWindow,
    providerSummary: {
      endpointPath: PROVIDER_ENDPOINT_PATH,
      authMode: 'authorization_bearer',
      chain: 'base-mainnet',
    },
    trackedWalletsTotal,
    processed,
    offset: effectiveOffset,
    limit: mode === 'full' ? limit : (usingAutomaticBatch ? Math.min(limit, AUTO_BATCH_MAX_TOTAL) : limit),
    nextOffset,
    hasMore,
    refreshStatus,
    inserted,
    skipped,
    skipReasons: skipSummary,
    providerErrors,
    message: processed === 0
      ? (mode === 'full' ? 'No active wallets were scanned for full refresh.' : 'No active wallets were scanned in this batch.')
      : mode === 'full' && hasMore
        ? 'Full refresh in progress.'
        : inserted > 0
          ? `Found ${inserted} qualifying alert${inserted === 1 ? '' : 's'} in this ${mode === 'full' ? 'refresh' : 'batch'}.`
          : `No qualifying recent whale activity found in this ${mode === 'full' ? 'refresh' : 'batch'}.`,
  }

  if (debug) {
    response.providerErrorSamples = providerErrorSamples
    response.fetchedTxCount = fetchedTxCount
    response.parsedMovementCount = parsedMovementCount
    response.alertCandidateCount = alertCandidateCount
    response.selectedMinUsd = selectedMinUsd
    response.skipSummary = skipSummary
    response.skipSamples = skipSamples
    response.finalPipelineSummary = finalPipelineSummary
    response.dbInsertErrorSamples = dbInsertErrorSamples
  }

  return NextResponse.json(response)
}
