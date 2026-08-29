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

// WALLET-WORKER-TIMING-AUDIT, DISCLOSED, ADDITIVE (Wallet Scanner live-regression audit — reported:
// "job completed... 81.5s. Pipeline timing showed ~72.5s" with no accounting for the ~9s gap).
// ROOT CAUSE, CONFIRMED BY READING THIS FILE'S OWN CONTROL FLOW: `jobState.durationMs` (the number
// this file already logs as "[wallet-scan-worker] job finished ... durationMs") is captured INSIDE
// executeWalletScanJob, BEFORE this function's own `toSerializableResult` + `publishFinal` steps
// run — so the real end-to-end job time a caller/queue actually experiences was always LARGER than
// the one number this codebase logged, by exactly the serialization + two sequential KV writes
// (walletScanResultKey, walletScanJobKey) that happen after jobState is built. That gap was real,
// present in every prior scan, and simply never measured. Separately, the ~15 dynamic imports
// executeWalletScanJob awaits BEFORE its own `startedAt` capture (cold-start module resolution) were
// also never measured — both gaps are now real, named fields below, not folded silently into
// "pipeline time."
//
// HONEST SCOPE, DISCLOSED: this worker's persistence layer is KV/Redis only (`lib/server/kv` —
// see publishFinal below) — no Supabase write happens anywhere in this job's execution path, so
// `supabaseWriteMs` is always null here (never a fabricated 0 standing in for "not applicable").
// `cacheWriteMs` is likewise null: the only OTHER cache write in this call chain
// (lib/server/cache/v2StageCache.ts's holdings-stage cache) happens INSIDE the pipeline itself,
// already folded into `pipelineMs` — measuring it separately here would require threading a timer
// through runWalletScanV2Worker's own internals, out of this task's safe, additive scope.
export type WalletWorkerTimingAudit = {
  // Full, real wall-clock span of runWalletScanWorker() — KV-connection verify through the final
  // Response — the true "how long did this job take" number a caller/queue experiences.
  jobDurationMs: number
  // executeWalletScanJob's own measured span (jobState.durationMs) — dynamic imports excluded (see
  // prePipelineMs), persistence excluded (see persistenceMs).
  pipelineMs: number
  // KV-connection verify + queue claim + executeWalletScanJob's own ~15 dynamic imports, all of
  // which happen before executeWalletScanJob's `startedAt` is captured — real, previously-unmeasured
  // cold-start/setup cost.
  prePipelineMs: number
  // toSerializableResult() + publishFinal()'s two sequential KV writes, combined — the real gap this
  // audit exists to close. Equal to jobDurationMs - prePipelineMs - pipelineMs whenever the job
  // reaches serialization (the one other possible time sink — the KV-connection verify/claim step —
  // is folded into prePipelineMs instead, since it happens before the pipeline, not after).
  postPipelineMs: number
  // Same real measured span as postPipelineMs — kept as its own explicit field (rather than only
  // inferring it from the totals above) because it is the one this task's audit shape specifically
  // asks for by this name.
  persistenceMs: number
  cacheWriteMs: number | null
  // The result-write half of publishFinal (walletScanResultKey) — this is literally the write that
  // makes a completed scan visible to the UI's poll route, so it is reported under this name.
  uiPublishMs: number
  supabaseWriteMs: number | null
  // The job-state-write half of publishFinal (walletScanJobKey, status:'done') — the "job is
  // finished" marker write, separate from the result write above.
  kvWriteMs: number
  // Whichever of the two previously-invisible spans (prePipelineMs vs. postPipelineMs) turned out
  // larger for this run — the most actionable single answer to "where did the missing time go."
  slowestUnmeasuredStage: 'pre_pipeline_imports_and_claim' | 'post_pipeline_serialization_and_publish' | null
  // Real residual: jobDurationMs minus every span this audit accounts for. Near-zero once
  // prePipelineMs/pipelineMs/postPipelineMs are all measured; a persistently large value here would
  // itself be the next diagnostic lead (e.g. Response.json/runtime overhead outside this file).
  unexplainedMs: number
}

export function buildWalletWorkerTimingAudit(params: {
  jobDurationMs: number
  pipelineMs: number
  prePipelineMs: number
  resultWriteMs: number
  jobStateWriteMs: number
  serializationMs: number
}): WalletWorkerTimingAudit {
  const { jobDurationMs, pipelineMs, prePipelineMs, resultWriteMs, jobStateWriteMs, serializationMs } = params
  const persistenceMs = serializationMs + resultWriteMs + jobStateWriteMs
  const accountedMs = prePipelineMs + pipelineMs + persistenceMs
  const unexplainedMs = Math.max(0, jobDurationMs - accountedMs)
  const slowestUnmeasuredStage: WalletWorkerTimingAudit['slowestUnmeasuredStage'] =
    prePipelineMs === 0 && persistenceMs === 0
      ? null
      : prePipelineMs >= persistenceMs
        ? 'pre_pipeline_imports_and_claim'
        : 'post_pipeline_serialization_and_publish'
  return {
    jobDurationMs,
    pipelineMs,
    prePipelineMs,
    postPipelineMs: persistenceMs,
    persistenceMs,
    cacheWriteMs: null,
    uiPublishMs: resultWriteMs,
    supabaseWriteMs: null,
    kvWriteMs: jobStateWriteMs,
    slowestUnmeasuredStage,
    unexplainedMs,
  }
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

// GOLDRUSH CALL SPLIT EXTRACTION, DISCLOSED (UI/trust follow-up task): the real, measured
// historical-vs-current-price split src/pipeline/index.ts's own final return now carries (see
// `goldrushCallSplit` there) — extracted here, defensively, so `logWalletProviderCostAudit` can
// attribute [wallet-provider-cost-audit]'s own numbers correctly. `undefined` (never a fabricated
// split) whenever the result shape doesn't carry real, finite numbers — a genuinely missing/failed
// scan degrades to the ledger's pre-existing, unsplit behavior, never a fabricated 0.
function goldrushCallSplitFrom(result: unknown): { historicalGoldrushLiveCalls: number; currentPriceGoldrushLiveCalls: number; currentPriceDexLiveCalls?: number } | undefined {
  if (!result || typeof result !== 'object') return undefined
  const body = result as Record<string, unknown>
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : body
  const split = data.goldrushCallSplit
  if (!split || typeof split !== 'object') return undefined
  const { historicalGoldrushLiveCalls, currentPriceGoldrushLiveCalls, currentPriceDexLiveCalls } = split as Record<string, unknown>
  if (typeof historicalGoldrushLiveCalls !== 'number' || !Number.isFinite(historicalGoldrushLiveCalls)) return undefined
  if (typeof currentPriceGoldrushLiveCalls !== 'number' || !Number.isFinite(currentPriceGoldrushLiveCalls)) return undefined
  const dexLiveCalls = typeof currentPriceDexLiveCalls === 'number' && Number.isFinite(currentPriceDexLiveCalls) ? currentPriceDexLiveCalls : undefined
  return { historicalGoldrushLiveCalls, currentPriceGoldrushLiveCalls, currentPriceDexLiveCalls: dexLiveCalls }
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
// TIMING HOOK, DISCLOSED, ADDITIVE: `onTiming` is optional and defaults to doing nothing — every
// existing caller (including this file's own tests) that doesn't pass it gets byte-identical
// behavior, same two awaited kv.set calls in the same order. runWalletScanWorker below is the one
// real caller that supplies it, to power walletWorkerTimingAudit's uiPublishMs/kvWriteMs split.
export async function publishFinal(
  jobId: string,
  jobState: WalletScanJobState,
  result: unknown,
  onTiming?: (resultWriteMs: number, jobStateWriteMs: number) => void,
): Promise<void> {
  const t0 = Date.now()
  await kv.set(walletScanResultKey(jobId), result)
  const t1 = Date.now()
  await kv.set(walletScanJobKey(jobId), jobState)
  const t2 = Date.now()
  onTiming?.(t1 - t0, t2 - t1)
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
  // PERF-SPRINT TASK, DISCLOSED ("detect sequential operations that could safely run in parallel"):
  // these ~15 dynamic imports were previously each individually `await`ed, one after another, even
  // though none of them depends on another's resolved value (every import target is an independent
  // module, and none of their reset-function calls below need to happen in any particular order
  // relative to each other — only "before runWalletScanV2Worker starts", which Promise.all already
  // guarantees). Real cost on a genuinely cold serverless instance: each `await import()` is its own
  // microtask/module-resolution step; running them concurrently instead of serially removes that
  // sequential tax with zero change to which resets fire or what they do — every comment explaining
  // WHY each individual reset exists (per-job counter isolation on a warm instance) is preserved
  // below, unchanged, only regrouped onto the destructuring of Promise.all's resolved array.
  const [
    { resetAlchemyAudit, printAlchemyAuditSummary },
    { runWalletScanV2Worker },
    { resetBaseDexRpcBudgetForScan },
    // PER-SCAN RESET, DISCLOSED (provider-call-audit task): same reasoning as resetAlchemyAudit/
    // resetBaseDexRpcBudgetForScan above — these two counters are process-global, so a warm
    // serverless instance serving a second, unrelated scan must start each fresh, not inherit the
    // previous scan's cumulative total. Without this, the new per-stage provider-call diagnostic
    // (workers/walletScanV2.ts) would report stale cross-request counts on any warm instance.
    { resetGoldrushPriceSourceCallCount },
    { resetDexscreenerCallCount },
    // SOURCE-RETRY-AVOIDANCE RESETS, DISCLOSED (source-retry-avoidance task): same per-job reset
    // convention as every other scan-scoped provider state above — a warm serverless instance's
    // PREVIOUS scan (a different wallet, possibly a different chain mix) must never bias this scan's
    // CoinGecko circuit state, GeckoTerminal no-pool cache, or Base DEX prioritisation.
    { resetCoingeckoCircuitBreaker },
    { resetGeckoTerminalNoPoolCache },
    { resetPricingAtTimeAdapterScanState },
    // REQUEST-SCOPED FETCH COALESCING RESET, DISCLOSED (provider-call-audit follow-up task): same
    // per-job reset convention as the counters above — see providerFetchWindow/index.ts's own header
    // for why this must be cleared at the start of every scan job (never leak a coalesced result
    // across unrelated wallets/scans on a warm serverless instance).
    { resetProviderFetchWindowRequestCache, getProviderFetchWindowCoalescingCounters, getProviderFetchWindowKeyAudits },
    // RECOVERY-PAGE COALESCING RESET, DISCLOSED (provider-call-audit follow-up task, confirmed
    // duplicate-call cause): same per-job reset convention as the counters/coalescing above — see
    // recoveryPolicy/utils.ts's own header for why multiple triggered candidates on one chain must
    // share ONE real GoldRush historical-page fetch, and why that sharing must reset per job.
    { resetRecoveryHistoricalPageRequestCache },
    // SHARED DEXSCREENER CACHE RESET, DISCLOSED (this task's explicit requirement): same per-job
    // reset convention as every other request-scoped cache above — see
    // src/lib/dexscreenerRequestCache.ts's own header for the confirmed root cause this closes (two
    // entirely separate, uncoordinated DexScreener implementations, neither aware of the other's
    // calls or budget).
    { resetDexscreenerRequestCache, getDexscreenerRequestDiagnostics },
    // SHADOW-MODE ALCHEMY HISTORICAL PRICING RESET, DISCLOSED: same per-job reset convention as every
    // other request-scoped provider budget/cache above — see alchemyHistoricalPriceSource.ts's own
    // header for why this scan's live-request budget/singleflight cache must never leak into an
    // unrelated later scan on a warm serverless instance. This module is shadow-mode only (records
    // results, never feeds official pricing) — resetting it has no effect on FIFO/PnL/coverage.
    { resetAlchemyHistoricalPricingState },
    // SHARED NATIVE-PRICE RESOLVER RESET, DISCLOSED (Phase 1) — clears ONLY this scan's transient
    // failure memory and counters. Deliberately does NOT clear the accepted-price cache: a real
    // historical ETH price for a past UTC day is immutable, so carrying it across scans on a warm
    // instance is correct AND is the entire point of the module (see nativePriceResolver/index.ts's
    // own header — repeatedly re-fetching immutable prices is what exhausted the rate limit that
    // produced this phase's production baseline).
    { resetNativePriceResolverForScan },
    // SHARED PROVIDER COST LEDGER RESET, DISCLOSED (cost-audit task): the single request-scoped
    // Alchemy+GoldRush budget every provider call site now gates on — see
    // src/modules/providerCost/walletProviderCostLedger.ts and docs/wallet-provider-cost-audit.md.
    // Same per-job reset convention as every other request-scoped budget above: a warm serverless
    // instance serving a second, unrelated scan must start with a fresh budget rather than inherit
    // the previous scan's exhausted one.
    { resetWalletProviderCostLedger, logWalletProviderCostAudit },
    // CURRENT-PRICE CACHE RESET, DISCLOSED (Wallet Scanner improvement audit): same per-job reset
    // convention as every other request-scoped cache above — the short-TTL current-price cache
    // (src/modules/pricing/index.ts) must never carry a price from one wallet's scan into an
    // unrelated one on a warm serverless instance.
    { resetPriceCache },
  ] = await Promise.all([
    import('@/lib/server/alchemyAudit'),
    import('@/workers/walletScanV2'),
    import('@/src/modules/pricingAtTimeEngine/sources/basedex'),
    import('@/src/modules/pricingAtTimeEngine/sources/goldrushPriceSource'),
    import('@/src/modules/pricingAtTimeEngine/sources/dexscreener'),
    import('@/src/modules/pricingAtTimeEngine/sources/coingecko'),
    import('@/src/pipeline/providers/geckoTerminalPriceSource'),
    import('@/src/pipeline/pricingAtTimeAdapter'),
    import('@/src/modules/providerFetchWindow/index'),
    import('@/src/modules/recoveryPolicy/utils'),
    import('@/src/lib/dexscreenerRequestCache'),
    import('@/src/modules/pricingAtTimeEngine/sources/alchemyHistoricalPriceSource'),
    import('@/src/modules/nativePriceResolver/index'),
    import('@/src/modules/providerCost/walletProviderCostLedger'),
    import('@/src/modules/pricing/index'),
  ])

  const startedAt = Date.now()
  console.warn('[wallet-scan-worker] job started', { jobId: payload.jobId })
  resetAlchemyAudit()
  // SCAN-LEVEL RPC BUDGET RESET, DISCLOSED: same reasoning as resetAlchemyAudit() above — a warm
  // serverless instance serving a second, unrelated scan must start basedex's own RPC-call budget
  // fresh (see basedex.ts's resetBaseDexRpcBudgetForScan for the full reasoning), not inherit the
  // previous scan's exhausted counter.
  resetBaseDexRpcBudgetForScan()
  resetWalletProviderCostLedger()
  resetGoldrushPriceSourceCallCount()
  resetDexscreenerCallCount()
  resetCoingeckoCircuitBreaker()
  resetNativePriceResolverForScan()
  resetGeckoTerminalNoPoolCache()
  resetPricingAtTimeAdapterScanState()
  resetPriceCache()
  // JOB-ID THREADED, DISCLOSED (provider-coalescing follow-up task's explicit audit requirement):
  // lets fetchProviderWindow's own per-key audit log attribute its entries to the real job that
  // produced them — never used for any cache-key/coalescing decision (the canonical key stays
  // (chain, wallet) only).
  resetProviderFetchWindowRequestCache(payload.jobId)
  resetRecoveryHistoricalPageRequestCache()
  resetDexscreenerRequestCache()
  resetAlchemyHistoricalPricingState()

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

  const providerFetchWindowCounters = getProviderFetchWindowCoalescingCounters()
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] providerFetchWindow coalescing summary', {
    jobId: payload.jobId,
    ...providerFetchWindowCounters,
    // EXPLICIT NAMES, DISCLOSED (this task's own requested diagnostic names): restates the same
    // real counters above under the exact requested keys, so a "one live request maximum per
    // chain" audit can grep for them directly instead of needing to know this module's own
    // internal `liveFetches`/`settledReuseHits` naming.
    transactionHistoryLiveFetches: providerFetchWindowCounters.liveFetches,
    transactionHistorySettledReuseHits: providerFetchWindowCounters.settledReuseHits,
  })
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] dexscreener shared cache summary', { jobId: payload.jobId, ...getDexscreenerRequestDiagnostics() })
  // PER-KEY AUDIT, DISCLOSED (provider-coalescing follow-up task's explicit diagnostic requirement):
  // one compact record per (chain, wallet) key this job touched — proves directly, per key, whether
  // a duplicate live fetch was actually prevented, rather than only a process-wide aggregate.
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] providerFetchWindow per-key audit', { jobId: payload.jobId, keys: getProviderFetchWindowKeyAudits() })

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
  // UNCONDITIONAL, DISCLOSED (cost-audit task): logged on FAILURE as well as success — a scan that
  // died partway through is exactly the case where knowing what it already spent matters most, and
  // gating this on success would hide the runaway scans this diagnostic exists to catch.
  logWalletProviderCostAudit(goldrushCallSplitFrom(finalBody))
  // Unconditional (success or failure) durationMs log via console.warn — the single most direct
  // way to answer "how long did the whole worker actually take, and did it finish or throw" on the
  // next real attempt, regardless of outcome.
  console.warn('[wallet-scan-worker] job finished', { jobId: payload.jobId, completedSuccessfully, durationMs: jobState.durationMs })

  return { jobState, result: finalBody }
}

export async function runWalletScanWorker(req: Request): Promise<Response> {
  // ENTRY-TIME CAPTURE, DISCLOSED: see WalletWorkerTimingAudit's own header — this is the moment
  // prePipelineMs starts counting from, and jobDurationMs is measured against.
  const workerEntryAtMs = Date.now()
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
  const serializationStartMs = Date.now()
  try {
    serializableResult = toSerializableResult(result)
  } catch (err) {
    console.error('[wallet-scan-worker] result serialization failed', { jobId, error: err instanceof Error ? err.message : String(err) })
    await markJobFailed(jobId, jobState, 'worker_result_serialization_failed')
    return Response.json({ status: 'failed', jobId, resultPublished: false, error: 'worker_result_serialization_failed' }, { status: 500 })
  }
  const serializationMs = Date.now() - serializationStartMs

  let resultWriteMs = 0
  let jobStateWriteMs = 0
  try {
    await publishFinal(jobId, jobState, serializableResult, (rMs, jMs) => { resultWriteMs = rMs; jobStateWriteMs = jMs })
  } catch (err) {
    console.error('[wallet-scan-worker] result publication failed', { jobId, error: err instanceof Error ? err.message : String(err) })
    await markJobFailed(jobId, jobState, 'worker_result_publish_failed')
    return Response.json({ status: 'failed', jobId, resultPublished: false, error: 'worker_result_publish_failed' }, { status: 500 })
  }

  // TIMING AUDIT, DISCLOSED: see WalletWorkerTimingAudit's own header for the full disclosure — logs
  // unconditionally (console.warn survives the production console strip, same convention as every
  // other diagnostic in this file) on the success path, where the full span is meaningful.
  const jobDurationMs = Date.now() - workerEntryAtMs
  const prePipelineMs = Math.max(0, jobState.startedAt - workerEntryAtMs)
  const walletWorkerTimingAudit = buildWalletWorkerTimingAudit({
    jobDurationMs,
    pipelineMs: jobState.durationMs,
    prePipelineMs,
    resultWriteMs,
    jobStateWriteMs,
    serializationMs,
  })
  console.warn('[wallet-worker-timing-audit]', { jobId, ...walletWorkerTimingAudit })

  // UNREALIZED-PRICE-USAGE-AUDIT VISIBILITY, DISCLOSED (this task's own explicit requirement — "make
  // unrealizedPriceUsageAudit appear in logs/output"): the field already survives all the way into
  // `result`/`finalBody` (src/deployment/api.ts's SanitizedReportV2 already carries it through, and
  // src/pipeline/runWalletScanV2.ts already logs it once mid-scan under its own tag), but it was
  // never re-surfaced at THIS job's final summary point, next to the cost audit and the timing audit
  // above, where an operator reading one job's logs would actually look for it. Read-only extraction
  // from the already-built result — never a new computation, never a second measurement.
  const finalBody = result as { data?: Record<string, unknown> } | null | undefined
  const unrealizedPriceUsageAuditFromResult = finalBody?.data?.unrealizedPriceUsageAudit ?? null
  console.warn('[wallet-worker-unrealized-price-usage-audit]', { jobId, unrealizedPriceUsageAudit: unrealizedPriceUsageAuditFromResult })

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
