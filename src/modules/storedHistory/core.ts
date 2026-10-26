// STORED WALLET HISTORY — pure core (no network, no storage).
//
// A wallet's transfer history kept between scans, so a rescan only fetches what is new and older
// history can be backfilled over several scans until the wallet's first transfer (genesis). This file
// holds the rules that make that history TRUSTWORTHY; fetching (fetch.ts) and persistence (store.ts)
// are separate and swappable.
//
// STREAMS. History is read per stream, each with its own coverage cursor:
//   from        erc20 + external native the wallet SENT
//   to          erc20 + external native the wallet RECEIVED
//   toInternal  native received from contracts (e.g. sale proceeds) — optional: some chains do not
//               support Alchemy's `internal` category; that stream is then marked unsupported and never
//               blocks the other two.
//
// CURSOR INVARIANT (the whole point): for a stream with cursor { oldest, newest }, EVERY transfer of
// that stream with block in [oldest, newest] is stored. Nothing is ever claimed outside that range:
//   - a page sequence that stops early (budget, deadline, error) may have read only part of its last
//     block, so that block is never claimed — the cursor moves to the last FULLY read block;
//   - a stream with no stored cursor claims nothing;
//   - genesis is set only when the provider returned no further page for a range reaching block 0.
// Boundary blocks are re-read inclusively on the next fetch and deduplicated by Alchemy's uniqueId.
//
// REORGS. Each incremental update re-reads the newest `reorgBlocks` blocks and REPLACES the stored
// transfers of that stream in the re-read range, so a transfer dropped by a reorg disappears.

export type StreamKey = 'from' | 'to' | 'toInternal'
export const STREAM_KEYS: readonly StreamKey[] = ['from', 'to', 'toInternal']
/** Streams that must be covered for the history to describe the wallet's trades. */
export const REQUIRED_STREAMS: readonly StreamKey[] = ['from', 'to']

export const STORED_HISTORY_VERSION = 1

export type StoredTransfer = {
  /** Alchemy uniqueId (tx hash + log/trace position) — the dedupe key. */
  uid: string
  block: number
  ts: string | null
  hash: string | null
  from: string | null
  to: string | null
  /** Token contract; null for native. */
  contract: string | null
  asset: string | null
  category: string
  /** Raw integer amount as a decimal string. */
  amountRaw: string | null
  decimals: number | null
  stream: StreamKey
}

export type StreamCursor = {
  oldest: number | null
  newest: number | null
  genesis: boolean
  /** True when the provider rejected this stream's category on this chain (only `toInternal`). */
  unsupported?: boolean
}

export type StoredHistory = {
  version: number
  chain: string
  wallet: string
  /** Optimistic-concurrency revision, bumped on every save. */
  rev: number
  cursors: Record<StreamKey, StreamCursor>
  /** Sorted by block, then uid. */
  transfers: StoredTransfer[]
  updatedAt: string | null
}

export const EMPTY_CURSOR: StreamCursor = { oldest: null, newest: null, genesis: false }

export function emptyHistory(chain: string, wallet: string): StoredHistory {
  return {
    version: STORED_HISTORY_VERSION, chain, wallet: wallet.toLowerCase(), rev: 0,
    cursors: { from: { ...EMPTY_CURSOR }, to: { ...EMPTY_CURSOR }, toInternal: { ...EMPTY_CURSOR } },
    transfers: [], updatedAt: null,
  }
}

/** A contiguous read of one stream, as returned by the fetcher. */
export type FetchedSegment = {
  stream: StreamKey
  /** desc from a head block ('initial'), asc from a start block ('incremental'), desc down from a block ('backfill'). */
  mode: 'initial' | 'incremental' | 'backfill'
  /** The block range that was requested (inclusive). */
  fromBlock: number
  toBlock: number
  transfers: StoredTransfer[]
  /** The provider returned no further page: the whole requested range was read. */
  exhausted: boolean
  /** The provider rejected the category on this chain (no rows, nothing claimed). */
  unsupported?: boolean
}

const byBlock = (a: StoredTransfer, b: StoredTransfer) => a.block - b.block || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)

function blockRange(rows: ReadonlyArray<StoredTransfer>): { min: number; max: number } | null {
  if (rows.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const r of rows) { if (r.block < min) min = r.block; if (r.block > max) max = r.block }
  return { min, max }
}

/**
 * The fully-read block range of a segment. A segment that stopped early may have read only part of
 * the block at its far end, so that block is excluded. Null = nothing can be claimed.
 */
export function segmentCoverage(seg: FetchedSegment): { from: number; to: number } | null {
  if (seg.unsupported) return null
  if (seg.exhausted) return { from: seg.fromBlock, to: seg.toBlock }
  const r = blockRange(seg.transfers)
  if (!r) return null
  if (seg.mode === 'incremental') {
    // asc: read from fromBlock upward; the highest block seen may be partial.
    const to = r.max - 1
    return to >= seg.fromBlock ? { from: seg.fromBlock, to } : null
  }
  // desc ('initial' / 'backfill'): read from toBlock downward; the lowest block seen may be partial.
  const from = r.min + 1
  return from <= seg.toBlock ? { from, to: seg.toBlock } : null
}

/**
 * Applies one fetched segment to a history. Pure: returns a new history. A segment that cannot be
 * proven contiguous with the stored range never extends the cursor (its rows are still kept, as
 * unclaimed data, so a later read can complete the range).
 */
export function applySegment(history: StoredHistory, seg: FetchedSegment): StoredHistory {
  const cursor = history.cursors[seg.stream]
  if (seg.unsupported) {
    return { ...history, cursors: { ...history.cursors, [seg.stream]: { ...cursor, unsupported: true } } }
  }
  const cov = segmentCoverage(seg)
  let transfers = history.transfers
  // Incremental re-read: replace this stream's stored rows in the fully re-read range (reorg safety).
  if (seg.mode === 'incremental' && cov) {
    transfers = transfers.filter((t) => !(belongsToStream(t, seg.stream, history.wallet) && t.block >= cov.from && t.block <= cov.to))
  }
  transfers = mergeTransfers(transfers, seg.transfers)

  let next: StreamCursor = { ...cursor }
  if (cov) {
    const genesisReached = seg.exhausted && seg.mode !== 'incremental' && seg.fromBlock === 0
    if (cursor.oldest == null || cursor.newest == null) {
      // First read of this stream: only a read anchored at the head ('initial') may start a cursor.
      if (seg.mode === 'initial') next = { oldest: genesisReached ? 0 : cov.from, newest: cov.to, genesis: genesisReached }
    } else if (seg.mode === 'incremental') {
      // Contiguous only if the re-read started at or below the stored newest block (+1).
      if (cov.from <= cursor.newest + 1) next = { ...cursor, newest: Math.max(cursor.newest, cov.to) }
    } else if (seg.mode === 'backfill') {
      // Contiguous only if the read reached up to (at least) the block just below the stored oldest.
      if (cov.to >= cursor.oldest - 1) next = { ...cursor, oldest: Math.min(cursor.oldest, genesisReached ? 0 : cov.from), genesis: cursor.genesis || genesisReached }
    } else if (seg.mode === 'initial') {
      // A fresh head read over an existing cursor: extend newest when contiguous, never shrink.
      if (cov.from <= cursor.newest + 1) next = { ...cursor, newest: Math.max(cursor.newest, cov.to), oldest: Math.min(cursor.oldest, genesisReached ? 0 : cov.from), genesis: cursor.genesis || genesisReached }
    }
  }
  return { ...history, cursors: { ...history.cursors, [seg.stream]: next }, transfers }
}

/** A transfer belongs to the stream whose query would return it. */
export function belongsToStream(t: StoredTransfer, stream: StreamKey, wallet: string): boolean {
  const w = wallet.toLowerCase()
  if (stream === 'from') return t.from === w && t.category !== 'internal'
  if (stream === 'to') return t.to === w && t.category !== 'internal'
  return t.to === w && t.category === 'internal'
}

/** Union by uid; the incoming copy wins. Sorted by block, then uid. */
export function mergeTransfers(stored: ReadonlyArray<StoredTransfer>, incoming: ReadonlyArray<StoredTransfer>): StoredTransfer[] {
  const byUid = new Map<string, StoredTransfer>()
  for (const t of stored) byUid.set(t.uid, t)
  for (const t of incoming) byUid.set(t.uid, t)
  return [...byUid.values()].sort(byBlock)
}

/**
 * The block range over which the stored history is complete for the wallet's trades: the
 * intersection of the required streams' cursors. Null when any required stream has no cursor.
 */
export function completeRange(history: StoredHistory): { oldest: number; newest: number; genesis: boolean } | null {
  let oldest = -Infinity
  let newest = Infinity
  let genesis = true
  for (const k of REQUIRED_STREAMS) {
    const c = history.cursors[k]
    if (c.oldest == null || c.newest == null) return null
    oldest = Math.max(oldest, c.oldest)
    newest = Math.min(newest, c.newest)
    genesis = genesis && c.genesis
  }
  return oldest <= newest ? { oldest, newest, genesis } : null
}

/** Storage chunk key: the transfer's UTC month ('YYYY-MM'), or 'undated'. */
export function chunkKeyFor(t: StoredTransfer): string {
  const ms = t.ts ? Date.parse(t.ts) : Number.NaN
  if (!Number.isFinite(ms)) return 'undated'
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function chunkTransfers(transfers: ReadonlyArray<StoredTransfer>): Map<string, StoredTransfer[]> {
  const out = new Map<string, StoredTransfer[]>()
  for (const t of transfers) {
    const k = chunkKeyFor(t)
    const list = out.get(k)
    if (list) list.push(t)
    else out.set(k, [t])
  }
  return out
}

/** Chunk keys whose content differs between two histories (added, removed or changed rows). */
export function dirtyChunks(before: ReadonlyArray<StoredTransfer>, after: ReadonlyArray<StoredTransfer>): string[] {
  const sig = (rows: ReadonlyArray<StoredTransfer>) => {
    const m = new Map<string, string[]>()
    for (const t of rows) {
      const k = chunkKeyFor(t)
      const entry = `${t.uid}|${t.block}|${t.amountRaw}|${t.from}|${t.to}`
      const list = m.get(k)
      if (list) list.push(entry)
      else m.set(k, [entry])
    }
    return new Map([...m.entries()].map(([k, v]) => [k, v.sort().join('\n')]))
  }
  const a = sig(before)
  const b = sig(after)
  const keys = new Set([...a.keys(), ...b.keys()])
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort()
}

// ── Shadow comparison ───────────────────────────────────────────────────────────────────────────

export type ScanTransferLike = { txHash: string | null; contract: string | null; fromAddress: string | null; toAddress: string | null; amountRaw: string | null; timestamp: string | null }

export function transferMatchKey(t: { hash: string | null; contract: string | null; from: string | null; to: string | null; amountRaw: string | null }): string {
  return [t.hash ?? '', t.contract ?? 'native', t.from ?? '', t.to ?? '', t.amountRaw ?? ''].map((x) => x.toLowerCase()).join('|')
}

export type ShadowComparison = {
  windowStartMs: number | null
  windowEndMs: number | null
  scanTransfers: number
  storedTransfers: number
  matched: number
  /** In the scan's own fetch but not in the stored history: the number that must stay at 0. */
  missingFromStore: number
  /** Stored but not in the scan's fetch (the scan may have dropped them, e.g. its own event cap). */
  extraInStore: number
  sampleMissing: string[]
}

/**
 * Compares the stored history with the scan's own fetched transfers over the time range BOTH claim
 * to cover completely, trimmed by `edgeMarginMs` at each end (block-time edges are approximate).
 */
export function compareWithScan(input: {
  history: StoredHistory
  scanEvents: ReadonlyArray<ScanTransferLike>
  scanCoveredFromMs: number | null
  storeCoveredFromMs: number | null
  storeCoveredToMs: number | null
  nowMs: number
  edgeMarginMs?: number
}): ShadowComparison {
  const margin = input.edgeMarginMs ?? 60 * 60_000
  const empty: ShadowComparison = { windowStartMs: null, windowEndMs: null, scanTransfers: 0, storedTransfers: 0, matched: 0, missingFromStore: 0, extraInStore: 0, sampleMissing: [] }
  if (input.scanCoveredFromMs == null || input.storeCoveredFromMs == null || input.storeCoveredToMs == null) return empty
  const start = Math.max(input.scanCoveredFromMs, input.storeCoveredFromMs) + margin
  const end = Math.min(input.nowMs, input.storeCoveredToMs) - margin
  if (!(end > start)) return { ...empty, windowStartMs: start, windowEndMs: end }
  const inWindow = (ts: string | null) => { const ms = ts ? Date.parse(ts) : Number.NaN; return Number.isFinite(ms) && ms >= start && ms <= end }
  const scanKeys = new Map<string, number>()
  for (const e of input.scanEvents) {
    if (!inWindow(e.timestamp)) continue
    const k = transferMatchKey({ hash: e.txHash, contract: e.contract, from: e.fromAddress, to: e.toAddress, amountRaw: e.amountRaw })
    scanKeys.set(k, (scanKeys.get(k) ?? 0) + 1)
  }
  const storeKeys = new Map<string, number>()
  for (const t of input.history.transfers) {
    if (!inWindow(t.ts)) continue
    const k = transferMatchKey(t)
    storeKeys.set(k, (storeKeys.get(k) ?? 0) + 1)
  }
  let matched = 0
  let missing = 0
  const sample: string[] = []
  for (const [k, n] of scanKeys) {
    const have = storeKeys.get(k) ?? 0
    matched += Math.min(n, have)
    if (have < n) { missing += n - have; if (sample.length < 5) sample.push(k.split('|')[0]) }
  }
  let scanTotal = 0
  for (const n of scanKeys.values()) scanTotal += n
  let storeTotal = 0
  for (const n of storeKeys.values()) storeTotal += n
  return { windowStartMs: start, windowEndMs: end, scanTransfers: scanTotal, storedTransfers: storeTotal, matched, missingFromStore: missing, extraInStore: Math.max(0, storeTotal - matched), sampleMissing: sample }
}

/** Timestamp (ms) of the oldest / newest stored transfer at or inside a block bound — for logging and comparison. */
export function tsBoundsForRange(history: StoredHistory, range: { oldest: number; newest: number }): { fromMs: number | null; toMs: number | null } {
  let fromMs: number | null = null
  let toMs: number | null = null
  for (const t of history.transfers) {
    if (t.block < range.oldest || t.block > range.newest) continue
    const ms = t.ts ? Date.parse(t.ts) : Number.NaN
    if (!Number.isFinite(ms)) continue
    if (fromMs == null || ms < fromMs) fromMs = ms
    if (toMs == null || ms > toMs) toMs = ms
  }
  return { fromMs, toMs }
}
