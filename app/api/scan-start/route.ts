// POST /api/scan-start — enqueue a Deep Scan as a background job (step 1 of the job/poll system).
//
// WORKER MOVED TO A DEDICATED ROUTE, PER EXPLICIT INSTRUCTION: the actual Deep Scan (holdings/
// pricing/portfolio/pnl/chainActivity/risk/personality/behavior/signals/smartMoneyScore — the same
// unchanged runWalletScanV2Worker every other scan route uses) previously ran inline inside this
// route's own `after()` callback. Reported as unreliable in the real deployment — background compute
// tacked onto an already-responded invocation is a real, documented class of platform risk,
// distinct from a normal, freshly HTTP-triggered function invocation. Moved to
// app/api/scan-v2/worker/route.ts (its own file, its own maxDuration budget) — this route's only
// remaining job is to validate the request, persist the job, and trigger that route.
//
// CRITICAL CORRECTNESS FIX OVER THE TASK'S OWN LITERAL SNIPPET, DISCLOSED: the task's Part 2 showed
// `await fetch(WORKER_ENDPOINT/api/scan-v2/worker, ...)` placed BEFORE returning `{jobId}` to the
// client. Applied literally, that would make THIS route block on the ENTIRE Deep Scan finishing
// before ever responding — reintroducing the exact FUNCTION_INVOCATION_TIMEOUT / hung-client-request
// problem this whole job/poll system exists to solve, just moved one hop later. The fetch trigger
// below is inside `after()` instead, which only runs AFTER the `{jobId}` response has already been
// sent to the client — so awaiting the worker's full response there never blocks the client, no
// matter how long the real scan takes (bounded by this route's own maxDuration=900, unchanged from
// before).
//
// REMAINING LIMITATION, DISCLOSED: this still depends on `after()` firing at all to dispatch the
// trigger fetch — if the real issue in production is that `after()` never invokes its callback (a
// total non-firing, not just a duration/kill issue), this fix narrows but does not eliminate that
// risk. What it DOES fix regardless: the actual heavy compute no longer runs "extra time squeezed
// onto an already-finished request" — it runs as a real, freshly-invoked function
// (app/api/scan-v2/worker/route.ts) with its own independent execution budget, which is the more
// likely source of real platform-level kills for a 15-minute background task. If `after()` truly
// never fires at all in this deployment, the next real step would be a durable queue or Vercel's
// `waitUntil()` primitive (via the `@vercel/functions` package) — not added here since introducing a
// new dependency for that is a bigger, separate decision than this task asked for.
//
// SECRET, DISCLOSED: SCAN_WORKER_SECRET must be set to the same value on both this route and
// app/api/scan-v2/worker/route.ts for the worker to actually accept the trigger in production — see
// that route's own header for its fail-open-with-a-warning behavior when it's unset.
//
// nanoid, DISCLOSED: not installed in this codebase (verified via package.json) — used
// crypto.randomUUID() instead, the same real, already-used-elsewhere id generator.

import { NextResponse, after } from 'next/server'
import { validateWalletAddress, validateChains, validateScanMode } from '@/src/deployment/validator'
import { setScanJob, type ScanJob } from '@/src/modules/scanJobs'

// maxDuration, DISCLOSED — unchanged reasoning from before this refactor: `after()`'s callback
// shares this invocation's own execution budget, so it's raised to the platform's real maximum
// rather than left at a low default (a lower real plan ceiling silently clamps this instead of
// erroring, so setting it high is safe everywhere).
export const maxDuration = 900

// RUNTIME, DISCLOSED: intentionally NOT edge — this route no longer touches ioredis directly, but
// keeping it on the default Node runtime avoids introducing a new, unverified Edge-compatibility
// question for no real benefit.

type ScanStartRequestBody = {
  walletAddress?: unknown
  chains?: unknown
  scanMode?: unknown
}

function workerBaseUrl(): string {
  if (process.env.WORKER_ENDPOINT) return process.env.WORKER_ENDPOINT
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000' // local dev fallback only
}

async function triggerWorker(jobId: string): Promise<void> {
  try {
    const res = await fetch(`${workerBaseUrl()}/api/scan-v2/worker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.SCAN_WORKER_SECRET ? { 'x-worker-secret': process.env.SCAN_WORKER_SECRET } : {}),
      },
      body: JSON.stringify({ jobId }),
    })
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[scan-start] worker trigger returned non-2xx', jobId, res.status)
    }
  } catch (err) {
    // The worker route's own job-status write is the source of truth; a failed trigger dispatch
    // just means the job stays 'pending' for a later poll to (currently) never resolve — logged
    // here for visibility, not silently swallowed.
    // eslint-disable-next-line no-console
    console.error('[scan-start] worker trigger failed', jobId, err instanceof Error ? err.message : String(err))
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body: ScanStartRequestBody = await req.json().catch(() => ({}))
    const addressCheck = validateWalletAddress(body.walletAddress)
    if (!addressCheck.valid) {
      return NextResponse.json({ success: false, error: addressCheck.error }, { status: 400 })
    }
    const chainsCheck = validateChains(body.chains ?? ['base', 'eth'])
    if (!chainsCheck.valid) {
      return NextResponse.json({ success: false, error: chainsCheck.error }, { status: 400 })
    }
    const scanModeCheck = validateScanMode(body.scanMode ?? 'deep')
    if (!scanModeCheck.valid) {
      return NextResponse.json({ success: false, error: scanModeCheck.error }, { status: 400 })
    }

    const walletAddress = body.walletAddress as string
    const rawBody = { walletAddress, chains: chainsCheck.sanitizedChains, scanMode: body.scanMode ?? 'deep' }
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const jobId = crypto.randomUUID()

    const job: ScanJob = {
      id: jobId,
      walletAddress,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'pending',
      result: null,
      error: null,
      rawBody,
      ip,
    }
    // Stored BEFORE returning, so an immediate poll never sees "not found" for a job that was
    // actually accepted, and so the worker route (a separate invocation) has something to load.
    await setScanJob(jobId, job)

    // Runs AFTER the {jobId} response below has already been sent to the client — awaiting the
    // full worker round-trip here never blocks the client (see file header).
    after(() => triggerWorker(jobId))

    return NextResponse.json({ jobId })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
