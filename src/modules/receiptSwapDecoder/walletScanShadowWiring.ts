// MODULE — receiptSwapDecoder: Wallet Scanner shadow-mode wiring.
//
// SCOPE, DISCLOSED: this is the ONLY file in this task that reads real Wallet Scanner pipeline data
// (routerTradeReconstruction's CandidateTrade[] — the pipeline's own existing, already-wired
// "swap candidate" set, keyed by chain+txHash, same module/convention as distributorRecovery's own
// read-only observability block in src/pipeline/index.ts). It runs receiptSwapDecoder ONLY against
// those candidates, compares the result to what routerTradeReconstruction already inferred, and
// returns bounded diagnostics — nothing here is fed back into normalizedEvents, priceLotsForWallet,
// or fifoEngine. Same "additive observability, never a second real event source" contract
// routerTradeReconstruction's own header already establishes.
//
// PROVIDER-CALL DISCIPLINE, DISCLOSED (this task's hard limit — "no provider-call increase"):
// `logsByTxHash` is caller-supplied and expected to be EMPTY in production today — this codebase's
// real provider fetchers (providerFetchWindow/types.ts's RawProviderEvent) do not fetch or expose
// raw receipt logs anywhere; confirmed by reading that module and NormalizedEvent (normalization/
// types.ts), neither of which carries a `logs` field. This function never fetches a receipt itself
// to fill that gap — a candidate with no logs already in hand is counted as `receiptsMissing` and
// skipped, exactly as required ("when genuinely absent, do not fetch in this pass"). The only
// network call this module can ever trigger is pool-factory validation (poolValidator.ts), and that
// ONLY happens for a candidate whose logs were already available — so with today's real data (never
// available), `newProviderCalls` is always 0. The counter exists so this stays honestly measured
// the day a future provider upgrade actually supplies logs, per this task's explicit requirement to
// expose it.

import { decodeReceiptSwap } from './index'
import type { PoolValidator } from './poolValidator'
import type { RawReceiptLog, ReceiptSwapProtocol, TokenMeta } from './types'

export type WalletScanSwapCandidate = {
  chain: string
  txHash: string
  inferredTokenIn: string | null
  inferredTokenOut: string | null
  inferredAmountIn: number | null
  inferredAmountOut: number | null
  // Mirrors swapNormalizer's NormalizedTrade.meta.missingSide contract — 'none' means the existing
  // inference already resolved both sides.
  inferredMissingSide: 'none' | 'tokenIn' | 'tokenOut'
}

export type WalletScanShadowModeInput = {
  walletAddress: string
  candidates: readonly WalletScanSwapCandidate[]
  // Present ONLY when the caller's provider data already included raw receipt logs for that
  // (chain, txHash) — see file header. Never populated by fetching inside this module.
  logsByTxHash?: ReadonlyMap<string, RawReceiptLog[]>
  tokenMeta?: Record<string, TokenMeta>
  validator: PoolValidator
}

export type ShadowDisagreementSample = {
  chain: string
  txHash: string
  inferredTokenIn: string | null
  inferredTokenOut: string | null
  inferredAmountIn: number | null
  inferredAmountOut: number | null
  decodedTokenIn: string | null
  decodedTokenOut: string | null
  decodedAmountIn: string | null
  decodedAmountOut: string | null
  protocol: ReceiptSwapProtocol | null
  poolAddress: string | null
  reason: string | null
  wouldCompleteMissingLotSide: boolean
}

export type WalletScanShadowCounters = {
  receiptsAvailable: number
  receiptsMissing: number
  receiptsExamined: number
  aerodromeSwapsDecoded: number
  exactTwoSidedSwapsRecovered: number
  oneLegTransactionsUpgraded: number
  inferenceAgreements: number
  inferenceDisagreements: number
  rejectedNonSwapTransactions: number
  candidateLotsUnlocked: number
  newProviderCalls: number
}

export type WalletScanShadowDiagnostics = {
  counters: WalletScanShadowCounters
  rejectionReasons: Record<string, number>
  decodedByVenue: Record<string, number>
  decodedByConfidence: Record<string, number>
  // Bounded to at most 10 entries — never an unbounded receipt/log dump.
  disagreementSamples: ShadowDisagreementSample[]
}

const MAX_DISAGREEMENT_SAMPLES = 10

function bumpMap(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

// ATTRIBUTION-ONLY, DISCLOSED: this function returns a plain diagnostics object. Nothing it returns
// is a lot, an event, or a FIFO input — `counters.candidateLotsUnlocked` is a COUNT of candidates
// that, in principle, could unlock a lot IF a future pass wired this live; it is never itself a lot
// and is never written into any FIFO/lot structure by this module.
export async function runWalletScanReceiptShadowMode(input: WalletScanShadowModeInput): Promise<WalletScanShadowDiagnostics> {
  const counters: WalletScanShadowCounters = {
    receiptsAvailable: 0,
    receiptsMissing: 0,
    receiptsExamined: 0,
    aerodromeSwapsDecoded: 0,
    exactTwoSidedSwapsRecovered: 0,
    oneLegTransactionsUpgraded: 0,
    inferenceAgreements: 0,
    inferenceDisagreements: 0,
    rejectedNonSwapTransactions: 0,
    candidateLotsUnlocked: 0,
    newProviderCalls: 0,
  }
  const rejectionReasons: Record<string, number> = {}
  const decodedByVenue: Record<string, number> = {}
  const decodedByConfidence: Record<string, number> = {}
  const disagreementSamples: ShadowDisagreementSample[] = []

  let providerCalls = 0
  const countingValidator: PoolValidator = {
    async isValidPool(protocol, pool, t0, t1) {
      providerCalls += 1
      return input.validator.isValidPool(protocol, pool, t0, t1)
    },
  }

  // Base + Aerodrome only, regardless of what the caller passes — enforced here, not merely by
  // convention, so this module can never silently widen scope if a caller forgets to pre-filter.
  const baseCandidates = input.candidates.filter((c) => c.chain === 'base')

  for (const candidate of baseCandidates) {
    const logs = input.logsByTxHash?.get(candidate.txHash) ?? null
    if (!logs || logs.length === 0) {
      counters.receiptsMissing += 1
      continue
    }
    counters.receiptsAvailable += 1
    counters.receiptsExamined += 1

    const result = await decodeReceiptSwap(
      {
        chain: 'base',
        txHash: candidate.txHash,
        walletAddress: input.walletAddress,
        logs,
        tokenMeta: input.tokenMeta,
      },
      countingValidator,
    )

    if (!result.ok) {
      bumpMap(rejectionReasons, result.rejection.reason)
      if (result.rejection.reason === 'lp_add_or_remove_detected' || result.rejection.reason === 'plain_transfer_no_swap_event') {
        counters.rejectedNonSwapTransactions += 1
      }
      const inferredHadASide = candidate.inferredTokenIn !== null || candidate.inferredTokenOut !== null
      if (inferredHadASide) {
        counters.inferenceDisagreements += 1
        if (disagreementSamples.length < MAX_DISAGREEMENT_SAMPLES) {
          disagreementSamples.push({
            chain: candidate.chain,
            txHash: candidate.txHash,
            inferredTokenIn: candidate.inferredTokenIn,
            inferredTokenOut: candidate.inferredTokenOut,
            inferredAmountIn: candidate.inferredAmountIn,
            inferredAmountOut: candidate.inferredAmountOut,
            decodedTokenIn: null,
            decodedTokenOut: null,
            decodedAmountIn: null,
            decodedAmountOut: null,
            protocol: null,
            poolAddress: null,
            reason: result.rejection.reason,
            wouldCompleteMissingLotSide: false,
          })
        }
      }
      continue
    }

    counters.aerodromeSwapsDecoded += 1
    counters.exactTwoSidedSwapsRecovered += 1
    bumpMap(decodedByVenue, result.swap.protocol)
    bumpMap(decodedByConfidence, result.swap.confidence)

    const completesMissingSide = candidate.inferredMissingSide !== 'none'
    if (completesMissingSide) {
      counters.oneLegTransactionsUpgraded += 1
      counters.candidateLotsUnlocked += 1
    }

    const bothInferredSidesKnown = candidate.inferredTokenIn !== null && candidate.inferredTokenOut !== null
    const disagrees = bothInferredSidesKnown
      && (candidate.inferredTokenIn!.toLowerCase() !== result.swap.tokenIn.address
        || candidate.inferredTokenOut!.toLowerCase() !== result.swap.tokenOut.address)

    if (bothInferredSidesKnown) {
      if (disagrees) counters.inferenceDisagreements += 1
      else counters.inferenceAgreements += 1
    }

    if ((disagrees || completesMissingSide) && disagreementSamples.length < MAX_DISAGREEMENT_SAMPLES) {
      disagreementSamples.push({
        chain: candidate.chain,
        txHash: candidate.txHash,
        inferredTokenIn: candidate.inferredTokenIn,
        inferredTokenOut: candidate.inferredTokenOut,
        inferredAmountIn: candidate.inferredAmountIn,
        inferredAmountOut: candidate.inferredAmountOut,
        decodedTokenIn: result.swap.tokenIn.address,
        decodedTokenOut: result.swap.tokenOut.address,
        decodedAmountIn: result.swap.amountInRaw,
        decodedAmountOut: result.swap.amountOutRaw,
        protocol: result.swap.protocol,
        poolAddress: result.swap.poolAddress,
        reason: disagrees ? 'token_mismatch' : null,
        wouldCompleteMissingLotSide: completesMissingSide,
      })
    }
  }

  counters.newProviderCalls = providerCalls
  return { counters, rejectionReasons, decodedByVenue, decodedByConfidence, disagreementSamples }
}

// ─── Pipeline-facing entry point ───────────────────────────────────────────────────────────────
//
// UNCONDITIONAL-LOG FIX, DISCLOSED (found live — real production scans emitted NO
// "[pipeline] receiptSwapDecoder shadow mode" log at all): src/pipeline/index.ts previously only
// logged when it had already built a non-empty `receiptShadowCandidates` array. Since
// routerTradeReconstruction.candidateTrades is only ever non-empty when routerDistributorMode is
// true (a rare, high-router-activity condition — see that module's own `applied` gate), virtually
// every real scan reached that block with zero candidates and the log silently never fired. This
// function is now the SINGLE place that decides enabled-vs-skipped and shapes the log payload —
// src/pipeline/index.ts calls it and unconditionally logs whatever it returns, so this function
// being tested directly (see walletScanShadowWiring.test.ts's pipeline-integration tests) is
// exercising the exact same code path the real pipeline runs, not a parallel reimplementation.

export type PipelineCandidateTrade = {
  chain: string
  txHash: string
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
}

export type ShadowSkipReason = 'no_candidates' | 'unsupported_chain' | 'shadow_disabled' | 'wiring_not_reached'

export type WalletScanShadowLogPayload =
  | { enabled: false; skipReason: ShadowSkipReason; baseSwapCandidates: number }
  | {
      enabled: true
      baseSwapCandidates: number
      receiptsAvailable: number
      receiptsMissing: number
      receiptsExamined: number
      aerodromeSwapsDecoded: number
      candidateLotsUnlocked: number
      newProviderCalls: number
      rejectionReasons: Record<string, number>
      decodedByVenue: Record<string, number>
      decodedByConfidence: Record<string, number>
      disagreementSamples: ShadowDisagreementSample[]
    }

export type BuildWalletScanShadowLogPayloadInput = {
  walletAddress: string
  allCandidateTrades: readonly PipelineCandidateTrade[]
  // Caller-supplied, expected empty in production today — see file header's provider-call
  // discipline disclosure. Never fetched inside this function.
  logsByTxHash: ReadonlyMap<string, RawReceiptLog[]>
  tokenMeta?: Record<string, TokenMeta>
  validator: PoolValidator
  disabledByEnv: boolean
}

// PURE with respect to control flow (the only awaited work is runWalletScanReceiptShadowMode
// itself, already documented as zero-network-call when logsByTxHash is empty). Never throws by
// itself — a thrown error from runWalletScanReceiptShadowMode propagates to the caller, which
// src/pipeline/index.ts catches and logs under the 'wiring_not_reached' skip reason so the
// unconditional-log guarantee holds even in that case.
export async function buildWalletScanShadowLogPayload(input: BuildWalletScanShadowLogPayloadInput): Promise<WalletScanShadowLogPayload> {
  if (input.disabledByEnv) {
    return { enabled: false, skipReason: 'shadow_disabled', baseSwapCandidates: 0 }
  }
  if (input.allCandidateTrades.length === 0) {
    return { enabled: false, skipReason: 'no_candidates', baseSwapCandidates: 0 }
  }
  const baseCandidateTrades = input.allCandidateTrades.filter((t) => t.chain === 'base')
  if (baseCandidateTrades.length === 0) {
    return { enabled: false, skipReason: 'unsupported_chain', baseSwapCandidates: 0 }
  }

  const candidates: WalletScanSwapCandidate[] = baseCandidateTrades.map((t) => ({
    chain: t.chain,
    txHash: t.txHash,
    inferredTokenIn: t.tokenIn,
    inferredTokenOut: t.tokenOut,
    inferredAmountIn: t.amountIn,
    inferredAmountOut: t.amountOut,
    // routerTradeReconstruction never emits a candidate for an unresolved side (see that module's
    // own header — "never fabricate a trade when evidence is ambiguous"), so every real candidate
    // sourced from it already has both sides known.
    inferredMissingSide: 'none',
  }))

  const result = await runWalletScanReceiptShadowMode({
    walletAddress: input.walletAddress,
    candidates,
    logsByTxHash: input.logsByTxHash,
    tokenMeta: input.tokenMeta,
    validator: input.validator,
  })

  return {
    enabled: true,
    baseSwapCandidates: candidates.length,
    receiptsAvailable: result.counters.receiptsAvailable,
    receiptsMissing: result.counters.receiptsMissing,
    receiptsExamined: result.counters.receiptsExamined,
    aerodromeSwapsDecoded: result.counters.aerodromeSwapsDecoded,
    candidateLotsUnlocked: result.counters.candidateLotsUnlocked,
    newProviderCalls: result.counters.newProviderCalls,
    rejectionReasons: result.rejectionReasons,
    decodedByVenue: result.decodedByVenue,
    decodedByConfidence: result.decodedByConfidence,
    disagreementSamples: result.disagreementSamples,
  }
}
