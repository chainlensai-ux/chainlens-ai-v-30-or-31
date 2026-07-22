import { kv } from '@/lib/server/kv'
import {
  WALLET_SCAN_QUEUE_UNAVAILABLE,
  WalletScanQueueUnavailableError,
  walletScanJobKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueue'
import type { WalletScanJobPayload } from '@/src/modules/walletScanQueue'

type WalletScanJobState = {
  status: 'done'
  startedAt: number
  finishedAt: number
  durationMs: number
  pipelineDiagnostics: unknown
}

// SHAPE, DISCLOSED: the client (app/frontend/api/scanWallet.ts's ScanWalletApiResponse, and
// app/terminal/wallet-scanner/page.tsx's `response.error?.message` read) requires `error` to be an
// object with a `message` field, never a bare string — a bare string previously made
// `response.error?.message` resolve to `undefined` client-side, silently swallowing the real error
// behind a generic "Scan failed" fallback.
function invalidShapeResultBody(): unknown {
  return { success: false, error: { message: 'wallet-scan-invalid-result-shape', category: 'pipeline' } }
}

function errorResultBody(err: unknown): unknown {
  return { success: false, error: { message: err instanceof Error ? err.message : String(err), category: 'pipeline' } }
}

function pipelineDiagnosticsFrom(result: unknown): unknown {
  if (!result || typeof result !== 'object') return null
  const body = result as Record<string, unknown>
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : body
  return {
    moduleErrors: data.moduleErrors ?? null,
    providerDiagnostics: data.providerDiagnostics ?? null,
    pricingProvidersStatus: data.pricingProvidersStatus ?? null,
    scanMetadata: data.scanMetadata ?? null,
  }
}

async function readWorkerJobId(req: Request): Promise<string | null> {
  const body = await req.json().catch(() => null) as { jobId?: unknown } | null
  return typeof body?.jobId === 'string' && body.jobId.trim() ? body.jobId.trim() : null
}

export async function publishFinal(jobId: string, jobState: WalletScanJobState, result: unknown): Promise<void> {
  await kv.set(walletScanJobKey(jobId), jobState)
  await kv.set(walletScanResultKey(jobId), result)
}

export async function verifyWalletScanKvConnection(): Promise<void> {
  await kv.set('walletScanTestKey', 'ok')
  const value = await kv.get<string>('walletScanTestKey')
  if (value !== 'ok') {
    throw new Error('wallet-scan-kv-verification-failed')
  }
  console.log('[wallet-scan-worker] kv verification succeeded', { key: 'walletScanTestKey' })
}

async function executeWalletScanJob(payload: WalletScanJobPayload): Promise<{ jobState: WalletScanJobState; result: unknown }> {
  const { resetAlchemyAudit, printAlchemyAuditSummary } = await import('@/lib/server/alchemyAudit')
  const { runWalletScanV2Worker } = await import('@/workers/walletScanV2')
  const { resetBaseDexRpcBudgetForScan } = await import('@/src/modules/pricingAtTimeEngine/sources/basedex')

  const startedAt = Date.now()
  console.log('[wallet-scan-worker] job started', { jobId: payload.jobId })
  resetAlchemyAudit()
  // SCAN-LEVEL RPC BUDGET RESET, DISCLOSED: same reasoning as resetAlchemyAudit() above — a warm
  // serverless instance serving a second, unrelated scan must start basedex's own RPC-call budget
  // fresh (see basedex.ts's resetBaseDexRpcBudgetForScan for the full reasoning), not inherit the
  // previous scan's exhausted counter.
  resetBaseDexRpcBudgetForScan()

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

  const finishedAt = Date.now()
  const jobState: WalletScanJobState = {
    status: 'done',
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    pipelineDiagnostics: pipelineDiagnosticsFrom(finalBody),
  }

  if (completedSuccessfully) {
    printAlchemyAuditSummary()
    console.log('[wallet-scan-worker] job completed', { jobId: payload.jobId })
  }

  return { jobState, result: finalBody }
}

export async function runWalletScanWorker(req: Request): Promise<Response> {
  const { claimWalletScanPayload } = await import('@/src/modules/walletScanQueue')
  const jobId = await readWorkerJobId(req)

  if (!jobId) {
    return Response.json({ status: 'missing-job-id' }, { status: 400 })
  }

  try {
    await verifyWalletScanKvConnection()
  } catch (err) {
    console.error('[wallet-scan-worker] kv verification failed', err)
    if (err instanceof WalletScanQueueUnavailableError) {
      return Response.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
    }
    return Response.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  let payload: WalletScanJobPayload | null
  try {
    payload = await claimWalletScanPayload(jobId)
  } catch (err) {
    console.error('[wallet-scan-worker] queue claim failed', err)
    if (err instanceof WalletScanQueueUnavailableError) {
      return Response.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
    }
    return Response.json(WALLET_SCAN_QUEUE_UNAVAILABLE, { status: 503 })
  }

  if (!payload) {
    return Response.json({ jobId, status: 'not-found' }, { status: 404 })
  }

  const { jobState, result } = await executeWalletScanJob(payload)
  await publishFinal(jobId, jobState, result)
  return Response.json({ status: 'done', jobId })
}
