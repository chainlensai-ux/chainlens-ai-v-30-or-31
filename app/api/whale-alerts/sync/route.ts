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
const DEFAULT_OFFSET = 0
const SAFETY_TIMEOUT_MS = 19_500

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

  const requestUrl = new URL(request.url)
  const debug = requestUrl.searchParams.get('debug') === 'true'
  const queryWindow = requestUrl.searchParams.get('window')
  const bodyWindow = typeof body.window === 'string' ? body.window : null
  const requestedWindow = queryWindow ?? bodyWindow
  const selectedWindow: SyncWindow = requestedWindow === '3d' || requestedWindow === '7d' ? requestedWindow : '24h'
  const windowMs = WINDOW_MS[selectedWindow]

  const queryLimit = parseInteger(requestUrl.searchParams.get('limit'))
  const bodyLimit = parseInteger(body.limit)
  const rawLimit = queryLimit ?? bodyLimit ?? DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, rawLimit))

  const queryOffset = parseInteger(requestUrl.searchParams.get('offset'))
  const bodyOffset = parseInteger(body.offset)
  const rawOffset = queryOffset ?? bodyOffset ?? DEFAULT_OFFSET
  const offset = Math.max(0, rawOffset)

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
    .range(offset, offset + limit - 1)

  if (walletError) {
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  const trackedWalletsTotal = count ?? 0
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
        } else if (usd < 1000) {
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

        filteredAlerts.push({
          ...alert,
          amount_usd: usd,
          severity: severityFromUsd(usd),
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

  const nextOffset = offset + processed < trackedWalletsTotal ? offset + processed : null
  const response: Record<string, unknown> = {
    ok: true,
    selectedWindow,
    providerSummary: {
      endpointPath: PROVIDER_ENDPOINT_PATH,
      authMode: 'authorization_bearer',
      chain: 'base-mainnet',
    },
    trackedWalletsTotal,
    processed,
    offset,
    limit,
    nextOffset,
    inserted,
    skipped,
    providerErrors,
    providerErrorSamples,
  }

  if (debug) {
    response.fetchedTxCount = fetchedTxCount
    response.parsedMovementCount = parsedMovementCount
    response.alertCandidateCount = alertCandidateCount
    response.skipSummary = skipSummary
    response.skipSamples = skipSamples
    response.finalPipelineSummary = finalPipelineSummary
    response.dbInsertErrorSamples = dbInsertErrorSamples
  }

  return NextResponse.json(response)
}
