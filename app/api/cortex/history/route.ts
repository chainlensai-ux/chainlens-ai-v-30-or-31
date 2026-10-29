import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { createRateLimiter } from '@/lib/server/rateLimit'

export const runtime = 'nodejs'

const CHAINS = new Set(['base', 'eth', 'bnb', 'robinhood'])
const ADDRESS = /^0x[0-9a-f]{40}$/

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 })

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  })

export async function GET(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview') {
    return json({ error: 'Not available.' }, 404)
  }

  if (process.env.CORTEX_SCAN_MEMORY_ENABLED !== 'true') {
    return json({ error: 'Not available.' }, 404)
  }

  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(user.userId)) {
    return json({ error: 'Too many history requests.' }, 429)
  }

  const url = new URL(req.url)
  const chain = url.searchParams.get('chain') ?? ''
  const contract = (url.searchParams.get('contract') ?? '').toLowerCase()

  if (!CHAINS.has(chain) || !ADDRESS.test(contract)) {
    return json({ error: 'Invalid chain or contract.' }, 400)
  }

  const dbUrl = process.env.CORTEX_SUPABASE_URL
  const dbKey = process.env.CORTEX_SUPABASE_SERVICE_ROLE_KEY

  if (!dbUrl || !dbKey) {
    return json({ error: 'History unavailable.' }, 503)
  }

  try {
    const db = createClient(dbUrl, dbKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data, error } = await db
      .from('scan_memory')
      .select(
        'observed_at,risk_score,risk_label,coverage,coverage_reason,price_usd,liquidity_usd,market_cap_usd,holder_points,holder_basis,scanner_version,risk_methodology_version'
      )
      .eq('chain', chain)
      .eq('token_address', contract)
      .gt('expires_at', new Date().toISOString())
      .order('observed_at', { ascending: false })
      .limit(60)

    if (error) {
      console.error('cortex_history_query_failed')
      return json({ error: 'History unavailable.' }, 503)
    }

    return json({
      chain,
      contract,
      observations: (data ?? []).map((row) => ({
        observedAt: row.observed_at,
        riskScore: row.risk_score,
        riskLabel: row.risk_label,
        coverage: row.coverage,
        coverageReason: row.coverage_reason,
        priceUsd: row.price_usd,
        liquidityUsd: row.liquidity_usd,
        marketCapUsd: row.market_cap_usd,
        holderPoints: row.holder_points,
        holderBasis: row.holder_basis,
        scannerVersion: row.scanner_version,
        riskMethodologyVersion: row.risk_methodology_version,
      })),
    })
  } catch {
    console.error('cortex_history_request_failed')
    return json({ error: 'History unavailable.' }, 503)
  }
}
