import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { WALLET_SCAN_QUEUE_UNAVAILABLE, WalletScanQueueUnavailableError, enqueueWalletScanJob, walletScanRedisConfigured } from '@/src/modules/walletScanQueue'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { canAccessFeature } from '@/lib/planFeatures'

export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const maxDuration = 300

type ScanMode = 'normal' | 'deep'

// PLAN GATE, FIXED (audit: wallet-scanner): wallet-scanner is Pro/Elite-only per
// lib/planFeatures.ts and the pricing page, but this route previously never checked auth or plan
// at all — only the frontend page (app/terminal/wallet-scanner/page.tsx) hid the UI for free
// users. A direct POST here bypassed that entirely and got the full deep scan for free. Mirrors
// app/api/token/route.ts's own getPlan()/checkRate() convention: fail closed to 'free' on any
// missing/invalid token.
async function getPlan(req: Request): Promise<'free' | 'pro' | 'elite'> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'free'
  // BETA_ALL_ELITE, DISCLOSED: same global beta-elite-for-authenticated-users override every other
  // gate already applies (app/api/user-settings/route.ts, app/api/clark/route.ts) — an authenticated
  // caller during the beta window resolves to 'elite' here too, matching what the frontend's own
  // betaEliteActive check already grants so a legitimate beta user is never blocked by this fix.
  if (process.env.BETA_ALL_ELITE === 'true') return 'elite'
  try { return (await getCurrentUserPlanFromBearerToken(token)).plan } catch { return 'free' }
}

// RATE LIMIT, FIXED (audit: wallet-scanner): the route captured the caller's IP but never used it
// to limit anything — each accepted job runs up to a 300s worker making real paid GoldRush/Alchemy
// calls, so an unthrottled caller could queue unlimited jobs. Same in-memory per-instance window
// convention as app/api/token/route.ts's tokenRateMap/checkRate (best-effort, not distributed —
// matches this codebase's existing rate-limit convention rather than inventing a new one).
const WALLET_SCAN_RATE_WINDOW_MS = 60 * 1000
const WALLET_SCAN_RATE_LIMIT = 6
const walletScanRateMap = new Map<string, { count: number; resetAt: number }>()
function checkWalletScanRate(ip: string): boolean {
  const now = Date.now()
  const cur = walletScanRateMap.get(ip)
  if (!cur || cur.resetAt <= now) { walletScanRateMap.set(ip, { count: 1, resetAt: now + WALLET_SCAN_RATE_WINDOW_MS }); return true }
  if (cur.count >= WALLET_SCAN_RATE_LIMIT) return false
  cur.count += 1
  return true
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as { walletAddress?: unknown; wallet?: unknown; chains?: unknown; scanMode?: unknown } | null
  const wallet = typeof body?.walletAddress === 'string'
    ? body.walletAddress.trim()
    : typeof body?.wallet === 'string'
      ? body.wallet.trim()
      : ''

  if (!isAddress(wallet)) {
    return NextResponse.json({ error: { message: 'Invalid wallet address', category: 'validation' } }, { status: 400 })
  }

  // ORDERING, DISCLOSED: infra availability is checked before plan/rate gating — a KV outage is a
  // server-side condition independent of who's asking, so it should short-circuit before spending
  // a Supabase lookup on the caller's plan (matches the pre-existing walletScanQueueUnavailable
  // test's expectation that this failure mode reports 503 regardless of the caller's plan).
  if (!walletScanRedisConfigured()) {
    return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  const plan = await getPlan(req)
  if (!canAccessFeature(plan, 'wallet-scanner')) {
    return NextResponse.json({ error: { message: 'Wallet Scanner requires a Pro or Elite plan.', category: 'plan' } }, { status: 403 })
  }

  const chains = Array.isArray(body?.chains) && body.chains.every((chain) => typeof chain === 'string')
    ? body.chains
    : ['base', 'eth']
  const scanMode: ScanMode = body?.scanMode === 'deep' ? 'deep' : 'normal'
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  if (!checkWalletScanRate(ip)) {
    return NextResponse.json({ error: { message: 'Rate limit reached. Try again shortly.', category: 'rate_limit' } }, { status: 429 })
  }

  const jobId = crypto.randomUUID()

  try {
    await enqueueWalletScanJob(jobId, { jobId, walletAddress: wallet, chains, scanMode, ip })
  } catch (err) {
    console.error('[wallet-scan] failed to enqueue job', { error: err instanceof Error ? err.message : String(err) })
    if (err instanceof WalletScanQueueUnavailableError) {
      return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
    }
    return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  return NextResponse.json({ jobId, wallet, status: 'queued' })
}


export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const jobId = searchParams.get('jobId')

  if (!jobId) {
    return NextResponse.json({ error: { message: 'Missing jobId', category: 'validation' } }, { status: 400 })
  }

  const { GET: pollWalletScanJob } = await import('@/app/api/wallet-scan/[jobId]/route')
  return await pollWalletScanJob(req, { params: Promise.resolve({ jobId }) })
}
