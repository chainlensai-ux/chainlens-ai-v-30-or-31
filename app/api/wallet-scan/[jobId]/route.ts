import { NextResponse } from 'next/server'
import { WALLET_SCAN_STATUS_UNAVAILABLE, WalletScanStatusUnavailableError, readWalletScanJob, readWalletScanResult, walletScanResultMissingFallback } from '@/src/modules/walletScanQueue'

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
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
    return NextResponse.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }

  if (job.status === 'done') {
    try {
      const result = await readWalletScanResult(jobId)
      const fallback = result ?? walletScanResultMissingFallback(jobId, job)
      const degraded = fallback && typeof fallback === 'object' && 'degraded' in fallback
      return NextResponse.json({ jobId, status: job.status, ...(degraded ? { degraded: true } : {}), result: fallback })
    } catch {
      return NextResponse.json({ jobId, status: 'done', degraded: true, result: walletScanResultMissingFallback(jobId, job) })
    }
  }

  return NextResponse.json({ jobId, status: job.status, ...(job.error ? { error: job.error } : {}) })
}
