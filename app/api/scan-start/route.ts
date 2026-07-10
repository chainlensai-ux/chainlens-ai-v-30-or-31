// POST /api/scan-start — enqueue a Deep Scan as a background job (step 1 of the job/poll system).
//
// WORKER MOVED TO A DEDICATED ROUTE, PER EXPLICIT INSTRUCTION: the actual Deep Scan (holdings/
// pricing/portfolio/pnl/chainActivity/risk/personality/behavior/signals/smartMoneyScore — the same
// unchanged runWalletScanV2Worker every other scan route uses) previously ran inline inside this
// route's own background-work callback. Reported as unreliable in the real deployment — background
// compute tacked onto an already-responded invocation is a real, documented class of platform risk,
// distinct from a normal, freshly HTTP-triggered function invocation. Moved to
// app/api/scan-v2/worker/route.ts (its own file, its own maxDuration budget) — this route's only
// remaining job is to validate the request, persist the job, and trigger that route.
//
// CRITICAL CORRECTNESS FIX OVER THE TASK'S OWN LITERAL SNIPPET, DISCLOSED: the task's Part 2 showed
// `await fetch(WORKER_ENDPOINT/api/scan-v2/worker, ...)` placed BEFORE returning `{jobId}` to the
// client. Applied literally, that would make THIS route block on the ENTIRE Deep Scan finishing
// before ever responding — reintroducing the exact FUNCTION_INVOCATION_TIMEOUT / hung-client-request
// problem this whole job/poll system exists to solve, just moved one hop later. The fetch trigger is
// instead scheduled as background work that only runs AFTER the `{jobId}` response has already been
// sent to the client — so awaiting the worker's full response there never blocks the client, no
// matter how long the real scan takes (bounded by this route's own maxDuration=900, unchanged from
// before).
//
// BACKGROUND-SCHEDULING PRIMITIVE, RESOLVED ("QStash never triggers in production" diagnosis): this
// used to schedule the worker trigger via `next/server`'s `after()`. In this deployment's real
// Next.js/Vercel build adapter, `after()`'s callback silently never fired at all — no outgoing
// request, no error, nothing — because `after()` resolves the platform's background-work hook
// through `globalThis[Symbol.for('@next/request-context')]`, a Next-build-adapter-bridged symbol
// that wasn't wired for this build. `after()` was removed and replaced with `waitUntil()` from
// `@vercel/functions` (see src/modules/scanJobCreation.ts's createAndEnqueueScanJob(), which now
// calls `waitUntil(triggerWorker(jobId))`), which reads Vercel's own native request context
// (`@vercel/request-context`) directly, set by the Vercel Functions runtime itself — no adapter
// bridging involved. Confirmed reliable via the explicit log lines added right before scheduling and
// at the top of triggerWorker(). There is no remaining limitation on background-work scheduling in
// this route.
//
// SECRET, DISCLOSED: SCAN_WORKER_SECRET must be set to the same value on both this route and
// app/api/scan-v2/worker/route.ts for the worker to actually accept the trigger in production — see
// that route's own header for its fail-open-with-a-warning behavior when it's unset.
//
// nanoid, DISCLOSED: not installed in this codebase (verified via package.json) — used
// crypto.randomUUID() instead, the same real, already-used-elsewhere id generator.

import { NextResponse } from 'next/server'
import { createAndEnqueueScanJob, type ScanStartRequestBody } from '@/src/modules/scanJobCreation'

// maxDuration, DISCLOSED — unchanged reasoning from before this refactor: `waitUntil()`'s callback
// shares this invocation's own execution budget, so it's raised to the platform's real maximum
// rather than left at a low default (a lower real plan ceiling silently clamps this instead of
// erroring, so setting it high is safe everywhere).
export const maxDuration = 900

// RUNTIME, DISCLOSED: intentionally NOT edge — this route no longer touches ioredis directly, but
// keeping it on the default Node runtime avoids introducing a new, unverified Edge-compatibility
// question for no real benefit.

// EXTRACTED, DISCLOSED (Migrate-full-scan-to-job/poll task): validation + job-persist +
// waitUntil()-scheduled worker-trigger logic moved verbatim into src/modules/scanJobCreation.ts's
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
