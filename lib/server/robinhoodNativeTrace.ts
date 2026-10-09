// Robinhood native-trace adapter: the target tx's internal native transfers from Blockscout — ALL pages of
// one target tx (bounded) over the existing transport (community host, then the PRO gateway on 401/403), on
// the dedicated `native_trace` lane (one slot per target tx, however many pages). Injected into PnL V1 by the
// sidecar scan (robinhoodWalletScanner.ts) so the V1 lane itself never depends on the Blockscout transport.
// Returns the transfers AND an audit, so a missing trace always says why. Never a partial prefix.
// Read order: process memory → persistent verified trace → live Blockscout. Only a complete, well-formed
// proven / empty trace is ever stored (robinhoodNativeTracePersistence.ts); a stored hit makes zero Blockscout calls.
// OVERSIZED TRACES: a live lookup that stops at the normal page / item cap on a valid cursor keeps its continuation in
// this source (one per scan); `extendOversized` may continue it once, from the next cursor, under the caller's extra
// page / time budget. Until that continuation reaches next_page_params == null the trace stays unavailable.

import {
  continueBlockscoutTransactionInternalTransactions, getBlockscoutTransactionInternalTransactions, NATIVE_TRACE_EXTENDED_MAX_ITEMS,
  type InternalTxTraceResult, type InternalTxTraceResume,
} from './robinhoodBlockscoutEvidence'
import type { RhNativeTraceAudit, RhNativeTraceResult, RhNativeTransfer } from './robinhoodMixedRouteForensics'
import type { FetchLike } from './robinhoodPnlV1'
import {
  persistRobinhoodNativeTrace, readPersistedRobinhoodNativeTrace, readRobinhoodNativeTraceMemory,
  robinhoodNativeTraceRecordFrom, robinhoodNativeTraceTransfers, type RobinhoodNativeTraceRecord,
} from './robinhoodNativeTracePersistence'

const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')

function nativeTraceFromRecord(txHash: string, record: RobinhoodNativeTraceRecord): RhNativeTraceResult {
  return {
    transfers: robinhoodNativeTraceTransfers(record),
    audit: {
      txHash, attempted: false, cacheHit: true, budgetLane: 'native_trace', requestHost: null, authMode: null, httpStatus: null,
      failureClass: null, transportAttempts: [], itemCount: record.transfers.length, paginated: false, malformed: false,
      missingSuccessStatus: false, pagesRequested: 0, pagesSucceeded: 0, totalItemCount: record.transfers.length,
      paginationComplete: true, paginationCap: null, paginationCapHit: false, pageTransportAttempts: [], result: record.result,
    },
  }
}

/**
 * Stored verified trace only (process memory → persistent positive proof). Never a live Blockscout request and
 * never a native_trace budget slot; null when nothing verified is stored for this tx.
 */
export async function storedRobinhoodNativeTrace(txHash: string): Promise<RhNativeTraceResult | null> {
  const mem = readRobinhoodNativeTraceMemory(txHash)
  if (mem && mem.txHash === lower(txHash)) return nativeTraceFromRecord(txHash, mem)
  const stored = await readPersistedRobinhoodNativeTrace(txHash)
  return stored.record ? nativeTraceFromRecord(txHash, stored.record) : null
}

export type RobinhoodNativeTraceSource = {
  transfersForTx: (txHash: string) => Promise<RhNativeTraceResult>
  /**
   * Continues a trace that hit the normal pagination cap (never re-requesting a fetched page), at most once per tx.
   * Null when there is nothing to continue (not oversized, already extended, or no valid cursor).
   */
  extendOversized: (txHash: string, budget: { maxExtraPages: number; maxTotalMs: number; priority: string }) => Promise<RhNativeTraceResult | null>
}

export function blockscoutNativeTransfersForTx(fetchImpl: FetchLike): (txHash: string) => Promise<RhNativeTraceResult> {
  return blockscoutNativeTraceSource(fetchImpl).transfersForTx
}

export function blockscoutNativeTraceSource(fetchImpl: FetchLike): RobinhoodNativeTraceSource {
  const resumes = new Map<string, InternalTxTraceResume>()
  const live = async (txHash: string) => {
    const t = await getBlockscoutTransactionInternalTransactions(txHash, fetchImpl)
    if (t.resume) resumes.set(lower(txHash), t.resume)
    return nativeTraceResultFrom(txHash, t)
  }
  const persisted = async (txHash: string, r: RhNativeTraceResult, audit: PersistenceAudit) => {
    // Persistence only reuses evidence that already passed the native-trace rules — never a negative.
    const record = r.audit ? robinhoodNativeTraceRecordFrom(txHash, r.transfers, r.audit) : null
    if (record) {
      const w = await persistRobinhoodNativeTrace(record)
      Object.assign(audit, { persisted: w.persisted, persistenceWriteFailed: w.writeFailed, persistenceReason: w.reason })
    }
  }
  return {
    transfersForTx: async (txHash) => {
      const audit = newPersistenceAudit(txHash)
      const fromRecord = (record: RobinhoodNativeTraceRecord): RhNativeTraceResult => nativeTraceFromRecord(txHash, record)
      const mem = readRobinhoodNativeTraceMemory(txHash)
      if (mem && mem.txHash === lower(txHash)) { audit.memoryHit = true; return logPersistence(audit, fromRecord(mem)) }
      const stored = await readPersistedRobinhoodNativeTrace(txHash)
      audit.persistentReadReason = stored.reason
      if (stored.record) { audit.persistentHit = true; return logPersistence(audit, fromRecord(stored.record)) }
      audit.liveAttempted = true
      const r = await live(txHash)
      audit.liveResult = r.audit?.result ?? null
      await persisted(txHash, r, audit)
      return logPersistence(audit, r)
    },
    extendOversized: async (txHash, budget) => {
      const resume = resumes.get(lower(txHash))
      if (!resume) return null
      resumes.delete(lower(txHash)) // one continuation per tx per scan
      const t = await continueBlockscoutTransactionInternalTransactions(resume, fetchImpl, {
        maxExtraPages: budget.maxExtraPages, maxItems: NATIVE_TRACE_EXTENDED_MAX_ITEMS, maxTotalMs: budget.maxTotalMs,
      })
      const r = nativeTraceResultFrom(txHash, t)
      if (r.audit) r.audit.extension = t.extension ? { ...t.extension, priority: budget.priority } : null
      const audit = { ...newPersistenceAudit(txHash), liveAttempted: true, liveResult: r.audit?.result ?? null, extended: true }
      await persisted(txHash, r, audit)
      return logPersistence(audit, r)
    },
  }
}

type PersistenceAudit = ReturnType<typeof newPersistenceAudit>
const newPersistenceAudit = (txHash: string) => ({
  txHash, memoryHit: false, persistentHit: false, persistentReadReason: null as string | null, liveAttempted: false,
  liveResult: null as string | null, persisted: false, persistenceWriteFailed: false, persistenceReason: null as string | null,
  transferCount: null as number | null, result: null as string | null,
})
function logPersistence(audit: PersistenceAudit, r: RhNativeTraceResult): RhNativeTraceResult {
  audit.transferCount = r.transfers ? r.transfers.length : null
  audit.result = r.audit?.result ?? null
  console.warn('[robinhood-native-trace-persistence-audit]', audit)
  return r
}

function nativeTraceResultFrom(txHash: string, t: InternalTxTraceResult): RhNativeTraceResult {
  const audit: RhNativeTraceAudit = {
    txHash,
    attempted: t.pagesRequested > 0,
    cacheHit: t.cacheHit,
    budgetLane: 'native_trace',
    requestHost: t.last.requestHost,
    authMode: t.last.authMode,
    httpStatus: t.last.httpStatus,
    failureClass: t.last.failureClass ?? (t.status === 'not_configured' ? 'not_configured' : null),
    transportAttempts: t.pageTransportAttempts,
    itemCount: t.items ? t.items.length : t.totalItemCount,
    paginated: !t.paginationComplete && t.pagesSucceeded > 0,
    malformed: t.status === 'malformed' || t.status === 'inconsistent_pagination',
    missingSuccessStatus: false,
    pagesRequested: t.pagesRequested,
    pagesSucceeded: t.pagesSucceeded,
    totalItemCount: t.totalItemCount,
    paginationComplete: t.paginationComplete,
    paginationCap: t.paginationCap,
    paginationCapHit: t.paginationCapHit,
    pageTransportAttempts: t.pageTransportAttempts,
    transportAttemptsTotal: t.transportAttemptsTotal,
    pageRetryCount: t.pageRetryCount,
    pagesRetried: t.pagesRetried,
    transientFailureCounts: t.transientFailureCounts,
    zeroValueFilter: t.zeroValueFilter,
    itemCategories: t.itemCategories,
    indexingPending: t.indexingPending,
    result: 'transport_failed',
  }
  const done = (result: RhNativeTraceAudit['result'], transfers: RhNativeTransfer[] | null = null): RhNativeTraceResult => ({ transfers, audit: { ...audit, result } })
  if (t.status === 'budget_exhausted') return done('budget_exhausted')
  if (t.status === 'pagination_cap_exhausted') return done('pagination_cap_exhausted')
  if (t.status === 'indexing_pending') return done('indexing_pending')
  if (t.status === 'malformed' || t.status === 'inconsistent_pagination') return done('malformed')
  if (t.status !== 'complete' || !t.items) return done('transport_failed')
  const out: RhNativeTransfer[] = []
  for (const it of t.items) {
    const from = lower(it.from?.hash)
    const to = lower(it.to?.hash)
    let value: bigint
    try { value = BigInt(it.value ?? '0') } catch { audit.malformed = true; return done('malformed') }
    if (!from || !to) { audit.malformed = true; return done('malformed') }
    // FAIL CLOSED (any page): Blockscout v2 internal transactions carry `success: boolean` (with `error` set
    // when it failed). An entry without an explicit boolean has an unknown execution status, which is not
    // proof — the whole trace is unavailable rather than guessing the transfer happened.
    if (typeof it.success !== 'boolean') { audit.missingSuccessStatus = true; return done('unknown_execution_status') }
    out.push({ from, to, value, success: it.success })
  }
  return done(out.length === 0 ? 'empty' : 'proven', out)
}
