// MODULE — receiptSwapDecoder: shadow-mode aggregation.
//
// SHADOW MODE, DISCLOSED: this compares receipt-decoded swaps against whatever the EXISTING
// transfer/router inference already concluded for the same transaction, WITHOUT changing which
// value is used anywhere downstream — it is pure observation. Nothing here promotes a decoded swap
// into FIFO, pricing, or public output (explicit requirement for this pass). A later, separate pass
// can wire the confirmed-safe decode path into the real pipeline once this counters output has been
// reviewed.
//
// Counter definitions (exact names required by this task):
//   receiptsExamined              — every tx bundle passed in, regardless of outcome.
//   aerodromeSwapsDecoded         — receipt decode succeeded (`ok: true`), any hop count.
//   exactTwoSidedSwapsRecovered   — decoded swaps with confidence 'exact' AND both tokenIn/tokenOut
//                                   resolved (never UNKNOWN) — a full two-sided recovery.
//   oneLegTransactionsUpgraded    — tx where the existing inference had a missing side
//                                   (`inferredMissingSide !== 'none'`) but receipt decoding
//                                   recovered a full two-sided swap.
//   inferenceDisagreements        — tx where BOTH receipt decode and inference produced a result,
//                                   but their tokenIn/tokenOut/direction disagree.
//   rejectedNonSwapTransactions   — tx receipt-decoded as LP_ADD/LP_REMOVE or a plain transfer
//                                   (`lp_add_or_remove_detected` / `plain_transfer_no_swap_event`).
//   newProviderCalls              — count of pool-validation calls this batch triggered (the one
//                                   provider call this module can add — see index.ts's header).
//   candidateLotsUnlocked         — count of previously one-legged (missing-side) transactions that
//                                   are now decoded with a complete tokenIn+tokenOut pair, i.e. real
//                                   candidate lots that FIFO could use IF this were wired live
//                                   (never actually applied to FIFO in this pass).

import type { PoolValidator } from './poolValidator'
import { decodeReceiptSwap } from './index'
import type { ReceiptDecodeResult, ReceiptTxBundle } from './types'

export type ExistingInferenceForTx = {
  txHash: string
  tokenIn: string | null
  tokenOut: string | null
  missingSide: 'none' | 'tokenIn' | 'tokenOut'
}

export type ShadowModeCounters = {
  receiptsExamined: number
  aerodromeSwapsDecoded: number
  exactTwoSidedSwapsRecovered: number
  oneLegTransactionsUpgraded: number
  inferenceDisagreements: number
  rejectedNonSwapTransactions: number
  newProviderCalls: number
  candidateLotsUnlocked: number
}

export type ShadowModeResult = {
  counters: ShadowModeCounters
  decodes: Array<{ txHash: string; result: ReceiptDecodeResult }>
}

function countingValidator(inner: PoolValidator): { validator: PoolValidator; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    validator: {
      async isValidPool(protocol, pool, t0, t1) {
        calls += 1
        return inner.isValidPool(protocol, pool, t0, t1)
      },
    },
  }
}

export async function runShadowMode(
  txs: ReceiptTxBundle[],
  validator: PoolValidator,
  existingInference: Map<string, ExistingInferenceForTx>,
): Promise<ShadowModeResult> {
  const counted = countingValidator(validator)
  const decodes: Array<{ txHash: string; result: ReceiptDecodeResult }> = []

  const counters: ShadowModeCounters = {
    receiptsExamined: 0,
    aerodromeSwapsDecoded: 0,
    exactTwoSidedSwapsRecovered: 0,
    oneLegTransactionsUpgraded: 0,
    inferenceDisagreements: 0,
    rejectedNonSwapTransactions: 0,
    newProviderCalls: 0,
    candidateLotsUnlocked: 0,
  }

  for (const tx of txs) {
    counters.receiptsExamined += 1
    const result = await decodeReceiptSwap(tx, counted.validator)
    decodes.push({ txHash: tx.txHash, result })

    if (!result.ok) {
      if (result.rejection.reason === 'lp_add_or_remove_detected' || result.rejection.reason === 'plain_transfer_no_swap_event') {
        counters.rejectedNonSwapTransactions += 1
      }
      continue
    }

    counters.aerodromeSwapsDecoded += 1
    const twoSided = result.swap.confidence === 'exact' && result.swap.tokenIn.address !== '' && result.swap.tokenOut.address !== ''
    if (twoSided) counters.exactTwoSidedSwapsRecovered += 1

    const inference = existingInference.get(tx.txHash)
    if (inference) {
      if (inference.missingSide !== 'none' && twoSided) {
        counters.oneLegTransactionsUpgraded += 1
        counters.candidateLotsUnlocked += 1
      }
      if (
        inference.missingSide === 'none'
        && inference.tokenIn
        && inference.tokenOut
        && (inference.tokenIn.toLowerCase() !== result.swap.tokenIn.address || inference.tokenOut.toLowerCase() !== result.swap.tokenOut.address)
      ) {
        counters.inferenceDisagreements += 1
      }
    }
  }

  counters.newProviderCalls = counted.calls()
  return { counters, decodes }
}
