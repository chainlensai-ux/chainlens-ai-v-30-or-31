// ROBINHOOD NATIVE-TRACE POSITIVE-PROOF PERSISTENCE.
//
// A mined tx's internal native transfers are immutable chain evidence, so a trace that ALREADY passed the
// native-trace rules (complete pagination, explicit `success` on every item, well-formed) is reusable forever.
// Only `proven` / `empty` results from a complete, uncapped, well-formed trace are stored; timeouts, rate
// limits, budget exhaustion, malformed / unknown-status / capped / incomplete traces are never stored, so an
// unavailable lookup is always retried live. Same KV client and conventions as the verified native-price
// evidence (src/modules/nativePriceResolver/persistentEvidence.ts): bounded timeouts, SET NX, no TTL.
// The key is chain- and tx-strict, and every read is re-validated against the requested tx.

import { kv as vercelKv } from '@vercel/kv'
import type { RhNativeTransfer } from './robinhoodMixedRouteForensics'

export const ROBINHOOD_NATIVE_TRACE_SCHEMA_VERSION = 1
const READ_TIMEOUT_MS = 800
const WRITE_TIMEOUT_MS = 1_500
const MAX_TRANSFERS = 600 // = NATIVE_TRACE_EXTENDED_MAX_ITEMS: a larger row cannot have come from a complete (extended) trace
const MEMORY_MAX = 2_000

export type RobinhoodNativeTraceRecord = {
  schemaVersion: 1
  chain: 'robinhood'
  txHash: string
  transfers: Array<{ from: string; to: string; value: string; success: boolean }>
  result: 'proven' | 'empty'
  paginationComplete: true
}

type TraceKv = Pick<typeof vercelKv, 'get' | 'set'>
let kvOverrideForTest: TraceKv | null = null
const memory = new Map<string, RobinhoodNativeTraceRecord>()

export function __setRobinhoodNativeTraceKvForTest(client: TraceKv | null): void { kvOverrideForTest = client }
/** Simulates a new server instance: drops the process-memory layer only. */
export function __resetRobinhoodNativeTraceMemoryForTest(): void { memory.clear() }

const TX_HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/

export function robinhoodNativeTracePersistenceKey(txHash: string): string {
  return `robinhood:native-trace:v1:${txHash.toLowerCase()}`
}

function persistenceConfigured(): boolean {
  return kvOverrideForTest !== null || Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('native_trace_kv_timeout')), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

/** PURE. A stored row is used only if it is exactly this schema, this chain and this tx. */
export function validateRobinhoodNativeTraceRecord(raw: unknown, txHash: string): RobinhoodNativeTraceRecord | null {
  const want = txHash.toLowerCase()
  if (!TX_HASH.test(want) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.schemaVersion !== ROBINHOOD_NATIVE_TRACE_SCHEMA_VERSION || r.chain !== 'robinhood' || r.txHash !== want || r.paginationComplete !== true) return null
  if (r.result !== 'proven' && r.result !== 'empty') return null
  if (!Array.isArray(r.transfers) || r.transfers.length > MAX_TRANSFERS) return null
  if ((r.result === 'empty') !== (r.transfers.length === 0)) return null
  for (const t of r.transfers) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return null
    const x = t as Record<string, unknown>
    if (typeof x.from !== 'string' || !ADDRESS.test(x.from) || typeof x.to !== 'string' || !ADDRESS.test(x.to)) return null
    if (typeof x.value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x.value) || typeof x.success !== 'boolean') return null
  }
  return r as RobinhoodNativeTraceRecord
}

/** Builds a record from an adapter result that already passed every native-trace rule; null when it did not. */
export function robinhoodNativeTraceRecordFrom(txHash: string, transfers: readonly RhNativeTransfer[] | null, audit: {
  result: string; paginationComplete: boolean; paginationCapHit: boolean; malformed: boolean; missingSuccessStatus: boolean
}): RobinhoodNativeTraceRecord | null {
  if (!transfers || (audit.result !== 'proven' && audit.result !== 'empty')) return null
  if (!audit.paginationComplete || audit.paginationCapHit || audit.malformed || audit.missingSuccessStatus) return null
  const record = {
    schemaVersion: ROBINHOOD_NATIVE_TRACE_SCHEMA_VERSION, chain: 'robinhood', txHash: txHash.toLowerCase(),
    transfers: transfers.map((t) => ({ from: t.from.toLowerCase(), to: t.to.toLowerCase(), value: t.value.toString(), success: t.success })),
    result: audit.result, paginationComplete: true,
  }
  return validateRobinhoodNativeTraceRecord(record, txHash)
}

export const robinhoodNativeTraceTransfers = (r: RobinhoodNativeTraceRecord): RhNativeTransfer[] =>
  r.transfers.map((t) => ({ from: t.from, to: t.to, value: BigInt(t.value), success: t.success }))

export function readRobinhoodNativeTraceMemory(txHash: string): RobinhoodNativeTraceRecord | null {
  return memory.get(robinhoodNativeTracePersistenceKey(txHash)) ?? null
}

function remember(record: RobinhoodNativeTraceRecord): void {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!)
  memory.set(robinhoodNativeTracePersistenceKey(record.txHash), record)
}

export async function readPersistedRobinhoodNativeTrace(txHash: string): Promise<{ record: RobinhoodNativeTraceRecord | null; reason: string | null }> {
  if (!TX_HASH.test(txHash.toLowerCase())) return { record: null, reason: 'invalid_tx_hash' }
  if (!persistenceConfigured()) return { record: null, reason: 'kv_not_configured' }
  try {
    const raw = await bounded((kvOverrideForTest ?? vercelKv).get<unknown>(robinhoodNativeTracePersistenceKey(txHash)), READ_TIMEOUT_MS)
    if (raw == null) return { record: null, reason: 'record_absent' }
    const record = validateRobinhoodNativeTraceRecord(raw, txHash)
    if (record) remember(record)
    return { record, reason: record ? null : 'invalid_persisted_record' }
  } catch {
    return { record: null, reason: 'persistent_lookup_failed' }
  }
}

/** Keeps a verified record in process memory and persists it (SET NX, no TTL). Never throws. */
export async function persistRobinhoodNativeTrace(record: RobinhoodNativeTraceRecord): Promise<{ persisted: boolean; writeFailed: boolean; reason: string | null }> {
  if (!validateRobinhoodNativeTraceRecord(record, record.txHash)) return { persisted: false, writeFailed: false, reason: 'invalid_record' }
  remember(record)
  if (!persistenceConfigured()) return { persisted: false, writeFailed: false, reason: 'kv_not_configured' }
  try {
    const res = await bounded((kvOverrideForTest ?? vercelKv).set(robinhoodNativeTracePersistenceKey(record.txHash), record, { nx: true }), WRITE_TIMEOUT_MS)
    return res === 'OK' ? { persisted: true, writeFailed: false, reason: null } : { persisted: false, writeFailed: false, reason: 'record_already_exists' }
  } catch {
    return { persisted: false, writeFailed: true, reason: 'persistent_write_failed' }
  }
}
