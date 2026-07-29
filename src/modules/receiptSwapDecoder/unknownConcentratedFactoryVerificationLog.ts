// MODULE — receiptSwapDecoder: one flat, scalar-only production log line per examined unknown
// concentrated-factory verification attempt (unknownConcentratedFactoryVerifier.ts).
//
// Same convention as uniswapV3ForensicLog.ts / concentratedPoolEmitterForensicLog.ts's own headers:
// every field here is a string, number, or boolean — never an array or nested object.

import type { UnknownConcentratedFactoryVerificationDiagnostics } from './unknownConcentratedFactoryVerifier'

export const UNKNOWN_CONCENTRATED_FACTORY_VERIFICATION_LOG_LABEL = '[pipeline] unknown concentrated factory verification'

export type UnknownConcentratedFactoryVerificationLogRecord = {
  txHash: string
  eventEmitter: string
  claimedFactory: string
  factoryCodeHash: string
  discoveryMethod: string
  discoveredPool: string
  emitterMatchesDiscoveredPool: string
  poolCodeHash: string
  knownImplementationCodeMatch: string
  proposedProtocol: string
  confidence: string
  finalTypedReason: string
}

// PURE, DISCLOSED: derives every field from the diagnostics object already produced by
// unknownConcentratedFactoryVerifier.ts — no I/O, no additional RPC calls.
export function buildUnknownConcentratedFactoryVerificationLogRecord(
  diagnostics: UnknownConcentratedFactoryVerificationDiagnostics,
): UnknownConcentratedFactoryVerificationLogRecord {
  return {
    txHash: diagnostics.txHash,
    eventEmitter: diagnostics.eventEmitter.toLowerCase(),
    claimedFactory: diagnostics.claimedFactory.toLowerCase(),
    factoryCodeHash: diagnostics.factoryCodeHash ?? 'none',
    discoveryMethod: diagnostics.discoveryMethod ?? 'unsupported',
    discoveredPool: (diagnostics.discoveredPool ?? 'none').toLowerCase(),
    emitterMatchesDiscoveredPool: diagnostics.emitterMatchesDiscoveredPool === null ? 'unknown' : String(diagnostics.emitterMatchesDiscoveredPool),
    poolCodeHash: diagnostics.poolCodeHash ?? 'none',
    knownImplementationCodeMatch: diagnostics.knownImplementationCodeMatch === null ? 'unknown' : String(diagnostics.knownImplementationCodeMatch),
    proposedProtocol: diagnostics.proposedProtocol ?? 'none',
    confidence: diagnostics.confidence,
    finalTypedReason: diagnostics.finalTypedReason,
  }
}
