const PROVIDER_NAME_REPLACEMENTS: Array<[RegExp, string]> = [
  [/geckoterminal/gi, 'Market data'],
  [/gecko\s*terminal/gi, 'Market data'],
  [/dexscreener/gi, 'Market data'],
  [/dex\s*screener/gi, 'Market data'],
  [/coingecko/gi, 'Market data'],
  [/goldrush/gi, 'Holder evidence'],
  [/covalent/gi, 'Holder evidence'],
  [/moralis/gi, 'Transfer evidence'],
  [/alchemy/gi, 'Contract evidence'],
  [/honeypot\.is/gi, 'Simulation evidence'],
  [/honeypot provider/gi, 'Simulation evidence'],
  [/basescan/gi, 'Contract evidence'],
  [/zerion/gi, 'Market data'],
  [/pinklock/gi, 'Lock evidence'],
  [/goplus/gi, 'Simulation evidence'],
  [/gmgn/gi, 'Market data'],
]

function sanitizePublicString(value: string): string {
  return PROVIDER_NAME_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
}

function sanitizePublicValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizePublicString(value)
  if (Array.isArray(value)) return value.map(sanitizePublicValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sourceTrail') continue
    if (key === 'cortexScoreDebug') continue
    if (key === 'holders' && Array.isArray(raw)) continue
    if (key === 'transfers' && Array.isArray(raw)) continue
    out[key] = sanitizePublicValue(raw)
  }
  return out
}

export function sanitizePublicTokenResponse<T extends Record<string, any>>(payload: T, debugMode: boolean): T {
  if (debugMode) return payload
  const sanitized = sanitizePublicValue(payload) as T
  delete (sanitized as any).gtRaw
  delete (sanitized as any).gtPools
  delete (sanitized as any).gmgn
  delete (sanitized as any).holders
  delete (sanitized as any).securityDiagnostics
  delete (sanitized as any).cortexScore
  delete (sanitized as any).cortexVerdict
  delete (sanitized as any).cortexConfidence
  delete (sanitized as any).scoreReasons
  delete (sanitized as any).missingScoreInputs
  delete (sanitized as any).scoreCoveragePercent
  delete (sanitized as any).cortexScoreDebug
  delete (sanitized as any)._debug
  delete (sanitized as any)._diagnostics
  delete (sanitized as any)._timing
  delete (sanitized as any).debugHolderStatus
  if ((sanitized as any).holderDistribution?.topHolders) {
    ;(sanitized as any).holderDistribution.topHolders = (sanitized as any).holderDistribution.topHolders.slice(0, 10)
  }
  if ((sanitized as any).devIntel?.holderDistribution?.topHolders) {
    ;(sanitized as any).devIntel.holderDistribution.topHolders = (sanitized as any).devIntel.holderDistribution.topHolders.slice(0, 10)
  }
  if ((sanitized as any).sections?.contractChecks) {
    delete (sanitized as any).sections.contractChecks.totalSupply
    delete (sanitized as any).sections.contractChecks.decimalsRpc
    delete (sanitized as any).sections.contractChecks.nameFallback
    delete (sanitized as any).sections.contractChecks.symbolFallback
  }
  if ((sanitized as any).rugRisk) {
    ;(sanitized as any).rugRisk = {
      score: (sanitized as any).rugRisk.score ?? (sanitized as any).riskEngine?.rugRiskScore ?? null,
      label: (sanitized as any).rugRisk.label ?? (sanitized as any).riskEngine?.rugRiskLabel ?? null,
      status: (sanitized as any).rugRisk.status ?? null,
    }
  }
  // riskEngine.rugRiskScore/rugRiskLabel are the legacy V1 score — competes with the
  // public Token Safety Score (riskScore/riskLabel/riskBreakdown), debug-only.
  if ((sanitized as any).riskEngine) {
    delete (sanitized as any).riskEngine.rugRiskScore
    delete (sanitized as any).riskEngine.rugRiskLabel
  }
  // lp_data_mode raw value ('strict'|'minimal'|'fallback'|'insufficient') is internal —
  // public callers get the normalized lpDataMode field instead.
  delete (sanitized as any).lpDataModeRaw
  if ((sanitized as any).priceChart?.points?.length > 150) {
    ;(sanitized as any).priceChart = { ...(sanitized as any).priceChart, points: (sanitized as any).priceChart.points.slice(-150) }
  }
  if ((sanitized as any).projectSocials) {
    delete (sanitized as any).projectSocials.sourceTrail
  }
  return sanitized
}
