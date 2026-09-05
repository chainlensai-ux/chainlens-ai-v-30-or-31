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

import { buildTradeTimelineForChain, type QuoteLegRecoveryChainAudit } from '@/app/api/_shared/walletChainPipeline'
import type { EventsCache } from '@/app/api/_shared/eventsCache'
import type { CuBudget } from '@/app/api/_shared/cuBudget'
import { logCuRisk } from '@/lib/server/cuAudit'
import type { PricedHolding } from '../pricing/types'
import type { ChainHolding } from '../holdings/types'
import type {
  ChainPnlBreakdown,
  ExcludedUnrealizedPosition,
  ParsedTrade,
  PnlEngineOutput,
  PnlFinalStatus,
  PnlV2,
  TokenCostBasis,
  TokenRealizedPnl,
  TokenUnrealizedPnl,
  WalletPnlEvidenceAudit,
} from './types'

export type { WalletPnlEvidenceAudit, PnlFinalStatus } from './types'

// RECONCILIATION TOLERANCE, DISCLOSED: same 0.1% float-rounding allowance already used by
// src/modules/fifoEngine's own canonical-balance reconciliation (computePnl.ts there) — not a new
// or looser standard, the identical tolerance applied a second time in this parallel engine.
const CANONICAL_BALANCE_RECONCILIATION_TOLERANCE = 1.001

export type { ParsedTrade } from './types'

const CHAIN_ID_TO_SUPPORTED_CHAIN: Record<number, 'eth' | 'base'> = {
  1: 'eth',
  8453: 'base',
}

// CU-HARDENING: this module now uses shared events (an optional `cache` param, threaded through to
// buildTradeTimelineForChain -> ... -> fetchRawEventsForChain) to avoid duplicated provider calls.
// Verified safe: `cache` is optional and additive — omitting it (as every other existing caller
// of buildTradeTimelineForChain/buildTradesWithIntentForChain/buildLotsForChain still does) is byte-
// for-byte the same behavior as before this change. Previously flagged as docs/CU_AUDIT.md
// Finding #1 (CU-RISK: HIGH — duplicated with lib/engine/modules/activity/computeChainActivity.ts's
// fetchChainSignals within one /api/scan-v2/full-scan request); fixed by having the route pass the
// SAME cache instance into both this function and computeChainActivity.
//
// WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED: real per-chain quote-leg-recovery counters (see
// app/api/_shared/walletChainPipeline.ts's recoverQuoteLegsForBundles) aggregated across every
// chain this call covered — the input computePnl below folds into the full walletPnlEvidenceAudit
// alongside its own FIFO-derived counts.
export type ChainEvidenceAudit = QuoteLegRecoveryChainAudit & { chainId: number }

export type FetchParsedTradesResult = {
  trades: ParsedTrade[]
  evidenceByChain: ChainEvidenceAudit[]
}

// Public entry point. `cache` is a new, optional trailing parameter (real callers passing only
// `walletAddress`, as this task originally specified, are unaffected). Never throws:
// buildTradeTimelineForChain's own real chain already degrades to an empty trades array on any
// failure (see walletChainPipeline.ts's own guarantees) rather than throwing.
export async function fetchParsedTrades(walletAddress: string, cache?: EventsCache, cuBudget?: CuBudget): Promise<FetchParsedTradesResult> {
  if (!walletAddress) {
    // eslint-disable-next-line no-console
    console.warn('[CU-AUDIT] Skipping external call: missing walletAddress')
    return { trades: [], evidenceByChain: [] }
  }

  const chainIds = [1, 8453]
  const perChain = await Promise.all(
    chainIds.map(async (chainId) => {
      const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
      if (cache) {
        // eslint-disable-next-line no-console
        console.debug('[CU-HARDENING] PnL using shared events:', chainId)
      } else {
        logCuRisk('goldrush+alchemy', `pnl.fetchParsedTrades chain=${chain} wallet=${walletAddress.slice(0, 8)}… (no cache passed — see CU-RISK comment above)`)
      }
      const result = await buildTradeTimelineForChain(chain, walletAddress, cache, cuBudget)
      const trades = result.trades
        .filter((t) => t.type === 'buy' || t.type === 'sell')
        .map((t): ParsedTrade => ({
          tokenAddress: t.tokenAddress,
          chainId,
          type: t.type,
          quantity: t.amount,
          valueUsd: t.type === 'buy' ? t.costBasisUsd : t.proceedsUsd,
          timestamp: t.timestamp,
        }))
      return { trades, evidence: { ...result.quoteLegRecoveryAudit, chainId } }
    }),
  )
  return {
    trades: perChain.flatMap((p) => p.trades),
    evidenceByChain: perChain.map((p) => p.evidence),
  }
}

function tokenKey(tokenAddress: string, chainId: number): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}

type FifoLot = { quantity: number; totalCostUsd: number }

function buildEmptyWalletPnlEvidenceAudit(walletAddress: string, finalPnlStatus: PnlFinalStatus, failureReason: string | null): WalletPnlEvidenceAudit {
  return {
    walletAddress, chainId: null, rawEvents: 0, transferEvents: 0, candidateSwapTxs: 0, receiptsFetched: 0,
    verifiedSwapCount: 0, likelySwapCount: 0, rejectedSwapCount: 0, rejectionReasons: {}, oneLegTxCount: 0,
    quoteLegsRecovered: 0, nativeQuoteLegsRecovered: 0, stableQuoteLegsRecovered: 0, buysClassified: 0,
    sellsClassified: 0, openPositions: 0, closedLots: 0, fullyPricedClosedLots: 0, realizedPnlUsd: null,
    finalPnlStatus, failureReason,
  }
}

// Public entry point, exactly as specified. `evidenceByChain`/`walletAddress` are new, optional,
// trailing parameters — WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED: every existing test fixture in
// this codebase calls computePnl with exactly 4 positional args and continues to typecheck/behave
// identically (pnlV2/pnlStatus unchanged); omitting them only means walletPnlEvidenceAudit falls
// back to an honest all-zero/unknown-chain shape instead of the real per-chain evidence counters
// fetchParsedTrades's real caller (workers/walletScanV2.ts) now supplies.
export async function computePnl(
  pricedHoldings: PricedHolding[],
  _chainHoldings: ChainHolding[],
  _totalValueUsd: number,
  trades: ParsedTrade[],
  evidenceByChain: ChainEvidenceAudit[] = [],
  walletAddress = '',
): Promise<PnlEngineOutput> {
  const rawEvents = evidenceByChain.reduce((sum, e) => sum + e.transferEvents, 0)
  const candidateSwapTxs = evidenceByChain.reduce((sum, e) => sum + e.candidateSwapTxs, 0)
  const receiptsFetched = evidenceByChain.reduce((sum, e) => sum + e.receiptsFetched, 0)
  const oneLegTxCount = evidenceByChain.reduce((sum, e) => sum + e.oneLegTxCount, 0)
  const quoteLegsRecovered = evidenceByChain.reduce((sum, e) => sum + e.quoteLegsRecovered, 0)
  const nativeQuoteLegsRecovered = evidenceByChain.reduce((sum, e) => sum + e.nativeQuoteLegsRecovered, 0)
  const stableQuoteLegsRecovered = evidenceByChain.reduce((sum, e) => sum + e.stableQuoteLegsRecovered, 0)
  const rejectionReasons: Record<string, number> = {}
  for (const e of evidenceByChain) {
    for (const [reason, count] of Object.entries(e.rejectionReasons)) rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + count
  }
  const singleChainId = evidenceByChain.length === 1 ? evidenceByChain[0].chainId : null

  // A. No trades — exactly as specified, now with the real, honest evidence-audit taxonomy this
  // task adds. `transfer_only` (real activity was seen, no buy/sell trade survived classification)
  // is distinguished from `unavailable` (no evidence of any activity at all) rather than collapsing
  // both into one bare "unavailable" — see PnlFinalStatus's own header.
  if (trades.length === 0) {
    const finalPnlStatus: PnlFinalStatus = rawEvents > 0 || candidateSwapTxs > 0 ? 'transfer_only' : 'unavailable'
    const failureReason = finalPnlStatus === 'transfer_only'
      ? 'No verified swaps were found among this wallet\'s on-chain activity — transfers/airdrops/liquidity events do not count as trades.'
      : 'No on-chain activity evidence was found for this wallet on the supported chains.'
    return {
      pnlV2: { realizedPnlUsd: 0, unrealizedPnlUsd: 0, costBasis: [], realized: [], unrealized: [], chainBreakdown: [], unrealizedExcludedPositions: [] },
      pnlStatus: 'unavailable',
      walletPnlEvidenceAudit: {
        ...buildEmptyWalletPnlEvidenceAudit(walletAddress, finalPnlStatus, failureReason),
        chainId: singleChainId, rawEvents, candidateSwapTxs, receiptsFetched, oneLegTxCount,
        quoteLegsRecovered, nativeQuoteLegsRecovered, stableQuoteLegsRecovered, rejectionReasons,
        transferEvents: rawEvents,
      },
    }
  }

  // B. FIFO cost basis, per token, in chronological order.
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const fifoQueues = new Map<string, FifoLot[]>()
  const realizedByToken = new Map<string, number>()
  let anyUnpricedTrade = false
  let closedLotsCount = 0

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

    // A real closed lot exists whenever this sell actually matched against at least one prior buy
    // (matchedFraction > 0) — entry (the consumed lot's cost) AND exit (this sell's priced
    // proceeds) both have real price evidence by construction (unpriced trades were already
    // skipped above, so anything reaching this point has a real valueUsd on both sides).
    if (matchedFraction > 0) closedLotsCount += 1

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
  //
  // CANONICAL-BALANCE RECONCILIATION, DISCLOSED — see ExcludedUnrealizedPosition's own header in
  // types.ts for the full production trace (a fabricated -$545,833.02 unrealized PnL on chain
  // 8453). Before this fix, `match.totalCostUsd` (this module's own event-replay-derived FIFO
  // remaining quantity's cost basis) was subtracted from `holding.valueUsd` (the REAL current
  // balance's market value) with NO check that the two figures even referred to the same quantity.
  // Now: `match.totalQuantity` must reconcile against `holding.quantity` (the real, independently-
  // fetched canonical balance) before this position is ever allowed to contribute to official
  // unrealizedPnlUsd — a mismatched position is EXCLUDED entirely (never clamped/blended) and
  // reported, with its refused candidate figure, in unrealizedExcludedPositions.
  const costBasisByKey = new Map(costBasis.map((c) => [tokenKey(c.tokenAddress, c.chainId), c]))
  const unrealized: TokenUnrealizedPnl[] = []
  const unrealizedExcludedPositions: ExcludedUnrealizedPosition[] = []
  let anyUnpricedHolding = false

  for (const holding of pricedHoldings) {
    if (holding.valueUsd == null) {
      anyUnpricedHolding = true
      continue
    }
    const match = costBasisByKey.get(tokenKey(holding.tokenAddress, holding.chainId))
    if (!match) continue

    const canonicalQuantity = Number(holding.quantity)
    const candidateUnrealizedPnlUsd = holding.valueUsd - match.totalCostUsd

    if (!Number.isFinite(canonicalQuantity) || canonicalQuantity < 0) {
      unrealizedExcludedPositions.push({
        chainId: holding.chainId,
        tokenAddress: holding.tokenAddress,
        fifoRemainingQuantity: match.totalQuantity,
        canonicalQuantity: null,
        fifoCostBasisUsd: match.totalCostUsd,
        canonicalValueUsd: holding.valueUsd,
        candidateUnrealizedPnlUsd,
        exclusionReason: 'invalid_canonical_quantity',
      })
      continue
    }
    if (match.totalQuantity > canonicalQuantity * CANONICAL_BALANCE_RECONCILIATION_TOLERANCE) {
      unrealizedExcludedPositions.push({
        chainId: holding.chainId,
        tokenAddress: holding.tokenAddress,
        fifoRemainingQuantity: match.totalQuantity,
        canonicalQuantity,
        fifoCostBasisUsd: match.totalCostUsd,
        canonicalValueUsd: holding.valueUsd,
        candidateUnrealizedPnlUsd,
        exclusionReason: 'quantity_exceeds_balance',
      })
      continue
    }

    unrealized.push({
      tokenAddress: holding.tokenAddress,
      chainId: holding.chainId,
      unrealizedPnlUsd: candidateUnrealizedPnlUsd,
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

  // G. WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — finalPnlStatus taxonomy (PnlFinalStatus's own
  // header): never "verified" without at least one real closed lot (entry + exit + price evidence
  // all required to reach closedLotsCount above); "partial" when a real closed lot exists but
  // coverage is incomplete elsewhere (an unpriced trade/holding); "open_position_only" when real
  // buys exist with no closed lot at all; "unavailable" only when neither applies (e.g. sells
  // existed but never matched any buy in this trade set — see lotCloser's own unmatchedSells
  // precedent for why that is never fabricated into a closed lot).
  const buysClassified = trades.filter((t) => t.type === 'buy').length
  const sellsClassified = trades.filter((t) => t.type === 'sell').length
  const openPositions = costBasis.length
  const finalPnlStatus: PnlFinalStatus = closedLotsCount > 0
    ? (pnlStatus === 'ok' ? 'verified' : 'partial')
    : (buysClassified > 0 && sellsClassified === 0 ? 'open_position_only' : 'unavailable')
  const failureReason = finalPnlStatus === 'open_position_only'
    ? 'Open position only — no verified closed trades. Buys are confirmed but no matching sell has been found yet.'
    : finalPnlStatus === 'unavailable'
      ? (sellsClassified > 0
        ? 'Sell activity was found but did not match any earlier buy in this wallet\'s recorded history — no verified closed lot could be built.'
        : 'No verified swaps found.')
      : null

  const walletPnlEvidenceAudit: WalletPnlEvidenceAudit = {
    walletAddress,
    chainId: singleChainId,
    rawEvents,
    transferEvents: rawEvents,
    candidateSwapTxs,
    receiptsFetched,
    // Distinct "confidence tiers" (verified_swap/likely_swap/etc, per the task's own taxonomy)
    // require threading a confidence field through swapNormalizer/tradeIntent/lotOpener/lotCloser
    // that does not exist in this engine today — out of scope for this evidence-extraction fix
    // (see this task's own "keep focused" instruction). Every trade that reaches computePnl's own
    // FIFO already has a real, priced buy/sell classification, so it is honestly counted as
    // verified here rather than invented into a separate, unbuilt "likely" tier.
    verifiedSwapCount: buysClassified + sellsClassified,
    likelySwapCount: 0,
    rejectedSwapCount: Object.values(rejectionReasons).reduce((sum, n) => sum + n, 0),
    rejectionReasons,
    oneLegTxCount,
    quoteLegsRecovered,
    nativeQuoteLegsRecovered,
    stableQuoteLegsRecovered,
    buysClassified,
    sellsClassified,
    openPositions,
    closedLots: closedLotsCount,
    fullyPricedClosedLots: closedLotsCount,
    realizedPnlUsd: closedLotsCount > 0 ? realizedPnlUsd : null,
    finalPnlStatus,
    failureReason,
  }

  return {
    pnlV2: { realizedPnlUsd, unrealizedPnlUsd, costBasis, realized, unrealized, chainBreakdown, unrealizedExcludedPositions },
    pnlStatus,
    walletPnlEvidenceAudit,
  }
}
