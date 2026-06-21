import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

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

  const body = await req.json().catch(() => null)
  const { address, label, portfolioValue, chainMode, source } = body ?? {}
  if (!address || typeof address !== 'string') {
    return NextResponse.json({ error: 'address required' }, { status: 400 })
  }

  const db = getServiceClient()
  if (!db) return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })

  const normalizedAddress = address.toLowerCase()

  const { data: existing, error: lookupError } = await db
    .from('watchlist_wallets')
    .select('id')
    .eq('user_id', userId)
    .eq('address', normalizedAddress)
    .maybeSingle()

  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 })

  if (existing) {
    return NextResponse.json({ wallet: existing, alreadyExists: true })
  }

  const { data, error } = await db
    .from('watchlist_wallets')
    .insert({
      user_id: userId,
      address: normalizedAddress,
      label: label ?? null,
      portfolio_value: typeof portfolioValue === 'number' && Number.isFinite(portfolioValue) ? portfolioValue : null,
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

  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 })

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
