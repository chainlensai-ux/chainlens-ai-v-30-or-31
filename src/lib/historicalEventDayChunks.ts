// src/lib/historicalEventDayChunks.ts — extends a busy wallet's history backwards across scans.
//
// A page-capped scan of a busy wallet reads only its newest few days (snapped to a UTC midnight by
// snapNarrowedWindowStart). Every whole UTC day inside that freshly read range is complete — the
// provider returned every transfer of it — so it is stored as one chunk per day, and the day is
// recorded as complete. The next scan reads its own fresh days again and then walks backwards
// through stored complete days, stopping at the first missing day: the stitched window is always
// one contiguous run of complete days, so it is as proven as a window a single scan read itself.
//
// Bounded on every axis: days are only stored when the chain's providers answered fully, a day
// with more than MAX_EVENTS_PER_DAY_CHUNK events is not stored (KV value size), stitching never
// reaches past the configured window, and the total event count (fresh + stitched) is capped so
// the scan stays inside its time budget. Nothing is invented: only real provider events a scan
// returned are stored, and a first scan stitches nothing.

import type { RawProviderEvent, SupportedChain } from '../modules/providerFetchWindow/types'

export const DAY_CHUNK_VERSION = 1 as const
const DAY_MS = 24 * 60 * 60 * 1000
/** ~300 bytes per compact event: keeps one day's chunk well under a 1 MB KV value. */
export const MAX_EVENTS_PER_DAY_CHUNK = 3_000
/** Fresh + stitched events per scan. Scan time grows with events; ~13k events took ~90s of a 270s budget. */
export const DEFAULT_STITCH_MAX_TOTAL_EVENTS = 24_000

export function stitchMaxTotalEvents(): number {
  const configured = Number.parseInt(process.env.WALLET_HISTORY_STITCH_MAX_EVENTS ?? '', 10)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STITCH_MAX_TOTAL_EVENTS
}

export function historyStitchEnabled(): boolean {
  return process.env.WALLET_HISTORY_STITCH !== '0'
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

export function dayIndexKey(wallet: string, chain: string): string {
  return `historical-days:v${DAY_CHUNK_VERSION}:${wallet.toLowerCase()}:${chain}:index`
}

export function dayChunkKey(wallet: string, chain: string, day: string): string {
  return `historical-days:v${DAY_CHUNK_VERSION}:${wallet.toLowerCase()}:${chain}:${day}`
}

/** Complete days only: day → event count stored for it. */
export type DayIndex = { v: typeof DAY_CHUNK_VERSION; days: Record<string, number> }

// Compact row: [txHash, timestamp, from, to, contract, symbol, amountRaw, decimals, provider]
type CompactEvent = [string, string, string, string, string, string | null, string, number | null, RawProviderEvent['provider']]
export type DayChunk = { v: typeof DAY_CHUNK_VERSION; day: string; events: CompactEvent[] }

function compact(e: RawProviderEvent): CompactEvent | null {
  if (!e.txHash || !e.timestamp || !e.fromAddress || !e.toAddress || !e.contract || !e.amountRaw) return null
  if (!/^\d+$/.test(e.amountRaw) || /^0+$/.test(e.amountRaw)) return null
  return [e.txHash, e.timestamp, e.fromAddress.toLowerCase(), e.toAddress.toLowerCase(), e.contract.toLowerCase(), e.symbol ?? null, e.amountRaw, e.tokenDecimals ?? null, e.provider]
}

function expand(chain: SupportedChain, row: unknown): RawProviderEvent | null {
  if (!Array.isArray(row) || row.length !== 9) return null
  const [txHash, timestamp, fromAddress, toAddress, contract, symbol, amountRaw, tokenDecimals, provider] = row as CompactEvent
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null
  if (typeof fromAddress !== 'string' || typeof toAddress !== 'string' || typeof contract !== 'string' || contract === '') return null
  if (typeof amountRaw !== 'string' || !/^\d+$/.test(amountRaw) || /^0+$/.test(amountRaw)) return null
  if (tokenDecimals !== null && !(Number.isInteger(tokenDecimals) && tokenDecimals >= 0 && tokenDecimals <= 36)) return null
  if (provider !== 'alchemy' && provider !== 'goldrush') return null
  return { provider, chain, txHash, timestamp, fromAddress, toAddress, contract, symbol: typeof symbol === 'string' ? symbol : null, amountRaw, tokenDecimals }
}

export type DayChunkKv = {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: (key: string, value: unknown, opts?: { ex?: number }) => Promise<unknown>
}

export type ChainStitchInput = {
  chain: SupportedChain
  /** This scan's events for the chain (any range; only [freshStartMs, scanMs) is used for storing). */
  freshEvents: readonly RawProviderEvent[]
  /** Start of the range this scan proved complete for the chain (a UTC midnight when narrowed). */
  freshStartMs: number
  /** Providers answered fully for this chain — only then are its days stored. */
  providerOk: boolean
}

export type ChainStitchAudit = {
  chain: string
  freshStartDay: string
  stitchedStartDay: string
  daysStitched: number
  eventsStitched: number
  daysStored: number
  daysSkippedTooLarge: number
  stopReason: 'no_stored_day' | 'configured_window_reached' | 'event_budget' | 'chunk_unreadable' | 'disabled' | 'none'
}

export type StitchResult = {
  /** Earliest proven start per chain (≤ freshStartMs). */
  startByChain: Map<string, number>
  /** Stored events older than each chain's fresh start, within its stitched range. */
  olderEvents: RawProviderEvent[]
  audit: ChainStitchAudit[]
}

/**
 * Reads complete stored days before each chain's fresh start (newest first, contiguous, bounded by the
 * configured window and the event budget), then stores this scan's complete days for later scans.
 * Never throws: a KV failure stitches nothing for that chain and stores nothing.
 */
export async function stitchHistoryDayChunks(kv: DayChunkKv | null, params: {
  wallet: string
  chains: readonly ChainStitchInput[]
  scanMs: number
  configuredStartMs: number
  maxTotalEvents: number
  ttlSeconds: number
}): Promise<StitchResult> {
  const startByChain = new Map<string, number>()
  const olderEvents: RawProviderEvent[] = []
  const audit: ChainStitchAudit[] = []
  let budget = params.maxTotalEvents - params.chains.reduce((sum, c) => sum + c.freshEvents.length, 0)

  for (const input of params.chains) {
    const row: ChainStitchAudit = {
      chain: input.chain, freshStartDay: utcDay(input.freshStartMs), stitchedStartDay: utcDay(input.freshStartMs),
      daysStitched: 0, eventsStitched: 0, daysStored: 0, daysSkippedTooLarge: 0, stopReason: 'none',
    }
    startByChain.set(input.chain, input.freshStartMs)
    audit.push(row)
    if (!kv) { row.stopReason = 'disabled'; continue }

    let index: DayIndex = { v: DAY_CHUNK_VERSION, days: {} }
    try {
      const stored = await kv.get<DayIndex>(dayIndexKey(params.wallet, input.chain))
      if (stored && stored.v === DAY_CHUNK_VERSION && stored.days && typeof stored.days === 'object') index = { v: DAY_CHUNK_VERSION, days: { ...stored.days } }
    } catch { /* stitch nothing, but this scan's days can still be stored */ }

    // 1. Walk back from the day before the fresh start through contiguous complete days.
    let cursor = input.freshStartMs - DAY_MS
    let stitchedStart = input.freshStartMs
    for (;;) {
      if (cursor < params.configuredStartMs) { row.stopReason = 'configured_window_reached'; break }
      const day = utcDay(cursor)
      const count = index.days[day]
      if (typeof count !== 'number') { row.stopReason = 'no_stored_day'; break }
      if (count > budget) { row.stopReason = 'event_budget'; break }
      let chunk: DayChunk | null = null
      try { chunk = await kv.get<DayChunk>(dayChunkKey(params.wallet, input.chain, day)) } catch { chunk = null }
      if (!chunk || chunk.v !== DAY_CHUNK_VERSION || chunk.day !== day || !Array.isArray(chunk.events)) {
        delete index.days[day]
        row.stopReason = 'chunk_unreadable'
        break
      }
      const events = chunk.events.map((e) => expand(input.chain, e))
      // A chunk with any bad row is not trusted as a complete day.
      if (events.some((e) => e === null || utcDay(Date.parse(e.timestamp!)) !== day)) {
        delete index.days[day]
        row.stopReason = 'chunk_unreadable'
        break
      }
      olderEvents.push(...(events as RawProviderEvent[]))
      budget -= events.length
      row.daysStitched += 1
      row.eventsStitched += events.length
      stitchedStart = cursor
      cursor -= DAY_MS
    }
    startByChain.set(input.chain, stitchedStart)
    row.stitchedStartDay = utcDay(stitchedStart)

    // 2. Store this scan's complete days (whole UTC days inside [freshStartMs, scanMs)) not yet stored.
    if (!input.providerOk) continue
    const byDay = new Map<string, RawProviderEvent[]>()
    for (const e of input.freshEvents) {
      const ms = e.timestamp ? Date.parse(e.timestamp) : Number.NaN
      if (!Number.isFinite(ms) || ms < input.freshStartMs) continue
      const day = utcDay(ms)
      byDay.set(day, [...(byDay.get(day) ?? []), e])
    }
    let indexChanged = false
    for (let start = Math.ceil(input.freshStartMs / DAY_MS) * DAY_MS; start + DAY_MS <= params.scanMs; start += DAY_MS) {
      const day = utcDay(start)
      if (typeof index.days[day] === 'number') continue
      // Rows without a tx hash, parties, token or a positive amount carry nothing a trade can be built from.
      const rows = (byDay.get(day) ?? []).map(compact).filter((r): r is CompactEvent => r !== null)
      if (rows.length > MAX_EVENTS_PER_DAY_CHUNK) { row.daysSkippedTooLarge += 1; continue }
      try {
        await kv.set(dayChunkKey(params.wallet, input.chain, day), { v: DAY_CHUNK_VERSION, day, events: rows } satisfies DayChunk, { ex: params.ttlSeconds })
        index.days[day] = rows.length
        indexChanged = true
        row.daysStored += 1
      } catch { /* not marked complete; a later scan stores it */ }
    }
    // Days that left the configured window are dropped from the index (their chunks expire on their own).
    for (const day of Object.keys(index.days)) {
      if (dayStartMs(day) < params.configuredStartMs) { delete index.days[day]; indexChanged = true }
    }
    if (indexChanged || row.stopReason === 'chunk_unreadable') {
      try { await kv.set(dayIndexKey(params.wallet, input.chain), index, { ex: params.ttlSeconds }) } catch { /* next scan re-stores */ }
    }
  }
  return { startByChain, olderEvents, audit }
}
