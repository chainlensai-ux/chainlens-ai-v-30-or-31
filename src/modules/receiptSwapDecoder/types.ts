// MODULE — receiptSwapDecoder: type definitions.
//
// PHASE 1, BASE ONLY, DISCLOSED: Aerodrome Classic (volatile) + Aerodrome Slipstream swaps only.
// No Uniswap, no aggregators, no other chains yet — see index.ts's own header for the full scope
// disclosure.
//
// STANDALONE, NOT WIRED INTO THE PIPELINE (same pattern as src/modules/swapNormalizer — see that
// module's own header): this is additive, new, and does not modify src/pipeline/index.ts,
// workers/walletScanV2.ts, FIFO, pricing gates, or any existing public output. Shadow-mode
// aggregation (shadowMode.ts) is a pure function callers can invoke against a batch of decoded
// receipts to get the required visibility counters — wiring it live into the production worker is
// an explicit later step, not this pass ("Do not promote decoded swaps into canonical FIFO in this
// pass").

export type ReceiptSwapChain = 'base'

export type ReceiptSwapProtocol = 'aerodrome_classic' | 'aerodrome_slipstream' | 'uniswap_v3'

// One raw, undecoded EVM log entry from a transaction receipt.
export type RawReceiptLog = {
  logIndex: number
  address: string
  topics: string[]
  data: string
}

// Minimal per-token metadata a caller must supply (symbol/decimals are never recoverable from a
// raw log alone) — same shape convention as swapNormalizer's TokenRef.
export type TokenMeta = { symbol: string; decimals: number }

export type ReceiptTxBundle = {
  chain: ReceiptSwapChain
  txHash: string
  walletAddress: string
  // The router/aggregator contract the wallet's own top-level call was sent to, if known. Used only
  // to identify router-intermediary legs — never trusted alone to decide protocol/pool identity.
  router?: string | null
  logs: RawReceiptLog[]
  // token address (lowercased) -> metadata. Missing entries fall back to decimals=18, symbol='?'.
  tokenMeta?: Record<string, TokenMeta>
}

export type TokenRef = {
  address: string
  symbol: string
  decimals: number
}

export type WalletDirection = 'wallet_sold_tokenIn' | 'wallet_bought_tokenOut' | 'wallet_swapped'

export type EvidenceSource =
  | 'receipt_pool_swap_event'
  | 'receipt_pool_swap_event_multi_hop'
  | 'inference_fallback'

export type DecodedSwapConfidence = 'exact' | 'high' | 'low'

// Canonical decoded-swap shape required by this task.
export type DecodedReceiptSwap = {
  chain: ReceiptSwapChain
  txHash: string
  protocol: ReceiptSwapProtocol
  poolAddress: string
  tokenIn: TokenRef
  tokenOut: TokenRef
  amountInRaw: string
  amountOutRaw: string
  decimals: { tokenIn: number; tokenOut: number }
  normalizedAmountIn: number
  normalizedAmountOut: number
  walletDirection: WalletDirection
  evidenceSource: EvidenceSource
  confidence: DecodedSwapConfidence
  // Diagnostics — never required by a consumer, never used to gate FIFO/pricing.
  meta: {
    hops: number
    poolsVisited: string[]
    nativeWrapDetected: boolean
    refundDetected: boolean
    feeLegsExcluded: number
    // Present only when a Classic leg went through the multi-transfer resolver (multiTransferLeg.ts)
    // — see that module's own header. Absent for Slipstream-only decodes.
    multiTransfer?: MultiTransferDiagnostics
    // Present only for protocol === 'uniswap_v3' — the exact fee tier the Uniswap V3 factory's own
    // getPool() confirmed for this pool (see uniswapV3PoolValidator.ts) — never guessed from the
    // Swap event itself (V3's Swap event carries no fee field).
    uniswapV3Fee?: number
    // Present only for protocol === 'uniswap_v3' — the full forensic diagnostics from the
    // validation attempt that succeeded (finalTypedReason: 'validated').
    uniswapV3Validation?: UniswapV3ValidationDiagnostics
  }
}

// Bounded, shadow/debug-only diagnostics from one Uniswap V3 factory validation attempt — see
// uniswapV3PoolValidator.ts's own header for the full disclosure. Restated here (not imported) to
// avoid a circular type dependency between types.ts and uniswapV3PoolValidator.ts.
export type UniswapV3ValidationDiagnostics = {
  eventEmitter: string
  configuredFactory: string
  token0: string
  token1: string
  fee: number | null
  feeSource: 'factory_getPool_fee_tier_match' | 'unavailable'
  getPoolResult: string | null
  emitterMatchesResult: boolean
  reversedTokenOrderAttempted: boolean
  reversedGetPoolResult: string | null
  finalTypedReason:
    | 'validated'
    | 'invalid_token_pair'
    | 'rpc_failure'
    | 'factory_returned_zero'
    | 'factory_pool_mismatch'
    | 'fee_unavailable'
    | 'validation_cap_exceeded'
}

// Bounded, shadow/debug-only diagnostics from the Classic multi-transfer resolver — never used to
// gate/change the decode itself, purely aggregated by callers (e.g. walletScanShadowWiring.ts)
// into the requested batch-level counters.
export type MultiTransferDiagnostics = {
  examined: boolean
  resolved: boolean
  swapEventAmountMatched: boolean | null
  routerIntermediaryTransfersIgnored: number
  refundNetted: boolean
}

// Why decoding did not produce a canonical swap for this tx — always a real, attributable reason,
// never a silent drop. `reason` values are stable strings intended for aggregate counting in
// shadow mode.
export type ReceiptDecodeRejection = {
  txHash: string
  reason:
    | 'no_logs'
    | 'no_recognized_pool_swap_event'
    | 'pool_not_validated_by_factory'
    | 'lp_add_or_remove_detected'
    | 'plain_transfer_no_swap_event'
    | 'contradictory_legs'
    | 'malformed_log_data'
    // Classic multi-transfer resolution found the right token(s) but the aggregated pool-transfer
    // sum did not match the Swap event's own authoritative amount within the 1-raw-unit tolerance
    // (e.g. a fee-on-transfer token, or a genuinely inconsistent receipt) — never accepted as a
    // guess, always fails closed.
    | 'swap_event_amount_mismatch'
    // UNISWAP V3, DISCLOSED (see uniswapV3Leg.ts / uniswapV3PoolValidator.ts) — only ever attempted
    // as a fallback for a SINGLE concentrated-liquidity-shaped Swap event whose Aerodrome Slipstream
    // factory validation genuinely failed first ("do not treat Slipstream pools as Uniswap V3").
    | 'uniswap_v3_sign_ambiguous'
    | 'uniswap_v3_ambiguous_token_mapping'
    | 'uniswap_v3_amount_mismatch'
    // FORENSIC VALIDATION REASONS, DISCLOSED (this task — replaces the old single generic
    // 'uniswap_v3_pool_not_validated' with the exact distinguishable outcomes requested; see
    // uniswapV3PoolValidator.ts's own header for what each one means). 'likely_non_uniswap_v3_factory'
    // is a higher-level conclusion decodeReceiptSwap draws (the validator's own factory_returned_zero
    // PLUS Aerodrome's factories having already failed first) — the validator itself never returns it.
    | 'invalid_token_pair'
    | 'rpc_failure'
    | 'factory_returned_zero'
    | 'factory_pool_mismatch'
    | 'fee_unavailable'
    | 'likely_non_uniswap_v3_factory'
    | 'validation_cap_exceeded'
  multiTransfer?: MultiTransferDiagnostics
  uniswapV3?: UniswapV3Diagnostics
  // Bounded, shadow/debug-only forensic diagnostics for the exact Uniswap V3 factory validation
  // attempt that produced one of the reasons above — see uniswapV3PoolValidator.ts's own header.
  uniswapV3Validation?: UniswapV3ValidationDiagnostics
}

// Bounded, shadow/debug-only diagnostics from the Uniswap V3 resolver (uniswapV3Leg.ts) — never
// used to gate/change the decode itself.
export type UniswapV3Diagnostics = {
  examined: boolean
  resolved: boolean
  signValid: boolean | null
  amountMatched: boolean | null
  routerIntermediaryTransfersIgnored: number
}

export type ReceiptDecodeResult =
  | { ok: true; swap: DecodedReceiptSwap }
  | { ok: false; rejection: ReceiptDecodeRejection }
