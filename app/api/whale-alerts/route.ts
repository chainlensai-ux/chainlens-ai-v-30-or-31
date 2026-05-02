import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type WindowKey = '15m' | '1h' | '6h' | '24h'

const WINDOW_MS: Record<WindowKey, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

function parseWindow(value: string | null): WindowKey {
  if (value === '15m' || value === '1h' || value === '6h' || value === '24h') return value
  return '24h'
}

function parseLimit(value: string | null): number {
  const n = Number(value ?? 50)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(100, Math.floor(n))
}

function emptyUnavailable(reason: string) {
  return NextResponse.json({
    alerts: [],
    stats: { alerts15m: 0, alerts1h: 0, alerts24h: 0, trackedWallets: 0 },
    unavailable: reason,
  })
}

export async function GET(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRole) {
    return emptyUnavailable('missing_supabase_env')
  }

  try {
    const supabase = createClient(supabaseUrl, serviceRole)
    const params = req.nextUrl.searchParams

    const selectedWindow = parseWindow(params.get('window'))
    const minUsdRaw = params.get('minUsd')
    const minUsd = minUsdRaw && Number.isFinite(Number(minUsdRaw)) ? Number(minUsdRaw) : null
    const type = params.get('type')?.trim() || null
    const side = params.get('side')?.trim() || null
    const severity = params.get('severity')?.trim() || null
    const limit = parseLimit(params.get('limit'))

    const windowStartIso = new Date(Date.now() - WINDOW_MS[selectedWindow]).toISOString()

    // Keep only meaningful token movements. A row passes if ANY branch matches:
    //   1. amount_token IS NULL  — sync rows where token amount is unknown (keep them)
    //   2. USDC with amount >= 100
    //   3. WETH or ETH with amount >= 0.01
    //   4. Any other named token with amount > 0
    //   5. Null-symbol token with amount > 0 (unknown asset, but has a real value)
    // Thresholds mirror the webhook insert filter so future inserts stay consistent.
    const meaningfulFilter =
      'amount_token.is.null,' +
      'and(token_symbol.eq.USDC,amount_token.gte.100),' +
      'and(token_symbol.in.(WETH,ETH),amount_token.gte.0.01),' +
      'and(token_symbol.neq.USDC,token_symbol.neq.WETH,token_symbol.neq.ETH,token_symbol.not.is.null,amount_token.gt.0),' +
      'and(token_symbol.is.null,amount_token.gt.0)'

    let query = supabase
      .from('whale_alerts')
      .select('*')
      .gte('occurred_at', windowStartIso)
      .or(meaningfulFilter)
      .order('occurred_at', { ascending: false })
      .limit(limit)

    // Only apply the minimum-usd filter when value is explicitly > 0.
    // minUsd = 0 means "All" — do not filter, which also preserves rows
    // where amount_usd IS NULL (webhook and sync rows with unknown value).
    if (minUsd !== null && minUsd > 0) query = query.gte('amount_usd', minUsd)
    if (type) query = query.eq('alert_type', type)
    if (side) query = query.eq('side', side)
    if (severity) query = query.eq('severity', severity)

    const [alertsRes, count15m, count1h, count24h, trackedCount] = await Promise.all([
      query,
      supabase.from('whale_alerts').select('id', { count: 'exact', head: true }).gte('occurred_at', new Date(Date.now() - WINDOW_MS['15m']).toISOString()).or(meaningfulFilter),
      supabase.from('whale_alerts').select('id', { count: 'exact', head: true }).gte('occurred_at', new Date(Date.now() - WINDOW_MS['1h']).toISOString()).or(meaningfulFilter),
      supabase.from('whale_alerts').select('id', { count: 'exact', head: true }).gte('occurred_at', new Date(Date.now() - WINDOW_MS['24h']).toISOString()).or(meaningfulFilter),
      supabase.from('tracked_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    ])

    if (alertsRes.error) {
      console.error('[whale-alerts] query failed', alertsRes.error.message)
      return NextResponse.json({ error: 'Failed to load alerts.' }, { status: 500 })
    }

    const returnedAlerts = alertsRes.data ?? []
    return NextResponse.json({
      alerts: returnedAlerts,
      stats: {
        alerts15m: count15m.count ?? 0,
        alerts1h: count1h.count ?? 0,
        alerts24h: count24h.count ?? 0,
        trackedWallets: trackedCount.count ?? 0,
      },
      diagnostics: {
        returnedCount: returnedAlerts.length,
        appliedWindow: selectedWindow,
        appliedMinUsd: minUsd ?? 0,
        filtersActive: { type: type ?? null, side: side ?? null, severity: severity ?? null },
      },
    })
  } catch (error) {
    console.error('[whale-alerts] unexpected error', error)
    return NextResponse.json({ error: 'Unexpected server error.' }, { status: 500 })
  }
}
