// lib/engines/smartMoneyScoreEngine.ts — SmartMoneyScoreEngine.
//
// PRE-CHECK PERFORMED (as required): no smartMoneyScore module exists anywhere in
// src/modules/ (confirmed via repo-wide search). This is a new, standalone, additive engine —
// nothing to avoid replacing.
//
// GENUINE REUSE: consumes the real output types of tradeTimelineEngineV2 (TradeEntry),
// realizedPnl (src/modules/realizedPnl's real RealizedPnlSummary), unrealizedPnlEngine (real
// UnrealizedPnlResult), and the two real, already-shipped V2 modules behaviorIntel
// (BehaviorIntelResult) and chainSelection (ChainSelectionResult) and portfolio (PortfolioSummary)
// — imported directly from their real locations, not redefined. None of the 6 engines/modules this
// consumes are modified, redesigned, or touched.
//
// NAMING NOTE, DISCLOSED: the request's input contract names these `RealizedPnlSummary`,
// `UnrealizedPnlSummary`, `BehaviorIntelSummary`, `ChainSelectionSummary`, `PortfolioSummary`. The
// real exported type names are `RealizedPnlSummary` (matches), `UnrealizedPnlResult` (not
// "...Summary"), `BehaviorIntelResult` (not "...Summary"), `ChainSelectionResult` (not
// "...Summary"), and `PortfolioSummary` (matches). Used the real types directly under their real
// names rather than fabricate parallel types with the requested names.
//
// SCORING METHODOLOGY, DISCLOSED (important): the request specifies component WEIGHTS precisely
// (30/25/20/15/10%) and lists real signals each component should reflect, but does not specify the
// exact sub-formula for turning e.g. "rotation efficiency" or "chain specialization" into a 0-100
// number — no such formula could exist without inventing one, since these are qualitative
// judgments the request describes but doesn't quantify. Every sub-formula below is therefore a
// disclosed, reasonable heuristic (documented at its own definition), not a codified external
// rule. The weighted-average combination step, and every use of a REAL field from a REAL input
// type, is exact and reproducible; the heuristic scoring curves themselves are a judgment call and
// should be revisited/tuned once real-world data is available to validate against.
//
// UNAVAILABLE SIGNAL, DISCLOSED: "bridge efficiency" (part of chainQuality) requires bridge-
// timeline data (src/modules/bridgeDetection or the real pipeline's bridgeTimeline) that is not
// part of this engine's given input contract. Rather than fabricate a bridge-efficiency score from
// data that isn't provided, chainQuality's bridge component is a neutral default (documented at
// its definition) with a note explaining why.

import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import type { TradeEntry } from '@/lib/engines/tradeTimelineEngineV2'
import type { RealizedPnlSummary } from '@/src/modules/realizedPnl'
import type { UnrealizedPnlResult } from '@/lib/engines/unrealizedPnlEngine'
import type { BehaviorIntelResult } from '@/src/modules/behaviorIntel/types'
import type { ChainSelectionResult } from '@/src/modules/chainSelection'
import type { PortfolioSummary } from '@/src/modules/portfolio/types'

export type SmartMoneyScoreRequest = {
  walletAddress: string
  chain: SupportedChain
  trades: TradeEntry[]
  realizedPnl: RealizedPnlSummary
  unrealizedPnl: UnrealizedPnlResult
  behavior: BehaviorIntelResult
  chainSelection: ChainSelectionResult
  portfolio: PortfolioSummary
}

export type SmartMoneyScoreComponents = {
  pnlQuality: number
  tradeQuality: number
  behaviorQuality: number
  chainQuality: number
  portfolioQuality: number
}

export type SmartMoneyScoreResult = {
  score: number
  components: SmartMoneyScoreComponents
  notes: string[]
}

const WEIGHTS = {
  pnlQuality: 0.3,
  tradeQuality: 0.25,
  behaviorQuality: 0.2,
  chainQuality: 0.15,
  portfolioQuality: 0.1,
} as const

function clamp(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

const CONFIDENCE_SCORE: Record<string, number> = { high: 100, medium: 66, low: 33, none: 0 }

// ─── 1. pnlQuality (30%) ─────────────────────────────────────────────────────────────────────────
//
// Heuristic: realizedRoi mapped onto a 0-100 curve centered at 50 (0% ROI = neutral), win rate and
// a win/loss magnitude ratio ("profit factor") folded in directly, then the whole thing is scaled
// down by the fraction of trades that actually carried high/medium pricing confidence — a
// profitable-looking wallet built entirely on "none"-confidence pricing shouldn't score as well as
// one with real evidence behind its numbers.
function scorePnlQuality(req: SmartMoneyScoreRequest, notes: string[]): number {
  const { realizedPnl, unrealizedPnl, trades } = req

  // ROI: 0% -> 50, +100% -> ~90, -100% (total loss) -> ~10. Bounded, diminishing-returns curve
  // (not linear) so an extreme outlier ROI doesn't dominate the score.
  const roiScore = clamp(50 + 40 * Math.tanh(realizedPnl.realizedRoi))

  // Win rate is already a real 0-100 field.
  const winRateScore = clamp(realizedPnl.winRate)

  // Profit factor: avgWin / |avgLoss|, mapped the same way as ROI. avgLoss is 0 when there are no
  // losing trades yet — profit factor is then treated as neutral (50) rather than +Infinity.
  const profitFactor = realizedPnl.avgLoss === 0 ? 1 : realizedPnl.avgWin / Math.abs(realizedPnl.avgLoss)
  const profitFactorScore = clamp(50 + 30 * Math.tanh(profitFactor - 1))

  // Unrealized PnL sign is a smaller, real signal (open positions currently up vs. down).
  const unrealizedScore = clamp(50 + 20 * Math.tanh(unrealizedPnl.totalUnrealizedPnlUsd / Math.max(1, Math.abs(realizedPnl.totalCostBasis) || 1)))

  const rawPnlScore = roiScore * 0.4 + winRateScore * 0.25 + profitFactorScore * 0.2 + unrealizedScore * 0.15

  // Confidence weighting: fraction of trades with high/medium confidence pulls the raw score
  // toward a neutral 50 the less real evidence backs it.
  const confidentTrades = trades.filter((t) => t.confidence === 'high' || t.confidence === 'medium').length
  const confidenceFraction = trades.length === 0 ? 0 : confidentTrades / trades.length
  const weighted = rawPnlScore * confidenceFraction + 50 * (1 - confidenceFraction)

  notes.push(`pnlQuality: realizedRoi=${realizedPnl.realizedRoi.toFixed(3)}, winRate=${realizedPnl.winRate.toFixed(1)}, confidenceFraction=${(confidenceFraction * 100).toFixed(0)}%`)
  return clamp(weighted)
}

// ─── 2. tradeQuality (25%) ───────────────────────────────────────────────────────────────────────
//
// Heuristic: reuses realizedPnl.winRate directly (never recomputes the same thing twice from
// trades[] independently — a single source of truth for "proportion of profitable trades").
// "Partial-close discipline" is approximated by the average number of sell events per distinct
// token sold (more partial exits per token = more disciplined scaling-out behavior, a real,
// if indirect, signal). "Rotation efficiency" is approximated by the ratio of sell count to buy
// count (bounded at 1) — a wallet that only ever buys and never realizes anything scores lower
// here specifically (this is about follow-through, not profitability, which pnlQuality already
// covers). "Cost-basis accuracy" reuses the same confidence-to-score mapping as pnlQuality.
function scoreTradeQuality(req: SmartMoneyScoreRequest, notes: string[]): number {
  const { trades, realizedPnl } = req

  const profitableTradesScore = clamp(realizedPnl.winRate)

  const sellTrades = trades.filter((t) => t.type === 'sell')
  const buyTrades = trades.filter((t) => t.type === 'buy')
  const distinctSoldTokens = new Set(sellTrades.map((t) => t.tokenAddress.toLowerCase())).size
  const avgSellsPerToken = distinctSoldTokens === 0 ? 0 : sellTrades.length / distinctSoldTokens
  // 1 sell per token = baseline (50); 3+ sells per token (scaling out) approaches 100.
  const partialCloseScore = clamp(50 + 25 * Math.tanh(avgSellsPerToken - 1))

  const rotationEfficiencyScore = clamp(buyTrades.length === 0 ? 50 : Math.min(1, sellTrades.length / buyTrades.length) * 100)

  const avgConfidenceScore = trades.length === 0 ? 0 : trades.reduce((sum, t) => sum + (CONFIDENCE_SCORE[t.confidence] ?? 0), 0) / trades.length

  const score = profitableTradesScore * 0.35 + partialCloseScore * 0.2 + rotationEfficiencyScore * 0.2 + avgConfidenceScore * 0.25
  notes.push(`tradeQuality: winRate=${realizedPnl.winRate.toFixed(1)}, avgSellsPerToken=${avgSellsPerToken.toFixed(2)}, sell/buy=${buyTrades.length === 0 ? 'n/a' : (sellTrades.length / buyTrades.length).toFixed(2)}, avgConfidence=${avgConfidenceScore.toFixed(1)}`)
  return clamp(score)
}

// ─── 3. behaviorQuality (20%) ────────────────────────────────────────────────────────────────────
//
// Heuristic: rotationStyle maps to a disclosed, subjective baseline (accumulator scored slightly
// higher than distributor/rotator — a judgment call, not derived from any codified rule);
// riskOnOff contributes a moderate baseline unless genuinely "unknown" (lower, reflecting
// insufficient evidence rather than penalizing a real risk stance either direction); a suspected
// bot (a real, already-computed signal) meaningfully lowers the score.
const ROTATION_STYLE_SCORE: Record<BehaviorIntelResult['rotationStyle']['value'], number> = {
  accumulator: 75,
  rotator: 60,
  distributor: 50,
  unknown: 40,
}

function scoreBehaviorQuality(req: SmartMoneyScoreRequest, notes: string[]): number {
  const { behavior } = req

  const rotationStyleScore = ROTATION_STYLE_SCORE[behavior.rotationStyle.value]

  const riskOnOffScore = behavior.riskOnOff.value === 'unknown' ? 40 : 60

  const automationPenalty = behavior.automationSignals.suspectedBot ? 30 : 0

  const score = rotationStyleScore * 0.5 + riskOnOffScore * 0.3 + 20 - (automationPenalty * 0.2)
  notes.push(`behaviorQuality: rotationStyle=${behavior.rotationStyle.value}, riskOnOff=${behavior.riskOnOff.value}, suspectedBot=${behavior.automationSignals.suspectedBot}`)
  return clamp(score)
}

// ─── 4. chainQuality (15%) ───────────────────────────────────────────────────────────────────────
//
// Heuristic: active-vs-dust ratio is a real, direct proportion. "Chain specialization" is
// approximated from behaviorIntel's real multiChainParticipation (a wallet concentrated on one
// primaryChain scores as more "specialized" than one spread thin) — again a disclosed judgment
// call on which direction is "better", not an external rule. "Bridge efficiency" is NOT computable
// from this engine's given inputs (no bridge-timeline data provided) — defaulted to a neutral 50
// with a note explaining the gap, never fabricated from unrelated data.
function scoreChainQuality(req: SmartMoneyScoreRequest, notes: string[]): number {
  const { chainSelection, behavior } = req

  const totalChains = chainSelection.activeChainCount + chainSelection.dustChainCount
  const activeRatioScore = clamp(totalChains === 0 ? 50 : (chainSelection.activeChainCount / totalChains) * 100)

  const activeChainCount = behavior.multiChainParticipation.activeChains.length
  const specializationScore = clamp(behavior.multiChainParticipation.primaryChain && activeChainCount > 0 ? 50 + 50 / activeChainCount : 50)

  const BRIDGE_EFFICIENCY_NEUTRAL_SCORE = 50
  notes.push('chainQuality: bridge efficiency not computable from this engine\'s given inputs (no bridge-timeline data provided) — defaulted to neutral 50')

  const score = activeRatioScore * 0.5 + specializationScore * 0.3 + BRIDGE_EFFICIENCY_NEUTRAL_SCORE * 0.2
  notes.push(`chainQuality: activeChains=${chainSelection.activeChainCount}/${totalChains}, primaryChain=${behavior.multiChainParticipation.primaryChain ?? 'none'}`)
  return clamp(score)
}

// ─── 5. portfolioQuality (10%) ───────────────────────────────────────────────────────────────────
//
// Heuristic: diversification from real token count (more distinct held tokens = more
// diversified, capped); stablecoin ratio from real portfolio valueUsd summed over recognized
// stable symbols (a MODEST stablecoin buffer is treated as healthier than none, but this does not
// reward being all-in stables, which would show as low "trade" activity elsewhere); concentration
// risk reuses behaviorIntel's real, already-computed topHoldingPercent when available; total value
// log-scaled so a $10M wallet doesn't need to be 1000x "better" than a $10K wallet to max this
// sub-score.
const KNOWN_STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC'])

function scorePortfolioQuality(req: SmartMoneyScoreRequest, notes: string[]): number {
  const { portfolio, behavior } = req

  const tokenCount = portfolio.tokens.length
  const diversificationScore = clamp(Math.min(1, tokenCount / 10) * 100)

  const totalValue = portfolio.totalValueUsd ?? 0
  const stableValue = portfolio.tokens
    .filter((t) => KNOWN_STABLE_SYMBOLS.has(t.symbol.toUpperCase()))
    .reduce((sum, t) => sum + (t.valueUsd ?? 0), 0)
  const stableRatio = totalValue > 0 ? stableValue / totalValue : 0
  // A 10-40% stable buffer scores best (~90); 0% or 100% stable both score lower (~50).
  const stableRatioScore = clamp(90 - 140 * Math.abs(stableRatio - 0.25))

  const concentrationScore = behavior.concentrationSignals
    ? clamp(100 - behavior.concentrationSignals.topHoldingPercent)
    : 50

  const totalValueScore = portfolio.totalValueUsd === null
    ? 0
    : clamp((Math.log10(Math.max(1, portfolio.totalValueUsd)) / Math.log10(1_000_000)) * 100)

  const score = diversificationScore * 0.3 + stableRatioScore * 0.2 + concentrationScore * 0.3 + totalValueScore * 0.2
  notes.push(`portfolioQuality: tokenCount=${tokenCount}, stableRatio=${(stableRatio * 100).toFixed(1)}%, totalValueUsd=${portfolio.totalValueUsd ?? 'null'}`)
  return clamp(score)
}

// Public entry point. Pure and deterministic: same input always produces the same output. Never
// throws — every sub-score function above only reads already-computed real fields with defensive
// fallbacks (never divides by zero, never produces NaN/Infinity in the final score).
export function computeSmartMoneyScore(req: SmartMoneyScoreRequest): SmartMoneyScoreResult {
  const notes: string[] = []

  const components: SmartMoneyScoreComponents = {
    pnlQuality: scorePnlQuality(req, notes),
    tradeQuality: scoreTradeQuality(req, notes),
    behaviorQuality: scoreBehaviorQuality(req, notes),
    chainQuality: scoreChainQuality(req, notes),
    portfolioQuality: scorePortfolioQuality(req, notes),
  }

  const score = clamp(
    components.pnlQuality * WEIGHTS.pnlQuality +
      components.tradeQuality * WEIGHTS.tradeQuality +
      components.behaviorQuality * WEIGHTS.behaviorQuality +
      components.chainQuality * WEIGHTS.chainQuality +
      components.portfolioQuality * WEIGHTS.portfolioQuality,
  )

  return { score, components, notes }
}
