import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { isValidAddress, isValidLabel } from '@/lib/server/watchlistValidation'

// HARDENING, DISCLOSED (security hardening pass): same fix as watchlist/tokens/route.ts — no
// rate limit and no address format validation on watchlist writes previously. Rate-limited per
// user (this route is already auth-gated).
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
  if (!db) return NextResponse.json({ wallets: [] })

  const { data, error } = await db
    .from('watchlist_wallets')
    .select('*')
    .eq('user_id', userId)
    .order('saved_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ wallets: data ?? [] })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!writeLimiter.check(userId)) {
    return NextResponse.json({ error: 'Too many watchlist writes. Try again shortly.' }, { status: 429 })
  }

  const body = await req.json().catch(() => null)
  // KEY-NAME FIX, DISCLOSED (wallet watchlist audit): the frontend (app/terminal/wallet-scanner/
  // page.tsx's handleAddWalletToWatchlist) has only ever sent `portfolio_value` (snake_case,
  // matching the DB column) — this destructured a different, never-sent `portfolioValue` key, so
  // every save silently stored null regardless of the real scanned value. Reads both spellings so
  // any other caller sending the camelCase form (there is none today) keeps working too.
  const { address, label, portfolio_value, portfolioValue: portfolioValueCamel, chain_mode, chainMode: chainModeCamel, source } = body ?? {}
  const portfolioValue = typeof (portfolio_value ?? portfolioValueCamel) === 'number' && Number.isFinite(portfolio_value ?? portfolioValueCamel)
    ? Number(portfolio_value ?? portfolioValueCamel)
    : null
  const chainMode = chain_mode ?? chainModeCamel
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: 'A valid wallet address is required.' }, { status: 400 })
  }
  if (!isValidLabel(label)) {
    return NextResponse.json({ error: 'label is too long.' }, { status: 400 })
  }

  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const normalizedAddress = address.toLowerCase()

  const { data: existing, error: lookupError } = await db
    .from('watchlist_wallets')
    .select('id, portfolio_value')
    .eq('user_id', userId)
    .eq('address', normalizedAddress)
    .maybeSingle()

  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 })

  if (existing) {
    // RE-SAVE UPDATES USD, DISCLOSED (reported live: a ~$150k wallet stayed stored as ~$20k
    // because alreadyExists returned the stale row and never wrote the new merged total). A
    // re-save of the same wallet refreshes portfolio_value in USD — never a token count.
    if (portfolioValue != null && portfolioValue !== existing.portfolio_value) {
      const { data, error } = await db
        .from('watchlist_wallets')
        .update({ portfolio_value: portfolioValue })
        .eq('id', existing.id)
        .select()
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ wallet: data, alreadyExists: true, updated: true })
    }
    return NextResponse.json({ wallet: existing, alreadyExists: true })
  }

  const { data, error } = await db
    .from('watchlist_wallets')
    .insert({
      user_id: userId,
      address: normalizedAddress,
      label: label ?? null,
      portfolio_value: portfolioValue,
      chain_mode: chainMode ?? null,
      source: source ?? 'wallet-scanner',
      saved_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ wallet: data, alreadyExists: false })
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
    return NextResponse.json({ error: 'A valid wallet address is required.' }, { status: 400 })
  }

  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const { error } = await db
    .from('watchlist_wallets')
    .delete()
    .eq('user_id', userId)
    .eq('address', address.toLowerCase())

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
