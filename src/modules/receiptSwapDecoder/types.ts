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

export type ReceiptSwapProtocol = 'aerodrome_classic' | 'aerodrome_slipstream'

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
  }
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
  multiTransfer?: MultiTransferDiagnostics
}

export type ReceiptDecodeResult =
  | { ok: true; swap: DecodedReceiptSwap }
  | { ok: false; rejection: ReceiptDecodeRejection }
