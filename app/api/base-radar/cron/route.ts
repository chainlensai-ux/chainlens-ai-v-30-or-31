import { NextResponse, type NextRequest } from 'next/server'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'

// DAILY-REDISCOVERY-CRON, DISCLOSED (explicitly requested: "make sure every 24 hours it does a mass
// finding of new tokens safely on base radar so it's not just the same shit forever" — before this,
// /api/radar's own 24h daily-pool cycle (see app/api/radar/route.ts's DAILY_POOL_CYCLE_MS) only ever
// re-ran discovery lazily, on whatever real page request happened to land after the previous cycle
// expired. With low/zero traffic in that window, the pool would sit stale — still technically correct
// (nothing fake), just not proactively refreshed — until the next visitor finally triggered it.
//
// This is a Vercel Cron target (see vercel.json's "crons" entry, scheduled once daily — Vercel's
// Hobby-plan cron limit is exactly one invocation/day per job, which matches this feature's actual
// need). Vercel signs cron invocations with `Authorization: Bearer ${CRON_SECRET}` when the
// CRON_SECRET env var is configured — this route requires that match, so it can't be triggered by an
// arbitrary caller and never runs unless a real secret is set in the deployment's env. It then calls
// /api/radar's own GET handler in-process for base (and Robinhood, if the feature flag + RPC config
// make it available) using the internal x-base-radar-cron-secret header GET() already recognizes as
// a trusted non-paying-user trigger — the exact same discovery/gate/daily-pool code path a real user
// request would run, just invoked on a schedule instead of waiting on traffic. No new discovery logic
// is introduced here; this only ensures the existing pipeline actually runs at least once every 24h.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const internalSecret = process.env.BASE_RADAR_CRON_SECRET
  if (!internalSecret) {
    // Fails closed and says why, rather than silently doing nothing — this is a real configuration
    // gap (the two env vars are meant to be set together), not a routine no-op.
    return NextResponse.json({ ok: false, error: 'BASE_RADAR_CRON_SECRET is not configured; cannot trigger internal discovery.' }, { status: 500 })
  }

  const origin = new URL(req.url).origin
  const chains: Array<'base' | 'robinhood'> = ['base']
  if (isRobinhoodChainAvailable()) chains.push('robinhood')

  const results: Record<string, { status: number; ok: boolean } | { error: string }> = {}
  for (const chain of chains) {
    try {
      const res = await fetch(`${origin}/api/radar?chain=${chain}&page=1`, {
        headers: { 'x-base-radar-cron-secret': internalSecret },
        cache: 'no-store',
      })
      results[chain] = { status: res.status, ok: res.ok }
    } catch (err) {
      results[chain] = { error: err instanceof Error ? err.message : 'fetch failed' }
    }
  }

  return NextResponse.json({ ok: true, triggeredAt: new Date().toISOString(), chains, results })
}
