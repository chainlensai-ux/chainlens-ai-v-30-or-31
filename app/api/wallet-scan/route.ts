import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { WALLET_SCAN_QUEUE_UNAVAILABLE, WalletScanQueueUnavailableError, describeKvError, confirmWalletScanInFlight, enqueueWalletScanJob, releaseWalletScanInFlight, reserveWalletScanInFlight, walletScanRedisConfigured } from '@/src/modules/walletScanQueue'
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { canAccessFeature } from '@/lib/planFeatures'
import { consumeDailyScan, snapshotDailyScan } from '@/lib/scanQuota'
import { scanDailyLimitReachedMessage } from '@/lib/pricingPlans'
import { buildWalletChainSelectionAudit } from '@/lib/server/walletChainSelectionAudit'
import { isRobinhoodChainAvailable } from '@/lib/server/robinhoodChainConfig'
import { markRobinhoodScanQueued, markRobinhoodScanEnqueueFailed } from '@/lib/server/robinhoodScanCoordinator'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'
import { detectContractAddress } from '@/lib/server/whaleWalletKind'
import { readReusableWalletScan } from '@/src/modules/walletScanLatest'

export const runtime = 'nodejs'
export const preferredRegion = 'iad1'
export const maxDuration = 300

type ScanMode = 'normal' | 'deep'

// PLAN GATE, FIXED (audit: wallet-scanner): wallet-scanner is available on Free/Pro/Elite
// (Basic Wallet Scanner on Free; Full on Pro/Elite via wallet-scanner-full for UI depth).
// Deep mode alone consumes SCAN_DAILY_LIMITS (Free 3/month, Pro 30/month, Elite unlimited).
// Normal wallet scans never consume that pool. This route checks auth + canAccessFeature
// ('wallet-scanner'). Mirrors app/api/token/route.ts getPlan()/checkRate(): fail closed to
// 'free' on any missing/invalid token.
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
  // Any unexpected throw (plan/quota/auth lookups) answers with JSON the client can show, never a bare 500.
  try {
    return await enqueueScan(req)
  } catch (err) {
    console.error('[wallet-scan] unexpected enqueue route error', { error: describeKvError(err) })
    return NextResponse.json({ error: { message: 'Scan could not be started. Please try again.', category: 'server' } }, { status: 500 })
  }
}

async function enqueueScan(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as { walletAddress?: unknown; wallet?: unknown; chains?: unknown; scanMode?: unknown; fresh?: unknown } | null
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
  const authUser = await requireAuthenticatedUser(req)
  if (!authUser) return unauthorizedResponse()

  const plan = await getPlan(req)
  if (!canAccessFeature(plan, 'wallet-scanner')) {
    return NextResponse.json({ error: { message: 'Wallet Scanner is not available on this plan.', category: 'plan' } }, { status: 403 })
  }

  // RECENT RESULT REUSE: a complete scan of this wallet by this user (or the scheduled pre-scan of their
  // watchlist) finished in the last WALLET_SCAN_REUSE_MAX_AGE_MINUTES is returned at once. A Rescan sends
  // `fresh: true` and always runs a new scan. Reuse consumes no quota and starts no job.
  if (body?.fresh !== true) {
    const reusable = await readReusableWalletScan({ userId: authUser.userId, wallet, scanMode: body?.scanMode === 'deep' ? 'deep' : 'normal' })
    if (reusable) {
      console.warn('[wallet-scan] served recent result', { jobId: reusable.jobId, wallet: wallet.toLowerCase(), ageMs: Date.now() - reusable.completedAt, scanMode: reusable.scanMode })
      return NextResponse.json({ jobId: reusable.jobId, wallet, status: 'done', result: reusable.result, reused: true, completedAt: reusable.completedAt })
    }
  }

  // A contract (token, bridge, router) is not a wallet: its transfers are not trades, and scanning
  // one publishes nonsense PnL. Rejected before any quota is consumed. Lookup failures scan anyway.
  const walletKind = await detectContractAddress(wallet)
  if (walletKind === 'contract' || walletKind === 'infra') {
    return NextResponse.json({
      error: {
        message: 'This address is a smart contract (a token, bridge or router), not a wallet. Paste a wallet address, or use Token Scanner to analyse a token.',
        category: 'validation',
      },
    }, { status: 400 })
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
  // Deep-scan quota is per verified account (not per IP: shared networks shared one allowance and a
  // network change reset it). `ip` still drives the per-minute rate limit below.
  const quotaActor = `user:${authUser.userId}`

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
  // IN-FLIGHT REUSE: a repeat scan of the same wallet and mode by the same user while the first job
  // is still live joins that job (same jobId, same background run) instead of starting a second full
  // scan, and does not consume another deep-scan quota unit. Only the request that wins the atomic
  // reservation (and still holds it at confirm time) may consume quota or enqueue.
  const jobId = crypto.randomUUID()
  let reservation = await reserveWalletScanInFlight(authUser.userId, wallet, scanMode, jobId)
  if (reservation.kind === 'owner') {
    const confirmed = await confirmWalletScanInFlight(reservation)
    // Superseded between reserve and confirm: join whoever holds the slot now, never enqueue.
    reservation = confirmed ?? await reserveWalletScanInFlight(authUser.userId, wallet, scanMode, crypto.randomUUID())
    if (!confirmed && reservation.kind === 'owner') {
      await releaseWalletScanInFlight(reservation)
      reservation = { kind: 'contended' }
    }
  }
  if (reservation.kind === 'join') {
    console.log('[wallet-scan] joined in-flight job', { jobId: reservation.jobId, wallet: wallet.toLowerCase(), scanMode, status: reservation.status, pending: reservation.pending })
    return NextResponse.json({ jobId: reservation.jobId, wallet, status: reservation.status, reused: true, scanQuota: await snapshotDailyScan(plan, quotaActor) })
  }
  if (reservation.kind === 'contended') {
    return NextResponse.json({ error: { message: 'A scan of this wallet is already starting. Try again in a moment.', category: 'rate_limit' } }, { status: 429 })
  }

  let deepScanQuota = await snapshotDailyScan(plan, quotaActor)
  if (wantsDeep) {
    const scanQuota = await consumeDailyScan(plan, quotaActor)
    if (!scanQuota.allowed) {
      await releaseWalletScanInFlight(reservation)
      return NextResponse.json({
        error: { message: scanDailyLimitReachedMessage(plan, scanQuota.limit), category: 'scan_limit' },
        scanQuota: await snapshotDailyScan(plan, quotaActor),
      }, { status: 429 })
    }
    deepScanQuota = await snapshotDailyScan(plan, quotaActor)
  }

  // ONE PROVIDER SCAN PER USER SCAN: no cache-warm scan here (it was a second full Robinhood pipeline next
  // to the worker's). The queued job owns the scan; this records that it is coming so GET
  // /api/wallet-scan/robinhood waits for it instead of starting another. Written BEFORE the job is
  // enqueued, so the job's worker cannot already have written running/done when this lands; a failed
  // enqueue closes the marker (queued → error) so nothing waits on a job that will never run.
  const robinhoodQueuedAt = Date.now()
  const robinhoodMarked = includeRobinhoodRequested && robinhoodAvailable
  if (robinhoodMarked) await markRobinhoodScanQueued(wallet, jobId, robinhoodQueuedAt).catch(() => {})

  const jobPayload = { jobId, userId: authUser.userId, walletAddress: wallet, chains, scanMode, ip, includeRobinhoodRequested }
  try {
    // WORKER-LEVEL ROBINHOOD FIX, DISCLOSED: `includeRobinhoodRequested` (computed above from the
    // caller's original, unfiltered `chains`) now rides along with the job payload so the worker
    // (workers/walletScanV2.ts's runWalletScanV2Worker, via src/modules/walletScanWorker.ts) can
    // run the one Robinhood provider scan for this job (lib/server/robinhoodScanCoordinator.ts) as part
    // of processing the queued deep-scan job.
    await enqueueWalletScanJob(jobId, jobPayload)
  } catch (err) {
    // Underlying cause, server-side only: which enqueue step failed, the KV/Redis error, job id, size.
    console.error('[wallet-scan] failed to enqueue job', {
      jobId,
      wallet: wallet.toLowerCase(),
      scanMode,
      stage: err instanceof WalletScanQueueUnavailableError ? err.stage ?? null : 'unexpected',
      kvError: err instanceof WalletScanQueueUnavailableError ? err.detail ?? err.message : describeKvError(err),
      payloadBytes: JSON.stringify(jobPayload).length,
    })
    if (robinhoodMarked) await markRobinhoodScanEnqueueFailed(wallet, jobId, robinhoodQueuedAt).catch(() => {})
    await releaseWalletScanInFlight(reservation)
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
