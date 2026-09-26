// GET /api/debug/coingecko-onchain-probe — admin-only, read-only capability probe (see
// lib/server/coingeckoOnchainProbe.ts). Same gate as the other debug routes: Bearer ADMIN_SECRET,
// plain 404 otherwise. One upstream request per call; the API key is never returned.
import { NextResponse } from 'next/server'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { parseProbeInput, runCoingeckoOnchainProbe, type ProbeFetch } from '@/lib/server/coingeckoOnchainProbe'

export const dynamic = 'force-dynamic'
// Explicit, matching the other Node-only debug/admin routes in this app (e.g.
// app/api/wallet-scan/route.ts, app/api/token/quota/route.ts) — removes any ambiguity in how the
// build/deploy pipeline infers the function runtime for this brand-new route.
export const runtime = 'nodejs'

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })

function isAllowed(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return Boolean(process.env.ADMIN_SECRET) && token === process.env.ADMIN_SECRET
}

export async function GET(req: Request) {
  if (!isAllowed(req)) return new Response('Not available', { status: 404 })
  if (!limiter.check('probe')) return NextResponse.json({ ok: false, error: 'probe rate limit (5/min)' }, { status: 429 })
  const input = parseProbeInput(new URL(req.url).searchParams)
  if ('error' in input) return NextResponse.json({ ok: false, error: input.error }, { status: 400 })
  const fetchImpl: ProbeFetch = (url, init) => fetch(url, { headers: init.headers, cache: 'no-store', signal: AbortSignal.timeout(8000) })
  const result = await runCoingeckoOnchainProbe(input, process.env.COINGECKO_API_KEY ?? null, fetchImpl)
  // Build marker, DISCLOSED: bumped whenever this file's deployed behavior changes, purely so a
  // fresh curl can confirm the response body itself comes from THIS build (never a stale cached
  // deployment) rather than trusting the platform's "Ready" status alone.
  return NextResponse.json({ probeRouteBuild: 2, ...result }, { status: 200 })
}
