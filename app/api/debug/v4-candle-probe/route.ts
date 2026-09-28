// GET /api/debug/v4-candle-probe — TEMPORARY, Preview-only "TEST V4 CANDLES" diagnostic behind the
// Token Scanner CANDLE DEBUG panel (see lib/server/v4CandleProbe.ts). Plain 404 outside Vercel
// Preview or without debug=1; requires a signed-in user; rate limited; at most 2 provider calls per
// request (one CoinGecko on-chain, one GeckoTerminal). Returns summary numbers only — never the
// CoinGecko key, request headers, raw provider bodies or auth data.
import { NextResponse } from 'next/server'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { coingeckoOnchainNetwork, fetchCoingeckoOnchainPoolOhlcv, isCoingeckoOnchainConfigured } from '@/lib/server/coingeckoOnchainOhlcv'
import { V4_PROBE_REQUEST, geckoTerminalProbePath, parseV4ProbeInput, runV4CandleProbe, type ProviderFetch } from '@/lib/server/v4CandleProbe'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
const notAvailable = () => new Response('Not available', { status: 404 })

const fetchGeckoTerminal: ProviderFetch = async (input) => {
  const base = (process.env.GECKO_BASE_URL ?? 'https://api.geckoterminal.com').replace(/\/$/, '')
  try {
    const res = await fetch(`${base}${geckoTerminalProbePath(input)}`, { headers: { Accept: 'application/json;version=20230302' }, cache: 'no-store', signal: AbortSignal.timeout(6000) })
    return { json: res.ok ? await res.json().catch(() => null) : null, httpStatus: res.status }
  } catch {
    return { json: null, httpStatus: null }
  }
}

export async function GET(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview') return notAvailable()
  const url = new URL(req.url)
  if (url.searchParams.get('debug') !== '1') return notAvailable()
  const user = await requireAuthenticatedUser(req)
  if (!user) return unauthorizedResponse()
  if (!limiter.check(`v4probe:${user.userId}`)) return NextResponse.json({ ok: false, error: 'rate limit (5/min)' }, { status: 429 })
  const input = parseV4ProbeInput(url.searchParams)
  if ('error' in input) return NextResponse.json({ ok: false, error: input.error }, { status: 400 })

  const coingeckoSkipReason = !isCoingeckoOnchainConfigured() ? 'coingecko_key_not_configured' : !coingeckoOnchainNetwork(input.chain) ? 'network_not_routed_to_coingecko' : undefined
  const result = await runV4CandleProbe(input, {
    coingecko: coingeckoSkipReason ? null : (i) => fetchCoingeckoOnchainPoolOhlcv(i.chain, i.pool, V4_PROBE_REQUEST, i.side),
    coingeckoSkipReason,
    geckoterminal: fetchGeckoTerminal,
  })
  return NextResponse.json({ ok: true, ...result }, { status: 200 })
}
