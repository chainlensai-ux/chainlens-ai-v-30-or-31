// MODULE — receiptSwapDecoder: one flat, scalar-only production log line per examined unsupported
// concentrated-factory forensic analysis (unsupportedFactoryForensics.ts).
//
// Same convention as this module set's other forensic log builders: every field here is a string,
// number, or boolean — never an array or nested object.

import type { UnsupportedFactoryForensicsDiagnostics } from './unsupportedFactoryForensics'

export const UNSUPPORTED_FACTORY_FORENSIC_LOG_LABEL = '[pipeline] unsupported concentrated factory forensic'

export type UnsupportedFactoryForensicsLogRecord = {
  txHash: string
  pool: string
  claimedFactory: string
  factoryCodeHash: string
  proxyType: string
  implementationAddress: string
  implementationCodeHash: string
  create2Detected: boolean
  poolCreatedTopicDetected: boolean
  creationReceiptAvailable: boolean
  creationEventEmitter: string
  creationEventPool: string
  creationEventToken0: string
  creationEventToken1: string
  creationEventFee: string
  creationProofMatches: string
  finalTypedReason: string
}

// PURE, DISCLOSED: derives every field from the diagnostics object already produced by
// unsupportedFactoryForensics.ts — no I/O, no additional RPC calls.
export function buildUnsupportedFactoryForensicsLogRecord(
  diagnostics: UnsupportedFactoryForensicsDiagnostics,
): UnsupportedFactoryForensicsLogRecord {
  return {
    txHash: diagnostics.txHash,
    pool: diagnostics.pool.toLowerCase(),
    claimedFactory: diagnostics.claimedFactory.toLowerCase(),
    factoryCodeHash: diagnostics.factoryCodeHash ?? 'none',
    proxyType: diagnostics.proxyType ?? 'unknown',
    implementationAddress: (diagnostics.implementationAddress ?? 'none').toLowerCase(),
    implementationCodeHash: diagnostics.implementationCodeHash ?? 'none',
    create2Detected: diagnostics.create2Detected,
    poolCreatedTopicDetected: diagnostics.poolCreatedTopicDetected,
    creationReceiptAvailable: diagnostics.creationReceiptAvailable,
    creationEventEmitter: (diagnostics.creationEventEmitter ?? 'none').toLowerCase(),
    creationEventPool: (diagnostics.creationEventPool ?? 'none').toLowerCase(),
    creationEventToken0: (diagnostics.creationEventToken0 ?? 'none').toLowerCase(),
    creationEventToken1: (diagnostics.creationEventToken1 ?? 'none').toLowerCase(),
    creationEventFee: diagnostics.creationEventFee === null ? 'none' : String(diagnostics.creationEventFee),
    creationProofMatches: diagnostics.creationProofMatches === null ? 'unknown' : String(diagnostics.creationProofMatches),
    finalTypedReason: diagnostics.finalTypedReason,
  }
}
