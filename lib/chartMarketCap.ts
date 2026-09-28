// lib/chartMarketCap.ts — MCAP chart mode for the Token Scanner Price Chart (pure; no I/O).
//
// MCAP mode is the SAME genuine price candles multiplied by ONE circulating-supply figure:
//   mcapOpen/High/Low/Close = priceOpen/High/Low/Close × circulatingSupply;  volume unchanged (USD).
// No provider call, no new candles, no FDV.
//
// SUPPLY GATE. MCAP is enabled only when the scan itself shows a VERIFIED circulating market cap
// (valuationContext.primaryValuationStatus === 'verified_mc' — the Market Cap card's own "verified"
// state) AND the provider's circulating_supply field agrees with it at the scan price (within 15%).
// The chart then multiplies by exactly that circulating_supply. Everything else keeps PRICE:
//   - 'estimated_mc' (on-chain TOTAL supply × price) or 'fdv_only' / 'partial'  -> "Circulating supply unavailable"
//   - verified market cap but no circulating_supply field                       -> "Circulating supply unavailable"
//   - circulating_supply × price disagrees with the verified market cap         -> "Circulating supply does not match
//     the verified market cap" (a source mismatch is surfaced, never forced into parity).

import type { ChartCandle } from './priceChartCandles.ts'

export const MCAP_SUPPLY_TOLERANCE = 0.15

export type ChartMarketCapSupply =
  | { enabled: true; supply: number; basis: 'circulating_supply'; verifiedMarketCapUsd: number; deviation: number }
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
  if (input.valuationStatus !== 'verified_mc' || !positive(input.verifiedMarketCapUsd)) return off('Circulating supply unavailable')
  if (!positive(input.circulatingSupply)) return off('Circulating supply unavailable')
  if (!positive(input.priceUsd)) return off('Circulating supply unavailable')
  const implied = input.circulatingSupply * input.priceUsd
  const deviation = Math.abs(implied - input.verifiedMarketCapUsd) / input.verifiedMarketCapUsd
  if (!Number.isFinite(deviation) || deviation > MCAP_SUPPLY_TOLERANCE) return off('Circulating supply does not match the verified market cap', Number.isFinite(deviation) ? deviation : null)
  return { enabled: true, supply: input.circulatingSupply, basis: 'circulating_supply', verifiedMarketCapUsd: input.verifiedMarketCapUsd, deviation }
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
