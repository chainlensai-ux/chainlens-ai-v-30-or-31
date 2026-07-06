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

  // `progress`, ADDED DISCLOSED (module-progress-reporting task): optional, may be absent on jobs
  // written before this field existed or on a job that hasn't reached its first module yet —
  // passed through as-is (undefined stays undefined in the JSON response, not coerced to null).
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    result: job.result,
    error: job.error,
    progress: job.progress,
  })
}
