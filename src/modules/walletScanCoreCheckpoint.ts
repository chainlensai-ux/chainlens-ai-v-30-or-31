// Core-scan checkpoint: lets the PnL follow-up job resume from the first job's core result instead of
// re-running the whole pipeline.
//
// When a job hits worker_global_timeout (270s) its core pipeline is still running — the timeout only
// stops waiting for it. The job publishes its partial result as before, then keeps the invocation
// alive until just before the platform limit; if the core result lands in that window it is stored
// here. The follow-up job (queued at the timeout) sees the pending marker, waits for the checkpoint,
// and runs only the post-core modules on it. Without a checkpoint it runs the core itself, as before.
import { kv } from '@/lib/server/kv'

const CHECKPOINT_TTL_SECONDS = 15 * 60
const POLL_INTERVAL_MS = 2_000
/** Extra time past the producer's stated deadline before the follow-up stops waiting. */
const WAIT_GRACE_MS = 3_000

export const walletScanCoreCheckpointKey = (jobId: string) => `walletScanCoreCheckpoint:${jobId}`
export const walletScanCoreCheckpointPendingKey = (jobId: string) => `walletScanCoreCheckpointPending:${jobId}`

type CheckpointRecord = { savedAt: number; result: unknown }
type PendingRecord = { until: number }

export type CoreCheckpointDeps = {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Tells a follow-up job that this job's core may still produce a checkpoint until `untilMs`. */
export async function markWalletScanCoreCheckpointPending(jobId: string, untilMs: number, now = Date.now()): Promise<void> {
  try {
    await kv.set(walletScanCoreCheckpointPendingKey(jobId), { until: untilMs } satisfies PendingRecord, { ex: Math.max(1, Math.ceil((untilMs - now) / 1000) + 10) })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[core-checkpoint] pending marker write failed', { jobId, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Ends the wait early (the core failed or ran out of time): the follow-up runs the core itself. */
export async function clearWalletScanCoreCheckpointPending(jobId: string): Promise<void> {
  try {
    await kv.set(walletScanCoreCheckpointPendingKey(jobId), { until: 0 } satisfies PendingRecord, { ex: 60 })
  } catch { /* the marker's own TTL ends the wait */ }
}

export async function saveWalletScanCoreCheckpoint(jobId: string, result: unknown, now = Date.now()): Promise<boolean> {
  try {
    await kv.set(walletScanCoreCheckpointKey(jobId), { savedAt: now, result } satisfies CheckpointRecord, { ex: CHECKPOINT_TTL_SECONDS })
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[core-checkpoint] save failed', { jobId, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * The stored core result of `jobId`, waiting while that job still says one may arrive. Null when there
 * is none and none is coming — the caller then runs the core itself.
 */
export async function waitForWalletScanCoreCheckpoint(jobId: string, deps: CoreCheckpointDeps = {}): Promise<unknown | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (;;) {
    let checkpoint: CheckpointRecord | null = null
    let pending: PendingRecord | null = null
    try {
      [checkpoint, pending] = await Promise.all([
        kv.get<CheckpointRecord>(walletScanCoreCheckpointKey(jobId)),
        kv.get<PendingRecord>(walletScanCoreCheckpointPendingKey(jobId)),
      ])
    } catch {
      return null
    }
    if (checkpoint && checkpoint.result != null) return checkpoint.result
    if (!pending || typeof pending.until !== 'number' || now() > pending.until + WAIT_GRACE_MS) return null
    await sleep(POLL_INTERVAL_MS)
  }
}
