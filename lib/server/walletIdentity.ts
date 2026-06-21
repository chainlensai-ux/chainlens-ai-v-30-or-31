import type { WalletSnapshot } from './walletSnapshot'

// ---------------------------------------------------------------------------
// Wallet Profile V2 — deterministic category + portfolio/trading behavior
// derived only from fields already present on WalletSnapshot (no new fetches,
// no AI, no additional provider usage).
// ---------------------------------------------------------------------------

export type ProfileConfidence = 'low' | 'medium' | 'high'

export type WalletProfile = {
  score: number | null
  grade: string | null
  profileColor: 'emerald' | 'green' | 'teal' | 'yellow' | 'orange' | 'red' | null
  confidence: ProfileConfidence
  walletCategory: string | null
  portfolioBehavior: string | null
  tradingBehavior: string | null
  portfolioConfidence: ProfileConfidence
  tradingConfidence: ProfileConfidence
  profileSummary: string | null
  followability: 'Low' | 'Moderate' | 'High' | null
  strengths: string[]
  weaknesses: string[]
  nextAction: string | null
  signals: string[]
  reasons: string[]
  evidenceCoverage: number
}

// TRADE-INTEL-WIRING: convert a tradeIntelligence.primaryStyle key into a readable profile
// label. Covers both the spec's profile-style vocabulary and the behavior-style keys actually
// emitted by walletSnapshot.tradeIntelligence. Never outputs "sniper" — behavior style is never
// a profit/skill claim. Unknown keys fall back to a safe title-case of the raw key.
export function readableTradeStyleLabel(style: string | null | undefined): string | null {
  if (!style || style === 'not_enough_data') return null
  const map: Record<string, string> = {
    // spec profile-style vocabulary
    high_speed_rotator: 'High-speed rotator',
    swing_rotator: 'Swing rotator',
    conviction_accumulator: 'Conviction accumulator',
    stablecoin_router: 'Stablecoin router',
    airdrop_farmer: 'Airdrop farmer',
    low_activity_holder: 'Low-activity holder',
    mixed_behavior: 'Mixed behavior',
    // behavior-style keys emitted by walletSnapshot.tradeIntelligence
    portfolio_rebalancer: 'Portfolio rebalancer',
    stable_quote_rotator: 'Stablecoin router',
    accumulator: 'Conviction accumulator',
    distributor: 'Distributor',
    mixed_rotator: 'Mixed behavior',
  }
  if (map[style]) return map[style]
  // Safe fallback — title-case the key, but never echo a "sniper" claim.
  if (/sniper/i.test(style)) return 'Mixed behavior'
  return style.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function gradeForScore(score: number): string {
  if (score >= 90) return 'A+'
  if (score >= 80) return 'A'
  if (score >= 70) return 'B'
  if (score >= 60) return 'C'
  if (score >= 50) return 'D'
  return 'F'
}

function colorForGrade(grade: string | null): WalletProfile['profileColor'] {
  if (grade === 'A+') return 'emerald'
  if (grade === 'A') return 'green'
  if (grade === 'B') return 'teal'
  if (grade === 'C') return 'yellow'
  if (grade === 'D') return 'orange'
  if (grade === 'F') return 'red'
  return null
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function isLikelyMemeSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase()
  if (!s) return false
  const exact = new Set(['SHIB', 'PEPE', 'KISHU', 'DOGE', 'FLOKI', 'BONK', 'WIF', 'MOG', 'TOSHI', 'BRETT', 'DEGEN', 'WOJAK', 'TURBO', 'LADYS', 'ELON', 'BABYDOGE', 'BNBTIGER'])
  if (exact.has(s)) return true
  return /DOGE|INU|SHIB|PEPE|FLOKI|BONK|WIF|MOG|CAT|FROG|TIGER|MOON|MEME/.test(s)
}

function isLargeCapSymbol(symbol: string): boolean {
  return new Set(['BTC', 'WBTC', 'ETH', 'WETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK', 'MATIC', 'POL', 'OP', 'ARB']).has(symbol.trim().toUpperCase())
}

function isYieldSymbol(symbol: string): boolean {
  return /^(A|C|Y|ST|WST|R)?(USDC|USDT|DAI|ETH|BTC)$/.test(symbol.trim().toUpperCase()) || /AAVE|COMP|MORPHO|PENDLE|VELO|AERO|CURVE|CRV|CVX|STETH|RETH|CBETH|WSTETH|SDAI|SUSDE|LP/.test(symbol.trim().toUpperCase())
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
  const summary = facts?.summary
  const chainExposure = summary?.chainExposure ?? []
  const chainCount = chainExposure.length || new Set(holdings.map((h) => h.chain).filter(Boolean)).size
  const concentrationLabel = summary?.concentrationLabel ?? null
  const stablecoinExposurePercent = summary?.stablecoinExposurePercent ?? 0
  const nativeExposurePercent = summary?.nativeExposurePercent ?? 0
  const topHoldings = summary?.topHoldings?.length ? summary.topHoldings : holdings.slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 10).map((h) => ({ symbol: h.symbol, chain: h.chain ?? 'unknown', valueUsd: h.value ?? 0, percent: totalValueUsd > 0 ? ((h.value ?? 0) / totalValueUsd) * 100 : 0 }))

  const tradeStats = snapshot.walletTradeStatsSummary
  const lotSummary = snapshot.walletLotSummary
  const estimatedPnl = snapshot.estimatedPnl
  const behaviorCtx = snapshot.walletBehavior
  const historicalCoverage = snapshot.walletHistoricalCoverageSummary

  const missingCostBasis = tradeStats?.pnlUnavailableReason === 'missing_cost_basis' || lotSummary?.pnlUnavailableReason === 'missing_cost_basis'
  const publicPnlStatus = (snapshot as any).publicPnlStatus ?? tradeStats?.publicPnlStatus
  const closedLotsForStats = tradeStats?.performanceClosedLots ?? (snapshot as any).performanceClosedLots ?? tradeStats?.publicClosedLots ?? (snapshot as any).publicClosedLots ?? 0
  const closedLots = missingCostBasis ? closedLotsForStats : closedLotsForStats
  const openLots = lotSummary?.openedLots ?? 0
  const uniqueTokensTraded = missingCostBasis || closedLotsForStats === 0 ? 0 : (tradeStats?.uniqueTokensTraded ?? 0)
  const avgHoldHours = tradeStats?.avgHoldingTimeSeconds != null ? tradeStats.avgHoldingTimeSeconds / 3600 : null
  const winRatePercent = tradeStats?.publicWinRatePercent ?? (snapshot as any).publicWinRatePercent ?? null
  const activeDays = behaviorCtx?.activeDays ?? null
  const tradesPerActiveDay = activeDays && activeDays > 0 ? closedLots / activeDays : null
  const realizedPnlUsd = tradeStats?.publicRealizedPnlUsd ?? (snapshot as any).publicRealizedPnlUsd ?? lotSummary?.realizedPnlUsd ?? null
  const unrealizedPnlUsd = estimatedPnl?.unrealizedPnlUsd ?? null

  const coverageChecks = [
    holdingsCount > 0,
    Boolean(facts && facts.status !== 'open_check'),
    Boolean(tradeStats && tradeStats.status !== 'open_check'),
    Boolean(estimatedPnl && estimatedPnl.status === 'ok'),
    Boolean(behaviorCtx && behaviorCtx.status !== 'unavailable'),
  ]
  const evidenceCoverage = Math.round((coverageChecks.filter(Boolean).length / coverageChecks.length) * 100)
  const hasHoldings = holdingsCount > 0
  const tradingLockedByPublicPnl = publicPnlStatus === 'open_check' || publicPnlStatus === 'flat_estimate_only' || publicPnlStatus === 'near_flat_verified_sample' || publicPnlStatus === 'limited_verified_sample' || publicPnlStatus === 'partial_near_flat' || tradeStats?.scoreUnlocked !== true || winRatePercent == null
  const tradeEvidenceStrong = !missingCostBasis && !tradingLockedByPublicPnl && closedLotsForStats >= 5 && tradeStats?.economicSignificance === 'meaningful'
  const tradeEvidenceWeak = !missingCostBasis && !tradingLockedByPublicPnl && closedLotsForStats >= 5 && (closedLots > 0 || uniqueTokensTraded > 0 || tradeStats?.status === 'partial')

  let walletCategory: string | null = null
  if (hasHoldings) {
    if (totalValueUsd >= 250000) walletCategory = 'Whale'
    else if (totalValueUsd >= 10000) walletCategory = 'Mid Portfolio'
    else walletCategory = 'Small Portfolio'
    signals.push(`Category "${walletCategory}": portfolio value $${Math.round(totalValueUsd).toLocaleString()} across ${holdingsCount} holdings.`)
  } else {
    reasons.push('No priced holdings available — wallet category and portfolio behavior withheld.')
  }

  type Candidate = { label: string; weight: number; reason: string; confidence: ProfileConfidence }
  const portfolioCandidates: Candidate[] = []
  const tradingCandidates: Candidate[] = []

  if (hasHoldings) {
    const memeHoldings = topHoldings.filter((h) => isLikelyMemeSymbol(h.symbol))
    const memeExposure = topHoldings.filter((h) => isLikelyMemeSymbol(h.symbol)).reduce((sum, h) => sum + (h.percent ?? 0), 0)
    const largeCapTokenExposure = topHoldings.filter((h) => isLargeCapSymbol(h.symbol)).reduce((sum, h) => sum + (h.percent ?? 0), 0)
    const nativeExposureAlreadyIncluded = topHoldings.some((h) => isLargeCapSymbol(h.symbol) && /^(eth|weth|steth|wsteth|reth|cbeth)$/i.test(h.symbol ?? ''))
    const largeCapExposure = Math.max(0, Math.min(100, largeCapTokenExposure + (nativeExposureAlreadyIncluded ? 0 : nativeExposurePercent)))
    const yieldExposure = topHoldings.filter((h) => isYieldSymbol(h.symbol)).reduce((sum, h) => sum + (h.percent ?? 0), 0)
    const largestPercent = topHoldings[0]?.percent ?? 0

    if (memeHoldings.length >= 2 || memeExposure >= 20) portfolioCandidates.push({ label: 'Meme Speculator', weight: 80 + memeHoldings.length * 5 + memeExposure, confidence: memeHoldings.length >= 3 || memeExposure >= 35 ? 'high' : 'medium', reason: `${memeHoldings.length} meme/speculative top holdings${memeExposure > 0 ? ` with ~${memeExposure.toFixed(0)}% top-holding exposure` : ''}.` })
    if (stablecoinExposurePercent >= 45) portfolioCandidates.push({ label: 'Stablecoin Heavy', weight: stablecoinExposurePercent, confidence: stablecoinExposurePercent >= 65 ? 'high' : 'medium', reason: `Stablecoin exposure is ${stablecoinExposurePercent.toFixed(0)}% of portfolio value.` })
    if (chainCount >= 3) portfolioCandidates.push({ label: 'Multi-Chain Portfolio Manager', weight: 65 + chainCount * 8, confidence: chainCount >= 4 && holdingsCount >= 10 ? 'high' : 'medium', reason: `Exposure spans ${chainCount} chains across ${holdingsCount} holdings.` })
    if (holdingsCount >= 10 && concentrationLabel === 'balanced') portfolioCandidates.push({ label: 'Diversified Holder', weight: 70 + holdingsCount, confidence: 'high', reason: `Balanced concentration with ${holdingsCount} holdings.` })
    if (largestPercent >= 55 || concentrationLabel === 'high') portfolioCandidates.push({ label: 'Conviction Holder', weight: 60 + largestPercent, confidence: largestPercent >= 70 ? 'high' : 'medium', reason: `Largest position is ${largestPercent.toFixed(0)}% and concentration is ${concentrationLabel ?? 'unknown'}.` })
    if (largeCapExposure >= 50) portfolioCandidates.push({ label: 'Large Cap Holder', weight: largeCapExposure, confidence: largeCapExposure >= 70 ? 'high' : 'medium', reason: `Large-cap/native exposure is approximately ${largeCapExposure.toFixed(0)}%.` })
    if (yieldExposure >= 25) portfolioCandidates.push({ label: 'Yield-Seeking Portfolio', weight: yieldExposure, confidence: yieldExposure >= 45 ? 'high' : 'medium', reason: `Yield/staked/LP-like symbols represent approximately ${yieldExposure.toFixed(0)}% of top holdings.` })
    if (stablecoinExposurePercent >= 25 && largeCapExposure >= 25 && holdingsCount >= 5 && (concentrationLabel === 'balanced' || concentrationLabel === 'medium')) portfolioCandidates.push({ label: 'Treasury Style Portfolio', weight: stablecoinExposurePercent + largeCapExposure, confidence: 'medium', reason: `Stablecoin plus large-cap exposure with ${concentrationLabel} concentration suggests treasury-style allocation.` })
  }

  portfolioCandidates.sort((a, b) => b.weight - a.weight)
  const portfolio = portfolioCandidates[0] ?? null
  const portfolioBehavior = portfolio?.label ?? null
  const portfolioConfidence = portfolio?.confidence ?? 'low'
  if (portfolio) {
    signals.push(`Portfolio behavior "${portfolio.label}": ${portfolio.reason}`)
    reasons.push(`Portfolio behavior assigned without requiring closed lots: ${portfolio.reason}`)
  } else if (hasHoldings) {
    reasons.push('Portfolio behavior not classified — holdings, concentration, chain, stablecoin, meme, yield, and large-cap evidence did not meet a supported behavior threshold.')
  }

  if (tradeEvidenceStrong) {
    if (winRatePercent != null && winRatePercent >= 55 && (tradeStats?.confidence === 'high' || tradeStats?.confidence === 'medium')) tradingCandidates.push({ label: 'Smart Money Candidate', weight: winRatePercent + (tradeStats.confidence === 'high' ? 10 : 0), confidence: tradeStats.confidence, reason: `Win rate ${winRatePercent.toFixed(1)}% across ${closedLots} meaningful closed trades.` })
    if (avgHoldHours != null && avgHoldHours < 24 && (tradesPerActiveDay ?? 0) >= 2) tradingCandidates.push({ label: 'Day Trader', weight: 85, confidence: 'high', reason: `Average hold time ${avgHoldHours.toFixed(1)}h with ${(tradesPerActiveDay ?? 0).toFixed(1)} trades/active day.` })
    if (avgHoldHours != null && avgHoldHours < 72 && (tradesPerActiveDay ?? 0) >= 0.5) tradingCandidates.push({ label: 'Active Trader', weight: 75, confidence: 'medium', reason: `Closed-lot cadence shows frequent realized trading across ${closedLots} lots.` })
    if (avgHoldHours != null && avgHoldHours >= 24 && avgHoldHours < 24 * 30) tradingCandidates.push({ label: 'Swing Trader', weight: 70, confidence: 'medium', reason: `Average hold time ${(avgHoldHours / 24).toFixed(1)} days across ${closedLots} closed trades.` })
    if (uniqueTokensTraded >= 5 && openLots > 0) tradingCandidates.push({ label: 'Position Rotator', weight: 65 + uniqueTokensTraded, confidence: 'medium', reason: `${uniqueTokensTraded} unique traded tokens with ${openLots} currently open lots.` })
  } else if (tradeEvidenceWeak) {
    reasons.push(`Trading behavior not classified — trade evidence exists but is weak (${tradeStats?.economicSignificanceReason ?? 'insufficient meaningful closed-lot sample'}).`)
  } else {
    reasons.push('Trading behavior not classified — not enough verified trade data is available in the current snapshot.')
  }

  tradingCandidates.sort((a, b) => b.weight - a.weight)
  const trading = tradingCandidates[0] ?? null
  let tradingBehavior = trading?.label ?? null
  let tradingConfidence: ProfileConfidence = trading?.confidence ?? 'low'
  if (trading) {
    signals.push(`Trading behavior "${trading.label}": ${trading.reason}`)
    reasons.push(`Trading behavior assigned from verified trade evidence: ${trading.reason}`)
  }

  // TRADE-INTEL-WIRING: behavior/style intelligence is separate from profit skill. When the
  // tradeIntelligence layer has enough verified behavior lots (>=10) and is partial/ready, use
  // its readable style label + confidence for the *behavior* read even if the legacy
  // profit-evidence path stayed null (e.g. near-flat public PnL). This never asserts profit:
  // followability and profit-skill copy below stay gated on public PnL honesty.
  const tradeIntel = (snapshot as any).tradeIntelligence as
    | { status?: string; tradeIntelLots?: number; verifiedPnlLots?: number; rawMatchedLots?: number; confidence?: ProfileConfidence; primaryStyle?: string }
    | undefined
  const tradeIntelUnlocked = Boolean(tradeIntel) && (tradeIntel!.status === 'partial' || tradeIntel!.status === 'ready') && (tradeIntel!.tradeIntelLots ?? 0) >= 10
  const tradeIntelStyleLabel = tradeIntelUnlocked ? readableTradeStyleLabel(tradeIntel!.primaryStyle) : null
  if (tradeIntelUnlocked && tradeIntelStyleLabel) {
    tradingBehavior = tradeIntelStyleLabel
    tradingConfidence = tradeIntel!.confidence ?? tradingConfidence
    const lots = tradeIntel!.tradeIntelLots ?? 0
    const raw = tradeIntel!.rawMatchedLots ?? 0
    const swapCandidates = (snapshot as any).walletSwapSummary?.swapCandidateEvents ?? (snapshot as any).walletSwapSummary?.swapCandidateCount ?? 0
    reasons.push(`Trading style classified from ${lots} verified behavior lots.`)
    signals.push(`Trade intelligence ${tradeIntel!.status}: ${lots} behavior lots, ${raw} raw matched lots, ${swapCandidates} swap candidates.`)
  }

  let score: number | null = null
  let grade: string | null = null
  let confidence: ProfileConfidence = 'low'
  const sufficientEvidence = hasHoldings && evidenceCoverage >= 40
  if (!sufficientEvidence) {
    reasons.push(`Evidence coverage too low (${evidenceCoverage}%) to produce a reliable wallet score.`)
    weaknesses.push(`Evidence coverage is only ${evidenceCoverage}% — score withheld until more data is verified.`)
  } else {
    const portfolioQuality = clampPct(totalValueUsd > 0 ? Math.min(100, Math.log10(totalValueUsd + 1) * 20) : 0)
    const diversification = clampPct((concentrationLabel === 'balanced' ? 80 : concentrationLabel === 'medium' ? 55 : concentrationLabel === 'high' ? 25 : 50) + Math.min(20, holdingsCount * 2))
    const activityQuality = clampPct(closedLots === 0 ? 40 : tradeStats?.economicSignificance === 'meaningful' ? 60 + Math.min(40, closedLots * 2) : 30)
    const pnlQuality = clampPct(estimatedPnl?.status !== 'ok' ? 30 : (winRatePercent ?? 50) * 0.7 + ((realizedPnlUsd ?? 0) + (unrealizedPnlUsd ?? 0) > 0 ? 30 : 10))
    const chainIntelligence = clampPct(40 + Math.min(60, chainCount * 20))
    score = Math.round(clampPct(portfolioQuality * 0.25 + diversification * 0.15 + activityQuality * 0.20 + pnlQuality * 0.25 + chainIntelligence * 0.15))
    grade = gradeForScore(score)
    const highConfidenceInputs = [portfolioConfidence === 'high', tradingConfidence === 'high', estimatedPnl?.status === 'ok' && estimatedPnl?.confidence === 'high', historicalCoverage?.coverageLevel === 'medium' || historicalCoverage?.coverageLevel === 'deep'].filter(Boolean).length
    if (portfolioConfidence === 'high' && evidenceCoverage >= 60 && highConfidenceInputs >= 1) confidence = 'high'
    else if (portfolioBehavior || evidenceCoverage >= 55) confidence = 'medium'
    else confidence = 'low'
    signals.push(`Wallet score ${score}/100 (grade ${grade}) from portfolio quality, diversification, activity quality, PnL quality, and chain intelligence.`)
  }

  if (portfolioBehavior) strengths.push(`${portfolioBehavior} supported by current holdings/portfolio evidence.`)
  if (tradingBehavior) strengths.push(`${tradingBehavior} supported by closed-lot/trade evidence.`)
  if (chainCount >= 3) strengths.push(`Multi-chain exposure across ${chainCount} chains.`)
  if (tradingConfidence === 'low') weaknesses.push('Trading confidence is low because meaningful verified trade evidence is missing or weak.')
  if (!portfolioBehavior) weaknesses.push('Portfolio behavior is unclassified because supported portfolio thresholds were not met.')
  if (concentrationLabel === 'high') weaknesses.push('Portfolio concentration is high.')
  if (!hasHoldings) weaknesses.push('No priced holdings were available in this snapshot.')

  // PROFIT-HONESTY: a readable trade style does NOT mean the wallet's profit skill is proven.
  // Keep followability Low whenever public PnL is near-flat/limited, PnL integrity is invalid,
  // or realized PnL is ~zero — never upgrade to Moderate/High or imply the wallet is copyable.
  const pnlIntegrityStatus = (tradeStats as any)?.pnlIntegrityStatus ?? snapshot.pnlIntegrityCheck?.status ?? null
  const realizedNearZero = realizedPnlUsd == null || Math.abs(realizedPnlUsd) < 1
  const profitNotProven = tradingLockedByPublicPnl || pnlIntegrityStatus === 'invalid' || publicPnlStatus === 'near_flat_verified_sample' || realizedNearZero
  const followability: WalletProfile['followability'] = profitNotProven ? 'Low' : tradingBehavior && tradingConfidence !== 'low' && score != null && score >= 70 ? 'High' : portfolioBehavior && score != null && score >= 55 ? 'Moderate' : 'Low'
  const nextAction = (tradeIntelUnlocked && tradingBehavior && profitNotProven)
    ? 'Use for behavior/style read only; profit skill is not proven because public PnL is near-flat and integrity checks are limited.'
    : tradingLockedByPublicPnl
      ? 'Use for portfolio read only; trading evidence is locked until more public-grade trades are available.'
      : tradingConfidence === 'low'
        ? 'Use this profile for portfolio read only; wait for stronger trade/PnL evidence before copying trades.'
        : 'Monitor future realized trades and position changes before following.'

  const profileSummary = sufficientEvidence
    ? `${chainCount > 1 ? `Multi-chain (${chainCount} chains)` : 'Single-chain'} ${walletCategory?.toLowerCase() ?? 'wallet'}${portfolioBehavior ? ` with ${portfolioBehavior.toLowerCase()} portfolio behavior` : ''}${tradingBehavior ? ` and ${tradingBehavior.toLowerCase()} trading behavior` : '; trading behavior not yet classified'}.`
    : null

  return {
    score,
    grade,
    profileColor: colorForGrade(grade),
    confidence,
    walletCategory,
    portfolioBehavior,
    tradingBehavior,
    portfolioConfidence,
    tradingConfidence,
    profileSummary,
    followability,
    strengths,
    weaknesses,
    nextAction,
    signals,
    reasons,
    evidenceCoverage,
  }
}
