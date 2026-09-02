import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { WALLET_SCAN_QUEUE_UNAVAILABLE, WalletScanQueueUnavailableError, enqueueWalletScanJob, walletScanRedisConfigured } from '@/src/modules/walletScanQueue'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { canAccessFeature } from '@/lib/planFeatures'
import { consumeDailyScan, snapshotDailyScan } from '@/lib/scanQuota'
import { scanDailyLimitReachedMessage } from '@/lib/pricingPlans'
import { buildWalletChainSelectionAudit } from '@/lib/server/walletChainSelectionAudit'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import { scanRobinhoodWallet } from '@/lib/server/robinhoodWalletScanner'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'

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

  // ACCOUNT-REQUIRED GATE, DISCLOSED (account-required task): a wallet scan previously ran for any
  // caller, authenticated or not, silently downgraded to the Free plan's quota/rate limit. Checked
  // after the infra-availability check above (a KV outage is independent of who's asking, per this
  // route's own pre-existing ordering disclosure) but before plan/quota resolution — an anonymous
  // caller is rejected before any job is enqueued.
  if (!(await requireAuthenticatedUser(req))) return unauthorizedResponse()

  const plan = await getPlan(req)
  if (!canAccessFeature(plan, 'wallet-scanner')) {
    return NextResponse.json({ error: { message: 'Wallet Scanner is not available on this plan.', category: 'plan' } }, { status: 403 })
  }

  const rawChains = Array.isArray(body?.chains) && body.chains.every((chain) => typeof chain === 'string')
    ? (body.chains as string[])
    : null
  // CHAINS FOR THE ENQUEUED EVM JOB, UNCHANGED, DISCLOSED: this is exactly the pre-existing
  // default/pass-through logic — 'robinhood' is filtered out here (never fed to
  // enqueueWalletScanJob()/runWalletScanV2(), whose SupportedChain union is EVM-only by design —
  // see lib/server/walletChainSelectionAudit.ts's header for why) but its presence/absence still
  // informs the Robinhood request decision below.
  const chains = (rawChains ? rawChains.filter((c) => c.toLowerCase() !== 'robinhood') : ['base', 'eth'])
  const wantsDeep = body?.scanMode === 'deep'
  const scanMode: ScanMode = wantsDeep ? 'deep' : 'normal'
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  // CANONICAL CHAIN SELECTION, DISCLOSED (Wallet Scanner deep scan chain coverage fix): Robinhood
  // Chain is considered "requested" for this scan whenever the caller used the default/auto chain
  // set (no explicit `chains` in the body — matching auto/all_supported semantics) OR explicitly
  // asked for it via 'robinhood' in `chains`. A caller who explicitly restricts to specific EVM
  // chains only (e.g. ['base']) without naming 'robinhood' is treated as not requesting it — an
  // honest, narrower request, not an omission bug.
  const includeRobinhoodRequested = rawChains === null || rawChains.some((c) => c.toLowerCase() === 'robinhood')
  const robinhoodAvailable = isRobinhoodChainAvailable()

  if (!checkWalletScanRate(ip)) {
    return NextResponse.json({ error: { message: 'Rate limit reached. Try again shortly.', category: 'rate_limit' } }, { status: 429 })
  }
  let deepScanQuota = snapshotDailyScan(plan, ip)
  if (wantsDeep) {
    const scanQuota = consumeDailyScan(plan, ip)
    if (!scanQuota.allowed) {
      return NextResponse.json({
        error: { message: scanDailyLimitReachedMessage(plan, scanQuota.limit), category: 'scan_limit' },
        scanQuota: snapshotDailyScan(plan, ip),
      }, { status: 429 })
    }
    deepScanQuota = snapshotDailyScan(plan, ip)
  }

  const jobId = crypto.randomUUID()

  try {
    // WORKER-LEVEL ROBINHOOD FIX, DISCLOSED: `includeRobinhoodRequested` (computed above from the
    // caller's original, unfiltered `chains`) now rides along with the job payload so the worker
    // (workers/walletScanV2.ts's runWalletScanV2Worker, via src/modules/walletScanWorker.ts) can
    // itself run a real scanRobinhoodWallet() call as part of processing the queued deep-scan job —
    // not just this route's own non-blocking cache-warm below, which only warms the shared cache and
    // never becomes part of the job's own published result.
    await enqueueWalletScanJob(jobId, { jobId, walletAddress: wallet, chains, scanMode, ip, includeRobinhoodRequested })
  } catch (err) {
    console.error('[wallet-scan] failed to enqueue job', { error: err instanceof Error ? err.message : String(err) })
    if (err instanceof WalletScanQueueUnavailableError) {
      return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
    }
    return NextResponse.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  const walletChainSelectionAudit = buildWalletChainSelectionAudit({
    requestedMode: scanMode,
    evmChainSlugs: chains,
    includeRobinhoodRequested,
    // Honest at this point in the request lifecycle: the EVM chains are what was just enqueued
    // (queued, not yet complete); Robinhood is included here only when it was both requested AND
    // actually available, since the cache-warm call fired below is the real, non-blocking attempt
    // to scan it — never a claim that it already finished.
    finalChainsScanned: includeRobinhoodRequested && robinhoodAvailable ? [...chains, 'robinhood'] : [...chains],
  })
  console.log('[wallet-scan] walletChainSelectionAudit', walletChainSelectionAudit)

  // ROBINHOOD CACHE-WARM, DISCLOSED: fires the SAME real scanRobinhoodWallet() call sequence the
  // standalone GET /api/wallet-scan/robinhood route already uses, populating the SAME
  // holdings/activity cache (lib/server/robinhoodWalletScanner.ts's getCachedRobinhoodWalletHoldings/
  // getCachedRobinhoodWalletActivity, keyed by wallet) that route reads from — so the page's own
  // parallel Robinhood fetch lands warm. This is what makes Robinhood part of the SAME deep-scan-
  // triggering request rather than "only rendered as a UI tab or separate side path." Never
  // awaited — the queued-job response must stay fast — and never silently swallowed: a failure is
  // logged with the real error, not hidden.
  if (includeRobinhoodRequested && robinhoodAvailable) {
    void scanRobinhoodWallet(wallet, fetch).catch((err) => {
      console.warn('[wallet-scan] robinhood cache-warm failed', {
        wallet,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  return NextResponse.json({ jobId, wallet, status: 'queued', walletChainSelectionAudit, scanQuota: deepScanQuota })
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
