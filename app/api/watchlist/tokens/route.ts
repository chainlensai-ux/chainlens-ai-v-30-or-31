import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { isValidAddress, isAllowedChain, isValidLabel } from '@/lib/server/watchlistValidation'

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
    .map((row) => {
      const address = (row.address ?? row.contract_address) as string | null | undefined
      if (typeof address !== 'string' || !address) return null
      return { ...row, address }
    })
    .filter((row): row is Record<string, unknown> & { address: string } => row != null)
  return NextResponse.json({ tokens })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!writeLimiter.check(userId)) {
    return NextResponse.json({ error: 'Too many watchlist writes. Try again shortly.' }, { status: 429 })
  }

  const body = await req.json().catch(() => null)
  const { address, symbol, name, chain, riskLabel, score } = body ?? {}
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

  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const { data, error } = await db
    .from('watchlist_tokens')
    .upsert({
      user_id: userId,
      address: address.toLowerCase(),
      symbol: symbol ?? null,
      name: name ?? null,
      chain: chainValue,
      risk_label: riskLabel ?? null,
      score: score ?? null,
      saved_at: new Date().toISOString(),
    }, { onConflict: 'user_id,address,chain' })
    .select()
    .single()

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
    .eq('address', address.toLowerCase())
    .eq('chain', chainParam)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
