// Centralized severe-risk scoring helpers for Base Radar.
//
// Base Radar is an opportunity/risk discovery engine, not a hype dashboard.
// These helpers apply caps and labeling so that tokens with severe LP/holder/
// ownership risk signals never display as strong opportunities, even when the
// underlying liquidity/volume heuristics produce a high base score.

export function normalizePairCreatedAt(value: unknown): string | null {
  if (!value) return null
  const raw = typeof value === "string" ? value.trim() : value
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) {
    const n = Number(raw)
    const ms = n > 10_000_000_000 ? n : n * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof raw === "string") {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

export function ageLabelFromIso(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

// Mirrors the top_share/owner_lp_share/locker_share/burn_share evidence convention
// used in lib/server/secondaryLpExposure.ts for the primary pool's lpControl evidence.
export function extractLpControllerSharePercent(evidence: string[] | null | undefined): number | null {
  if (!Array.isArray(evidence)) return null
  for (const key of ['owner_lp_share', 'top_share', 'locker_share', 'burn_share']) {
    const line = evidence.find((item) => item.toLowerCase().startsWith(`${key}=`))
    if (line) {
      const value = Number(line.split('=').slice(1).join('=').replace('%', ''))
      if (Number.isFinite(value)) return Math.round(value * 100) / 100
    }
  }
  return null
}

export interface BaseRadarSeverityInput {
  baseScore: number
  lpControlStatus: string | null
  lpController: string | null
  lockBurnConfirmed: boolean
  lpControlEvidence?: string[] | null
  top1: number | null
  top10: number | null
  top20?: number | null
  holderCount: number | null
  ownershipStatus: string | null
  hasSocials: boolean
  poolAgeMinutes: number | null
  marketCapUsd: number | null
  fdvUsd: number | null
  simulationStatus?: 'passed' | 'open_check' | null
  lpModelUnknown?: boolean
}

export interface BaseRadarSeverityResult {
  cap: number | null
  effectiveScore: number
  severityLabel: string
  severeFlags: string[]
  flagCount: number
  evidenceGaps: string[]
  watchNext: string[]
  cortexSevereLine: string | null
}

export function getScoreSeverityLabel(score: number): string {
  if (score >= 75) return 'STRONG SIGNAL'
  if (score >= 60) return 'WATCHLIST'
  if (score >= 40) return 'CAUTION'
  if (score >= 25) return 'HIGH WATCH'
  return 'EXTREME WATCH'
}

export function creatorTopHolderDisplay(inTopHolders: boolean | null | undefined, creatorPercent: number | null | undefined): string {
  if (inTopHolders === true) {
    if (creatorPercent != null && Number.isFinite(creatorPercent) && creatorPercent > 0) {
      return `Detected · ${creatorPercent.toFixed(1)}%`
    }
    return 'Detected in indexed holders · supply share open check'
  }
  if (inTopHolders === false) return 'Not confirmed'
  return 'Open Check'
}

export function assessBaseRadarSeverity(input: BaseRadarSeverityInput): BaseRadarSeverityResult {
  const lpControllerSharePercent = extractLpControllerSharePercent(input.lpControlEvidence)
  const isWalletTeamControlled = input.lpControlStatus === 'team_controlled'
  const activeOwner = input.ownershipStatus === 'active_owner'
  const smallOrNewPool = input.poolAgeMinutes == null || input.poolAgeMinutes <= 1440
  const extremeConcentration = (input.top10 != null && input.top10 >= 80) || (input.top20 != null && input.top20 >= 90)

  const caps: Array<{ flag: string; matched: boolean; cap: number }> = [
    {
      flag: 'LP wallet/team controlled with no verified lock or burn proof',
      matched: isWalletTeamControlled && !input.lockBurnConfirmed,
      cap: 45,
    },
    {
      flag: 'LP controller share is at least 90% with lock/burn proof open',
      matched: lpControllerSharePercent != null && lpControllerSharePercent >= 90 && !input.lockBurnConfirmed,
      cap: 35,
    },
    {
      flag: 'LP controller share is at least 99% with lock/burn proof open',
      matched: lpControllerSharePercent != null && lpControllerSharePercent >= 99 && !input.lockBurnConfirmed,
      cap: 30,
    },
    {
      flag: 'Top holder controls at least 50% of supply',
      matched: input.top1 != null && input.top1 >= 50,
      cap: 40,
    },
    {
      flag: 'Top holder controls at least 90% of supply',
      matched: input.top1 != null && input.top1 >= 90,
      cap: 25,
    },
    {
      flag: 'Top 10 holders control at least 95% of supply',
      matched: input.top10 != null && input.top10 >= 95,
      cap: 30,
    },
    {
      flag: 'Top 10 holders control at least 80% of supply',
      matched: input.top10 != null && input.top10 >= 80,
      cap: 45,
    },
    {
      flag: 'Top 10 holders control at least 90% of supply',
      matched: input.top10 != null && input.top10 >= 90,
      cap: 35,
    },
    {
      flag: 'Top 20 holders control at least 90% of supply',
      matched: input.top20 != null && input.top20 >= 90,
      cap: 40,
    },
    {
      flag: 'Holder count is under 25',
      matched: input.holderCount != null && input.holderCount < 25,
      cap: 35,
    },
    {
      flag: 'Active owner/admin alongside wallet/team LP control',
      matched: activeOwner && isWalletTeamControlled,
      cap: 35,
    },
    {
      flag: 'Active owner/admin with top holder controlling at least 50% of supply',
      matched: activeOwner && input.top1 != null && input.top1 >= 50,
      cap: 35,
    },
    {
      flag: 'Active owner/admin alongside extreme holder concentration',
      matched: activeOwner && extremeConcentration,
      cap: 35,
    },
    {
      flag: 'Buy/sell simulation is an open check alongside extreme holder concentration',
      matched: input.simulationStatus === 'open_check' && extremeConcentration,
      cap: 40,
    },
    {
      flag: 'LP pool model is unknown alongside extreme holder concentration',
      matched: Boolean(input.lpModelUnknown) && extremeConcentration,
      cap: 40,
    },
    {
      flag: 'Missing socials on a small or very new pool',
      matched: !input.hasSocials && smallOrNewPool,
      cap: 45,
    },
  ]

  const severeFlags = caps.filter((c) => c.matched).map((c) => c.flag)
  const flagCount = severeFlags.length
  const candidateCaps = caps.filter((c) => c.matched).map((c) => c.cap)
  if (flagCount >= 3) candidateCaps.push(35)
  if (flagCount >= 5) candidateCaps.push(30)

  const cap = candidateCaps.length ? Math.min(...candidateCaps) : null
  const effectiveScore = cap != null ? Math.min(input.baseScore, cap) : input.baseScore
  const severityLabel = getScoreSeverityLabel(effectiveScore)

  const evidenceGaps: string[] = []
  if (!input.lockBurnConfirmed) {
    evidenceGaps.push('LP lock proof is not verified.')
    evidenceGaps.push('LP burn proof is not verified.')
  }
  if (isWalletTeamControlled && input.lpController) {
    evidenceGaps.push('A single wallet controls the dominant share of the LP position.')
  }
  if (input.marketCapUsd == null && input.fdvUsd != null) {
    evidenceGaps.push('Market cap is unavailable; valuation context is FDV-only.')
  }
  if (input.poolAgeMinutes == null) {
    evidenceGaps.push('Pool age is unavailable or not normalized from current evidence.')
  }
  if (!input.hasSocials) {
    evidenceGaps.push('Project socials are missing from current evidence.')
  }
  if (input.holderCount != null && input.holderCount < 25) {
    evidenceGaps.push(`Holder count is very low (${input.holderCount}).`)
  }
  if ((input.top10 != null && input.top10 >= 95) || (input.top1 != null && input.top1 >= 90)) {
    evidenceGaps.push('Holder concentration is extreme based on indexed top-holder evidence.')
  }
  if (activeOwner) {
    evidenceGaps.push('Contract ownership is active (not renounced).')
  }

  const watchNext: string[] = []
  if (flagCount > 0) {
    if (isWalletTeamControlled) watchNext.push('Watch LP movement from controlling wallet.')
    watchNext.push('Watch top-holder wallets for large transfers.')
    if (!input.lockBurnConfirmed) watchNext.push('Verify lock/burn proof before trusting liquidity stability.')
    watchNext.push('Rescan after liquidity or holder changes.')
  }

  let cortexSevereLine: string | null = null
  if (activeOwner && input.top1 != null && input.top1 >= 50 && input.top20 != null && input.top20 >= 90) {
    cortexSevereLine = 'Holder concentration is high: the top wallet controls over 50% and the top 20 wallets control over 90%. '
      + 'Ownership/admin control is still active, so owner-side risk remains open.'
  } else if (flagCount >= 3) {
    cortexSevereLine = 'Market evidence is available and simulation passed, but the control profile is severe: '
      + 'a single wallet controls the detected LP position, no verified lock/burn proof was found, '
      + 'holder count is very low, and indexed supply is extremely concentrated. '
      + 'Treat as extreme watch until lock/burn and holder movement evidence improves.'
  }

  return {
    cap,
    effectiveScore,
    severityLabel,
    severeFlags,
    flagCount,
    evidenceGaps,
    watchNext,
    cortexSevereLine,
  }
}
