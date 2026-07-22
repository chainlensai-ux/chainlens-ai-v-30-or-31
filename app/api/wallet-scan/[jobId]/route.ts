import { WALLET_SCAN_STATUS_UNAVAILABLE, walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueue'
import { kv } from '@/lib/server/kv'

type WalletScanJobState = {
  status?: string
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

  return Response.json({ status: job.status ?? 'running' })
}
