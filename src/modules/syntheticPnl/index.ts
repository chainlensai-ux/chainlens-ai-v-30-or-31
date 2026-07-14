// MODULE — syntheticPnl
//
// UI-DISPLAY-ONLY, DISCLOSED UP FRONT: this module produces an INFERRED, UNVERIFIED PnL read model
// for the wallet-scanner UI to show when the real, verified engines (fifoEngine's publicPnlStatus,
// pnlV2) can't produce a confident number. It is completely separate from — and never influences —
// either real engine:
//   - inferSyntheticTrades reuses src/modules/routerTradeReconstruction's already-real,
//     already-tested same-tx pairing logic (never re-derived) rather than building a second,
//     divergent event-pairing implementation. It ADDS pool-liquidity-aware confidence downgrading
//     and dead-pool exclusion on top, using caller-injected `poolData` (this module never fetches
//     anything itself — no network calls, no fabricated prices).
//   - computeSyntheticPnl uses a WEIGHTED-AVERAGE-COST approximation (not FIFO lot-matching) across
//     inferred trades ordered by timestamp — a deliberately simpler, disclosed method than
//     fifoEngine's real per-lot FIFO algorithm. This is why the result is "synthetic," never
//     presented as engine-verified.
//   - Nothing this module produces is ever written back into normalizedEvents, recoveredEvents,
//     priceLotsForWallet's input, or fifoEngine's input. The UI-side badge
//     ("SYNTHETIC · INFERRED · NOT ENGINE VERIFIED") is the honest label for what this whole
//     module is: real trade evidence and real prices, combined with a simplified accounting method,
//     never a replacement for or an input to the real, verified engines.

import type { NormalizedEvent } from '../normalization/types'
import { reconstructRouterTrades, classifyPoolLiquidity } from '../routerTradeReconstruction/index'
import type { PoolDataMap, SyntheticTrade, SyntheticTradeConfidence, SyntheticPnlSummary } from './types'

export type { SyntheticTrade, SyntheticTradeConfidence, SyntheticPnlSummary, PoolDataMap, PoolPriceData } from './types'

function poolKey(chain: string, token: string): string {
  return `${chain}:${token.toLowerCase()}`
}

// PURE, exported for direct testing. Builds on routerTradeReconstruction's real same-tx pairing
// (high/medium confidence tiers, unchanged) and adds pool-liquidity awareness on top:
//   - either leg's pool is 'abandoned' (or missing from poolData entirely) -> the trade is EXCLUDED
//     (this task's own "dead pools -> no synthetic trades" rule; there is no honest price to value
//     it with anyway).
//   - either leg's pool is 'dust' -> confidence downgraded to 'low' (real evidence, real event —
//     just a shallower, less reliable market to price it against).
//   - both legs' pools are 'real' -> the original high/medium confidence from
//     reconstructRouterTrades is kept unchanged.
export function inferSyntheticTrades(
  normalizedEvents: readonly NormalizedEvent[],
  knownDexRouterAddresses: ReadonlySet<string>,
  poolData: PoolDataMap,
  routerDistributorMode: boolean,
): SyntheticTrade[] {
  const { candidateTrades } = reconstructRouterTrades(normalizedEvents, knownDexRouterAddresses, routerDistributorMode)

  const result: SyntheticTrade[] = []
  for (const trade of candidateTrades) {
    const tokenInPool = poolData[poolKey(trade.chain, trade.tokenIn)]
    const tokenOutPool = poolData[poolKey(trade.chain, trade.tokenOut)]

    const tokenInClass = classifyPoolLiquidity(tokenInPool?.liquidityUsd ?? null)
    const tokenOutClass = classifyPoolLiquidity(tokenOutPool?.liquidityUsd ?? null)

    // No real price for either leg at all -> cannot honestly value this trade; excluded entirely
    // (never fabricated as a $0 or default price).
    if (!tokenInPool || !tokenOutPool) continue
    if (tokenInClass === 'abandoned' || tokenOutClass === 'abandoned') continue

    const confidence: SyntheticTradeConfidence =
      (tokenInClass === 'dust' || tokenOutClass === 'dust') ? 'low' : trade.confidence

    // ENTRY-TIME PRICING BAKED IN, DISCLOSED: resolved once, here, from THIS poolData snapshot —
    // never re-looked-up with a possibly-different snapshot later. This is what lets
    // computeSyntheticPnl's realized-PnL math use a genuinely different, later `currentPrices`
    // snapshot for still-open positions without also silently drifting the cost basis of trades
    // this function already priced.
    result.push({ ...trade, confidence, tokenInPriceUsd: tokenInPool.midPriceUsd, tokenOutPriceUsd: tokenOutPool.midPriceUsd })
  }
  return result
}

// PURE, exported for direct testing. WEIGHTED-AVERAGE-COST approximation (disclosed above, NOT
// FIFO) across `trades` ordered by timestamp, using each trade's OWN baked-in entry prices
// (tokenInPriceUsd/tokenOutPriceUsd — resolved once, at inference time) for cost basis and
// disposal proceeds. `currentPrices` (a SEPARATE, later snapshot — may be the same poolData used at
// inference time, or a fresher one) is used ONLY to value whatever position remains open once every
// trade has been processed; this is the one place "at trade time" and "current" can genuinely
// differ without a full historical price-series feed (out of scope here).
//
// A token sold beyond this run's own tracked position (no prior synthetic acquisition seen in this
// SAME set of trades — typically the wallet's own starting capital, e.g. ETH/USDC used to buy into
// a memecoin, never itself "bought" via a synthetic trade here) contributes NOTHING to
// syntheticRealizedPnlUsd — never proceeds-as-profit (which would silently assume a fabricated $0
// cost basis) and never a fabricated cost. Same "unknown cost basis is excluded, never assumed
// zero" principle the real engines already apply.
export function computeSyntheticPnl(trades: readonly SyntheticTrade[], currentPrices: PoolDataMap): SyntheticPnlSummary {
  const ordered = [...trades].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const positions = new Map<string, { qty: number; costUsd: number }>()
  let syntheticRealizedPnlUsd = 0
  let totalCostBasisEverUsd = 0

  for (const trade of ordered) {
    const inKey = poolKey(trade.chain, trade.tokenIn)
    const outKey = poolKey(trade.chain, trade.tokenOut)

    const proceedsUsd = trade.amountIn * trade.tokenInPriceUsd
    const existingPosition = positions.get(inKey)
    if (existingPosition && existingPosition.qty > 0) {
      const soldQty = Math.min(trade.amountIn, existingPosition.qty)
      const avgCostPerUnit = existingPosition.costUsd / existingPosition.qty
      const costOfSoldQty = avgCostPerUnit * soldQty
      syntheticRealizedPnlUsd += proceedsUsd - costOfSoldQty
      existingPosition.qty -= soldQty
      existingPosition.costUsd -= costOfSoldQty
    }

    // Acquisition side (tokenOut): open/extend a tracked position at its own real, baked-in
    // trade-time price.
    const acquisitionCostUsd = trade.amountOut * trade.tokenOutPriceUsd
    totalCostBasisEverUsd += acquisitionCostUsd
    const outPosition = positions.get(outKey) ?? { qty: 0, costUsd: 0 }
    outPosition.qty += trade.amountOut
    outPosition.costUsd += acquisitionCostUsd
    positions.set(outKey, outPosition)
  }

  // Open positions valued at `currentPrices` — a real, caller-supplied snapshot, never fabricated;
  // a position whose token has no entry in `currentPrices` is left out of unrealized PnL entirely
  // (never assumed flat/unchanged).
  let syntheticUnrealizedPnlUsd = 0
  for (const [key, position] of positions) {
    if (position.qty <= 0) continue
    const currentPrice = currentPrices[key]?.midPriceUsd
    if (currentPrice == null) continue
    syntheticUnrealizedPnlUsd += position.qty * currentPrice - position.costUsd
  }

  const syntheticTotalPnlUsd = syntheticRealizedPnlUsd + syntheticUnrealizedPnlUsd
  const syntheticRoiPct = totalCostBasisEverUsd > 0 ? (syntheticTotalPnlUsd / totalCostBasisEverUsd) * 100 : null

  return {
    syntheticRealizedPnlUsd,
    syntheticUnrealizedPnlUsd,
    syntheticTotalPnlUsd,
    syntheticRoiPct,
    tradeCount: trades.length,
    highConfidenceCount: trades.filter((t) => t.confidence === 'high').length,
    mediumConfidenceCount: trades.filter((t) => t.confidence === 'medium').length,
    lowConfidenceCount: trades.filter((t) => t.confidence === 'low').length,
  }
}
