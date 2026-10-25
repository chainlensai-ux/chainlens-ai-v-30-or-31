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
  /**
   * Filled in by the core pipeline as each step starts and ends, so a scan cut off by the global
   * deadline can still report which steps finished, how long each took, and which were still running.
   */
  coreStageTrace?: CoreStageTrace
  /**
   * Current USD prices the holdings/portfolio snapshot resolved (fresh only), so the core scan values open
   * positions with the same prices the portfolio shows instead of depending on its own second lookup.
   * Resolves to null when the snapshot failed.
   */
  snapshotCurrentPrices?: Promise<SnapshotCurrentPrice[] | null>
}

/** One fresh current price from the portfolio snapshot; chain is the pipeline slug ('base' | 'eth'). */
export type SnapshotCurrentPrice = { chain: string; contract: string; priceUsd: number; source: string }

export type CoreStageTrace = {
  /** Total ms per finished step (a step that runs more than once accumulates). */
  done: Record<string, number>
  /** Steps currently running, with their Date.now() start. */
  open: Array<{ name: string; startedAt: number }>
  /** The most recently finished step and its Date.now() end, to spot time spent between steps. */
  lastFinished?: { name: string; endedAt: number }
}

export function createCoreStageTrace(): CoreStageTrace {
  return { done: {}, open: [] }
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

export function traceCoreStageStart(name: string): void {
  storage.getStore()?.coreStageTrace?.open.push({ name, startedAt: Date.now() })
}

export function traceCoreStageEnd(name: string): void {
  const trace = storage.getStore()?.coreStageTrace
  if (!trace) return
  const index = trace.open.findIndex((entry) => entry.name === name)
  if (index < 0) return
  const [entry] = trace.open.splice(index, 1)
  const endedAt = Date.now()
  trace.done[name] = (trace.done[name] ?? 0) + (endedAt - entry.startedAt)
  trace.lastFinished = { name, endedAt }
}

/**
 * Flat summary for the job's timing record: `core.<step>` = ms for finished steps,
 * `core.<step>.running` = ms so far for steps still open at `now`, and the last finished step with
 * how long ago it ended (time no traced step accounts for).
 */
export function summarizeCoreStageTrace(trace: CoreStageTrace, now = Date.now()): Record<string, number | string> {
  const summary: Record<string, number | string> = {}
  if (trace.lastFinished) {
    summary['core.lastFinished'] = trace.lastFinished.name
    summary['core.sinceLastFinishedMs'] = now - trace.lastFinished.endedAt
  }
  for (const [name, ms] of Object.entries(trace.done)) summary[`core.${name}`] = ms
  for (const { name, startedAt } of trace.open) {
    const key = `core.${name}.running`
    summary[key] = Math.max(Number(summary[key] ?? 0), now - startedAt)
  }
  return summary
}
