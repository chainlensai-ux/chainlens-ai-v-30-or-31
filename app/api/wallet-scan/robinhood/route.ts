import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { canAccessFeature } from '@/lib/planFeatures'
import { createRateLimiter, getClientIp } from '@/lib/server/rateLimit'
import { resolveRobinhoodRouteRequest } from '@/lib/server/robinhoodScanCoordinator'

// ROBINHOOD WALLET SCANNER ROUTE, DISCLOSED (phased Robinhood Chain Wallet Scanner rollout,
// Phase 1+2). Deliberately its OWN route, not a branch inside app/api/wallet-scan/route.ts's
// job-queue pipeline — see lib/server/robinhoodWalletScanner.ts's own header for the full
// architecture rationale. Synchronous (holdings + a bounded transaction-history fetch, both single
// bounded HTTP round-trips) rather than job-queued, since Phase 1/2's workload is far lighter than
// the deep multi-chain FIFO/PnL scan the queue exists for. Never touches wallet-scan's queue,
// worker, or V2 pipeline files.
export const runtime = 'nodejs'
export const maxDuration = 30

const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })

async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  if (process.env.BETA_ALL_ELITE === 'true') return 'elite'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}

export async function GET(req: Request): Promise<Response> {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ error: { message: 'Too many requests.', category: 'rate_limit' } }, { status: 429 })
  }

  const { searchParams } = new URL(req.url)
  const wallet = (searchParams.get('address') ?? searchParams.get('wallet') ?? '').trim()
  if (!isAddress(wallet)) {
    return NextResponse.json({ error: { message: 'Invalid wallet address', category: 'validation' } }, { status: 400 })
  }

  const plan = await getPlan(req)
  if (!canAccessFeature(plan, 'wallet-scanner')) {
    return NextResponse.json({ error: { message: 'Wallet Scanner is not available on this plan.', category: 'plan' } }, { status: 403 })
  }

  // ONE PROVIDER SCAN PER USER SCAN: this route no longer runs its own synchronous scanRobinhoodWallet().
  // The queued Wallet Scanner job is the canonical owner (lib/server/robinhoodScanCoordinator.ts): with a
  // `jobId` this serves / waits (bounded) for that job's Robinhood result and never scans; without one it
  // serves a fresh result, joins a live scan, or runs one bounded standalone scan (direct navigation).
  // `refresh=1` (the section's Rescan button) skips a fresh finished result but still joins a live scan.
  const jobId = searchParams.get('jobId')
  const outcome = await resolveRobinhoodRouteRequest(wallet, fetch, { jobId: jobId && /^[\w-]{1,64}$/.test(jobId) ? jobId : null, refresh: searchParams.get('refresh') === '1' })
  return NextResponse.json(outcome.body, { status: outcome.status })
}
