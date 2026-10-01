// GET /api/token/chart-candles — on-demand candles for the Token Scanner Price Chart. Same account
// requirement as token scans; nothing here runs during a scan.
//  - timeframe=5m: real 5M candles when a user clicks 5M:
//      * an exact Uniswap V4 PoolId (bytes32) on a V4-configured chain: the pool's own on-chain Swap
//        events, only when every log carries its exact timestamp (lib/server/v4SwapCandlesRpc.ts
//        loadV4SwapFiveMinuteWindow) — never the providers' pool OHLCV, which can't serve a PoolId;
//      * a normal 20-byte pool: the providers' pool OHLCV (lib/server/chartCandlesOnDemand.ts).
//  - timeframe=history: older HOURLY candles when a user selects 1H / 4H / 1D or pans past the
//    oldest loaded candle — `before` cursor in, genuine candles + `hasMore` + next cursor out:
//      * an exact Uniswap V4 PoolId (bytes32): swap-derived (lib/server/v4SwapCandlesRpc.ts
//        loadV4SwapHistoryWindow);
//      * a normal 20-byte pool: the providers' own pool OHLCV for the proven token side
//        (lib/server/chartCandlesOnDemand.ts loadPoolOhlcvHistory);
//      * chain=solana: the mint's exact-case pool on GeckoTerminal (lib/server/solanaChartHistory.ts).
import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { loadOnDemandCandles, loadPoolOhlcvHistory } from '@/lib/server/chartCandlesOnDemand'
import { fetchCoingeckoOnchainPoolOhlcv, isCoingeckoOnchainConfigured } from '@/lib/server/coingeckoOnchainOhlcv'
import { loadV4SwapFiveMinuteWindow, loadV4SwapHistoryWindow, V4_FIVE_MINUTE_NOT_EXACT_MESSAGE, V4_SWAP_CHAIN_CONFIG, type V4FiveMinuteCode } from '@/lib/server/v4SwapCandlesRpc'
import { makeV4FiveMinuteDeps, makeV4HistoryDeps } from '@/lib/server/v4SwapHistoryDeps'
import { buildCoverageMeta } from '@/lib/chartQuality'
import { loadSolanaPoolHistory } from '@/lib/server/solanaChartHistory'
import { candleFailureMessage } from '@/lib/evmChartCandles'

function v4FiveMinuteMessage(code: V4FiveMinuteCode): string {
  if (code === 'v4_timestamps_not_exact') return V4_FIVE_MINUTE_NOT_EXACT_MESSAGE
  if (code === 'invalid_request') return 'The 5M request needs an exact V4 PoolId and token.'
  if (code === 'token_decimals_unavailable') return "the token's decimals could not be read on-chain."
  return candleFailureMessage(code)
}

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
    // Solana: its own exact-case lane (base58 mint + pool, GeckoTerminal hourly, proven side).
    if (chain === 'solana') {
      const { result: h } = await loadSolanaPoolHistory({ mint: token, pool, side: url.searchParams.get('side'), before: Number.isInteger(before) ? before : null }, fetchJson, { baseUrl: process.env.GECKO_BASE_URL })
      if (!h.ok) return NextResponse.json({ ok: false, timeframe: 'history', code: h.code, message: h.message, hasMore: h.hasMore }, { status: h.code === 'invalid_request' ? 400 : 200 })
      return NextResponse.json({ ok: true, timeframe: 'history', intervalSec: h.intervalSec, points: h.points, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec, endReason: h.endReason, windowEndSec: Math.floor(before / 3600) * 3600, source: h.source })
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(pool)) {
      const { result: h } = await loadPoolOhlcvHistory(
        { chain, token, pool, side: url.searchParams.get('side'), before: Number.isInteger(before) ? before : null },
        fetchJson,
        {
          baseUrl: process.env.GECKO_BASE_URL,
          fetchCoingecko: isCoingeckoOnchainConfigured() ? (c, p, r, side, beforeSec) => fetchCoingeckoOnchainPoolOhlcv(c, p, r, side, undefined, beforeSec ?? null) : undefined,
        },
      )
      if (!h.ok) return NextResponse.json({ ok: false, timeframe: 'history', code: h.code, message: h.message, hasMore: h.hasMore }, { status: h.code === 'invalid_request' ? 400 : 200 })
      return NextResponse.json({ ok: true, timeframe: 'history', intervalSec: h.intervalSec, points: h.points, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec, endReason: h.endReason, windowEndSec: Math.floor(before / 3600) * 3600, source: h.source })
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(pool) || !/^0x[a-fA-F0-9]{40}$/.test(token) || !Number.isInteger(before) || before <= 0) {
      return NextResponse.json({ ok: false, timeframe: 'history', code: 'invalid_request', message: 'Older history needs an exact pool, token and cursor.' }, { status: 400 })
    }
    const deps = makeV4HistoryDeps(chain)
    if (!deps) {
      const code = V4_SWAP_CHAIN_CONFIG[chain] ? 'v4_rpc_unavailable' : 'v4_chain_not_supported'
      return NextResponse.json({ ok: false, timeframe: 'history', code, message: candleFailureMessage(code), hasMore: false })
    }
    const h = await loadV4SwapHistoryWindow({ chain, poolId: pool, token, beforeSec: before }, deps)
    if (!h.ok) {
      const message = h.code === 'invalid_request' ? 'Older history request is out of range.' : candleFailureMessage(h.code ?? 'v4_swap_logs_unavailable')
      return NextResponse.json({ ok: false, timeframe: 'history', code: h.code, message, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec }, { status: h.code === 'invalid_request' ? 400 : 200 })
    }
    return NextResponse.json({ ok: true, timeframe: 'history', intervalSec: h.intervalSec, points: h.candles, hasMore: h.hasMore, nextBeforeSec: h.nextBeforeSec, endReason: h.endReason ?? null, windowEndSec: h.windowEndSec, source: 'v4_swap_events' })
  }
  // 5M for an exact Uniswap V4 PoolId on a V4-configured chain: its own Swap events (never provider PoolId OHLCV).
  const fivePool = url.searchParams.get('pool') ?? ''
  const fiveChain = url.searchParams.get('chain') ?? ''
  if (url.searchParams.get('timeframe') === '5m' && /^0x[a-fA-F0-9]{64}$/.test(fivePool) && V4_SWAP_CHAIN_CONFIG[fiveChain]) {
    const deps = makeV4FiveMinuteDeps(fiveChain)
    if (!deps) return NextResponse.json({ ok: false, timeframe: '5m', code: 'v4_rpc_unavailable', message: candleFailureMessage('v4_rpc_unavailable'), source: 'v4_swap_events' })
    const f = await loadV4SwapFiveMinuteWindow({ chain: fiveChain, poolId: fivePool, token: url.searchParams.get('token') ?? '' }, deps)
    if (!f.ok) {
      const code = f.code ?? 'v4_swap_logs_unavailable'
      return NextResponse.json({ ok: false, timeframe: '5m', code, message: v4FiveMinuteMessage(code), timeResolution: f.timeResolution, source: 'v4_swap_events' }, { status: code === 'invalid_request' ? 400 : 200 })
    }
    const coverage = buildCoverageMeta({ requestEndSec: Date.now() / 1000, intervalSec: f.intervalSec, limit: null, points: f.candles, windowSec: f.windowProven ? 24 * 3600 : null, windowProven: f.windowProven })
    return NextResponse.json({ ok: true, timeframe: '5m', intervalSec: f.intervalSec, points: f.candles, coverage, timeResolution: f.timeResolution, source: 'v4_swap_events' })
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
