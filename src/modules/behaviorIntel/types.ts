// MODULE 7 — behaviorIntel: type definitions.
//
// Pure behavioral read. Zero cost, zero provider calls. Reads ONLY timelines + chainSelection (+
// windowCoverage, an external coverage-fact input — no such module exists yet in this delivery,
// see Architecture Step 1 for its shape) and an optional holdings input for concentration signals
// (no portfolio-pricing module exists yet either). NEVER imports fifoEngine or recoveryPolicy.

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
}

export type ConcentrationSignals = {
  topHoldingSymbol: string
  topHoldingPercent: number
  concentrationLabel: 'high' | 'medium' | 'balanced' | 'none'
} | null

export type ConfidenceBasis = {
  chainSelectionFactor: string
  windowCoverageFactor: string
}

export type BehaviorIntelResult = {
  rotationStyle: RotationStyleResult
  riskOnOff: RiskOnOffResult
  multiChainParticipation: MultiChainParticipation
  concentrationSignals: ConcentrationSignals
  automationSignals: AutomationSignals
  confidence: ConfidenceLevel
  confidenceBasis: ConfidenceBasis
}
