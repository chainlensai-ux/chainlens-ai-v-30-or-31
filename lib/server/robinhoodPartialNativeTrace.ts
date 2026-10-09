// Robinhood PARTIAL native-trace progress, persisted across scans (process memory + Vercel KV).
//
// HARD RULE: a partial record is NEVER evidence. It holds only the successfully fetched pages of a target-tx
// internal-transactions trace and the exact Blockscout cursor of the next page, so a later scan can continue
// pagination instead of refetching pages 1..N. It has its own key namespace and shape (no `result`, no transfers in
// the proven-trace format, no verdict, no promotion, no PnL) and no reader of proven traces ever looks at it. A trace
// becomes proof only when a continuation reaches next_page_params == null (then it is written to the proven-trace
// store and this record is deleted).
//
// Invalidation: any mismatch of tx hash, chain, methodology version, endpoint identity, filter mode, block identity
// (block number / hash / tx status, when known), an expired record, a bad checksum, an empty cursor or inconsistent
// page / item counts → the record is discarded and the lookup starts fresh. Writes are monotonic: a record is
// replaced only by one with strictly more completed pages (and never fewer items).

import { createHash } from 'node:crypto'
import { kv as vercelKv } from '@vercel/kv'
import { ROBINHOOD_CHAIN_ID } from './robinhoodChainConfig'

/** Bump on any change to how pages are requested / items normalized: older partials are then discarded. */
export const ROBINHOOD_PARTIAL_TRACE_METHODOLOGY_VERSION = 1
/** Endpoint semantics the stored cursor belongs to. */
export const ROBINHOOD_PARTIAL_TRACE_ENDPOINT = 'blockscout:/api/v2/transactions/{tx}/internal-transactions'
export const ROBINHOOD_PARTIAL_TRACE_TTL_MS = 48 * 60 * 60_000
/** Same ceiling as an extended trace (NATIVE_TRACE_EXTENDED_MAX_ITEMS): a larger trace is never completed anyway. */
export const ROBINHOOD_PARTIAL_TRACE_MAX_ITEMS = 600
const MEMORY_MAX = 500
const READ_TIMEOUT_MS = 800
const WRITE_TIMEOUT_MS = 1_500

export type PartialTraceItem = {
  index: number | null; block_index: number | null; transaction_hash: string | null
  from: { hash: string } | null; to: { hash: string } | null; value: string | null; success?: boolean | null; type: string | null
}
export type PartialTraceIdentity = { blockNumber: number | null; blockHash: string | null; txStatus: number | null }
export type RobinhoodPartialNativeTraceRecord = {
  kind: 'robinhood_partial_native_trace'
  methodologyVersion: number
  chainId: number
  endpoint: string
  txHash: string
  /** Pages 1..completedPages were fetched successfully; `nextCursor` is the exact query of page completedPages + 1. */
  completedPages: number
  nextCursor: string
  /** Every cursor already followed (loop detection continues across scans). */
  cursors: string[]
  items: PartialTraceItem[]
  itemCount: number
  paginationComplete: false
  /** include_zero_value=false sent on every page (true) or never (false). */
  filter: boolean
  zeroValueFilter: string
  sourceHost: string | null
  useGateway: boolean
  identity: PartialTraceIdentity
  createdAt: number
  updatedAt: number
  expiresAt: number
  checksum: string
}

type PartialKv = { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown, opts?: { px?: number }) => Promise<unknown>; del: (key: string) => Promise<unknown> }
let kvOverrideForTest: PartialKv | null = null
const memory = new Map<string, RobinhoodPartialNativeTraceRecord>()
export function __setRobinhoodPartialTraceKvForTest(client: PartialKv | null): void { kvOverrideForTest = client }
export function __resetRobinhoodPartialTraceMemoryForTest(): void { memory.clear() }

const TX_HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
export function robinhoodPartialTraceKey(txHash: string): string {
  return `robinhood:partial-native-trace:v1:${ROBINHOOD_CHAIN_ID}:${txHash.toLowerCase()}:${ROBINHOOD_PARTIAL_TRACE_METHODOLOGY_VERSION}`
}
const kvConfigured = () => kvOverrideForTest !== null || Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
const client = (): PartialKv => kvOverrideForTest ?? (vercelKv as unknown as PartialKv)
function bounded<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([op, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('partial_trace_kv_timeout')), ms) })]).finally(() => clearTimeout(timer))
}

/** Checksum over everything that defines the progress (not the timestamps). */
export function partialTraceChecksum(r: Omit<RobinhoodPartialNativeTraceRecord, 'checksum'>): string {
  return createHash('sha256').update(JSON.stringify([
    r.kind, r.methodologyVersion, r.chainId, r.endpoint, r.txHash, r.completedPages, r.nextCursor, r.cursors, r.items, r.itemCount,
    r.filter, r.zeroValueFilter, r.useGateway, r.identity,
  ])).digest('hex')
}

export type PartialTraceMissReason =
  | 'absent' | 'kv_not_configured' | 'lookup_failed' | 'corrupted' | 'checksum_mismatch' | 'methodology_mismatch' | 'chain_mismatch'
  | 'endpoint_mismatch' | 'tx_mismatch' | 'expired' | 'inconsistent_counts' | 'cursor_missing' | 'identity_mismatch' | 'filter_mode_mismatch'
  | 'too_many_items'

/** PURE. The record if it is exactly this schema / chain / methodology / tx and internally consistent; else why not. */
export function validatePartialTraceRecord(raw: unknown, txHash: string, now: number): { record: RobinhoodPartialNativeTraceRecord | null; reason: PartialTraceMissReason | null } {
  const fail = (reason: PartialTraceMissReason) => ({ record: null, reason })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('corrupted')
  const r = raw as Record<string, unknown>
  if (r.kind !== 'robinhood_partial_native_trace' || r.paginationComplete !== false) return fail('corrupted')
  if (r.methodologyVersion !== ROBINHOOD_PARTIAL_TRACE_METHODOLOGY_VERSION) return fail('methodology_mismatch')
  if (r.chainId !== ROBINHOOD_CHAIN_ID) return fail('chain_mismatch')
  if (r.endpoint !== ROBINHOOD_PARTIAL_TRACE_ENDPOINT) return fail('endpoint_mismatch')
  if (typeof r.txHash !== 'string' || r.txHash !== txHash.toLowerCase() || !TX_HASH.test(r.txHash)) return fail('tx_mismatch')
  if (typeof r.expiresAt !== 'number' || now >= r.expiresAt) return fail('expired')
  if (typeof r.nextCursor !== 'string' || r.nextCursor === '') return fail('cursor_missing')
  if (!Number.isInteger(r.completedPages) || (r.completedPages as number) < 1 || !Array.isArray(r.items) || !Array.isArray(r.cursors)
    || r.itemCount !== r.items.length || r.cursors.length !== r.completedPages || !r.cursors.every((c) => typeof c === 'string' && c !== '')
    || r.cursors[r.cursors.length - 1] !== r.nextCursor) return fail('inconsistent_counts')
  if (r.items.length > ROBINHOOD_PARTIAL_TRACE_MAX_ITEMS) return fail('too_many_items')
  if (typeof r.filter !== 'boolean' || typeof r.useGateway !== 'boolean' || typeof r.zeroValueFilter !== 'string') return fail('corrupted')
  const id = r.identity as Record<string, unknown> | null
  if (!id || typeof id !== 'object' || !(id.blockNumber === null || Number.isInteger(id.blockNumber))
    || !(id.blockHash === null || (typeof id.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(id.blockHash)))
    || !(id.txStatus === null || Number.isInteger(id.txStatus))) return fail('corrupted')
  for (const it of r.items as unknown[]) {
    const x = it as Record<string, unknown> | null
    if (!x || typeof x !== 'object') return fail('corrupted')
    const addr = (v: unknown) => v === null || (typeof v === 'object' && v !== null && typeof (v as { hash?: unknown }).hash === 'string' && ADDRESS.test((v as { hash: string }).hash.toLowerCase()))
    if (!addr(x.from) || !addr(x.to) || !(x.value === null || (typeof x.value === 'string' && /^\d+$/.test(x.value)))
      || !(x.success === undefined || x.success === null || typeof x.success === 'boolean')) return fail('corrupted')
  }
  const record = r as unknown as RobinhoodPartialNativeTraceRecord
  const { checksum, ...rest } = record
  if (typeof checksum !== 'string' || checksum !== partialTraceChecksum(rest)) return fail('checksum_mismatch')
  return { record, reason: null }
}

/** Compatibility with the scan about to resume it (identity known now must equal the stored one). */
export function partialTraceCompatible(record: RobinhoodPartialNativeTraceRecord, current: { identity: PartialTraceIdentity; filterUnsupported: boolean }): PartialTraceMissReason | null {
  const a = record.identity
  const b = current.identity
  if (a.blockNumber !== b.blockNumber || a.blockHash !== b.blockHash || a.txStatus !== b.txStatus) return 'identity_mismatch'
  // A filtered cursor cannot continue once the endpoint is known to refuse the parameter; an unfiltered one always can.
  if (record.filter && current.filterUnsupported) return 'filter_mode_mismatch'
  return null
}

export async function readPartialTrace(txHash: string, now = Date.now()): Promise<{ record: RobinhoodPartialNativeTraceRecord | null; reason: PartialTraceMissReason | null }> {
  const key = robinhoodPartialTraceKey(txHash)
  const mem = memory.get(key)
  if (mem) {
    const v = validatePartialTraceRecord(mem, txHash, now)
    if (v.record) return v
    memory.delete(key)
    return v
  }
  if (!kvConfigured()) return { record: null, reason: 'absent' }
  try {
    const raw = await bounded(client().get(key), READ_TIMEOUT_MS)
    if (raw == null) return { record: null, reason: 'absent' }
    const v = validatePartialTraceRecord(raw, txHash, now)
    if (v.record) remember(v.record)
    else await deletePartialTrace(txHash) // a stale / corrupted record never comes back
    return v
  } catch {
    return { record: null, reason: 'lookup_failed' }
  }
}

function remember(record: RobinhoodPartialNativeTraceRecord): void {
  const key = robinhoodPartialTraceKey(record.txHash)
  memory.delete(key)
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!)
  memory.set(key, record)
}

export type PartialTraceProgress = Omit<RobinhoodPartialNativeTraceRecord, 'kind' | 'methodologyVersion' | 'chainId' | 'endpoint' | 'paginationComplete' | 'createdAt' | 'updatedAt' | 'expiresAt' | 'checksum' | 'itemCount'>

/**
 * Monotonic write: stores the progress only when it has strictly more completed pages than the stored compatible
 * record (and at least as many items). Never throws.
 */
export async function writePartialTrace(progress: PartialTraceProgress, now = Date.now()): Promise<{ written: boolean; reason: string | null; record: RobinhoodPartialNativeTraceRecord | null }> {
  if (progress.completedPages < 1 || !progress.nextCursor) return { written: false, reason: 'no_progress', record: null }
  if (progress.items.length > ROBINHOOD_PARTIAL_TRACE_MAX_ITEMS) return { written: false, reason: 'too_many_items', record: null }
  const existing = await readPartialTrace(progress.txHash, now)
  if (existing.record && partialTraceCompatible(existing.record, { identity: progress.identity, filterUnsupported: false }) == null
    && existing.record.filter === progress.filter
    && (existing.record.completedPages >= progress.completedPages || existing.record.itemCount > progress.items.length)) {
    return { written: false, reason: 'not_more_progress', record: existing.record }
  }
  const base = {
    kind: 'robinhood_partial_native_trace' as const, methodologyVersion: ROBINHOOD_PARTIAL_TRACE_METHODOLOGY_VERSION, chainId: ROBINHOOD_CHAIN_ID,
    endpoint: ROBINHOOD_PARTIAL_TRACE_ENDPOINT, ...progress, txHash: progress.txHash.toLowerCase(), itemCount: progress.items.length,
    paginationComplete: false as const, createdAt: existing.record?.createdAt ?? now, updatedAt: now, expiresAt: now + ROBINHOOD_PARTIAL_TRACE_TTL_MS,
  }
  const record: RobinhoodPartialNativeTraceRecord = { ...base, checksum: partialTraceChecksum(base) }
  if (!validatePartialTraceRecord(record, record.txHash, now).record) return { written: false, reason: 'invalid_record', record: null }
  remember(record)
  if (!kvConfigured()) return { written: true, reason: 'memory_only', record }
  try {
    await bounded(client().set(robinhoodPartialTraceKey(record.txHash), record, { px: ROBINHOOD_PARTIAL_TRACE_TTL_MS }), WRITE_TIMEOUT_MS)
    return { written: true, reason: null, record }
  } catch {
    return { written: true, reason: 'persistent_write_failed', record }
  }
}

export async function deletePartialTrace(txHash: string): Promise<boolean> {
  const key = robinhoodPartialTraceKey(txHash)
  const had = memory.delete(key)
  if (!kvConfigured()) return had
  try { await bounded(client().del(key), WRITE_TIMEOUT_MS); return true } catch { return had }
}

/** Progress summary for trace selection (ordering only; never evidence). */
export async function partialTraceProgress(txHash: string): Promise<{ completedPages: number; itemCount: number } | null> {
  const r = await readPartialTrace(txHash)
  return r.record ? { completedPages: r.record.completedPages, itemCount: r.record.itemCount } : null
}
