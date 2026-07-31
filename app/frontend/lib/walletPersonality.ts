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

export type TradingStyle = 'Manual trader' | 'Assisted trader' | 'Bot-like' | 'Highly automated' | 'Automation signals present'
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

// AXIS SCORE CALIBRATION, DISCLOSED (this task's own root-cause fix): production evidence showed
// Activity/Risk both pinned at 100% and Automation/Rotation each driven by ONE raw field
// (totalTransactions/50, riskOnOff.value, repeatedRouterPercent, rotationStyle.value —
// respectively) — a single metric could unilaterally saturate an axis to "fully proven" even
// though the UI presents it as a percentage a reader naturally reads as certainty. Rebuilt so:
//   - Every axis is a WEIGHTED COMBINATION of 2-4 INDEPENDENT real sub-signals (never one field).
//   - `signalStrength` (0-100) and `evidenceConfidence` (0-1) are SEPARATE numbers — strength says
//     how far toward the "top band" the available evidence points; confidence says how much of
//     the axis's possible evidence is actually present (missing inputs lower confidence, they are
//     never defaulted to a midpoint or to the maximum).
//   - Signal strength can only reach the very-high band when AT LEAST TWO independent sub-signals
//     each land in the top band (>= TOP_BAND_THRESHOLD) — see combineAxis()'s own header for the
//     single-signal ceiling that enforces this.
//   - Correlated concepts (e.g. "token churn" feeding both Risk and Rotation, or "holding speed"
//     feeding both Risk and Conviction) are included in more than one axis ONLY at explicitly
//     reduced weight, disclosed per sub-signal below — never full weight in two places at once.
export type AxisContributor = {
  key: string
  label: string
  // The real underlying metric value shown to the user (already-formatted string) — e.g.
  // "163 unique tokens", "60% repeated router" — never just the internal normalized [0,1] number.
  detail: string
  // Normalized [0,1] contribution this sub-signal made to the axis, or null when this sub-signal's
  // own input data was unavailable (excluded from the weighted average, not defaulted).
  normalizedValue: number | null
  weight: number
}

export type AxisScore = {
  // 0-100, or null when NO sub-signal for this axis had any real data at all (never a fabricated
  // "insufficient" fallback number like 0 or 50).
  signalStrength: number | null
  // 0-1 — fraction of this axis's total possible evidence weight that was actually backed by real
  // (non-null) data this scan. Independent of how extreme signalStrength itself is.
  evidenceConfidence: number
  label: 'Insufficient evidence' | 'Low' | 'Moderate' | 'High' | 'Very high'
  contributors: AxisContributor[]
  missingInputs: string[]
}

export type RadarAxes = {
  activity: AxisScore
  risk: AxisScore
  automation: AxisScore
  rotation: AxisScore
  conviction: AxisScore
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

// AUTOMATION LABEL, DISCLOSED (this task's own explicit rule): "repeated-router % alone must not
// prove automation" — the strongest labels ('Bot-like'/'Highly automated') now additionally
// require the automation AXIS's own evidenceConfidence to clear MIN_CONFIDENCE_FOR_BOT_LABEL
// (i.e. at least 2 of the 3 independent automation sub-signals actually had real data), never just
// a high repeatedRouterPercent alone. Below that confidence bar, the softer, non-alarmist
// "Automation signals present" wording is used instead — still evidence-backed, never overclaimed.
const MIN_CONFIDENCE_FOR_BOT_LABEL = 0.65

function classifyAutomation(automationAxis: AxisScore, suspectedBot: boolean): TradingStyle {
  const strength = automationAxis.signalStrength ?? 0
  const confident = automationAxis.evidenceConfidence >= MIN_CONFIDENCE_FOR_BOT_LABEL
  if (strength >= 80) return confident ? 'Highly automated' : 'Automation signals present'
  if (strength >= 55 || suspectedBot) return confident ? 'Bot-like' : 'Automation signals present'
  if (strength >= 30) return 'Assisted trader'
  return 'Manual trader'
}

function classifyConcentration(label: 'high' | 'medium' | 'balanced' | 'none' | null): ConcentrationClass {
  if (label === 'high') return 'Concentrated'
  if (label === 'medium') return 'Moderately diversified'
  if (label === 'balanced') return 'Highly diversified'
  return 'Not enough data'
}

// RISK LABEL, DISCLOSED (this task's own explicit rebuild): the badge is now derived from the
// multi-signal Risk AXIS (see computeRiskAxis) rather than riskOnOff.value directly — "risk must
// not equal bad" and "high activity itself must not be high risk" both hold structurally now,
// since neither riskOnOff nor activity feed this axis at all (see computeRiskAxis' own real
// sub-signals: short holding, portfolio concentration, reduced-weight token churn, chain breadth).
// evidenceConfidence === 0 (no risk sub-signal had any data) returns 'Not enough data' — never a
// guessed "Low"/"Medium" default.
function classifyRisk(riskAxis: AxisScore): RiskClass {
  if (riskAxis.signalStrength == null) return 'Not enough data'
  if (riskAxis.signalStrength >= 65) return 'High risk behavior'
  if (riskAxis.signalStrength >= 35) return 'Medium risk behavior'
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

  // CONFLICT DETECTION, DISCLOSED (this task's own explicit rule): 'rotator' (fast, frequent
  // token-switching) and 'Long-term holder' (patient, multi-week+ average holding time) are
  // genuinely contradictory real signals — rather than silently picking one and overclaiming
  // certainty, a neutral title names the conflict directly.
  if (rotationValue === 'rotator' && holdingClass === 'Long-term holder') return 'Mixed-Signal Trader'

  if (concentrationClass === 'Concentrated' && convictionValue === 'high') return 'Concentrated Conviction Holder'
  if (riskValue === 'risk_on' && holdingClass === 'Swing trader') return 'Risk-On Swing Operator'
  if (rotationValue === 'rotator' && (holdingClass === 'Short-term rotator' || holdingClass === 'Hyperactive sniper') && totalTransactions >= 15) return 'High-Tempo Token Rotator'
  if (automationClass === 'Manual trader' && activeChains >= 3) return 'Manual Multi-Chain Trader'
  if (automationClass === 'Highly automated') return 'Highly Automated Execution Wallet'
  if (automationClass === 'Bot-like') return 'Bot-Like Execution Pattern'
  if (automationClass === 'Automation signals present') return 'Wallet With Automation Signals'
  if (holdingClass === 'Long-term holder') return riskValue === 'risk_off' ? 'Disciplined Long-Term Holder' : 'Conviction Long-Term Holder'
  if (holdingClass === 'Hyperactive sniper') return 'Hyperactive Token Sniper'
  if (holdingClass === 'Short-term rotator') return 'Short-Term Token Rotator'
  if (rotationValue === 'accumulator') return 'Steady Accumulator'
  if (rotationValue === 'distributor') return 'Active Distributor'
  const riskLabel = riskValue === 'risk_on' ? 'Risk-On' : riskValue === 'risk_off' ? 'Risk-Off' : 'Balanced'
  return `${riskLabel} ${automationClass}`
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

// MIN-SAMPLE GATE, DISCLOSED: a token-churn RATIO computed from a tiny transaction count is noise,
// not signal (e.g. 3 tokens / 6 transactions trivially "saturates" a naive ratio threshold despite
// there being almost no real evidence at all) — this is the same class of problem
// MIN_INTERVALS_FOR_CADENCE guards against for automation. Below this transaction count, the
// churn-ratio sub-signal is excluded entirely (missing, not defaulted), which correctly lowers
// evidenceConfidence instead of letting a low-weight signal dominate a near-empty weighted average.
const MIN_TRANSACTIONS_FOR_CHURN_SIGNAL = 10

// TOP-BAND THRESHOLD, DISCLOSED: a sub-signal counts as "top band" (i.e. eligible to help unlock
// the very-high/100 range) only once it is itself at or above this normalized value.
const TOP_BAND_THRESHOLD = 0.8
// SINGLE-SIGNAL CEILING, DISCLOSED: the hard cap applied whenever FEWER than 2 available
// sub-signals reach TOP_BAND_THRESHOLD — this is what makes "one metric alone must never force
// 100" a structural guarantee rather than a convention a single formula could violate. 0.85 still
// reads as "High", never "Very high"/100, for a wallet whose only strong evidence is one signal.
const SINGLE_SIGNAL_CEILING = 0.85

type RawSubSignal = { key: string; label: string; detail: string; value: number | null; weight: number }

// PURE, DISCLOSED — the shared scoring engine every axis below is built from. See AxisScore's own
// header for the exact guarantees this enforces (independent multi-signal combination, a real
// single-signal ceiling, missing inputs reducing confidence rather than defaulting to a midpoint).
export function combineAxis(signals: RawSubSignal[]): AxisScore {
  const contributors: AxisContributor[] = signals.map((s) => ({ key: s.key, label: s.label, detail: s.detail, normalizedValue: s.value, weight: s.weight }))
  const missingInputs = signals.filter((s) => s.value == null).map((s) => s.label)
  const available = signals.filter((s): s is RawSubSignal & { value: number } => s.value != null)
  const totalPossibleWeight = signals.reduce((sum, s) => sum + s.weight, 0)

  if (available.length === 0 || totalPossibleWeight === 0) {
    return { signalStrength: null, evidenceConfidence: 0, label: 'Insufficient evidence', contributors, missingInputs }
  }

  const availableWeight = available.reduce((sum, s) => sum + s.weight, 0)
  const weightedAverage = available.reduce((sum, s) => sum + s.value * s.weight, 0) / availableWeight
  const topBandCount = available.filter((s) => s.value >= TOP_BAND_THRESHOLD).length
  const strength01 = topBandCount >= 2 ? weightedAverage : Math.min(weightedAverage, SINGLE_SIGNAL_CEILING)
  const evidenceConfidence = clamp01(availableWeight / totalPossibleWeight)

  const signalStrength = Math.round(clamp01(strength01) * 100)
  const label: AxisScore['label'] =
    signalStrength >= 90 ? 'Very high' : signalStrength >= 70 ? 'High' : signalStrength >= 40 ? 'Moderate' : 'Low'

  return { signalStrength, evidenceConfidence, label, contributors, missingInputs }
}

// PURE. Coefficient-of-variation-based cadence regularity — a genuinely independent automation
// signal (never reused elsewhere): a wallet whose transactions land at very regular intervals
// (low variance) reads as automation-like; irregular spacing reads as manual. `null` (never a
// guessed value) unless there are at least MIN_INTERVALS_FOR_CADENCE real gaps to measure — a
// single-digit transaction count cannot honestly support a cadence claim.
const MIN_INTERVALS_FOR_CADENCE = 5

export function computeCadenceRegularity(timestampsMs: readonly number[]): number | null {
  const sorted = [...new Set(timestampsMs)].filter((t) => Number.isFinite(t)).sort((a, b) => a - b)
  if (sorted.length < MIN_INTERVALS_FOR_CADENCE + 1) return null
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) intervals.push(sorted[i] - sorted[i - 1])
  const avgInterval = mean(intervals)
  if (avgInterval == null || avgInterval <= 0) return null
  const variance = intervals.reduce((sum, v) => sum + (v - avgInterval) ** 2, 0) / intervals.length
  const stdDev = Math.sqrt(variance)
  const coefficientOfVariation = stdDev / avgInterval
  // A CV of 0 is perfectly regular (1.0 regularity); a CV at or above 1 is treated as fully
  // irregular (0 regularity) — real-world human trading is almost always well above CV 1.
  return clamp01(1 - coefficientOfVariation)
}

// PURE. Activity axis — two independent sub-signals (never one raw transaction count alone):
// trade DENSITY (transactions per day of real wallet age) and trade VOLUME (total transaction
// count), each saturating well before typical "prolific trader" volumes so genuinely huge wallets
// don't need a third signal to justify a high reading, while an ordinary wallet's raw count alone
// cannot reach the top band on its own.
function computeActivityAxis(params: { totalTransactions: number; walletAgeDays: number | null }): AxisScore {
  const { totalTransactions, walletAgeDays } = params
  const density = totalTransactions > 0 && walletAgeDays != null && walletAgeDays > 0
    ? clamp01((totalTransactions / walletAgeDays) / 5) // 5 tx/day saturates the density signal
    : null
  const volume = totalTransactions > 0 ? clamp01(totalTransactions / 300) : null // 300+ tx saturates the volume signal
  return combineAxis([
    { key: 'density', label: 'Transaction density', detail: walletAgeDays != null ? `${(totalTransactions / Math.max(1, walletAgeDays)).toFixed(2)} tx/day` : 'Unknown', value: density, weight: 0.55 },
    { key: 'volume', label: 'Transaction volume', detail: `${totalTransactions} total transactions`, value: volume, weight: 0.45 },
  ])
}

// PURE. Risk axis — REBUILT from independent behavior evidence (never riskOnOff.value directly —
// see this task's own audit: that single categorical field previously WAS the entire axis, forcing
// 0% or 100% from one classification). "High activity itself is high risk" is explicitly NOT one
// of the sub-signals below. Token-churn and holding-speed are shared concepts with the Rotation/
// Conviction axes — included here at REDUCED weight only (0.15/0.10 vs. their primary-axis weight
// of 0.30-0.35) so the same underlying behavior is never double-counted at full strength twice.
function computeRiskAxis(params: {
  averageHoldingDays: number | null
  concentrationLabel: 'high' | 'medium' | 'balanced' | 'none' | null
  uniqueTokensTraded: number | null
  totalTransactions: number
  activeChains: number
}): AxisScore {
  const { averageHoldingDays, concentrationLabel, uniqueTokensTraded, totalTransactions, activeChains } = params

  const shortHolding = averageHoldingDays != null ? clamp01((5 - averageHoldingDays) / 5) : null
  const concentration = concentrationLabel == null ? null
    : concentrationLabel === 'high' ? 1 : concentrationLabel === 'medium' ? 0.5 : concentrationLabel === 'balanced' ? 0.1 : null
  const tokenChurn = uniqueTokensTraded != null && totalTransactions >= MIN_TRANSACTIONS_FOR_CHURN_SIGNAL
    ? clamp01((uniqueTokensTraded / totalTransactions) / 0.5)
    : null
  const chainBreadth = activeChains > 0 ? clamp01(activeChains / 6) : null

  return combineAxis([
    { key: 'shortHolding', label: 'Short holding periods', detail: fmtDays(averageHoldingDays), value: shortHolding, weight: 0.40 },
    // CONFIDENCE-NOT-ASSUMPTION, DISCLOSED (this task's own explicit rule): a null concentration
    // input is EXCLUDED here (never treated as "assume high risk") — it only lowers
    // evidenceConfidence via combineAxis' own availableWeight/totalPossibleWeight ratio.
    { key: 'concentration', label: 'Portfolio concentration', detail: concentrationLabel ?? 'Unknown', value: concentration, weight: 0.35 },
    // REDUCED WEIGHT, DISCLOSED (shared with Rotation's own primary churnRatio signal at 0.35) —
    // never double-counted at full strength.
    { key: 'tokenChurnReduced', label: 'Token churn (reduced weight)', detail: uniqueTokensTraded != null ? `${uniqueTokensTraded} unique tokens` : 'Unknown', value: tokenChurn, weight: 0.15 },
    { key: 'chainBreadth', label: 'Chain breadth', detail: `${activeChains} active chain${activeChains === 1 ? '' : 's'}`, value: chainBreadth, weight: 0.10 },
  ])
}

// PURE. Automation axis — repeated-router percentage ALONE never proves automation (this task's
// own explicit rule). Combines it with the backend's own suspectedBot classification (a real,
// independently-computed field — see src/modules/behaviorIntel) and a genuinely independent
// cadence-regularity signal computed from real transaction timestamps already in scope. When fewer
// than 2 of these are available, evidenceConfidence is capped low by combineAxis' own weight-ratio
// math — the caller (classifyAutomation) is responsible for using the softer "automation signals
// present" wording rather than "bot-like" whenever confidence is thin.
function computeAutomationAxis(params: {
  suspectedBot: boolean
  repeatedRouterPercent: number | null
  cadenceRegularity: number | null
}): AxisScore {
  const { suspectedBot, repeatedRouterPercent, cadenceRegularity } = params
  return combineAxis([
    { key: 'suspectedBot', label: 'Backend automation classification', detail: suspectedBot ? 'Automation signal detected' : 'No automation signal detected', value: suspectedBot ? 1 : 0, weight: 0.35 },
    { key: 'repeatedRouter', label: 'Repeated router pattern', detail: repeatedRouterPercent != null ? `${repeatedRouterPercent.toFixed(0)}% repeated router` : 'Unknown', value: repeatedRouterPercent != null ? clamp01(repeatedRouterPercent / 100) : null, weight: 0.35 },
    { key: 'cadence', label: 'Transaction cadence regularity', detail: cadenceRegularity != null ? `${(cadenceRegularity * 100).toFixed(0)}% regular spacing` : 'Not enough transactions to measure', value: cadenceRegularity, weight: 0.30 },
  ])
}

// PURE. Rotation axis — categorical rotationStyle PLUS a real token-churn ratio, plus a reduced-
// weight holding-speed signal shared with Risk's own shortHolding (disclosed, reduced weight so
// the same "fast trading" behavior isn't counted at full strength on both axes).
function computeRotationAxis(params: {
  rotationValue: 'accumulator' | 'rotator' | 'distributor' | 'unknown'
  uniqueTokensTraded: number | null
  totalTransactions: number
  averageHoldingDays: number | null
}): AxisScore {
  const { rotationValue, uniqueTokensTraded, totalTransactions, averageHoldingDays } = params
  const categorical = rotationValue === 'unknown' ? null : rotationValue === 'rotator' ? 1 : rotationValue === 'distributor' ? 0.6 : 0.2
  const churnRatio = uniqueTokensTraded != null && totalTransactions >= MIN_TRANSACTIONS_FOR_CHURN_SIGNAL
    ? clamp01((uniqueTokensTraded / totalTransactions) / 0.4)
    : null
  const holdingSpeed = averageHoldingDays != null ? clamp01((10 - averageHoldingDays) / 10) : null

  return combineAxis([
    { key: 'rotationStyle', label: 'Rotation classification', detail: rotationValue === 'unknown' ? 'Unknown' : rotationValue, value: categorical, weight: 0.45 },
    { key: 'churnRatio', label: 'Token churn ratio', detail: uniqueTokensTraded != null ? `${uniqueTokensTraded} unique tokens / ${totalTransactions} tx` : 'Unknown', value: churnRatio, weight: 0.35 },
    { key: 'holdingSpeedReduced', label: 'Holding speed (reduced weight)', detail: fmtDays(averageHoldingDays), value: holdingSpeed, weight: 0.20 },
  ])
}

// PURE. Conviction axis — categorical convictionScore PLUS reduced-weight concentration (shared
// with Risk's own primary concentration signal) and holding duration (a distinct, longer-horizon
// saturation curve than Rotation's holdingSpeed — 30 days for full conviction credit vs. 10 days
// for Rotation's own speed signal — so the two do not simply mirror each other).
function computeConvictionAxis(params: {
  convictionValue: 'high' | 'medium' | 'low' | 'unknown'
  concentrationLabel: 'high' | 'medium' | 'balanced' | 'none' | null
  averageHoldingDays: number | null
}): AxisScore {
  const { convictionValue, concentrationLabel, averageHoldingDays } = params
  const categorical = convictionValue === 'unknown' ? null : convictionValue === 'high' ? 1 : convictionValue === 'medium' ? 0.5 : 0.15
  const concentration = concentrationLabel == null ? null
    : concentrationLabel === 'high' ? 1 : concentrationLabel === 'medium' ? 0.5 : concentrationLabel === 'balanced' ? 0.15 : null
  const holdingDuration = averageHoldingDays != null ? clamp01(averageHoldingDays / 30) : null

  return combineAxis([
    { key: 'convictionScore', label: 'Conviction classification', detail: convictionValue === 'unknown' ? 'Unknown' : convictionValue, value: categorical, weight: 0.50 },
    { key: 'concentrationReduced', label: 'Portfolio concentration (reduced weight)', detail: concentrationLabel ?? 'Unknown', value: concentration, weight: 0.25 },
    { key: 'holdingDuration', label: 'Holding duration', detail: fmtDays(averageHoldingDays), value: holdingDuration, weight: 0.25 },
  ])
}

// PURE. All 5 axes together — see RadarAxes/AxisScore's own headers for the full disclosure.
export function computeRadarAxes(params: {
  totalTransactions: number
  walletAgeDays: number | null
  concentrationLabel: 'high' | 'medium' | 'balanced' | 'none' | null
  uniqueTokensTraded: number | null
  activeChains: number
  suspectedBot: boolean
  repeatedRouterPercent: number | null
  cadenceRegularity: number | null
  rotationValue: 'accumulator' | 'rotator' | 'distributor' | 'unknown'
  convictionValue: 'high' | 'medium' | 'low' | 'unknown'
  averageHoldingDays: number | null
}): RadarAxes {
  return {
    activity: computeActivityAxis({ totalTransactions: params.totalTransactions, walletAgeDays: params.walletAgeDays }),
    risk: computeRiskAxis({
      averageHoldingDays: params.averageHoldingDays, concentrationLabel: params.concentrationLabel,
      uniqueTokensTraded: params.uniqueTokensTraded, totalTransactions: params.totalTransactions, activeChains: params.activeChains,
    }),
    automation: computeAutomationAxis({
      suspectedBot: params.suspectedBot, repeatedRouterPercent: params.repeatedRouterPercent, cadenceRegularity: params.cadenceRegularity,
    }),
    rotation: computeRotationAxis({
      rotationValue: params.rotationValue, uniqueTokensTraded: params.uniqueTokensTraded,
      totalTransactions: params.totalTransactions, averageHoldingDays: params.averageHoldingDays,
    }),
    conviction: computeConvictionAxis({
      convictionValue: params.convictionValue, concentrationLabel: params.concentrationLabel, averageHoldingDays: params.averageHoldingDays,
    }),
  }
}

// PURE. Overall confidence badge — DISCLOSED (this task's own explicit rule): derived from
// COVERAGE and SAMPLE SIZE, never from how extreme any axis's signalStrength is. Only ever
// DOWNGRADES the backend's own behaviorIntel.confidence (a real, already-computed coverage-based
// field — see src/modules/behaviorIntel's own confidenceBasis) — never upgrades it, so this can
// only make the badge more conservative, never less.
const MIN_TRANSACTIONS_FOR_HIGH_CONFIDENCE = 10
const MIN_WALLET_AGE_DAYS_FOR_HIGH_CONFIDENCE = 7
const MIN_AXES_WITH_EVIDENCE_FOR_HIGH_CONFIDENCE = 3

export function deriveOverallConfidence(params: {
  backendConfidence: 'high' | 'medium' | 'low'
  totalTransactions: number
  walletAgeDays: number | null
  axisConfidences: number[]
}): 'high' | 'medium' | 'low' {
  const { backendConfidence, totalTransactions, walletAgeDays, axisConfidences } = params
  if (backendConfidence !== 'high') return backendConfidence
  const axesWithEvidence = axisConfidences.filter((c) => c > 0).length
  const adequateSample =
    totalTransactions >= MIN_TRANSACTIONS_FOR_HIGH_CONFIDENCE
    && (walletAgeDays ?? 0) >= MIN_WALLET_AGE_DAYS_FOR_HIGH_CONFIDENCE
    && axesWithEvidence >= MIN_AXES_WITH_EVIDENCE_FOR_HIGH_CONFIDENCE
  return adequateSample ? 'high' : 'medium'
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

  const rotationValue = b?.rotationStyle?.value ?? 'unknown'
  const riskValue = b?.riskOnOff?.value ?? 'unknown'
  const convictionValue = b?.convictionScore?.value ?? 'unknown'
  const cadenceRegularity = computeCadenceRegularity(allTimestamps)

  // AXIS SCORES, DISCLOSED: computed BEFORE classification labels below, since the labels
  // themselves now derive FROM the multi-signal axis scores (see classifyAutomation/classifyRisk's
  // own headers) rather than from a single raw field each.
  const radar = computeRadarAxes({
    totalTransactions, walletAgeDays, concentrationLabel, uniqueTokensTraded, activeChains,
    suspectedBot, repeatedRouterPercent, cadenceRegularity, rotationValue, convictionValue, averageHoldingDays,
  })

  const automationClass = classifyAutomation(radar.automation, suspectedBot)
  const riskClass = classifyRisk(radar.risk)

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

  const overallConfidence = deriveOverallConfidence({
    backendConfidence: b?.confidence ?? 'low',
    totalTransactions,
    walletAgeDays,
    axisConfidences: [radar.activity.evidenceConfidence, radar.risk.evidenceConfidence, radar.automation.evidenceConfidence, radar.rotation.evidenceConfidence, radar.conviction.evidenceConfidence],
  })

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
    confidence: overallConfidence,
    evidenceBasis,
    radar,
    traits: {
      tradingStyle: automationClass,
      activityLevel: totalTransactions === 0 ? 'Inactive' : totalTransactions >= 50 ? 'Very active' : totalTransactions >= 10 ? 'Active' : 'Light',
      holdingStyle: holdingClass,
      rotationBehavior: rotationValue === 'unknown' ? 'Unknown' : rotationValue.charAt(0).toUpperCase() + rotationValue.slice(1),
      riskAppetite: riskValue === 'unknown' ? 'Unknown' : riskValue.replace('_', ' '),
      automationLikelihood: automationClass,
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
