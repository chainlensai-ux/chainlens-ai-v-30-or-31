// lib/marketPoolSelection.ts — deterministic pool ROLES for the Token Scanner (pure; no I/O).
//
// One token can trade in several pools, and the deepest pool is not always the market. A pool can
// report a large reserve while nobody trades it (e.g. one-sided launch liquidity in a Uniswap V4
// pool: $2.68M reserve, $0 volume, 0 txns) while the real market is a smaller, busy pool (an
// Aerodrome pool with $78K reserve, $198K volume, 1,552 txns). So the scanner keeps two roles:
//
//   marketPool     — price fallback, Market Pulse liquidity / volume / buys / sells / pair age /
//                    protocol, and the primary Price Chart pool.            (selectMarketPool)
//   liquidityPool  — LP Safety and liquidity custody / LP analysis: the deepest pool, exactly the
//                    previous reserve_in_usd-descending rule.              (selectLiquidityPool)
//
// Both read ONLY fields already present in the provider's pool list (GeckoTerminal
// /tokens/{token}/pools: reserve_in_usd, volume_usd.h24, transactions.h24) — zero extra calls.
//
// MARKET RULE. A pool is ACTIVE when its 24h volume > 0 AND its 24h txns (buys + sells) > 0.
// Active pools rank by: 1) 24h volume desc, 2) 24h txns desc, 3) reserve_in_usd desc, 4) pool id
// asc. When NO pool is active the ranking falls back to the liquidity rule, so a dormant token
// behaves exactly as before. An inactive pool can never outrank an active one, whatever its reserve.

export type PoolLike = { id?: unknown; attributes?: Record<string, unknown> | null } | null | undefined

export type MarketPoolMetrics = {
  id: string
  reserveUsd: number
  volume24hUsd: number
  txns24h: number
  buys24h: number | null
  sells24h: number | null
  active: boolean
}

export type MarketPoolRule = 'active_market' | 'deepest_liquidity_fallback' | 'none'

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export function marketPoolMetrics(pool: PoolLike): MarketPoolMetrics {
  const a = (pool?.attributes ?? {}) as Record<string, unknown>
  const vol = a.volume_usd
  const volume24hUsd = Math.max(0, num(vol && typeof vol === 'object' ? (vol as Record<string, unknown>).h24 : null) ?? 0)
  const tx = a.transactions
  const h24 = tx && typeof tx === 'object' ? (tx as Record<string, unknown>).h24 : null
  let buys: number | null = null
  let sells: number | null = null
  let total: number | null = null
  if (h24 && typeof h24 === 'object') {
    const o = h24 as Record<string, unknown>
    buys = num(o.buys) ?? num(o.buy)
    sells = num(o.sells) ?? num(o.sell)
    total = buys != null || sells != null ? Math.max(0, buys ?? 0) + Math.max(0, sells ?? 0) : null
  } else {
    total = num(h24)
  }
  const txns24h = Math.max(0, total ?? 0)
  return {
    id: String(pool?.id ?? ''),
    reserveUsd: Math.max(0, num(a.reserve_in_usd) ?? 0),
    volume24hUsd,
    txns24h,
    buys24h: buys,
    sells24h: sells,
    active: volume24hUsd > 0 && txns24h > 0,
  }
}

/** The previous primary-pool rule: reserve_in_usd desc, then pool id asc. */
export function compareByLiquidity(a: MarketPoolMetrics, b: MarketPoolMetrics): number {
  return (b.reserveUsd - a.reserveUsd) || a.id.localeCompare(b.id)
}

/** Active pools first (volume, txns, reserve, id); inactive pools after them by the liquidity rule. */
export function compareByMarket(a: MarketPoolMetrics, b: MarketPoolMetrics): number {
  if (a.active !== b.active) return a.active ? -1 : 1
  if (!a.active) return compareByLiquidity(a, b)
  return (b.volume24hUsd - a.volume24hUsd) || (b.txns24h - a.txns24h) || (b.reserveUsd - a.reserveUsd) || a.id.localeCompare(b.id)
}

const sortWith = <T extends PoolLike>(pools: ReadonlyArray<T>, cmp: (a: MarketPoolMetrics, b: MarketPoolMetrics) => number): T[] =>
  pools.filter((p) => p != null).map((p) => ({ p, m: marketPoolMetrics(p) })).sort((x, y) => cmp(x.m, y.m)).map((x) => x.p)

/** Every pool in market order: the market pool first, remaining active pools, then inactive ones by liquidity. */
export function orderPoolsForMarket<T extends PoolLike>(pools: ReadonlyArray<T>): T[] {
  return sortWith(pools, compareByMarket)
}

/** Every pool in liquidity order (the LP Safety / custody order). */
export function orderPoolsByLiquidity<T extends PoolLike>(pools: ReadonlyArray<T>): T[] {
  return sortWith(pools, compareByLiquidity)
}

export function selectMarketPool<T extends PoolLike>(pools: ReadonlyArray<T>): { pool: T | null; rule: MarketPoolRule; metrics: MarketPoolMetrics | null; activePoolCount: number } {
  const ordered = orderPoolsForMarket(pools)
  const pool = ordered[0] ?? null
  const metrics = pool ? marketPoolMetrics(pool) : null
  const activePoolCount = ordered.filter((p) => marketPoolMetrics(p).active).length
  return { pool, rule: !metrics ? 'none' : metrics.active ? 'active_market' : 'deepest_liquidity_fallback', metrics, activePoolCount }
}

export function selectLiquidityPool<T extends PoolLike>(pools: ReadonlyArray<T>): T | null {
  return orderPoolsByLiquidity(pools)[0] ?? null
}
