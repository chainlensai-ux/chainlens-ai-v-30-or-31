// MODULE — receiptSwapDecoder: Phase 2 completion-first conditional receipt budget.
//
// GOAL, DISCLOSED (this task's explicit Budget section): keep the normal 10-receipt budget, but allow
// a CONDITIONAL completion budget of up to 40 ADDITIONAL receipts (50 total) while high-yield
// candidates remain — stopping the moment marginal completion yield falls below a fixed, deterministic
// threshold. Concurrency stays capped at 3 per round, no retries anywhere, and every receipt fetched
// (normal or conditional) goes through the SAME acquireReceiptsForCandidates path this codebase
// already tested — this module only decides HOW MANY additional rounds to run, never how a single
// receipt is fetched or decoded.
//
// HOW EXPANSION REUSES THE EXISTING CACHE, DISCLOSED: acquireReceiptsForCandidates already accepts a
// shared `requestScope` cache and a `maxLiveCalls` ceiling. Calling it again with a LARGER ceiling and
// the SAME requestScope is a real, cheap way to fetch "the next batch": every candidate already
// fetched in an earlier round is served from `cache` (a cache hit, zero live calls) — see
// receiptAcquisition.ts's own header — and only the NEWLY-in-range candidates cost a real call this
// round. Because candidateSelector.ts's tier/quota selection is monotonic in `maxLiveCalls` (a larger
// cap only ever ADDS candidates, never reorders or drops an already-selected one — verified by its own
// deterministic quota-backfill logic), each round's own `receiptLiveCalls`/
// `receiptsWithSwapEventDetectedFreshFetch` counters are exactly that round's OWN marginal
// contribution — the real basis for the marginal-yield stop rule below.
//
// MARGINAL YIELD, DISCLOSED: `swapEventDetectedThisRound / liveCallsThisRound` — the fraction of this
// round's FRESH receipt fetches that decodeLogs found at least one recognized pool-swap-shaped event
// in (a cheap, already-computed, zero-extra-cost presence check — never a full protocol decode, never
// an amount inference). This is a real, pre-decode proxy for "was this batch worth fetching", not the
// FINAL exact-swap/promotion count (which the caller's own decode/promotion stage still computes
// afterward, unchanged, over every accumulated receipt). Expansion stops the FIRST round whose yield
// falls below MARGINAL_YIELD_STOP_THRESHOLD, or when the conditional budget or the high-yield
// candidate pool is exhausted — whichever comes first. Never retried, never re-attempted with a lower
// threshold.

import {
  acquireReceiptsForCandidates,
  type AcquireReceiptsInput,
  type AcquireReceiptsResult,
} from './receiptAcquisition'

// Fixed, deterministic — not tuned per-scan, not derived from this scan's own results. Chosen so a
// batch where fewer than 1-in-4 fresh receipts even CONTAIN a recognized swap event stops further
// spend; a batch at or above this rate is still worth its cost even before full decode/validation.
export const MARGINAL_YIELD_STOP_THRESHOLD = 0.25

export const NORMAL_RECEIPT_BUDGET = 10
export const MAX_CONDITIONAL_RECEIPT_BUDGET = 40
export const COMPLETION_BATCH_SIZE = 3 // matches the existing, unchanged concurrency cap

export type CompletionBudgetBatch = {
  batchIndex: number
  // Cumulative ceiling used for this round's acquireReceiptsForCandidates call.
  cumulativeCeiling: number
  liveCallsThisRound: number
  swapEventDetectedThisRound: number
  marginalYield: number
  stoppedAfterThisBatch: boolean
  stopReason: 'below_threshold' | 'no_live_calls_remaining' | 'conditional_budget_exhausted' | null
}

export type AcquireReceiptsWithCompletionBudgetResult = {
  // The LAST round's full result — cumulative across every round via the shared requestScope cache,
  // so `logsByTxHash` already contains every receipt fetched across normal + conditional rounds.
  final: AcquireReceiptsResult
  normalBudgetUsed: number
  conditionalBudgetUsed: number
  receiptsFetched: number
  providerCalls: number
  marginalYieldByBatch: CompletionBudgetBatch[]
}

// PURE with respect to control flow beyond the injected fetcher (same contract as
// acquireReceiptsForCandidates itself). Never throws by itself.
export async function acquireReceiptsWithCompletionBudget(
  input: Omit<AcquireReceiptsInput, 'maxLiveCalls'> & {
    normalBudget?: number
    maxConditionalBudget?: number
    batchSize?: number
    marginalYieldStopThreshold?: number
  },
): Promise<AcquireReceiptsWithCompletionBudgetResult> {
  const normalBudget = input.normalBudget ?? NORMAL_RECEIPT_BUDGET
  const maxConditionalBudget = input.maxConditionalBudget ?? MAX_CONDITIONAL_RECEIPT_BUDGET
  const batchSize = input.batchSize ?? COMPLETION_BATCH_SIZE
  const threshold = input.marginalYieldStopThreshold ?? MARGINAL_YIELD_STOP_THRESHOLD

  const batches: CompletionBudgetBatch[] = []

  // ROUND 0 — the normal, unconditional budget. Always spent (up to however many real candidates
  // exist), matching this task's explicit "keep normal budget 10" requirement.
  let result = await acquireReceiptsForCandidates({ ...input, maxLiveCalls: normalBudget, concurrency: input.concurrency ?? batchSize })
  let cumulativeCeiling = normalBudget
  let totalLiveCalls = result.counters.receiptLiveCalls
  const normalBudgetUsed = result.counters.receiptLiveCalls

  batches.push({
    batchIndex: 0,
    cumulativeCeiling,
    liveCallsThisRound: result.counters.receiptLiveCalls,
    swapEventDetectedThisRound: result.counters.receiptsWithSwapEventDetectedFreshFetch,
    marginalYield: result.counters.receiptLiveCalls > 0
      ? result.counters.receiptsWithSwapEventDetectedFreshFetch / result.counters.receiptLiveCalls
      : 0,
    stoppedAfterThisBatch: false,
    stopReason: null,
  })

  let conditionalBudgetUsed = 0
  let batchIndex = 1

  // CONDITIONAL EXPANSION LOOP, DISCLOSED: each iteration raises the ceiling by exactly `batchSize`
  // (never more — concurrency stays capped at 3 per round) and stops the moment this round's marginal
  // yield falls below `threshold`, the conditional budget is exhausted, or no further candidates exist
  // to fetch (receiptLiveCalls this round is 0 — the candidate pool itself is exhausted, not a
  // yield failure, reported under its own distinct stop reason).
  while (conditionalBudgetUsed < maxConditionalBudget) {
    const remainingConditional = maxConditionalBudget - conditionalBudgetUsed
    const roundCeiling = Math.min(batchSize, remainingConditional)
    cumulativeCeiling += roundCeiling

    // eslint-disable-next-line no-await-in-loop
    const roundResult = await acquireReceiptsForCandidates({ ...input, maxLiveCalls: cumulativeCeiling, concurrency: input.concurrency ?? batchSize })
    const liveCallsThisRound = roundResult.counters.receiptLiveCalls
    const swapEventDetectedThisRound = roundResult.counters.receiptsWithSwapEventDetectedFreshFetch
    const marginalYield = liveCallsThisRound > 0 ? swapEventDetectedThisRound / liveCallsThisRound : 0

    result = roundResult
    totalLiveCalls += liveCallsThisRound
    conditionalBudgetUsed += liveCallsThisRound

    let stopReason: CompletionBudgetBatch['stopReason'] = null
    let stop = false

    if (liveCallsThisRound === 0) {
      // The candidate pool itself is exhausted (every remaining candidate was already fetched, or
      // there simply aren't enough real candidates to reach this ceiling) — never a yield failure.
      stopReason = 'no_live_calls_remaining'
      stop = true
    } else if (marginalYield < threshold) {
      stopReason = 'below_threshold'
      stop = true
    } else if (conditionalBudgetUsed >= maxConditionalBudget) {
      stopReason = 'conditional_budget_exhausted'
      stop = true
    }

    batches.push({
      batchIndex,
      cumulativeCeiling,
      liveCallsThisRound,
      swapEventDetectedThisRound,
      marginalYield,
      stoppedAfterThisBatch: stop,
      stopReason,
    })

    batchIndex += 1
    if (stop) break
  }

  return {
    final: result,
    normalBudgetUsed,
    conditionalBudgetUsed,
    receiptsFetched: totalLiveCalls,
    providerCalls: totalLiveCalls,
    marginalYieldByBatch: batches,
  }
}
