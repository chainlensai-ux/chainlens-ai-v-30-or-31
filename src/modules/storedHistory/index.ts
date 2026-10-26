// STORED WALLET HISTORY — orchestration (shadow mode).
//
// WALLET_STORED_HISTORY=shadow: after a wallet scan has PUBLISHED its result, the worker calls
// runStoredHistoryShadow. Per chain it takes the writer lease, loads the stored history, reads what is
// new (incremental, asc from the stored newest block minus a reorg margin), backfills older history
// with the remaining page budget (desc down from the stored oldest block), saves, and compares the
// stored history against the scan's OWN Alchemy fetch over the range both claim to cover. Nothing here
// feeds the scan result — users see exactly what they saw before. The log line [stored-history-shadow]
// is the evidence for whether stored history can be switched on.
//
// Off by default (unset / anything but 'shadow'). Requires the Supabase tables in
// supabase/wallet-history-store.sql.

import { alchemyRpcUrlFor } from '@/src/modules/providerFetchWindow/utils'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { STREAM_KEYS, applySegment, compareWithScan, completeRange, tsBoundsForRange, type ScanTransferLike, type ShadowComparison, type StoredHistory, type StreamKey } from './core'
import { fetchHeadBlock, fetchStreamSegment, type FetchLike, type SegmentResult } from './fetch'
import { createSupabaseHistoryStore, supabaseHistoryStoreAvailable, type HistoryStore } from './store'

export * from './core'

export type StoredHistoryMode = 'off' | 'shadow'
export function storedHistoryMode(env: Record<string, string | undefined> = process.env): StoredHistoryMode {
  return env.WALLET_STORED_HISTORY === 'shadow' ? 'shadow' : 'off'
}

/** Blocks re-read (and replaced) on every incremental update: covers realistic reorg depth. */
export const REORG_BLOCKS: Partial<Record<SupportedChain, number>> = { base: 300, eth: 64, arbitrum: 1200 }
/** Alchemy pages (up to 1000 transfers each) per stream per scan: incremental first, then backfill. */
export const STORED_HISTORY_PAGES_PER_STREAM = 4

export type ShadowChainReport = {
  chain: string
  status: 'updated' | 'locked' | 'no_alchemy' | 'no_head' | 'save_conflict' | 'save_error' | 'load_error' | 'skipped_deadline'
  calls: number
  newTransfers: number
  storedTransfers: number
  streams: Partial<Record<StreamKey, { oldest: number | null; newest: number | null; genesis: boolean; unsupported?: boolean; stop: string[] }>>
  completeFromMs: number | null
  completeToMs: number | null
  genesis: boolean
  comparison: ShadowComparison | null
}

export type ScanChainEvidence = { events: ReadonlyArray<ScanTransferLike>; coveredFromMs: number | null } | null

export async function runStoredHistoryShadowChain(input: {
  chain: SupportedChain
  wallet: string
  store: HistoryStore
  deadlineMs: number
  scan: ScanChainEvidence
  url?: string | null
  fetchImpl?: FetchLike
  now?: () => number
  pagesPerStream?: number
  /** Override the chain's reorg margin (tests). */
  reorgBlocks?: number
}): Promise<ShadowChainReport> {
  const now = input.now ?? Date.now
  const wallet = input.wallet.toLowerCase()
  const report: ShadowChainReport = { chain: input.chain, status: 'updated', calls: 0, newTransfers: 0, storedTransfers: 0, streams: {}, completeFromMs: null, completeToMs: null, genesis: false, comparison: null }
  const url = input.url !== undefined ? input.url : alchemyRpcUrlFor(input.chain)
  if (!url) return { ...report, status: 'no_alchemy' }
  if (input.deadlineMs - now() < 5000) return { ...report, status: 'skipped_deadline' }
  const lease = await input.store.acquire(input.chain, wallet, now())
  if (!lease) return { ...report, status: 'locked' }
  try {
    let before: StoredHistory
    try { before = await input.store.load(lease) } catch { return { ...report, status: 'load_error' } }
    const head = await fetchHeadBlock(url, input.fetchImpl)
    report.calls += 1
    if (head == null) return { ...report, status: 'no_head' }
    const reorg = input.reorgBlocks ?? REORG_BLOCKS[input.chain] ?? 300
    const pages = input.pagesPerStream ?? STORED_HISTORY_PAGES_PER_STREAM

    // Each stream reads independently (in parallel); segments are applied in order afterwards.
    const runStream = async (stream: StreamKey): Promise<{ stream: StreamKey; segments: SegmentResult[] }> => {
      const c = before.cursors[stream]
      if (c.unsupported) return { stream, segments: [] }
      const seg = (mode: SegmentResult['mode'], fromBlock: number, toBlock: number, maxPages: number) =>
        fetchStreamSegment({ url, wallet, stream, mode, fromBlock, toBlock, maxPages, deadlineMs: input.deadlineMs, fetchImpl: input.fetchImpl, now })
      if (c.oldest == null || c.newest == null) return { stream, segments: [await seg('initial', 0, head, pages)] }
      const segments: SegmentResult[] = []
      const inc = await seg('incremental', Math.max(0, c.newest - reorg), head, pages)
      segments.push(inc)
      const left = pages - inc.calls
      // Backfill only after the incremental read reached the head (never leave a fresh gap behind).
      if (!c.genesis && left > 0 && inc.exhausted) segments.push(await seg('backfill', 0, c.oldest, left))
      return { stream, segments }
    }
    const results = await Promise.all(STREAM_KEYS.map(runStream))
    let after = before
    for (const r of results) {
      const stops: string[] = []
      for (const s of r.segments) {
        report.calls += s.calls
        stops.push(`${s.mode}:${s.stopReason ?? 'none'}`)
        after = applySegment(after, s)
      }
      const c = after.cursors[r.stream]
      report.streams[r.stream] = { oldest: c.oldest, newest: c.newest, genesis: c.genesis, ...(c.unsupported ? { unsupported: true } : {}), stop: stops }
    }
    const beforeUids = new Set(before.transfers.map((t) => t.uid))
    report.newTransfers = after.transfers.filter((t) => !beforeUids.has(t.uid)).length
    report.storedTransfers = after.transfers.length

    const saved = await input.store.save(lease, before, after, now())
    if (saved !== 'saved') return { ...report, status: saved === 'conflict' ? 'save_conflict' : 'save_error' }

    const range = completeRange(after)
    if (range) {
      const b = tsBoundsForRange(after, range)
      report.genesis = range.genesis
      report.completeFromMs = range.genesis ? 0 : b.fromMs
      report.completeToMs = b.toMs
      if (input.scan) {
        report.comparison = compareWithScan({
          history: after,
          scanEvents: input.scan.events,
          scanCoveredFromMs: input.scan.coveredFromMs,
          storeCoveredFromMs: report.completeFromMs,
          storeCoveredToMs: b.toMs,
          nowMs: now(),
        })
      }
    }
    return report
  } finally {
    await input.store.release(lease)
  }
}

/** Shadow run for one finished scan. Never throws; logs one [stored-history-shadow] line per chain. */
export async function runStoredHistoryShadow(input: {
  wallet: string
  chains: ReadonlyArray<SupportedChain>
  budgetMs: number
  scanEvidence: (chain: SupportedChain) => Promise<ScanChainEvidence>
  store?: HistoryStore | null
  jobId?: string | null
}): Promise<ShadowChainReport[]> {
  if (storedHistoryMode() !== 'shadow') return []
  if (!input.store && !supabaseHistoryStoreAvailable()) return []
  const store = input.store ?? createSupabaseHistoryStore()
  if (!store) return []
  const deadlineMs = Date.now() + input.budgetMs
  const reports: ShadowChainReport[] = []
  for (const chain of input.chains) {
    try {
      const scan = await input.scanEvidence(chain).catch(() => null)
      const r = await runStoredHistoryShadowChain({ chain, wallet: input.wallet, store, deadlineMs, scan })
      reports.push(r)
      console.warn('[stored-history-shadow]', { jobId: input.jobId ?? null, wallet: input.wallet.toLowerCase(), ...r })
    } catch (err) {
      console.warn('[stored-history-shadow] failed', { jobId: input.jobId ?? null, chain, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return reports
}
