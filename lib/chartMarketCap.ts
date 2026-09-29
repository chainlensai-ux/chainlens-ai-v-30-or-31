// lib/chartMarketCap.ts — MCAP chart mode for the Token Scanner Price Chart (pure; no I/O).
//
// MCAP mode is the SAME genuine price candles multiplied by ONE circulating-supply figure:
//   mcapOpen/High/Low/Close = priceOpen/High/Low/Close × circulatingSupply;  volume unchanged (USD).
// No provider call, no new candles, no FDV.
//
// SUPPLY GATE — two levels, in priority order. Both require the scan's own VERIFIED current market cap
// (valuationContext.primaryValuationStatus === 'verified_mc', the Market Cap card's "verified" state):
//   A) VERIFIED SUPPLY BASIS  — the provider circulating_supply agrees with the verified market cap at
//      the scan price (within 15%): multiply by exactly that circulating_supply.
//   B) INFERRED CURRENT-MC BASIS — circulating_supply is unavailable, but the verified market cap and
//      the scan price are both usable: basis = verifiedMarketCap / price (a constant). This is NOT a
//      claim that historical circulating supply was independently verified; the UI labels it
//      "MCAP · inferred supply basis" with INFERRED_MCAP_BASIS_TOOLTIP.
// Everything else keeps PRICE (never FDV):
//   - 'estimated_mc' (on-chain TOTAL supply × price) or 'fdv_only' / 'partial'  -> "Verified market cap unavailable"
//   - verified market cap but no usable price                                    -> "Verified market cap unavailable"
//   - circulating_supply × price disagrees with the verified market cap         -> "Circulating supply does not match
//     the verified market cap" (a source mismatch is surfaced, never forced into parity or papered over by B).

import type { ChartCandle } from './priceChartCandles.ts'

export const MCAP_SUPPLY_TOLERANCE = 0.15

export type ChartMarketCapBasis = 'circulating_supply' | 'inferred_current_mc'

export const VERIFIED_MCAP_BASIS_TOOLTIP = 'Market cap = price × verified circulating supply'
export const INFERRED_MCAP_BASIS_TOOLTIP = 'Historical market cap is derived from verified current market cap and price using a constant circulating-supply basis.'
export const MCAP_UNAVAILABLE_REASON = 'Verified market cap unavailable'

export type ChartMarketCapSupply =
  | { enabled: true; supply: number; basis: ChartMarketCapBasis; verifiedMarketCapUsd: number; deviation: number }
  | { enabled: false; supply: null; reason: string; deviation: number | null }

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export function resolveChartMarketCapSupply(input: {
  /** valuationContext.primaryValuationStatus from the scan. */
  valuationStatus: string | null | undefined
  /** The verified circulating market cap the Market Cap card shows (valuationContext.primaryValuationUsd). */
  verifiedMarketCapUsd: number | null | undefined
  /** The provider circulating_supply field the scan already returns. */
  circulatingSupply: number | null | undefined
  /** The scan's live token price (the same price the verified market cap is quoted against). */
  priceUsd: number | null | undefined
}): ChartMarketCapSupply {
  const off = (reason: string, deviation: number | null = null): ChartMarketCapSupply => ({ enabled: false, supply: null, reason, deviation })
  if (input.valuationStatus !== 'verified_mc' || !positive(input.verifiedMarketCapUsd)) return off(MCAP_UNAVAILABLE_REASON)
  if (!positive(input.priceUsd)) return off(MCAP_UNAVAILABLE_REASON)
  const mc = input.verifiedMarketCapUsd
  if (positive(input.circulatingSupply)) {
    // A) verified circulating supply.
    const deviation = Math.abs(input.circulatingSupply * input.priceUsd - mc) / mc
    if (!Number.isFinite(deviation) || deviation > MCAP_SUPPLY_TOLERANCE) return off('Circulating supply does not match the verified market cap', Number.isFinite(deviation) ? deviation : null)
    return { enabled: true, supply: input.circulatingSupply, basis: 'circulating_supply', verifiedMarketCapUsd: mc, deviation }
  }
  // B) inferred basis: verified current MC ÷ current price (so the latest close reproduces the card exactly).
  const inferred = mc / input.priceUsd
  if (!positive(inferred)) return off(MCAP_UNAVAILABLE_REASON)
  return { enabled: true, supply: inferred, basis: 'inferred_current_mc', verifiedMarketCapUsd: mc, deviation: 0 }
}

/** Header label + tooltip for the active MCAP basis. */
export function marketCapBasisLabel(basis: ChartMarketCapBasis): { label: string; tooltip: string } {
  return basis === 'inferred_current_mc'
    ? { label: 'MCAP · inferred supply basis', tooltip: INFERRED_MCAP_BASIS_TOOLTIP }
    : { label: 'MCAP · verified supply basis', tooltip: VERIFIED_MCAP_BASIS_TOOLTIP }
}

/** Price candles -> market-cap candles (O/H/L/C × supply). Time and USD volume are untouched; the input is never mutated. */
export function scaleCandlesToMarketCap(candles: ReadonlyArray<ChartCandle>, supply: number): ChartCandle[] {
  if (!positive(supply)) return [...candles]
  const out: ChartCandle[] = []
  for (const c of candles) {
    const open = c.open * supply
    const high = c.high * supply
    const low = c.low * supply
    const close = c.close * supply
    if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue
    out.push({ ...c, open, high, low, close })
  }
  return out
}

/** Compact USD for market-cap values: $82K, $580K, $1.2M, $4.5M (header: $578.44K). */
export function formatCompactUsd(value: number | null | undefined, maxDecimals = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = abs / size
      // Keep 3+ significant digits readable without trailing zeros: 1.2M, 580K, 578.44K.
      const decimals = scaled >= 100 ? Math.min(maxDecimals, 2) : maxDecimals
      return `${sign}$${trimZeros(scaled.toFixed(decimals))}${suffix}`
    }
  }
  return `${sign}$${trimZeros(abs.toFixed(abs >= 1 ? Math.min(maxDecimals, 2) : 2))}`
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}
