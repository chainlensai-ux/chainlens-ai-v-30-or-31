import { WALLET_SCAN_STATUS_UNAVAILABLE } from '@/src/modules/walletScanQueue'
import { kv } from '@/lib/server/kv'
import type { WalletScanJobMetadata } from '@/src/modules/walletScanQueue'

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
  const jobKey = `walletScanJob:${jobId}`
  const resultKey = `walletScanResult:${jobId}`
  console.warn('[wallet-scan-poll]', { jobKey, resultKey })

  let job: WalletScanJobMetadata | null
  try {
    job = await kv.get<WalletScanJobMetadata>(jobKey)
  } catch {
    return Response.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }

  if (!job) {
    return Response.json({ status: 'not-found' }, { status: 404 })
  }

  if (job.status === 'running') {
    return Response.json({ status: 'running' })
  }

  if (job.status === 'done') {
    let result: unknown | null
    try {
      result = await kv.get(resultKey)
    } catch {
      return Response.json({ status: 'done', result: { error: 'scan-final-result-unavailable', degraded: true } })
    }

    if (result !== null) {
      return Response.json({ status: 'done', result })
    }

    return Response.json({ status: 'done', result: { error: 'scan-final-result-missing', degraded: true } })
  }

  return Response.json({ status: job.status })
}
