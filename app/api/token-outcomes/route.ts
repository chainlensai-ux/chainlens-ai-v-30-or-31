import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { OUTCOME_POLICY, type TrackedOutcome } from '@/lib/tokenOutcomes'
import { verifyOutcomeReceipt } from '@/lib/server/tokenOutcomeReceipt'
import { outcomeDb, refreshOutcomes, sanitizeTrackedOutcome } from '@/lib/server/tokenOutcomeService'
import { createRateLimiter } from '@/lib/server/rateLimit'

export const runtime = 'nodejs'
export const maxDuration = 60
const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
export async function GET(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (id) {
      if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return json({ error: 'Invalid outcome ID.' }, 400)
      const { data, error } = await outcomeDb().from('tracked_token_outcomes').select('*').eq('user_id', user.userId).eq('id', id).maybeSingle()
      if (error) return json({ error: 'Unable to load the frozen receipt.' }, 503)
      if (!data) return json({ error: 'Outcome not found.' }, 404)
      return json({ outcome: sanitizeTrackedOutcome(data) })
    }
    // Keep the list small even for Elite. Full immutable evidence loads on receipt open only.
    const { data, error } = await outcomeDb().from('tracked_token_outcomes').select('id,chain,token_address,scan_id,tracked_at,baseline_price_usd,baseline_liquidity_usd,baseline_market_cap_usd,baseline_risk_score,baseline_verdict,current_price_usd,current_liquidity_usd,price_change_pct,liquidity_change_pct,outcome_status,outcome_confidence,outcome_reasons_json,last_checked_at,market_source,after_evidence_json,baseline_snapshot_json->tokenSymbol,baseline_snapshot_json->tokenName,baseline_snapshot_json->scannedAt').eq('user_id', user.userId).order('tracked_at', { ascending: false }).limit(OUTCOME_POLICY.limits.elite)
    if (error) return json({ error: 'Outcome storage unavailable. The tracked-token-outcomes migration must be applied.' }, 503)
    const outcomes = (data ?? []).map(row => sanitizeTrackedOutcome({ ...row, baseline_snapshot_json: {
      tokenSymbol: typeof row.tokenSymbol === 'string' ? row.tokenSymbol : '',
      tokenName: typeof row.tokenName === 'string' ? row.tokenName : '',
      scannedAt: typeof row.scannedAt === 'string' ? row.scannedAt : row.tracked_at,
      baselineRiskScore: row.baseline_risk_score, baselineVerdict: row.baseline_verdict,
    } } as unknown as TrackedOutcome))
    return json({ outcomes, limit: OUTCOME_POLICY.limits[user.plan] })
  } catch { return json({ error: 'Outcome storage is not configured or reachable.' }, 503) }
}
export async function POST(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(user.userId)) return json({ error: 'Too many outcome requests. Try again in a minute.' }, 429)
  try {
    const bodyText = await req.text()
    if (bodyText.length > 182_000) return json({ error: 'Outcome receipt too large.' }, 413)
    let body: { action?: string; receipt?: unknown }
    try { body = JSON.parse(bodyText) } catch { return json({ error: 'Invalid request.' }, 400) }
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400)
    if (body.action === 'refresh') {
      await refreshOutcomes(user.userId)
      return json({ refreshed: true, batchLimit: OUTCOME_POLICY.refreshBatch })
    }
    const snapshot = verifyOutcomeReceipt(body.receipt, user.userId)
    if (!snapshot) return json({ error: 'Valid signed scan with Risk Score ≥50 required. Rescan the token while signed in.' }, 400)
    const { data, error } = await outcomeDb().rpc('create_tracked_outcome', { p_user: user.userId, p_snapshot: snapshot, p_limit: OUTCOME_POLICY.limits[user.plan] })
    if (error) return json({ error: error.message.includes('plan limit') ? 'Your tracked outcome limit has been reached.' : 'Outcome could not be saved. Check storage configuration and migration.' }, error.message.includes('plan limit') ? 409 : 503)
    return json(data)
  } catch { return json({ error: 'Outcome request failed. Please retry.' }, 503) }
}
