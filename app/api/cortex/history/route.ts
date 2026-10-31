import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { ACCOUNT_SCAN_CHAINS, canonicalHistoryToken, retryAccountScan } from '@/lib/server/accountScanHistory'

export const runtime = 'nodejs'
const limiter = createRateLimiter({ windowMs: 60_000, max: 30 })
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

export async function POST(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(user.userId)) return json({ error: 'Too many history requests.' }, 429)
  const body = await req.json().catch(() => null)
  const receipt = await retryAccountScan(user.userId, body?.retryToken)
  return json({ accountHistory: receipt }, receipt.status === 'ineligible' ? 400 : receipt.status === 'unavailable' ? 503 : 200)
}

export async function GET(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(user.userId)) return json({ error: 'Too many history requests.' }, 429)
  const url = new URL(req.url)
  const chain = url.searchParams.get('chain') ?? ''
  const contract = canonicalHistoryToken(chain, url.searchParams.get('contract') ?? '')
  if (!contract) return json({ error: 'Invalid chain or contract.' }, 400)
  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!dbUrl || !anonKey) return json({ error: 'Account history unavailable.' }, 503)
  try {
    // User JWT enforces RLS; explicit user_id predicate is an additional isolation guard.
    const db = createClient(dbUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: req.headers.get('authorization') ?? '' } } })
    let query = db.from('cortex_account_scan_history')
      .select('id,observed_at,risk_score,risk_label,confidence,coverage_percent,scanner_version,risk_methodology_version,evidence_snapshot')
      .eq('user_id', user.userId).eq('chain_id', ACCOUNT_SCAN_CHAINS[chain]).eq('token_address', contract)
    const cursor = url.searchParams.get('cursor')
    if (cursor) {
      let parsed: { at?: string; id?: string }
      try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { return json({ error: 'Invalid cursor.' }, 400) }
      if (!parsed.at || !Number.isFinite(Date.parse(parsed.at)) || !/^[0-9a-f-]{36}$/i.test(parsed.id ?? '')) return json({ error: 'Invalid cursor.' }, 400)
      const at = new Date(parsed.at).toISOString()
      query = query.or(`observed_at.lt.${at},and(observed_at.eq.${at},id.lt.${parsed.id})`)
    }
    const { data, error } = await query.order('observed_at', { ascending: false }).order('id', { ascending: false }).limit(201).abortSignal(AbortSignal.timeout(2000))
    if (error) return json({ error: 'Account history unavailable. The history migration may not be installed.' }, 503)
    const rows = (data ?? []).slice(0, 200)
    const last = rows.at(-1)
    return json({ chain, contract, storage: 'account', nextCursor: data && data.length > 200 && last ? Buffer.from(JSON.stringify({ at: last.observed_at, id: last.id })).toString('base64url') : null,
      observations: rows.map(row => {
        const evidence = row.evidence_snapshot as Record<string, any>
        return { observedAt: row.observed_at, riskScore: row.risk_score, riskLabel: row.risk_label,
          confidence: row.confidence, coveragePercent: row.coverage_percent,
          coverage: Number(row.coverage_percent) === 100 ? 'complete' : 'partial', coverageReason: 'partial_section',
          priceUsd: evidence.priceUsd ?? null, liquidityUsd: evidence.liquidityUsd ?? null, marketCapUsd: evidence.marketCapUsd ?? null,
          holderPoints: evidence.top10 ?? null, holderBasis: evidence.holderBasis ?? null,
          scannerVersion: row.scanner_version, riskMethodologyVersion: row.risk_methodology_version, factors: evidence.factors ?? null }
      }) })
  } catch { return json({ error: 'Account history unavailable.' }, 503) }
}
