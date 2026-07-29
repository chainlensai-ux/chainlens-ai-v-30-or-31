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
// PROVIDER-CALL DISCIPLINE, DISCLOSED (runWalletScanReceiptShadowMode below): `logsByTxHash` is a
// direct parameter here — a candidate with no logs already in hand is counted as `receiptsMissing`
// and skipped; this function itself never fetches a receipt. Bounded, real receipt ACQUISITION
// (up to 10 live eth_getTransactionReceipt calls per scan) now happens one layer up, in
// buildWalletScanShadowLogPayload below, via receiptAcquisition.ts — see that module's own header
// for the full disclosure (cap, concurrency, timeout, no-retry, cache/singleflight).

import { decodeReceiptSwap } from './index'
import type { PoolValidator } from './poolValidator'
import type { UniswapV3PoolValidator } from './uniswapV3PoolValidator'
import type { DecodedReceiptSwap, RawReceiptLog, ReceiptSwapProtocol, TokenMeta } from './types'
import { selectBaseReceiptCandidates, type CandidateTxEvidence, type CandidateSelectionResult } from './candidateSelector'
import {
  acquireReceiptsForCandidates, createReceiptRequestScopeCache, createLiveBaseReceiptFetcher,
  type ReceiptFetcher, type ReceiptRequestScopeCache,
} from './receiptAcquisition'
import {
  classifyReceiptForensics, createRecordingPoolValidator, MAX_FORENSIC_SAMPLES,
  type ReceiptForensicSample, type FactoryValidationAttempt,
} from './forensicClassifier'
import { buildUniswapV3ForensicLogRecord, UNISWAP_V3_FORENSIC_LOG_LABEL } from './uniswapV3ForensicLog'
import type { ConcentratedPoolEmitterFingerprinter } from './concentratedPoolEmitterFingerprint'
import {
  buildConcentratedPoolEmitterForensicLogRecord, CONCENTRATED_POOL_EMITTER_FORENSIC_LOG_LABEL,
} from './concentratedPoolEmitterForensicLog'
import type { UnknownConcentratedFactoryVerifier } from './unknownConcentratedFactoryVerifier'
import {
  buildUnknownConcentratedFactoryVerificationLogRecord, UNKNOWN_CONCENTRATED_FACTORY_VERIFICATION_LOG_LABEL,
} from './unknownConcentratedFactoryVerificationLog'

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
  // Optional — carried through from candidateSelector.ts's SelectedCandidate when this candidate
  // came from the real selector, purely for forensic attribution (see forensicClassifier.ts).
  // null/undefined for candidates built directly (e.g. tests), never required for decoding.
  priorityTier?: number | null
  priorityReason?: string | null
}

export type WalletScanShadowModeInput = {
  walletAddress: string
  candidates: readonly WalletScanSwapCandidate[]
  // Present ONLY when the caller's provider data already included raw receipt logs for that
  // (chain, txHash) — see file header. Never populated by fetching inside this module.
  logsByTxHash?: ReadonlyMap<string, RawReceiptLog[]>
  tokenMeta?: Record<string, TokenMeta>
  validator: PoolValidator
  // Optional — when supplied, a concentrated-liquidity-shaped Swap event whose Aerodrome Slipstream
  // validation genuinely fails is also attempted against the real Uniswap V3 factory (see
  // uniswapV3PoolValidator.ts / uniswapV3Leg.ts / index.ts's own header). Omitting this preserves
  // identical behavior to before this parameter existed.
  uniswapV3Validator?: UniswapV3PoolValidator
  // Optional — when supplied, a concentrated-liquidity Swap event whose Uniswap V3 factory
  // validation genuinely failed also gets its own emitter fingerprinted (see
  // concentratedPoolEmitterFingerprint.ts's own header). Omitting this preserves identical behavior
  // to before this parameter existed.
  emitterFingerprinter?: ConcentratedPoolEmitterFingerprinter
  // Optional — when supplied, an emitter whose factory() claim is 'unknown_concentrated_factory'
  // (see concentratedPoolEmitterFingerprint.ts) is additionally forensically verified against the
  // claimed factory itself (see unknownConcentratedFactoryVerifier.ts's own header). Omitting this
  // preserves identical behavior to before this parameter existed.
  unknownFactoryVerifier?: UnknownConcentratedFactoryVerifier
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
  // AERODROME CLASSIC MULTI-TRANSFER RESOLUTION, DISCLOSED — see multiTransferLeg.ts's own header
  // (production proof: a real 6-transfer/1-wrap Classic swap was rejected as contradictory_legs
  // purely for having more than one transfer per side). Aggregated across every Classic swap this
  // batch examined, regardless of whether it ultimately decoded successfully.
  multiTransferPoolFlowsExamined: number
  multiTransferPoolFlowsResolved: number
  swapEventAmountMatches: number
  swapEventAmountMismatches: number
  routerIntermediaryTransfersIgnored: number
  refundsNetted: number
  // UNISWAP V3 (BASE), DISCLOSED — see uniswapV3Leg.ts / uniswapV3PoolValidator.ts / index.ts's own
  // header. Aggregated across every concentrated-liquidity-shaped Swap event this batch attempted
  // the V3 fallback for, regardless of outcome.
  uniswapV3PoolsExamined: number
  uniswapV3PoolsValidated: number
  uniswapV3ValidationCalls: number
  uniswapV3SwapsDecoded: number
  uniswapV3AmountMatches: number
  uniswapV3AmountMismatches: number
}

export type WalletScanShadowDiagnostics = {
  counters: WalletScanShadowCounters
  rejectionReasons: Record<string, number>
  decodedByVenue: Record<string, number>
  decodedByConfidence: Record<string, number>
  // Bounded to at most 10 entries — never an unbounded receipt/log dump.
  disagreementSamples: ShadowDisagreementSample[]
  // Bounded, shadow/debug-only forensic classification of every EXAMINED receipt (at most
  // MAX_FORENSIC_SAMPLES = 10) — see forensicClassifier.ts's own header. Never used to change
  // selection or decoding; purely diagnostic.
  receiptForensics: ReceiptForensicSample[]
  // Bounded (<= MAX_FORENSIC_SAMPLES) list of fully-accepted exact swaps this batch decoded —
  // confidence === 'exact', factory-validated, two-sided. Never promoted into canonical events by
  // this module; a later stage (src/pipeline/index.ts, after real FIFO/pricing exist) may replay
  // AT MOST ONE of these through shadowFifoReplay.ts for measurement only.
  acceptedExactSwaps: DecodedReceiptSwap[]
  // Count of accepted exact swaps grouped by their originating candidate's priority tier (keys are
  // stringified tier numbers, or 'unknown' when the candidate carried no tier) — diagnostic only.
  acceptedExactSwapsByPriorityTier: Record<string, number>
  // Count of accepted exact swaps grouped by protocol/venue (e.g. 'uniswap_v3', 'aerodrome_classic',
  // 'aerodrome_slipstream') — diagnostic only.
  acceptedExactSwapsByVenue: Record<string, number>
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
    multiTransferPoolFlowsExamined: 0,
    multiTransferPoolFlowsResolved: 0,
    swapEventAmountMatches: 0,
    swapEventAmountMismatches: 0,
    routerIntermediaryTransfersIgnored: 0,
    refundsNetted: 0,
    uniswapV3PoolsExamined: 0,
    uniswapV3PoolsValidated: 0,
    uniswapV3ValidationCalls: 0,
    uniswapV3SwapsDecoded: 0,
    uniswapV3AmountMatches: 0,
    uniswapV3AmountMismatches: 0,
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

  // SEPARATE COUNTER, DISCLOSED: Uniswap V3 validation calls are tracked independently from Aerodrome's
  // `providerCalls`/`newProviderCalls` — see this task's "hard-cap Uniswap V3 validation calls
  // separately" requirement. Only ever invoked when `input.uniswapV3Validator` is supplied.
  let uniswapV3Calls = 0
  const countingUniswapV3Validator: UniswapV3PoolValidator | undefined = input.uniswapV3Validator && {
    async validatePool(poolAddress, token0, token1) {
      uniswapV3Calls += 1
      return input.uniswapV3Validator!.validatePool(poolAddress, token0, token1)
    },
  }

  // Base + Aerodrome only, regardless of what the caller passes — enforced here, not merely by
  // convention, so this module can never silently widen scope if a caller forgets to pre-filter.
  const baseCandidates = input.candidates.filter((c) => c.chain === 'base')

  const receiptForensics: ReceiptForensicSample[] = []
  const acceptedExactSwaps: DecodedReceiptSwap[] = []
  const acceptedExactSwapsByPriorityTier: Record<string, number> = {}
  const acceptedExactSwapsByVenue: Record<string, number> = {}

  for (const candidate of baseCandidates) {
    const logs = input.logsByTxHash?.get(candidate.txHash) ?? null
    if (!logs || logs.length === 0) {
      counters.receiptsMissing += 1
      continue
    }
    counters.receiptsAvailable += 1
    counters.receiptsExamined += 1

    // RECORDING WRAPPER, DISCLOSED (forensicClassifier.ts's own header): wraps the SAME
    // countingValidator this tx's decode was always going to use — never a second isValidPool
    // call, just an observer of the ones decodeReceiptSwap already makes below.
    const factoryValidationAttempts: FactoryValidationAttempt[] = []
    const recordingValidator = createRecordingPoolValidator(countingValidator, factoryValidationAttempts)

    const result = await decodeReceiptSwap(
      {
        chain: 'base',
        txHash: candidate.txHash,
        walletAddress: input.walletAddress,
        logs,
        tokenMeta: input.tokenMeta,
      },
      recordingValidator,
      countingUniswapV3Validator,
    )

    const uniswapV3Diagnostics = result.ok
      ? (result.swap.protocol === 'uniswap_v3' ? { examined: true, amountMatched: true as boolean | null } : undefined)
      : result.rejection.uniswapV3
    if (uniswapV3Diagnostics?.examined) {
      counters.uniswapV3PoolsExamined += 1
      if (uniswapV3Diagnostics.amountMatched === true) counters.uniswapV3AmountMatches += 1
      if (uniswapV3Diagnostics.amountMatched === false) counters.uniswapV3AmountMismatches += 1
    }

    // FORENSIC PRODUCTION LOG, DISCLOSED (this task): one separate flat log per examined Uniswap V3
    // validation attempt — reuses the SAME diagnostics object decodeReceiptSwap already produced
    // above (zero additional getPool()/provider calls), bounded to this loop's already-bounded
    // (<= 10) receipt cap. See uniswapV3ForensicLog.ts's own header.
    const uniswapV3ValidationDiagnostics = result.ok
      ? (result.swap.protocol === 'uniswap_v3' ? result.swap.meta.uniswapV3Validation : undefined)
      : result.rejection.uniswapV3Validation
    if (uniswapV3ValidationDiagnostics) {
      console.warn(UNISWAP_V3_FORENSIC_LOG_LABEL, buildUniswapV3ForensicLogRecord(candidate.txHash, uniswapV3ValidationDiagnostics))
    }

    // CONCENTRATED POOL EMITTER FINGERPRINTING, DISCLOSED (this task): only ever attempted for an
    // emitter whose Uniswap V3 factory validation genuinely failed (finalTypedReason !==
    // 'validated') -- "identify the non-Uniswap concentrated pool emitter", never a re-check of an
    // emitter that already validated. Bounded to this loop's already-bounded (<= 10) receipt cap;
    // never fetches a receipt itself.
    if (uniswapV3ValidationDiagnostics && uniswapV3ValidationDiagnostics.finalTypedReason !== 'validated' && input.emitterFingerprinter) {
      const fingerprint = await input.emitterFingerprinter.fingerprint(
        candidate.txHash, uniswapV3ValidationDiagnostics.eventEmitter,
        uniswapV3ValidationDiagnostics.token0, uniswapV3ValidationDiagnostics.token1,
      )
      console.warn(CONCENTRATED_POOL_EMITTER_FORENSIC_LOG_LABEL, buildConcentratedPoolEmitterForensicLogRecord(fingerprint))

      // UNKNOWN FACTORY VERIFICATION, DISCLOSED (this task): only ever attempted when the
      // fingerprint itself couldn't recognize the claimed factory ('unknown_concentrated_factory')
      // and every input this needs (claimed factory, both tokens, fee) is actually in hand — "verify
      // the unknown factory before registry inclusion", never a registry mutation by itself.
      if (
        fingerprint.finalTypedReason === 'unknown_concentrated_factory' && fingerprint.emitterFactory
        && fingerprint.emitterToken0 && fingerprint.emitterToken1 && fingerprint.emitterFee !== null
        && input.unknownFactoryVerifier
      ) {
        const verification = await input.unknownFactoryVerifier.verify(
          candidate.txHash, fingerprint.eventEmitter, fingerprint.emitterFactory,
          fingerprint.emitterToken0, fingerprint.emitterToken1, fingerprint.emitterFee,
        )
        console.warn(
          UNKNOWN_CONCENTRATED_FACTORY_VERIFICATION_LOG_LABEL,
          buildUnknownConcentratedFactoryVerificationLogRecord(verification),
        )
      }
    }
    if (result.ok && result.swap.protocol === 'uniswap_v3') {
      counters.uniswapV3SwapsDecoded += 1
      counters.uniswapV3PoolsValidated += 1
    }

    const multiTransfer = result.ok ? result.swap.meta.multiTransfer : result.rejection.multiTransfer
    if (multiTransfer?.examined) {
      counters.multiTransferPoolFlowsExamined += 1
      if (multiTransfer.resolved) counters.multiTransferPoolFlowsResolved += 1
      if (multiTransfer.swapEventAmountMatched === true) counters.swapEventAmountMatches += 1
      if (multiTransfer.swapEventAmountMatched === false) counters.swapEventAmountMismatches += 1
      counters.routerIntermediaryTransfersIgnored += multiTransfer.routerIntermediaryTransfersIgnored
      if (multiTransfer.refundNetted) counters.refundsNetted += 1
    }

    if (receiptForensics.length < MAX_FORENSIC_SAMPLES) {
      receiptForensics.push(classifyReceiptForensics({
        txHash: candidate.txHash,
        candidatePriorityTier: candidate.priorityTier ?? null,
        candidatePriorityReason: candidate.priorityReason ?? null,
        logs,
        decodeResult: result,
        factoryValidationAttempts,
      }))
    }

    if (result.ok && result.swap.confidence === 'exact' && acceptedExactSwaps.length < MAX_FORENSIC_SAMPLES) {
      acceptedExactSwaps.push(result.swap)
      const tierKey = String(candidate.priorityTier ?? 'unknown')
      acceptedExactSwapsByPriorityTier[tierKey] = (acceptedExactSwapsByPriorityTier[tierKey] ?? 0) + 1
      acceptedExactSwapsByVenue[result.swap.protocol] = (acceptedExactSwapsByVenue[result.swap.protocol] ?? 0) + 1
    }

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
  counters.uniswapV3ValidationCalls = uniswapV3Calls
  return {
    counters, rejectionReasons, decodedByVenue, decodedByConfidence, disagreementSamples,
    receiptForensics, acceptedExactSwaps, acceptedExactSwapsByPriorityTier, acceptedExactSwapsByVenue,
  }
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
      exactTwoSidedSwapsRecovered: number
      oneLegTransactionsUpgraded: number
      candidateLotsUnlocked: number
      // AERODROME CLASSIC MULTI-TRANSFER RESOLUTION, DISCLOSED — see multiTransferLeg.ts's own
      // header and WalletScanShadowCounters' matching fields above.
      multiTransferPoolFlowsExamined: number
      multiTransferPoolFlowsResolved: number
      swapEventAmountMatches: number
      swapEventAmountMismatches: number
      routerIntermediaryTransfersIgnored: number
      refundsNetted: number
      // BOUNDED ACQUISITION, DISCLOSED — see receiptAcquisition.ts's own header (cap 10, concurrency
      // 3, no retries, per-call timeout, request-scoped cache + singleflight by chain:txHash).
      receiptCandidatesTotal: number
      receiptCandidatesSelected: number
      receiptCandidatesCapped: number
      receiptCacheHits: number
      receiptSingleflightHits: number
      receiptLiveCalls: number
      receiptTimeouts: number
      receiptMissingResults: number
      receiptMalformed: number
      receiptReverted: number
      // Attributable, separately-counted provider-call totals: receiptProviderCalls is real
      // eth_getTransactionReceipt calls (<= 10); poolValidationProviderCalls is real factory
      // getPool() calls (only for successfully-decoded receipts); newProviderCalls is their sum.
      receiptProviderCalls: number
      poolValidationProviderCalls: number
      newProviderCalls: number
      rejectionReasons: Record<string, number>
      decodedByVenue: Record<string, number>
      decodedByConfidence: Record<string, number>
      disagreementSamples: ShadowDisagreementSample[]
      // Bounded (<= 10) forensic classification of every examined receipt — see
      // forensicClassifier.ts's own header. Shadow/debug-only.
      receiptForensics: ReceiptForensicSample[]
      // Bounded (<= MAX_FORENSIC_SAMPLES) fully-accepted exact swaps — see
      // WalletScanShadowDiagnostics' matching field above. Consumed by src/pipeline/index.ts's
      // shadow-FIFO-replay stage (at most the first one, per scan) after real FIFO/pricing exist.
      acceptedExactSwaps: DecodedReceiptSwap[]
      acceptedExactSwapsByPriorityTier: Record<string, number>
      acceptedExactSwapsByVenue: Record<string, number>
      // UNISWAP V3 (BASE), DISCLOSED — see uniswapV3Leg.ts / uniswapV3PoolValidator.ts.
      uniswapV3PoolsExamined: number
      uniswapV3PoolsValidated: number
      uniswapV3ValidationCalls: number
      uniswapV3SwapsDecoded: number
      uniswapV3AmountMatches: number
      uniswapV3AmountMismatches: number
      // TIER-DIVERSIFIED RECEIPT SELECTION, DISCLOSED — see receiptAcquisition.ts's
      // selectReceiptFetchCandidates for the full disclosure (5/5 quota reservation for tiers 3/4,
      // tier 1/2 always first, backfill from whichever tier has spare candidates).
      receiptSelectedByPriorityTier: Record<string, number>
      receiptCandidatesSkippedByTierQuota: Record<string, number>
      receiptQuotaBackfilled: number
      // SELECTOR BROADENING, DISCLOSED — see candidateSelector.ts's own header for the full
      // production-proof root cause this fixes (415 real swap-lookup transactions, 0 candidates
      // selected under the old routerDistributorMode-gated source).
      selectorTransactionsConsidered: number
      selectorEligibleCandidates: number
      selectorRejectedCandidates: number
      selectorReasonCounts: Record<string, number>
      candidatePriorityBreakdown: Record<string, number>
    }

export type BuildWalletScanShadowLogPayloadInput = {
  walletAddress: string
  // Real, already-computed per-transaction evidence (leg grouping, router inference, bridge
  // detection, verified-quote-address, closed-lot pairing) — see candidateSelector.ts's own header.
  evidence: readonly CandidateTxEvidence[]
  tokenMeta?: Record<string, TokenMeta>
  validator: PoolValidator
  // Optional — see WalletScanShadowModeInput's own field of the same name.
  uniswapV3Validator?: UniswapV3PoolValidator
  // Optional — see WalletScanShadowModeInput's own field of the same name.
  emitterFingerprinter?: ConcentratedPoolEmitterFingerprinter
  // Optional — see WalletScanShadowModeInput's own field of the same name.
  unknownFactoryVerifier?: UnknownConcentratedFactoryVerifier
  disabledByEnv: boolean
  // Receipt acquisition — defaults to the real, live, on-chain fetcher and a fresh request-scoped
  // cache. Tests inject a fake fetcher / a pre-seeded requestScope (exactly "reuse any receipt
  // already in request scope") instead of hitting the network.
  receiptFetcher?: ReceiptFetcher
  requestScope?: ReceiptRequestScopeCache
  maxLiveReceiptCalls?: number
  receiptConcurrency?: number
  receiptTimeoutMs?: number
}

// PURE with respect to control flow beyond the injected fetcher (acquireReceiptsForCandidates) and
// pool validator (runWalletScanReceiptShadowMode) — both already bounded/documented in their own
// files. Never throws by itself — a thrown error propagates to the caller, which
// src/pipeline/index.ts catches and logs under the 'wiring_not_reached' skip reason so the
// unconditional-log guarantee holds even in that case.
export async function buildWalletScanShadowLogPayload(input: BuildWalletScanShadowLogPayloadInput): Promise<WalletScanShadowLogPayload> {
  if (input.disabledByEnv) {
    return { enabled: false, skipReason: 'shadow_disabled', baseSwapCandidates: 0 }
  }
  if (input.evidence.length === 0) {
    return { enabled: false, skipReason: 'no_candidates', baseSwapCandidates: 0 }
  }

  const selection: CandidateSelectionResult = selectBaseReceiptCandidates(input.evidence)
  if (selection.baseSwapCandidates === 0) {
    // Distinguishes "there was no Base evidence at all" from "there was Base evidence but none of
    // it survived eligibility" — both are honestly "nothing to decode", but the former is the exact
    // production symptom the selector-broadening task fixed (evidence existed, selection was empty).
    const anyBaseEvidence = input.evidence.some((e) => e.chain === 'base')
    return { enabled: false, skipReason: anyBaseEvidence ? 'no_candidates' : 'unsupported_chain', baseSwapCandidates: 0 }
  }

  const acquisition = await acquireReceiptsForCandidates({
    // Highest-priority first — candidateSelector.ts already sorts `selected` this way.
    candidates: selection.selected,
    fetcher: input.receiptFetcher ?? createLiveBaseReceiptFetcher(),
    requestScope: input.requestScope ?? createReceiptRequestScopeCache(),
    maxLiveCalls: input.maxLiveReceiptCalls,
    concurrency: input.receiptConcurrency,
    timeoutMs: input.receiptTimeoutMs,
  })

  const candidates: WalletScanSwapCandidate[] = selection.selected.map((c) => ({
    chain: c.chain,
    txHash: c.txHash,
    inferredTokenIn: c.inferredTokenIn,
    inferredTokenOut: c.inferredTokenOut,
    inferredAmountIn: null,
    inferredAmountOut: null,
    inferredMissingSide: c.inferredMissingSide,
    priorityTier: c.priorityTier,
    priorityReason: c.priorityReason,
  }))

  const result = await runWalletScanReceiptShadowMode({
    walletAddress: input.walletAddress,
    candidates,
    logsByTxHash: acquisition.logsByTxHash,
    tokenMeta: input.tokenMeta,
    validator: input.validator,
    uniswapV3Validator: input.uniswapV3Validator,
    emitterFingerprinter: input.emitterFingerprinter,
    unknownFactoryVerifier: input.unknownFactoryVerifier,
  })

  const poolValidationProviderCalls = result.counters.newProviderCalls
  const receiptProviderCalls = acquisition.counters.receiptProviderCalls

  return {
    enabled: true,
    baseSwapCandidates: selection.baseSwapCandidates,
    receiptsAvailable: result.counters.receiptsAvailable,
    receiptsMissing: result.counters.receiptsMissing,
    receiptsExamined: result.counters.receiptsExamined,
    aerodromeSwapsDecoded: result.counters.aerodromeSwapsDecoded,
    exactTwoSidedSwapsRecovered: result.counters.exactTwoSidedSwapsRecovered,
    oneLegTransactionsUpgraded: result.counters.oneLegTransactionsUpgraded,
    candidateLotsUnlocked: result.counters.candidateLotsUnlocked,
    multiTransferPoolFlowsExamined: result.counters.multiTransferPoolFlowsExamined,
    multiTransferPoolFlowsResolved: result.counters.multiTransferPoolFlowsResolved,
    swapEventAmountMatches: result.counters.swapEventAmountMatches,
    swapEventAmountMismatches: result.counters.swapEventAmountMismatches,
    routerIntermediaryTransfersIgnored: result.counters.routerIntermediaryTransfersIgnored,
    refundsNetted: result.counters.refundsNetted,
    receiptCandidatesTotal: acquisition.counters.receiptCandidatesTotal,
    receiptCandidatesSelected: acquisition.counters.receiptCandidatesSelected,
    receiptCandidatesCapped: acquisition.counters.receiptCandidatesCapped,
    receiptCacheHits: acquisition.counters.receiptCacheHits,
    receiptSingleflightHits: acquisition.counters.receiptSingleflightHits,
    receiptLiveCalls: acquisition.counters.receiptLiveCalls,
    receiptTimeouts: acquisition.counters.receiptTimeouts,
    receiptMissingResults: acquisition.counters.receiptMissingResults,
    receiptMalformed: acquisition.counters.receiptMalformed,
    receiptReverted: acquisition.counters.receiptReverted,
    receiptProviderCalls,
    poolValidationProviderCalls,
    newProviderCalls: receiptProviderCalls + poolValidationProviderCalls,
    rejectionReasons: result.rejectionReasons,
    decodedByVenue: result.decodedByVenue,
    decodedByConfidence: result.decodedByConfidence,
    disagreementSamples: result.disagreementSamples,
    receiptForensics: result.receiptForensics,
    acceptedExactSwaps: result.acceptedExactSwaps,
    acceptedExactSwapsByPriorityTier: result.acceptedExactSwapsByPriorityTier,
    acceptedExactSwapsByVenue: result.acceptedExactSwapsByVenue,
    uniswapV3PoolsExamined: result.counters.uniswapV3PoolsExamined,
    uniswapV3PoolsValidated: result.counters.uniswapV3PoolsValidated,
    uniswapV3ValidationCalls: result.counters.uniswapV3ValidationCalls,
    uniswapV3SwapsDecoded: result.counters.uniswapV3SwapsDecoded,
    uniswapV3AmountMatches: result.counters.uniswapV3AmountMatches,
    uniswapV3AmountMismatches: result.counters.uniswapV3AmountMismatches,
    receiptSelectedByPriorityTier: acquisition.receiptSelectedByPriorityTier,
    receiptCandidatesSkippedByTierQuota: acquisition.receiptCandidatesSkippedByTierQuota,
    receiptQuotaBackfilled: acquisition.receiptQuotaBackfilled,
    selectorTransactionsConsidered: selection.selectorTransactionsConsidered,
    selectorEligibleCandidates: selection.selectorEligibleCandidates,
    selectorRejectedCandidates: selection.selectorRejectedCandidates,
    selectorReasonCounts: selection.selectorReasonCounts,
    candidatePriorityBreakdown: selection.candidatePriorityBreakdown,
  }
}
