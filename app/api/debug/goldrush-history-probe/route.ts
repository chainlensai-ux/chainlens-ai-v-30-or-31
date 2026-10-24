// GET /api/debug/goldrush-history-probe?wallet=0x…&chain=base-mainnet&maxPages=20&secret=<CRON_SECRET>
// One-off diagnostic: how much of a wallet's history GoldRush returns, how fast, and whether it carries
// USD prices and decoded swaps (see lib/server/goldrushHistoryProbe.ts). Gated by the deployment's
// CRON_SECRET (constant-time compare), rate limited, at most maxPages + 3 GoldRush calls per request.
// Returns summary numbers only — never the API key or raw provider bodies.
import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createRateLimiter } from '@/lib/server/rateLimit'
import { parseGoldrushProbeInput, runGoldrushHistoryProbe, type ProbeFetch } from '@/lib/server/goldrushHistoryProbe'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const limiter = createRateLimiter({ windowMs: 60_000, max: 3 })
const notAvailable = () => new Response('Not available', { status: 404 })

function secretMatches(given: string | null): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  if (!secretMatches(url.searchParams.get('secret'))) return notAvailable()
  if (!limiter.check('goldrush-history-probe')) return NextResponse.json({ ok: false, error: 'rate limit (3/min)' }, { status: 429 })
  const apiKey = process.env.GOLDRUSH_API_KEY ?? process.env.COVALENT_API_KEY ?? ''
  if (!apiKey) return NextResponse.json({ ok: false, error: 'GOLDRUSH_API_KEY not configured on this deployment' }, { status: 200 })
  const input = parseGoldrushProbeInput(url.searchParams)
  if ('error' in input) return NextResponse.json({ ok: false, error: input.error }, { status: 400 })

  const fetchJson: ProbeFetch = async (target) => {
    const t0 = Date.now()
    try {
      const res = await fetch(target, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      return { status: res.status, json: await res.json().catch(() => null), ms: Date.now() - t0 }
    } catch {
      return { status: null, json: null, ms: Date.now() - t0 }
    }
  }
  const result = await runGoldrushHistoryProbe(input, fetchJson)
  return NextResponse.json({ ok: true, ...result }, { status: 200 })
}
