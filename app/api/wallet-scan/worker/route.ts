import { WALLET_SCAN_QUEUE_UNAVAILABLE, WalletScanQueueUnavailableError } from '@/src/modules/walletScanQueue'
import type { WalletScanJobPayload } from '@/src/modules/walletScanQueue'

function invalidShapeResultBody(): unknown {
  return { success: false, error: 'wallet-scan-invalid-result-shape', partial: true }
}

function errorResultBody(err: unknown): unknown {
  return { success: false, error: err instanceof Error ? err.message : String(err), partial: true }
}

async function executeWalletScanJob(payload: WalletScanJobPayload): Promise<void> {
  const { resetAlchemyAudit, printAlchemyAuditSummary } = await import('@/lib/server/alchemyAudit')
  const { runWalletScanV2Worker } = await import('@/workers/walletScanV2')
  const { publishFinalWalletScanResult } = await import('@/src/modules/walletScanQueue')

  console.log('[wallet-scan-worker] job started', { jobId: payload.jobId })
  resetAlchemyAudit()

  let finalBody: unknown
  let completedSuccessfully = false

  try {
    const result = await runWalletScanV2Worker(
      { walletAddress: payload.walletAddress, chains: payload.chains, scanMode: payload.scanMode },
      payload.ip,
      payload.jobId,
    )

    if (!result || typeof result !== 'object' || !('body' in result)) {
      finalBody = invalidShapeResultBody()
      console.error('[wallet-scan-worker] job returned invalid result shape', { jobId: payload.jobId })
    } else {
      finalBody = result.body ?? invalidShapeResultBody()
      completedSuccessfully = true
    }
  } catch (err) {
    finalBody = errorResultBody(err)
    console.error('[wallet-scan-worker] job completed with failure result', err)
  }

  await publishFinalWalletScanResult(payload.jobId, finalBody)

  if (completedSuccessfully) {
    printAlchemyAuditSummary()
    console.log('[wallet-scan-worker] job completed', { jobId: payload.jobId })
  }
}

async function runWalletScanWorker(req: Request): Promise<Response> {
  void req
  const { claimNextWalletScanPayload } = await import('@/src/modules/walletScanQueue')

  for (;;) {
    let payload: WalletScanJobPayload | null
    try {
      payload = await claimNextWalletScanPayload()
    } catch (err) {
      console.error('[wallet-scan-worker] queue claim failed', err)
      if (err instanceof WalletScanQueueUnavailableError) {
        return Response.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
      }
      return Response.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
    }

    if (!payload) {
      return new Response(null, { status: 202 })
    }

    await executeWalletScanJob(payload)
  }
}

export async function POST(req: Request) {
  return await runWalletScanWorker(req);
}
