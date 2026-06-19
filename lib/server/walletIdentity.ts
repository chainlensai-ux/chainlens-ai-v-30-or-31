import type { WalletSnapshot } from './walletSnapshot'

// ---------------------------------------------------------------------------
// Wallet Identity Engine V2 — separates portfolio-size CATEGORY from
// evidence-driven BEHAVIOR, derived only from evidence already produced
// elsewhere in this snapshot (no new fetches, no AI).
// ---------------------------------------------------------------------------

export type WalletEvidenceCoverage = {
  portfolioConfidence: 'low' | 'medium' | 'high'
  tradingConfidence: 'low' | 'medium' | 'high'
  verifiedEvidence: string[]
  partialEvidence: string[]
  missingEvidence: string[]
}

export type WalletProfile = {
  score: number | null
  grade: string | null
  profileColor: string | null
  confidence: 'low' | 'medium' | 'high'
  category: string | null
  behavior: string | null
  secondaryBehavior: string | null
  // Back-compat aliases for older callers/UI — mirror category/behavior.
  primaryArchetype: string | null
  secondaryArchetype: string | null
  profileSummary: string | null
  followability: 'Low' | 'Moderate' | 'High' | null
  followabilityReasons: string[]
  strengths: string[]
  weaknesses: string[]
  nextAction: string | null
  signals: string[]
  reasons: string[]
  evidenceCoverage: number
  walletEvidenceCoverage: WalletEvidenceCoverage
}

const WALLET_CATEGORIES = ['Whale', 'Large Portfolio', 'Mid Portfolio', 'Small Portfolio'] as const

const WALLET_BEHAVIORS = [
  'Multi-Chain Portfolio Manager', 'Active Trader', 'Position Rotator', 'Swing Trader', 'Day Trader',
  'Diversified Holder', 'Conviction Holder', 'Smart Money Candidate', 'Airdrop Farmer', 'Meme Speculator',
  'Treasury Style Portfolio',
] as const

// Well-known meme-coin tickers/name fragments used only for evidence-gated
// behavior classification — no new fetches, matched against existing holdings.
const MEME_SYMBOLS = [
  'DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'BRETT', 'POPCAT',
  'MOG', 'TURBO', 'WOJAK', 'LADYS', 'SPX', 'TRUMP', 'PNUT', 'GOAT', 'NEIRO',
  'CAT', 'INU', 'ELON', 'BABYDOGE', 'DOGWIFHAT',
] as const

function detectMemeHoldings(holdings: Array<{ symbol?: string; name?: string }>): string[] {
  const hits = new Set<string>()
  for (const h of holdings) {
    const symbol = (h.symbol ?? '').toUpperCase()
    const name = (h.name ?? '').toUpperCase()
    for (const meme of MEME_SYMBOLS) {
      if (symbol === meme || symbol.includes(meme) || name.includes(meme)) {
        hits.add(symbol || meme)
        break
      }
    }
  }
  return Array.from(hits)
}

const GRADE_COLORS: Record<string, string> = {
  'A+': 'emerald', A: 'green', B: 'teal', C: 'yellow', D: 'orange', F: 'red',
}

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

function categoryForValue(totalValueUsd: number): typeof WALLET_CATEGORIES[number] {
  if (totalValueUsd >= 250000) return 'Whale'
  if (totalValueUsd >= 50000) return 'Large Portfolio'
  if (totalValueUsd >= 5000) return 'Mid Portfolio'
  return 'Small Portfolio'
}

export function computeWalletProfile(snapshot: WalletSnapshot): WalletProfile {
  const reasons: string[] = []
  const signals: string[] = []
  const strengths: string[] = []
  const weaknesses: string[] = []

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
  const behaviorCtx = snapshot.walletBehavior
  const historicalCoverage = snapshot.walletHistoricalCoverageSummary

  const closedLots = tradeStats?.closedLots ?? 0
  const uniqueTokensTraded = tradeStats?.uniqueTokensTraded ?? 0
  const turnoverRatio = closedLots > 0 ? uniqueTokensTraded / closedLots : 0
  const avgHoldHours = tradeStats?.avgHoldingTimeSeconds != null ? tradeStats.avgHoldingTimeSeconds / 3600 : null
  const winRatePercent = tradeStats?.winRatePercent ?? null
  const activeDays = behaviorCtx?.activeDays ?? null
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
    Boolean(behaviorCtx && behaviorCtx.status !== 'unavailable'),
  ]
  const evidenceCoverage = Math.round((coverageChecks.filter(Boolean).length / coverageChecks.length) * 100)

  const stablecoinExposurePercent = facts?.summary?.stablecoinExposurePercent ?? null
  const memeHits = detectMemeHoldings(holdings as Array<{ symbol?: string; name?: string }>)

  // --- Evidence coverage V2: portfolio and trading confidence are derived from
  // independent evidence pools so weak trade history never drags down a wallet's
  // already-verified portfolio data, and vice versa. ---
  const verifiedEvidence: string[] = []
  const partialEvidence: string[] = []
  const missingEvidence: string[] = []

  if (holdingsCount > 0) verifiedEvidence.push('Holdings')
  else missingEvidence.push('Holdings')

  if (totalValueUsd > 0) verifiedEvidence.push('Portfolio value')
  else missingEvidence.push('Portfolio value')

  if (chainCount > 0) verifiedEvidence.push('Chain exposure')
  else partialEvidence.push('Chain exposure')

  if (facts?.status === 'ok') verifiedEvidence.push('Token balances')
  else if (facts?.status === 'partial') partialEvidence.push('Token balances')
  else missingEvidence.push('Token balances')

  const portfolioChecks: Array<boolean> = [holdingsCount > 0, totalValueUsd > 0, Boolean(facts && facts.status !== 'open_check')]
  const portfolioScore = portfolioChecks.filter(Boolean).length / portfolioChecks.length
  const portfolioConfidence: 'low' | 'medium' | 'high' = portfolioScore >= 0.99 ? 'high' : portfolioScore >= 0.5 ? 'medium' : 'low'

  if (behaviorCtx?.status === 'ok') verifiedEvidence.push('Historical activity')
  else if (behaviorCtx?.status === 'partial') partialEvidence.push('Historical activity')
  else missingEvidence.push('Historical activity')

  if (estimatedPnl?.status === 'ok') verifiedEvidence.push('Cost basis')
  else if (estimatedPnl?.status === 'partial') partialEvidence.push('Cost basis')
  else missingEvidence.push('Cost basis')

  if (lotSummary?.status === 'ok') verifiedEvidence.push('Trade reconstruction')
  else if (lotSummary?.status === 'partial') partialEvidence.push('Trade reconstruction')
  else missingEvidence.push('Trade reconstruction')

  if (tradeStats?.status === 'ok') verifiedEvidence.push('Swap attribution')
  else if (tradeStats?.status === 'partial') partialEvidence.push('Swap attribution')
  else missingEvidence.push('Swap attribution')

  if (tradeStats?.status === 'ok' && (tradeStats?.closedLots ?? 0) > 0) verifiedEvidence.push('Closed-lot attribution')
  else if (tradeStats?.status === 'partial') partialEvidence.push('Closed-lot attribution')
  else missingEvidence.push('Closed-lot attribution')

  if (historicalCoverage?.status === 'ok') verifiedEvidence.push('Historical recovery')
  else if (historicalCoverage?.status === 'partial') partialEvidence.push('Historical recovery')
  else missingEvidence.push('Historical recovery')

  if (estimatedPnl?.confidence === 'high') verifiedEvidence.push('PnL confidence')
  else if (estimatedPnl?.confidence === 'medium' || estimatedPnl?.confidence === 'low') partialEvidence.push('PnL confidence')
  else missingEvidence.push('PnL confidence')

  const tradingChecks: Array<boolean> = [
    Boolean(tradeStats && tradeStats.status === 'ok'),
    Boolean(lotSummary && lotSummary.status === 'ok'),
    Boolean(estimatedPnl && estimatedPnl.status === 'ok'),
    Boolean(historicalCoverage && historicalCoverage.status === 'ok'),
  ]
  const tradingScore = tradingChecks.filter(Boolean).length / tradingChecks.length
  const tradingConfidence: 'low' | 'medium' | 'high' = tradingScore >= 0.75 ? 'high' : tradingScore >= 0.4 ? 'medium' : 'low'

  const walletEvidenceCoverage: WalletEvidenceCoverage = {
    portfolioConfidence,
    tradingConfidence,
    verifiedEvidence,
    partialEvidence,
    missingEvidence,
  }

  const hasMeaningfulTradeHistory = closedLots >= 3 && tradeStats?.economicSignificance === 'meaningful'
  const hasAnyHoldings = holdingsCount > 0

  if (!hasAnyHoldings) {
    reasons.push('No priced holdings available for this wallet — cannot classify or score.')
  }

  // --- Category: portfolio size only, always assignable from totalValue ---
  const category = hasAnyHoldings ? categoryForValue(totalValueUsd) : null
  if (category) {
    signals.push(`Category "${category}": portfolio value $${Math.round(totalValueUsd).toLocaleString()}.`)
  }

  // --- Behavior: evidence-gated classification, never defaults to a "missing evidence" guess ---
  type Candidate = { behavior: typeof WALLET_BEHAVIORS[number]; weight: number; reason: string }
  const candidates: Candidate[] = []

  if (chainCount >= 4 && totalValueUsd >= 50000 && concentrationLabel !== 'high') {
    candidates.push({
      behavior: 'Multi-Chain Portfolio Manager',
      weight: 60 + Math.min(30, chainCount * 5),
      reason: `Holdings spread across ${chainCount} chains with a $${Math.round(totalValueUsd).toLocaleString()} portfolio and non-concentrated positioning.`,
    })
  }

  if (hasMeaningfulTradeHistory) {
    if (avgHoldHours != null && avgHoldHours < 6 && (tradesPerActiveDay ?? 0) >= 1) {
      candidates.push({ behavior: 'Day Trader', weight: 60 + Math.min(40, (tradesPerActiveDay ?? 0) * 10), reason: `Average hold time ${avgHoldHours.toFixed(1)}h with ${(tradesPerActiveDay ?? 0).toFixed(1)} trades/active day.` })
    } else if (avgHoldHours != null && avgHoldHours >= 24 && avgHoldHours < 24 * 30) {
      candidates.push({ behavior: 'Swing Trader', weight: 50 + Math.min(30, turnoverRatio * 30), reason: `Average hold time ${(avgHoldHours / 24).toFixed(1)} days with ${uniqueTokensTraded} unique tokens traded.` })
    }

    if (turnoverRatio >= 0.6 && holdingsCount > 0 && concentrationLabel === 'high') {
      candidates.push({ behavior: 'Meme Speculator', weight: 50 + turnoverRatio * 40, reason: `High position concentration (${concentrationLabel}) combined with high token turnover (${(turnoverRatio * 100).toFixed(0)}%).` })
    }
    if (closedLots >= 8 && turnoverRatio >= 0.4) {
      candidates.push({ behavior: 'Position Rotator', weight: 45 + Math.min(35, closedLots), reason: `${closedLots} closed lots across ${uniqueTokensTraded} tokens shows repeated entry/exit rotation.` })
    }

    if (closedLots > 0 && (activeDays ?? 0) > 0 && (tradesPerActiveDay ?? 0) >= 0.3 && !(avgHoldHours != null && avgHoldHours < 6)) {
      candidates.push({ behavior: 'Active Trader', weight: 40 + Math.min(40, closedLots), reason: `${closedLots} closed trades over ${activeDays} active days with ongoing portfolio activity.` })
    }

    if (winRatePercent != null && winRatePercent >= 55 && (tradeStats?.confidence === 'high' || tradeStats?.confidence === 'medium') && realizedPnlUsd != null && realizedPnlUsd > 0) {
      const weight = winRatePercent + (tradeStats?.confidence === 'high' ? 15 : 5)
      candidates.push({ behavior: 'Smart Money Candidate', weight, reason: `Win rate ${winRatePercent.toFixed(1)}% across ${closedLots} closed trades with positive realized PnL and ${tradeStats?.confidence} confidence.` })
    }
  } else if (closedLots > 0) {
    reasons.push(`Trade history present but below the meaningful-significance threshold (${tradeStats?.economicSignificanceReason ?? 'insufficient sample'}) — trading behaviors withheld.`)
  }

  if (memeHits.length >= 2 && hasAnyHoldings) {
    const topMemeHolding = facts?.summary?.topHoldings?.find((h) => memeHits.includes((h.symbol ?? '').toUpperCase()))
    const memeReason = topMemeHolding
      ? `${memeHits.join(', ')} allocation detected — ${topMemeHolding.symbol} represents ${topMemeHolding.percent.toFixed(0)}% of portfolio, meme concentration elevated.`
      : `${memeHits.join(', ')} allocation detected — meme concentration elevated.`
    candidates.push({ behavior: 'Meme Speculator', weight: 45 + Math.min(40, memeHits.length * 15), reason: memeReason })
  }

  if (stablecoinExposurePercent != null && stablecoinExposurePercent >= 60 && concentrationLabel !== 'high' && hasAnyHoldings) {
    candidates.push({
      behavior: 'Treasury Style Portfolio',
      weight: 50 + Math.min(40, stablecoinExposurePercent - 60),
      reason: `Stablecoin allocation ${stablecoinExposurePercent.toFixed(0)}%, capital preservation positioning, diversified cash exposure across ${holdingsCount} holdings.`,
    })
  }

  if (hasAnyHoldings && holdingsCount >= 5 && concentrationLabel === 'balanced') {
    candidates.push({ behavior: 'Diversified Holder', weight: 35 + Math.min(25, holdingsCount), reason: `${holdingsCount} holdings with balanced concentration across positions.` })
  }

  const topHoldingPercent = facts?.summary?.topHoldings?.[0]?.percent ?? null
  if (hasAnyHoldings && concentrationLabel === 'high' && closedLots === 0 && (activeDays ?? 0) > 30) {
    const topPart = topHoldingPercent != null ? `Top holding represents ${topHoldingPercent.toFixed(0)}% of portfolio. ` : ''
    candidates.push({ behavior: 'Conviction Holder', weight: 35 + Math.min(30, (activeDays ?? 0) / 10), reason: `${topPart}High concentration with no closed trades over ${activeDays} active days — long-term concentration pattern.` })
  } else if (avgHoldHours != null && avgHoldHours >= 24 * 90 && turnoverRatio < 0.2 && closedLots > 0) {
    const topPart = topHoldingPercent != null ? `Top holding represents ${topHoldingPercent.toFixed(0)}% of portfolio. ` : ''
    candidates.push({ behavior: 'Conviction Holder', weight: 40 + Math.min(35, (avgHoldHours / (24 * 90)) * 10), reason: `${topPart}Average hold time ${(avgHoldHours / 24).toFixed(0)} days with low realized turnover (${(turnoverRatio * 100).toFixed(0)}%).` })
  }

  if (airdropLikeTxs != null && airdropLikeTxs >= 3 && swapLikeTxs != null && airdropLikeTxs > swapLikeTxs) {
    candidates.push({ behavior: 'Airdrop Farmer', weight: 40 + Math.min(30, airdropLikeTxs), reason: `${airdropLikeTxs} claim/airdrop-like transactions detected, exceeding swap-like activity.` })
  }

  if (candidates.length === 0 && hasAnyHoldings) {
    reasons.push('Available evidence does not match any behavior heuristic with sufficient confidence — behavior withheld rather than guessed.')
  }

  candidates.sort((a, b) => b.weight - a.weight)
  const behavior = candidates[0]?.behavior ?? null
  const secondaryBehavior = candidates[1] && candidates[1].behavior !== behavior ? candidates[1].behavior : null
  if (behavior) {
    signals.push(candidates[0].reason)
    reasons.push(`Primary behavior "${behavior}": ${candidates[0].reason}`)
    strengths.push(candidates[0].reason)
  } else if (hasAnyHoldings) {
    weaknesses.push('No behavior pattern could be confirmed from available trade/activity evidence.')
  }
  if (secondaryBehavior) {
    signals.push(candidates[1].reason)
    reasons.push(`Secondary behavior "${secondaryBehavior}": ${candidates[1].reason}`)
    strengths.push(candidates[1].reason)
  }

  // --- Weighted wallet score ---
  let score: number | null = null
  let grade: string | null = null
  let profileColor: string | null = null

  const sufficientEvidence = hasAnyHoldings && evidenceCoverage >= 40

  if (!sufficientEvidence) {
    reasons.push(`Evidence coverage too low (${evidenceCoverage}%) to produce a reliable wallet score.`)
    weaknesses.push(`Evidence coverage is only ${evidenceCoverage}% — score withheld until more data is verified.`)
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
    profileColor = GRADE_COLORS[grade] ?? null

    if (diversification >= 70) strengths.push(`Diversification score ${Math.round(diversification)}/100 — positions are not overly concentrated.`)
    if (chainIntelligence >= 80) strengths.push(`Active across ${chainCount} chains, supporting broader market coverage.`)
    if (diversification < 40) weaknesses.push('Position concentration is high relative to portfolio size.')
    if (pnlQuality < 40) weaknesses.push('PnL evidence is limited or unfavorable — treat performance claims with caution.')

    signals.push(`Wallet score ${score}/100 (grade ${grade}) from portfolio quality, diversification, activity quality, PnL quality, and chain intelligence.`)
  }

  // --- Confidence: based purely on evidence coverage, never downgraded for an unlocked score ---
  let confidence: 'low' | 'medium' | 'high'
  if (evidenceCoverage >= 80) confidence = 'high'
  else if (evidenceCoverage >= 50) confidence = 'medium'
  else confidence = 'low'

  // --- Followability V2: derived from evidence quality, portfolio size, diversification,
  // and trading evidence quality — never a new evidence input, always explained. ---
  let followability: 'Low' | 'Moderate' | 'High' | null = null
  const followabilityReasons: string[] = []
  if (sufficientEvidence) {
    const diversificationScore = clampPct(
      (concentrationLabel === 'balanced' ? 80 : concentrationLabel === 'medium' ? 55 : concentrationLabel === 'high' ? 25 : 50) +
      Math.min(20, holdingsCount * 2)
    )
    const isSizable = category === 'Whale' || category === 'Large Portfolio'
    const strongTradingEvidence = walletEvidenceCoverage.tradingConfidence === 'high'

    if (behavior && walletEvidenceCoverage.portfolioConfidence === 'high' && strongTradingEvidence && (isSizable || diversificationScore >= 70)) {
      followability = 'High'
      followabilityReasons.push(`Confirmed behavior "${behavior}" with high portfolio and trading confidence.`)
      if (isSizable) followabilityReasons.push(`Portfolio size (${category}) supports follow-worthy conviction.`)
      if (diversificationScore >= 70) followabilityReasons.push(`Diversification score ${Math.round(diversificationScore)}/100 reduces single-position risk.`)
    } else if (behavior && (walletEvidenceCoverage.portfolioConfidence !== 'low' || strongTradingEvidence)) {
      followability = 'Moderate'
      followabilityReasons.push(`Behavior "${behavior}" confirmed, but evidence quality or portfolio size is not yet strong enough for high followability.`)
      followabilityReasons.push(`Portfolio confidence: ${walletEvidenceCoverage.portfolioConfidence}, trading confidence: ${walletEvidenceCoverage.tradingConfidence}.`)
    } else {
      followability = 'Low'
      followabilityReasons.push(behavior ? `Behavior "${behavior}" confirmed but evidence quality is too low to recommend following.` : 'No confirmed behavior pattern — insufficient signal to recommend following.')
    }
  }

  // --- Profile summary: analyst-quality, built from category + behavior + concentration + activity ---
  let profileSummary: string | null = null
  if (sufficientEvidence && score != null) {
    const sizePart = category === 'Whale' || category === 'Large Portfolio' ? 'Large' : category === 'Mid Portfolio' ? 'Mid-sized' : 'Small'
    const chainPart = chainCount > 1 ? `multi-chain portfolio with diversified exposure across ${chainCount} networks` : chainCount === 1 ? `single-chain portfolio on ${chainExposure[0]?.chain ?? 'one network'}` : 'portfolio'
    const rotationPart = closedLots >= 8 && turnoverRatio >= 0.4 ? 'moderate-to-active portfolio rotation' : closedLots > 0 ? 'limited but verified trading activity' : 'a low-turnover holding pattern'
    const tradeConfidencePart = tradeStats?.confidence === 'high' ? 'high trade-history confidence' : tradeStats?.confidence === 'medium' ? 'moderate trade-history confidence' : 'limited trade-history confidence'
    profileSummary = `${sizePart} ${chainPart} and ${rotationPart}. Evidence suggests ${behavior ? behavior.toLowerCase() : 'no confirmed behavior pattern'}, but ${tradeConfidencePart} remains a factor.`
    profileSummary = profileSummary.charAt(0).toUpperCase() + profileSummary.slice(1)
  }

  // --- Next action: a single deterministic recommendation derived from gaps already identified ---
  let nextAction: string | null = null
  if (!hasAnyHoldings) {
    nextAction = 'Rescan once priced holdings are available — no current evidence to act on.'
  } else if (!sufficientEvidence) {
    nextAction = 'Run a deep scan to raise evidence coverage before relying on this profile.'
  } else if (!behavior) {
    nextAction = 'Treat this wallet as size-only (category) until more trade history confirms a behavior pattern.'
  } else {
    nextAction = `Monitor for continued ${behavior.toLowerCase()} activity before treating this as a confirmed pattern.`
  }

  return {
    score,
    grade,
    profileColor,
    confidence,
    category,
    behavior,
    secondaryBehavior,
    primaryArchetype: category,
    secondaryArchetype: behavior,
    profileSummary,
    followability,
    followabilityReasons,
    strengths,
    weaknesses,
    nextAction,
    signals,
    reasons,
    evidenceCoverage,
    walletEvidenceCoverage,
  }
}
