// lib/engine/modules/smartMoney/computeSmartMoneyScore.ts — Smart Money Score, rebuilt.
//
// AUDIT, DISCLOSED (this task's own root-cause trace — production evidence: score 42/100, PnL
// component 0, Behavior 60, Personality 50, Chain Activity 68, Risk 37, Signals 35, wallet has 219
// FIFO closed lots but only 10 fully priced):
//
//   OLD FORMULA (deleted below): 0.30*pnlScore + 0.25*behaviorScore + 0.20*personalityScore +
//   0.15*chainActivityScore + 0.10*riskScore + 0.10*signalsScore, where:
//     - pnlScore defaulted to a fabricated NEUTRAL MIDPOINT of 50 whenever pnlStatus wasn't
//       'ok'/'partial' — not the reported 0, but still a fully-weighted (30%) invented number with
//       zero verified evidence behind it. (The reported "PnL 0" in production likely reflects
//       pnlV2.realizedPnlUsd/unrealizedPnlUsd both being real 0s from the SEPARATE, unwired PnlV2
//       engine — a different bug from this module, not fixed here per this task's own scope.)
//     - personalityScore (20% weight) was PersonalityV2.riskAppetite/pnlBehavior/
//       activityConsistency — purely descriptive labels, never a measurement of realized trading
//       skill. A wallet could gain 40 raw points here from personality alone.
//     - chainActivityScore (15% weight) was literally an average of a per-chain 'activityLevel'
//       enum (high=100, medium=65, low=35, dust=10) — RAW ACTIVITY, explicitly banned as a
//       materially-score-raising input by this task.
//     - signalsScore (10% weight) counted generic behavioral signal TYPES, not verified outcomes.
//     - riskScore (10% weight) was a real risk measurement, but LOW risk alone could still combine
//       with 3 purely-descriptive categories (personality/chainActivity/signals = 45% combined
//       weight) to produce a score that implies "smart money" from a wallet with ZERO proven
//       trading skill.
//     - No evidence-confidence concept existed at all: a wallet with 10/219 priced lots (4.57%
//       coverage) and a wallet with 219/219 priced lots would compute through the exact same
//       formula with the exact same apparent authority.
//
//   CONCLUSION: 3 of 6 components (personality, chain activity, signals = 45% combined weight) were
//   descriptive, not performance evidence; the 4th (PnL) silently defaulted to a fabricated neutral
//   value with full weight whenever real evidence was missing; low risk alone could inflate the
//   score without any proof of skill. This is exactly the failure mode this task's audit asked to
//   find and fix.
//
// REBUILT MODEL, DISCLOSED: six categories per this task's own required list (verified
// profitability, verified win quality, risk-adjusted performance, timing/entry-exit quality,
// consistency across time, behavior quality), computed ONLY from
// src/modules/fifoEngine's real MatchedLot[] (the SAME real, quantity-based FIFO engine this
// session's Wallet Personality work already established as the authoritative source — never
// pnlSummaryV2's diagnostic rows, never PersonalityV2/ChainActivityV2/SignalV2's descriptive
// fields). A SEPARATE evidence-confidence score, and an explicit not-yet-rated gate below which no
// official numeric score is ever published.

import type { BehaviorV2 } from '../behavior/types'
import type {
  SmartMoneyEvidenceConfidence, SmartMoneyEvidenceConfidenceLevel, SmartMoneyPerformanceBreakdown,
  SmartMoneyScore, SmartMoneyScoreStatus,
} from './types'

export type { SmartMoneyEvidenceConfidence, SmartMoneyPerformanceBreakdown, SmartMoneyScore, SmartMoneyScoreStatus } from './types'

// GENERIC TRADE-EVIDENCE SHAPE, DISCLOSED: this codebase has TWO real, independently-computed
// per-trade sources with the SAME underlying meaning but different concrete shapes —
// src/modules/fifoEngine's MatchedLot (openedAt/closedAt/evidenceQuality) and
// lib/engines/tradeTimelineEngineV2's TradeEntry (single timestamp/confidence, no separate
// open/close pair). Rather than hard-coupling this module to one engine's type (which would make
// it unusable from whichever caller doesn't use that engine), it takes this minimal, real-fields-
// only shape — each real caller maps its own native type into this one at the call site (see
// workers/walletScanV2.ts's own mapping). `openedAt: null` is honest for a source that has no
// separate entry timestamp (e.g. TradeEntry) — computeTimingQuality below simply excludes any lot
// missing it, never fabricating a holding period.
export type VerifiedTradeEvidence = {
  realizedPnlUsd: number | null
  costBasisUsd: number | null
  closedAt: number
  openedAt: number | null
  // True only when this trade's pricing evidence is the source engine's own strongest tier
  // (fifoEngine's evidenceQuality === 'verified', or tradeTimelineEngineV2's confidence === 'high')
  // — never inferred, always the real classification the source engine itself already computed.
  isVerified: boolean
}

const MS_PER_DAY = 86_400_000

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// GATING THRESHOLDS, DISCLOSED: mirrors src/modules/fifoEngine/index.ts's OWN
// derivePublicPnlStatus() thresholds (verifiedMatchedCount >= 10, verified coverage >= 50%) for
// consistency across the codebase — not a newly-invented bar specific to this module.
export const MIN_VERIFIED_TRADES_FOR_OFFICIAL = 10
export const MIN_COVERAGE_PERCENT_FOR_OFFICIAL = 50

// ONE-LUCKY-TRADE GUARD, DISCLOSED: caps any single verified lot's realizedPnlUsd (and the
// cost-basis-normalized return derived from it) at a multiple of the sample's own MEDIAN absolute
// lot PnL before it feeds ANY aggregate below — a real, deterministic winsorization, not a
// fabricated cap. With only 1-2 lots the median IS one of the lots, so the cap has no effect
// (nothing to compare against yet); it only suppresses a genuine outlier once a real distribution
// exists to compare it to.
const OUTLIER_CAP_MULTIPLE = 5

function winsorizedPnl(verifiedLots: readonly VerifiedTradeEvidence[]): number[] {
  const raw = verifiedLots.map((l) => l.realizedPnlUsd as number)
  const medianAbs = median(raw.map((v) => Math.abs(v)))
  if (medianAbs <= 0) return raw
  const cap = medianAbs * OUTLIER_CAP_MULTIPLE
  return raw.map((v) => clamp(v, -cap, cap))
}

function isoWeekKey(ms: number): string {
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  const jan1 = Date.UTC(year, 0, 1)
  const week = Math.floor((ms - jan1) / (7 * MS_PER_DAY))
  return `${year}-W${week}`
}

// PURE. Verified-only trade evidence: isVerified AND both realizedPnlUsd and costBasisUsd are
// real (non-null) — the same "verified" bar Wallet Personality's own computeVerifiedWinLoss
// already uses (app/frontend/lib/walletPersonality.ts).
function verifiedLotsOf(trades: readonly VerifiedTradeEvidence[]): VerifiedTradeEvidence[] {
  return trades.filter((t) => t.isVerified && t.realizedPnlUsd != null && t.costBasisUsd != null && t.costBasisUsd > 0)
}

// PURE. Verified profitability — total winsorized realized PnL relative to total cost basis,
// mapped through a saturating curve (0% return -> 50, +/-100% return saturates to 100/0).
function computeVerifiedProfitability(verifiedLots: readonly VerifiedTradeEvidence[]): number | null {
  if (verifiedLots.length === 0) return null
  const pnls = winsorizedPnl(verifiedLots)
  const totalPnl = pnls.reduce((sum, v) => sum + v, 0)
  const totalCostBasis = verifiedLots.reduce((sum, l) => sum + (l.costBasisUsd as number), 0)
  if (totalCostBasis <= 0) return null
  const returnRatio = totalPnl / totalCostBasis
  return Math.round(50 + clamp(returnRatio, -1, 1) * 50)
}

// PURE. Verified win quality — combines win rate with payoff ratio (avg win / avg loss magnitude,
// winsorized) so a wallet that wins often but loses big scores lower than one with fewer, larger
// wins and small, controlled losses. Requires at least one win AND one loss to compute a payoff
// ratio; falls back to win rate alone (still real, just less specific) when there are no losses at
// all yet.
function computeVerifiedWinQuality(verifiedLots: readonly VerifiedTradeEvidence[]): number | null {
  if (verifiedLots.length === 0) return null
  const pnls = winsorizedPnl(verifiedLots)
  const wins = pnls.filter((v) => v > 0)
  const losses = pnls.filter((v) => v < 0)
  const winRate = wins.length / verifiedLots.length
  const winRateScore = winRate * 100

  if (losses.length === 0) return Math.round(winRateScore)

  const avgWin = mean(wins) ?? 0
  const avgLossMagnitude = mean(losses.map((v) => Math.abs(v))) ?? 0
  if (avgLossMagnitude <= 0) return Math.round(winRateScore)
  const payoffRatio = avgWin / avgLossMagnitude
  const payoffScore = clamp(50 + (payoffRatio - 1) * 25, 0, 100)
  return Math.round((winRateScore + payoffScore) / 2)
}

// PURE. Risk-adjusted performance — a Sharpe-like ratio over per-lot RETURN PERCENTAGES (never raw
// dollar PnL, so a wallet with many small positions isn't penalized relative to one with few large
// positions): mean return / stddev of returns. `null` when fewer than 2 verified lots (a stddev
// over a single data point proves nothing).
function computeRiskAdjustedPerformance(verifiedLots: readonly VerifiedTradeEvidence[]): number | null {
  if (verifiedLots.length < 2) return null
  const pnls = winsorizedPnl(verifiedLots)
  const returns = verifiedLots.map((l, i) => pnls[i] / (l.costBasisUsd as number))
  const avgReturn = mean(returns)
  if (avgReturn == null) return null
  const sd = stddev(returns, avgReturn)
  const sharpeLike = sd > 0 ? avgReturn / sd : (avgReturn > 0 ? 2 : avgReturn < 0 ? -2 : 0)
  return Math.round(50 + clamp(sharpeLike, -2, 2) * 25)
}

// PURE. Timing/entry-exit quality — a real, computable proxy from only timestamps (no external
// price-benchmark data exists in this codebase, so a true "bought the local low" measure is
// honestly not computable; fabricating one would violate this task's own "no fake precision" bar
// established earlier this session): compares average holding time of WINNING lots against
// LOSING lots. A trader who lets winners run longer than they hold losers (cutting losses faster)
// scores higher — a real, established discipline signal computable purely from real
// openedAt/closedAt. `null` when either side has zero lots (nothing to compare).
function computeTimingQuality(verifiedLots: readonly VerifiedTradeEvidence[]): number | null {
  const pnls = winsorizedPnl(verifiedLots)
  const winHoldDays: number[] = []
  const lossHoldDays: number[] = []
  verifiedLots.forEach((l, i) => {
    if (l.openedAt == null) return
    const days = (l.closedAt - l.openedAt) / MS_PER_DAY
    if (!Number.isFinite(days) || days < 0) return
    if (pnls[i] > 0) winHoldDays.push(days)
    else if (pnls[i] < 0) lossHoldDays.push(days)
  })
  if (winHoldDays.length === 0 || lossHoldDays.length === 0) return null
  const avgWinHold = mean(winHoldDays)!
  const avgLossHold = mean(lossHoldDays)!
  const ratio = avgLossHold > 0 ? avgWinHold / avgLossHold : (avgWinHold > 0 ? 2 : 1)
  return Math.round(clamp(50 + (ratio - 1) * 25, 0, 100))
}

// PURE. Consistency across time — the SAME anti-single-trade-domination guard this task's own
// "one lucky trade cannot dominate" requirement calls for: buckets verified closes by ISO week and
// measures what fraction of weeks WITH a verified close also had at least one winning close. A
// wallet whose entire track record is one lucky week out of many active weeks scores low here even
// if its aggregate profitability looks strong — profitability spread thin across time, not
// concentrated in a single trade/period, is what this category actually measures.
// MIN-WEEKS NORMALIZER, DISCLOSED: without this, a wallet active for a SINGLE week whose one
// trade happened to win would score a trivial 100% (1 winning week / 1 active week) — exactly
// the "one lucky trade/period can dominate" failure mode this category exists to catch. Dividing
// by at least this many weeks means a short track record structurally cannot reach full credit
// regardless of how it scored within that short window.
const MIN_WEEKS_FOR_FULL_CONSISTENCY_CREDIT = 8

function computeConsistency(verifiedLots: readonly VerifiedTradeEvidence[]): number | null {
  if (verifiedLots.length === 0) return null
  const pnls = winsorizedPnl(verifiedLots)
  const weeksWithClose = new Set<string>()
  const weeksWithWin = new Set<string>()
  verifiedLots.forEach((l, i) => {
    const week = isoWeekKey(l.closedAt)
    weeksWithClose.add(week)
    if (pnls[i] > 0) weeksWithWin.add(week)
  })
  if (weeksWithClose.size === 0) return null
  const normalizingWeeks = Math.max(weeksWithClose.size, MIN_WEEKS_FOR_FULL_CONSISTENCY_CREDIT)
  return Math.round(clamp((weeksWithWin.size / normalizingWeeks) * 100, 0, 100))
}

// PURE. Behavior quality — the ONE allowed non-performance category (real BehaviorV2 fields,
// capped at 10% of the official weight). Never personality, never raw activity/chain/age counts.
function computeBehaviorQuality(behaviorV2: BehaviorV2 | null | undefined): number | null {
  if (!behaviorV2) return null
  let score = 50
  if (behaviorV2.accumulationStyle === 'accumulator') score += 15
  if (behaviorV2.accumulationStyle === 'distributor') score -= 10
  if (behaviorV2.rotationStyle === 'holding') score += 10
  if (behaviorV2.rotationStyle === 'rotating') score -= 10
  if (behaviorV2.memeBehavior === 'meme-active') score -= 15
  if (behaviorV2.farmingBehavior === 'farmer') score += 5
  if (behaviorV2.stableRoutingBehavior === 'router') score += 5
  return Math.round(clamp(score, 0, 100))
}

// OFFICIAL WEIGHTS, DISCLOSED — exactly this task's own required weighting.
const WEIGHTS: Record<keyof SmartMoneyPerformanceBreakdown, number> = {
  verifiedProfitability: 0.30,
  verifiedWinQuality: 0.20,
  timingQuality: 0.15,
  riskAdjustedPerformance: 0.15,
  consistency: 0.10,
  behaviorQuality: 0.10,
}

// PURE. Weighted-average combine over only the AVAILABLE (non-null) breakdown categories — a
// missing category is EXCLUDED from the weighted average (never treated as 0), and instead lowers
// evidenceConfidence separately (see computeEvidenceConfidence). Mirrors the same combine pattern
// app/frontend/lib/walletPersonality.ts's combineAxis() already established this session.
function combineBreakdown(breakdown: SmartMoneyPerformanceBreakdown): number | null {
  const entries = (Object.keys(WEIGHTS) as Array<keyof SmartMoneyPerformanceBreakdown>)
    .map((key) => ({ value: breakdown[key], weight: WEIGHTS[key] }))
    .filter((e): e is { value: number; weight: number } => e.value != null)
  if (entries.length === 0) return null
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0)
  const weightedSum = entries.reduce((sum, e) => sum + e.value * e.weight, 0)
  return Math.round(weightedSum / totalWeight)
}

// PURE. Evidence confidence — SEPARATE from the score itself, per this task's own explicit rule.
// Three real, disclosed factors: coverage (reaches 1.0 at the official 50% coverage bar), sample
// size (reaches 1.0 at 20 verified trades), and history length (reaches 1.0 at 30 days of real
// closed-lot history) — never derived from how extreme the score itself is.
function computeEvidenceConfidence(params: {
  verifiedCount: number
  totalMatchedLotCount: number
  historyDays: number | null
}): SmartMoneyEvidenceConfidence {
  const { verifiedCount, totalMatchedLotCount, historyDays } = params
  const verifiedCoveragePercent = totalMatchedLotCount > 0 ? (verifiedCount / totalMatchedLotCount) * 100 : 0

  const coverageFactor = clamp((verifiedCoveragePercent / 100) / (MIN_COVERAGE_PERCENT_FOR_OFFICIAL / 100), 0, 1)
  const sampleSizeFactor = clamp(verifiedCount / 20, 0, 1)
  const historyFactor = historyDays == null ? 0 : clamp(historyDays / 30, 0, 1)

  const value = clamp(0.5 * coverageFactor + 0.3 * sampleSizeFactor + 0.2 * historyFactor, 0, 1)
  const level: SmartMoneyEvidenceConfidenceLevel = value >= 0.7 ? 'high' : value >= 0.4 ? 'medium' : 'low'

  return { value: Math.round(value * 100) / 100, level, fullyPricedTradeCount: verifiedCount, totalMatchedLotCount, verifiedCoveragePercent: Math.round(verifiedCoveragePercent * 100) / 100, historyDays }
}

export type ComputeSmartMoneyScoreParams = {
  trades: readonly VerifiedTradeEvidence[]
  // Optional — real BehaviorV2 field for the one allowed non-performance category. Omitting it
  // simply leaves behaviorQuality null (excluded from the weighted average, not defaulted).
  behaviorV2?: BehaviorV2 | null
}

// PURE. The single entry point for this module. Never throws, deterministic (identical input
// always produces an identical output — no Date.now()/Math.random() anywhere in this file).
export function computeSmartMoneyScore(params: ComputeSmartMoneyScoreParams): SmartMoneyScore {
  const trades = params.trades ?? []
  const verifiedLots = verifiedLotsOf(trades)

  const closedAtValues = trades.map((l) => l.closedAt).filter((t) => Number.isFinite(t))
  const historyDays = closedAtValues.length >= 2 ? (Math.max(...closedAtValues) - Math.min(...closedAtValues)) / MS_PER_DAY : null

  const evidenceConfidence = computeEvidenceConfidence({
    verifiedCount: verifiedLots.length,
    totalMatchedLotCount: trades.length,
    historyDays,
  })

  const breakdown: SmartMoneyPerformanceBreakdown = {
    verifiedProfitability: computeVerifiedProfitability(verifiedLots),
    verifiedWinQuality: computeVerifiedWinQuality(verifiedLots),
    riskAdjustedPerformance: computeRiskAdjustedPerformance(verifiedLots),
    timingQuality: computeTimingQuality(verifiedLots),
    consistency: computeConsistency(verifiedLots),
    behaviorQuality: computeBehaviorQuality(params.behaviorV2),
  }

  // GATE, DISCLOSED: an official score requires BOTH a real minimum sample (>= 10 verified trades)
  // AND real minimum coverage (>= 50% of this wallet's own matched lots actually priced) — mirrors
  // fifoEngine's own derivePublicPnlStatus() bar exactly, so "official Smart Money Score" and
  // "official PnL" agree on what counts as enough real evidence.
  const meetsGate = verifiedLots.length >= MIN_VERIFIED_TRADES_FOR_OFFICIAL
    && evidenceConfidence.verifiedCoveragePercent >= MIN_COVERAGE_PERCENT_FOR_OFFICIAL

  const status: SmartMoneyScoreStatus = meetsGate ? 'official' : 'not_yet_rated'
  const officialScore = meetsGate ? combineBreakdown(breakdown) : null
  // PROVISIONAL, DISCLOSED: only behaviorQuality (the one category that needs no verified PnL
  // evidence) is ever shown when not officially rated — never a blend with any performance
  // category, and never labeled as the official score anywhere this value is consumed.
  const provisionalBehaviorScore = !meetsGate ? breakdown.behaviorQuality : null

  const reasonNotRated = meetsGate ? null
    : verifiedLots.length < MIN_VERIFIED_TRADES_FOR_OFFICIAL
      ? `Only ${verifiedLots.length} fully priced, verified trade${verifiedLots.length === 1 ? '' : 's'} — at least ${MIN_VERIFIED_TRADES_FOR_OFFICIAL} are required.`
      : `Verified coverage is ${evidenceConfidence.verifiedCoveragePercent.toFixed(1)}% of this wallet's ${trades.length} closed lots — at least ${MIN_COVERAGE_PERCENT_FOR_OFFICIAL}% is required.`

  const notes: string[] = []
  if (meetsGate) {
    if ((breakdown.verifiedProfitability ?? 0) > 70) notes.push('Consistently profitable across verified, fully priced trades.')
    if ((breakdown.verifiedWinQuality ?? 0) > 70) notes.push('Wins outweigh losses in both frequency and size.')
    if ((breakdown.riskAdjustedPerformance ?? 0) > 70) notes.push('Returns are strong relative to their own volatility.')
    if ((breakdown.timingQuality ?? 0) > 70) notes.push('Lets winners run longer than losers are held.')
    if ((breakdown.consistency ?? 0) > 70) notes.push('Profitability is spread across time, not concentrated in one trade.')
    if ((breakdown.behaviorQuality ?? 0) > 70) notes.push('Exhibits disciplined, non-degen trading behavior.')
  } else {
    notes.push(reasonNotRated!)
  }

  return { status, officialScore, provisionalBehaviorScore, evidenceConfidence, breakdown, notes, reasonNotRated }
}
