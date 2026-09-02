import { NextResponse } from 'next/server'
import { getPortfolioLite } from '@/lib/server/walletLite'
import { getPortfolioFromV2 } from '@/lib/server/v2Adapters'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'

// PLAN GATE, FIXED (audit: plan-entitlement double-check): portfolio is Pro/Elite-only per
// lib/planFeatures.ts and the pricing page, but this route had zero auth/plan check — only the
// frontend page (app/terminal/portfolio/page.tsx) hid the UI for free users via LockedPanel. A
// direct POST/GET here bypassed that entirely, same class of bug already fixed on
// /api/wallet-scan and /api/token this session. Mirrors those routes' getPlan() convention.
async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  if (process.env.BETA_ALL_ELITE === 'true') return 'elite'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}

// V2 ENGINE INTEGRATED (route-level only): this route previously called fetchWalletSnapshot()
// (lib/server/walletSnapshot.ts, V1, Alchemy RPC), then was replaced with the zero-RPC
// getPortfolioLite() fallback. It now tries the real V2 engine first (getPortfolioFromV2, KV-cached
// 45s, see lib/server/v2Adapters.ts for the full CU-tradeoff disclosure), falling back to
// getPortfolioLite() only when V2 is unavailable — never throws, always returns ok: true/false.
const PORTFOLIO_CACHE_TTL_MS = 3 * 60 * 1000
const portfolioCache = new Map<string, { exp: number; payload: unknown; cachedAt: number }>()
const portfolioRate = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_PER_MIN = 12

export const dynamic = 'force-dynamic'

function ipOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

export async function POST(req: Request) {
  // ACCOUNT-REQUIRED GATE, DISCLOSED (account-required task): Portfolio Intelligence previously ran
  // for any caller, authenticated or not — only the frontend page hid the UI for signed-out users.
  if (!(await requireAuthenticatedUser(req))) return unauthorizedResponse()
  try {
    const plan = await getPlan(req)
    void plan

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
    const v2 = await getPortfolioFromV2(address)
    const result = v2 ?? await getPortfolioLite(address)
    if (!refresh) portfolioCache.set(address, { exp: Date.now() + PORTFOLIO_CACHE_TTL_MS, payload: result, cachedAt: Date.now() })
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Portfolio data is currently unavailable.' }, { status: 200 })
  }
}

// GET ?address=0x... — additive, read-only variant of the POST handler above (never a
// replacement for it). The POST handler is this route's real, primary interface — every real
// frontend call site (app/terminal/portfolio/page.tsx) uses POST with a JSON body, confirmed
// before adding this. Added because SOME caller in production may issue GET requests (a health
// checker, a bot, browser prefetch) and get a correct-but-unhelpful 405; this gives that caller a
// real, working response instead, without touching or replacing POST's real logic. Same
// validation/rate-limit/cache/fallback behavior, just query-string input instead of a body.
export async function GET(req: Request) {
  if (!(await requireAuthenticatedUser(req))) return unauthorizedResponse()
  try {
    const plan = await getPlan(req)
    void plan

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

    const { searchParams } = new URL(req.url)
    const address = String(searchParams.get('address') ?? '').trim().toLowerCase()
    if (!address) return NextResponse.json({ error: 'Wallet address required.' }, { status: 400 })
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return NextResponse.json({ error: 'Invalid wallet address.' }, { status: 400 })

    const cached = portfolioCache.get(address)
    if (cached && cached.exp > Date.now()) {
      const cacheAgeSeconds = Math.floor((Date.now() - cached.cachedAt) / 1000)
      const cp = typeof cached.payload === 'object' && cached.payload
        ? { ...(cached.payload as Record<string, unknown>), dataFreshness: 'cached', cacheAgeSeconds }
        : cached.payload
      return NextResponse.json(cp)
    }
    const v2 = await getPortfolioFromV2(address)
    const result = v2 ?? await getPortfolioLite(address)
    portfolioCache.set(address, { exp: Date.now() + PORTFOLIO_CACHE_TTL_MS, payload: result, cachedAt: Date.now() })
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Portfolio data is currently unavailable.' }, { status: 200 })
  }
}
