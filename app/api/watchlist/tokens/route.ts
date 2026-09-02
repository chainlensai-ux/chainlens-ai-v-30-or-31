import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter } from '@/lib/server/rateLimit'
import {
  isValidAddress, isAllowedChain, isValidLabel, watchlistTokenUpsertAttempts, isRetryableWatchlistSchemaError, watchlistTokenDeleteAttempts,
  chainIdForSlug, chainIdMatchesSlug, emptyWatchlistSaveAudit, logWatchlistSaveAudit, isLikelyRlsRejection,
  WATCHLIST_SAVE_CLIENT_MESSAGE,
  type WatchlistSaveReason,
} from '@/lib/server/watchlistValidation'
import { isValidSolanaMintAddress } from '@/lib/solanaAddress'
import { normalizeRiskScore } from '@/lib/riskScoreDirection'
import { getVerifiedUserPlan } from '@/lib/supabase/userSettings'

// SOLANA-CASE-SENSITIVE FIX, DISCLOSED (same repair as the address-validation fix above): a
// Solana base58 mint address is case-sensitive, unlike an EVM 0x address — lowercasing it
// unconditionally (the pre-existing behavior here) silently corrupts it into a different,
// non-existent address. Only ever lowercase the EVM shape.
function normalizeWatchlistAddress(address: string): string {
  return isValidSolanaMintAddress(address as unknown) ? address : address.toLowerCase()
}

// HARDENING, DISCLOSED (security hardening pass): watchlist writes had no rate limit and no
// address/chain format validation — an authenticated caller (or a compromised/scripted session)
// could hammer this endpoint with unbounded upsert calls, or store arbitrary non-address strings
// in the address column. Rate-limited per user (not IP, since this route is already
// auth-gated — a per-user limit targets abuse-by-account directly and doesn't punish users behind
// a shared IP).
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 20 })

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function createAnonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function getUserId(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return null
  const anon = createAnonClient()
  if (!anon) return null
  const { data } = await anon.auth.getUser(token)
  return data.user?.id ?? null
}

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = getServiceClient()
  if (!db) return NextResponse.json({ tokens: [] })

  const { data, error } = await db
    .from('watchlist_tokens')
    .select('*')
    .eq('user_id', userId)
    .order('saved_at', { ascending: false })

  const query = error && isRetryableWatchlistSchemaError(error.message)
    ? await db.from('watchlist_tokens').select('*').eq('user_id', userId)
    : { data, error }

  if (query.error) return NextResponse.json({ error: query.error.message }, { status: 500 })
  // NORMALIZE-WATCHLIST-ROW FIX, DISCLOSED: this route's own POST/DELETE below write/read an
  // `address` column, but Token Scanner's "Track This Token" button writes directly to this same
  // table via a separate client-side Supabase insert using `contract_address` instead (see
  // docs/supabase-watchlist-tokens.sql, the actual documented migration for this table — it only
  // ever defines `contract_address`, never `address`). Whichever field name the live table
  // ultimately has, a row saved through one path came back with the other field undefined when
  // read here — and Base Radar's isWatched() called `.toLowerCase()` on it with no null check,
  // crashing the entire page on load (reported: "This page couldn't load" + a real browser
  // console TypeError on that exact line). Normalizing to a single `address` field here, with a
  // fallback to `contract_address`, fixes it for every consumer of this endpoint without needing
  // to know which column the live table actually has. Rows with neither are dropped rather than
  // returned with an empty/fake address.
  const rows = (query.data ?? []) as Array<Record<string, unknown>>
  const tokens = rows
    .flatMap((row) => {
      const address = (row.address ?? row.contract_address) as string | null | undefined
      if (typeof address !== 'string' || !address) return []
      const storedRiskLabel = typeof row.risk_label === 'string' ? row.risk_label : null
      const embeddedRiskType = storedRiskLabel?.startsWith('risk_score:') === true
      return [{
        ...row,
        address,
        risk_label: embeddedRiskType ? storedRiskLabel.slice('risk_score:'.length) : storedRiskLabel,
        score_type: row.score_type ?? (embeddedRiskType ? 'risk_score' : null),
        score_direction: row.score_direction ?? (embeddedRiskType ? 'higher_is_riskier' : null),
      }]
    })
  return NextResponse.json({ tokens })
}

// SAVE-FAILURE DIAGNOSIS, DISCLOSED (Track This Token "Could not save this token" audit): the
// real root cause was NOT the code path the old comment above (WATCHLIST-ENDPOINT-MISMATCH FIX)
// already fixed. It was the live table's ONLY real unique index —
// `(user_id, lower(contract_address))`, no chain, a functional/expression index — which does not
// satisfy any of the (then only) three onConflict targets this route tried
// (`user_id,address,chain` / `user_id,contract_address,chain` / `user_id,contract_address`).
// Every save failed all of them with "no unique or exclusion constraint matching the ON CONFLICT
// specification" before falling through to the plain-insert fallback below — 6+ wasted
// round-trips on every single write, non-migrated or not, and a genuine risk of hitting the
// function's execution-time budget under load. Two further, separate real bugs alongside that:
// (1) the fallback UPDATE on a "duplicate" error was never chain-scoped
// (`.eq('user_id',...).eq('contract_address',...)` only) — the same 0x address tracked on two
// different chains would silently overwrite each other's row instead of saving separately,
// exactly the opposite of the "same address on different chains is a different token" rule this
// codebase enforces everywhere else (see the chain-strict DELETE below). (2) every failure mode
// (unauthenticated, already-tracked, a real db error) collapsed to the same generic client
// message, so the UI could never distinguish "you already saved this" from "this is broken".
//
// Fixed here: an explicit chain-scoped duplicate pre-check (so a repeat click is a fast,
// predictable 200 "already tracked" — never a race through the conflict-guessing cascade), a
// chain_id column carried best-effort (docs/supabase-watchlist-tokens.sql now creates it and the
// real composite index `(user_id, chain, contract_address)` the app actually needs), the
// UPDATE-path chain-scoping bug fixed, and a typed, safe `reason` in every response so the client
// can show the right message instead of one generic string for everything.
export async function POST(req: NextRequest) {
  const audit = emptyWatchlistSaveAudit()

  function fail(status: number, reason: Exclude<WatchlistSaveReason, 'saved'>, message?: string) {
    audit.finalStatus = 'failed'
    audit.finalReason = reason
    logWatchlistSaveAudit(audit)
    return NextResponse.json({ error: message ?? WATCHLIST_SAVE_CLIENT_MESSAGE[reason], reason }, { status })
  }

  const userId = await getUserId(req)
  audit.userIdPresent = Boolean(userId)
  audit.authSessionReady = Boolean(userId)
  if (!userId) return fail(401, 'unauthenticated')

  if (!writeLimiter.check(userId)) {
    return NextResponse.json({ error: 'Too many watchlist writes. Try again shortly.', reason: 'unknown' }, { status: 429 })
  }

  const body = await req.json().catch(() => null)
  const { address, symbol, name, chain, chainId: clientChainId, riskLabel, score, scoreType, scoreDirection } = body ?? {}
  audit.tokenAddress = typeof address === 'string' ? address : null
  audit.symbol = typeof symbol === 'string' ? symbol : null
  audit.name = typeof name === 'string' ? name : null

  if (!isValidAddress(address)) {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'A valid token contract address is required.')
  }
  const chainValue = typeof chain === 'string' ? chain : 'base'
  audit.chainSlug = chainValue
  if (!isAllowedChain(chainValue)) {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'Unsupported chain.')
  }
  // CHAIN-ID SUPPORT, DISCLOSED: a client-supplied chainId only ever CONFIRMS the slug's own
  // well-known id — Robinhood (4663) in particular must never be silently coerced onto another
  // chain's id by a stale/incorrect client value. When omitted, the server derives it from the
  // slug alone, so every existing caller that doesn't send chainId keeps working unchanged.
  if (!chainIdMatchesSlug(clientChainId, chainValue)) {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', `chainId does not match chain "${chainValue}".`)
  }
  const chainId = chainIdForSlug(chainValue)
  audit.chainId = chainId
  if (!isValidLabel(symbol)) {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'symbol is too long.')
  }
  if (!isValidLabel(name)) {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'name is too long.')
  }
  if (scoreType != null && scoreType !== 'risk_score' && scoreType !== 'radar_score' && scoreType !== 'safety_score') {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'Unsupported score type.')
  }
  if (scoreDirection != null && scoreDirection !== 'higher_is_riskier' && scoreDirection !== 'higher_is_safer') {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'Unsupported score direction.')
  }
  if (score != null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)) {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'Score must be between 0 and 100.')
  }
  if (scoreType === 'risk_score' && scoreDirection !== 'higher_is_riskier') {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'Risk Score direction must be higher_is_riskier.')
  }
  if (scoreType === 'safety_score' && scoreDirection !== 'higher_is_safer') {
    audit.payloadValid = false
    return fail(400, 'invalid_payload', 'Safety Score direction must be higher_is_safer.')
  }
  audit.payloadValid = true

  const canonicalWatchlistRisk = scoreType === 'risk_score' || scoreType === 'safety_score'
    ? normalizeRiskScore({ rawScore: score, rawScoreType: scoreType, source: 'watchlist_api', displayLocation: 'watchlist_storage' })
    : null
  const storedScore = canonicalWatchlistRisk?.riskScore0To100 ?? score ?? null
  const storedRiskLabel = canonicalWatchlistRisk?.riskLabel ?? riskLabel ?? null
  const storedScoreType = canonicalWatchlistRisk ? 'risk_score' : scoreType ?? null
  const storedScoreDirection = canonicalWatchlistRisk ? 'higher_is_riskier' : scoreDirection ?? null

  const db = getServiceClient()
  if (!db) return fail(503, 'db_error', 'Service unavailable')

  const normalizedAddress = normalizeWatchlistAddress(address)

  // PLAN CONTEXT, DISCLOSED: the pricing page advertises "Watchlist — full access" on every plan
  // (free/pro/elite alike) — there is no plan-based watchlist limit today. `plan` is still
  // resolved and logged for diagnostic completeness (so a future limit, or a plan-lookup failure,
  // is visible in the audit trail); `limit` stays honestly null rather than inventing a cap that
  // doesn't exist in this product.
  audit.plan = await getVerifiedUserPlan(req).catch(() => null)
  audit.limit = null

  // CHAIN-SCOPED DUPLICATE PRE-CHECK, DISCLOSED: resolves "already tracked" as a fast, predictable
  // 200 before ever touching the onConflict-guessing cascade below, and is itself resilient to
  // which address column the live table actually has (same retry pattern as everywhere else in
  // this route). Scoped by chain so the same 0x address on two different chains is never treated
  // as the same saved token.
  let existing: Record<string, unknown> | null = null
  for (const column of ['contract_address', 'address'] as const) {
    const result = await db
      .from('watchlist_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq(column, normalizedAddress)
      .eq('chain', chainValue)
      .maybeSingle()
    if (!result.error) { existing = result.data as Record<string, unknown> | null; break }
    if (!isRetryableWatchlistSchemaError(result.error.message)) break
  }

  const savedCountResult = await db
    .from('watchlist_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .then((r) => r, () => ({ count: null, error: null }))
  audit.currentSavedCount = savedCountResult.count ?? null

  if (existing) {
    audit.duplicateDetected = true
    audit.finalStatus = 'duplicate'
    audit.finalReason = 'duplicate'
    logWatchlistSaveAudit(audit)
    return NextResponse.json({ token: existing, duplicate: true, reason: 'duplicate' as const })
  }

  const writeFields = {
    user_id: userId,
    address: normalizedAddress,
    symbol: symbol ?? null,
    name: name ?? null,
    chain: chainValue,
    chainId,
    risk_label: storedRiskLabel,
    score: storedScore,
    score_type: storedScoreType,
    score_direction: storedScoreDirection,
    saved_at: new Date().toISOString(),
  }

  let data: Record<string, unknown> | null = null
  let error: { message: string; code?: string } | null = null
  audit.supabaseInsertAttempted = true
  for (const attempt of watchlistTokenUpsertAttempts(writeFields)) {
    const result = await db
      .from('watchlist_tokens')
      .upsert(attempt.row, { onConflict: attempt.onConflict })
      .select()
      .single()
    if (!result.error) {
      data = result.data as Record<string, unknown>
      error = null
      break
    }
    error = result.error
    if (!isRetryableWatchlistSchemaError(result.error.message)) break
  }

  if (error && isRetryableWatchlistSchemaError(error.message)) {
    const insertRow = {
      user_id: userId,
      contract_address: writeFields.address,
      symbol: writeFields.symbol,
      name: writeFields.name,
      chain: writeFields.chain,
      risk_label: writeFields.risk_label,
      score: writeFields.score,
      saved_at: writeFields.saved_at,
    }
    const inserted = await db.from('watchlist_tokens').insert(insertRow).select().single()
    if (!inserted.error) {
      data = inserted.data as Record<string, unknown>
      error = null
    } else if (/duplicate|unique/i.test(inserted.error.message)) {
      // CHAIN-SCOPED UPDATE FIX, DISCLOSED: this used to update by (user_id, contract_address)
      // alone — no chain filter — so a genuinely NEW save on a different chain for an address
      // already tracked elsewhere silently overwrote that other chain's row instead of creating
      // its own. Scoping by chain here matches the pre-check above and the chain-strict DELETE.
      const updated = await db
        .from('watchlist_tokens')
        .update({
          symbol: insertRow.symbol,
          name: insertRow.name,
          chain: insertRow.chain,
          risk_label: insertRow.risk_label,
          score: insertRow.score,
          saved_at: insertRow.saved_at,
        })
        .eq('user_id', userId)
        .eq('contract_address', writeFields.address)
        .eq('chain', writeFields.chain)
        .select()
        .maybeSingle()
      if (!updated.error) {
        data = (updated.data as Record<string, unknown> | null) ?? insertRow
        error = null
      } else {
        error = updated.error
      }
    } else {
      error = inserted.error
    }
  }

  if (error) {
    audit.supabaseErrorCode = error.code ?? null
    audit.supabaseErrorMessage = error.message
    audit.rlsRejected = isLikelyRlsRejection(error.message)
    return fail(500, 'db_error')
  }

  audit.finalStatus = 'saved'
  audit.finalReason = 'saved'
  logWatchlistSaveAudit(audit)
  return NextResponse.json({ token: data, reason: 'saved' as const })
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!writeLimiter.check(userId)) {
    return NextResponse.json({ error: 'Too many watchlist writes. Try again shortly.' }, { status: 429 })
  }

  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: 'A valid token contract address is required.' }, { status: 400 })
  }
  // CHAIN-STRICT DELETE (chain-strictness audit): same address on another chain is a different
  // token — the delete must target the requested chain's row, never all rows for that address.
  const chainParam = searchParams.get('chain') ?? 'base'
  if (!isAllowedChain(chainParam)) {
    return NextResponse.json({ error: 'Unsupported chain.' }, { status: 400 })
  }

  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const normalized = normalizeWatchlistAddress(address)
  let error: { message: string } | null = null
  for (const attempt of watchlistTokenDeleteAttempts(normalized, chainParam)) {
    let q = db.from('watchlist_tokens').delete().eq('user_id', userId).eq(attempt.column, normalized)
    if (attempt.chain) q = q.eq('chain', attempt.chain)
    const result = await q.select('id')
    if (!result.error) {
      error = null
      if ((result.data?.length ?? 0) > 0) break
      continue
    }
    error = result.error
    if (!isRetryableWatchlistSchemaError(result.error.message)) break
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
