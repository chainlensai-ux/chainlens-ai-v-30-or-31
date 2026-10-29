// Older chart history already loaded in this browser session, keyed by one scan's exact chart data identity
// (lib/priceChartCandles.ts chartDataIdentity). PriceChartPanel unmounts whenever the Market tab is left, so
// keeping this in component state re-sent the same provider request every time the tab was opened again. Here a
// remount reads the history it already has — or the request still in flight — instead. A new scan or a new candle
// series has a new identity, so it never sees another scan's history. Nothing is stored beyond the page session.

export type ChartHistoryEntry<H, C> = {
  hist: H
  /** Candles of the one automatic batch (the default timeframe is re-chosen once over them), or null. */
  auto: C[] | null
  /** The automatic batch was started for this identity (it runs at most once per scan). */
  autoStarted: boolean
}

const MAX_ENTRIES = 24
const entries = new Map<string, ChartHistoryEntry<unknown, unknown>>()
const listeners = new Set<() => void>()

export function readChartHistory<H, C>(id: string): ChartHistoryEntry<H, C> | undefined {
  return entries.get(id) as ChartHistoryEntry<H, C> | undefined
}

/** Replaces the entry with a NEW object (stable snapshots for useSyncExternalStore) and notifies subscribers. */
export function writeChartHistory<H, C>(id: string, initial: H, patch: Partial<ChartHistoryEntry<H, C>>): void {
  const current = (entries.get(id) as ChartHistoryEntry<H, C> | undefined) ?? { hist: initial, auto: null, autoStarted: false }
  entries.delete(id)
  entries.set(id, { ...current, ...patch })
  // Oldest first in insertion order: drop the least recently written scans beyond the cap.
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!)
  for (const listener of [...listeners]) listener()
}

export function subscribeChartHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function __resetChartHistoryStoreForTest(): void {
  entries.clear()
  listeners.clear()
}
