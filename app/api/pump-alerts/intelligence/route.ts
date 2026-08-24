import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { buildPumpIntelligenceReport, type PumpAlertInput, type WhaleAlertRow } from '@/lib/server/pumpIntelligence'

export const dynamic = 'force-dynamic'

// PUMP-INTELLIGENCE-REPORT, DISCLOSED: gated at Pro/Elite because its wallet-intelligence section
// reads the same whale_alerts feed as /api/whale-alerts, which is itself Pro/Elite-gated — a Free
// user could otherwise see whale data through this route that the whale-alerts route deliberately
// withholds from them.
const INTEL_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 0, pro: 12, elite: 30 }
const intelRate = new Map<string, { count: number; resetAt: number }>()

function getIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const contract = (searchParams.get('contract') ?? '').trim()
  const chain = (searchParams.get('chain') ?? 'base').trim().toLowerCase()
  if (!contract) return NextResponse.json({ error: 'contract is required' }, { status: 400 })

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  if (token) {
    const planData = await getCurrentUserPlanFromBearerToken(token).catch(() => null)
    if (planData) plan = planData.plan
  }
  if (plan === 'free') {
    return NextResponse.json({ error: 'Pump Intelligence Reports are included in Pro and Elite.' }, { status: 403 })
  }

  const ip = getIp(req)
  const rk = `${ip}:${plan}`
  const now = Date.now()
  const rr = intelRate.get(rk)
  if (!rr || rr.resetAt <= now) intelRate.set(rk, { count: 1, resetAt: now + 60_000 })
  else if (rr.count >= INTEL_RATE_LIMIT[plan]) {
    return NextResponse.json({ error: 'Rate limit reached. Try again shortly.' }, { status: 429 })
  } else rr.count += 1

  // Alert snapshot fields the client already has (from the pump-alerts list) — used as a fallback
  // if the fresh /api/token call below fails, so the report can still render its price/volume/
  // liquidity context rather than showing nothing.
  const alert: PumpAlertInput = {
    symbol: searchParams.get('symbol') ?? '?',
    name: searchParams.get('name') ?? 'Unknown',
    contract,
    priceUsd: numOrNull(searchParams.get('priceUsd')),
    change24h: numOrNull(searchParams.get('change24h')),
    change7d: numOrNull(searchParams.get('change7d')),
    volume24hUsd: numOrNull(searchParams.get('volume24hUsd')),
    liquidityUsd: numOrNull(searchParams.get('liquidityUsd')),
    fdvUsd: numOrNull(searchParams.get('fdvUsd')),
    reason: searchParams.get('reason') ?? 'Flagged by pump detection.',
    riskLevel: (searchParams.get('riskLevel') as PumpAlertInput['riskLevel']) ?? 'MEDIUM',
  }

  // ── Fetch full CORTEX analysis via the existing, already-correct /api/token pipeline —
  // deliberately an internal call rather than reimplementing RiskEngine/LP/holder/honeypot
  // analysis here (see pumpIntelligence.ts's header comment for why).
  let tokenAnalysis: Record<string, unknown> | null = null
  try {
    const origin = new URL(req.url).origin
    const tokenRes = await fetch(`${origin}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ contract, chain }),
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    })
    if (tokenRes.ok) {
      const json = await tokenRes.json()
      if (!json?.error) tokenAnalysis = json
      // Use the fresher, authoritative values from the live scan when present.
      if (json?.symbol) alert.symbol = json.symbol
      if (json?.name) alert.name = json.name
    }
  } catch { /* best-effort — report still renders from the alert snapshot + whale data alone */ }

  // ── Real per-token whale event log (Supabase) ──────────────────────────────────────────
  let whaleRows: WhaleAlertRow[] = []
  let trackedAddresses = new Set<string>()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (supabaseUrl && serviceRole) {
    try {
      const supabase = createClient(supabaseUrl, serviceRole)
      const [alertsRes, trackedRes] = await Promise.all([
        supabase
          .from('whale_alerts')
          .select('wallet_address, side, amount_usd, occurred_at')
          .ilike('token_address', contract)
          .order('occurred_at', { ascending: false })
          .limit(60),
        supabase.from('tracked_wallets').select('address').eq('is_active', true),
      ])
      if (!alertsRes.error && alertsRes.data) whaleRows = alertsRes.data as WhaleAlertRow[]
      if (!trackedRes.error && trackedRes.data) {
        trackedAddresses = new Set(
          (trackedRes.data as Array<{ address: string }>).map(r => r.address.toLowerCase())
        )
      }
    } catch { /* best-effort — wallet intelligence section degrades to "no data" honestly */ }
  }

  const report = buildPumpIntelligenceReport({ alert, chain, tokenAnalysis, whaleRows, trackedAddresses })
  return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
}

function numOrNull(v: string | null): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
