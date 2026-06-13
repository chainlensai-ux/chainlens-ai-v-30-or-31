export type RadarValuationBasis = 'verified_market_cap' | 'fdv_fallback' | 'unavailable'

export interface RadarValuationInput {
  marketCapUsd?: number | null
  marketCapStatus?: string | null
  fdvUsd?: number | null
}

export interface RadarValuationResult {
  basis: RadarValuationBasis
  valueUsd: number | null
  label: 'Market Cap' | 'FDV' | 'Unavailable'
  verified: boolean
  reason: string
}

export const DEFAULT_RADAR_MIN_VALUATION_USD = 15_000
export const DEFAULT_RADAR_MIN_LIQUIDITY_USD = 5_000
export const DEFAULT_RADAR_ALLOW_FDV_FALLBACK = true

export function getRadarValuationBasis(input: RadarValuationInput): RadarValuationResult {
  if (
    typeof input.marketCapUsd === 'number' &&
    Number.isFinite(input.marketCapUsd) &&
    input.marketCapUsd > 0 &&
    input.marketCapStatus === 'verified'
  ) {
    return {
      basis: 'verified_market_cap',
      valueUsd: input.marketCapUsd,
      label: 'Market Cap',
      verified: true,
      reason: 'Verified market cap available.',
    }
  }

  if (
    typeof input.fdvUsd === 'number' &&
    Number.isFinite(input.fdvUsd) &&
    input.fdvUsd > 0
  ) {
    return {
      basis: 'fdv_fallback',
      valueUsd: input.fdvUsd,
      label: 'FDV',
      verified: false,
      reason: 'Market cap unavailable; FDV used as fallback valuation.',
    }
  }

  return {
    basis: 'unavailable',
    valueUsd: null,
    label: 'Unavailable',
    verified: false,
    reason: 'No verified market cap or FDV available.',
  }
}

export function tokenPassesRadarValuationFilters(input: RadarValuationInput & {
  liquidityUsd?: number | null
  minValuationUsd?: number
  minLiquidityUsd?: number
  allowFdvFallback?: boolean
}): { included: boolean; valuation: RadarValuationResult } {
  const minValuationUsd = input.minValuationUsd ?? DEFAULT_RADAR_MIN_VALUATION_USD
  const minLiquidityUsd = input.minLiquidityUsd ?? DEFAULT_RADAR_MIN_LIQUIDITY_USD
  const allowFdvFallback = input.allowFdvFallback ?? DEFAULT_RADAR_ALLOW_FDV_FALLBACK
  const valuation = getRadarValuationBasis({
    marketCapUsd: input.marketCapUsd,
    marketCapStatus: input.marketCapStatus,
    fdvUsd: allowFdvFallback ? input.fdvUsd : null,
  })
  const liquidityUsd = typeof input.liquidityUsd === 'number' && Number.isFinite(input.liquidityUsd) ? input.liquidityUsd : 0

  return {
    valuation,
    included: valuation.valueUsd !== null && valuation.valueUsd >= minValuationUsd && liquidityUsd >= minLiquidityUsd,
  }
}

export function getRadarValuationEvidenceGap(valuation: RadarValuationResult): string | null {
  if (valuation.basis === 'fdv_fallback') return 'Market cap unavailable; FDV used as fallback valuation.'
  if (valuation.basis === 'unavailable') return 'Market valuation unavailable.'
  return null
}
