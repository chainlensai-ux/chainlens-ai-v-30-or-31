// MODULE — receiptSwapDecoder: Phase 2 completion-first conditional receipt budget.
//
// GOAL, DISCLOSED (this task's explicit Budget section): keep the normal 10-receipt budget, but allow
// a CONDITIONAL completion budget of up to 40 ADDITIONAL receipts (50 total) while high-yield
// candidates remain — stopping the moment marginal completion yield falls below a fixed, deterministic
// threshold. Concurrency stays capped at 3 per round, no retries anywhere.
//
// ─── BUDGET-ALLOCATION FIX (this revision) ─────────────────────────────────────────────────────────
//
// Production proof: tier1CandidatesAfter was 0 (candidateSelector.ts's own two-independent-signal
// gate — see that module's header — correctly found no genuine tier-1 candidate this scan), yet the
// decoder still spent normalBudget=10 PLUS conditionalBudget=3. Root cause: the prior version of this
// module handed the FULL, all-tiers candidate list to every conditional round with a growing
// `maxLiveCalls` ceiling. Once the normal budget's own tier-1/tier-2 "unlimited first" allocation ran
// out of tier-1 candidates, the SAME tier-quota logic that (correctly) lets the NORMAL budget backfill
// unused capacity from tiers 3/4/5 ALSO applied to conditional rounds — so a conditional round with
// zero real tier-1 candidates left still happily fetched 3 more tier-3/4 receipts, spending budget the
// completion-first premise (a receipt worth chasing because it can complete a specific FIFO lot) never
// justified for tier-3/4 candidates at all.
//
// FIX: the conditional budget now ALWAYS selects from a candidates array containing ONLY tier-1
// candidates (`tier1Only` below) — tiers 2/3/4/5 are structurally unreachable in any conditional round,
// never merely deprioritized. The normal (10-receipt) budget is completely unchanged: it still uses the
// full, all-tiers list and its own existing tier-quota backfill exactly as before ("keep the existing
// normal receipt budget of 10 unchanged"). When tier1Only is empty, or the normal budget already
// covered every tier-1 candidate that exists, the very first conditional round observes zero live
// calls and the loop stops immediately — conditionalBudgetUsed is provably 0, not "usually 0".
//
// HOW EXPANSION REUSES THE EXISTING CACHE, DISCLOSED: unchanged in spirit — each conditional round
// calls acquireReceiptsForCandidates again with a LARGER ceiling and the SAME requestScope, so an
// already-fetched tier-1 candidate (including one the NORMAL budget already covered) is a cache hit,
// never a live call. The conditional ceiling therefore starts from however many tier-1 candidates the
// normal round already selected for fetch (`round0.receiptSelectedByPriorityTier[1]`), not from zero —
// otherwise a conditional round would just re-request the same already-covered tier-1 candidates and
// see zero live calls regardless of how many genuinely new tier-1 candidates remain beyond it.
//
// MARGINAL YIELD, DISCLOSED: `swapEventDetectedThisRound / liveCallsThisRound` — the fraction of this
// round's FRESH receipt fetches that decodeLogs found at least one recognized pool-swap-shaped event
// in. Expansion stops the FIRST round whose yield falls below MARGINAL_YIELD_STOP_THRESHOLD, or when
// the conditional budget or the tier-1 candidate pool is exhausted — whichever comes first.

import {
  acquireReceiptsForCandidates,
  type AcquireReceiptsInput,
  type AcquireReceiptsResult,
  type ReceiptAcquisitionCounters,
} from './receiptAcquisition'
import type { RawReceiptLog } from './types'

// Fixed, deterministic — not tuned per-scan, not derived from this scan's own results.
export const MARGINAL_YIELD_STOP_THRESHOLD = 0.25

export const NORMAL_RECEIPT_BUDGET = 10
export const MAX_CONDITIONAL_RECEIPT_BUDGET = 40
export const COMPLETION_BATCH_SIZE = 3 // matches the existing, unchanged concurrency cap

export type CompletionBudgetBatch = {
  batchIndex: number
  // Cumulative ceiling used for this round's acquireReceiptsForCandidates call. For batchIndex 0 this
  // is against the full candidate list; for every later batch it is against the tier-1-only pool.
  cumulativeCeiling: number
  liveCallsThisRound: number
  swapEventDetectedThisRound: number
  marginalYield: number
  stoppedAfterThisBatch: boolean
  stopReason: 'below_threshold' | 'no_live_calls_remaining' | 'conditional_budget_exhausted' | null
}

export type AcquireReceiptsWithCompletionBudgetResult = {
  // MERGED across every round (normal + every conditional round) — logsByTxHash and
  // freshlyFetchedTxHashes are real unions; the remaining counters are real sums. See mergeRounds
  // below for the exact reasoning per field.
  final: AcquireReceiptsResult
  normalBudgetUsed: number
  conditionalBudgetUsed: number
  receiptsFetched: number
  providerCalls: number
  marginalYieldByBatch: CompletionBudgetBatch[]
}

function sumCounters(rounds: readonly AcquireReceiptsResult[]): ReceiptAcquisitionCounters {
  const base = rounds[0].counters
  return {
    // Candidate-pool-size fields describe the FULL picture and only ever come from round 0 (the
    // normal budget's own call against the complete, all-tiers list) — summing them across
    // conditional rounds (which re-examine an overlapping tier-1 subset each time) would double-count.
    receiptCandidatesTotal: base.receiptCandidatesTotal,
    receiptCandidatesSelected: rounds[rounds.length - 1].counters.receiptCandidatesSelected,
    receiptCandidatesCapped: base.receiptCandidatesCapped,
    // Per-attempt outcome counters ARE real sums — every round's own live calls are genuinely
    // distinct attempts (the shared requestScope guarantees no txHash is ever attempted twice).
    receiptCacheHits: rounds.reduce((sum, r) => sum + r.counters.receiptCacheHits, 0),
    receiptSingleflightHits: rounds.reduce((sum, r) => sum + r.counters.receiptSingleflightHits, 0),
    receiptLiveCalls: rounds.reduce((sum, r) => sum + r.counters.receiptLiveCalls, 0),
    receiptTimeouts: rounds.reduce((sum, r) => sum + r.counters.receiptTimeouts, 0),
    receiptMissingResults: rounds.reduce((sum, r) => sum + r.counters.receiptMissingResults, 0),
    receiptMalformed: rounds.reduce((sum, r) => sum + r.counters.receiptMalformed, 0),
    receiptReverted: rounds.reduce((sum, r) => sum + r.counters.receiptReverted, 0),
    receiptProviderCalls: rounds.reduce((sum, r) => sum + r.counters.receiptProviderCalls, 0),
    receiptQuotaSubstitutions: rounds.reduce((sum, r) => sum + r.counters.receiptQuotaSubstitutions, 0),
    receiptNegativeFingerprintsRecorded: base.receiptNegativeFingerprintsRecorded,
    receiptSubstitutionAttempts: rounds.reduce((sum, r) => sum + r.counters.receiptSubstitutionAttempts, 0),
    receiptsWithSwapEventDetectedFreshFetch: rounds.reduce((sum, r) => sum + r.counters.receiptsWithSwapEventDetectedFreshFetch, 0),
  }
}

// MERGE, DISCLOSED: round 0 (the normal budget, full candidate list) is the authoritative source for
// every "what does the overall candidate pool look like" field — tier-diversification quotas,
// backfill counts, candidate totals — since conditional rounds deliberately never see tiers 2-5 at
// all. logsByTxHash and freshlyFetchedTxHashes are real unions across every round, so a downstream
// decode/fresh-vs-cached split sees every receipt actually fetched, regardless of which round fetched
// it. Tier-1's own selected-count is the LAST round's own cumulative value (each conditional round's
// ceiling only ever grows, so its own count already reflects everything fetched for tier 1 so far).
function mergeRounds(rounds: readonly AcquireReceiptsResult[]): AcquireReceiptsResult {
  const logsByTxHash = new Map<string, RawReceiptLog[]>()
  const freshlyFetchedTxHashes = new Set<string>()
  for (const round of rounds) {
    for (const [txHash, logs] of round.logsByTxHash) logsByTxHash.set(txHash, logs)
    for (const txHash of round.freshlyFetchedTxHashes) freshlyFetchedTxHashes.add(txHash)
  }

  const base = rounds[0]
  const last = rounds[rounds.length - 1]

  return {
    logsByTxHash,
    counters: sumCounters(rounds),
    receiptSelectedByPriorityTier: { ...base.receiptSelectedByPriorityTier, 1: last.receiptSelectedByPriorityTier[1] },
    receiptCandidatesSkippedByTierQuota: base.receiptCandidatesSkippedByTierQuota,
    receiptQuotaBackfilled: base.receiptQuotaBackfilled,
    negativeFingerprintSamples: base.negativeFingerprintSamples,
    freshlyFetchedTxHashes,
  }
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
  const concurrency = input.concurrency ?? batchSize

  const batches: CompletionBudgetBatch[] = []

  // ROUND 0 — the normal, unconditional budget. Always spent (up to however many real candidates
  // exist), against the FULL, all-tiers candidate list — completely unchanged from before this fix.
  const round0 = await acquireReceiptsForCandidates({ ...input, maxLiveCalls: normalBudget, concurrency })
  const normalBudgetUsed = round0.counters.receiptLiveCalls

  batches.push({
    batchIndex: 0,
    cumulativeCeiling: normalBudget,
    liveCallsThisRound: round0.counters.receiptLiveCalls,
    swapEventDetectedThisRound: round0.counters.receiptsWithSwapEventDetectedFreshFetch,
    marginalYield: round0.counters.receiptLiveCalls > 0
      ? round0.counters.receiptsWithSwapEventDetectedFreshFetch / round0.counters.receiptLiveCalls
      : 0,
    stoppedAfterThisBatch: false,
    stopReason: null,
  })

  // TIER-1-ONLY CONDITIONAL POOL, DISCLOSED — see this module's own header. Every conditional round
  // below is called with THIS array, never the full candidate list — tiers 2/3/4/5 are structurally
  // unreachable here, not merely deprioritized.
  const tier1Only = input.candidates.filter((c) => c.priorityTier === 1)

  const rounds: AcquireReceiptsResult[] = [round0]
  let conditionalBudgetUsed = 0
  let batchIndex = 1
  // Tier-1 candidates the normal round already covered — the conditional ceiling starts HERE (never
  // from zero), or a conditional round would just re-request the same already-fetched candidates.
  let ceiling = round0.receiptSelectedByPriorityTier[1]

  while (conditionalBudgetUsed < maxConditionalBudget) {
    const remainingConditional = maxConditionalBudget - conditionalBudgetUsed
    ceiling += Math.min(batchSize, remainingConditional)

    // eslint-disable-next-line no-await-in-loop
    const roundResult = await acquireReceiptsForCandidates({ ...input, candidates: tier1Only, maxLiveCalls: ceiling, concurrency })
    rounds.push(roundResult)

    const liveCallsThisRound = roundResult.counters.receiptLiveCalls
    const swapEventDetectedThisRound = roundResult.counters.receiptsWithSwapEventDetectedFreshFetch
    const marginalYield = liveCallsThisRound > 0 ? swapEventDetectedThisRound / liveCallsThisRound : 0
    conditionalBudgetUsed += liveCallsThisRound

    let stopReason: CompletionBudgetBatch['stopReason'] = null
    let stop = false

    if (liveCallsThisRound === 0) {
      // Either tier1Only is empty (tier1CandidatesAfter === 0 — this fix's central case) or every
      // tier-1 candidate that exists was already covered by the normal budget or an earlier
      // conditional round. Never a yield failure.
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
      cumulativeCeiling: ceiling,
      liveCallsThisRound,
      swapEventDetectedThisRound,
      marginalYield,
      stoppedAfterThisBatch: stop,
      stopReason,
    })

    batchIndex += 1
    if (stop) break
  }

  const merged = mergeRounds(rounds)

  return {
    final: merged,
    normalBudgetUsed,
    conditionalBudgetUsed,
    receiptsFetched: normalBudgetUsed + conditionalBudgetUsed,
    providerCalls: normalBudgetUsed + conditionalBudgetUsed,
    marginalYieldByBatch: batches,
  }
}
