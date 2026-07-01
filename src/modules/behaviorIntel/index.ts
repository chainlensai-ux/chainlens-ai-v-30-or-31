// MODULE 7 — behaviorIntel
//
// Pure behavioral read. Zero cost, zero provider calls (Architecture Step 8 §5). Reads ONLY
// timelines + chainSelection (+ windowCoverage / holdings as external, non-financial coverage-fact
// inputs — see types.ts). This module deliberately has NO import of recoveryPolicy or fifoEngine
// anywhere in the file — that absence is what makes "behaviorIntel never reads financial data" a
// structural guarantee rather than a convention (Architecture Step 9 §5, Step 4 "no backflow").

import type { BuyTimeline, DistributionTimeline, SellTimeline } from '../timelineBuilder/types'
import type { ChainSelectionResult } from '../chainSelection/types'
import type {
  AutomationSignals,
  BehaviorIntelResult,
  ConfidenceBasis,
  ConfidenceLevel,
  ConcentrationSignals,
  HoldingForConcentration,
  MultiChainParticipation,
  RiskOnOffResult,
  RotationStyleResult,
  WindowCoverage,
} from './types'
import {
  activeChainsFrom,
  concentrationLabelFor,
  detectUniformSpacing,
  primaryChainFrom,
  topHolding,
} from './utils'

export type {
  AutomationSignals,
  BehaviorIntelResult,
  ConcentrationSignals,
  ConfidenceBasis,
  ConfidenceLevel,
  HoldingForConcentration,
  MultiChainParticipation,
  RiskOnOff,
  RiskOnOffResult,
  RotationStyle,
  RotationStyleResult,
  WindowCoverage,
  WindowCoverageBasis,
} from './types'

// PURE. Derived ONLY from buy/sell/distribution timeline patterns — no financial figures, no
// recovery outcome, ever consulted.
export function classifyRotationStyle(
  buyTimeline: BuyTimeline,
  sellTimeline: SellTimeline,
  distributionTimeline: DistributionTimeline,
): RotationStyleResult {
  const buyCount = buyTimeline.totalBuys
  const sellCount = sellTimeline.totalSells
  const distributionCount = distributionTimeline.totalDistributions
  const distinctTokensTraded = new Set([
    ...buyTimeline.entries.map((e) => `${e.chain}:${e.token.toLowerCase()}`),
    ...sellTimeline.entries.map((e) => `${e.chain}:${e.token.toLowerCase()}`),
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

// PURE. Derived ONLY from buy/sell timeline patterns. NOTE ON SCOPE: without a token-classification
// module (stablecoin/blue-chip labeling), this cannot truly assess "moving into risk assets" vs.
// "moving into stables" — it uses net buy vs. sell/exit activity as an honest, simplified proxy,
// clearly documented as such rather than presented as a richer signal than it is.
export function classifyRiskOnOff(buyTimeline: BuyTimeline, sellTimeline: SellTimeline): RiskOnOffResult {
  const buyCount = buyTimeline.totalBuys
  const sellCount = sellTimeline.totalSells

  if (buyCount === 0 && sellCount === 0) {
    return { value: 'unknown', basis: 'no buy or sell activity to derive a risk posture from' }
  }
  if (buyCount > sellCount) {
    return { value: 'risk_on', basis: 'buyTimeline activity outweighs sellTimeline activity (net new-position accumulation)' }
  }
  if (sellCount > buyCount) {
    return { value: 'risk_off', basis: 'sellTimeline activity outweighs buyTimeline activity (net exposure reduction)' }
  }
  return { value: 'unknown', basis: 'buy and sell activity are evenly balanced — no clear directional signal' }
}

// PURE. Derived ONLY from timestamp spacing across buy + sell timeline entries — never financial
// or recovery data.
export function detectAutomationSignals(timelines: { buyTimeline: BuyTimeline; sellTimeline: SellTimeline }): AutomationSignals {
  const timestamps = [
    ...timelines.buyTimeline.entries.map((e) => e.timestamp),
    ...timelines.sellTimeline.entries.map((e) => e.timestamp),
  ]
  const { uniform, subSecondClusters } = detectUniformSpacing(timestamps)

  const signals: string[] = []
  if (uniform) signals.push('uniform_tx_spacing_detected')
  else signals.push('uniform_tx_spacing_not_detected')
  if (subSecondClusters > 0) signals.push(`sub_second_repeat_clusters_detected:${subSecondClusters}`)
  else signals.push('no_sub_second_repeat_patterns')

  return { suspectedBot: uniform && subSecondClusters > 0, signals }
}

// PURE. Derived ONLY from windowCoverage + chainSelection — never from recoveryPolicy or
// fifoEngine outcomes (Architecture Step 3 §3, Step 9 §3).
export function computeConfidence(
  chainSelection: ChainSelectionResult,
  windowCoverage: WindowCoverage,
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

  const confidenceBasis: ConfidenceBasis = {
    chainSelectionFactor: `${dustChainCount} dust chain(s) excluded out of ${totalChains} total`,
    windowCoverageFactor: `coverageBasis: ${windowCoverage.coverageBasis} (${windowCoverage.realDataDays} real / ${windowCoverage.inferredDays} inferred / ${windowCoverage.recoveredExtraDays} recovered days)`,
  }

  return { confidence, confidenceBasis }
}

function buildMultiChainParticipation(chainSelection: ChainSelectionResult): MultiChainParticipation {
  return {
    activeChains: activeChainsFrom(chainSelection),
    primaryChain: primaryChainFrom(chainSelection),
    chainSelectionRef: {
      activeChainCount: chainSelection.activeChainCount,
      dustChainCount: chainSelection.dustChainCount,
    },
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

export function buildBehaviorIntelObject(params: {
  buyTimeline: BuyTimeline
  sellTimeline: SellTimeline
  distributionTimeline: DistributionTimeline
  chainSelection: ChainSelectionResult
  windowCoverage: WindowCoverage
  holdings?: HoldingForConcentration[]
}): BehaviorIntelResult {
  const rotationStyle = classifyRotationStyle(params.buyTimeline, params.sellTimeline, params.distributionTimeline)
  const riskOnOff = classifyRiskOnOff(params.buyTimeline, params.sellTimeline)
  const automationSignals = detectAutomationSignals({ buyTimeline: params.buyTimeline, sellTimeline: params.sellTimeline })
  const { confidence, confidenceBasis } = computeConfidence(params.chainSelection, params.windowCoverage)

  return {
    rotationStyle,
    riskOnOff,
    multiChainParticipation: buildMultiChainParticipation(params.chainSelection),
    concentrationSignals: buildConcentrationSignals(params.holdings),
    automationSignals,
    confidence,
    confidenceBasis,
  }
}
