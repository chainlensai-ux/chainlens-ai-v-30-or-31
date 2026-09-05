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
  PnlRecoveryFlowAuditEntry,
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
  fetchGoldrushFreeRideEvents,
  fetchGoldrushHistoricalPage,
  sellOccurrenceCount,
  top3HoldingTokens,
} from './utils'

export type {
  HoldingInput,
  PnlRecoveryFlowAuditEntry,
  RecoveryEvaluationEntry,
  RecoveryPolicyCaps,
  RecoveryPolicyResult,
  RecoveryPolicyTriggerConfig,
  RecoveryTriggerEvidenceRef,
  RecoveryTriggeredBy,
  RecoveryTriggerRule,
} from './types'
export { DEFAULT_RECOVERY_CAPS, DEFAULT_TRIGGER_RECOVERY_WHEN } from './types'

// CONCURRENCY CAP, DISCLOSED (wallet-scanner audit fix): buildRecoveryPolicyObject previously ran
// ALL triggered candidates' fetchHistoricalPages concurrently via a single Promise.all — not just
// page 1 (GoldRush) vs page 2 (Alchemy) within one candidate, which was the parallelism this module
// was actually designed for. Each candidate itself fans out to 1 GoldRush + up to 1 Alchemy call, so
// with maxHistoricalPagesPerWallet/maxHistoricalPagesPerToken allowing up to 3 triggered candidates
// on one wallet, this could burst up to 3 concurrent GoldRush + 3 concurrent Alchemy requests against
// one shared API key — with no cap like pricingAtTimeEngine's PRICE_ENTRY_CONCURRENCY_LIMIT, and
// failures silently swallowed as "no history" by fetchGoldrushHistoricalPage/fetchAlchemyTokenHistory,
// making a real 429 indistinguishable from "wallet genuinely has no history". Capped at 2 concurrent
// candidates — this only ever affects deep scans with multiple triggered tokens, and this module's
// own real fetch loop is already bounded (CU-AUDIT), so this is strictly a burst-shape fix, not a
// new cap on total volume.
const RECOVERY_CANDIDATE_CONCURRENCY_LIMIT = 2

async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

export type CandidateEvaluation = {
  token: string
  chain: SupportedChain
  triggeredBy: RecoveryTriggeredBy[]
  recoveryTriggered: boolean
  // COVERAGE MATERIALITY, DISCLOSED, OPTIONAL (verified-coverage recovery task). Both figures are
  // already computed by evaluateRecoveryTriggers for its own trigger rules — they are recorded here
  // rather than recomputed, so this adds zero work and zero provider calls. Used ONLY to decide
  // which triggered candidates get the scarce wallet page budget first (see planRecoveryFetches);
  // it never changes WHETHER a candidate is triggered, and never affects FIFO/pricing/dedupe.
  //
  // sellCount is the primary signal because verified coverage's denominator is CLOSED lots: one
  // token sold 12 times can convert up to 12 closed lots from unpriced to verified when its entry
  // buys are recovered, while a token sold once can convert at most one — so per page spent,
  // repeatedly-sold tokens are strictly the higher-yield target for the coverage gate.
  // Optional so existing callers/tests that construct a candidate without it keep working; absent
  // means "unknown materiality", which sorts last-but-stable (never ahead of a measured candidate).
  coverageMateriality?: { sellCount: number; cumulativeBuyUsd: number }
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

    return {
      token,
      chain,
      triggeredBy,
      recoveryTriggered: triggeredBy.length > 0,
      // Reuses the two figures already computed above for the trigger rules — not a second pass.
      coverageMateriality: { sellCount, cumulativeBuyUsd: cumulativeUsd },
    }
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
// MATERIALITY-ORDERED ALLOCATION, DISCLOSED (verified-coverage recovery task — confirmed
// production defect). The wallet page budget is genuinely scarce: DEFAULT_RECOVERY_CAPS allows 6
// pages per wallet and fetchHistoricalPages consumes 2 per candidate, so exactly
// floor(6 / 2) = 3 triggered tokens can ever receive recovery, no matter how many trigger. That
// ceiling is intentional cost control and is NOT changed here.
//
// What WAS wrong is which 3 got it. Candidates arrive in distinctTokensFromTimelines' Map
// insertion order — i.e. whichever token happens to appear first in the buy/sell timelines — which
// is chronological and completely unrelated to how much a token contributes to the verified
// coverage gate. So the scarce budget was routinely spent on an incidental single-sell token while
// a repeatedly-sold token (worth many closed lots) got nothing. Confirmed live shape: 5 tokens
// triggered, 3 recovered, coverage stalled at 46.36%.
//
// This orders the SAME budget by measured coverage materiality first. It does not raise any cap,
// does not fetch more pages, and does not change how many candidates get budget — identical
// provider call volume, aimed at the tokens that can actually move the gate.
//
// The sort is STABLE and only ever reorders ALLOCATION: the returned array stays in the caller's
// original candidate order, so output shape/ordering downstream is byte-identical to before.
// Candidates with equal (or absent) materiality keep their original relative order, which is why
// existing allocation behaviour for unmeasured candidates is unchanged.
function materialityRank(candidate: CandidateEvaluation): { sellCount: number; cumulativeBuyUsd: number } {
  return candidate.coverageMateriality ?? { sellCount: 0, cumulativeBuyUsd: 0 }
}

export function planRecoveryFetches(
  candidates: CandidateEvaluation[],
  caps: RecoveryPolicyCaps,
): Array<{ candidate: CandidateEvaluation; pageBudget: number; rank: number }> {
  // Stable descending sort by materiality, carrying the original index so the result can be
  // restored to input order after allocation.
  const allocationOrder = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const ra = materialityRank(a.candidate)
      const rb = materialityRank(b.candidate)
      if (rb.sellCount !== ra.sellCount) return rb.sellCount - ra.sellCount
      if (rb.cumulativeBuyUsd !== ra.cumulativeBuyUsd) return rb.cumulativeBuyUsd - ra.cumulativeBuyUsd
      return a.index - b.index // stable tiebreak — preserves original order for equal materiality
    })

  const budgetByIndex = new Array<number>(candidates.length).fill(0)
  // PNL-RECOVERY-FLOW-FIX, DISCLOSED (compact per-token flow audit, "ranked" field): the same
  // materiality position already computed for allocation, exposed per-candidate so pnlRecoveryFlowAudit
  // can report it without a second, duplicate sort.
  const rankByIndex = new Array<number>(candidates.length).fill(-1)
  let remainingWalletBudget = caps.maxHistoricalPagesPerWallet

  allocationOrder.forEach(({ candidate, index }, rankPosition) => {
    rankByIndex[index] = rankPosition
    if (!candidate.recoveryTriggered || remainingWalletBudget <= 0) {
      budgetByIndex[index] = 0
      return
    }
    const pageBudget = Math.min(caps.maxHistoricalPagesPerToken, remainingWalletBudget)
    // fetchHistoricalPages never actually consumes more than 2 pages regardless of pageBudget (see
    // its own header) — mirror that exact cap here so the NEXT candidate's remainingWalletBudget
    // matches the real pagesUsed that will be reported.
    const actualPagesForThisCandidate = Math.min(Math.max(0, pageBudget), 2)
    remainingWalletBudget -= actualPagesForThisCandidate
    budgetByIndex[index] = pageBudget
  })

  return candidates.map((candidate, index) => ({ candidate, pageBudget: budgetByIndex[index], rank: rankByIndex[index] }))
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

  // PNL-RECOVERY-FLOW-FIX, DISCLOSED (Wallet Scanner PnL recovery bottleneck task — confirmed
  // production shape: 8 triggered, only 3 succeeded, "page cap 6 funds only 3 tokens"). A triggered
  // candidate that planRecoveryFetches allocated ZERO wallet-page budget to (the scarce budget was
  // already spent on higher-materiality candidates) used to be skipped OUTRIGHT below, even though
  // fetchGoldrushHistoricalPage's page-1 fetch has no token parameter and is already request-scope
  // coalesced (see utils.ts) — i.e. if ANY other candidate on the SAME chain has real budget and will
  // trigger that exact call anyway, a zero-budget candidate can read the SAME already-fetched (or
  // in-flight) page for free and recover its own token's entry/exit legs from it, at zero additional
  // provider cost. Only chains with at least one REAL paying candidate get this free ride — a chain
  // where nobody has budget never triggers an extra fetch, so total provider-call/page volume is
  // unchanged; only which already-fetched data zero-budget candidates get to benefit from changes.
  const chainsWithRealGoldrushBudget = new Set(plan.filter((p) => p.pageBudget > 0).map((p) => p.candidate.chain))

  const results = await mapWithConcurrencyLimit(plan, RECOVERY_CANDIDATE_CONCURRENCY_LIMIT, ({ candidate, pageBudget }) => {
    if (pageBudget > 0) return fetchHistoricalPages(candidate.chain, candidate.token, params.walletAddress, pageBudget)
    if (chainsWithRealGoldrushBudget.has(candidate.chain)) return fetchGoldrushFreeRideEvents(candidate.chain, candidate.token, params.walletAddress)
    return Promise.resolve({ events: [] as Awaited<ReturnType<typeof fetchHistoricalPages>>['events'], pagesUsed: 0 })
  })

  const evaluation: RecoveryEvaluationEntry[] = plan.map(({ candidate }, i) => ({
    ...candidate,
    pagesUsed: results[i].pagesUsed,
    recoveredEvents: results[i].events,
  }))
  const totalPagesUsedThisWallet = results.reduce((sum, r) => sum + r.pagesUsed, 0)

  const walletLower = params.walletAddress.trim().toLowerCase()
  const pnlRecoveryFlowAudit: PnlRecoveryFlowAuditEntry[] = plan.map(({ candidate, pageBudget, rank }, i) => {
    const matchingEvents = results[i].events
    let entryLotsRecovered = 0
    let exitLotsRecovered = 0
    for (const ev of matchingEvents) {
      const to = (ev.toAddress ?? '').toLowerCase()
      const from = (ev.fromAddress ?? '').toLowerCase()
      if (to === walletLower) entryLotsRecovered += 1
      else if (from === walletLower) exitLotsRecovered += 1
    }
    const includedInSharedRequest = pageBudget > 0 || chainsWithRealGoldrushBudget.has(candidate.chain)
    let dropStage: PnlRecoveryFlowAuditEntry['dropStage'] = 'not_dropped'
    let dropReason: string | null = null
    if (!candidate.recoveryTriggered) {
      dropStage = 'not_triggered'
      dropReason = 'no recovery trigger rule matched for this token'
    } else if (!includedInSharedRequest) {
      dropStage = 'no_shared_request'
      dropReason = 'no candidate on this chain received wallet page budget, so no shared GoldRush page was fetched for this chain'
    } else if (matchingEvents.length === 0) {
      dropStage = 'no_matching_events'
      dropReason = 'the fetched page(s) for this chain contained no transactions for this token'
    }
    return {
      token: candidate.token,
      chain: candidate.chain,
      lotCount: candidate.coverageMateriality?.sellCount ?? 0,
      ranked: rank,
      includedInSharedRequest,
      pagesAvailable: pageBudget,
      matchingEventsFound: matchingEvents.length,
      entryLotsRecovered,
      exitLotsRecovered,
      // recoveryPolicy runs strictly before fifoEngine/pricing (this file's own architectural rule) —
      // it structurally cannot know these; honestly null, never guessed.
      priceRequirements: null,
      pricesResolved: null,
      lotsVerified: null,
      dropStage,
      dropReason,
    }
  })

  return { triggerRecoveryWhen: triggerConfig, caps, evaluation, totalPagesUsedThisWallet, pnlRecoveryFlowAudit }
}
