import { NextRequest, NextResponse } from 'next/server'
import { createAnonSupabaseClient, createAuthedSupabaseClient } from '@/lib/supabase/userSettings'

const noStoreHeaders = { 'Cache-Control': 'no-store, max-age=0' }

async function getAuth(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.toLowerCase().startsWith('bearer ')) return { error: 'Unauthorized.', status: 401 as const }
  const token = authHeader.slice(7).trim()
  const authSupabase = createAnonSupabaseClient()
  const supabase = createAuthedSupabaseClient(token)
  if (!token || !authSupabase || !supabase) return { error: 'Unauthorized.', status: 401 as const }
  const { data, error } = await authSupabase.auth.getUser(token)
  if (error || !data.user) return { error: 'Unauthorized.', status: 401 as const }
  return { userId: data.user.id, supabase }
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

export async function GET(request: NextRequest) {
  const auth = await getAuth(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error, saved: false }, { status: auth.status, headers: noStoreHeaders })
  const chain = normalizeChain(request.nextUrl.searchParams.get('chain'))
  const tokenAddress = normalizeAddress(request.nextUrl.searchParams.get('tokenAddress'))
  let query = auth.supabase.from('token_watchlist').select('id, chain, token_address, token_symbol, token_name, risk_label, score, created_at, updated_at').eq('user_id', auth.userId).order('updated_at', { ascending: false })
  if (chain) query = query.eq('chain', chain)
  if (tokenAddress) query = query.eq('token_address', tokenAddress)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: 'Could not load watchlist.', saved: false }, { status: 500, headers: noStoreHeaders })
  return NextResponse.json({ saved: tokenAddress ? (data?.length ?? 0) > 0 : undefined, tokens: data ?? [] }, { headers: noStoreHeaders })
}

export async function POST(request: NextRequest) {
  const auth = await getAuth(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error, saved: false }, { status: auth.status, headers: noStoreHeaders })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const chain = normalizeChain(body?.chain)
  const tokenAddress = normalizeAddress(body?.tokenAddress)
  if (!chain || !tokenAddress) return NextResponse.json({ error: 'Invalid chain or token address.', saved: false }, { status: 400, headers: noStoreHeaders })
  const score = typeof body?.score === 'number' && Number.isFinite(body.score) ? body.score : null
  const payload = {
    user_id: auth.userId,
    chain,
    token_address: tokenAddress,
    token_symbol: typeof body?.tokenSymbol === 'string' ? body.tokenSymbol.slice(0, 64) : null,
    token_name: typeof body?.tokenName === 'string' ? body.tokenName.slice(0, 160) : null,
    risk_label: typeof body?.riskLabel === 'string' ? body.riskLabel.slice(0, 64) : null,
    score,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await auth.supabase.from('token_watchlist').upsert(payload, { onConflict: 'user_id,chain,token_address' }).select('id, chain, token_address, token_symbol, token_name, risk_label, score, created_at, updated_at').single()
  if (error) return NextResponse.json({ error: 'Could not update watchlist.', saved: false }, { status: 500, headers: noStoreHeaders })
  return NextResponse.json({ saved: true, token: data }, { headers: noStoreHeaders })
}

export async function DELETE(request: NextRequest) {
  const auth = await getAuth(request)
  if ('error' in auth) return NextResponse.json({ error: auth.error, saved: false }, { status: auth.status, headers: noStoreHeaders })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const chain = normalizeChain(body?.chain)
  const tokenAddress = normalizeAddress(body?.tokenAddress)
  if (!chain || !tokenAddress) return NextResponse.json({ error: 'Invalid chain or token address.', saved: false }, { status: 400, headers: noStoreHeaders })
  const { error } = await auth.supabase.from('token_watchlist').delete().eq('user_id', auth.userId).eq('chain', chain).eq('token_address', tokenAddress)
  if (error) return NextResponse.json({ error: 'Could not update watchlist.', saved: false }, { status: 500, headers: noStoreHeaders })
  return NextResponse.json({ saved: false }, { headers: noStoreHeaders })
}
