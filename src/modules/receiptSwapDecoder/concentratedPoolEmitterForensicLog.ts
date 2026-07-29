// MODULE — receiptSwapDecoder: one flat, scalar-only production log line per examined
// concentrated-liquidity pool emitter fingerprint attempt (concentratedPoolEmitterFingerprint.ts).
//
// Same convention as uniswapV3ForensicLog.ts's own header: every field here is a string, number, or
// boolean — never an array or nested object — so a single console.warn(label, record) call is fully
// flat under Node's/Vercel's default console-inspect depth truncation.

import type { ConcentratedEmitterFingerprintDiagnostics } from './concentratedPoolEmitterFingerprint'

export const CONCENTRATED_POOL_EMITTER_FORENSIC_LOG_LABEL = '[pipeline] concentrated pool emitter forensic'

export type ConcentratedPoolEmitterForensicLogRecord = {
  txHash: string
  eventEmitter: string
  emitterFactory: string
  emitterToken0: string
  emitterToken1: string
  emitterFee: string
  runtimeCodeHash: string
  matchedProtocol: string
  matchedFactory: string
  tokenPairMatches: string
  finalTypedReason: string
}

// PURE, DISCLOSED: derives every field from the diagnostics object already produced by
// concentratedPoolEmitterFingerprint.ts — no I/O, no additional RPC calls.
export function buildConcentratedPoolEmitterForensicLogRecord(
  diagnostics: ConcentratedEmitterFingerprintDiagnostics,
): ConcentratedPoolEmitterForensicLogRecord {
  return {
    txHash: diagnostics.txHash,
    eventEmitter: diagnostics.eventEmitter.toLowerCase(),
    emitterFactory: (diagnostics.emitterFactory ?? 'none').toLowerCase(),
    emitterToken0: (diagnostics.emitterToken0 ?? 'none').toLowerCase(),
    emitterToken1: (diagnostics.emitterToken1 ?? 'none').toLowerCase(),
    emitterFee: diagnostics.emitterFee === null ? 'none' : String(diagnostics.emitterFee),
    runtimeCodeHash: diagnostics.runtimeCodeHash ?? 'none',
    matchedProtocol: diagnostics.matchedProtocol ?? 'none',
    matchedFactory: (diagnostics.matchedFactory ?? 'none').toLowerCase(),
    tokenPairMatches: diagnostics.tokenPairMatches === null ? 'unknown' : String(diagnostics.tokenPairMatches),
    finalTypedReason: diagnostics.finalTypedReason,
  }
}
