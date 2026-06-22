import type { WalletBehavior, WalletClosedLot, WalletSnapshot } from './walletSnapshot'
import { readableTradeStyleLabel } from './walletIdentity'

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
  personality: string
  scores: { sniperScore: number; smartMoneyScore: number; rotatorScore: number; degenScore: number } | null
  summary: string
  basis: 'behavior_only' | 'pnl_verified'
  pnlUsed: boolean
  profitSkillStatus: 'not_proven' | 'integrity_invalid_not_proven' | 'unlocked'
  signals?: string[]
  limitations?: string[]
}

type PersonalityBehaviorEvidence = {
  tradeIntelStatus?: string | null
  tradeIntelLots?: number | null
  walletSideTransactions?: number | null
  swapLikeWalletTransactions?: number | null
  uniqueTokensTraded?: number | null
  repeatedTokenPatterns?: string[] | null
  primaryStyle?: string | null
  botClassification?: string | null
}

export function computeWalletPersonality(
  closedLots: WalletClosedLot[],
  walletBehavior: WalletBehavior | null,
  tradeStats: WalletTradeStatsSummary | null,
  behaviorEvidence: PersonalityBehaviorEvidence = {}
): WalletPersonalityResult {
  const missing = tradeStats?.missing ?? []
  const publicPnlStatus = tradeStats?.publicPnlStatus as string | undefined
  const pnlIntegrityInvalid = (tradeStats as any)?.pnlIntegrityStatus === 'invalid' || publicPnlStatus === 'open_check_integrity_invalid'
  const lockedByPublicEvidence = tradeStats?.readyForWalletScore !== true
    || tradeStats?.scoreUnlocked !== true
    || (tradeStats?.performanceClosedLots ?? closedLots.length) < 10
    || tradeStats?.publicWinRatePercent == null
    || missing.includes('win_rate_locked_below_threshold')
    || missing.includes('sample_size_below_win_rate_threshold')
    || ['open_check', 'near_flat_verified_sample', 'activity_only', 'missing_cost_basis', 'limited_verified_sample'].includes(publicPnlStatus ?? '')
    || pnlIntegrityInvalid
  if (closedLots.length < 3 || lockedByPublicEvidence) {
    // BEHAVIOR-ONLY-PERSONALITY: the PnL-gated path above is locked (small/partial public sample,
    // or PnL integrity failed), but tradeIntelligence may still carry strong behavior evidence
    // (lots, swap-like txs, repeated token rotation) — use that instead of defaulting to
    // "Not enough data" whenever behavior evidence is actually strong. Mirrors computeBotScore's
    // behavior-only fallback so personality and bot score never disagree about data availability.
    const tradeIntelLots = behaviorEvidence.tradeIntelLots ?? 0
    const swapLikeTxs = behaviorEvidence.swapLikeWalletTransactions ?? 0
    const walletSideTxs = behaviorEvidence.walletSideTransactions ?? 0
    const uniqueTokens = behaviorEvidence.uniqueTokensTraded ?? 0
    const repeatedPatterns = behaviorEvidence.repeatedTokenPatterns ?? []
    const tradeIntelReady = behaviorEvidence.tradeIntelStatus === 'ready' || behaviorEvidence.tradeIntelStatus === 'partial'
    const enoughBehaviorEvidence = tradeIntelReady && (tradeIntelLots >= 20 || walletSideTxs >= 50 || swapLikeTxs >= 30)
    const profitSkillStatus: WalletPersonalityResult['profitSkillStatus'] = pnlIntegrityInvalid ? 'integrity_invalid_not_proven' : 'not_proven'

    if (!enoughBehaviorEvidence) {
      return {
        personality: 'Not enough data',
        scores: null,
        summary: lockedByPublicEvidence
          ? 'Public performance sample is too small or partial to classify trading personality.'
          : 'Not enough closed-trade history yet to classify this wallet\'s trading personality.',
        basis: 'behavior_only',
        pnlUsed: false,
        profitSkillStatus,
      }
    }

    const styleLabel = readableTradeStyleLabel(behaviorEvidence.primaryStyle) ?? 'Mixed behavior'
    const botLike = behaviorEvidence.botClassification === 'Likely bot' || behaviorEvidence.botClassification === 'High-frequency bot'
    const personality = botLike ? `${styleLabel} / Bot-like Rotator` : styleLabel

    const signals: string[] = []
    if (tradeIntelLots > 0) signals.push(`${tradeIntelLots} behavior lots`)
    if (swapLikeTxs > 0) signals.push(`${swapLikeTxs} swap-like transactions`)
    if (repeatedPatterns.length > 0) signals.push(`Repeated token rotation: ${repeatedPatterns.slice(0, 5).join(', ')}`)
    if (uniqueTokens > 0) signals.push(`${uniqueTokens} unique tokens traded`)

    const profitReason = pnlIntegrityInvalid
      ? 'Profit skill is not proven because PnL integrity failed.'
      : 'Profit skill is not proven because public PnL sample is too small or partial.'
    const summary = `Strong behavior evidence from ${tradeIntelLots} behavior lots, ${swapLikeTxs} swap-like transactions, ${repeatedPatterns.length > 0 ? 'repeated token rotation, ' : ''}and ${uniqueTokens} unique tokens. ${profitReason}`

    return {
      personality,
      scores: null,
      summary,
      basis: 'behavior_only',
      pnlUsed: false,
      profitSkillStatus,
      signals,
      limitations: [profitReason],
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
      basis: 'behavior_only',
      pnlUsed: false,
      profitSkillStatus: 'not_proven',
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

  return { personality, scores, summary, basis: 'pnl_verified', pnlUsed: true, profitSkillStatus: 'unlocked' }
}

// ---------------------------------------------------------------------------
// B. Time-windowed realized PnL
// ---------------------------------------------------------------------------

export type WindowStat =
  | { realizedPnlUsd: number | null; closedLots: number; winRatePercent: number | null; winRateStatus?: 'unlocked' | 'locked_small_sample' | 'locked_integrity_invalid'; publicPnlStatus?: string; reason?: string }
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

export function computeWindowedPnl(closedLots: WalletClosedLot[], now: Date = new Date(), options?: { scoreUnlocked?: boolean; publicPnlStatus?: string; rawMatchedClosedLots?: number; integrityInvalid?: boolean }): WalletPnlWindows {
  const nowMs = now.getTime()
  const result = {} as WalletPnlWindows
  const integrityInvalid = options?.integrityInvalid === true || options?.publicPnlStatus === 'open_check_integrity_invalid'

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

    // PUBLIC-PNL-INTEGRITY-GATE: a window's realized PnL/win rate must never be shown once the
    // parent pnlIntegrityCheck is hard-invalid — these numbers are derived from the same lots the
    // integrity check flagged, so they cannot be presented as a clean public-grade read.
    if (integrityInvalid) {
      result[key] = {
        realizedPnlUsd: null,
        closedLots: inWindow.length,
        winRatePercent: null,
        winRateStatus: 'locked_integrity_invalid',
        publicPnlStatus: 'open_check_integrity_invalid',
        reason: 'PnL integrity check failed, so window PnL and win rate are locked.',
      }
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
  classification: 'Human-like' | 'Assisted / semi-automated' | 'Likely bot' | 'High-frequency bot' | 'Not enough behavior data'
  reason: string
  basis?: 'behavior_only' | 'behavior_with_public_performance'
  profitSkillStatus?: 'not_proven' | 'unlocked'
  pnlUsed: false
  signals: string[]
}

type BotBehaviorEvidence = {
  walletSideTransactions?: number | null
  swapLikeWalletTransactions?: number | null
  tradeIntelLots?: number | null
  uniqueTokensTraded?: number | null
  avgHoldingTimeSeconds?: number | null
  repeatedTokenPatterns?: string[] | null
  sameTxInboundOutboundCandidates?: number | null
  topCounterparties?: Array<{ count?: number | null }> | null
  activityWindowDays?: number | null
}

export function computeBotScore(
  closedLots: WalletClosedLot[],
  walletBehavior: WalletBehavior | null,
  tradeStats: WalletTradeStatsSummary | null,
  behaviorEvidence: BotBehaviorEvidence = {}
): WalletBotScoreResult {
  const pnlIntegrityInvalid = (tradeStats as any)?.pnlIntegrityStatus === 'invalid' || tradeStats?.publicPnlStatus === 'open_check_integrity_invalid'
  const walletSideTxs = behaviorEvidence.walletSideTransactions ?? 0
  const swapLikeTxs = behaviorEvidence.swapLikeWalletTransactions ?? 0
  const tradeIntelLots = behaviorEvidence.tradeIntelLots ?? closedLots.length
  const enoughBehaviorEvidence = tradeIntelLots >= 20 || walletSideTxs >= 50 || swapLikeTxs >= 30

  if (!enoughBehaviorEvidence) {
    return { score: null, classification: 'Not enough behavior data', reason: 'Not enough wallet-side activity or swap behavior to assess automation.', basis: pnlIntegrityInvalid ? 'behavior_only' : 'behavior_with_public_performance', profitSkillStatus: pnlIntegrityInvalid ? 'not_proven' : (tradeStats?.scoreUnlocked === true ? 'unlocked' : 'not_proven'), pnlUsed: false, signals: [] }
  }

  const n = Math.max(tradeIntelLots, closedLots.length, 1)
  const activeDays = Math.max(behaviorEvidence.activityWindowDays ?? walletBehavior?.activeDays ?? 1, 1)
  const uniqueTokens = behaviorEvidence.uniqueTokensTraded ?? tradeStats?.uniqueTokensTraded ?? new Set(closedLots.map(l => l.tokenAddress.toLowerCase())).size
  const avgHoldSeconds = behaviorEvidence.avgHoldingTimeSeconds ?? tradeStats?.avgHoldingTimeSeconds ?? mean(closedLots.map(l => l.holdingTimeSeconds).filter((v): v is number => v != null))
  const repeatedPatterns = behaviorEvidence.repeatedTokenPatterns ?? []
  const sameTxCandidates = behaviorEvidence.sameTxInboundOutboundCandidates ?? 0
  const topCounterpartyMax = Math.max(0, ...(behaviorEvidence.topCounterparties ?? []).map(c => Number(c.count ?? 0)).filter(Number.isFinite))

  const swapActivityScore = clamp((swapLikeTxs / 120) * 35 + (walletSideTxs / 180) * 15, 0, 45)
  const repeatedTokenScore = clamp(repeatedPatterns.length * 7, 0, 25)
  const avgHoldHours = avgHoldSeconds != null ? avgHoldSeconds / 3600 : null
  const holdingScore = avgHoldHours == null ? 5 : avgHoldHours < 0.25 ? 25 : avgHoldHours < 1 ? 18 : avgHoldHours < 6 ? 10 : avgHoldHours < 24 ? 3 : 0
  const counterpartyScore = clamp((topCounterpartyMax / Math.max(walletSideTxs, 1)) * 25 + (sameTxCandidates / Math.max(swapLikeTxs, 1)) * 15, 0, 20)
  const burstScore = clamp((swapLikeTxs / activeDays) * 2, 0, 15)
  const diversityReduction = uniqueTokens >= 25 ? 12 : uniqueTokens >= 15 ? 7 : 0
  const longerHoldReduction = avgHoldHours != null && avgHoldHours >= 6 ? 8 : 0

  const score = Math.round(clamp(swapActivityScore + repeatedTokenScore + holdingScore + counterpartyScore + burstScore - diversityReduction - longerHoldReduction, 0, 100))
  const classification: WalletBotScoreResult['classification'] = score >= 85 ? 'High-frequency bot' : score >= 65 ? 'Likely bot' : score >= 35 ? 'Assisted / semi-automated' : 'Human-like'

  const signals: string[] = []
  if (swapLikeTxs >= 30) signals.push(`${swapLikeTxs} swap-like wallet transactions`)
  if (walletSideTxs >= 50) signals.push(`${walletSideTxs} wallet-side transactions`)
  if (tradeIntelLots >= 20) signals.push(`${tradeIntelLots} behavior lots`)
  if (repeatedPatterns.length > 0) signals.push(`Repeated token rotation: ${repeatedPatterns.slice(0, 5).join(', ')}`)
  if (avgHoldHours != null) signals.push(`Average holding time around ${avgHoldHours.toFixed(1)}h`)
  if (topCounterpartyMax > 0) signals.push(`Repeated counterparty/router usage up to ${topCounterpartyMax} interactions`)
  if (uniqueTokens >= 15) signals.push(`${uniqueTokens} unique tokens adds diversification context`)

  const reason = `${swapLikeTxs >= 30 ? 'High swap activity' : 'Wallet-side activity'}${repeatedPatterns.length > 0 ? ' and repeated token rotation' : ''} detected. ${avgHoldHours != null && avgHoldHours >= 6 ? 'Holding times are not pure rapid-fire, so the read is moderated.' : 'Timing and rotation patterns are used for this automation read.'}`

  return {
    score,
    classification,
    reason,
    basis: pnlIntegrityInvalid ? 'behavior_only' : 'behavior_with_public_performance',
    profitSkillStatus: pnlIntegrityInvalid ? 'not_proven' : (tradeStats?.scoreUnlocked === true ? 'unlocked' : 'not_proven'),
    pnlUsed: false,
    signals,
  }
}
