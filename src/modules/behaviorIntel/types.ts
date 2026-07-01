// MODULE 7 — behaviorIntel: type definitions.
//
// Pure behavioral read. Zero cost, zero provider calls. Reads ONLY timelines + chainSelection (+
// windowCoverage, an external coverage-fact input — no such module exists yet in this delivery,
// see Architecture Step 1 for its shape) and an optional holdings input for concentration signals
// (no portfolio-pricing module exists yet either). NEVER imports fifoEngine or recoveryPolicy.
//
// TODO: HyperEVM LP/staking/yield detection requires verified contract registry — this module has
// no LP/staking/yield fields at all (no such detection exists for ANY chain yet), so it never
// claims yield-farming activity on HyperEVM or anywhere else. Keep it that way until a verified
// per-protocol contract-address registry exists; do not infer yield activity from generic
// transfer patterns.

import type { SupportedChain } from '../providerFetchWindow/types'

export type RotationStyle = 'accumulator' | 'rotator' | 'distributor' | 'unknown'
export type RiskOnOff = 'risk_on' | 'risk_off' | 'unknown'
export type ConfidenceLevel = 'high' | 'medium' | 'low'
export type WindowCoverageBasis = 'partial_window' | 'partial_window_plus_targeted_recovery' | 'full_window'

// Architecture Step 1 shape — defined locally (not imported from a shared module, since no such
// module exists in this delivery) so this module stays self-contained.
export type WindowCoverage = {
  realDataDays: number
  inferredDays: number
  recoveredExtraDays: number
  coverageBasis: WindowCoverageBasis
}

export type HoldingForConcentration = {
  token: string
  symbol: string
  chain: SupportedChain
  valueUsd: number
}

export type RotationStyleResult = {
  value: RotationStyle
  basis: {
    buyCount: number
    sellCount: number
    distributionCount: number
    distinctTokensTraded: number
  }
}

export type RiskOnOffResult = {
  value: RiskOnOff
  basis: string
}

export type AutomationSignals = {
  suspectedBot: boolean
  signals: string[]
}

export type MultiChainParticipation = {
  activeChains: SupportedChain[]
  primaryChain: SupportedChain | null
  chainSelectionRef: {
    activeChainCount: number
    dustChainCount: number
  }
  // Additive, sourced from real sellTimelineV2 entries (src/modules/sellTimeline) — distinct from
  // `activeChains` above, which means "cleared the active-intelligence gate" and is NOT redefined
  // by this migration (a buy-only wallet correctly keeps non-empty activeChains here). These two
  // fields answer a narrower, genuinely new question: "which of chainSelection's chains actually
  // have real sell evidence yet?"
  chainsWithRealSells: SupportedChain[]
  chainsPendingSellEvidence: SupportedChain[]
}

export type ConcentrationSignals = {
  topHoldingSymbol: string
  topHoldingPercent: number
  concentrationLabel: 'high' | 'medium' | 'balanced' | 'none'
} | null

export type ConfidenceBasis = {
  chainSelectionFactor: string
  windowCoverageFactor: string
  // Additive — real breakdown of sellTimelineV2 entries by confidence level (e.g. "2 high / 1
  // medium / 0 low confidence sells (via sellTimelineV2)"). `confidence`'s own value/meaning is
  // NOT redefined by this (still chainSelection/windowCoverage-derived, per this module's existing
  // documented semantics) — this is disclosure only, not a new derivation path for the field.
  sellEvidenceFactor: string
}

export type ExitVelocity = {
  // Median milliseconds between consecutive sellTimelineV2 entries, sorted by timestamp. null
  // when there are fewer than 2 real sells to measure a gap from — never a guessed number.
  medianMsBetweenSells: number | null
  basis: string
}

export type ConvictionLevel = 'high' | 'medium' | 'low' | 'unknown'

export type ConvictionScore = {
  value: ConvictionLevel
  basis: string
}

export type BehaviorIntelResult = {
  rotationStyle: RotationStyleResult
  riskOnOff: RiskOnOffResult
  multiChainParticipation: MultiChainParticipation
  concentrationSignals: ConcentrationSignals
  automationSignals: AutomationSignals
  confidence: ConfidenceLevel
  confidenceBasis: ConfidenceBasis
  // Additive fields — both sourced from real sellTimelineV2 entries (+ buyTimeline for
  // convictionScore). Neither existed before this migration; adding them changes nothing about
  // any pre-existing field.
  exitVelocity: ExitVelocity
  convictionScore: ConvictionScore
}
