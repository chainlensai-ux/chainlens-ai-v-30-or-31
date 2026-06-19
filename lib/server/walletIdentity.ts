import type { WalletSnapshot } from './walletSnapshot'

// ---------------------------------------------------------------------------
// Wallet Identity Engine V1 — deterministic archetype + score derived only from
// evidence already produced elsewhere in this snapshot (no new fetches, no AI).
// ---------------------------------------------------------------------------

export type WalletProfile = {
  score: number | null
  grade: string | null
  confidence: 'low' | 'medium' | 'high'
  primaryArchetype: string | null
  secondaryArchetype: string | null
  profileSummary: string | null
  signals: string[]
  reasons: string[]
  evidenceCoverage: number
}

const WALLET_ARCHETYPES = [
  'Smart Money', 'Meme Hunter', 'Swing Trader', 'Day Trader', 'Diamond Holder',
  'Whale', 'Yield Farmer', 'Airdrop Farmer', 'Dev Wallet', 'Passive Investor',
] as const

function gradeForScore(score: number): string {
  if (score >= 90) return 'A+'
  if (score >= 80) return 'A'
  if (score >= 70) return 'B'
  if (score >= 60) return 'C'
  if (score >= 50) return 'D'
  return 'F'
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function computeWalletProfile(snapshot: WalletSnapshot): WalletProfile {
  const reasons: string[] = []
  const signals: string[] = []

  const totalValueUsd = Number.isFinite(snapshot.totalValue) ? snapshot.totalValue : 0
  const holdings = Array.isArray(snapshot.holdings) ? snapshot.holdings : []
  const holdingsCount = holdings.length
  const facts = snapshot.walletFacts
  const chainExposure = facts?.summary?.chainExposure ?? []
  const chainCount = chainExposure.length
  const concentrationLabel = facts?.summary?.concentrationLabel ?? null

  const tradeStats = snapshot.walletTradeStatsSummary
  const lotSummary = snapshot.walletLotSummary
  const estimatedPnl = snapshot.estimatedPnl
  const behavior = snapshot.walletBehavior
  const historicalCoverage = snapshot.walletHistoricalCoverageSummary

  const closedLots = tradeStats?.closedLots ?? 0
  const uniqueTokensTraded = tradeStats?.uniqueTokensTraded ?? 0
  const turnoverRatio = closedLots > 0 ? uniqueTokensTraded / closedLots : 0
  const avgHoldHours = tradeStats?.avgHoldingTimeSeconds != null ? tradeStats.avgHoldingTimeSeconds / 3600 : null
  const winRatePercent = tradeStats?.winRatePercent ?? null
  const activeDays = behavior?.activeDays ?? null
  const tradesPerActiveDay = activeDays && activeDays > 0 ? closedLots / activeDays : null
  const realizedPnlUsd = estimatedPnl?.realizedPnlUsd ?? lotSummary?.realizedPnlUsd ?? null
  const unrealizedPnlUsd = estimatedPnl?.unrealizedPnlUsd ?? null
  const sourceClassification = (facts as unknown as { sourceClassification?: { claimOrAirdropLikeTxs?: number; swapLikeTxs?: number } } | undefined)?.sourceClassification
  const airdropLikeTxs = sourceClassification?.claimOrAirdropLikeTxs ?? null
  const swapLikeTxs = sourceClassification?.swapLikeTxs ?? null

  // --- Evidence coverage: how much of the underlying evidence pipeline actually completed ---
  const coverageChecks: Array<boolean> = [
    holdingsCount > 0,
    Boolean(facts && facts.status !== 'open_check'),
    Boolean(tradeStats && tradeStats.status !== 'open_check'),
    Boolean(estimatedPnl && estimatedPnl.status === 'ok'),
    Boolean(behavior && behavior.status !== 'unavailable'),
  ]
  const evidenceCoverage = Math.round((coverageChecks.filter(Boolean).length / coverageChecks.length) * 100)

  const hasMeaningfulTradeHistory = closedLots >= 3 && tradeStats?.economicSignificance === 'meaningful'
  const hasAnyHoldings = holdingsCount > 0

  if (!hasAnyHoldings) {
    reasons.push('No priced holdings available for this wallet — cannot classify or score.')
  }

  // --- Phase 1: archetype classification (deterministic, evidence-gated) ---
  type Candidate = { archetype: typeof WALLET_ARCHETYPES[number]; weight: number; reason: string }
  const candidates: Candidate[] = []

  if (hasMeaningfulTradeHistory) {
    if (winRatePercent != null && winRatePercent >= 55 && (tradeStats?.confidence === 'high' || tradeStats?.confidence === 'medium')) {
      const weight = winRatePercent + (tradeStats?.confidence === 'high' ? 10 : 0)
      candidates.push({ archetype: 'Smart Money', weight, reason: `Win rate ${winRatePercent.toFixed(1)}% across ${closedLots} closed trades with ${tradeStats?.confidence} confidence.` })
    }
    if (avgHoldHours != null && avgHoldHours < 6 && (tradesPerActiveDay ?? 0) >= 1) {
      candidates.push({ archetype: 'Day Trader', weight: 60 + Math.min(40, (tradesPerActiveDay ?? 0) * 10), reason: `Average hold time ${avgHoldHours.toFixed(1)}h with ${(tradesPerActiveDay ?? 0).toFixed(1)} trades/active day.` })
    } else if (avgHoldHours != null && avgHoldHours >= 24 && avgHoldHours < 24 * 30) {
      candidates.push({ archetype: 'Swing Trader', weight: 50 + Math.min(30, turnoverRatio * 30), reason: `Average hold time ${(avgHoldHours / 24).toFixed(1)} days with ${uniqueTokensTraded} unique tokens traded.` })
    }
    if (turnoverRatio >= 0.6 && holdingsCount > 0 && concentrationLabel === 'high') {
      candidates.push({ archetype: 'Meme Hunter', weight: 50 + turnoverRatio * 40, reason: `High position concentration (${concentrationLabel}) combined with high token turnover (${(turnoverRatio * 100).toFixed(0)}%).` })
    }
  } else if (closedLots > 0) {
    reasons.push(`Trade history present but below the meaningful-significance threshold (${tradeStats?.economicSignificanceReason ?? 'insufficient sample'}) — trading archetypes withheld.`)
  }

  if (totalValueUsd >= 250000 && hasAnyHoldings) {
    candidates.push({ archetype: 'Whale', weight: 70 + Math.min(30, Math.log10(totalValueUsd / 250000 + 1) * 30), reason: `Portfolio value $${Math.round(totalValueUsd).toLocaleString()} exceeds the whale threshold.` })
  }

  if (avgHoldHours != null && avgHoldHours >= 24 * 90 && turnoverRatio < 0.2 && closedLots > 0) {
    candidates.push({ archetype: 'Diamond Holder', weight: 50 + Math.min(40, (avgHoldHours / (24 * 90)) * 10), reason: `Average hold time ${(avgHoldHours / 24).toFixed(0)} days with minimal turnover (${(turnoverRatio * 100).toFixed(0)}%).` })
  } else if (closedLots === 0 && hasAnyHoldings && (activeDays ?? 0) > 30) {
    candidates.push({ archetype: 'Diamond Holder', weight: 40, reason: `No closed trades over ${activeDays} active days — holdings appear long-held rather than traded.` })
  }

  if (airdropLikeTxs != null && airdropLikeTxs >= 3 && swapLikeTxs != null && airdropLikeTxs > swapLikeTxs) {
    candidates.push({ archetype: 'Airdrop Farmer', weight: 40 + Math.min(30, airdropLikeTxs), reason: `${airdropLikeTxs} claim/airdrop-like transactions detected, exceeding swap-like activity.` })
  }

  if (hasAnyHoldings && closedLots === 0 && (tradesPerActiveDay ?? 0) === 0 && chainCount > 0 && concentrationLabel !== 'high' && holdingsCount >= 3) {
    candidates.push({ archetype: 'Passive Investor', weight: 35 + Math.min(20, holdingsCount), reason: `Diversified holdings across ${holdingsCount} assets with no closed trades detected.` })
  }

  // Yield Farmer and Dev Wallet are intentionally never assigned: the existing evidence model
  // (holdings + swap/transfer classification) does not surface LP/staking or contract-deploy
  // signals, and guessing here would violate the "do not guess" requirement.
  if (candidates.length === 0 && hasAnyHoldings) {
    reasons.push('Available evidence does not match any archetype heuristic with sufficient confidence.')
  }

  candidates.sort((a, b) => b.weight - a.weight)
  const primaryArchetype = candidates[0]?.archetype ?? null
  const secondaryArchetype = candidates[1] && candidates[1].archetype !== primaryArchetype ? candidates[1].archetype : null
  if (primaryArchetype) {
    signals.push(candidates[0].reason)
    reasons.push(`Primary archetype "${primaryArchetype}": ${candidates[0].reason}`)
  }
  if (secondaryArchetype) {
    signals.push(candidates[1].reason)
    reasons.push(`Secondary archetype "${secondaryArchetype}": ${candidates[1].reason}`)
  }

  // --- Phase 2: weighted wallet score ---
  let score: number | null = null
  let grade: string | null = null
  let confidence: 'low' | 'medium' | 'high' = 'low'

  const sufficientEvidence = hasAnyHoldings && evidenceCoverage >= 40

  if (!sufficientEvidence) {
    reasons.push(`Evidence coverage too low (${evidenceCoverage}%) to produce a reliable wallet score.`)
  } else {
    const portfolioQuality = clampPct(
      (totalValueUsd > 0 ? Math.min(100, Math.log10(totalValueUsd + 1) * 20) : 0)
    )
    const diversification = clampPct(
      (concentrationLabel === 'balanced' ? 80 : concentrationLabel === 'medium' ? 55 : concentrationLabel === 'high' ? 25 : 50) +
      Math.min(20, holdingsCount * 2)
    )
    const activityQuality = clampPct(
      closedLots === 0 ? 40 :
      tradeStats?.economicSignificance === 'meaningful' ? 60 + Math.min(40, closedLots * 2) :
      30
    )
    const pnlQuality = clampPct(
      estimatedPnl?.status !== 'ok' ? 30 :
      (winRatePercent != null ? winRatePercent : 50) * 0.7 +
      ((realizedPnlUsd ?? 0) + (unrealizedPnlUsd ?? 0) > 0 ? 30 : 10)
    )
    const chainIntelligence = clampPct(40 + Math.min(60, chainCount * 20))

    const weighted =
      portfolioQuality * 0.25 +
      diversification * 0.15 +
      activityQuality * 0.20 +
      pnlQuality * 0.25 +
      chainIntelligence * 0.15

    score = Math.round(clampPct(weighted))
    grade = gradeForScore(score)

    const highConfidenceInputs = [
      tradeStats?.confidence === 'high',
      estimatedPnl?.status === 'ok' && estimatedPnl?.confidence === 'high',
      (historicalCoverage?.coverageLevel === 'medium' || historicalCoverage?.coverageLevel === 'deep'),
    ].filter(Boolean).length

    if (evidenceCoverage >= 80 && highConfidenceInputs >= 2) confidence = 'high'
    else if (evidenceCoverage >= 55) confidence = 'medium'
    else confidence = 'low'

    signals.push(`Wallet score ${score}/100 (grade ${grade}) from portfolio quality, diversification, activity quality, PnL quality, and chain intelligence.`)
  }

  // --- Phase 3: deterministic profile summary ---
  let profileSummary: string | null = null
  if (sufficientEvidence && score != null) {
    const chainPart = chainCount > 1 ? `multi-chain (${chainCount} chains)` : chainCount === 1 ? `${chainExposure[0]?.chain ?? 'single-chain'}` : 'wallet'
    const concentrationPart = concentrationLabel === 'high' ? 'concentrated positions' : concentrationLabel === 'balanced' ? 'diversified positions' : 'mixed positions'
    const archetypePart = primaryArchetype ? `${primaryArchetype.toLowerCase()} wallet` : 'wallet'
    const activityPart = closedLots > 0 ? `active portfolio rotation across ${closedLots} closed trades` : 'a low-turnover holding pattern'
    profileSummary = `${chainPart} ${archetypePart} with ${concentrationPart} and ${activityPart}.`
    profileSummary = profileSummary.charAt(0).toUpperCase() + profileSummary.slice(1)
  } else {
    profileSummary = null
  }

  return {
    score,
    grade,
    confidence,
    primaryArchetype,
    secondaryArchetype,
    profileSummary,
    signals,
    reasons,
    evidenceCoverage,
  }
}
