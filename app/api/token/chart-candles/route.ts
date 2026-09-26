// GET /api/token/chart-candles — on-demand real 5M candles for the Token Scanner Price Chart.
// Called only when a user clicks 5M; see lib/server/chartCandlesOnDemand.ts for the verification,
// caching and provider-call cap. Same account requirement as token scans.
import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { loadOnDemandCandles } from '@/lib/server/chartCandlesOnDemand'

export const dynamic = 'force-dynamic'

// Per user+IP: generous for interactive chip clicks, bounded against loops.
const limiter = createRateLimiter({ windowMs: 60_000, max: 20 })

async function fetchJson(url: string): Promise<{ json: unknown; httpStatus: number | null }> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: AbortSignal.timeout(6000) })
    return { json: res.ok ? await res.json().catch(() => null) : null, httpStatus: res.status }
  } catch {
    return { json: null, httpStatus: null }
  }
}

export async function GET(req: Request) {
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(`${user.userId}:${getClientIp(req)}`)) {
    return NextResponse.json({ ok: false, code: 'provider_rate_limited', message: 'Too many chart requests. Try again shortly.' }, { status: 429 })
  }
  const url = new URL(req.url)
  const { result } = await loadOnDemandCandles(
    {
      chain: url.searchParams.get('chain'),
      token: url.searchParams.get('token'),
      pool: url.searchParams.get('pool'),
      timeframe: url.searchParams.get('timeframe'),
    },
    fetchJson,
    { baseUrl: process.env.GECKO_BASE_URL },
  )
  return NextResponse.json(result, { status: result.ok || result.code !== 'invalid_request' ? 200 : 400 })
}
