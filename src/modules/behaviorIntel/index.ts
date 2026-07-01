// MODULE 7 — behaviorIntel
//
// Pure behavioral read. Zero cost, zero provider calls (Architecture Step 8 §5). Reads ONLY
// timelines + chainSelection (+ windowCoverage / holdings as external, non-financial coverage-fact
// inputs — see types.ts). This module deliberately has NO import of recoveryPolicy or fifoEngine
// anywhere in the file — that absence is what makes "behaviorIntel never reads financial data" a
// structural guarantee rather than a convention (Architecture Step 9 §5, Step 4 "no backflow").

import type { BuyTimeline, DistributionTimeline } from '../timelineBuilder/types'
import type { ChainSelectionResult } from '../chainSelection/types'
import type { SellTimelineEntry } from '../sellTimeline/types'
import type {
  AutomationSignals,
  BehaviorIntelResult,
  ConfidenceBasis,
  ConfidenceLevel,
  ConcentrationSignals,
  ConvictionScore,
  ExitVelocity,
  HoldingForConcentration,
  MultiChainParticipation,
  RiskOnOffResult,
  RotationStyleResult,
  WindowCoverage,
} from './types'
import {
  activeChainsFrom,
  chainsPendingSellEvidenceFrom,
  chainsWithRealSellsFrom,
  concentrationLabelFor,
  detectUniformSpacing,
  medianMsBetweenSells,
  primaryChainFrom,
  sellConfidenceBreakdown,
  topHolding,
} from './utils'

export type {
  AutomationSignals,
  BehaviorIntelResult,
  ConcentrationSignals,
  ConfidenceBasis,
  ConfidenceLevel,
  ConvictionLevel,
  ConvictionScore,
  ExitVelocity,
  HoldingForConcentration,
  MultiChainParticipation,
  RiskOnOff,
  RiskOnOffResult,
  RotationStyle,
  RotationStyleResult,
  WindowCoverage,
  WindowCoverageBasis,
} from './types'

// PURE. Derived from buyTimeline + real sellTimelineV2 entries + distributionTimeline — no
// financial figures, no recovery outcome, ever consulted.
//
// MIGRATION NOTE: sellCount/sellEntries now come from sellTimelineV2 (src/modules/sellTimeline),
// not the legacy timelines.sellTimeline. The enum ('accumulator' | 'rotator' | 'distributor' |
// 'unknown') and thresholds are UNCHANGED from before this migration — only the evidence source
// switched, per this module's "preserve existing fields and semantics" requirement.
export function classifyRotationStyle(
  buyTimeline: BuyTimeline,
  sellEntries: SellTimelineEntry[],
  distributionTimeline: DistributionTimeline,
): RotationStyleResult {
  const buyCount = buyTimeline.totalBuys
  const sellCount = sellEntries.length
  const distributionCount = distributionTimeline.totalDistributions
  const distinctTokensTraded = new Set([
    ...buyTimeline.entries.map((e) => `${e.chain}:${e.token.toLowerCase()}`),
    ...sellEntries.map((e) => `${e.chain}:${e.token.toLowerCase()}`),
  ]).size

  const basis = { buyCount, sellCount, distributionCount, distinctTokensTraded }

  if (buyCount === 0 && sellCount === 0 && distributionCount === 0) {
    return { value: 'unknown', basis }
  }
  if (sellCount + distributionCount > buyCount && (sellCount > 0 || distributionCount > 0)) {
    return { value: 'distributor', basis }
  }
  if (buyCount > 0 && sellCount === 0 && distributionCount === 0) {
    return { value: 'accumulator', basis }
  }
  return { value: 'rotator', basis }
}

// PURE. Derived from buyTimeline + real sellTimelineV2 entries. NOTE ON SCOPE: without a
// token-classification module (stablecoin/blue-chip labeling), this cannot truly assess "moving
// into risk assets" vs. "moving into stables" — it uses net buy vs. sell/exit activity as an
// honest, simplified proxy, clearly documented as such rather than presented as a richer signal
// than it is.
//
// MIGRATION NOTE: sellCount now comes from sellTimelineV2. A proceedsUsdEstimate-weighted
// "large exit" branch is NOT implemented — sellTimelineV2's proceedsUsdEstimate is always null
// today (no pricing-at-time module exists in any of its four mechanisms), so a branch keyed on it
// could never fire; adding one would be dead code dressed up as a real signal.
export function classifyRiskOnOff(buyTimeline: BuyTimeline, sellEntries: SellTimelineEntry[]): RiskOnOffResult {
  const buyCount = buyTimeline.totalBuys
  const sellCount = sellEntries.length

  if (buyCount === 0 && sellCount === 0) {
    return { value: 'unknown', basis: 'no buy or sell activity to derive a risk posture from' }
  }
  if (buyCount > sellCount) {
    return { value: 'risk_on', basis: 'buyTimeline activity outweighs sellTimelineV2 activity (net new-position accumulation)' }
  }
  if (sellCount > buyCount) {
    return { value: 'risk_off', basis: 'sellTimelineV2 activity outweighs buyTimeline activity (net exposure reduction)' }
  }
  return { value: 'unknown', basis: 'buy and sell activity are evenly balanced — no clear directional signal' }
}

// PURE. Derived from timestamp spacing across buyTimeline + real sellTimelineV2 entries — never
// financial or recovery data.
export function detectAutomationSignals(timelines: { buyTimeline: BuyTimeline; sellEntries: SellTimelineEntry[] }): AutomationSignals {
  const timestamps = [
    ...timelines.buyTimeline.entries.map((e) => e.timestamp),
    ...timelines.sellEntries.map((e) => e.timestamp),
  ]
  const { uniform, subSecondClusters } = detectUniformSpacing(timestamps)

  const signals: string[] = []
  if (uniform) signals.push('uniform_tx_spacing_detected')
  else signals.push('uniform_tx_spacing_not_detected')
  if (subSecondClusters > 0) signals.push(`sub_second_repeat_clusters_detected:${subSecondClusters}`)
  else signals.push('no_sub_second_repeat_patterns')

  return { suspectedBot: uniform && subSecondClusters > 0, signals }
}

// PURE, NEW. Real median time between sells (src/modules/sellTimeline), never a guessed cadence.
export function computeExitVelocity(sellEntries: SellTimelineEntry[]): ExitVelocity {
  const medianMs = medianMsBetweenSells(sellEntries)
  if (sellEntries.length === 0) {
    return { medianMsBetweenSells: null, basis: 'no real sells detected via sellTimelineV2' }
  }
  if (medianMs === null) {
    return { medianMsBetweenSells: null, basis: `only ${sellEntries.length} real sell(s) detected — need at least 2 to measure a gap` }
  }
  const medianDays = (medianMs / (24 * 60 * 60 * 1000)).toFixed(1)
  return { medianMsBetweenSells: medianMs, basis: `median gap across ${sellEntries.length} real sells is ~${medianDays} day(s)` }
}

// PURE, NEW. Coarse conviction proxy from buyTimeline + real sellTimelineV2 entries — "high" means
// buys with no detected exits, "low" means sells are frequent relative to buys. Same
// "uncomputable/ambiguous defaults to a conservative label, never fabricated" convention as the
// rest of this module.
export function computeConvictionScore(buyTimeline: BuyTimeline, sellEntries: SellTimelineEntry[]): ConvictionScore {
  const buyCount = buyTimeline.totalBuys
  const sellCount = sellEntries.length

  if (buyCount === 0 && sellCount === 0) {
    return { value: 'unknown', basis: 'no buy or sell activity to derive conviction from' }
  }
  if (buyCount > 0 && sellCount === 0) {
    return { value: 'high', basis: `${buyCount} buy(s) with zero detected exits via sellTimelineV2` }
  }
  const sellToBuyRatio = sellCount / Math.max(1, buyCount)
  if (sellToBuyRatio < 0.34) {
    return { value: 'high', basis: `${sellCount} sell(s) against ${buyCount} buy(s) — infrequent exits relative to entries` }
  }
  if (sellToBuyRatio > 1) {
    return { value: 'low', basis: `${sellCount} sell(s) against ${buyCount} buy(s) — exits outpace entries` }
  }
  return { value: 'medium', basis: `${sellCount} sell(s) against ${buyCount} buy(s) — moderate exit frequency` }
}

// PURE. `confidence`'s value is derived ONLY from windowCoverage + chainSelection, EXACTLY as
// before this migration — never from recoveryPolicy or fifoEngine outcomes (Architecture Step 3
// §3, Step 9 §3), and NOT redefined as "% of high-confidence sells" (that would be a different
// concept entirely and would break every existing consumer of this field's meaning). The real
// sellTimelineV2 confidence breakdown is disclosed as an additional confidenceBasis fact instead —
// see sellEvidenceFactor below.
export function computeConfidence(
  chainSelection: ChainSelectionResult,
  windowCoverage: WindowCoverage,
  sellEntries: SellTimelineEntry[],
): { confidence: ConfidenceLevel; confidenceBasis: ConfidenceBasis } {
  const { activeChainCount, dustChainCount } = chainSelection
  const totalChains = activeChainCount + dustChainCount
  const dustRatio = totalChains > 0 ? dustChainCount / totalChains : 0

  let confidence: ConfidenceLevel
  if (windowCoverage.coverageBasis === 'full_window' && dustRatio < 0.5) {
    confidence = 'high'
  } else if (windowCoverage.coverageBasis === 'partial_window' && dustRatio >= 0.5) {
    confidence = 'low'
  } else if (activeChainCount === 0) {
    confidence = 'low'
  } else {
    confidence = 'medium'
  }

  const sellBreakdown = sellConfidenceBreakdown(sellEntries)

  const confidenceBasis: ConfidenceBasis = {
    chainSelectionFactor: `${dustChainCount} dust chain(s) excluded out of ${totalChains} total`,
    windowCoverageFactor: `coverageBasis: ${windowCoverage.coverageBasis} (${windowCoverage.realDataDays} real / ${windowCoverage.inferredDays} inferred / ${windowCoverage.recoveredExtraDays} recovered days)`,
    sellEvidenceFactor: sellEntries.length === 0
      ? 'no real sells detected via sellTimelineV2'
      : `${sellBreakdown.high} high / ${sellBreakdown.medium} medium / ${sellBreakdown.low} low confidence sell(s) detected via sellTimelineV2`,
  }

  return { confidence, confidenceBasis }
}

function buildMultiChainParticipation(chainSelection: ChainSelectionResult, sellEntries: SellTimelineEntry[]): MultiChainParticipation {
  return {
    activeChains: activeChainsFrom(chainSelection),
    primaryChain: primaryChainFrom(chainSelection),
    chainSelectionRef: {
      activeChainCount: chainSelection.activeChainCount,
      dustChainCount: chainSelection.dustChainCount,
    },
    chainsWithRealSells: chainsWithRealSellsFrom(sellEntries),
    chainsPendingSellEvidence: chainsPendingSellEvidenceFrom(chainSelection, sellEntries),
  }
}

function buildConcentrationSignals(holdings: HoldingForConcentration[] | undefined): ConcentrationSignals {
  if (!holdings || holdings.length === 0) return null
  const top = topHolding(holdings)
  if (!top) return null
  return {
    topHoldingSymbol: top.symbol,
    topHoldingPercent: top.percent,
    concentrationLabel: concentrationLabelFor(top.percent),
  }
}

// MIGRATION: `sellTimeline` param replaced with `sellEntries` (real report.timelines.sellTimelineV2
// .entries) — the legacy timelines.sellTimeline is no longer read anywhere in this module. Callers
// (src/pipeline/index.ts) must pass sellTimelineV2.entries here; the legacy sellTimeline object
// itself is untouched and still produced by timelineBuilder for its own existing consumers.
export function buildBehaviorIntelObject(params: {
  buyTimeline: BuyTimeline
  sellEntries: SellTimelineEntry[]
  distributionTimeline: DistributionTimeline
  chainSelection: ChainSelectionResult
  windowCoverage: WindowCoverage
  holdings?: HoldingForConcentration[]
}): BehaviorIntelResult {
  const rotationStyle = classifyRotationStyle(params.buyTimeline, params.sellEntries, params.distributionTimeline)
  const riskOnOff = classifyRiskOnOff(params.buyTimeline, params.sellEntries)
  const automationSignals = detectAutomationSignals({ buyTimeline: params.buyTimeline, sellEntries: params.sellEntries })
  const { confidence, confidenceBasis } = computeConfidence(params.chainSelection, params.windowCoverage, params.sellEntries)
  const exitVelocity = computeExitVelocity(params.sellEntries)
  const convictionScore = computeConvictionScore(params.buyTimeline, params.sellEntries)

  return {
    rotationStyle,
    riskOnOff,
    multiChainParticipation: buildMultiChainParticipation(params.chainSelection, params.sellEntries),
    concentrationSignals: buildConcentrationSignals(params.holdings),
    automationSignals,
    confidence,
    confidenceBasis,
    exitVelocity,
    convictionScore,
  }
}
