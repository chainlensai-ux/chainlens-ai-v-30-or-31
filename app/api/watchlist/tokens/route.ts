import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { isValidAddress, isAllowedChain, isValidLabel } from '@/lib/server/watchlistValidation'
import { isValidSolanaMintAddress } from '@/lib/solanaAddress'
import { normalizeRiskScore } from '@/lib/riskScoreDirection'

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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
  const rows = (data ?? []) as Array<Record<string, unknown>>
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

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!writeLimiter.check(userId)) {
    return NextResponse.json({ error: 'Too many watchlist writes. Try again shortly.' }, { status: 429 })
  }

  const body = await req.json().catch(() => null)
  const { address, symbol, name, chain, riskLabel, score, scoreType, scoreDirection } = body ?? {}
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: 'A valid token contract address is required.' }, { status: 400 })
  }
  const chainValue = typeof chain === 'string' ? chain : 'base'
  if (!isAllowedChain(chainValue)) {
    return NextResponse.json({ error: 'Unsupported chain.' }, { status: 400 })
  }
  if (!isValidLabel(symbol)) {
    return NextResponse.json({ error: 'symbol is too long.' }, { status: 400 })
  }
  if (!isValidLabel(name)) {
    return NextResponse.json({ error: 'name is too long.' }, { status: 400 })
  }
  if (scoreType != null && scoreType !== 'risk_score' && scoreType !== 'radar_score' && scoreType !== 'safety_score') {
    return NextResponse.json({ error: 'Unsupported score type.' }, { status: 400 })
  }
  if (scoreDirection != null && scoreDirection !== 'higher_is_riskier' && scoreDirection !== 'higher_is_safer') {
    return NextResponse.json({ error: 'Unsupported score direction.' }, { status: 400 })
  }
  if (score != null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)) {
    return NextResponse.json({ error: 'Score must be between 0 and 100.' }, { status: 400 })
  }
  if (scoreType === 'risk_score' && scoreDirection !== 'higher_is_riskier') {
    return NextResponse.json({ error: 'Risk Score direction must be higher_is_riskier.' }, { status: 400 })
  }
  if (scoreType === 'safety_score' && scoreDirection !== 'higher_is_safer') {
    return NextResponse.json({ error: 'Safety Score direction must be higher_is_safer.' }, { status: 400 })
  }

  const canonicalWatchlistRisk = scoreType === 'risk_score' || scoreType === 'safety_score'
    ? normalizeRiskScore({ rawScore: score, rawScoreType: scoreType, source: 'watchlist_api', displayLocation: 'watchlist_storage' })
    : null
  const storedScore = canonicalWatchlistRisk?.riskScore0To100 ?? score ?? null
  const storedRiskLabel = canonicalWatchlistRisk?.riskLabel ?? riskLabel ?? null
  const storedScoreType = canonicalWatchlistRisk ? 'risk_score' : scoreType ?? null
  const storedScoreDirection = canonicalWatchlistRisk ? 'higher_is_riskier' : scoreDirection ?? null

  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const watchlistRow = {
    user_id: userId,
    address: normalizeWatchlistAddress(address),
    symbol: symbol ?? null,
    name: name ?? null,
    chain: chainValue,
    risk_label: storedRiskLabel,
    score: storedScore,
    score_type: storedScoreType,
    score_direction: storedScoreDirection,
    saved_at: new Date().toISOString(),
  }
  let { data, error } = await db
    .from('watchlist_tokens')
    .upsert(watchlistRow, { onConflict: 'user_id,address,chain' })
    .select()
    .single()

  // Rollout compatibility: if the optional score metadata columns have not reached the live table
  // yet, preserve direction in an explicit label prefix. Untyped historical rows remain untrusted.
  if (error && /score_type|score_direction/i.test(error.message)) {
    const legacyRow = {
      user_id: watchlistRow.user_id,
      address: watchlistRow.address,
      symbol: watchlistRow.symbol,
      name: watchlistRow.name,
      chain: watchlistRow.chain,
      risk_label: watchlistRow.risk_label,
      score: watchlistRow.score,
      saved_at: watchlistRow.saved_at,
    }
    const fallbackRow = storedScoreType === 'risk_score' && storedRiskLabel
      ? { ...legacyRow, risk_label: `risk_score:${storedRiskLabel}` }
      : legacyRow
    const fallback = await db
      .from('watchlist_tokens')
      .upsert(fallbackRow, { onConflict: 'user_id,address,chain' })
      .select()
      .single()
    data = fallback.data
    error = fallback.error
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ token: data })
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

  const { error } = await db
    .from('watchlist_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('address', normalizeWatchlistAddress(address))
    .eq('chain', chainParam)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
