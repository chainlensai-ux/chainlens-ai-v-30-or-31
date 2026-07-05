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

type CandidateEvaluation = {
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
export async function fetchHistoricalPages(
  chain: SupportedChain,
  token: string,
  walletAddress: string,
  pageCount: number,
) {
  const cappedPageCount = Math.max(0, pageCount)
  if (cappedPageCount === 0) return { events: [] as Awaited<ReturnType<typeof fetchGoldrushHistoricalPage>>, pagesUsed: 0 }

  const events: Awaited<ReturnType<typeof fetchGoldrushHistoricalPage>> = []
  let pagesUsed = 0

  // Page 1: one targeted GoldRush historical page (page-number 1, beyond the base window's page 0).
  const goldrushEvents = await fetchGoldrushHistoricalPage(chain, walletAddress, 1)
  pagesUsed += 1
  events.push(...goldrushEvents.filter((e) => (e.contract ?? '').toLowerCase() === token.toLowerCase()))

  // Page 2 (only if the cap allows it): one targeted Alchemy pull scoped to this token contract.
  if (cappedPageCount >= 2) {
    const alchemyEvents = await fetchAlchemyTokenHistory(chain, walletAddress, token)
    pagesUsed += 1
    events.push(...alchemyEvents)
  }

  return { events, pagesUsed }
}

// Orchestrates evaluation + capped, triggered historical fetches into the final recoveryPolicy
// object. This is the only function in the module that awaits network calls; everything above it
// (evaluateRecoveryTriggers) is pure and synchronous.
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
  // (maxHistoricalPagesPerWallet/maxHistoricalPagesPerToken, enforced below via
  // remainingWalletBudget/pageBudget) and only ever runs for scanMode: 'deep' (never a normal scan
  // — see src/pipeline/index.ts's safeRunRecoveryPolicy), so it does not qualify as HIGH RISK
  // ("unbounded loop") — but it is real, variable-count, per-candidate-token GoldRush/Alchemy
  // pagination, worth knowing about when reasoning about deep-scan cost.
  const evaluation: RecoveryEvaluationEntry[] = []
  let totalPagesUsedThisWallet = 0

  for (const candidate of candidates) {
    if (!candidate.recoveryTriggered || totalPagesUsedThisWallet >= caps.maxHistoricalPagesPerWallet) {
      evaluation.push({ ...candidate, pagesUsed: 0, recoveredEvents: [] })
      continue
    }

    // Never exceed either cap — the per-token budget is also clamped by whatever wallet-level
    // budget remains, so a late-evaluated token can never blow past the wallet ceiling even if
    // its own per-token cap would otherwise allow more.
    const remainingWalletBudget = caps.maxHistoricalPagesPerWallet - totalPagesUsedThisWallet
    const pageBudget = Math.min(caps.maxHistoricalPagesPerToken, remainingWalletBudget)

    const { events, pagesUsed } = await fetchHistoricalPages(candidate.chain, candidate.token, params.walletAddress, pageBudget)
    totalPagesUsedThisWallet += pagesUsed
    evaluation.push({ ...candidate, pagesUsed, recoveredEvents: events })
  }

  return { triggerRecoveryWhen: triggerConfig, caps, evaluation, totalPagesUsedThisWallet }
}
