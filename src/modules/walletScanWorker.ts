import { kv } from '@/lib/server/kv'
import {
  WALLET_SCAN_QUEUE_UNAVAILABLE,
  WalletScanQueueUnavailableError,
  walletScanJobKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueue'
import type { WalletScanJobPayload } from '@/src/modules/walletScanQueue'

type WalletScanJobState = {
  status: 'done' | 'failed'
  startedAt: number
  finishedAt: number
  durationMs: number
  pipelineDiagnostics: unknown
  // Safe stage-specific code, present only on failed publication — surfaced by the poll route so
  // the UI can distinguish "the pipeline failed" from "the result could not be stored".
  error?: string
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

// SERIALIZATION GUARD, DISCLOSED: the V2 pipeline result flows through many modules and can carry
// values plain JSON cannot represent — BigInt (viem block numbers in diagnostics), circular
// references, or class instances — any of which makes the KV client's own JSON.stringify THROW,
// which (before the publish-failure handling below existed) left the job stuck 'running' forever.
// This normalizes the result through one JSON round-trip: BigInt → decimal string (real value
// preserved, never dropped), non-finite numbers (NaN/±Infinity — already unrepresentable in JSON)
// → null, everything JSON-representable passes through byte-identical. A still-unserializable
// result (circular refs) throws here, deliberately — caught by the publish-failure path below and
// recorded as a real failure, never silently published as a corrupted result.
export function toSerializableResult(result: unknown): unknown {
  const json = JSON.stringify(result, (_key, value) => {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    return value
  })
  return json === undefined ? null : JSON.parse(json)
}

// PUBLICATION ORDER, FIXED (confirmed ordering bug): this previously wrote the job key (status
// 'done') FIRST and the result key SECOND — so a failed/interrupted result write, or a poll
// landing between the two writes, produced a job marked done with no result: exactly the
// "Final scan result is temporarily unavailable" degraded state the UI reported after otherwise
// successful pipeline runs. Correct order — write the result, THEN mark done — makes "done"
// mean "the full result is already safely stored", closing that window entirely.
export async function publishFinal(jobId: string, jobState: WalletScanJobState, result: unknown): Promise<void> {
  await kv.set(walletScanResultKey(jobId), result)
  await kv.set(walletScanJobKey(jobId), jobState)
}

export async function verifyWalletScanKvConnection(): Promise<void> {
  await kv.set('walletScanTestKey', 'ok')
  const value = await kv.get<string>('walletScanTestKey')
  if (value !== 'ok') {
    throw new Error('wallet-scan-kv-verification-failed')
  }
  // OBSERVABILITY FIX, DISCLOSED (confirmed bug — next.config's compiler.removeConsole strips
  // console.log/info/debug entirely from production builds, exclude: ['error','warn'] only; see
  // basedex.ts's own identical fix for the same reason): this line, and every other diagnostic
  // console.log/console.debug call in this file and workers/walletScanV2.ts, NEVER appeared in any
  // production deployment's logs — the entire per-module timing chain (V2-worker
  // starting/finished X, job started/completed) was a complete, silent black box this whole time,
  // which is why prior diagnosis kept finding the (fast, ~20s) base pipeline and never the actual
  // bottleneck. console.warn survives the production strip; message content is unchanged.
  console.warn('[wallet-scan-worker] kv verification succeeded', { key: 'walletScanTestKey' })
}

async function executeWalletScanJob(payload: WalletScanJobPayload): Promise<{ jobState: WalletScanJobState; result: unknown }> {
  const { resetAlchemyAudit, printAlchemyAuditSummary } = await import('@/lib/server/alchemyAudit')
  const { runWalletScanV2Worker } = await import('@/workers/walletScanV2')
  const { resetBaseDexRpcBudgetForScan } = await import('@/src/modules/pricingAtTimeEngine/sources/basedex')
  // PER-SCAN RESET, DISCLOSED (provider-call-audit task): same reasoning as resetAlchemyAudit/
  // resetBaseDexRpcBudgetForScan above — these two counters are process-global, so a warm
  // serverless instance serving a second, unrelated scan must start each fresh, not inherit the
  // previous scan's cumulative total. Without this, the new per-stage provider-call diagnostic
  // (workers/walletScanV2.ts) would report stale cross-request counts on any warm instance.
  const { resetGoldrushPriceSourceCallCount } = await import('@/src/modules/pricingAtTimeEngine/sources/goldrushPriceSource')
  const { resetDexscreenerCallCount } = await import('@/src/modules/pricingAtTimeEngine/sources/dexscreener')
  // REQUEST-SCOPED FETCH COALESCING RESET, DISCLOSED (provider-call-audit follow-up task): same
  // per-job reset convention as the counters above — see providerFetchWindow/index.ts's own header
  // for why this must be cleared at the start of every scan job (never leak a coalesced result
  // across unrelated wallets/scans on a warm serverless instance).
  const { resetProviderFetchWindowRequestCache, getProviderFetchWindowCoalescingCounters } = await import('@/src/modules/providerFetchWindow/index')
  // RECOVERY-PAGE COALESCING RESET, DISCLOSED (provider-call-audit follow-up task, confirmed
  // duplicate-call cause): same per-job reset convention as the counters/coalescing above — see
  // recoveryPolicy/utils.ts's own header for why multiple triggered candidates on one chain must
  // share ONE real GoldRush historical-page fetch, and why that sharing must reset per job.
  const { resetRecoveryHistoricalPageRequestCache } = await import('@/src/modules/recoveryPolicy/utils')

  const startedAt = Date.now()
  console.warn('[wallet-scan-worker] job started', { jobId: payload.jobId })
  resetAlchemyAudit()
  // SCAN-LEVEL RPC BUDGET RESET, DISCLOSED: same reasoning as resetAlchemyAudit() above — a warm
  // serverless instance serving a second, unrelated scan must start basedex's own RPC-call budget
  // fresh (see basedex.ts's resetBaseDexRpcBudgetForScan for the full reasoning), not inherit the
  // previous scan's exhausted counter.
  resetBaseDexRpcBudgetForScan()
  resetGoldrushPriceSourceCallCount()
  resetDexscreenerCallCount()
  resetProviderFetchWindowRequestCache()
  resetRecoveryHistoricalPageRequestCache()

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

  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] providerFetchWindow coalescing summary', { jobId: payload.jobId, ...getProviderFetchWindowCoalescingCounters() })

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
  }
  // Unconditional (success or failure) durationMs log via console.warn — the single most direct
  // way to answer "how long did the whole worker actually take, and did it finish or throw" on the
  // next real attempt, regardless of outcome.
  console.warn('[wallet-scan-worker] job finished', { jobId: payload.jobId, completedSuccessfully, durationMs: jobState.durationMs })

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

  // FINAL PUBLICATION, HARDENED (confirmed stuck-running bug): publishFinal was previously awaited
  // bare — a throw anywhere in serialization or either KV write propagated straight out of this
  // handler, so the job (already marked 'running' by the claim) stayed 'running' FOREVER with no
  // failure record, and the UI polled until its own client-side timeout. Now: serialization and
  // publication failures each get a distinct stage code, the job is explicitly marked 'failed'
  // (best-effort — if even that write fails, the error is logged with the jobId and stage so the
  // stuck job is at least diagnosable), and the route reports the failure honestly instead of
  // returning 'done'.
  let serializableResult: unknown
  try {
    serializableResult = toSerializableResult(result)
  } catch (err) {
    console.error('[wallet-scan-worker] result serialization failed', { jobId, error: err instanceof Error ? err.message : String(err) })
    await markJobFailed(jobId, jobState, 'worker_result_serialization_failed')
    return Response.json({ status: 'failed', jobId, resultPublished: false, error: 'worker_result_serialization_failed' }, { status: 500 })
  }

  try {
    await publishFinal(jobId, jobState, serializableResult)
  } catch (err) {
    console.error('[wallet-scan-worker] result publication failed', { jobId, error: err instanceof Error ? err.message : String(err) })
    await markJobFailed(jobId, jobState, 'worker_result_publish_failed')
    return Response.json({ status: 'failed', jobId, resultPublished: false, error: 'worker_result_publish_failed' }, { status: 500 })
  }

  return Response.json({ status: 'done', jobId, resultPublished: true })
}

// Best-effort terminal-failure write: a job must never be left 'running' after a publication
// failure. Never throws — if this write also fails (full KV outage), the console.error above plus
// this one leave a complete jobId+stage trail, and the poll route's existing not-found/unavailable
// handling covers the client side.
async function markJobFailed(jobId: string, jobState: WalletScanJobState, errorCode: string): Promise<void> {
  try {
    await kv.set(walletScanJobKey(jobId), { ...jobState, status: 'failed', error: errorCode })
  } catch (err) {
    console.error('[wallet-scan-worker] failed to mark job failed', { jobId, errorCode, error: err instanceof Error ? err.message : String(err) })
  }
}
