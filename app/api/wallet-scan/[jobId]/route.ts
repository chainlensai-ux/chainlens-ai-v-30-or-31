import {
  WALLET_SCAN_STATUS_UNAVAILABLE, markWalletScanJobStalled, mergeWalletScanJobLive, readWalletScanJobLive, recordWalletScanRetrigger,
  superviseWalletScanJob, triggerWalletScanWorker, walletScanJobKey, walletScanResultKey,
} from '@/src/modules/walletScanQueue'
import type { WalletScanJobLive, WalletScanJobMetadata, WalletScanJobProgress, WalletScanPartialSnapshot } from '@/src/modules/walletScanQueue'
import { kv } from '@/lib/server/kv'
import { requireAuthenticatedUser, unauthorizedResponse } from '@/lib/server/requireAuth'

type WalletScanJobState = {
  userId?: string
  status?: string
  error?: string
  createdAt?: number
  heartbeatAt?: number
  // STAGE PROGRESS / PARTIAL SNAPSHOT, DISCLOSED (perceived-speed + fast-snapshot follow-up tasks):
  // both real, present only while the job is still running — the worker's own `publishFinal`
  // overwrites this whole record with a status:'done'/'failed' shape once the scan completes, so
  // both fields naturally disappear from the response the moment a real final result exists (never
  // a stale progress line or partial snapshot shown alongside a finished scan).
  progress?: WalletScanJobProgress
  partial?: WalletScanPartialSnapshot
}

export async function GET(req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const auth = await requireAuthenticatedUser(req)
  if (!auth) return unauthorizedResponse()

  const { jobId } = await context.params
  const jobKey = walletScanJobKey(jobId)
  const resultKey = walletScanResultKey(jobId)

  let job: WalletScanJobState | null
  let result: unknown | null
  let live: WalletScanJobLive | null
  try {
    ;[job, result, live] = await Promise.all([
      kv.get<WalletScanJobState>(jobKey),
      kv.get(resultKey),
      readWalletScanJobLive(jobId),
    ])
  } catch {
    return Response.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }
  // The worker's heartbeat/progress live on their own key; a terminal job ignores them.
  if (job) job = mergeWalletScanJobLive(job, live)

  if (!job || job.userId !== auth.userId) {
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

  // WATCHDOG: re-trigger a job no worker has claimed yet (the claim is NX-locked, so this can never
  // start a duplicate scan), and fail one that has gone 90s without being claimed or heart-beating, so
  // the page stops polling and shows an error with Retry instead of spinning forever.
  const meta = job as unknown as WalletScanJobMetadata
  const now = Date.now()
  const supervision = superviseWalletScanJob({ ...meta, jobId }, now)
  if (supervision.action === 'fail') {
    console.warn('[wallet-scan-watchdog] marking job failed', { jobId, error: supervision.error, silentForMs: supervision.silentForMs, status: job.status ?? null })
    await markWalletScanJobStalled({ ...meta, jobId }, supervision.error, now)
    return Response.json({ status: 'failed', error: supervision.error })
  }
  if (supervision.action === 'retrigger') {
    await recordWalletScanRetrigger({ ...meta, jobId }, supervision.attempt, now)
    const trigger = await triggerWalletScanWorker(jobId)
    console.warn('[wallet-scan-watchdog] re-triggered queued job', { jobId, attempt: supervision.attempt, trigger })
  }

  return Response.json({
    status: job.status ?? 'running',
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.partial ? { partial: job.partial } : {}),
    // For the page's elapsed time / last-update line (server clock); only while the job is in flight.
    ...(job.status === 'queued' || job.status === 'running'
      ? { createdAt: meta.createdAt ?? null, heartbeatAt: meta.heartbeatAt ?? null, serverNow: now }
      : {}),
  })
}
