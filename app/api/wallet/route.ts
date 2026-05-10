import { NextResponse } from 'next/server'
import { fetchWalletSnapshot } from '@/lib/server/walletSnapshot'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

const WALLET_CACHE_TTL_MS = 3 * 60 * 1000
const walletCache = new Map<string, { exp: number; payload: unknown }>()
const walletRate = new Map<string, { count: number; resetAt: number }>()
const WALLET_RATE_BY_PLAN: Record<string, number> = { free: 20, pro: 60, elite: 180 }
async function walletPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}
function walletIp(req: Request): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
async function walletAllowed(req: Request): Promise<boolean> { const plan=await walletPlan(req); const key=`${plan}:${walletIp(req)}`; const now=Date.now(); const cur=walletRate.get(key); const lim=WALLET_RATE_BY_PLAN[plan]; if(!cur||cur.resetAt<=now){walletRate.set(key,{count:1,resetAt:now+60000}); return true} if(cur.count>=lim)return false; cur.count+=1; return true }

export async function POST(req: Request) {
  const plan = await walletPlan(req)
  if (plan === 'free') return NextResponse.json({ error: 'Included in Pro and Elite.' }, { status: 403 })
  if (!(await walletAllowed(req))) return NextResponse.json({ error: "Rate limit reached. Try again shortly." }, { status: 429 })
  try {
    const requestUrl = new URL(req.url)
    const body = await req.json()
    const address = body?.address
    const debugFresh = requestUrl.searchParams.get('debugFresh') === 'true' || body?.debugFresh === true || body?.debugFresh === 'true'
    const hasBearerToken = (req.headers.get('authorization') ?? '').startsWith('Bearer ')
    const allowDebugFresh = debugFresh && (process.env.NODE_ENV !== 'production' || hasBearerToken)
    const key = String(address ?? '').toLowerCase()
    const cached = allowDebugFresh ? null : walletCache.get(key)
    if (cached && cached.exp > Date.now()) {
      const cp: any = typeof cached.payload === 'object' && cached.payload ? { ...(cached.payload as any) } : cached.payload
      if (cp && typeof cp === 'object') {
        cp._diagnostics = { ...(cp._diagnostics ?? {}), providers: { ...((cp._diagnostics ?? {}).providers ?? {}), cacheHit: true } }
      }
      return NextResponse.json(cp)
    }
    const snapshot = await fetchWalletSnapshot(address ?? '')
    ;(snapshot as any)._diagnostics = { ...((snapshot as any)._diagnostics ?? {}), providers: { ...(((snapshot as any)._diagnostics ?? {}).providers ?? {}), cacheHit: false } }
    if (!allowDebugFresh) walletCache.set(key, { exp: Date.now() + WALLET_CACHE_TTL_MS, payload: snapshot })
    return NextResponse.json(snapshot)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Wallet scan failed'
    const status = msg === 'Invalid wallet address' ? 400 : 500
    return NextResponse.json({ error: status === 400 ? 'Invalid wallet address' : 'Wallet scan unavailable right now.' }, { status })
  }
}
