import { NextResponse } from 'next/server'
import { WALLET_SCAN_STATUS_UNAVAILABLE, WalletScanStatusUnavailableError, readWalletScanJob, readWalletScanResult, walletScanJobKey, walletScanResultKey, walletScanResultMissingFallback } from '@/src/modules/walletScanQueue'

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
  const pollResultKey = walletScanResultKey(jobId)
  const pollJobKey = walletScanJobKey(jobId)
  console.warn('[wallet-scan-poll]', { pollResultKey, pollJobKey })
  let job
  try {
    job = await readWalletScanJob(jobId)
  } catch (err) {
    if (err instanceof WalletScanStatusUnavailableError) {
      return NextResponse.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
    }
    return NextResponse.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }

  if (!job) {
    return NextResponse.json({ jobId, status: 'not-found' }, { status: 404 })
  }

  if (job.status === 'done') {
    try {
      const result = await readWalletScanResult(jobId)
      if (result !== null) {
        const degraded = typeof result === 'object' && result !== null && 'degraded' in result
        return NextResponse.json({ jobId, status: job.status, ...(degraded ? { degraded: true } : {}), result })
      }
      return NextResponse.json({ jobId, status: 'done', degraded: true, result: walletScanResultMissingFallback(jobId, job) })
    } catch {
      return NextResponse.json({ jobId, status: 'done', degraded: true, result: walletScanResultMissingFallback(jobId, job) })
    }
  }

  return NextResponse.json({ jobId, status: job.status, ...(job.error ? { error: job.error } : {}) })
}
