import { NextResponse } from 'next/server'
import { redis as kv } from '@/lib/server/cache/redisClient'
import { WALLET_SCAN_STATUS_UNAVAILABLE, walletScanResultMissingFallback } from '@/src/modules/walletScanQueue'
import type { WalletScanJobMetadata } from '@/src/modules/walletScanQueue'

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
  const pollResultKey = `walletScanResult:${jobId}`
  const pollJobKey = `walletScanJob:${jobId}`
  console.warn('[wallet-scan-poll]', { pollResultKey, pollJobKey })

  let job: WalletScanJobMetadata | null
  try {
    job = await kv.get<WalletScanJobMetadata>(pollJobKey)
  } catch {
    return NextResponse.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }

  if (!job) {
    return NextResponse.json({ status: 'not-found' }, { status: 404 })
  }

  if (job.status === 'done') {
    try {
      const result = await kv.get(pollResultKey)
      if (result !== null) {
        return NextResponse.json(result)
      }
      return NextResponse.json({ jobId, status: 'done', result: walletScanResultMissingFallback(jobId, job) })
    } catch {
      return NextResponse.json({ jobId, status: 'done', result: walletScanResultMissingFallback(jobId, job) })
    }
  }

  return NextResponse.json({ status: 'running' })
}
