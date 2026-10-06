// Robinhood native-trace adapter: the target tx's internal native transfers from Blockscout (existing
// transport: community host, then the PRO gateway on 401/403) on the dedicated `native_trace` budget lane.
// Injected into PnL V1 by the sidecar scan (robinhoodWalletScanner.ts) so the V1 lane itself never depends on
// the Blockscout transport. Returns the transfers AND an audit, so a missing trace always says why.

import { getBlockscoutTransactionInternalTransactions } from './robinhoodBlockscoutEvidence'
import type { RhNativeTraceAudit, RhNativeTraceResult, RhNativeTransfer } from './robinhoodMixedRouteForensics'
import type { FetchLike } from './robinhoodPnlV1'

const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '')

export function blockscoutNativeTransfersForTx(fetchImpl: FetchLike): (txHash: string) => Promise<RhNativeTraceResult> {
  return async (txHash) => {
    const { data, audit: bs } = await getBlockscoutTransactionInternalTransactions(txHash, fetchImpl)
    const audit: RhNativeTraceAudit = {
      txHash,
      attempted: bs.blockscoutAttempted && bs.blockscoutStatus !== 'rate_limited' && !bs.blockscoutCacheHit,
      cacheHit: bs.blockscoutCacheHit,
      budgetLane: 'native_trace',
      requestHost: bs.requestHost,
      authMode: bs.authMode,
      httpStatus: bs.httpStatus,
      failureClass: bs.failureClass ?? (bs.blockscoutStatus === 'not_configured' ? 'not_configured' : null),
      transportAttempts: bs.transportAttempts.map((t) => ({ requestHost: t.requestHost, authMode: t.authMode, httpStatus: t.httpStatus, failureClass: t.failureClass })),
      itemCount: null,
      paginated: false,
      malformed: false,
      missingSuccessStatus: false,
      result: 'transport_failed',
    }
    const done = (result: RhNativeTraceAudit['result'], transfers: RhNativeTransfer[] | null = null): RhNativeTraceResult => ({ transfers, audit: { ...audit, result } })
    // The native_trace lane's own budget refused the lookup before any request (a Blockscout 429 is
    // 'unavailable' + rate_limited_by_blockscout instead, i.e. transport_failed with failureClass rate_limited).
    if (bs.blockscoutStatus === 'rate_limited') return done('budget_exhausted')
    if (!data) return done('transport_failed')
    if (!Array.isArray(data.items)) { audit.malformed = true; return done('malformed') }
    audit.itemCount = data.items.length
    // A paginated (incomplete) trace is not proof of the full native flow.
    if (data.next_page_params) { audit.paginated = true; return done('paginated') }
    const out: RhNativeTransfer[] = []
    for (const it of data.items) {
      const from = lower(it.from?.hash)
      const to = lower(it.to?.hash)
      let value: bigint
      try { value = BigInt(it.value ?? '0') } catch { audit.malformed = true; return done('malformed') }
      if (!from || !to) { audit.malformed = true; return done('malformed') }
      // FAIL CLOSED: Blockscout v2 internal transactions carry `success: boolean` (with `error` set when it
      // failed). An entry without an explicit boolean has an unknown execution status, which is not proof —
      // the whole trace is unavailable rather than guessing the transfer happened.
      if (typeof it.success !== 'boolean') { audit.missingSuccessStatus = true; return done('unknown_execution_status') }
      out.push({ from, to, value, success: it.success })
    }
    return done(out.length === 0 ? 'empty' : 'proven', out)
  }
}
