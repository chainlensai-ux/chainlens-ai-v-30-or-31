// Raw DEX/pool-source identifiers (e.g. "aerodrome-base", "uniswap-v3-base") are internal —
// public text shows the neutral DEX brand name instead. Order matters: more specific
// (versioned/network-suffixed) patterns must run before their generic catch-alls.
const DEX_LABEL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/aerodrome[-_\s]*slipstream/gi, 'Aerodrome Slipstream'],
  // The trailing `(?:v2|base)` suffix must only be consumed together with its
  // separator — an unanchored `[-_\s]*` would otherwise swallow a trailing space
  // when no suffix follows (e.g. "aerodrome is" -> "Aerodromeis").
  [/aerodrome(?:[-_\s]*(?:v2|base))?/gi, 'Aerodrome'],
  [/uniswap[-_\s]*v4(?:[-_\s]*base)?/gi, 'Uniswap V4'],
  [/uniswap[-_\s]*v3(?:[-_\s]*base)?/gi, 'Uniswap V3'],
  [/uniswap[-_\s]*v2(?:[-_\s]*base)?/gi, 'Uniswap V2'],
  [/uniswap/gi, 'Uniswap'],
  [/pancakeswap[-_\s]*v3(?:[-_\s]*base)?/gi, 'PancakeSwap V3'],
  [/pancakeswap[-_\s]*v2(?:[-_\s]*base)?/gi, 'PancakeSwap V2'],
  [/pancakeswap/gi, 'PancakeSwap'],
  [/baseswap[-_\s]*v2/gi, 'BaseSwap'],
  [/baseswap/gi, 'BaseSwap'],
  [/sushiswap[-_\s]*v3/gi, 'SushiSwap V3'],
  [/sushiswap[-_\s]*v2/gi, 'SushiSwap V2'],
  [/sushiswap/gi, 'SushiSwap'],
  [/alienbase/gi, 'AlienBase'],
  [/swapbased/gi, 'SwapBased'],
]

const PROVIDER_NAME_REPLACEMENTS: Array<[RegExp, string]> = [
  ...DEX_LABEL_REPLACEMENTS,
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


function formatTokenSafetyScore(payload: Record<string, any>): string {
  const score = typeof payload.riskScore === 'number' ? payload.riskScore : null
  const rawLabel = typeof payload.riskLabel === 'string' ? payload.riskLabel : null
  const label = rawLabel ? ` (${rawLabel})` : ''
  return score == null ? `Token Safety Score${label}` : `Token Safety Score: ${score}/100${label}`
}



function tokenSafetyAdjective(score: number | null, fallbackLabel: string | null): string | null {
  if (score == null) return fallbackLabel
  if (score <= 24) return 'very low'
  if (score <= 39) return 'low'
  if (score <= 59) return 'moderate'
  if (score <= 74) return 'watchlist'
  return 'stronger'
}

function formatTokenIdentityForPublic(name: string | null | undefined, symbol: string | null | undefined): string {
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : ''
  const cleanSymbol = typeof symbol === 'string' && symbol.trim() ? symbol.trim() : ''
  if (cleanName && cleanSymbol && cleanName !== cleanSymbol) return `${cleanName} (${cleanSymbol})`
  if (cleanName) return cleanName
  if (cleanSymbol) return cleanSymbol
  return 'This token'
}

function tokenSafetySentence(payload: Record<string, any>): string {
  const symbol = typeof payload.symbol === 'string' && payload.symbol.trim() ? payload.symbol.trim() : null
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null
  const identity = formatTokenIdentityForPublic(name, symbol)
  const score = typeof payload.riskScore === 'number' ? payload.riskScore : null
  const rawLabel = typeof payload.riskLabel === 'string' && payload.riskLabel.trim() ? payload.riskLabel.trim() : null
  const label = tokenSafetyAdjective(score, rawLabel)
  const holderDistribution = payload.holderDistribution && typeof payload.holderDistribution === 'object' ? payload.holderDistribution as Record<string, any> : {}
  const top1 = typeof holderDistribution.top1 === 'number' ? holderDistribution.top1 : null
  const top10 = typeof holderDistribution.top10 === 'number' ? holderDistribution.top10 : null
  const top20 = typeof holderDistribution.top20 === 'number' ? holderDistribution.top20 : null
  const holderCount = typeof holderDistribution.holderCount === 'number' ? holderDistribution.holderCount : null
  const ownershipStatus = payload.security?.devOwnership?.ownershipStatus ?? payload.sections?.ownership?.status ?? null
  const creatorSupply = payload.creatorHolderPercent ?? payload.supplyControl?.creatorHolderPercent ?? null
  const clusterSupply = payload.devClusterSupplyPercent ?? payload.supplyControl?.devClusterSupplyPercent ?? null
  const activeOwner = ownershipStatus === 'active_owner' || payload.security?.devOwnership?.activeOwner === true
  const highHolderConcentration = Boolean((top1 != null && top1 >= 40) || (top10 != null && top10 >= 70) || (top20 != null && top20 >= 85) || (holderCount != null && holderCount < 75))
  const severeHolderDev = Boolean(
    (typeof clusterSupply === 'number' && clusterSupply >= 50)
    || (typeof creatorSupply === 'number' && creatorSupply >= 50)
  )
  const scorePart = score != null && label
    ? `has a ${label} Token Safety Score (${score}/100)`
    : label
      ? `has a ${label} Token Safety Score`
      : score != null
        ? `has a Token Safety Score of ${score}/100`
        : 'has a Token Safety Score'
  if (severeHolderDev) return `${identity} ${scorePart}, with severe holder/dev-control risk drivers.`
  if (highHolderConcentration && activeOwner) return `${identity} ${scorePart}. Score is pressured by high holder concentration and active owner/admin control.`
  const broadHolders = top1 != null && top1 <= 10 && top10 != null && top10 <= 20 && holderCount != null && holderCount >= 100
  const renounced = ownershipStatus === 'renounced' || payload.security?.devOwnership?.isRenounced === true || payload.sections?.ownership?.is_renounced === true
  if (broadHolders && renounced) {
    return 'Holder distribution appears broad and ownership is renounced. Main open checks are fallback-only pool identity, LP model/control verification, simulation/tax status, FDV-only valuation, and missing socials.'
  }
  return `${identity} ${scorePart}; no severe holder/dev-control risk drivers were confirmed from current evidence.`
}

function rewriteLegacyRiskSummaryText(text: string, payload: Record<string, any>): string {
  return text
    .replace(/^(?:Base|Ethereum) token\.\s*/i, '')
    .replace(/Rug-risk pressure:\s*\d+\s*\/\s*100\.?/gi, `${formatTokenSafetyScore(payload)}.`)
}

function rewriteLegacyRiskSummaryValues(value: unknown, payload: Record<string, any>): unknown {
  if (typeof value === 'string') return rewriteLegacyRiskSummaryText(value, payload)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = rewriteLegacyRiskSummaryValues(value[index], payload)
    return value
  }
  if (!value || typeof value !== 'object') return value
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    ;(value as Record<string, unknown>)[key] = rewriteLegacyRiskSummaryValues(raw, payload)
  }
  return value
}

function sanitizePublicString(value: string): string {
  return PROVIDER_NAME_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
}

function publicSamplingReason(value: unknown): unknown {
  if (value === 'no_bounded_candidate_source') return 'No bounded position-candidate source is available yet for this pool.'
  if (value === 'no_matching_candidates') return 'No matching position candidates were available from current indexed evidence.'
  if (value === 'sampling_attempt_failed') return 'Position-owner sampling could not be completed from current evidence.'
  return value
}

function sanitizePublicValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizePublicString(value)
  if (Array.isArray(value)) return value.map(sanitizePublicValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sourceTrail') continue
    if (key === 'cortexScoreDebug') continue
    if (key === 'samplingDebug') continue
    if (key === 'samplingReason') {
      out[key] = sanitizePublicValue(publicSamplingReason(raw))
      continue
    }
    if (key === 'holders' && Array.isArray(raw)) continue
    if (key === 'transfers' && Array.isArray(raw)) continue
    out[key] = sanitizePublicValue(raw)
  }
  return out
}

export function sanitizePublicTokenResponse<T extends Record<string, any>>(payload: T, debugMode: boolean): T {
  if (debugMode) return payload
  const sanitized = sanitizePublicValue(payload) as T
  if (typeof (sanitized as any).chain === 'string' && (sanitized as any).resolvedInput && typeof (sanitized as any).resolvedInput === 'object') {
    ;(sanitized as any).resolvedInput.requestedChain = (sanitized as any).chain
  }
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
      status: (sanitized as any).rugRisk.status ?? null,
    }
  }
  // riskEngine.rugRiskScore/rugRiskLabel are the legacy V1 score — competes with the
  // public Token Safety Score (riskScore/riskLabel/riskBreakdown), debug-only.
  if ((sanitized as any).riskEngine) {
    delete (sanitized as any).riskEngine.rugRiskScore
    delete (sanitized as any).riskEngine.rugRiskLabel
    rewriteLegacyRiskSummaryValues((sanitized as any).riskEngine.clarkInterpretation, sanitized as Record<string, any>)
  }
  // lp_data_mode raw value ('strict'|'minimal'|'fallback'|'insufficient') is internal —
  // public callers get the normalized lpDataMode field instead. cortexLpRead.mode and any
  // "(data mode: ...)" text it embeds must match the public mode, never say "fallback"
  // when the public mode is evidence_based/resolved/indexed.
  const lpDataModeRawValue = (sanitized as any).lpDataModeRaw as string | undefined
  const lpDataModePublicValue = (sanitized as any).lpDataMode as string | undefined
  delete (sanitized as any).lpDataModeRaw
  if ((sanitized as any).cortexLpRead && lpDataModeRawValue) {
    const displayMode = lpDataModePublicValue === 'evidence_based' ? 'evidence-based' : lpDataModePublicValue ?? lpDataModeRawValue
    const cortexLpRead = (sanitized as any).cortexLpRead
    if (typeof cortexLpRead.mode === 'string') cortexLpRead.mode = displayMode
    if (typeof cortexLpRead.riskSummary === 'string') {
      cortexLpRead.riskSummary = cortexLpRead.riskSummary.replace(
        new RegExp(`data mode:\\s*${lpDataModeRawValue}`, 'gi'),
        `data mode: ${displayMode}`
      )
    }
  }
  // cortexLpRead.riskSummary's "shows an overall ... risk tier" wording is built from the
  // legacy rugRiskLabel tier, which can disagree with the canonical Token Safety Score
  // (e.g. a "critical" LP-risk tier alongside a 49/100 "moderate" overall score). Replace it
  // with the canonical score/label so the public summary never names a different tier than
  // riskScore/riskLabel.
  if (typeof (sanitized as any).cortexLpRead?.riskSummary === 'string') {
    const cortexLpRead = (sanitized as any).cortexLpRead
    cortexLpRead.riskSummary = cortexLpRead.riskSummary.replace(
      /^(?:(?:[^.]*?\([^)]*\)|[^.]*?)\s+)?shows an overall \"[^\"]*\" risk tier based on observed pool data\./i,
      tokenSafetySentence(sanitized as Record<string, any>)
    )
  }
  if ((sanitized as any).priceChart?.points?.length > 150) {
    ;(sanitized as any).priceChart = { ...(sanitized as any).priceChart, points: (sanitized as any).priceChart.points.slice(-150) }
  }
  if ((sanitized as any).projectSocials) {
    delete (sanitized as any).projectSocials.sourceTrail
  }
  // When LP lock/burn proof is an open check, public lpProofStatus/lpEvidenceSummary/
  // sections.liquidity.lpLockBurnProofStatus should say "open_check" rather than the
  // internal "missing"/"partial" wording, which reads as more alarming than warranted.
  if ((sanitized as any).lpLockBurnIntel?.lockBurnProof === 'open_check') {
    if ((sanitized as any).lpProofStatus === 'missing' || (sanitized as any).lpProofStatus === 'partial') {
      ;(sanitized as any).lpProofStatus = 'open_check'
    }
    if (typeof (sanitized as any).lpEvidenceSummary === 'string') {
      ;(sanitized as any).lpEvidenceSummary = (sanitized as any).lpEvidenceSummary.replace(
        /Proof status:\s*(missing|partial)/i,
        'Proof status: open_check'
      )
    }
    const lpLockBurnProofStatus = (sanitized as any).sections?.liquidity?.lpLockBurnProofStatus
    if (lpLockBurnProofStatus === 'missing' || lpLockBurnProofStatus === 'partial') {
      ;(sanitized as any).sections.liquidity.lpLockBurnProofStatus = 'open_check'
    }
  }
  rewriteLegacyRiskSummaryValues(sanitized, sanitized as Record<string, any>)
  return sanitized
}
