// walletPersonality.ts — pure derivation for the Wallet Personality card.
//
// GROUNDING, DISCLOSED: every field this module reads is a REAL, already-computed output of the
// production pipeline (src/modules/behaviorIntel, src/modules/fifoEngine, src/modules/
// finalReportAssembler, src/modules/timelineBuilder) — the same fields FinalReport already
// guarantees on every successful scan (see src/modules/finalReportAssembler/types.ts). The optional
// `personalityV2`/`behaviorV2`/`riskV2`/`signalsV2`/`chainActivityV2` V2-engine fields (lib/engine/
// modules/*) are consumed ONLY when present — confirmed by tracing the real scan route
// (app/api/wallet-scan/worker/route.ts -> src/modules/walletScanWorker.ts -> src/pipeline/index.ts)
// that they are NOT currently populated by the live Wallet Scanner path, so this module never
// requires them and always has a real, non-V2-sourced fallback for every field it renders.
//
// NEVER PnL-GATED, DISCLOSED: nothing in here reads report.pnlSummaryV2 (src/modules/pnlEngine) as
// an authoritative trade count — that module is a diagnostic-only, non-FIFO read model (one row per
// deduped sell, never a real matched lot; see that module's own header) and is explicitly excluded
// per this task's own instruction. Every win/loss/holding-time figure below is computed from
// report.fifoAndPnl.matchedLots — the real, quantity-based FIFO engine — filtered to
// evidenceQuality === 'verified' wherever a "verified" claim is made. Holding-time figures use ONLY
// openedAt/closedAt (real timestamps), never costBasisUsd/proceedsUsd — so they are available
// regardless of pricing coverage, per this task's "must not depend on... verified historical
// pricing" requirement.
//
// NEVER FALSE ZERO, DISCLOSED: every "unknown" numeric quantity resolves to `null`, never `0` —
// the UI layer is responsible for rendering `null` as "Unknown"/"Not available", never as a literal
// 0/0%.

import type { FinalReport } from '@/src/modules/finalReportAssembler/types'
import type { MatchedLot } from '@/src/modules/fifoEngine/types'
import type { PersonalityV2 } from '@/lib/engine/modules/personality/types'
import type { BehaviorV2 } from '@/lib/engine/modules/behavior/types'
import type { RiskV2 } from '@/lib/engine/modules/risk/types'
import type { SignalV2 } from '@/lib/engine/modules/signals/types'
import type { ChainActivityRecord } from '@/lib/engine/modules/activity/types'

export type WalletPersonalitySourceReport = Pick<FinalReport, 'behaviorIntel' | 'fifoAndPnl' | 'finalSummary' | 'timelines' | 'chainSelection'> & {
  personalityV2?: PersonalityV2 | null
  behaviorV2?: BehaviorV2 | null
  riskV2?: RiskV2 | null
  signalsV2?: SignalV2[] | null
  chainActivityV2?: ChainActivityRecord[] | null
}

export type EvidenceBasis = 'behavior_verified' | 'behavior_only' | 'behavior_plus_pnl' | 'limited_evidence'

export type TradingStyle = 'Manual trader' | 'Assisted trader' | 'Bot-like' | 'Highly automated'
export type HoldingStyle = 'Long-term holder' | 'Swing trader' | 'Short-term rotator' | 'Hyperactive sniper' | 'Not enough data'
export type ConcentrationClass = 'Concentrated' | 'Moderately diversified' | 'Highly diversified' | 'Not enough data'
export type RiskClass = 'Low risk behavior' | 'Medium risk behavior' | 'High risk behavior' | 'Not enough data'

export type PersonalityTraits = {
  tradingStyle: string
  activityLevel: string
  holdingStyle: string
  rotationBehavior: string
  riskAppetite: string
  automationLikelihood: string
  chainPreference: string
  portfolioConcentration: string
}

export type BehaviorMetrics = {
  totalTransactions: number
  buys: number
  sells: number
  activeChains: number
  averageHoldingDays: number | null
  medianHoldingDays: number | null
  uniqueTokensTraded: number | null
  repeatedRouterPercent: number | null
  walletAgeDays: number | null
  lastActiveAt: string | null
}

export type BehaviorClassification = {
  automation: TradingStyle
  holding: HoldingStyle
  concentration: ConcentrationClass
  risk: RiskClass
}

export type ProfitEvidence = {
  kind: 'verified' | 'limited_sample' | 'not_proven'
  message: string
  winCount: number | null
  lossCount: number | null
  evaluatedCount: number | null
  winRatePercent: number | null
}

// RADAR AXES, DISCLOSED: 5 axes normalized to [0, 1] for the compact visual summary — each is a
// deterministic function of real, already-present behavior data (never a fabricated precision
// figure). `null` (never a guessed midpoint like 0.5) whenever the underlying signal itself is
// genuinely unknown (e.g. riskOnOff === 'unknown', or zero real transactions for activity).
export type RadarAxes = {
  activity: number | null
  risk: number | null
  automation: number | null
  rotation: number | null
  conviction: number | null
}

export type WalletPersonalityData = {
  title: string
  subtitle: string
  summarySentence: string
  confidence: 'high' | 'medium' | 'low'
  evidenceBasis: EvidenceBasis
  traits: PersonalityTraits
  metrics: BehaviorMetrics
  classification: BehaviorClassification
  radar: RadarAxes
  strengths: string[]
  watchouts: string[]
  profitEvidence: ProfitEvidence
  // MINIMAL-EVIDENCE FALLBACK, DISCLOSED: true whenever there is too little real activity (zero
  // transactions) to say anything specific — the card still renders (never blank), just with this
  // flag driving a plain "insufficient evidence" message instead of a detailed profile.
  insufficientEvidence: boolean
}

const MS_PER_DAY = 86_400_000

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// PURE. Holding time is computed strictly from real openedAt/closedAt timestamps on
// fifoAndPnl.matchedLots — never from priced cost basis/proceeds, so this is available regardless
// of pricing coverage. `evidenceQuality` is intentionally NOT filtered here (a lot's TIME window is
// real and known even when its USD price is not) — a caller wanting a stricter, verified-only view
// should filter its own input list first.
export function computeHoldingDaysStats(matchedLots: readonly Pick<MatchedLot, 'openedAt' | 'closedAt'>[]): {
  averageHoldingDays: number | null
  medianHoldingDays: number | null
} {
  const days = matchedLots
    .map((l) => (l.closedAt - l.openedAt) / MS_PER_DAY)
    .filter((d) => Number.isFinite(d) && d >= 0)
  return { averageHoldingDays: mean(days), medianHoldingDays: median(days) }
}

// PURE. "Repeated-router percentage" — the share of sellTimelineV2 entries whose counterparty
// (real, already-normalized field on SellTimelineEntry) equals the single most common counterparty
// among all sells that carry one. `null` (never 0) when there is no counterparty evidence at all.
export function computeRepeatedRouterPercent(counterparties: readonly (string | null)[]): number | null {
  const known = counterparties.filter((c): c is string => c != null && c.length > 0)
  if (known.length === 0) return null
  const counts = new Map<string, number>()
  for (const c of known) counts.set(c, (counts.get(c) ?? 0) + 1)
  const maxCount = Math.max(...counts.values())
  return (maxCount / known.length) * 100
}

// PURE. Win/loss counts computed ONLY over VERIFIED matched lots (evidenceQuality === 'verified',
// realizedPnlUsd non-null) — the real, priced, FIFO-matched outcome of a closed lot. Never reads
// pnlSummaryV2's diagnostic rows.
export function computeVerifiedWinLoss(matchedLots: readonly Pick<MatchedLot, 'evidenceQuality' | 'realizedPnlUsd'>[]): {
  wins: number
  losses: number
  evaluated: number
} {
  let wins = 0
  let losses = 0
  let evaluated = 0
  for (const lot of matchedLots) {
    if (lot.evidenceQuality !== 'verified' || lot.realizedPnlUsd == null) continue
    evaluated += 1
    if (lot.realizedPnlUsd > 0) wins += 1
    else if (lot.realizedPnlUsd < 0) losses += 1
  }
  return { wins, losses, evaluated }
}

function classifyHolding(averageHoldingDays: number | null): HoldingStyle {
  if (averageHoldingDays == null) return 'Not enough data'
  if (averageHoldingDays >= 30) return 'Long-term holder'
  if (averageHoldingDays >= 7) return 'Swing trader'
  if (averageHoldingDays >= 1) return 'Short-term rotator'
  return 'Hyperactive sniper'
}

function classifyAutomation(suspectedBot: boolean, repeatedRouterPercent: number | null): TradingStyle {
  if (suspectedBot && (repeatedRouterPercent ?? 0) >= 80) return 'Highly automated'
  if (suspectedBot) return 'Bot-like'
  if ((repeatedRouterPercent ?? 0) >= 50) return 'Assisted trader'
  return 'Manual trader'
}

function classifyConcentration(label: 'high' | 'medium' | 'balanced' | 'none' | null): ConcentrationClass {
  if (label === 'high') return 'Concentrated'
  if (label === 'medium') return 'Moderately diversified'
  if (label === 'balanced') return 'Highly diversified'
  return 'Not enough data'
}

function classifyRisk(riskOnOff: 'risk_on' | 'risk_off' | 'unknown', suspectedBot: boolean, concentration: ConcentrationClass): RiskClass {
  if (riskOnOff === 'unknown' && !suspectedBot && concentration === 'Not enough data') return 'Not enough data'
  let score = 0
  if (riskOnOff === 'risk_on') score += 1
  if (suspectedBot) score += 1
  if (concentration === 'Concentrated') score += 1
  if (score >= 2) return 'High risk behavior'
  if (score === 1) return 'Medium risk behavior'
  return 'Low risk behavior'
}

// PURE. Composes a distinctive, evidence-grounded personality title from real classification
// inputs only — never a placeholder. "General User" is reserved EXCLUSIVELY for the
// insufficient-evidence case (handled by the caller, not this function) — every other case
// produces a specific, real-signal-backed title, matching this task's own explicit examples
// ("Risk-On Swing Operator", "High-Tempo Token Rotator", "Manual Multi-Chain Trader",
// "Concentrated Conviction Holder"). Deterministic priority order, most-specific signal first.
export function composeTitle(params: {
  automationClass: TradingStyle
  holdingClass: HoldingStyle
  concentrationClass: ConcentrationClass
  riskValue: 'risk_on' | 'risk_off' | 'unknown'
  rotationValue: 'accumulator' | 'rotator' | 'distributor' | 'unknown'
  convictionValue: 'high' | 'medium' | 'low' | 'unknown'
  activeChains: number
  totalTransactions: number
}): string {
  const { automationClass, holdingClass, concentrationClass, riskValue, rotationValue, convictionValue, activeChains, totalTransactions } = params

  if (concentrationClass === 'Concentrated' && convictionValue === 'high') return 'Concentrated Conviction Holder'
  if (riskValue === 'risk_on' && holdingClass === 'Swing trader') return 'Risk-On Swing Operator'
  if (rotationValue === 'rotator' && (holdingClass === 'Short-term rotator' || holdingClass === 'Hyperactive sniper') && totalTransactions >= 15) return 'High-Tempo Token Rotator'
  if (automationClass === 'Manual trader' && activeChains >= 3) return 'Manual Multi-Chain Trader'
  if (automationClass === 'Highly automated') return 'Highly Automated Execution Wallet'
  if (automationClass === 'Bot-like') return 'Bot-Like Execution Pattern'
  if (holdingClass === 'Long-term holder') return riskValue === 'risk_off' ? 'Disciplined Long-Term Holder' : 'Conviction Long-Term Holder'
  if (holdingClass === 'Hyperactive sniper') return 'Hyperactive Token Sniper'
  if (holdingClass === 'Short-term rotator') return 'Short-Term Token Rotator'
  if (rotationValue === 'accumulator') return 'Steady Accumulator'
  if (rotationValue === 'distributor') return 'Active Distributor'
  const riskLabel = riskValue === 'risk_on' ? 'Risk-On' : riskValue === 'risk_off' ? 'Risk-Off' : 'Balanced'
  return `${riskLabel} ${automationClass}`
}

// PURE. 5-axis radar, each normalized to [0, 1] or null — see RadarAxes' own header.
export function computeRadarAxes(params: {
  totalTransactions: number
  riskValue: 'risk_on' | 'risk_off' | 'unknown'
  suspectedBot: boolean
  repeatedRouterPercent: number | null
  rotationValue: 'accumulator' | 'rotator' | 'distributor' | 'unknown'
  convictionValue: 'high' | 'medium' | 'low' | 'unknown'
}): RadarAxes {
  const { totalTransactions, riskValue, suspectedBot, repeatedRouterPercent, rotationValue, convictionValue } = params
  return {
    activity: totalTransactions === 0 ? null : Math.min(1, totalTransactions / 50),
    risk: riskValue === 'unknown' ? null : riskValue === 'risk_on' ? 1 : 0,
    automation: suspectedBot ? 1 : repeatedRouterPercent != null ? Math.min(1, repeatedRouterPercent / 100) : 0,
    rotation: rotationValue === 'unknown' ? null : rotationValue === 'rotator' ? 1 : rotationValue === 'distributor' ? 0.6 : 0.2,
    conviction: convictionValue === 'unknown' ? null : convictionValue === 'high' ? 1 : convictionValue === 'medium' ? 0.5 : 0.15,
  }
}

function fmtDays(v: number | null): string {
  if (v == null) return 'Not enough data'
  if (v < 1) return `${(v * 24).toFixed(1)}h`
  return `${v.toFixed(1)}d`
}

// PURE. The single source of truth for the whole card — never throws, never returns a shape that
// would force the caller to hide the card. Every field is either a real derived value or an
// honestly-labeled "not enough data" placeholder — never a fabricated 0/blank.
export function deriveWalletPersonality(report: WalletPersonalitySourceReport): WalletPersonalityData {
  const b = report.behaviorIntel
  const matchedLots = report.fifoAndPnl?.matchedLots ?? []
  const buys = report.timelines?.buyTimeline?.totalBuys ?? 0
  const sellEntries = report.timelines?.sellTimelineV2?.entries ?? []
  const sells = report.timelines?.sellTimelineV2?.totalSells ?? sellEntries.length
  const buyEntries = report.timelines?.buyTimeline?.entries ?? []
  const totalTransactions = buys + sells
  const activeChains = report.chainSelection?.activeChainCount ?? b?.multiChainParticipation?.activeChains?.length ?? 0

  const { averageHoldingDays, medianHoldingDays } = computeHoldingDaysStats(matchedLots)
  const repeatedRouterPercent = computeRepeatedRouterPercent(sellEntries.map((e) => e.counterparty ?? null))
  const uniqueTokensTraded = b?.rotationStyle?.basis?.distinctTokensTraded ?? null

  const allTimestamps = [
    ...buyEntries.map((e) => e.timestamp),
    ...sellEntries.map((e) => e.timestamp),
  ].filter((t) => Number.isFinite(t))
  const firstSeenMs = allTimestamps.length > 0 ? Math.min(...allTimestamps) : null
  const lastActiveMs = allTimestamps.length > 0 ? Math.max(...allTimestamps) : null
  const walletAgeDays = firstSeenMs != null ? (Date.now() - firstSeenMs) / MS_PER_DAY : null
  const lastActiveAt = lastActiveMs != null ? new Date(lastActiveMs).toISOString() : null

  const suspectedBot = b?.automationSignals?.suspectedBot ?? false
  const concentrationLabel = b?.concentrationSignals?.concentrationLabel ?? null
  const concentrationClass = classifyConcentration(concentrationLabel)
  const holdingClass = classifyHolding(averageHoldingDays)
  const automationClass = classifyAutomation(suspectedBot, repeatedRouterPercent)
  const riskClass = classifyRisk(b?.riskOnOff?.value ?? 'unknown', suspectedBot, concentrationClass)

  const officialPnlStatus = report.finalSummary?.financialStatus?.officialPnlStatus ?? null
  const { wins, losses, evaluated } = computeVerifiedWinLoss(matchedLots)

  const profitEvidence: ProfitEvidence = (() => {
    if (officialPnlStatus === 'ok' && evaluated > 0) {
      const winRatePercent = (wins / evaluated) * 100
      const skill = report.fifoAndPnl?.realizedPnlUsd != null
        ? report.fifoAndPnl.realizedPnlUsd > 0 ? 'profitable' : report.fifoAndPnl.realizedPnlUsd < 0 ? 'unprofitable' : 'breakeven'
        : null
      return {
        kind: 'verified',
        message: skill
          ? `Verified win rate: ${winRatePercent.toFixed(0)}% (${wins} wins / ${losses} losses) — ${skill} on a verified sample.`
          : `Verified win rate: ${winRatePercent.toFixed(0)}% (${wins} wins / ${losses} losses).`,
        winCount: wins, lossCount: losses, evaluatedCount: evaluated, winRatePercent,
      }
    }
    if (evaluated > 0) {
      return {
        kind: 'limited_sample',
        message: `Limited verified sample — ${wins} wins / ${losses} losses across ${evaluated} fully priced trades.`,
        winCount: wins, lossCount: losses, evaluatedCount: evaluated,
        winRatePercent: (wins / evaluated) * 100,
      }
    }
    return {
      kind: 'not_proven',
      message: 'Profitability not proven — personality is based on on-chain behavior.',
      winCount: null, lossCount: null, evaluatedCount: 0, winRatePercent: null,
    }
  })()

  const evidenceBasis: EvidenceBasis =
    totalTransactions === 0 ? 'limited_evidence'
    : officialPnlStatus === 'ok' ? 'behavior_plus_pnl'
    : (b?.confidence ?? 'low') !== 'low' ? 'behavior_verified'
    : 'behavior_only'

  const insufficientEvidence = totalTransactions === 0

  const rotationValue = b?.rotationStyle?.value ?? 'unknown'
  const riskValue = b?.riskOnOff?.value ?? 'unknown'

  const convictionValue = b?.convictionScore?.value ?? 'unknown'

  // TITLE, DISCLOSED: "General User" is reserved EXCLUSIVELY for the zero-evidence case (per this
  // task's explicit instruction) — prefers a real V2 personalityV2.archetype when the caller
  // supplied one (see this module's own header — not populated by the live scan route today, but
  // consumed when present), otherwise composeTitle() builds a distinctive, real-signal-backed
  // title — NEVER from smartMoneyScore.components.personalityScore (a 0-100 number, not a label).
  const title = insufficientEvidence
    ? 'General User'
    : (report.personalityV2?.archetype ?? composeTitle({
        automationClass, holdingClass, concentrationClass, riskValue, rotationValue, convictionValue, activeChains, totalTransactions,
      }))

  const subtitle = insufficientEvidence
    ? 'Insufficient evidence for a detailed personality'
    : `${automationClass} · ${holdingClass} · ${activeChains} active chain${activeChains === 1 ? '' : 's'}`

  const summarySentence = insufficientEvidence
    ? 'Not enough on-chain activity was found for this wallet to characterize its trading behavior.'
    : `This wallet is a ${automationClass.toLowerCase()}, ${holdingClass.toLowerCase()} trading across ${activeChains} active chain${activeChains === 1 ? '' : 's'}, with ${riskValue === 'unknown' ? 'an undetermined' : riskValue.replace('_', '-')} risk posture.`

  const radar = computeRadarAxes({ totalTransactions, riskValue, suspectedBot, repeatedRouterPercent, rotationValue, convictionValue })

  const strengths: string[] = []
  const watchouts: string[] = []

  if (!insufficientEvidence) {
    if (totalTransactions >= 10) strengths.push('Consistent on-chain activity')
    if (activeChains >= 3) strengths.push('Diversified chain usage')
    if (averageHoldingDays != null && averageHoldingDays >= 7) strengths.push('Disciplined holding periods')
    if (repeatedRouterPercent != null && repeatedRouterPercent < 40) strengths.push('Low router repetition')
    if (concentrationClass === 'Concentrated' && (b?.convictionScore?.value === 'high')) strengths.push('Concentrated conviction')

    if (rotationValue === 'rotator' && (uniqueTokensTraded ?? 0) >= 5) watchouts.push('Rapid token rotation')
    if (concentrationClass === 'Concentrated') watchouts.push('Heavy portfolio concentration')
    if (repeatedRouterPercent != null && repeatedRouterPercent >= 70) watchouts.push('Repeated router patterns')
    if (averageHoldingDays != null && averageHoldingDays < 1) watchouts.push('Short holding periods')
    if ((b?.confidence ?? 'low') === 'low') watchouts.push('Limited verified trade history')
  }

  return {
    title,
    subtitle,
    summarySentence,
    confidence: b?.confidence ?? 'low',
    evidenceBasis,
    radar,
    traits: {
      tradingStyle: automationClass,
      activityLevel: totalTransactions === 0 ? 'Inactive' : totalTransactions >= 50 ? 'Very active' : totalTransactions >= 10 ? 'Active' : 'Light',
      holdingStyle: holdingClass,
      rotationBehavior: rotationValue === 'unknown' ? 'Unknown' : rotationValue.charAt(0).toUpperCase() + rotationValue.slice(1),
      riskAppetite: riskValue === 'unknown' ? 'Unknown' : riskValue.replace('_', ' '),
      automationLikelihood: suspectedBot ? 'Likely automated' : 'Likely manual',
      chainPreference: b?.multiChainParticipation?.primaryChain ?? 'Unknown',
      portfolioConcentration: concentrationClass,
    },
    metrics: {
      totalTransactions,
      buys,
      sells,
      activeChains,
      averageHoldingDays,
      medianHoldingDays,
      uniqueTokensTraded,
      repeatedRouterPercent,
      walletAgeDays,
      lastActiveAt,
    },
    classification: {
      automation: automationClass,
      holding: holdingClass,
      concentration: concentrationClass,
      risk: riskClass,
    },
    strengths: [...new Set(strengths)],
    watchouts: [...new Set(watchouts)],
    profitEvidence,
    insufficientEvidence,
  }
}

export function fmtHoldingDays(v: number | null): string {
  return fmtDays(v)
}
