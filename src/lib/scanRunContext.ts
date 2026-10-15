// Per-scan run context, set by the queued worker (workers/walletScanV2.ts) around the core pipeline call
// and read inside it, so optional late-stage work can respect the worker's global deadline and wait for
// the holdings/portfolio snapshot to be published first. Absent for every other caller (routes, tests),
// in which case those stages keep their own budgets only.
import { AsyncLocalStorage } from 'node:async_hooks'

export type ScanRunContext = {
  /** Epoch ms at which the worker gives up on the core scan (worker_global_timeout). */
  deadlineAtMs: number
  /** Settles once the holdings/portfolio snapshot has been published (or could not be). */
  snapshotPublished?: Promise<unknown>
}

const storage = new AsyncLocalStorage<ScanRunContext>()

export function runWithScanContext<T>(context: ScanRunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn)
}

export function currentScanContext(): ScanRunContext | undefined {
  return storage.getStore()
}
