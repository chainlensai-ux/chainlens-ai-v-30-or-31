export type RiskScoreType = 'risk_score' | 'safety_score' | 'unknown'
export type CanonicalRiskLabel = 'Low Risk' | 'Medium Risk' | 'High Risk' | 'Critical Risk'

export const CANONICAL_RISK_THRESHOLD = '0-24 low; 25-49 medium; 50-74 high; 75-100 critical' as const

export type RiskScoreDirectionAudit = {
  rawScore: number | null
  rawScoreType: RiskScoreType
  convertedRiskScore: number | null
  finalRiskScore: number | null
  finalLabel: CanonicalRiskLabel | null
  scoreDirection: 'higher_is_riskier'
  sourceModule: string
  displayLocation: string
  inverted: boolean
  thresholdUsed: typeof CANONICAL_RISK_THRESHOLD
}

export type NormalizedRiskScore = {
  riskScore0To100: number | null
  riskLabel: CanonicalRiskLabel | null
  scoreDirection: 'higher_is_riskier'
  confidence: 'high' | 'medium' | 'low'
  explanation: string
  audit: RiskScoreDirectionAudit
}

function boundedScore(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null
}

export function riskLabelFromCanonicalScore(score: number | null): CanonicalRiskLabel | null {
  if (score == null) return null
  if (score <= 24) return 'Low Risk'
  if (score <= 49) return 'Medium Risk'
  if (score <= 74) return 'High Risk'
  return 'Critical Risk'
}

export function riskGaugeFillPercent(score: number | null): number {
  return score == null ? 0 : Math.max(0, Math.min(100, score))
}

export function riskColorFromCanonicalLabel(label: CanonicalRiskLabel | null): string {
  if (label === 'Low Risk') return '#34d399'
  if (label === 'Medium Risk') return '#fbbf24'
  if (label === 'High Risk') return '#f97316'
  if (label === 'Critical Risk') return '#f87171'
  return '#94a3b8'
}

export function normalizeRiskScore(input: {
  rawScore: unknown
  rawScoreType: RiskScoreType
  riskDrivers?: string[]
  confidence?: 'high' | 'medium' | 'low' | string | null
  source: string
  displayLocation?: string
}): NormalizedRiskScore {
  const rawScore = boundedScore(input.rawScore)
  const inverted = rawScore != null && input.rawScoreType === 'safety_score'
  // Unknown direction is not a Risk Score. Refuse to guess because a historical safety value
  // would otherwise be silently presented backwards.
  const riskScore0To100 = rawScore == null || input.rawScoreType === 'unknown' ? null : inverted ? 100 - rawScore : rawScore
  const riskLabel = riskLabelFromCanonicalScore(riskScore0To100)
  const confidence = input.confidence === 'high' || input.confidence === 'medium' || input.confidence === 'low' ? input.confidence : 'low'
  const topDriver = input.riskDrivers?.find((driver) => typeof driver === 'string' && driver.trim())?.trim() ?? null
  const explanation = riskScore0To100 == null
    ? input.rawScoreType === 'unknown' && rawScore != null
      ? 'Risk Score is unavailable because the source score direction was not recorded. Rescan to refresh it.'
      : 'Risk Score is unavailable because no numeric risk evidence was returned.'
    : `${inverted ? 'Converted once from the source Safety Score. ' : ''}Risk Score: ${riskScore0To100}/100 — ${riskLabel}. Higher scores mean higher risk.${topDriver ? ` Top driver: ${topDriver}` : ''}`
  return {
    riskScore0To100,
    riskLabel,
    scoreDirection: 'higher_is_riskier',
    confidence,
    explanation,
    audit: {
      rawScore,
      rawScoreType: input.rawScoreType,
      convertedRiskScore: riskScore0To100,
      finalRiskScore: riskScore0To100,
      finalLabel: riskLabel,
      scoreDirection: 'higher_is_riskier',
      sourceModule: input.source,
      displayLocation: input.displayLocation ?? 'not_supplied',
      inverted,
      thresholdUsed: CANONICAL_RISK_THRESHOLD,
    },
  }
}
