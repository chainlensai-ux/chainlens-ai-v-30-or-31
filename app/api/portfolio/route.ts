import { NextResponse } from 'next/server'

// V1 ENGINE DISABLED: this route previously called fetchWalletSnapshot()
// (lib/server/walletSnapshot.ts) directly. Per an explicit, confirmed request to cut V1 CU usage
// ahead of a V2 integration that hasn't landed yet, that call — and the import itself, so no V1
// code path can execute from this file — has been removed. This route now always returns
// { ok: false, error: "V1 engine disabled" }. walletSnapshot.ts itself is untouched (not deleted).
const PORTFOLIO_CACHE_TTL_MS = 3 * 60 * 1000
const portfolioCache = new Map<string, { exp: number; payload: unknown; cachedAt: number }>()
const portfolioRate = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_PER_MIN = 12

function ipOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

export async function POST(req: Request) {
  try {
    const ip = ipOf(req)
    const now = Date.now()
    const cur = portfolioRate.get(ip)
    if (!cur || cur.resetAt <= now) {
      portfolioRate.set(ip, { count: 1, resetAt: now + 60_000 })
    } else {
      if (cur.count >= RATE_LIMIT_PER_MIN) {
        return NextResponse.json({ error: 'Too many portfolio scans. Please try again shortly.' }, { status: 429 })
      }
      cur.count += 1
    }

    const body = await req.json() as { address?: string; refresh?: boolean }
    const address = String(body.address ?? '').trim().toLowerCase()
    if (!address) return NextResponse.json({ error: 'Wallet address required.' }, { status: 400 })
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return NextResponse.json({ error: 'Invalid wallet address.' }, { status: 400 })
    const refresh = body.refresh === true
    const cached = refresh ? null : portfolioCache.get(address)
    if (cached && cached.exp > Date.now()) {
      const cacheAgeSeconds = Math.floor((Date.now() - cached.cachedAt) / 1000)
      const cp = typeof cached.payload === 'object' && cached.payload
        ? { ...(cached.payload as Record<string, unknown>), dataFreshness: 'cached', cacheAgeSeconds }
        : cached.payload
      return NextResponse.json(cp)
    }
    return NextResponse.json({ ok: false, error: 'V1 engine disabled' })
  } catch {
    return NextResponse.json({ error: 'Portfolio data is currently unavailable.' }, { status: 200 })
  }
}
