// UNMATCHED SELL FORENSICS: one persisted row per unmatched sell (capped), so the reason each sell
// still blocks (or no longer does) is on the scan result rather than only in a log line. Pure; built
// from values the pipeline already computed. Never changes FIFO, cost basis or coverage status.

import type { UnmatchedEventIdentity } from '../modules/fifoEngine/types'
import type { HistoryCoverageStatus, WindowBoundaryProofDiagnostics } from '../modules/eventClassification/index'
import type { BoundaryDependentSellResolutionRow, TargetedRecoveryOutcome, BoundaryDependentSellDisposition } from '../modules/eventClassification/boundaryDependentSellResolution'
import { unmatchedSellProofKey } from '../modules/eventClassification/boundaryDependentSellResolution'

export const MAX_UNMATCHED_SELL_FORENSIC_ROWS = 100

export type UnmatchedSellForensicBucket =
  | WindowBoundaryProofDiagnostics['boundaryRequiredSells'][number]['reason']
  | WindowBoundaryProofDiagnostics['boundaryIndependentSells'][number]['reason']
  // Not blocking after the final audit (proven non-trade, proven pre-window exit, or exhaustive history).
  | 'non_blocking'

export type UnmatchedSellForensicRow = {
  chain: string
  txHash: string
  token: string
  timestamp: number
  unmatchedRaw: string | null
  sellRaw: string | null
  bucket: UnmatchedSellForensicBucket
  receiptProof: string | null
  targetedRecoveryOutcome: TargetedRecoveryOutcome | null
  finalDisposition: BoundaryDependentSellDisposition | null
  tokenSkippedByFetchCap: boolean
  historyCoverageStatus: HistoryCoverageStatus
}

export type UnmatchedSellForensics = {
  totalUnmatchedSells: number
  rowsReturned: number
  truncated: boolean
  historyCoverageStatus: HistoryCoverageStatus
  tokensSkippedByFetchCap: string[]
  rows: UnmatchedSellForensicRow[]
}

export function buildUnmatchedSellForensics(params: {
  unmatchedSellEvents: readonly UnmatchedEventIdentity[]
  boundaryProofDiagnostics: Pick<WindowBoundaryProofDiagnostics, 'boundaryRequiredSells' | 'boundaryIndependentSells'>
  resolverRows: readonly BoundaryDependentSellResolutionRow[]
  receiptProofByTxHash: ReadonlyMap<string, string>
  historyCoverageStatus: HistoryCoverageStatus
  tokensSkippedByFetchCap?: readonly string[]
  maxRows?: number
}): UnmatchedSellForensics {
  const maxRows = params.maxRows ?? MAX_UNMATCHED_SELL_FORENSIC_ROWS
  const bucketByKey = new Map<string, UnmatchedSellForensicBucket>()
  for (const s of params.boundaryProofDiagnostics.boundaryRequiredSells) bucketByKey.set(unmatchedSellProofKey(s), s.reason)
  for (const s of params.boundaryProofDiagnostics.boundaryIndependentSells) bucketByKey.set(unmatchedSellProofKey(s), s.reason)
  const rowByKey = new Map(params.resolverRows.map((row) => [row.identity, row] as const))

  // Deterministic order regardless of provider/event order: time, then tx, then token.
  const sorted = [...params.unmatchedSellEvents].sort((a, b) =>
    a.timestamp - b.timestamp
    || a.txHash.toLowerCase().localeCompare(b.txHash.toLowerCase())
    || a.token.toLowerCase().localeCompare(b.token.toLowerCase())
    || a.chain.localeCompare(b.chain))
  const rows: UnmatchedSellForensicRow[] = sorted.slice(0, maxRows).map((sell) => {
    const key = unmatchedSellProofKey(sell)
    const resolved = rowByKey.get(key) ?? null
    return {
      chain: sell.chain,
      txHash: sell.txHash,
      token: sell.token,
      timestamp: sell.timestamp,
      unmatchedRaw: sell.unmatchedRaw ?? null,
      sellRaw: sell.sellRaw ?? sell.amountRaw ?? null,
      bucket: bucketByKey.get(key) ?? 'non_blocking',
      receiptProof: resolved?.receiptProof ?? params.receiptProofByTxHash.get(sell.txHash.toLowerCase()) ?? null,
      targetedRecoveryOutcome: resolved?.targetedRecoveryOutcome ?? null,
      finalDisposition: resolved?.finalDisposition ?? null,
      tokenSkippedByFetchCap: resolved?.tokenSkippedByFetchCap ?? false,
      historyCoverageStatus: params.historyCoverageStatus,
    }
  })
  return {
    totalUnmatchedSells: params.unmatchedSellEvents.length,
    rowsReturned: rows.length,
    truncated: params.unmatchedSellEvents.length > rows.length,
    historyCoverageStatus: params.historyCoverageStatus,
    tokensSkippedByFetchCap: [...(params.tokensSkippedByFetchCap ?? [])],
    rows,
  }
}
