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

export interface RadarValuationCardDisplay {
  label: 'Market cap' | 'FDV' | 'Valuation'
  value: string
  sublabel: string | null
}

/**
 * Card-level valuation display per priority: verified marketCapUsd -> FDV fallback -> unavailable.
 * Never labels an FDV fallback value as a verified market cap.
 */
export function getRadarValuationCardDisplay(valuation: RadarValuationResult, fmtUSD: (value: number) => string): RadarValuationCardDisplay {
  if (valuation.basis === 'verified_market_cap' && valuation.valueUsd != null) {
    return { label: 'Market cap', value: fmtUSD(valuation.valueUsd), sublabel: 'Verified' }
  }
  if (valuation.basis === 'fdv_fallback' && valuation.valueUsd != null) {
    return { label: 'FDV', value: fmtUSD(valuation.valueUsd), sublabel: 'Market cap unavailable' }
  }
  return { label: 'Valuation', value: 'Open check', sublabel: null }
}

export interface RadarValuationDrawerDisplay {
  marketCapLabel: string
  marketCapValue: string
  fdvLabel: string
  fdvValue: string
  note: string | null
}

/**
 * Drawer/details valuation display. When FDV fallback is used, market cap is shown
 * explicitly as "Unverified" alongside the FDV value and a note explaining the fallback.
 */
export function getRadarValuationDrawerDisplay(valuation: RadarValuationResult, fdvUsd: number | null | undefined, fmtUSD: (value: number) => string): RadarValuationDrawerDisplay {
  if (valuation.basis === 'fdv_fallback' && valuation.valueUsd != null) {
    return {
      marketCapLabel: 'Market cap',
      marketCapValue: 'Unverified',
      fdvLabel: 'FDV',
      fdvValue: fmtUSD(valuation.valueUsd),
      note: 'FDV shown because verified market cap is unavailable.',
    }
  }
  if (valuation.basis === 'verified_market_cap' && valuation.valueUsd != null) {
    return {
      marketCapLabel: 'Market cap',
      marketCapValue: fmtUSD(valuation.valueUsd),
      fdvLabel: 'FDV',
      fdvValue: typeof fdvUsd === 'number' && Number.isFinite(fdvUsd) && fdvUsd > 0 ? fmtUSD(fdvUsd) : 'Open check',
      note: null,
    }
  }
  return {
    marketCapLabel: 'Market cap',
    marketCapValue: 'Open check',
    fdvLabel: 'FDV',
    fdvValue: 'Open check',
    note: null,
  }
}

/**
 * CORTEX wording for valuation. Only fires when FDV fallback is used; verified
 * market cap and unavailable valuations need no extra CORTEX explanation here.
 */
export function getRadarCortexValuationLine(valuation: RadarValuationResult): string | null {
  if (valuation.basis === 'fdv_fallback') {
    return 'Verified market cap is unavailable, so FDV is shown as fallback valuation.'
  }
  return null
}
