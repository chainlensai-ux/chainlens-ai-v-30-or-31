// GET /api/token/chart-candles — on-demand candles for the Token Scanner Price Chart. Same account
// requirement as token scans; nothing here runs during a scan.
//  - timeframe=5m: real 5M candles when a user clicks 5M (lib/server/chartCandlesOnDemand.ts).
//  - timeframe=history: older hourly candles for an exact Uniswap V4 PoolId when a user selects
//    1H / 4H / 1D or pans past the oldest loaded candle (lib/server/v4SwapCandlesRpc.ts
//    loadV4SwapHistoryWindow): `before` cursor in, genuine swap candles + `hasMore` + next cursor out.
import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { loadOnDemandCandles } from '@/lib/server/chartCandlesOnDemand'
import { fetchCoingeckoOnchainPoolOhlcv, isCoingeckoOnchainConfigured } from '@/lib/server/coingeckoOnchainOhlcv'
import { loadV4SwapHistoryWindow } from '@/lib/server/v4SwapCandlesRpc'
import { makeV4HistoryDeps } from '@/lib/server/v4SwapHistoryDeps'
import { candleFailureMessage } from '@/lib/evmChartCandles'

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
  if (url.searchParams.get('timeframe') === 'history') {
    const chain = url.searchParams.get('chain') ?? ''
    const pool = url.searchParams.get('pool') ?? ''
    const token = url.searchParams.get('token') ?? ''
    const before = Number(url.searchParams.get('before'))
    if (!/^0x[a-fA-F0-9]{64}$/.test(pool) || !/^0x[a-fA-F0-9]{40}$/.test(token) || !Number.isInteger(before) || before <= 0) {
      return NextResponse.json({ ok: false, timeframe: 'history', code: 'invalid_request', message: 'Older history needs an exact V4 pool id, token and cursor.' }, { status: 400 })
    }
    const deps = makeV4HistoryDeps(chain)
    if (!deps) return NextResponse.json({ ok: false, timeframe: 'history', code: 'v4_chain_not_supported', message: candleFailureMessage('v4_chain_not_supported'), hasMore: false })
    const h = await loadV4SwapHistoryWindow({ chain, poolId: pool, token, beforeSec: before }, deps)
    if (!h.ok) {
      const message = h.code === 'invalid_request' ? 'Older history request is out of range.' : candleFailureMessage(h.code ?? 'v4_swap_logs_unavailable')
      return NextResponse.json({ ok: false, timeframe: 'history', code: h.code, message, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec }, { status: h.code === 'invalid_request' ? 400 : 200 })
    }
    return NextResponse.json({ ok: true, timeframe: 'history', intervalSec: h.intervalSec, points: h.candles, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec, windowEndSec: h.windowEndSec, source: 'v4_swap_events' })
  }
  const { result } = await loadOnDemandCandles(
    {
      chain: url.searchParams.get('chain'),
      token: url.searchParams.get('token'),
      pool: url.searchParams.get('pool'),
      timeframe: url.searchParams.get('timeframe'),
    },
    fetchJson,
    {
      baseUrl: process.env.GECKO_BASE_URL,
      // CoinGecko on-chain first (server-side key, never returned); GeckoTerminal only on its failure.
      fetchCoingecko: isCoingeckoOnchainConfigured() ? (chain, pool, req, side) => fetchCoingeckoOnchainPoolOhlcv(chain, pool, req, side) : undefined,
    },
  )
  return NextResponse.json(result, { status: result.ok || result.code !== 'invalid_request' ? 200 : 400 })
}
