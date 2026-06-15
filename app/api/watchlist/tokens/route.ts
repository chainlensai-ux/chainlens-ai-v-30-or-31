import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient, createAuthedSupabaseClient } from '@/lib/supabase/userSettings'

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' }
const selectColumns = 'id, chain, token_address, token_symbol, token_name, risk_label, score, created_at, updated_at'

type WatchlistAction = 'get' | 'post' | 'delete'

type AuthResult =
  | { user: { id: string }, userId: string, supabase: NonNullable<ReturnType<typeof createAuthedSupabaseClient>> }
  | { error: string, status: 401 }

async function getAuth(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.toLowerCase().startsWith('bearer ')) return { error: 'Sign in to save tokens.', status: 401 }
  const token = authHeader.slice(7).trim()
  const authSupabase = createAnonSupabaseClient()
  const supabase = createAuthedSupabaseClient(token)
  if (!token || !authSupabase || !supabase) return { error: 'Sign in to save tokens.', status: 401 }
  const { data, error } = await authSupabase.auth.getUser(token)
  if (error || !data.user) return { error: 'Sign in to save tokens.', status: 401 }
  return { user: { id: data.user.id }, userId: data.user.id, supabase }
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null
}

function normalizeChain(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed ? trimmed : null
}

function logWatchlist(action: WatchlistAction, status: 'ok' | 'error', userId: string | undefined, chain: string | null, tokenAddress: string | null, error?: { code?: string, message?: string, details?: string } | null) {
  const payload = {
    action,
    status,
    hasUser: !!userId,
    userId: userId ?? null,
    chain,
    tokenAddress,
    normalizedChain: chain,
    normalizedTokenAddress: tokenAddress,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    errorDetails: error?.details ?? null,
  }
  if (status === 'error') console.error('[watchlist.tokens]', payload)
  else console.log('[watchlist.tokens]', payload)
}

export async function GET(request: NextRequest) {
  const auth = await getAuth(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error, saved: false }, { status: auth.status, headers: noStoreHeaders })
  const chain = normalizeChain(request.nextUrl.searchParams.get('chain'))
  const tokenAddress = normalizeAddress(request.nextUrl.searchParams.get('tokenAddress'))
  let query = auth.supabase.from('token_watchlist').select(selectColumns).eq('user_id', auth.userId).order('updated_at', { ascending: false })
  if (chain) query = query.eq('chain', chain)
  if (tokenAddress) query = query.eq('token_address', tokenAddress)
  const { data, error } = await query
  if (error) {
    logWatchlist('get', 'error', auth.userId, chain, tokenAddress, error)
    return NextResponse.json({ error: 'Could not load watchlist.', saved: false }, { status: 500, headers: noStoreHeaders })
  }
  logWatchlist('get', 'ok', auth.userId, chain, tokenAddress)
  const tokens = (data ?? []).map((row) => ({
    id: row.id,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenName: row.token_name,
    riskLabel: row.risk_label,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
  return NextResponse.json({ saved: tokenAddress ? tokens.length > 0 : undefined, tokens }, { headers: noStoreHeaders })
}

export async function POST(request: NextRequest) {
  const auth = await getAuth(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error, saved: false }, { status: auth.status, headers: noStoreHeaders })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const chain = normalizeChain(body?.chain)
  const tokenAddress = normalizeAddress(body?.tokenAddress)
  if (!body?.tokenAddress) return NextResponse.json({ error: 'Token address is required.', saved: false }, { status: 400, headers: noStoreHeaders })
  if (!chain) return NextResponse.json({ error: 'Chain is required.', saved: false }, { status: 400, headers: noStoreHeaders })
  if (!tokenAddress) return NextResponse.json({ error: 'Token address is invalid.', saved: false }, { status: 400, headers: noStoreHeaders })
  const score = typeof body?.score === 'number' && Number.isFinite(body.score) ? body.score : null
  const payload = {
    user_id: auth.user.id,
    chain: chain.toLowerCase(),
    token_address: tokenAddress.toLowerCase(),
    token_symbol: typeof body?.tokenSymbol === 'string' ? body.tokenSymbol.slice(0, 64) : null,
    token_name: typeof body?.tokenName === 'string' ? body.tokenName.slice(0, 160) : null,
    risk_label: typeof body?.riskLabel === 'string' ? body.riskLabel.slice(0, 64) : null,
    score,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await auth.supabase.from('token_watchlist').upsert(payload, { onConflict: 'user_id,chain,token_address' }).select(selectColumns).single()
  if (error) {
    logWatchlist('post', 'error', auth.userId, payload.chain, payload.token_address, error)
    return NextResponse.json({ error: 'Could not save token. Watchlist setup may be incomplete.', saved: false }, { status: 500, headers: noStoreHeaders })
  }
  logWatchlist('post', 'ok', auth.userId, payload.chain, payload.token_address)
  return NextResponse.json({ saved: true, token: data }, { headers: noStoreHeaders })
}

export async function DELETE(request: NextRequest) {
  const auth = await getAuth(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error, saved: false }, { status: auth.status, headers: noStoreHeaders })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const chain = normalizeChain(body?.chain)
  const tokenAddress = normalizeAddress(body?.tokenAddress)
  if (!body?.tokenAddress) return NextResponse.json({ error: 'Token address is required.', saved: false }, { status: 400, headers: noStoreHeaders })
  if (!chain) return NextResponse.json({ error: 'Chain is required.', saved: false }, { status: 400, headers: noStoreHeaders })
  if (!tokenAddress) return NextResponse.json({ error: 'Token address is invalid.', saved: false }, { status: 400, headers: noStoreHeaders })
  const { error } = await auth.supabase.from('token_watchlist').delete().eq('user_id', auth.userId).eq('chain', chain).eq('token_address', tokenAddress)
  if (error) {
    logWatchlist('delete', 'error', auth.userId, chain, tokenAddress, error)
    return NextResponse.json({ error: 'Could not save token. Watchlist setup may be incomplete.', saved: false }, { status: 500, headers: noStoreHeaders })
  }
  logWatchlist('delete', 'ok', auth.userId, chain, tokenAddress)
  return NextResponse.json({ saved: false }, { headers: noStoreHeaders })
}
