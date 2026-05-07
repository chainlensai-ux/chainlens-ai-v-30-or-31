import { NextResponse } from 'next/server'
import { fetchWalletSnapshot } from '@/lib/server/walletSnapshot'
import { getVerifiedUserPlan } from '@/lib/supabase/userSettings'

const WALLET_CACHE_TTL_MS = 3 * 60 * 1000
const walletCache = new Map<string, { exp: number; payload: unknown }>()
const walletRate = new Map<string, { count: number; resetAt: number }>()
const WALLET_RATE_BY_PLAN: Record<string, number> = { free: 20, pro: 60, elite: 180 }

function walletIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

function walletAllowed(plan: 'free' | 'pro' | 'elite', ip: string): boolean {
  const key = `${plan}:${ip}`
  const now = Date.now()
  const cur = walletRate.get(key)
  const lim = WALLET_RATE_BY_PLAN[plan]
  if (!cur || cur.resetAt <= now) { walletRate.set(key, { count: 1, resetAt: now + 60000 }); return true }
  if (cur.count >= lim) return false
  cur.count += 1
  return true
}

export async function POST(req: Request) {
  const isAuthenticated = (req.headers.get('authorization') ?? '').toLowerCase().startsWith('bearer ')
  const plan = isAuthenticated ? await getVerifiedUserPlan(req) : 'free'
  const ip = walletIp(req)

  // Gate authenticated free-tier users — unauthenticated requests fall back to free rate limit
  if (isAuthenticated && plan === 'free') {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[wallet] route=/api/wallet verifiedPlan=free gated=true')
    }
    return NextResponse.json(
      { error: 'Wallet Scanner requires a Pro or Elite plan. Upgrade at /pricing.' },
      { status: 403 }
    )
  }

  if (!walletAllowed(plan, ip)) {
    return NextResponse.json({ error: 'Rate limit reached. Try again shortly.' }, { status: 429 })
  }

  try {
    const { address } = await req.json()
    const key = String(address ?? '').toLowerCase()
    const cached = walletCache.get(key)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)
    const snapshot = await fetchWalletSnapshot(address ?? '')
    walletCache.set(key, { exp: Date.now() + WALLET_CACHE_TTL_MS, payload: snapshot })
    return NextResponse.json(snapshot)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Wallet scan failed'
    const status = msg === 'Invalid wallet address' ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
