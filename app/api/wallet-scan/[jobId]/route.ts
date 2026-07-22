import { WALLET_SCAN_STATUS_UNAVAILABLE, walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueue'
import { kv } from '@/lib/server/kv'

type WalletScanJobState = {
  status?: string
  error?: string
}

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
  const jobKey = walletScanJobKey(jobId)
  const resultKey = walletScanResultKey(jobId)

  let job: WalletScanJobState | null
  let result: unknown | null
  try {
    ;[job, result] = await Promise.all([
      kv.get<WalletScanJobState>(jobKey),
      kv.get(resultKey),
    ])
  } catch {
    return Response.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }

  if (!job) {
    return Response.json({ status: 'not-found' }, { status: 404 })
  }

  if (job.status === 'done' && result !== null) {
    return Response.json({ status: 'done', result })
  }

  // FAILED-STATE ERROR PASS-THROUGH, FIXED (audit: poll route): a failed job previously polled as
  // a bare { status: 'failed' } — the safe stage code the worker recorded (e.g.
  // worker_result_publish_failed) never reached the client, so the UI could only show a generic
  // "scan-failed". Only the job's own safe `error` code string is exposed — never the payload.
  if (job.status === 'failed') {
    return Response.json({ status: 'failed', ...(typeof job.error === 'string' && job.error ? { error: job.error } : {}) })
  }

  return Response.json({ status: job.status ?? 'running' })
}
