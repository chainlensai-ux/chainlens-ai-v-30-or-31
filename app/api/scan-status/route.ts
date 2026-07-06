// GET /api/scan-status?jobId=... — poll a Deep Scan job's current status/result.

import { NextResponse } from 'next/server'
import { getScanJob } from '@/src/modules/scanJobs'

export async function GET(req: Request): Promise<Response> {
  const jobId = new URL(req.url).searchParams.get('jobId')
  if (!jobId) {
    return NextResponse.json({ error: 'jobId query param is required' }, { status: 400 })
  }

  const job = await getScanJob(jobId)
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 })
  }

  // `moduleErrors`, ADDED DISCLOSED (stuck-at-module-11 task): workers/walletScanV2.ts merges
  // moduleErrors into the SAME `result` blob it already returns (see scanJobs.ts's own
  // ScanModuleErrors comment for why it isn't a separate stored field) — extracted here so callers
  // get it as its own top-level field alongside status/error/progress instead of having to reach
  // into `result` themselves. Never throws: `job.result` may be null (job not yet completed) or any
  // other shape (an older job, or a failed job with `result: null`), so this only reads
  // `moduleErrors` when `result` is a real object that actually has one.
  const moduleErrors =
    job.result && typeof job.result === 'object' && 'moduleErrors' in job.result
      ? (job.result as { moduleErrors?: unknown }).moduleErrors
      : undefined

  // `progress`, ADDED DISCLOSED (module-progress-reporting task): optional, may be absent on jobs
  // written before this field existed or on a job that hasn't reached its first module yet —
  // passed through as-is (undefined stays undefined in the JSON response, not coerced to null).
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    result: job.result,
    error: job.error,
    progress: job.progress,
    moduleErrors,
  })
}
