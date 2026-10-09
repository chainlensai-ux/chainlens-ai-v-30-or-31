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
// PARTIAL PROGRESS ACROSS SCANS (robinhoodPartialNativeTrace.ts): read order is proven trace (memory → persistent) →
// compatible partial record → fresh live lookup. A partial resumes at its exact stored cursor (fetched pages are never
// requested again) as a normal lookup (one lane slot, normal caps, scan deadline). A lookup that ends incomplete after
// ≥ 1 good page stores its progress (monotonic); a complete lookup deletes it. A partial never yields transfers.

import {
  continueBlockscoutTransactionInternalTransactions, getBlockscoutTransactionInternalTransactions, internalTxResumeFrom, NATIVE_TRACE_EXTENDED_MAX_ITEMS,
  nativeTraceFilterKnownUnsupported, resumeBlockscoutTransactionInternalTransactions,
  type BlockscoutInternalTransaction, type InternalTxTraceResult, type InternalTxTraceResume,
} from './robinhoodBlockscoutEvidence'
import {
  deletePartialTrace, partialTraceCompatible, readPartialTrace, ROBINHOOD_PARTIAL_TRACE_METHODOLOGY_VERSION, writePartialTrace,
  type PartialTraceIdentity, type PartialTraceItem, type RobinhoodPartialNativeTraceRecord,
} from './robinhoodPartialNativeTrace'
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
  /** `deadlineAt`: the scan-wide deadline — bounds every request and decides whether a same-page retry may run. */
  transfersForTx: (txHash: string, opts?: NativeTraceLookupOpts) => Promise<RhNativeTraceResult>
  /**
   * Continues a trace that hit the normal pagination cap (never re-requesting a fetched page), at most once per tx.
   * Null when there is nothing to continue (not oversized, already extended, or no valid cursor).
   */
  extendOversized: (txHash: string, budget: { maxExtraPages: number; maxTotalMs: number; priority: string; deadlineAt?: number; pageTimeoutMs?: number }) => Promise<RhNativeTraceResult | null>
}

export type NativeTraceLookupOpts = {
  deadlineAt?: number; reserveRetry?: boolean; pageTimeoutMs?: number
  /** The target tx's receipt identity (block number / hash, status): a stored partial must match it to be resumed. */
  identity?: Partial<PartialTraceIdentity>
}
export function blockscoutNativeTransfersForTx(fetchImpl: FetchLike): (txHash: string, opts?: NativeTraceLookupOpts) => Promise<RhNativeTraceResult> {
  return blockscoutNativeTraceSource(fetchImpl).transfersForTx
}

export function blockscoutNativeTraceSource(fetchImpl: FetchLike): RobinhoodNativeTraceSource {
  const resumes = new Map<string, InternalTxTraceResume>()
  const identities = new Map<string, PartialTraceIdentity>()
  const live = async (txHash: string, opts?: NativeTraceLookupOpts) => {
    const identity = identityOf(opts)
    identities.set(lower(txHash), identity)
    const pa = newPartialAudit(txHash, 'scan_lookup')
    const lookupOpts = { deadlineAt: opts?.deadlineAt, reserveRetry: opts?.reserveRetry, pageTimeoutMs: opts?.pageTimeoutMs }
    const stored = await readPartialTrace(txHash)
    let partial: RobinhoodPartialNativeTraceRecord | null = stored.record
    pa.missReason = stored.reason
    if (partial) {
      const incompatible = partialTraceCompatible(partial, { identity, filterUnsupported: nativeTraceFilterKnownUnsupported() })
      if (incompatible) { pa.missReason = incompatible; await deletePartialTrace(txHash); partial = null }
    }
    let t: InternalTxTraceResult
    if (partial) {
      Object.assign(pa, { hit: true, missReason: null, completedPagesBefore: partial.completedPages, itemsBefore: partial.itemCount, resumedCursor: partial.nextCursor, expiry: partial.expiresAt })
      t = await resumeBlockscoutTransactionInternalTransactions(internalTxResumeFrom({
        txHash, filter: partial.filter, zeroValueFilter: partial.zeroValueFilter as never, nextCursor: partial.nextCursor, cursors: partial.cursors,
        items: partial.items as BlockscoutInternalTransaction[], useGateway: partial.useGateway, completedPages: partial.completedPages,
      }), fetchImpl, lookupOpts)
    } else {
      t = await getBlockscoutTransactionInternalTransactions(txHash, fetchImpl, undefined, lookupOpts)
    }
    await settlePartial(txHash, t, identity, pa, partial)
    if (t.resume) resumes.set(lower(txHash), t.resume)
    const r = nativeTraceResultFrom(txHash, t)
    if (r.audit) Object.assign(r.audit, partialAuditFields(pa, partial))
    logPartial(pa, r)
    return r
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
    transfersForTx: async (txHash, opts) => {
      const audit = newPersistenceAudit(txHash)
      const fromRecord = (record: RobinhoodNativeTraceRecord): RhNativeTraceResult => nativeTraceFromRecord(txHash, record)
      const mem = readRobinhoodNativeTraceMemory(txHash)
      if (mem && mem.txHash === lower(txHash)) { audit.memoryHit = true; return logPersistence(audit, fromRecord(mem)) }
      const stored = await readPersistedRobinhoodNativeTrace(txHash)
      audit.persistentReadReason = stored.reason
      if (stored.record) { audit.persistentHit = true; return logPersistence(audit, fromRecord(stored.record)) }
      audit.liveAttempted = true
      const r = await live(txHash, opts)
      audit.liveResult = r.audit?.result ?? null
      await persisted(txHash, r, audit)
      return logPersistence(audit, r)
    },
    extendOversized: async (txHash, budget) => {
      const resume = resumes.get(lower(txHash))
      if (!resume) return null
      resumes.delete(lower(txHash)) // one continuation per tx per scan
      const t = await continueBlockscoutTransactionInternalTransactions(resume, fetchImpl, {
        maxExtraPages: budget.maxExtraPages, maxItems: NATIVE_TRACE_EXTENDED_MAX_ITEMS, maxTotalMs: budget.maxTotalMs, deadlineAt: budget.deadlineAt,
        reserveRetry: budget.priority === 'p1_native_out_sell', pageTimeoutMs: budget.pageTimeoutMs,
      })
      const pa = newPartialAudit(txHash, 'in_scan_continuation')
      Object.assign(pa, { completedPagesBefore: resume.pagesDone, itemsBefore: resume.items.size, resumedCursor: resume.query })
      await settlePartial(txHash, t, identities.get(lower(txHash)) ?? identityOf(undefined), pa, null)
      const r = nativeTraceResultFrom(txHash, t)
      if (r.audit) r.audit.extension = t.extension ? { ...t.extension, priority: budget.priority } : null
      logPartial(pa, r)
      const audit = { ...newPersistenceAudit(txHash), liveAttempted: true, liveResult: r.audit?.result ?? null, extended: true }
      await persisted(txHash, r, audit)
      return logPersistence(audit, r)
    },
  }
}

const identityOf = (opts: NativeTraceLookupOpts | undefined): PartialTraceIdentity => ({
  blockNumber: opts?.identity?.blockNumber ?? null, blockHash: opts?.identity?.blockHash?.toLowerCase() ?? null, txStatus: opts?.identity?.txStatus ?? null,
})
const toPartialItem = (it: BlockscoutInternalTransaction): PartialTraceItem => ({
  index: it.index ?? null, block_index: it.block_index ?? null, transaction_hash: it.transaction_hash ?? null,
  from: it.from?.hash ? { hash: it.from.hash } : null, to: it.to?.hash ? { hash: it.to.hash } : null, value: it.value ?? null,
  ...(it.success === undefined ? {} : { success: it.success }), type: it.type ?? null,
})

type PartialAudit = ReturnType<typeof newPartialAudit>
const newPartialAudit = (txHash: string, lookup: 'scan_lookup' | 'in_scan_continuation') => ({
  txHash, lookup, hit: false, missReason: null as string | null, methodologyVersion: ROBINHOOD_PARTIAL_TRACE_METHODOLOGY_VERSION,
  completedPagesBefore: 0, completedPagesAfter: 0, itemsBefore: 0, itemsAfter: 0, resumedCursor: null as string | null, pagesRefetched: 0,
  writeAttempted: false, writeSucceeded: false, writeReason: null as string | null, deletedAfterProof: false, deletedReason: null as string | null,
  expiry: null as number | null, result: null as string | null,
})
/**
 * After a lookup / continuation: a COMPLETE trace deletes the partial (it is now proof or a definitive negative); a
 * malformed / inconsistent / still-indexing trace deletes it too (start fresh next time); an incomplete trace with ≥ 1
 * good page writes its progress (monotonic). Nothing here ever produces transfers.
 */
async function settlePartial(txHash: string, t: InternalTxTraceResult, identity: PartialTraceIdentity, pa: PartialAudit, resumedFrom: RobinhoodPartialNativeTraceRecord | null): Promise<void> {
  pa.pagesRefetched = resumedFrom ? t.pageTransportAttempts.filter((a) => a.page <= resumedFrom.completedPages).length : 0
  pa.completedPagesAfter = t.pagesSucceeded
  pa.itemsAfter = t.totalItemCount
  if (t.status === 'complete') {
    pa.deletedAfterProof = await deletePartialTrace(txHash) || resumedFrom != null
    pa.deletedReason = 'trace_complete'
    return
  }
  if (t.status === 'malformed' || t.status === 'inconsistent_pagination' || t.status === 'indexing_pending') {
    if (await deletePartialTrace(txHash)) pa.deletedReason = t.status
    return
  }
  const r = t.resume
  if (!r || r.pagesDone < 1 || !r.query) return
  pa.writeAttempted = true
  const w = await writePartialTrace({
    txHash, completedPages: r.pagesDone, nextCursor: r.query, cursors: [...r.cursors], items: [...r.items.values()].map(toPartialItem),
    filter: r.filter, zeroValueFilter: r.zeroValueFilter, sourceHost: t.last.requestHost, useGateway: r.useGateway, identity,
  })
  pa.writeSucceeded = w.written
  pa.writeReason = w.reason
  pa.expiry = w.record?.expiresAt ?? pa.expiry
}
const partialAuditFields = (pa: PartialAudit, resumedFrom: RobinhoodPartialNativeTraceRecord | null) => ({
  partialTraceHit: pa.hit, resumedFromPage: resumedFrom ? resumedFrom.completedPages + 1 : null,
  resumedItemCount: resumedFrom ? resumedFrom.itemCount : null, pagesRefetched: pa.pagesRefetched, partialWritten: pa.writeSucceeded,
})
function logPartial(pa: PartialAudit, r: RhNativeTraceResult): void {
  pa.result = r.audit?.result ?? null
  console.warn('[robinhood-partial-trace-audit]', pa)
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
    filterProbes: t.filterProbes,
    filterCapabilityWaitMs: t.filterCapabilityWaitMs,
    deadlineStopped: t.deadlineStopped,
    retrySkippedForDeadline: t.retrySkippedForDeadline,
    result: 'transport_failed',
  }
  const done = (result: RhNativeTraceAudit['result'], transfers: RhNativeTransfer[] | null = null): RhNativeTraceResult => ({ transfers, audit: { ...audit, result } })
  if (t.status === 'budget_exhausted') return done('budget_exhausted')
  if (t.status === 'pagination_cap_exhausted') return done('pagination_cap_exhausted')
  if (t.status === 'indexing_pending') return done('indexing_pending')
  if (t.status === 'insufficient_deadline') return done('not_attempted_deadline')
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
