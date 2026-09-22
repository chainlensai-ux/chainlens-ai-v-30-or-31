import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { OUTCOME_POLICY, liveOutcomeRequestIds } from '@/lib/tokenOutcomes'
import { verifyOutcomeReceipt } from '@/lib/server/tokenOutcomeReceipt'
import { outcomeDb, refreshOutcomes, refreshLiveOutcomes, sanitizeTrackedOutcome, listTrackedOutcomes, logOutcomeStorageError, sanitizeOutcomeStorageError, logTrackedOutcomeLiveBatch } from '@/lib/server/tokenOutcomeService'
import { createRateLimiter } from '@/lib/server/rateLimit'

export const runtime = 'nodejs'
export const maxDuration = 60
const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const OUTCOME_ID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
export async function GET(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (id) {
      if (!OUTCOME_ID_RE.test(id)) return json({ error: 'Invalid outcome ID.' }, 400)
      const { data, error } = await outcomeDb().from('tracked_token_outcomes').select('*').eq('user_id', user.userId).eq('id', id).maybeSingle()
      if (error) {
        logOutcomeStorageError('get_receipt', error)
        return json({ error: 'Unable to load the frozen receipt.', code: sanitizeOutcomeStorageError(error).code }, 503)
      }
      if (!data) return json({ error: 'Outcome not found.' }, 404)
      return json({ outcome: sanitizeTrackedOutcome(data) })
    }
    // Keep the list small even for Elite. Full immutable evidence loads on receipt open only.
    const outcomes = await listTrackedOutcomes(user.userId)
    return json({ outcomes, limit: OUTCOME_POLICY.limits[user.plan] })
  } catch (error) {
    logOutcomeStorageError('GET', error)
    const { code } = sanitizeOutcomeStorageError(error)
    return json({ error: 'Outcome storage is not configured or reachable.', code }, 503)
  }
}
export async function POST(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(user.userId)) return json({ error: 'Too many outcome requests. Try again in a minute.' }, 429)
  try {
    const bodyText = await req.text()
    if (bodyText.length > 182_000) return json({ error: 'Outcome receipt too large.' }, 413)
    let body: { action?: string; receipt?: unknown; force?: unknown; ids?: unknown; id?: unknown; batchId?: unknown }
    try { body = JSON.parse(bodyText) } catch { return json({ error: 'Invalid request.' }, 400) }
    if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400)
    if (body.action === 'live') {
      const ids = liveOutcomeRequestIds(body.ids, body.id)
      const batchId = typeof body.batchId === 'string' && body.batchId.length <= 64 ? body.batchId : null
      const startedAt = Date.now()
      if (!ids.length) return json({ error: 'Invalid outcome ID.' }, 400)
      const { outcomes, attempted, providerCalls, refreshedIds, failedIds, rejectionReasons, observationTimestamps } = await refreshLiveOutcomes(user.userId, ids)
      const finishedAt = Date.now()
      const notFound = !outcomes.length && attempted.length <= 1
      // BOUNDED DIAGNOSTIC, DISCLOSED: one line per live batch, server-observable fields only —
      // see logTrackedOutcomeLiveBatch's own header for why merge/scheduling fields are the
      // client's job, not this route's.
      logTrackedOutcomeLiveBatch({
        batchId, selectedIds: ids, startedAt, finishedAt, httpStatus: notFound ? 404 : 200,
        providerCalls, refreshedIds, failedIds, rejectionReasons, observationTimestamps,
      })
      if (notFound) return json({ error: 'Outcome not found.' }, 404)
      return json({
        live: true, outcome: outcomes[0] ?? null, outcomes, attempted, batchId, startedAt, finishedAt,
        providerCalls, refreshedIds, failedIds, rejectionReasons, observationTimestamps,
      })
    }
    if (body.action === 'refresh') {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : undefined
      const outcomes = await refreshOutcomes(user.userId, { force: body.force === true, ids })
      return json({ refreshed: true, batchLimit: OUTCOME_POLICY.refreshBatch, force: body.force === true, outcomes, limit: OUTCOME_POLICY.limits[user.plan] })
    }
    const snapshot = verifyOutcomeReceipt(body.receipt, user.userId)
    if (!snapshot) return json({ error: 'Valid signed scan with Risk Score ≥50 required. Rescan the token while signed in.' }, 400)
    const { data, error } = await outcomeDb().rpc('create_tracked_outcome', { p_user: user.userId, p_snapshot: snapshot, p_limit: OUTCOME_POLICY.limits[user.plan] })
    if (error) return json({ error: error.message.includes('plan limit') ? 'Your tracked outcome limit has been reached.' : 'Outcome could not be saved. Check storage configuration and migration.' }, error.message.includes('plan limit') ? 409 : 503)
    return json(data)
  } catch (error) {
    logOutcomeStorageError('POST', error)
    return json({ error: 'Outcome request failed. Please retry.', code: sanitizeOutcomeStorageError(error).code }, 503)
  }
}
export async function DELETE(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  const id = new URL(req.url).searchParams.get('id')
  if (!id || !OUTCOME_ID_RE.test(id)) return json({ error: 'Invalid outcome ID.' }, 400)
  try {
    const { data, error } = await outcomeDb().from('tracked_token_outcomes').delete().eq('id', id).eq('user_id', user.userId).select('id').maybeSingle()
    if (error) {
      logOutcomeStorageError('DELETE', error)
      return json({ error: 'Unable to delete this tracked outcome.', code: sanitizeOutcomeStorageError(error).code }, 503)
    }
    if (!data) return json({ error: 'Outcome not found.' }, 404)
    return json({ deleted: true, id })
  } catch (error) {
    logOutcomeStorageError('DELETE', error)
    return json({ error: 'Outcome storage is not configured or reachable.', code: sanitizeOutcomeStorageError(error).code }, 503)
  }
}
