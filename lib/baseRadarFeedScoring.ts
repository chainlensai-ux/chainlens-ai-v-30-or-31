export type RadarFeedSimulationStatus = 'passed' | 'open_check' | string | null | undefined
export type RadarFeedRiskLabel = 'VERY LOW' | 'LOW' | 'MODERATE' | 'WATCHLIST' | 'STRONGER'

export interface RadarFeedScoreInput {
  baseScore: number
  liquidityUsd?: number | null
  volume24h?: number | null
  ageMinutes?: number | null
  simulationStatus?: RadarFeedSimulationStatus
  buyTax?: number | null
  sellTax?: number | null
  honeypotPresent?: boolean
  valuationVerified?: boolean
  valuationUsd?: number | null
  lpLockBurnConfirmed?: boolean
  lpModel?: string | null
  strongProtection?: boolean
  activeOwner?: boolean
  top10?: number | null
  top20?: number | null
  highHolderConcentration?: boolean
  majorControlOrHolderOrLpRedFlag?: boolean
  simulationReason?: string | null
  missingSocials?: boolean
}


function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

function saneValuation(input: RadarFeedScoreInput): boolean {
  return Boolean(input.valuationVerified) || (typeof input.valuationUsd === 'number' && Number.isFinite(input.valuationUsd) && input.valuationUsd >= 1_000 && input.valuationUsd <= 1_000_000_000)
}

export function getRadarFeedRiskLabel(score: number): RadarFeedRiskLabel {
  if (score >= 75) return 'STRONGER'
  if (score >= 60) return 'WATCHLIST'
  if (score >= 40) return 'MODERATE'
  if (score >= 25) return 'LOW'
  return 'VERY LOW'
}

export function getRadarFeedStatusFromScore(score: number): 'HOT' | 'WATCH' | 'EARLY' | 'UNVERIFIED' | 'RISKY' | 'DEAD' {
  if (score >= 75) return 'HOT'
  if (score >= 60) return 'WATCH'
  if (score >= 40) return 'UNVERIFIED'
  if (score >= 25) return 'RISKY'
  return 'DEAD'
}

export function applyBaseRadarScoreCaps(input: RadarFeedScoreInput): { score: number; cap: number | null; caps: string[]; riskLabel: RadarFeedRiskLabel } {
  const caps: Array<{ cap: number; reason: string }> = []
  const liquidity = input.liquidityUsd ?? null
  const missingTaxEvidence = !input.honeypotPresent || input.buyTax == null || input.sellTax == null
  const simulationUnconfirmed = input.simulationStatus !== 'passed' || missingTaxEvidence
  const youngTimeout = simulationUnconfirmed && input.ageMinutes != null && input.ageMinutes < 15
  const erc20LpNeedsProof = input.lpModel == null || input.lpModel === 'erc20_lp_token' || input.lpModel === 'open_check'

  if (simulationUnconfirmed) caps.push({ cap: 74, reason: 'Simulation or tax evidence is not confirmed.' })
  if (youngTimeout) caps.push({ cap: 59, reason: 'New token with unresolved simulation.' })
  if (erc20LpNeedsProof && !input.lpLockBurnConfirmed && !input.strongProtection) caps.push({ cap: 49, reason: 'ERC20 LP lock/burn proof is missing.' })
  if (input.activeOwner && (input.highHolderConcentration || (input.top10 != null && input.top10 > 70) || (input.top20 != null && input.top20 > 90))) caps.push({ cap: 59, reason: 'Active owner/admin with high holder concentration.' })
  if (input.top10 != null && input.top10 > 70) caps.push({ cap: 59, reason: 'Top 10 holders exceed 70%.' })
  if (input.top20 != null && input.top20 > 90) caps.push({ cap: 49, reason: 'Top 20 holders exceed 90%.' })
  if (liquidity != null && liquidity < 5_000) caps.push({ cap: 39, reason: 'Liquidity below $5k.' })
  if (liquidity != null && liquidity < 500) caps.push({ cap: 24, reason: 'Liquidity below $500.' })

  const highScoreAllowed = input.simulationStatus === 'passed'
    && !missingTaxEvidence
    && saneValuation(input)
    && liquidity != null && liquidity >= 5_000
    && !input.majorControlOrHolderOrLpRedFlag
    && !(input.top10 != null && input.top10 > 70)
    && !(input.top20 != null && input.top20 > 90)
    && !(erc20LpNeedsProof && !input.lpLockBurnConfirmed && !input.strongProtection)

  if (!highScoreAllowed) caps.push({ cap: 79, reason: '80+ requires confirmed simulation, sane valuation, liquidity, and no major red flags.' })

  let penalties = 0
  const reason = String(input.simulationReason ?? '')
  if (input.simulationStatus !== 'passed') {
    if (reason === 'timeout_after_retry') penalties += 12
    else if (reason === 'unsupported_pool_model') penalties += 8
    else penalties += 6
  }
  if (missingTaxEvidence) penalties += 10
  if (input.ageMinutes != null) {
    if (input.ageMinutes < 5) penalties += 10
    else if (input.ageMinutes < 15) penalties += 6
  }
  if (liquidity != null) {
    if (liquidity < 500) penalties += 30
    else if (liquidity < 5_000) penalties += 18
  }
  if (input.top10 != null && input.top10 > 70) penalties += 15
  if (input.top20 != null && input.top20 > 90) penalties += 18
  if (input.activeOwner) penalties += 10
  if (input.missingSocials) penalties += 4
  if (erc20LpNeedsProof && !input.lpLockBurnConfirmed && !input.strongProtection) penalties += 15

  const confidenceBoost = input.valuationVerified ? 3 : 0
  const cap = caps.length ? Math.min(...caps.map(c => c.cap)) : null
  const penalizedScore = input.baseScore - penalties + confidenceBoost
  const score = clampScore(cap == null ? penalizedScore : Math.min(penalizedScore, cap))
  const activeCapReasons = caps.filter(c => cap == null || c.cap === cap).map(c => c.reason)
  // TOKEN-SAVER: log why a cap won so a fallback score is traceable to its evidence gap
  // rather than looking like a stuck/hardcoded value.
  if (process.env.NODE_ENV !== 'production' && cap != null) {
    console.debug('[baseRadarFeedScoring] cap applied', { baseScore: input.baseScore, cap, score, reasons: activeCapReasons })
  }
  return { score, cap, caps: activeCapReasons, riskLabel: getRadarFeedRiskLabel(score) }
}
