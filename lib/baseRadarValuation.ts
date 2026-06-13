export type RadarValuationBasis = 'verified_market_cap' | 'fdv_fallback' | 'unavailable'

export interface RadarValuationInput {
  marketCapUsd?: number | null
  marketCapStatus?: string | null
  fdvUsd?: number | null
  liquidityUsd?: number | null
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

export interface ResolvedFallbackMarketCap {
  marketCapUsd: number | null
  marketCapStatus: 'verified' | null
}

/**
 * Maps a real marketCap/marketCapUsd value from a fallback market payload to a
 * verified marketCapUsd. FDV must never be inferred as market cap here — callers
 * pass only the fallback payload's marketCap field, not its FDV.
 */
export function resolveFallbackMarketCap(fallbackMarketCapUsd: number | null | undefined): ResolvedFallbackMarketCap {
  if (typeof fallbackMarketCapUsd === 'number' && Number.isFinite(fallbackMarketCapUsd) && fallbackMarketCapUsd > 0) {
    return { marketCapUsd: fallbackMarketCapUsd, marketCapStatus: 'verified' }
  }
  return { marketCapUsd: null, marketCapStatus: null }
}

export interface BaseRadarMarketCapRawInput {
  dexPair?: Record<string, unknown> | null
  geckoPool?: { attributes?: Record<string, unknown> | null } | null
  normalized?: Record<string, unknown> | null
}

export type BaseRadarMarketCapSourceKind = 'market_api' | null

export interface ResolvedBaseRadarMarketCap {
  marketCapUsd: number | null
  marketCapStatus: 'verified' | 'unavailable'
  sourceKind: BaseRadarMarketCapSourceKind
  reason: string
}

function finitePositiveNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Centralized Base Radar market cap resolver. Checks known raw market-cap fields
 * across DexScreener pair, GeckoTerminal pool attributes, and normalized shapes —
 * first finite positive value wins. Market cap is never inferred from FDV here.
 */
export function resolveBaseRadarMarketCap(input: BaseRadarMarketCapRawInput): ResolvedBaseRadarMarketCap {
  const dexPair = input.dexPair ?? {}
  const geckoAttrs = input.geckoPool?.attributes ?? {}
  const normalized = input.normalized ?? {}

  const candidates: unknown[] = [
    (dexPair as Record<string, unknown>).marketCap,
    (dexPair as Record<string, unknown>).marketCapUsd,
    (dexPair as Record<string, unknown>).market_cap,
    (dexPair as Record<string, unknown>).market_cap_usd,
    (geckoAttrs as Record<string, unknown>).market_cap_usd,
    (geckoAttrs as Record<string, unknown>).market_cap,
    (geckoAttrs as Record<string, unknown>).token_market_cap_usd,
    (geckoAttrs as Record<string, unknown>).base_token_market_cap_usd,
    (normalized as Record<string, unknown>).marketCapUsd,
    (normalized as Record<string, unknown>).market_cap_usd,
    (normalized as Record<string, unknown>).marketCap,
  ]

  for (const candidate of candidates) {
    const value = finitePositiveNumber(candidate)
    if (value != null) {
      return { marketCapUsd: value, marketCapStatus: 'verified', sourceKind: 'market_api', reason: 'Explicit market cap found in raw market data.' }
    }
  }

  return { marketCapUsd: null, marketCapStatus: 'unavailable', sourceKind: null, reason: 'No explicit market cap field present in raw market data.' }
}

/**
 * FDV sanity check. FDV is rejected as a fallback valuation if it is not a finite
 * positive number, or if it is implausible relative to liquidity. A real verified
 * market cap is never gated by this check.
 */
export function isFdvValid(fdvUsd: number | null | undefined, liquidityUsd?: number | null): boolean {
  if (typeof fdvUsd !== 'number' || !Number.isFinite(fdvUsd) || fdvUsd <= 0) return false
  const liquidity = typeof liquidityUsd === 'number' && Number.isFinite(liquidityUsd) ? liquidityUsd : 0
  if (liquidity > 0 && fdvUsd < liquidity) return false
  if (liquidity >= 1000 && fdvUsd < 100) return false
  return true
}

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

  if (isFdvValid(input.fdvUsd, input.liquidityUsd)) {
    return {
      basis: 'fdv_fallback',
      valueUsd: input.fdvUsd as number,
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
    reason: input.fdvUsd != null ? 'FDV VALUE FAILED SANITY CHECK' : 'No verified market cap or FDV available.',
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
  const liquidityUsd = typeof input.liquidityUsd === 'number' && Number.isFinite(input.liquidityUsd) ? input.liquidityUsd : 0
  const valuation = getRadarValuationBasis({
    marketCapUsd: input.marketCapUsd,
    marketCapStatus: input.marketCapStatus,
    fdvUsd: allowFdvFallback ? input.fdvUsd : null,
    liquidityUsd,
  })

  return {
    valuation,
    included: valuation.valueUsd !== null && valuation.valueUsd >= minValuationUsd && liquidityUsd >= minLiquidityUsd,
  }
}

export function getRadarValuationEvidenceGap(valuation: RadarValuationResult): string | null {
  if (valuation.basis === 'fdv_fallback') return 'Verified market cap not returned; FDV is shown as fallback valuation.'
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
