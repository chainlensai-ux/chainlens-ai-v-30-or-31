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

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function parseNumeric(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function severityFromUsd(amountUsd: number | null): string | null {
  if (amountUsd === null) return null
  if (amountUsd >= 25000) return 'major'
  if (amountUsd >= 10000) return 'large'
  if (amountUsd >= 5000) return 'medium'
  if (amountUsd >= 1000) return 'small'
  return null
}

async function fetchWalletTransactions(address: string, apiKey: string) {
  const url = new URL(`${COVALENT_BASE}/address/${address}/transactions_v3/`)
  url.searchParams.set('page-size', '100')
  url.searchParams.set('no-logs', 'false')

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`provider_${response.status}_${body.slice(0, 120)}`)
  }

  return response.json()
}

function extractAlerts(wallet: TrackedWallet, txs: CovalentTx[]) {
  const since = Date.now() - 24 * 60 * 60 * 1000
  const alerts: Array<Record<string, unknown>> = []

  for (const tx of txs) {
    const occurredAt = tx.block_signed_at ? new Date(tx.block_signed_at).getTime() : NaN
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

export async function POST() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  const providerKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY

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

  const { data: wallets, error: walletError } = await supabase
    .from('tracked_wallets')
    .select('address,label,category,confidence,source,is_active')
    .eq('is_active', true)

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

  if (!wallets || wallets.length === 0) {
    return NextResponse.json({ ok: false, error: 'no_active_wallets', trackedWallets: 0 }, { status: 404 })
  }

  let totalFetched = 0
  let totalInserted = 0
  let totalSkipped = 0
  const walletSummaries: Array<Record<string, unknown>> = []

  for (const wallet of (wallets ?? []) as TrackedWallet[]) {
    const short = shortAddress(wallet.address)
    try {
      const payload = await fetchWalletTransactions(wallet.address, providerKey)
      const txItems = (payload?.data?.items ?? []) as CovalentTx[]
      totalFetched += txItems.length

      const alerts = extractAlerts(wallet, txItems)
      const filteredAlerts = alerts.map((alert) => {
        const usd = parseNumeric(alert.amount_usd)
        return {
          ...alert,
          amount_usd: usd,
          severity: severityFromUsd(usd),
        }
      })

      let inserted = 0
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
          inserted = data?.length ?? 0
        }
      }

      const skipped = Math.max(filteredAlerts.length - inserted, 0)
      totalInserted += inserted
      totalSkipped += skipped

      console.info('[whale-sync] wallet', short, 'provider_status=ok', `fetched=${txItems.length}`, `inserted=${inserted}`, `skipped=${skipped}`)
      walletSummaries.push({ wallet: short, fetched: txItems.length, inserted, skipped, status: 'ok' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error'
      console.warn('[whale-sync] wallet', short, 'provider_status=error', message)
      walletSummaries.push({ wallet: short, fetched: 0, inserted: 0, skipped: 0, status: 'error' })
    }
  }

  return NextResponse.json({
    ok: true,
    provider: 'covalent_goldrush',
    window: '24h',
    walletsProcessed: wallets?.length ?? 0,
    trackedWallets: wallets?.length ?? 0,
    fetchedCount: totalFetched,
    insertedCount: totalInserted,
    skippedCount: totalSkipped,
    walletSummaries,
  })
}
