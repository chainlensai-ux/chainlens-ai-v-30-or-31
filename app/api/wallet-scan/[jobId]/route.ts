import { WALLET_SCAN_STATUS_UNAVAILABLE } from '@/src/modules/walletScanQueue'
import { walletScanJobKey, walletScanResultKey } from '@/src/modules/walletScanQueueKeys'
import { kv } from '@/lib/server/kv'
import type { WalletScanJobMetadata } from '@/src/modules/walletScanQueue'

export async function GET(_req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params
  const pollJobKey = walletScanJobKey(jobId)
  const pollResultKey = walletScanResultKey(jobId)
  console.warn('[wallet-scan-poll]', { pollJobKey, pollResultKey })

  let job: WalletScanJobMetadata | null
  try {
    job = await kv.get<WalletScanJobMetadata>(pollJobKey)
  } catch {
    return Response.json(WALLET_SCAN_STATUS_UNAVAILABLE, { status: 503 })
  }

  if (!job) {
    return Response.json({ status: 'not-found' }, { status: 404 })
  }

  if (job.status === 'done') {
    const result = await kv.get(pollResultKey)
    if (result !== null) {
      return Response.json(result)
    }
  }

  return Response.json({ jobId, status: job.status })
}
