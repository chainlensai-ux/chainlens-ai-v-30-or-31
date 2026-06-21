import type { WalletBehavior, WalletClosedLot, WalletSnapshot } from './walletSnapshot'

type WalletTradeStatsSummary = WalletSnapshot['walletTradeStatsSummary']

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

// Population standard deviation (denominator = n, not n-1) — used for "how spread out are these
// returns/sizes/gaps" descriptive stats, not for inferential statistics.
function popStdDev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values) ?? 0
  const variance = mean(values.map(v => (v - m) ** 2)) ?? 0
  return Math.sqrt(variance)
}

// ---------------------------------------------------------------------------
// A. Wallet personality classification
// ---------------------------------------------------------------------------

export type WalletPersonalityResult = {
  personality: 'Sniper' | 'Smart Money' | 'Rotator' | 'Degen' | 'Not enough data'
  scores: { sniperScore: number; smartMoneyScore: number; rotatorScore: number; degenScore: number } | null
  summary: string
}

export function computeWalletPersonality(
  closedLots: WalletClosedLot[],
  walletBehavior: WalletBehavior | null,
  tradeStats: WalletTradeStatsSummary | null
): WalletPersonalityResult {
  const missing = tradeStats?.missing ?? []
  const publicPnlStatus = tradeStats?.publicPnlStatus as string | undefined
  const lockedByPublicEvidence = tradeStats?.readyForWalletScore !== true
    || tradeStats?.scoreUnlocked !== true
    || (tradeStats?.performanceClosedLots ?? closedLots.length) < 10
    || tradeStats?.publicWinRatePercent == null
    || missing.includes('win_rate_locked_below_threshold')
    || missing.includes('sample_size_below_win_rate_threshold')
    || ['open_check', 'near_flat_verified_sample', 'activity_only', 'missing_cost_basis', 'limited_verified_sample'].includes(publicPnlStatus ?? '')
    || (tradeStats as any)?.pnlIntegrityStatus === 'invalid'
  if (closedLots.length < 3 || lockedByPublicEvidence) {
    return {
      personality: 'Not enough data',
      scores: null,
      summary: lockedByPublicEvidence
        ? 'Public performance sample is too small or partial to classify trading personality.'
        : 'Not enough closed-trade history yet to classify this wallet\'s trading personality.',
    }
  }

  // PNL-SAFETY-FIX-7: verified closed lots that are all dust (no economically meaningful trade
  // value behind them) are real evidence, but not enough to classify trading behavior — a handful
  // of cents of closed cost basis should never drive a Rotator/Sniper/Smart Money/Degen label.
  const meaningfulClosedLots = tradeStats?.meaningfulClosedLots ?? closedLots.length
  if (meaningfulClosedLots === 0 || tradeStats?.economicSignificance === 'micro_sample') {
    return {
      personality: 'Not enough data',
      scores: null,
      summary: 'Verified closed trades exist, but are too small (dust-sized) to classify this wallet\'s trading personality.',
    }
  }

  const n = tradeStats?.verifiedClosedLots ?? tradeStats?.closedLotsForStats ?? closedLots.length
  const excluded = (tradeStats?.estimateOnlyClosedLots ?? 0) + (tradeStats?.syntheticClosedLotsExcluded ?? 0)

  // Average holding time in hours across lots that have a known holding time. If none have a
  // known holding time, fall back to 24h (treated as "neutral / held a day").
  const holdTimes = closedLots.map(l => l.holdingTimeSeconds).filter((v): v is number => v != null)
  const avgHoldHours = holdTimes.length > 0 ? (mean(holdTimes) ?? 0) / 3600 : 24

  const winningCount = closedLots.filter(l => l.realizedPnlUsd > 0).length
  const winRate = tradeStats?.winRatePercent ?? (winningCount / n) * 100

  const pnlPercents = closedLots.map(l => l.realizedPnlPercent).filter((v): v is number => v != null)
  const pnlStdDev = popStdDev(pnlPercents)

  const uniqueTokens = tradeStats?.uniqueTokensTraded ?? new Set(closedLots.map(l => l.tokenAddress.toLowerCase())).size
  const rotationRatio = n > 0 ? uniqueTokens / n : 0

  const activeDays = Math.max(walletBehavior?.activeDays ?? 1, 1)
  const tradesPerActiveDay = n / activeDays

  // shortHoldFactor: 100 = instant flips (avgHoldHours ~ 0), 0 = held >= 24h on average.
  const shortHoldFactor = clamp(100 - (avgHoldHours / 24) * 100, 0, 100)
  // sniperScore: weighted toward fast flips, with win rate as a secondary signal.
  const sniperScore = Math.round(0.6 * shortHoldFactor + 0.4 * clamp(winRate ?? 50, 0, 100))

  // consistencyFactor: lower PnL% variance => more consistent/deliberate trading.
  const consistencyFactor = clamp(100 - pnlStdDev, 0, 100)
  const avgReturnPct = tradeStats?.avgReturnPercentPerClosedLot ?? mean(pnlPercents) ?? 0
  // smartMoneyScore: dominated by win rate, with consistency and average return as supporting signals.
  const smartMoneyScore = Math.round(0.5 * clamp(winRate ?? 0, 0, 100) + 0.3 * consistencyFactor + 0.2 * clamp(avgReturnPct, 0, 100))

  // rotatorScore: blends how many distinct tokens are traded (relative to trade count) with
  // how often the wallet trades per active day.
  const rotatorScore = Math.round(0.5 * (rotationRatio * 100) + 0.5 * clamp(tradesPerActiveDay * 10, 0, 100))

  // degenScore: high PnL variance plus a low win rate suggests high-risk, inconsistent bets.
  const degenScore = Math.round(0.6 * clamp(pnlStdDev, 0, 100) + 0.4 * clamp(100 - (winRate ?? 50), 0, 100))

  const scores = { sniperScore, smartMoneyScore, rotatorScore, degenScore }

  // Tie-break order: Sniper > Smart Money > Rotator > Degen.
  const ranked: Array<[WalletPersonalityResult['personality'], number]> = [
    ['Sniper', sniperScore],
    ['Smart Money', smartMoneyScore],
    ['Rotator', rotatorScore],
    ['Degen', degenScore],
  ]
  let personality: WalletPersonalityResult['personality'] = ranked[0][0]
  let best = ranked[0][1]
  for (const [name, score] of ranked.slice(1)) {
    if (score > best) {
      personality = name
      best = score
    }
  }

  const winRateStr = winRate != null ? winRate.toFixed(1) : 'N/A'
  let summary: string
  switch (personality) {
    case 'Sniper':
      summary = `This wallet closed ${n} trades with an average holding time of ${avgHoldHours.toFixed(1)}h and a ${winRateStr}% win rate, suggesting fast, opportunistic entries and exits.`
      break
    case 'Smart Money':
      summary = `This wallet closed ${n} trades with a ${winRateStr}% win rate and consistent returns (±${pnlStdDev.toFixed(1)}% variance), suggesting deliberate, evidence-based entries rather than reactive trading.`
      break
    case 'Rotator':
      summary = `This wallet rotated through ${uniqueTokens} unique tokens across ${n} closed trades (about ${tradesPerActiveDay.toFixed(2)} trades/active day), suggesting frequent reallocation rather than holding a fixed set of positions.`
      break
    case 'Degen':
      summary = `This wallet closed ${n} trades with high PnL variance (±${pnlStdDev.toFixed(1)}%) and a ${winRateStr}% win rate, suggesting high-risk, inconsistent position sizing and exits.`
      break
    default:
      summary = 'Not enough closed-trade history yet to classify this wallet\'s trading personality.'
  }

  if (excluded > 0) summary += ` Based on ${n} verified trades; ${excluded} matched lots excluded.`

  return { personality, scores, summary }
}

// ---------------------------------------------------------------------------
// B. Time-windowed realized PnL
// ---------------------------------------------------------------------------

export type WindowStat =
  | { realizedPnlUsd: number; closedLots: number; winRatePercent: number | null; winRateStatus?: 'unlocked' | 'locked_small_sample'; publicPnlStatus?: string }
  | { closedLots: 0; fallback: string }

export type WalletPnlWindows = {
  '3d': WindowStat
  '7d': WindowStat
  '30d': WindowStat
}

const WINDOW_DEFS: Array<{ key: keyof WalletPnlWindows; days: number }> = [
  { key: '3d', days: 3 },
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
]

export function computeWindowedPnl(closedLots: WalletClosedLot[], now: Date = new Date(), options?: { scoreUnlocked?: boolean; publicPnlStatus?: string; rawMatchedClosedLots?: number }): WalletPnlWindows {
  const nowMs = now.getTime()
  const result = {} as WalletPnlWindows

  for (const { key, days } of WINDOW_DEFS) {
    const windowMs = days * 24 * 60 * 60 * 1000
    const inWindow = closedLots.filter(l => {
      const closedMs = new Date(l.closedAt).getTime()
      return Number.isFinite(closedMs) && closedMs >= nowMs - windowMs
    })

    if (inWindow.length === 0) {
      result[key] = { closedLots: 0, fallback: (options?.rawMatchedClosedLots ?? 0) > 0 ? `No verified public-grade closed trades in the last ${days}d.` : `No closed trades in the last ${days}d.` }
      continue
    }

    const realizedPnlUsd = inWindow.reduce((sum, l) => sum + l.realizedPnlUsd, 0)
    const winners = inWindow.filter(l => l.realizedPnlUsd > 0).length
    const winRateUnlocked = options?.scoreUnlocked === true && inWindow.length >= 10
    const winRatePercent = winRateUnlocked ? Math.round((100 * winners / inWindow.length) * 10) / 10 : null

    result[key] = {
      realizedPnlUsd,
      closedLots: inWindow.length,
      winRatePercent,
      winRateStatus: winRateUnlocked ? 'unlocked' : 'locked_small_sample',
      publicPnlStatus: options?.publicPnlStatus ?? (winRateUnlocked ? 'ok' : 'limited_verified_sample'),
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// C. Bot detection score
// ---------------------------------------------------------------------------

export type WalletBotScoreResult = {
  score: number | null
  classification: 'Likely bot' | 'Possibly semi-automated' | 'Likely human/manual' | 'Not enough data'
  reason: string
}

export function computeBotScore(
  closedLots: WalletClosedLot[],
  walletBehavior: WalletBehavior | null,
  tradeStats: WalletTradeStatsSummary | null
): WalletBotScoreResult {
  if (tradeStats?.scoreUnlocked !== true || (tradeStats as any)?.pnlIntegrityStatus === 'invalid') {
    return { score: null, classification: 'Not enough data', reason: 'Bot/automation read is locked until enough performance-grade trades pass public evidence checks.' }
  }

  if (closedLots.length < 3) {
    return { score: null, classification: 'Not enough data', reason: 'Not enough trade history to assess automation.' }
  }

  const n = tradeStats?.verifiedClosedLots ?? tradeStats?.closedLotsForStats ?? closedLots.length
  const excluded = (tradeStats?.estimateOnlyClosedLots ?? 0) + (tradeStats?.syntheticClosedLotsExcluded ?? 0)
  const activeDays = Math.max(walletBehavior?.activeDays ?? 1, 1)
  const tradesPerActiveDay = n / activeDays

  const uniqueTokens = tradeStats?.uniqueTokensTraded ?? new Set(closedLots.map(l => l.tokenAddress.toLowerCase())).size
  const rotationRatio = n > 0 ? uniqueTokens / n : 0

  // frequencyScore: trades per active day. More frequent trading => more bot-like.
  const frequencyScore = clamp(tradesPerActiveDay * 15, 0, 100)

  // repetitionScore: low unique-token ratio (same pairs traded repeatedly) => more bot-like.
  const repetitionScore = clamp(100 - rotationRatio * 100, 0, 100)

  // sizeConsistencyScore: low variance (coefficient of variation) in trade size => more bot-like.
  const sizes = closedLots.map(l => l.amountClosed ?? l.costBasisUsd ?? 0)
  const sizeMean = mean(sizes) ?? 0
  const sizeStdDev = popStdDev(sizes)
  const sizeCv = sizeMean !== 0 ? sizeStdDev / Math.abs(sizeMean) : 0
  const sizeConsistencyScore = clamp(100 - sizeCv * 100, 0, 100)

  // timingRegularityScore: low variance (coefficient of variation) in gaps between consecutive
  // closes => regular intervals => more bot-like.
  const sortedCloseTimes = closedLots
    .map(l => new Date(l.closedAt).getTime())
    .filter(t => Number.isFinite(t))
    .sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < sortedCloseTimes.length; i++) {
    gaps.push(sortedCloseTimes[i] - sortedCloseTimes[i - 1])
  }
  const gapMean = mean(gaps) ?? 0
  const gapStdDev = popStdDev(gaps)
  const gapCv = gapMean !== 0 ? gapStdDev / Math.abs(gapMean) : 0
  const timingRegularityScore = gaps.length > 0 ? clamp(100 - gapCv * 100, 0, 100) : 0

  // fastFlipScore: fraction of lots held for less than 5 minutes => more bot-like.
  const fastFlips = closedLots.filter(l => l.holdingTimeSeconds != null && l.holdingTimeSeconds < 300).length
  const fastFlipScore = (fastFlips / n) * 100

  // humanNoiseRaw: stablecoin activity and a wider variety of top tokens suggest a human managing
  // a diversified portfolio rather than a single-purpose bot. Higher humanNoiseRaw => lower bot score.
  const humanNoiseRaw = clamp(
    (walletBehavior?.stablecoinActivity ? 30 : 0) + (walletBehavior?.topTokens?.length ?? 0) * 5,
    0,
    100
  )

  const botSignalScore =
    0.20 * frequencyScore +
    0.20 * repetitionScore +
    0.20 * sizeConsistencyScore +
    0.20 * timingRegularityScore +
    0.10 * fastFlipScore +
    0.10 * (100 - humanNoiseRaw)

  const score = Math.round(clamp(botSignalScore, 0, 100))

  let classification: WalletBotScoreResult['classification']
  if (score >= 80) classification = 'Likely bot'
  else if (score >= 60) classification = 'Possibly semi-automated'
  else classification = 'Likely human/manual'

  // Pick a dominant-signal explanation.
  let reason: string
  if (score >= 60 && (frequencyScore >= 60 || repetitionScore >= 60) && timingRegularityScore >= 50) {
    reason = `High trade frequency (${tradesPerActiveDay.toFixed(1)}/day) and repetitive token pairs (${uniqueTokens} unique of ${n} trades) with regular timing point to automated execution.`
  } else if (score >= 60 && fastFlipScore >= 40) {
    reason = `A large share of trades (${fastFlipScore.toFixed(0)}%) were closed in under 5 minutes, consistent with automated execution.`
  } else if (score >= 60) {
    reason = `Trade sizing and timing show low variance, which is consistent with scripted or semi-automated execution.`
  } else {
    reason = 'Trade sizes and timing show natural variance consistent with manual decisions.'
  }

  return { score, classification, reason }
}
