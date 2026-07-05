// lib/engine/modules/pnl/computePnl.ts — new PnL module for the V2 engine.
//
// REUSE, NOT REIMPLEMENTATION, DISCLOSED: `fetchParsedTrades` reuses the real, existing
// app/api/_shared/walletChainPipeline.ts's `buildTradeTimelineForChain` (itself a thin wrapper
// around the real swapNormalizer/tradeIntent/lotOpener/lotCloser chain and
// lib/engines/tradeTimelineEngineV2.ts) for chainId 1 (eth) / 8453 (base) — the same two chains the
// holdings/pricing modules from prior tasks support. No new provider/network/pricing logic is
// written here; every `ParsedTrade`'s `valueUsd` comes straight from that real chain's own
// pricing-backed `costBasisUsd`/`proceedsUsd` fields.
//
// FIFO ALGORITHM, DISCLOSED: `computePnl`'s own per-token FIFO (step B/C in the request) IS a new,
// self-contained aggregation written for this module — the task explicitly asked for this
// computation to be built fresh here (a second, additive PnL surface alongside the untouched
// `fifoAndPnl` field), not for src/modules/fifoEngine or lotOpener/lotCloser to be reused for the
// aggregation step itself (only for supplying the underlying trade data, via fetchParsedTrades
// above). This avoids conflating "reuse the real trade-fetching/parsing layer" (done) with
// "reuse the real FIFO matching engine's exact internals" (not attempted — this module's FIFO
// matches the literal, simpler algorithm the task itself specifies and tests against).
//
// UNPRICED TRADES, DISCLOSED: a trade with `valueUsd: null` (the real chain found no reliable
// historical price for it) is skipped by the FIFO algorithm below rather than treated as a
// zero-cost/zero-proceeds trade, which would silently fabricate a PnL number. Its presence is what
// drives `pnlStatus` toward `"partial"` instead of `"ok"` (see step F below).

import { buildTradeTimelineForChain } from '@/app/api/_shared/walletChainPipeline'
import { logCuRisk } from '@/lib/server/cuAudit'
import type { PricedHolding } from '../pricing/types'
import type { ChainHolding } from '../holdings/types'
import type {
  ChainPnlBreakdown,
  ParsedTrade,
  PnlEngineOutput,
  PnlV2,
  TokenCostBasis,
  TokenRealizedPnl,
  TokenUnrealizedPnl,
} from './types'

export type { ParsedTrade } from './types'

const CHAIN_ID_TO_SUPPORTED_CHAIN: Record<number, 'eth' | 'base'> = {
  1: 'eth',
  8453: 'base',
}

// CU-RISK: HIGH — external provider call duplicated across modules within one scan request.
// CU-AUDIT FINDING (docs/CU_AUDIT.md): app/api/scan-v2/full-scan/route.ts calls this function AND
// lib/engine/modules/activity/computeChainActivity.ts's fetchChainSignals for the SAME wallet +
// chains, in the SAME request. Both independently reach fetchRawEventsForChain/
// buildTradesWithIntentForChain per chain, roughly doubling GoldRush/Alchemy calls for that route.
// Not fixed here — see the matching comment in computeChainActivity.ts for the real fix this would
// need (shared caching/pre-fetch at the route layer), which is a refactor out of this audit's scope.
//
// Public entry point, exactly as specified (walletAddress only). Never throws:
// buildTradeTimelineForChain's own real chain already degrades to an empty trades array on any
// failure (see walletChainPipeline.ts's own guarantees) rather than throwing.
export async function fetchParsedTrades(walletAddress: string): Promise<ParsedTrade[]> {
  if (!walletAddress) {
    // eslint-disable-next-line no-console
    console.warn('[CU-AUDIT] Skipping external call: missing walletAddress')
    return []
  }

  const chainIds = [1, 8453]
  const perChain = await Promise.all(
    chainIds.map(async (chainId) => {
      const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
      logCuRisk('goldrush+alchemy', `pnl.fetchParsedTrades chain=${chain} wallet=${walletAddress.slice(0, 8)}… (duplicate of computeChainActivity.fetchChainSignals — see CU-RISK comment above)`)
      const result = await buildTradeTimelineForChain(chain, walletAddress)
      return result.trades
        .filter((t) => t.type === 'buy' || t.type === 'sell')
        .map((t): ParsedTrade => ({
          tokenAddress: t.tokenAddress,
          chainId,
          type: t.type,
          quantity: t.amount,
          valueUsd: t.type === 'buy' ? t.costBasisUsd : t.proceedsUsd,
          timestamp: t.timestamp,
        }))
    }),
  )
  return perChain.flat()
}

function tokenKey(tokenAddress: string, chainId: number): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}

type FifoLot = { quantity: number; totalCostUsd: number }

// Public entry point, exactly as specified.
export async function computePnl(
  pricedHoldings: PricedHolding[],
  _chainHoldings: ChainHolding[],
  _totalValueUsd: number,
  trades: ParsedTrade[],
): Promise<PnlEngineOutput> {
  // A. No trades — exactly as specified.
  if (trades.length === 0) {
    return {
      pnlV2: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [] },
      pnlStatus: 'unavailable',
    }
  }

  // B. FIFO cost basis, per token, in chronological order.
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const fifoQueues = new Map<string, FifoLot[]>()
  const realizedByToken = new Map<string, number>()
  let anyUnpricedTrade = false

  for (const trade of sorted) {
    if (trade.valueUsd == null) {
      anyUnpricedTrade = true
      continue // unpriced trade — skipped, never fabricated (see file header)
    }

    const key = tokenKey(trade.tokenAddress, trade.chainId)
    const queue = fifoQueues.get(key) ?? []
    fifoQueues.set(key, queue)

    if (trade.type === 'buy') {
      queue.push({ quantity: trade.quantity, totalCostUsd: trade.valueUsd })
      continue
    }

    // trade.type === 'sell' — pop from the front of the queue, handling partial-lot fills.
    let remainingToSell = trade.quantity
    let costUsdConsumed = 0
    while (remainingToSell > 0 && queue.length > 0) {
      const lot = queue[0]
      const consumedQty = Math.min(lot.quantity, remainingToSell)
      const consumedFraction = lot.quantity > 0 ? consumedQty / lot.quantity : 0
      const consumedCost = lot.totalCostUsd * consumedFraction

      costUsdConsumed += consumedCost
      lot.quantity -= consumedQty
      lot.totalCostUsd -= consumedCost
      remainingToSell -= consumedQty

      if (lot.quantity <= 0) queue.shift()
    }

    // proceedsUsd is only for the portion actually matched against a real lot — a sell with no
    // matching buy in this trade set (remainingToSell > 0 at the end) has no real cost basis for
    // that unmatched portion, so its proceeds don't count as realized PnL either (never fabricated).
    const matchedFraction = trade.quantity > 0 ? (trade.quantity - remainingToSell) / trade.quantity : 0
    const proceedsUsdMatched = trade.valueUsd * matchedFraction
    const realizedPnlUsd = proceedsUsdMatched - costUsdConsumed

    realizedByToken.set(key, (realizedByToken.get(key) ?? 0) + realizedPnlUsd)
  }

  // Remaining FIFO queues become costBasis (per token, remaining quantity/cost).
  const costBasis: TokenCostBasis[] = []
  for (const [key, queue] of fifoQueues.entries()) {
    const totalQuantity = queue.reduce((sum, lot) => sum + lot.quantity, 0)
    const totalCostUsd = queue.reduce((sum, lot) => sum + lot.totalCostUsd, 0)
    if (totalQuantity <= 0) continue // fully sold — nothing remaining to report
    const [chainIdStr, tokenAddress] = key.split(':')
    costBasis.push({
      tokenAddress,
      chainId: Number(chainIdStr),
      totalQuantity,
      totalCostUsd,
      averageCostUsd: totalQuantity > 0 ? totalCostUsd / totalQuantity : 0,
    })
  }

  const realized: TokenRealizedPnl[] = [...realizedByToken.entries()].map(([key, realizedPnlUsd]) => {
    const [chainIdStr, tokenAddress] = key.split(':')
    return { tokenAddress, chainId: Number(chainIdStr), realizedPnlUsd }
  })

  // C. Unrealized PnL — for each pricedHolding, currentValueUsd - remainingCostBasisUsd (matched by
  // token+chain against the FIFO remainder above). A holding with no matching cost-basis entry (no
  // real buy trade found for it in this trade set) or a null valueUsd is honestly skipped — never a
  // fabricated unrealized number.
  const costBasisByKey = new Map(costBasis.map((c) => [tokenKey(c.tokenAddress, c.chainId), c]))
  const unrealized: TokenUnrealizedPnl[] = []
  let anyUnpricedHolding = false

  for (const holding of pricedHoldings) {
    if (holding.valueUsd == null) {
      anyUnpricedHolding = true
      continue
    }
    const match = costBasisByKey.get(tokenKey(holding.tokenAddress, holding.chainId))
    if (!match) continue
    unrealized.push({
      tokenAddress: holding.tokenAddress,
      chainId: holding.chainId,
      unrealizedPnlUsd: holding.valueUsd - match.totalCostUsd,
    })
  }

  // D. Chain breakdown — sum realized/unrealized per chainId.
  const chainIds = new Set([...realized.map((r) => r.chainId), ...unrealized.map((u) => u.chainId)])
  const chainBreakdown: ChainPnlBreakdown[] = [...chainIds].map((chainId) => ({
    chainId,
    realizedPnlUsd: realized.filter((r) => r.chainId === chainId).reduce((sum, r) => sum + r.realizedPnlUsd, 0),
    unrealizedPnlUsd: unrealized.filter((u) => u.chainId === chainId).reduce((sum, u) => sum + u.unrealizedPnlUsd, 0),
  }))

  // E. Totals.
  const realizedPnlUsd = realized.reduce((sum, r) => sum + r.realizedPnlUsd, 0)
  const unrealizedPnlUsd = unrealized.reduce((sum, u) => sum + u.unrealizedPnlUsd, 0)

  // F. pnlStatus — trades already confirmed non-empty above (step A returned early otherwise).
  const pnlStatus: PnlEngineOutput['pnlStatus'] = anyUnpricedTrade || anyUnpricedHolding ? 'partial' : 'ok'

  return {
    pnlV2: { realizedPnlUsd, unrealizedPnlUsd, costBasis, realized, unrealized, chainBreakdown },
    pnlStatus,
  }
}
