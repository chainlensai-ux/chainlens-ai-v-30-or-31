// What a tracked wallet did in one transaction, from its own token legs (evidence only):
//  buy   — paid with base assets (stablecoins / ETH / WETH / BTC wrappers), received another token
//  sell  — sent a token, received only base assets
//  exit  — a sell after which the wallet's on-chain balance of that token is 0 (set by the feed
//          after a balanceOf check; classifyTrade itself never claims an exit)
//  swap  — tokens out and in, but not a clean base-asset buy/sell (e.g. token → token)
//  in / out — one direction only: a transfer, not proof of a trade
// Severity comes from the priced USD value only; no price → no severity.

export type TradeKind = 'buy' | 'sell' | 'exit' | 'swap' | 'in' | 'out'

export type TradeLeg = { side?: unknown; token_symbol?: unknown; token_address?: unknown }

const BASE_ASSET_SYMBOLS = new Set(['USDC', 'USDBC', 'USDT', 'DAI', 'EURC', 'USDS', 'ETH', 'WETH', 'CBBTC', 'WBTC', 'CBETH', 'WSTETH'])

function symbolOf(leg: TradeLeg): string {
  return typeof leg.token_symbol === 'string' ? leg.token_symbol.trim().toUpperCase() : ''
}

export function isBaseAsset(leg: TradeLeg): boolean {
  return BASE_ASSET_SYMBOLS.has(symbolOf(leg))
}

export function classifyTrade(legs: readonly TradeLeg[]): { kind: TradeKind; token: TradeLeg | null } {
  const outs = legs.filter(l => String(l.side ?? '').toLowerCase() === 'sell')
  const ins = legs.filter(l => String(l.side ?? '').toLowerCase() === 'buy')
  if (outs.length === 0 && ins.length > 0) return { kind: 'in', token: ins.find(l => !isBaseAsset(l)) ?? ins[0]! }
  if (ins.length === 0 && outs.length > 0) return { kind: 'out', token: outs.find(l => !isBaseAsset(l)) ?? outs[0]! }
  if (ins.length === 0 && outs.length === 0) return { kind: 'in', token: legs[0] ?? null }
  const boughtToken = ins.find(l => !isBaseAsset(l))
  const soldToken = outs.find(l => !isBaseAsset(l))
  if (outs.every(isBaseAsset) && boughtToken) return { kind: 'buy', token: boughtToken }
  if (ins.every(isBaseAsset) && soldToken) return { kind: 'sell', token: soldToken }
  return { kind: 'swap', token: boughtToken ?? soldToken ?? ins[0]! }
}

export type Severity = 'major' | 'large' | 'medium' | 'small'

export function severityFromPricedUsd(usd: unknown): Severity | null {
  const value = typeof usd === 'number' && Number.isFinite(usd) ? usd : null
  if (value == null || value <= 0) return null
  if (value >= 25_000) return 'major'
  if (value >= 10_000) return 'large'
  if (value >= 5_000) return 'medium'
  if (value >= 1_000) return 'small'
  return null
}

/** Filter values the page sends; `side` groups kinds by direction of exposure. */
export function matchesTradeFilters(
  row: { trade_kind?: TradeKind | null; severity?: string | null },
  filters: { type?: string | null; side?: string | null; severity?: string | null },
): boolean {
  const kind = row.trade_kind ?? null
  if (filters.type && filters.type !== 'token_transfer' && kind !== filters.type) return false
  if (filters.side === 'buy' && kind !== 'buy' && kind !== 'in') return false
  if (filters.side === 'sell' && kind !== 'sell' && kind !== 'exit' && kind !== 'out') return false
  if (filters.severity && row.severity !== filters.severity) return false
  return true
}
