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
  /**
   * Settles once Robinhood's verified native-ETH days have had first use of the shared historical
   * price quota (CoinGecko breaker / native resolver). Historical-price calls made inside the core
   * scan wait on it; everything else in the scan runs without waiting.
   */
  historicalPricePriority?: Promise<void>
}

const storage = new AsyncLocalStorage<ScanRunContext>()

export function runWithScanContext<T>(context: ScanRunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn)
}

export function currentScanContext(): ScanRunContext | undefined {
  return storage.getStore()
}

/** Waits for the scan's historical-price priority gate, if this call runs inside a gated scan. */
export async function awaitHistoricalPricePriority(): Promise<void> {
  const gate = storage.getStore()?.historicalPricePriority
  if (gate) await gate
}
