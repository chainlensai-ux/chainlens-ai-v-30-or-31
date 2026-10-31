// What the Whale Alerts Activity feed shows, and what one alert is worth. One definition for the feed
// rows AND the 1h/6h/24h counters, so the two can never disagree.
//
// TRADE VALUE: a swap is one economic movement. Its legs are the two sides of the same trade, so adding
// them together double counts it (a $10k USDC → TOKEN buy read as $20k, and graded one severity too
// high). The value is ONE side: the base-asset side (stablecoin / ETH / WETH / BTC wrapper paid or
// received) when every leg on it is priced — the most reliable price — otherwise the larger priced side.
// One-direction movements (a transfer in or out) keep their own sum.
//
// ROUTINE CHURN: stablecoin-only movements (USDT/USDC/DAI shuffles, CEX deposits) are never shown, and
// movements made only of base assets (ETH/WETH/cbBTC wrapping, ETH↔USDC rebalancing) are shown only when
// they are genuinely large. Their legs are kept internally: a stablecoin leg still prices the token it
// bought, and the row is shown as that token trade.

import { classifyTrade, type TradeLeg } from './whaleTradeClassify'

export const STABLE_SYMBOLS: ReadonlySet<string> = new Set(['USDC', 'USDBC', 'USDT', 'DAI', 'EURC', 'USDS', 'AXLUSDC'])
export const BASE_ASSET_SYMBOLS: ReadonlySet<string> = new Set([...STABLE_SYMBOLS, 'ETH', 'WETH', 'CBBTC', 'WBTC', 'CBETH', 'WSTETH'])
/** A base-asset-only movement (e.g. a large ETH buy with USDC) is shown from this size up. */
export const SIGNIFICANT_BASE_ASSET_USD = 100_000

type Leg = TradeLeg & { amount_usd?: unknown }

const sym = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : '')
const usdOf = (leg: Leg): number | null => (typeof leg.amount_usd === 'number' && Number.isFinite(leg.amount_usd) && leg.amount_usd > 0 ? leg.amount_usd : null)

function sideSum(legs: readonly Leg[]): { usd: number; allPriced: boolean } {
  let usd = 0
  let allPriced = legs.length > 0
  for (const leg of legs) {
    const value = usdOf(leg)
    if (value == null) allPriced = false
    else usd += value
  }
  return { usd, allPriced }
}

/** USD value of one transaction's movement; null when no leg carries a verified value. */
export function tradeUsdValue(legs: readonly Leg[]): number | null {
  const ins = legs.filter((l) => String(l.side ?? '').toLowerCase() === 'buy')
  const outs = legs.filter((l) => String(l.side ?? '').toLowerCase() === 'sell')
  if (ins.length === 0 || outs.length === 0) {
    const { usd } = sideSum(legs)
    return usd > 0 ? usd : null
  }
  const { kind } = classifyTrade(legs)
  const baseSide = kind === 'buy' ? outs : kind === 'sell' || kind === 'exit' ? ins : null
  if (baseSide) {
    const base = sideSum(baseSide)
    if (base.allPriced && base.usd > 0) return base.usd
  }
  const inUsd = sideSum(ins).usd
  const outUsd = sideSum(outs).usd
  const value = Math.max(inUsd, outUsd)
  return value > 0 ? value : null
}

/** Symbols of a (possibly grouped "A / B") row. */
export function rowSymbols(tokenSymbol: unknown): string[] {
  return typeof tokenSymbol === 'string' ? tokenSymbol.split(' / ').map(sym).filter(Boolean) : []
}

export type RoutineReason = 'stablecoin_only' | 'base_asset_churn'

/** Why a row is routine churn (hidden), or null when it belongs in the Activity feed. */
export function routineChurnReason(symbols: readonly string[], usd: number | null): RoutineReason | null {
  if (symbols.length === 0) return null
  if (symbols.every((s) => STABLE_SYMBOLS.has(s))) return 'stablecoin_only'
  if (symbols.every((s) => BASE_ASSET_SYMBOLS.has(s))) {
    return usd != null && usd >= SIGNIFICANT_BASE_ASSET_USD ? null : 'base_asset_churn'
  }
  return null
}
