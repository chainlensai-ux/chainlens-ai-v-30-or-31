// Heavy-wallet follow-up job. When the V2 worker defers its analysis modules for a wallet with a
// very large history (workers/walletScanV2.ts, pnlStatus 'deferred_heavy_wallet'), the first job
// still publishes holdings / portfolio / core FIFO straight away, and this enqueues a second job
// for the same wallet that runs every module (it never defers again). The follow-up's id is put on
// the first result so the page can show "PnL still processing" and poll it. Robinhood is not
// re-scanned: the follow-up reuses the first job's stored Robinhood result (workers/walletScanV2.ts,
// HEAVY_WALLET_FOLLOW_UP_ROBINHOOD_REUSE_MS), so its canonical totals still include it.
import { enqueueWalletScanJob, type WalletScanJobPayload } from '@/src/modules/walletScanQueue'

export const HEAVY_WALLET_DEFERRED_PNL_STATUS = 'deferred_heavy_wallet'

type ResultBody = { success?: boolean; data?: Record<string, unknown>; partial?: boolean; partialSnapshotPublished?: boolean; error?: { message?: string } }

/** The core scan hit worker_global_timeout after the holdings/portfolio snapshot was published. */
function isTimedOutAfterSnapshot(result: ResultBody | null): boolean {
  return !!result && result.success === false && result.partial === true && result.partialSnapshotPublished === true
    && result.error?.message === 'worker_global_timeout'
}

export async function attachHeavyWalletFollowUp(
  body: unknown,
  payload: WalletScanJobPayload,
  enqueue: (jobId: string, payload: WalletScanJobPayload) => Promise<void> = enqueueWalletScanJob,
  newJobId: () => string = () => crypto.randomUUID(),
  /** This job's core is still running and may leave a checkpoint the follow-up can resume from. */
  coreCheckpointPending = false,
): Promise<unknown> {
  if (payload.heavyWalletFollowUp) return body
  const result = body as ResultBody | null
  // TIMEOUT AFTER SNAPSHOT: the page keeps the published snapshot with "PnL still processing" and polls
  // a follow-up job (it never queues another). When this job's core may still finish, the follow-up
  // resumes from its checkpoint instead of re-running the scan (src/modules/walletScanCoreCheckpoint.ts).
  if (isTimedOutAfterSnapshot(result)) {
    const followUpJobId = newJobId()
    try {
      await enqueue(followUpJobId, { ...payload, jobId: followUpJobId, heavyWalletFollowUp: true, ...(coreCheckpointPending ? { resumeCoreFromJobId: payload.jobId } : {}) })
      // eslint-disable-next-line no-console
      console.warn('[heavy-wallet-follow-up] queued after global timeout', { jobId: payload.jobId, followUpJobId })
      return { ...result, pnlStillProcessing: true, pnlFollowUpJobId: followUpJobId }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[heavy-wallet-follow-up] enqueue after timeout failed', { jobId: payload.jobId, error: err instanceof Error ? err.message : String(err) })
      return { ...result, pnlStillProcessing: false, pnlFollowUpJobId: null }
    }
  }
  if (!result || result.success !== true || !result.data || result.data.pnlStatus !== HEAVY_WALLET_DEFERRED_PNL_STATUS) return body

  const deferral = (result.data.heavyWalletDeferral ?? {}) as Record<string, unknown>
  const followUpJobId = newJobId()
  try {
    await enqueue(followUpJobId, {
      ...payload,
      jobId: followUpJobId,
      heavyWalletFollowUp: true,
    })
    // eslint-disable-next-line no-console
    console.warn('[heavy-wallet-follow-up] queued', { jobId: payload.jobId, followUpJobId })
    return { ...result, data: { ...result.data, pnlFollowUpJobId: followUpJobId, heavyWalletDeferral: { ...deferral, followUp: 'queued' } } }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[heavy-wallet-follow-up] enqueue failed', { jobId: payload.jobId, error: err instanceof Error ? err.message : String(err) })
    return { ...result, data: { ...result.data, pnlFollowUpJobId: null, heavyWalletDeferral: { ...deferral, followUp: 'enqueue_failed' } } }
  }
}
