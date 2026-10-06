// Robinhood native-trace adapter: the target tx's internal native transfers from Blockscout — ALL pages of
// one target tx (bounded) over the existing transport (community host, then the PRO gateway on 401/403), on
// the dedicated `native_trace` lane (one slot per target tx, however many pages). Injected into PnL V1 by the
// sidecar scan (robinhoodWalletScanner.ts) so the V1 lane itself never depends on the Blockscout transport.
// Returns the transfers AND an audit, so a missing trace always says why. Never a partial prefix.

import { getBlockscoutTransactionInternalTransactions } from './robinhoodBlockscoutEvidence'
import type { RhNativeTraceAudit, RhNativeTraceResult, RhNativeTransfer } from './robinhoodMixedRouteForensics'
import type { FetchLike } from './robinhoodPnlV1'

const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')

export function blockscoutNativeTransfersForTx(fetchImpl: FetchLike): (txHash: string) => Promise<RhNativeTraceResult> {
  return async (txHash) => {
    const t = await getBlockscoutTransactionInternalTransactions(txHash, fetchImpl)
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
      result: 'transport_failed',
    }
    const done = (result: RhNativeTraceAudit['result'], transfers: RhNativeTransfer[] | null = null): RhNativeTraceResult => ({ transfers, audit: { ...audit, result } })
    if (t.status === 'budget_exhausted') return done('budget_exhausted')
    if (t.status === 'pagination_cap_exhausted') return done('pagination_cap_exhausted')
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
}
