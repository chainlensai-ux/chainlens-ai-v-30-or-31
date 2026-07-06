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

import { NextResponse } from 'next/server'
import { createAndEnqueueScanJob, type ScanStartRequestBody } from '@/src/modules/scanJobCreation'

// maxDuration, DISCLOSED — unchanged reasoning from before this refactor: `after()`'s callback
// shares this invocation's own execution budget, so it's raised to the platform's real maximum
// rather than left at a low default (a lower real plan ceiling silently clamps this instead of
// erroring, so setting it high is safe everywhere).
export const maxDuration = 900

// RUNTIME, DISCLOSED: intentionally NOT edge — this route no longer touches ioredis directly, but
// keeping it on the default Node runtime avoids introducing a new, unverified Edge-compatibility
// question for no real benefit.

// EXTRACTED, DISCLOSED (Migrate-full-scan-to-job/poll task): validation + job-persist +
// after()-scheduled worker-trigger logic moved verbatim into src/modules/scanJobCreation.ts's
// createAndEnqueueScanJob(), so app/api/scan-v2/full-scan/start/route.ts (new, normal-mode job
// route) can reuse it instead of duplicating it. This route's own behavior/response shape is
// UNCHANGED — same validation order, same {jobId} success shape, same error shapes, still defaults
// scanMode to 'deep'. Nothing about Deep Scan's request/response contract or worker dispatch was
// altered by this extraction.
export async function POST(req: Request): Promise<Response> {
  try {
    const body: ScanStartRequestBody = await req.json().catch(() => ({}))
    const result = await createAndEnqueueScanJob(req, body, 'deep')
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status })
    }
    return NextResponse.json({ jobId: result.jobId })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
