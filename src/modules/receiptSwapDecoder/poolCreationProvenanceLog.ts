// MODULE — receiptSwapDecoder: one flat, scalar-only log line per pool-creation provenance
// investigation (poolCreationProvenanceInvestigator.ts). FORENSIC/ADMIN-ONLY -- see that module's
// own header; this formatter is never invoked from a per-wallet-scan code path.

import type { PoolCreationProvenanceDiagnostics } from './poolCreationProvenanceInvestigator'

export type PoolCreationProvenanceLogRecord = {
  pool: string
  creationTxHash: string
  contractCreator: string
  transactionTo: string
  claimedFactoryInCreationPath: string
  creationReceiptFound: boolean
  exactPoolCreated: string
  tokenPairVerified: string
  feeVerified: string
  finalTypedReason: string
}

// PURE, DISCLOSED: derives every field from the diagnostics object already produced by
// poolCreationProvenanceInvestigator.ts — no I/O, no additional calls.
export function buildPoolCreationProvenanceLogRecord(
  diagnostics: PoolCreationProvenanceDiagnostics,
): PoolCreationProvenanceLogRecord {
  return {
    pool: diagnostics.pool.toLowerCase(),
    creationTxHash: diagnostics.creationTxHash ?? 'none',
    contractCreator: (diagnostics.contractCreator ?? 'none').toLowerCase(),
    transactionTo: (diagnostics.transactionTo ?? 'none').toLowerCase(),
    claimedFactoryInCreationPath: diagnostics.claimedFactoryInCreationPath === null ? 'unknown' : String(diagnostics.claimedFactoryInCreationPath),
    creationReceiptFound: diagnostics.creationReceiptFound,
    exactPoolCreated: diagnostics.exactPoolCreated === null ? 'unknown' : String(diagnostics.exactPoolCreated),
    tokenPairVerified: diagnostics.tokenPairVerified === null ? 'unknown' : String(diagnostics.tokenPairVerified),
    feeVerified: diagnostics.feeVerified === null ? 'unknown' : String(diagnostics.feeVerified),
    finalTypedReason: diagnostics.finalTypedReason,
  }
}
