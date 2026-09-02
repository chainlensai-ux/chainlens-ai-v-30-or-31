export type RiskScoreType = 'risk_score' | 'safety_score' | 'unknown'
export type CanonicalRiskLabel = 'Low Risk' | 'Moderate Risk' | 'Caution' | 'High Risk' | 'Extreme Risk'

export const CANONICAL_RISK_THRESHOLD = '0-20 low; 21-40 moderate; 41-60 caution; 61-75 high; 76-100 extreme' as const
export const CAUTION_ELEVATED_COPY = 'Elevated risk — missing LP/dev verification'
export const RISK_SCORE_CONFIDENCE_NOTE =
  'Score calculated from available evidence. Missing checks reduce confidence or add caution, but do not automatically make it extreme.'

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
  copy: string | null
  audit: RiskScoreDirectionAudit
}

function boundedScore(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null
}

export function riskLabelFromCanonicalScore(score: number | null): CanonicalRiskLabel | null {
  if (score == null) return null
  if (score <= 20) return 'Low Risk'
  if (score <= 40) return 'Moderate Risk'
  if (score <= 60) return 'Caution'
  if (score <= 75) return 'High Risk'
  return 'Extreme Risk'
}

export function coerceCanonicalRiskLabel(label: string | null | undefined): CanonicalRiskLabel | null {
  if (!label) return null
  const raw = label.trim()
  if (raw === 'Low Risk' || raw === 'low' || raw === 'very_low' || raw === 'Very Low Risk') return 'Low Risk'
  if (raw === 'Moderate Risk' || raw === 'Medium Risk' || raw === 'moderate' || raw === 'medium') return 'Moderate Risk'
  if (raw === 'Caution' || raw === 'Elevated Risk' || raw === 'elevated' || raw === 'caution') return 'Caution'
  if (raw === 'High Risk' || raw === 'high') return 'High Risk'
  if (raw === 'Extreme Risk' || raw === 'Critical Risk' || raw === 'extreme' || raw === 'critical') return 'Extreme Risk'
  return null
}

export function riskLabelCopy(label: CanonicalRiskLabel | string | null | undefined): string | null {
  return coerceCanonicalRiskLabel(label) === 'Caution' ? CAUTION_ELEVATED_COPY : null
}

export function riskGaugeFillPercent(score: number | null): number {
  return score == null ? 0 : Math.max(0, Math.min(100, score))
}

export function riskColorFromCanonicalLabel(label: CanonicalRiskLabel | string | null): string {
  const canonical = coerceCanonicalRiskLabel(label)
  if (canonical === 'Low Risk') return '#34d399'
  if (canonical === 'Moderate Risk') return '#fbbf24'
  if (canonical === 'Caution') return '#f59e0b'
  if (canonical === 'High Risk') return '#f97316'
  if (canonical === 'Extreme Risk') return '#f87171'
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
  const copy = riskLabelCopy(riskLabel)
  const topDriver = input.riskDrivers?.find((driver) => typeof driver === 'string' && driver.trim())?.trim() ?? null
  const explanation = riskScore0To100 == null
    ? input.rawScoreType === 'unknown' && rawScore != null
      ? 'Risk Score is unavailable because the source score direction was not recorded. Rescan to refresh it.'
      : 'Risk Score is unavailable because no numeric risk evidence was returned.'
    : `${inverted ? 'Converted once from the source Safety Score. ' : ''}Risk Score: ${riskScore0To100}/100 — ${riskLabel}. Higher scores mean higher risk. ${RISK_SCORE_CONFIDENCE_NOTE}${copy ? ` ${copy}` : ''}${topDriver ? ` Top driver: ${topDriver}` : ''}`
  return {
    riskScore0To100,
    riskLabel,
    scoreDirection: 'higher_is_riskier',
    confidence,
    explanation,
    copy,
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
