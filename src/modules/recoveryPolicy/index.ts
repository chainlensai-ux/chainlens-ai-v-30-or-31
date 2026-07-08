// MODULE 5 — recoveryPolicy
//
// The sole component permitted to fetch historical pages, and the sole component permitted to
// spend cost beyond the fixed base scan (Architecture Step 4 §5, Step 8 §3). Used strictly to
// unlock financial precision for high-value or behavior-critical tokens — never to extend
// behavioral coverage (behaviorIntel has no dependency on this module's output at all).
//
// Hard rules enforced by construction, not by convention:
//   - reads ONLY buyTimeline + sellTimeline (no import of distributionTimeline's type at all)
//   - never reads behaviorIntel or fifoEngine (no import of either module)
//   - never modifies timelines or normalized events (read-only access, no mutation anywhere below)
//   - never exceeds caps (enforced in the fetch loop itself, not just checked after the fact)
//   - runs strictly before fifoEngine in the pipeline (this module has no output edge that depends
//     on fifoEngine, and fifoEngine consumes this module's output, never the reverse)

import type { BuyTimeline, SellTimeline } from '../timelineBuilder/types'
import type { SupportedChain } from '../providerFetchWindow/types'
import type {
  HoldingInput,
  RecoveryEvaluationEntry,
  RecoveryPolicyCaps,
  RecoveryPolicyResult,
  RecoveryPolicyTriggerConfig,
  RecoveryTriggeredBy,
} from './types'
import { DEFAULT_RECOVERY_CAPS, DEFAULT_TRIGGER_RECOVERY_WHEN } from './types'
import {
  cumulativeBuyValueUsd,
  distinctTokensFromTimelines,
  evidenceRefsFor,
  fetchAlchemyTokenHistory,
  fetchGoldrushHistoricalPage,
  sellOccurrenceCount,
  top3HoldingTokens,
} from './utils'

export type {
  HoldingInput,
  RecoveryEvaluationEntry,
  RecoveryPolicyCaps,
  RecoveryPolicyResult,
  RecoveryPolicyTriggerConfig,
  RecoveryTriggerEvidenceRef,
  RecoveryTriggeredBy,
  RecoveryTriggerRule,
} from './types'
export { DEFAULT_RECOVERY_CAPS, DEFAULT_TRIGGER_RECOVERY_WHEN } from './types'

export type CandidateEvaluation = {
  token: string
  chain: SupportedChain
  triggeredBy: RecoveryTriggeredBy[]
  recoveryTriggered: boolean
}

// PURE. Evaluates the three OR-combined trigger rules for every distinct (chain, token) pair
// found across buyTimeline + sellTimeline. Never reads distributionTimeline — it is never passed
// in, so it structurally cannot influence this evaluation (Architecture Step 3 §2).
export function evaluateRecoveryTriggers(
  buyTimeline: BuyTimeline,
  sellTimeline: SellTimeline,
  holdings: HoldingInput[],
  triggerConfig: RecoveryPolicyTriggerConfig = DEFAULT_TRIGGER_RECOVERY_WHEN,
): CandidateEvaluation[] {
  const tokens = distinctTokensFromTimelines(buyTimeline.entries, sellTimeline.entries)
  const top3 = top3HoldingTokens(holdings)

  return tokens.map(({ token, chain }) => {
    const triggeredBy: RecoveryTriggeredBy[] = []

    const cumulativeUsd = cumulativeBuyValueUsd(buyTimeline.entries, token, chain)
    if (cumulativeUsd >= triggerConfig.token_value_usd_gte) {
      const matchingBuys = buyTimeline.entries.filter((e) => e.chain === chain && e.token.toLowerCase() === token)
      triggeredBy.push({
        rule: 'token_value_usd_gte',
        evidenceSource: 'buyTimeline',
        evidenceEntryRefs: evidenceRefsFor(matchingBuys),
        detail: `cumulative buy value $${cumulativeUsd.toFixed(2)} >= threshold $${triggerConfig.token_value_usd_gte}`,
      })
    }

    if (triggerConfig.in_top_3_holdings && top3.has(`${chain}:${token}`)) {
      triggeredBy.push({
        rule: 'in_top_3_holdings',
        evidenceSource: 'buyTimeline',
        evidenceEntryRefs: [],
        detail: 'token is in the top 3 holdings by current USD value',
      })
    }

    const sellCount = sellOccurrenceCount(sellTimeline.entries, token, chain)
    if (sellCount >= triggerConfig.repeated_in_sell_timeline_min_count) {
      const matchingSells = sellTimeline.entries.filter((e) => e.chain === chain && e.token.toLowerCase() === token)
      triggeredBy.push({
        rule: 'repeated_in_sell_timeline_min_count',
        evidenceSource: 'sellTimeline',
        evidenceEntryRefs: evidenceRefsFor(matchingSells),
        detail: `appears ${sellCount} times in sellTimeline >= threshold ${triggerConfig.repeated_in_sell_timeline_min_count}`,
      })
    }

    return { token, chain, triggeredBy, recoveryTriggered: triggeredBy.length > 0 }
  })
}

// The ONLY historical-fetch entry point in this module. Fetches at most `pageCount` pages total
// (GoldRush + Alchemy combined), never more — caller (buildRecoveryPolicyObject) is responsible
// for passing a pageCount that already respects both caps.
//
// PARALLELIZED, DISCLOSED (scan-latency task): page 1 (GoldRush) and page 2 (Alchemy) target
// different providers/endpoints and have no data dependency on each other — the decision to fetch
// page 2 at all depends only on `pageCount` (known up front), never on what page 1's response
// contains. The old version awaited them back-to-back regardless, doubling this function's real
// wall-clock latency for no correctness reason. Same two calls, same pagesUsed accounting, same
// events collected — just fired concurrently instead of sequentially.
export async function fetchHistoricalPages(
  chain: SupportedChain,
  token: string,
  walletAddress: string,
  pageCount: number,
) {
  const cappedPageCount = Math.max(0, pageCount)
  if (cappedPageCount === 0) return { events: [] as Awaited<ReturnType<typeof fetchGoldrushHistoricalPage>>, pagesUsed: 0 }

  const wantsPage2 = cappedPageCount >= 2

  const [goldrushEvents, alchemyEvents] = await Promise.all([
    // Page 1: one targeted GoldRush historical page (page-number 1, beyond the base window's page 0).
    fetchGoldrushHistoricalPage(chain, walletAddress, 1),
    // Page 2 (only if the cap allows it): one targeted Alchemy pull scoped to this token contract.
    wantsPage2 ? fetchAlchemyTokenHistory(chain, walletAddress, token) : Promise.resolve([] as Awaited<ReturnType<typeof fetchAlchemyTokenHistory>>),
  ])

  const events: Awaited<ReturnType<typeof fetchGoldrushHistoricalPage>> = []
  events.push(...goldrushEvents.filter((e) => (e.contract ?? '').toLowerCase() === token.toLowerCase()))
  if (wantsPage2) events.push(...alchemyEvents)

  return { events, pagesUsed: wantsPage2 ? 2 : 1 }
}

// TEST-SUPPORT EXPORT, DISCLOSED: extracted as its own pure function (no network calls) so its
// budget-allocation arithmetic can be unit-tested directly, without mocking fetchHistoricalPages'
// real GoldRush/Alchemy network calls. Also used directly by buildRecoveryPolicyObject below — not
// a test-only duplicate.
//
// PARALLELIZED, DISCLOSED (scan-latency task): fetchHistoricalPages' real pagesUsed is fully
// deterministic from the pageBudget it's given (1 page if budget is 1, 2 pages if budget is >=2, 0
// if budget is 0 — see that function's own header) — it never depends on what the real API
// responses contain. That means every triggered candidate's page budget (and therefore its exact
// pagesUsed) can be computed synchronously, up front, in one pass — before firing any network call
// — instead of only being knowable after awaiting the previous candidate's fetch. This precompute
// is the EXACT same running-total/capping arithmetic the old sequential version used (same caps,
// same order-dependent allocation, byte-identical totalPagesUsedThisWallet), just computed ahead of
// time so every candidate's real fetch can then run concurrently instead of one after another.
export function planRecoveryFetches(
  candidates: CandidateEvaluation[],
  caps: RecoveryPolicyCaps,
): Array<{ candidate: CandidateEvaluation; pageBudget: number }> {
  let remainingWalletBudget = caps.maxHistoricalPagesPerWallet
  return candidates.map((candidate) => {
    if (!candidate.recoveryTriggered || remainingWalletBudget <= 0) {
      return { candidate, pageBudget: 0 }
    }
    const pageBudget = Math.min(caps.maxHistoricalPagesPerToken, remainingWalletBudget)
    // fetchHistoricalPages never actually consumes more than 2 pages regardless of pageBudget (see
    // its own header) — mirror that exact cap here so the NEXT candidate's remainingWalletBudget
    // matches what the old sequential code would have computed from the real pagesUsed it awaited.
    const actualPagesForThisCandidate = Math.min(Math.max(0, pageBudget), 2)
    remainingWalletBudget -= actualPagesForThisCandidate
    return { candidate, pageBudget }
  })
}

// Orchestrates evaluation + capped, triggered historical fetches into the final recoveryPolicy
// object. This is the only function in the module that awaits network calls; everything above it
// (evaluateRecoveryTriggers, planRecoveryFetches) is pure and synchronous.
export async function buildRecoveryPolicyObject(params: {
  buyTimeline: BuyTimeline
  sellTimeline: SellTimeline
  holdings: HoldingInput[]
  walletAddress: string
  triggerConfig?: RecoveryPolicyTriggerConfig
  caps?: RecoveryPolicyCaps
}): Promise<RecoveryPolicyResult> {
  const triggerConfig = params.triggerConfig ?? DEFAULT_TRIGGER_RECOVERY_WHEN
  const caps = params.caps ?? DEFAULT_RECOVERY_CAPS

  const candidates = evaluateRecoveryTriggers(params.buyTimeline, params.sellTimeline, params.holdings, triggerConfig)

  // CU-RISK: MEDIUM (bounded, not unbounded) — this is the one real per-token, multi-page deep
  // historical fetch loop in this codebase (CU-AUDIT, docs/CU_AUDIT.md). It IS capped
  // (maxHistoricalPagesPerWallet/maxHistoricalPagesPerToken, enforced in planRecoveryFetches above)
  // and only ever runs for scanMode: 'deep' (never a normal scan — see src/pipeline/index.ts's
  // safeRunRecoveryPolicy), so it does not qualify as HIGH RISK ("unbounded loop") — but it is real,
  // variable-count, per-candidate-token GoldRush/Alchemy pagination, worth knowing about when
  // reasoning about deep-scan cost.
  const plan = planRecoveryFetches(candidates, caps)

  const results = await Promise.all(
    plan.map(({ candidate, pageBudget }) =>
      pageBudget > 0
        ? fetchHistoricalPages(candidate.chain, candidate.token, params.walletAddress, pageBudget)
        : Promise.resolve({ events: [] as Awaited<ReturnType<typeof fetchHistoricalPages>>['events'], pagesUsed: 0 }),
    ),
  )

  const evaluation: RecoveryEvaluationEntry[] = plan.map(({ candidate }, i) => ({
    ...candidate,
    pagesUsed: results[i].pagesUsed,
    recoveredEvents: results[i].events,
  }))
  const totalPagesUsedThisWallet = results.reduce((sum, r) => sum + r.pagesUsed, 0)

  return { triggerRecoveryWhen: triggerConfig, caps, evaluation, totalPagesUsedThisWallet }
}
