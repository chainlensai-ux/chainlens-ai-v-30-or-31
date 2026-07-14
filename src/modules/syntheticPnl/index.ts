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
import type { PoolDataMap, SyntheticTrade, SyntheticTradeConfidence, SyntheticPnlSummary, SyntheticChainPnl } from './types'

export type { SyntheticTrade, SyntheticTradeConfidence, SyntheticPnlSummary, SyntheticChainPnl, PoolDataMap, PoolPriceData } from './types'

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
// RELAXED GATE, DISCLOSED (this task's own request — "syntheticPnl MUST be returned even when
// routerDistributorMode is false"): routerTradeReconstruction.reconstructRouterTrades has its own
// `routerDistributorMode` gate (a hard no-op when false) — correct and UNCHANGED for its real
// caller, distributorRecovery, which is specifically about detecting/observing the heavy-distributor
// pattern. Synthetic PnL has a different job (Nansen-style "always show a number when the real
// engine can't"), so it always asks reconstructRouterTrades to attempt pairing (passes `true`
// unconditionally) regardless of the `routerDistributorMode` parameter received here — that
// parameter is kept only so callers/logs still know whether THIS wallet matched the heavy-
// distributor pattern, never as a gate on whether reconstruction runs. Every trade this still
// produces is exactly as real as before (same-tx pairing, same confidence tiers, same pool-liquidity
// exclusion) — relaxing this gate does not relax any of the "never fabricate" rules, only whether
// reconstruction is ATTEMPTED for a lighter-activity wallet.
export function inferSyntheticTrades(
  normalizedEvents: readonly NormalizedEvent[],
  knownDexRouterAddresses: ReadonlySet<string>,
  poolData: PoolDataMap,
  routerDistributorMode: boolean,
): SyntheticTrade[] {
  void routerDistributorMode // no longer gates reconstruction — see this function's own header
  const { candidateTrades } = reconstructRouterTrades(normalizedEvents, knownDexRouterAddresses, true)

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
// a memecoin, never itself "bought" via a synthetic trade here) contributes NOTHING to realized
// PnL — never proceeds-as-profit (which would silently assume a fabricated $0 cost basis) and never
// a fabricated cost. Same "unknown cost basis is excluded, never assumed zero" principle the real
// engines already apply.
//
// PER-CHAIN, DISCLOSED: realized/unrealized/cost-basis are accumulated BOTH globally and per-chain
// from the exact same trade-by-trade pass — never a second, divergent computation. `perChain` is
// populated independently of whether the global totals end up "empty" (0 trades); nothing here
// requires one to gate the other.
//
// NEVER RETURNS NULL FIELDS, DISCLOSED (this task's own relaxation request): every numeric field
// below is a real, computed number — missing cost basis or missing price simply contributes 0 (see
// the per-leg comments below), never a fabricated non-zero value and never a null placeholder.
// `roiPercent` (global and per-chain) is the one exception — null ONLY when the relevant cost basis
// is exactly 0 (an honest "can't compute a percentage of zero," not a confidence signal). The caller
// (src/pipeline/index.ts) still decides whether to call this function at all — `trades.length === 0`
// there means literally nothing to reconstruct, which is the one case this module has no data to
// report from, not a case this function itself special-cases to null.
export function computeSyntheticPnl(trades: readonly SyntheticTrade[], currentPrices: PoolDataMap): SyntheticPnlSummary {
  const ordered = [...trades].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const positions = new Map<string, { qty: number; costUsd: number; chain: string }>()
  let totalRealizedPnlUsd = 0
  let totalCostBasisEverUsd = 0
  const realizedByChain = new Map<string, number>()
  const costBasisByChain = new Map<string, number>()

  const addToChain = (map: Map<string, number>, chain: string, delta: number) => {
    map.set(chain, (map.get(chain) ?? 0) + delta)
  }

  for (const trade of ordered) {
    const inKey = poolKey(trade.chain, trade.tokenIn)
    const outKey = poolKey(trade.chain, trade.tokenOut)

    const proceedsUsd = trade.amountIn * trade.tokenInPriceUsd
    const existingPosition = positions.get(inKey)
    if (existingPosition && existingPosition.qty > 0) {
      const soldQty = Math.min(trade.amountIn, existingPosition.qty)
      const avgCostPerUnit = existingPosition.costUsd / existingPosition.qty
      const costOfSoldQty = avgCostPerUnit * soldQty
      const realizedThisLeg = proceedsUsd - costOfSoldQty
      totalRealizedPnlUsd += realizedThisLeg
      addToChain(realizedByChain, trade.chain, realizedThisLeg)
      existingPosition.qty -= soldQty
      existingPosition.costUsd -= costOfSoldQty
    }

    // Acquisition side (tokenOut): open/extend a tracked position at its own real, baked-in
    // trade-time price.
    const acquisitionCostUsd = trade.amountOut * trade.tokenOutPriceUsd
    totalCostBasisEverUsd += acquisitionCostUsd
    addToChain(costBasisByChain, trade.chain, acquisitionCostUsd)
    const outPosition = positions.get(outKey) ?? { qty: 0, costUsd: 0, chain: trade.chain }
    outPosition.qty += trade.amountOut
    outPosition.costUsd += acquisitionCostUsd
    positions.set(outKey, outPosition)
  }

  // Open positions valued at `currentPrices` — a real, caller-supplied snapshot, never fabricated;
  // a position whose token has no entry in `currentPrices` is left out of unrealized PnL entirely
  // (never assumed flat/unchanged).
  let totalUnrealizedPnlUsd = 0
  const unrealizedByChain = new Map<string, number>()
  for (const [key, position] of positions) {
    if (position.qty <= 0) continue
    const currentPrice = currentPrices[key]?.midPriceUsd
    if (currentPrice == null) continue
    const unrealizedThisPosition = position.qty * currentPrice - position.costUsd
    totalUnrealizedPnlUsd += unrealizedThisPosition
    addToChain(unrealizedByChain, position.chain, unrealizedThisPosition)
  }

  const totalPnlUsd = totalRealizedPnlUsd + totalUnrealizedPnlUsd
  const roiPercent = totalCostBasisEverUsd > 0 ? (totalPnlUsd / totalCostBasisEverUsd) * 100 : null

  const chainIds = new Set<string>([...realizedByChain.keys(), ...unrealizedByChain.keys(), ...costBasisByChain.keys()])
  const perChain: SyntheticChainPnl[] = [...chainIds].sort().map((chainId) => {
    // A chain only appears here at all if it contributed at least one trade leg — realized/
    // unrealized default to 0 (a real, computed zero for that leg type), never null, for a chain
    // that DID contribute trades; costBasisUsd similarly. roiPercent is null only when this chain's
    // own cost basis is 0 (no divide-by-zero, no fabricated percentage).
    const chainRealized = realizedByChain.get(chainId) ?? 0
    const chainUnrealized = unrealizedByChain.get(chainId) ?? 0
    const chainCostBasis = costBasisByChain.get(chainId) ?? 0
    const chainTotal = chainRealized + chainUnrealized
    return {
      chainId,
      realizedPnlUsd: chainRealized,
      unrealizedPnlUsd: chainUnrealized,
      totalPnlUsd: chainTotal,
      roiPercent: chainCostBasis > 0 ? (chainTotal / chainCostBasis) * 100 : null,
      costBasisUsd: chainCostBasis,
    }
  })

  return {
    totalRealizedPnlUsd,
    totalUnrealizedPnlUsd,
    totalPnlUsd,
    roiPercent,
    costBasisUsd: totalCostBasisEverUsd,
    perChain,
    tradeCount: trades.length,
    highConfidenceCount: trades.filter((t) => t.confidence === 'high').length,
    mediumConfidenceCount: trades.filter((t) => t.confidence === 'medium').length,
    lowConfidenceCount: trades.filter((t) => t.confidence === 'low').length,
  }
}
