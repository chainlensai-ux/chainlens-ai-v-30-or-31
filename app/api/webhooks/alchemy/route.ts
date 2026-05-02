import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Alchemy ADDRESS_ACTIVITY webhook payload shape
type AlchemyActivity = {
  fromAddress?: string | null
  toAddress?: string | null
  hash?: string | null
  value?: number | null
  asset?: string | null
  category?: string | null
  rawContract?: {
    address?: string | null
    decimals?: number | null
    rawValue?: string | null
  } | null
}

type AlchemyPayload = {
  createdAt?: string | null
  type?: string
  event?: {
    network?: string
    activity?: unknown[]
  }
}

type TrackedWallet = {
  address: string
  label: string | null
}

type SkipReasons = {
  no_activity: number
  no_tx_hash: number
  no_tracked_wallet_match: number
  duplicate: number
  insert_failed: number
  missing_required_fields: number
}

function makeSkipReasons(): SkipReasons {
  return {
    no_activity: 0,
    no_tx_hash: 0,
    no_tracked_wallet_match: 0,
    duplicate: 0,
    insert_failed: 0,
    missing_required_fields: 0,
  }
}

function severityFromUsd(usd: number | null): string | null {
  if (usd === null) return null
  if (usd >= 25000) return 'major'
  if (usd >= 10000) return 'large'
  if (usd >= 5000) return 'medium'
  if (usd >= 1000) return 'small'
  return null
}

export async function GET() {
  return NextResponse.json({ ok: true, route: 'alchemy webhook alive' })
}

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRole) {
    return NextResponse.json({ ok: false, error: 'missing_supabase_env' }, { status: 503 })
  }

  const skipReasons = makeSkipReasons()

  // Load tracked wallets first so trackedWalletCount is always real in diagnostics,
  // even when the payload has no activity (e.g. Alchemy test pings).
  const supabase = createClient(supabaseUrl, serviceRole)

  const { data: wallets, error: walletError } = await supabase
    .from('tracked_wallets')
    .select('address,label')
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  const trackedWalletQueryOk = !walletError
  const trackedWalletCount   = (wallets ?? []).length
  const trackedWalletLoadErrorCode = walletError?.code ?? null

  if (walletError) {
    console.error('[alchemy-webhook] wallet load failed', walletError.code)
    console.log('[alchemy-webhook]', { trackedWalletQueryOk, trackedWalletCount, trackedWalletLoadErrorCode })
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  // Parse body safely — return 200 even on bad body so Alchemy stops retrying
  let payload: AlchemyPayload = {}
  try {
    payload = (await request.json()) as AlchemyPayload
  } catch {
    skipReasons.no_activity += 1
    const diag = { received: 0, trackedWalletQueryOk, trackedWalletCount, matched: 0, inserted: 0, skipped: 1, skipReasons }
    console.log('[alchemy-webhook]', diag)
    return NextResponse.json({ ok: true, ...diag })
  }

  const rawActivity = payload?.event?.activity
  if (!Array.isArray(rawActivity) || rawActivity.length === 0) {
    skipReasons.no_activity += 1
    const diag = { received: 0, trackedWalletQueryOk, trackedWalletCount, matched: 0, inserted: 0, skipped: 1, skipReasons }
    console.log('[alchemy-webhook]', diag)
    return NextResponse.json({ ok: true, ...diag })
  }

  const received = rawActivity.length

  // lowercase address → label for O(1) lookup
  const walletMap = new Map<string, string | null>()
  for (const w of wallets as TrackedWallet[]) {
    walletMap.set(w.address.toLowerCase(), w.label)
  }

  // Use webhook createdAt as occurred_at; fall back to now
  const occurredAt = payload.createdAt
    ? new Date(payload.createdAt).toISOString()
    : new Date().toISOString()

  const candidates: Record<string, unknown>[] = []

  for (const raw of rawActivity) {
    const item = raw as AlchemyActivity
    const fromKey = item.fromAddress?.toLowerCase() ?? null
    const toKey   = item.toAddress?.toLowerCase() ?? null

    // One candidate per matched tracked wallet in this activity item
    type Match = { walletKey: string; storedAddress: string; side: 'buy' | 'sell' }
    const matches: Match[] = []
    if (fromKey && walletMap.has(fromKey)) {
      matches.push({ walletKey: fromKey, storedAddress: item.fromAddress ?? fromKey, side: 'sell' })
    }
    if (toKey && walletMap.has(toKey)) {
      matches.push({ walletKey: toKey, storedAddress: item.toAddress ?? toKey, side: 'buy' })
    }

    if (matches.length === 0) {
      skipReasons.no_tracked_wallet_match += 1
      continue
    }

    const txHash       = item.hash ?? null
    const tokenSymbol  = item.asset ?? null
    const tokenAddress = item.rawContract?.address ?? null
    const amountToken  = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null

    for (const match of matches) {
      if (!txHash) {
        skipReasons.no_tx_hash += 1
        continue
      }
      candidates.push({
        wallet_address: match.storedAddress,
        wallet_label:   walletMap.get(match.walletKey) ?? null,
        token_address:  tokenAddress,
        token_symbol:   tokenSymbol,
        token_name:     null,
        alert_type:     'token_transfer',
        side:           match.side,
        amount_usd:     null,
        amount_token:   amountToken,
        tx_hash:        txHash,
        chain:          'base',
        severity:       severityFromUsd(null),
        summary:        `Alchemy webhook: ${match.side} ${tokenSymbol ?? 'token'} via ${item.category ?? 'transaction'}`,
        occurred_at:    occurredAt,
      })
    }
  }

  const matched = candidates.length

  if (candidates.length === 0) {
    const diag = { received, trackedWalletQueryOk, trackedWalletCount, matched: 0, inserted: 0, skipped: received, skipReasons }
    console.log('[alchemy-webhook]', diag)
    return NextResponse.json({ ok: true, ...diag })
  }

  // Dedupe via the same unique index the sync route uses:
  // uq_whale_alerts_tx_wallet_token_type on (tx_hash, wallet_address, token_address, alert_type)
  const { data, error: insertError } = await supabase
    .from('whale_alerts')
    .upsert(candidates, {
      onConflict: 'tx_hash,wallet_address,token_address,alert_type',
      ignoreDuplicates: true,
    })
    .select('id')

  if (insertError) {
    skipReasons.insert_failed += candidates.length
    console.error('[alchemy-webhook] insert failed', insertError.code)
    const diag = { received, trackedWalletQueryOk, trackedWalletCount, matched, inserted: 0, skipped: candidates.length, skipReasons }
    console.log('[alchemy-webhook]', diag)
    return NextResponse.json({ ok: false, error: 'insert_failed' }, { status: 500 })
  }

  const inserted = data?.length ?? 0
  const skipped  = candidates.length - inserted
  skipReasons.duplicate += skipped

  const diag = { received, trackedWalletQueryOk, trackedWalletCount, matched, inserted, skipped, skipReasons }
  console.log('[alchemy-webhook]', diag)
  return NextResponse.json({ ok: true, ...diag })
}
