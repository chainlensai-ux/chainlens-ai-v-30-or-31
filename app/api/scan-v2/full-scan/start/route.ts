// POST /api/scan-v2/full-scan/start — enqueue a `normal`-mode scan as a background job (mirrors
// app/api/scan-start's job/poll system, which was already generic across scanMode before this
// change — see src/modules/scanJobCreation.ts's header for the shared logic both routes call).
//
// WHY A THIN NEW ROUTE INSTEAD OF A SECOND JOB SYSTEM, DISCLOSED: app/api/scan-start/route.ts,
// app/api/scan-status/route.ts, app/api/scan-v2/worker/route.ts, and src/modules/scanJobs.ts were
// already fully generic across `scanMode` before this task (validateScanMode already accepts both
// 'normal' and 'deep'; the worker runs the identical runWalletScanV2Worker chain regardless of
// mode) — nothing in them is deep-scan-specific. Building a second, fully independent job/worker/
// store stack for `normal` mode would duplicate that already-working system, which conflicts with
// this task's own "don't duplicate code unnecessarily" rule. This route exists only to give
// `normal` scans their own URL shape per the task's explicit request; internally it defers to the
// exact same createAndEnqueueScanJob() used by app/api/scan-start, just defaulting scanMode to
// 'normal' instead of 'deep'. The job store, the worker route, and Deep Scan's own routes/behavior
// are completely untouched by this file.

export const maxDuration = 900

import { NextResponse } from 'next/server'
import { createAndEnqueueScanJob, type ScanStartRequestBody } from '@/src/modules/scanJobCreation'

export async function POST(req: Request): Promise<Response> {
  try {
    const body: ScanStartRequestBody = await req.json().catch(() => ({}))
    const result = await createAndEnqueueScanJob(req, body, 'normal')
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
