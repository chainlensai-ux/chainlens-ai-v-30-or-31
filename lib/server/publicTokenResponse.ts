// Strips diagnostics-only and legacy/competing-score fields from the /api/token
// response for normal (non-debug) public callers. Debug=true callers receive the
// payload untouched so existing diagnostics tooling keeps working.

const MAX_PUBLIC_CHART_POINTS = 150

export function sanitizePublicTokenResponse<T extends Record<string, unknown>>(payload: T, debugMode: boolean): T {
  if (debugMode) return payload

  const sanitized: Record<string, unknown> = { ...payload }

  // Legacy CORTEX Score V2 fields were duplicated at the top level; the canonical
  // copy lives under riskEngine.* and the public Token Safety Score is
  // riskScore/riskLabel/riskBreakdown — drop the top-level duplicates so they
  // cannot be mistaken for the product score.
  delete sanitized.cortexScore
  delete sanitized.cortexVerdict
  delete sanitized.cortexConfidence
  delete sanitized.scoreReasons
  delete sanitized.missingScoreInputs
  delete sanitized.scoreCoveragePercent
  delete sanitized.cortexScoreDebug

  // Raw lp_data_mode ('strict'|'minimal'|'fallback'|'insufficient') is internal —
  // public callers get the normalized lpDataMode field instead.
  delete sanitized.lpDataModeRaw

  const riskEngine = sanitized.riskEngine
  if (riskEngine && typeof riskEngine === 'object') {
    const { rugRiskScore, rugRiskLabel, cortexScoreDebug, ...restEngine } = riskEngine as Record<string, unknown>
    void rugRiskScore
    void rugRiskLabel
    void cortexScoreDebug
    sanitized.riskEngine = restEngine
  }

  const priceChart = sanitized.priceChart
  if (priceChart && typeof priceChart === 'object' && Array.isArray((priceChart as Record<string, unknown>).points)) {
    const points = (priceChart as Record<string, unknown>).points as unknown[]
    if (points.length > MAX_PUBLIC_CHART_POINTS) {
      sanitized.priceChart = { ...(priceChart as Record<string, unknown>), points: points.slice(-MAX_PUBLIC_CHART_POINTS) }
    }
  }

  return sanitized as T
}
