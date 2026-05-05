import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

const ROUTING_ONLY_SYMBOLS = new Set(['USDC', 'USDBC', 'EURC', 'DAI', 'USDT', 'WETH', 'ETH', 'CBBTC', 'WSTETH'])
const WEBHOOK_EVENT_CAP_PER_MINUTE = 150

const minuteBuckets = new Map<string, number>()

function consumeMinuteBudget(requested: number): { allowed: number; deferred: number } {
  const now = new Date()
  const minuteKey = now.toISOString().slice(0, 16)

  for (const key of minuteBuckets.keys()) {
    if (key !== minuteKey) minuteBuckets.delete(key)
  }

  const used = minuteBuckets.get(minuteKey) ?? 0
  const remaining = Math.max(0, WEBHOOK_EVENT_CAP_PER_MINUTE - used)
  const allowed = Math.min(requested, remaining)
  minuteBuckets.set(minuteKey, used + allowed)

  return { allowed, deferred: Math.max(0, requested - allowed) }
}

function isBelowSymbolThreshold(symbol: string | null, amount: number | null): boolean {
  if (amount === null) return false
  const sym = symbol?.toUpperCase() ?? ''
  if (sym === 'USDC' || sym === 'USDT' || sym === 'DAI' || sym === 'USDBC' || sym === 'EURC') return amount < 100
  if (sym === 'WETH' || sym === 'ETH') return amount < 0.01
  return amount <= 0
}

function isLikelyApproval(category: string | null, rawValue: string | null, amountToken: number | null): boolean {
  const cat = (category ?? '').toLowerCase()
  if (cat.includes('approval') || cat.includes('allowance')) return true
  if (amountToken !== null) return false
  return rawValue === '0' || rawValue === '0x0'
}

function shouldEnrichCandidate(symbol: string | null, amountToken: number | null, category: string | null): boolean {
  const sym = symbol?.toUpperCase() ?? null
  const cat = (category ?? '').toLowerCase()
  const nonRouting = sym !== null && !ROUTING_ONLY_SYMBOLS.has(sym)
  const aboveThreshold = amountToken !== null && !isBelowSymbolThreshold(sym, amountToken)
  const meaningfulType = cat.includes('swap') || cat.includes('transfer') || cat.includes('erc20')
  return nonRouting || aboveThreshold || meaningfulType
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

  let payload: AlchemyPayload = {}
  try {
    payload = (await request.json()) as AlchemyPayload
  } catch {
    console.log('[alchemy-webhook]', { received: 0, earlySkipped: 1, duplicateSkipped: 0, relevantForEnrichment: 0, enriched: 0, inserted: 0 })
    return NextResponse.json({ ok: true, received: 0, inserted: 0 })
  }

  const rawActivity = payload?.event?.activity
  if (!Array.isArray(rawActivity) || rawActivity.length === 0) {
    console.log('[alchemy-webhook]', { received: 0, earlySkipped: 1, duplicateSkipped: 0, relevantForEnrichment: 0, enriched: 0, inserted: 0 })
    return NextResponse.json({ ok: true, received: 0, inserted: 0 })
  }

  const received = rawActivity.length
  const budget = consumeMinuteBudget(received)

  const supabase = createClient(supabaseUrl, serviceRole)
  const { data: wallets, error: walletError } = await supabase
    .from('tracked_wallets')
    .select('address,label')
    .eq('is_active', true)

  if (walletError) {
    return NextResponse.json({ ok: false, error: 'wallet_load_failed' }, { status: 500 })
  }

  const walletMap = new Map<string, string | null>()
  for (const w of (wallets ?? []) as TrackedWallet[]) {
    walletMap.set(w.address.toLowerCase(), w.label)
  }

  const occurredAt = payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString()
  const dedupePairs = new Set<string>()
  const candidates: Record<string, unknown>[] = []

  let duplicateSkipped = 0
  let earlySkipped = budget.deferred
  let relevantForEnrichment = 0

  for (let i = 0; i < budget.allowed; i += 1) {
    const item = rawActivity[i] as AlchemyActivity
    const txHash = item.hash?.trim() ?? null
    if (!txHash) {
      earlySkipped += 1
      continue
    }

    const tokenSymbol = item.asset?.toUpperCase() ?? null
    const tokenAddress = item.rawContract?.address ?? null
    const rawValue = item.rawContract?.rawValue ?? null
    const amountToken = typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null

    if (isLikelyApproval(item.category ?? null, rawValue, amountToken)) {
      earlySkipped += 1
      continue
    }

    const isInternal = item.category === 'internal'
    const isZeroValue = amountToken !== null && amountToken <= 0
    const isNativeDust = tokenAddress === null && (tokenSymbol === 'ETH' || tokenSymbol === null) && (amountToken === null || amountToken < 0.01)
    if (isZeroValue || isInternal || isNativeDust) {
      earlySkipped += 1
      continue
    }

    const fromKey = item.fromAddress?.toLowerCase() ?? null
    const toKey = item.toAddress?.toLowerCase() ?? null

    const matches: Array<{ walletKey: string; storedAddress: string; side: 'buy' | 'sell' }> = []
    if (fromKey && walletMap.has(fromKey)) matches.push({ walletKey: fromKey, storedAddress: item.fromAddress ?? fromKey, side: 'sell' })
    if (toKey && walletMap.has(toKey)) matches.push({ walletKey: toKey, storedAddress: item.toAddress ?? toKey, side: 'buy' })

    if (matches.length === 0) {
      earlySkipped += 1
      continue
    }

    for (const match of matches) {
      const pairKey = `${txHash}::${match.walletKey}`
      if (dedupePairs.has(pairKey)) {
        duplicateSkipped += 1
        continue
      }
      dedupePairs.add(pairKey)
      if (!shouldEnrichCandidate(tokenSymbol, amountToken, item.category ?? null)) {
        earlySkipped += 1
        continue
      }
      relevantForEnrichment += 1

      candidates.push({
        wallet_address: match.storedAddress,
        wallet_label: walletMap.get(match.walletKey) ?? null,
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        token_name: null,
        alert_type: 'token_transfer',
        side: match.side,
        amount_usd: null,
        amount_token: amountToken,
        tx_hash: txHash,
        chain: 'base',
        severity: severityFromUsd(null),
        summary: `Alchemy webhook: ${match.side} ${tokenSymbol ?? 'token'} via ${item.category ?? 'transaction'}`,
        occurred_at: occurredAt,
      })
    }
  }

  const enriched = candidates.length

  if (candidates.length === 0) {
    console.log('[alchemy-webhook]', { received, earlySkipped, duplicateSkipped, relevantForEnrichment, enriched: 0, inserted: 0 })
    return NextResponse.json({ ok: true, received, inserted: 0 })
  }

  const { data, error: insertError } = await supabase
    .from('whale_alerts')
    .upsert(candidates, {
      onConflict: 'tx_hash,wallet_address,token_address,alert_type',
      ignoreDuplicates: true,
    })
    .select('id')

  if (insertError) {
    return NextResponse.json({ ok: false, error: 'insert_failed' }, { status: 500 })
  }

  const inserted = data?.length ?? 0
  duplicateSkipped += Math.max(0, candidates.length - inserted)

  console.log('[alchemy-webhook]', { received, earlySkipped, duplicateSkipped, relevantForEnrichment, enriched, inserted })
  return NextResponse.json({ ok: true, received, inserted })
}
