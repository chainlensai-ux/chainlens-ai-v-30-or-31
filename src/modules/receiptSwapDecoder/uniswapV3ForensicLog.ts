// MODULE — receiptSwapDecoder: one flat, scalar-only production log line per examined Uniswap V3
// pool-validation attempt.
//
// GOAL, DISCLOSED: production evidence showed finalTypedReason correctly reaching
// factory_pool_mismatch and amount reconciliation passing, but `factoryValidationAttempts` printed
// as `[Array]` inside the batched "[pipeline] receiptSwapDecoder shadow mode" log payload —
// Vercel's console formatter truncates nested arrays/objects past its default inspect depth,
// hiding the decisive per-fee-tier getPool() values needed to tell factory_pool_mismatch apart
// from factory_returned_zero. This module builds ONE separate, fully flat record (every field a
// string/number/boolean — no arrays, no nested objects) per examined Uniswap V3 candidate, from the
// SAME `UniswapV3ValidationDiagnostics` object decodeReceiptSwap/uniswapV3PoolValidator.ts already
// produced. Zero additional getPool() or provider calls — arrays are only ever joined into compact
// strings here, never re-derived.
//
// BOUNDED, DISCLOSED: the caller (walletScanShadowWiring.ts) only ever has a diagnostics object to
// pass here for a receipt it already fetched and examined — the same <= 10-receipt cap
// receiptAcquisition.ts enforces, never a separate/unbounded log volume.

import type { UniswapV3ValidationDiagnostics } from './types'

export const UNISWAP_V3_FORENSIC_LOG_LABEL = '[pipeline] Uniswap V3 receipt validation forensic'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type UniswapV3ForensicLogRecord = {
  txHash: string
  eventEmitter: string
  configuredFactory: string
  token0: string
  token1: string
  feeAttempts: string
  matchingFee: string
  feeSource: string
  getPoolResults: string
  matchingGetPoolResult: string
  emitterMatchesResult: boolean
  reversedTokenOrderAttempted: boolean
  reversedGetPoolResults: string
  finalTypedReason: string
  // Distinguishes the two ways `factory_pool_mismatch` can occur (this task's own requirement):
  // 'single_fee_tier_pool_mismatch:fee=<fee>,returnedPool=<addr>' when exactly one (fee tier, token
  // order) combination returned a real, non-zero pool that simply differs from the emitter address
  // -- vs 'multiple_or_ambiguous_fee_tier_pools' when more than one combination returned a non-zero
  // pool. 'not_applicable' for any other finalTypedReason.
  mismatchDetail: string
}

// Joins fee tiers with their aligned getPool() results into one compact, flat string —
// e.g. "500=0x000...000,3000=0xabc...def,10000=0x000...000" — never a nested array in the log.
function joinFeeResultPairs(feeAttempts: readonly number[], results: readonly (string | null)[]): string {
  if (feeAttempts.length === 0) return 'not_attempted'
  return feeAttempts.map((fee, i) => `${fee}=${(results[i] ?? 'rpc_error').toLowerCase()}`).join(',')
}

function computeMismatchDetail(diagnostics: UniswapV3ValidationDiagnostics): string {
  if (diagnostics.finalTypedReason !== 'factory_pool_mismatch') return 'not_applicable'

  // DEDUPLICATE BY FEE+RETURNED ADDRESS, DISCLOSED (this task — production proof: primary and the
  // order-reversed fallback both legitimately hit the SAME real pool at the SAME fee tier, since
  // Uniswap-shaped factories sort tokens internally and are order-independent — counting that one
  // real pool twice, once per attempt, previously misclassified an honest single-fee-tier mismatch
  // as 'multiple_or_ambiguous_fee_tier_pools'). A (fee, address) pair is one real-world fact
  // regardless of how many token-order attempts happened to observe it.
  const seen = new Set<string>()
  const nonZeroHits: Array<{ fee: number; pool: string }> = []
  const record = (fee: number, pool: string | null): void => {
    if (!pool || pool.toLowerCase() === ZERO_ADDRESS) return
    const key = `${fee}:${pool.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    nonZeroHits.push({ fee, pool })
  }
  diagnostics.feeAttempts.forEach((fee, i) => record(fee, diagnostics.getPoolResults[i]))
  diagnostics.feeAttempts.forEach((fee, i) => record(fee, diagnostics.reversedGetPoolResults[i]))

  if (nonZeroHits.length === 1) {
    return `single_fee_tier_pool_mismatch:fee=${nonZeroHits[0].fee},returnedPool=${nonZeroHits[0].pool.toLowerCase()}`
  }
  if (nonZeroHits.length > 1) return 'multiple_or_ambiguous_fee_tier_pools'
  return 'no_nonzero_pool_found'
}

// PURE, DISCLOSED: derives every field from the diagnostics object already passed in — no I/O, no
// additional getPool()/provider calls, no mutation of its input.
export function buildUniswapV3ForensicLogRecord(txHash: string, diagnostics: UniswapV3ValidationDiagnostics): UniswapV3ForensicLogRecord {
  return {
    txHash,
    eventEmitter: diagnostics.eventEmitter.toLowerCase(),
    configuredFactory: diagnostics.configuredFactory.toLowerCase(),
    token0: diagnostics.token0.toLowerCase(),
    token1: diagnostics.token1.toLowerCase(),
    feeAttempts: diagnostics.feeAttempts.length > 0 ? diagnostics.feeAttempts.join(',') : 'not_attempted',
    matchingFee: diagnostics.fee === null ? 'none' : String(diagnostics.fee),
    feeSource: diagnostics.feeSource,
    getPoolResults: joinFeeResultPairs(diagnostics.feeAttempts, diagnostics.getPoolResults),
    matchingGetPoolResult: (diagnostics.getPoolResult ?? 'none').toLowerCase(),
    emitterMatchesResult: diagnostics.emitterMatchesResult,
    reversedTokenOrderAttempted: diagnostics.reversedTokenOrderAttempted,
    reversedGetPoolResults: diagnostics.reversedTokenOrderAttempted
      ? joinFeeResultPairs(diagnostics.feeAttempts, diagnostics.reversedGetPoolResults)
      : 'not_attempted',
    finalTypedReason: diagnostics.finalTypedReason,
    mismatchDetail: computeMismatchDetail(diagnostics),
  }
}
