import { isRedisRestRateLimited, isRedisRestTimeout, logRedisRestError, logRedisRestUsageDiagnostics, redis, redisConfigured } from '@/lib/server/cache/redisClient'
import {
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueueKeys'

export {
  walletScanJobKey,
  walletScanPendingJobKey,
  walletScanPendingKey,
  walletScanResultKey,
} from '@/src/modules/walletScanQueueKeys'

export type WalletScanJobStatus = 'queued' | 'running' | 'done' | 'failed'
export type WalletScanDegradedModule = 'holdings' | 'provider-window' | 'final-publish' | 'job-status'
export type WalletScanKvWriteOutcome = { ok: boolean; degraded: boolean; partial: boolean; failedKeys: string[]; reason?: string }

export type WalletScanJobMetadata = {
  jobId: string
  wallet: string
  status: WalletScanJobStatus
  createdAt: number
  updatedAt: number
  chains?: string[]
  scanMode?: 'normal' | 'deep'
  ip?: string
  error?: string
  finishedAt?: number
}

export type WalletScanJobPayload = {
  jobId: string
  walletAddress: string
  chains: string[]
  scanMode: 'normal' | 'deep'
  ip: string
}

const JOB_TTL_SECONDS = 30 * 60

const KV_WRITE_BACKOFF_MS = [50, 100, 200, 400] as const
let adaptiveHoldingsBatchSize = 50
let adaptiveProviderWindowBatchSize = 50

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAdaptiveKvWriteError(err: unknown): boolean {
  if (isRedisRestTimeout(err) || isRedisRestRateLimited(err)) return true
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return message.includes('kv_timeout_safe') || message.includes('budget_exceeded')
}

function reduceAdaptiveKvBatchSizes(reason: string): void {
  adaptiveHoldingsBatchSize = Math.max(1, Math.floor(adaptiveHoldingsBatchSize / 2))
  adaptiveProviderWindowBatchSize = Math.max(1, Math.floor(adaptiveProviderWindowBatchSize / 2))
  console.warn('[wallet-scan-kv] adaptive batch size reduced', {
    reason,
    holdingsBatchSize: adaptiveHoldingsBatchSize,
    providerWindowBatchSize: adaptiveProviderWindowBatchSize,
    partialWriteMode: true,
  })
}

function degradedResultBody(result: unknown, outcome: WalletScanKvWriteOutcome): unknown {
  if (!outcome.degraded || !result || typeof result !== 'object') return result
  const record = result as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : undefined
  const kvDegraded = {
    degraded: true,
    partialWrite: outcome.partial,
    failedKeys: outcome.failedKeys,
    reason: outcome.reason ?? 'kv_write_degraded',
  }
  return {
    ...record,
    degraded: true,
    kvDegraded,
    data: data ? {
      ...data,
      degraded: true,
      kvDegraded,
      moduleErrors: {
        ...(data.moduleErrors && typeof data.moduleErrors === 'object' ? data.moduleErrors as Record<string, unknown> : {}),
        kvWrites: outcome.reason ?? 'kv_write_degraded',
      },
      degradedModules: Array.from(new Set([...
        (Array.isArray(data.degradedModules) ? data.degradedModules.filter((m): m is string => typeof m === 'string') : []),
        'holdings',
        'provider-window',
      ])),
    } : undefined,
  }
}

async function adaptiveCriticalSet(key: string, value: unknown): Promise<void> {
  for (let attempt = 0; attempt <= KV_WRITE_BACKOFF_MS.length; attempt++) {
    try {
      await redis.setCritical(key, value)
      return
    } catch (err) {
      if (!isAdaptiveKvWriteError(err) || attempt === KV_WRITE_BACKOFF_MS.length) throw err
      const reason = err instanceof Error ? err.message : String(err)
      reduceAdaptiveKvBatchSizes(reason)
      logRedisRestUsageDiagnostics('[wallet-scan-kv] adaptive retry diagnostics', err)
      await sleep(KV_WRITE_BACKOFF_MS[attempt])
    }
  }
}

async function publishCriticalWritesPartial(writes: Array<{ key: string; value: unknown }>): Promise<WalletScanKvWriteOutcome> {
  const failedKeys: string[] = []
  let reason: string | undefined
  for (const write of writes) {
    try {
      await adaptiveCriticalSet(write.key, write.value)
    } catch (err) {
      failedKeys.push(write.key)
      reason = err instanceof Error ? err.message : String(err)
      if (isAdaptiveKvWriteError(err)) {
        reduceAdaptiveKvBatchSizes(reason)
        console.warn('[wallet-scan-kv] partial-write mode retained after rate-limit failure', { key: write.key, reason })
      } else {
        logQueueFailure('[wallet-scan-kv] partial-write failure', err)
      }
    }
  }
  return { ok: failedKeys.length === 0, degraded: failedKeys.length > 0, partial: failedKeys.length > 0 && failedKeys.length < writes.length, failedKeys, reason }
}

export const WALLET_SCAN_QUEUE_UNAVAILABLE = { error: 'scan-queue-unavailable', degraded: true } as const
export const WALLET_SCAN_STATUS_UNAVAILABLE = { error: 'scan-status-unavailable', degraded: true } as const
export const WALLET_SCAN_FINAL_RESULT_UNAVAILABLE = { error: 'scan-final-result-unavailable', degraded: true } as const

export class WalletScanQueueUnavailableError extends Error {
  constructor(message = 'scan-queue-unavailable') {
    super(message)
    this.name = 'WalletScanQueueUnavailableError'
  }
}

export class WalletScanStatusUnavailableError extends Error {
  constructor(message = 'scan-status-unavailable') {
    super(message)
    this.name = 'WalletScanStatusUnavailableError'
  }
}

export function walletScanRedisConfigured(): boolean {
  return redisConfigured()
}

function assertWalletScanRedisConfigured(kind: 'queue' | 'status'): void {
  if (walletScanRedisConfigured()) return
  if (kind === 'queue') throw new WalletScanQueueUnavailableError('Upstash Redis REST is not configured')
  throw new WalletScanStatusUnavailableError('Upstash Redis REST is not configured')
}

function queueUnavailable(err: unknown): WalletScanQueueUnavailableError {
  return err instanceof WalletScanQueueUnavailableError
    ? err
    : new WalletScanQueueUnavailableError(err instanceof Error ? err.message : String(err))
}

function statusUnavailable(err: unknown): WalletScanStatusUnavailableError {
  return err instanceof WalletScanStatusUnavailableError
    ? err
    : new WalletScanStatusUnavailableError(err instanceof Error ? err.message : String(err))
}

export function walletScanResultMissingFallback(jobId: string, job: WalletScanJobMetadata | null): unknown {
  void jobId
  void job
  return WALLET_SCAN_FINAL_RESULT_UNAVAILABLE
}

function logQueueFailure(label: string, err: unknown): void {
  logRedisRestError(label, err)
}

export async function publishFinalWalletScanResult(jobId: string, result: unknown): Promise<unknown | void> {
  const finishedAt = Date.now()
  const finalJob = { jobId, status: 'done' as const, finishedAt }
  const finalResult = result ?? walletScanResultMissingFallback(jobId, null)
  console.log('[final-publish] start', { jobId })

  if (!walletScanRedisConfigured()) {
    console.error('[final-publish] unavailable', { jobId, reason: 'Upstash Redis REST is not configured' })
    return WALLET_SCAN_FINAL_RESULT_UNAVAILABLE
  }

  const firstOutcome = await publishCriticalWritesPartial([
    { key: walletScanResultKey(jobId), value: finalResult },
    { key: walletScanJobKey(jobId), value: finalJob },
  ])
  if (firstOutcome.ok) {
    console.log('[final-publish] success', { jobId, client: 'rest' })
    return
  }

  const degradedFinalResult = degradedResultBody(finalResult, firstOutcome)
  const retryOutcome = await publishCriticalWritesPartial([
    ...(firstOutcome.failedKeys.includes(walletScanResultKey(jobId)) ? [{ key: walletScanResultKey(jobId), value: degradedFinalResult }] : []),
    ...(firstOutcome.failedKeys.includes(walletScanJobKey(jobId)) ? [{ key: walletScanJobKey(jobId), value: { ...finalJob, degraded: true, error: firstOutcome.reason } }] : []),
  ])

  if (retryOutcome.ok) {
    console.warn('[final-publish] degraded success', { jobId, failedKeys: firstOutcome.failedKeys, reason: firstOutcome.reason })
    return firstOutcome
  }

  console.error('[final-publish] degraded partial failure', { jobId, failedKeys: retryOutcome.failedKeys, reason: retryOutcome.reason })
  return { ...WALLET_SCAN_FINAL_RESULT_UNAVAILABLE, finalResult: degradedFinalResult, kvWrite: retryOutcome }
}

export async function writeWalletScanJob(job: WalletScanJobMetadata): Promise<void> {
  assertWalletScanRedisConfigured('queue')
  try {
    await redis.set(walletScanJobKey(job.jobId), { ...job, updatedAt: Date.now() }, { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] write-job-failure', err)
    throw queueUnavailable(err)
  }
}

export async function readWalletScanJob(jobId: string): Promise<WalletScanJobMetadata | null> {
  assertWalletScanRedisConfigured('status')
  try {
    return await redis.get<WalletScanJobMetadata>(walletScanJobKey(jobId))
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] read-job-failure', err)
    throw statusUnavailable(err)
  }
}

export async function readWalletScanResult(jobId: string): Promise<unknown | null> {
  assertWalletScanRedisConfigured('status')
  try {
    return await redis.get(walletScanResultKey(jobId))
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] read-result-failure', err)
    throw statusUnavailable(err)
  }
}


export async function claimNextWalletScanPayload(): Promise<WalletScanJobPayload | null> {
  assertWalletScanRedisConfigured('queue')
  let pending: string[]
  try {
    pending = (await redis.get<string[]>(walletScanPendingKey())) ?? []
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] claim-read-pending-failure', err)
    if (isRedisRestTimeout(err)) console.warn('[wallet-scan-worker] queue claim network timeout', { error: 'scan-queue-unavailable', degraded: true })
    throw queueUnavailable(err)
  }
  const [jobId, ...remaining] = pending
  if (!jobId) return null

  try { await redis.set(walletScanPendingKey(), remaining, { ex: JOB_TTL_SECONDS }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-pending-failure', err); if (isRedisRestTimeout(err)) console.warn('[wallet-scan-worker] queue claim network timeout', { error: 'scan-queue-unavailable', degraded: true }); throw queueUnavailable(err) }

  const job = await readWalletScanJob(jobId).catch((err) => { throw queueUnavailable(err) })
  if (!job) return null

  try { await redis.set(walletScanPendingJobKey(jobId), false, { ex: 60 }) } catch (err) { logQueueFailure('[wallet-scan-queue] claim-write-pending-job-failure', err); if (isRedisRestTimeout(err)) console.warn('[wallet-scan-worker] queue claim network timeout', { error: 'scan-queue-unavailable', degraded: true }); throw queueUnavailable(err) }

  return {
    jobId,
    walletAddress: job.wallet,
    chains: job.chains ?? ['base', 'eth'],
    scanMode: job.scanMode ?? 'normal',
    ip: job.ip ?? 'unknown',
  }
}

async function triggerWalletScanWorker(): Promise<void> {
  try {
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000'

    await fetch(`${base}/api/wallet-scan/worker`, { method: 'POST' })
  } catch (err) {
    // Enqueue must stay lightweight and never run the scan inline. If the trigger fails, the
    // persisted pending job remains in KV for the next worker invocation/retry.
    console.warn('[walletScanQueue] failed to trigger background worker', { err: err instanceof Error ? err.message : String(err) })
  }
}

export async function enqueueWalletScanJob(jobId: string, payload: WalletScanJobPayload): Promise<void> {
  assertWalletScanRedisConfigured('queue')
  const now = Date.now()
  await writeWalletScanJob({
    jobId,
    wallet: payload.walletAddress,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    chains: payload.chains,
    scanMode: payload.scanMode,
    ip: payload.ip,
  })
  try {
    await redis.set(walletScanPendingJobKey(jobId), true, { ex: JOB_TTL_SECONDS })
    const pending = (await redis.get<string[]>(walletScanPendingKey())) ?? []
    await redis.set(walletScanPendingKey(), [...new Set([...pending, jobId])], { ex: JOB_TTL_SECONDS })
  } catch (err) {
    logQueueFailure('[wallet-scan-queue] enqueue-pending-failure', err)
    throw queueUnavailable(err)
  }
  await triggerWalletScanWorker()
}
