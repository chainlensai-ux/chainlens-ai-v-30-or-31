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

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
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

function extractAlerts(wallet: TrackedWallet, txs: CovalentTx[]) {
  const since = Date.now() - 24 * 60 * 60 * 1000
  const alerts: Array<Record<string, unknown>> = []

  for (const tx of txs) {
    const occurredAt = tx.block_signed_at ? new Date(tx.block_signed_at).getTime() : Number.NaN
    if (!Number.isFinite(occurredAt) || occurredAt < since) continue
    if (tx.successful === false) continue

    const eventCount = tx.log_events?.length ?? 0
    const txHash = tx.tx_hash ?? null
    if (!txHash) continue

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
      tx_hash: txHash,
      chain: 'base',
      severity: null,
      summary: `Recent token transfer activity (${eventCount} events)`,
      occurred_at: new Date(occurredAt).toISOString(),
    })
  }

  return alerts
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
  const queryLimit = parseInteger(requestUrl.searchParams.get('limit'))
  const bodyLimit = parseInteger(body.limit)
  const rawLimit = queryLimit ?? bodyLimit ?? DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, rawLimit))

  const queryOffset = parseInteger(requestUrl.searchParams.get('offset'))
  const bodyOffset = parseInteger(body.offset)
  const rawOffset = queryOffset ?? bodyOffset ?? DEFAULT_OFFSET
  const offset = Math.max(0, rawOffset)

  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({
      ok: false,
      error: 'missing_supabase_env',
      env: {
        hasNextPublicSupabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
        hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
        hasNextPublicAnonKey: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
        hasServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        expectedNames: [
          'NEXT_PUBLIC_SUPABASE_URL',
          'SUPABASE_URL',
          'NEXT_PUBLIC_SUPABASE_ANON_KEY',
          'SUPABASE_SERVICE_ROLE_KEY',
        ],
      },
    }, { status: 503 })
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
    console.error('[whale-sync] wallet load failed', walletError.message)
    return NextResponse.json({
      ok: false,
      error: 'wallet_load_failed',
      details: {
        table: 'tracked_wallets',
        code: walletError.code ?? null,
        message: walletError.message ?? null,
        hint: walletError.hint ?? null,
        details: walletError.details ?? null,
      },
    }, { status: 500 })
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
  const providerErrorSamples: ProviderErrorSample[] = []

  for (const wallet of wallets as TrackedWallet[]) {
    if (Date.now() - startedAt >= SAFETY_TIMEOUT_MS) {
      break
    }

    processed += 1
    const short = shortAddress(wallet.address)

    try {
      const payload = await fetchWalletTransactions(wallet.address, providerKey)
      const txItems = (payload?.data?.items ?? []) as CovalentTx[]

      const alerts = extractAlerts(wallet, txItems)
      const filteredAlerts = alerts.map((alert) => {
        const usd = parseNumeric(alert.amount_usd)
        return {
          ...alert,
          amount_usd: usd,
          severity: severityFromUsd(usd),
        }
      })

      let walletInserted = 0
      if (filteredAlerts.length > 0) {
        const { data, error } = await supabase
          .from('whale_alerts')
          .upsert(filteredAlerts, {
            onConflict: 'tx_hash,wallet_address,token_address,alert_type',
            ignoreDuplicates: true,
          })
          .select('id')

        if (error) {
          console.warn('[whale-sync] insert failed', short, error.message)
        } else {
          walletInserted = data?.length ?? 0
        }
      }

      const walletSkipped = Math.max(filteredAlerts.length - walletInserted, 0)
      inserted += walletInserted
      skipped += walletSkipped

      console.info('[whale-sync] wallet', short, 'provider_status=ok', `fetched=${txItems.length}`, `inserted=${walletInserted}`, `skipped=${walletSkipped}`)
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

      console.warn('[whale-sync] wallet', short, 'provider_status=error', `status=${statusCode ?? 'network'}`, reason)
    }
  }

  const nextOffset = offset + processed < trackedWalletsTotal ? offset + processed : null

  return NextResponse.json({
    ok: true,
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
  })
}
