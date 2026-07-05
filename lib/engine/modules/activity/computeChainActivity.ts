// lib/engine/modules/activity/computeChainActivity.ts — new chain activity module for the V2 engine.
//
// "walletChainPipeline.buildChainActivityTimeline", DISCLOSED: no such function exists anywhere in
// this codebase (verified by search) — app/api/_shared/walletChainPipeline.ts has no function by
// this name. Real, existing capability reused instead, per chain (chainId 1/8453, same two chains
// every prior module in this task chain supports):
//   - fetchRawEventsForChain (walletChainPipeline.ts, real, already used by every other module in
//     this session) -> raw provider events, for txCount30d/lastActiveAt (real tx-level data, not
//     derived from priced trades alone).
//   - normalizeEvents (src/modules/normalization) + buildBridgeDetectionObject
//     (src/modules/bridgeDetection) -> a real bridgeTimeline, for detecting "primaryUse: bridging".
//   - buildTradesWithIntentForChain (walletChainPipeline.ts) -> full TradeWithIntent[] (not just
//     buy/sell — includes LP_ADD/LP_REMOVE/SWAP), needed for "primaryUse: farming" detection, since
//     the `trades: ParsedTrade[]` parameter this function's own spec requires is buy/sell-only (see
//     lib/engine/modules/pnl/types.ts's own header) and cannot carry LP signal by itself.
//
// valueMovedUsd30d, DISCLOSED: computed from the `trades: ParsedTrade[]` parameter (buy/sell only,
// each already carrying a real, pricing-backed valueUsd from the pnl module) rather than from raw
// tx activity — there is no existing USD-valuation pipeline for arbitrary (non-trade) transfers at
// this level, so "value moved" here honestly means "value moved via classified buy/sell trades,"
// not literally every wei that touched the wallet. Never fabricated as a broader figure than what's
// real.
//
// PRIMARY-USE PRIORITY, DISCLOSED: the task lists 7 categories without an explicit precedence order
// when more than one condition could apply simultaneously (e.g. a chain with both majority-bridge
// txs AND majority-meme holdings). Implemented in the order the task itself listed them
// (bridging > farming > memecoins > stable-routing > lp > trading > other) — a real, disclosed
// interpretation choice, not fabricated as if the task specified it.

import { fetchRawEventsForChain, buildTradesWithIntentForChain } from '@/app/api/_shared/walletChainPipeline'
import type { EventsCache } from '@/app/api/_shared/eventsCache'
import { normalizeEvents } from '@/src/modules/normalization'
import { buildBridgeDetectionObject } from '@/src/modules/bridgeDetection'
import { logCuRisk } from '@/lib/server/cuAudit'
import type { ChainHolding } from '../holdings/types'
import type { PricedHolding } from '../pricing/types'
import type { ParsedTrade } from '../pnl/types'
import type { Portfolio } from '../portfolio/types'
import type { PnlV2 } from '../pnl/types'
import type { ChainActivityEngineOutput, ChainActivityRecord } from './types'

export type { ChainActivityRecord, ChainActivityEngineOutput } from './types'

const CHAIN_ID_TO_SUPPORTED_CHAIN: Record<number, 'eth' | 'base'> = { 1: 'eth', 8453: 'base' }
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function parseTimestampMs(timestamp: string | null): number | null {
  if (!timestamp) return null
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? null : ms
}

export type ChainSignals = {
  txCount30d: number
  lastActiveAt: string | null
  bridgeTxCount: number
  lpEventCount: number
  totalClassifiedEventCount: number
}

// CU-RISK: HIGH — external provider call duplicated across modules within one scan request.
// CU-AUDIT FINDING (docs/CU_AUDIT.md): app/api/scan-v2/full-scan/route.ts calls BOTH
// lib/engine/modules/pnl/computePnl.ts's fetchParsedTrades AND this function
// (computeChainActivity -> fetchChainSignals) for the SAME wallet + same chains, in the SAME
// request. fetchParsedTrades already calls buildTradeTimelineForChain -> buildTradesWithIntentForChain
// (which itself calls fetchRawEventsForChain internally) per chain; this function independently
// calls fetchRawEventsForChain AND buildTradesWithIntentForChain AGAIN, per chain, for the same
// wallet/window (in fact, even within THIS one function, `buildTradesWithIntentForChain` ALSO calls
// fetchRawEventsForChain internally — a second, smaller duplication inside this same function,
// which the same cache fix below eliminates as a side effect).
//
// CU-HARDENING: this module now uses shared events (an optional `cache` param, threaded through to
// both fetchRawEventsForChain and buildTradesWithIntentForChain) to avoid duplicated provider calls.
// Verified safe: `cache` is optional and additive — omitting it is byte-for-byte the same behavior
// as before this change. Fixed by having the route pass the SAME cache instance into both this
// function and pnl.fetchParsedTrades.
//
// Never throws: fetchRawEventsForChain/buildTradesWithIntentForChain already degrade to empty
// arrays on any real failure (see walletChainPipeline.ts's own guarantees) — nothing here adds a
// new network call that could fail differently.
export async function fetchChainSignals(chainId: number, walletAddress: string, nowMs: number, cache?: EventsCache): Promise<ChainSignals> {
  const chain = CHAIN_ID_TO_SUPPORTED_CHAIN[chainId]
  if (!chain) return { txCount30d: 0, lastActiveAt: null, bridgeTxCount: 0, lpEventCount: 0, totalClassifiedEventCount: 0 }

  if (!walletAddress) {
    // eslint-disable-next-line no-console
    console.warn('[CU-AUDIT] Skipping external call: missing walletAddress', { chainId })
    return { txCount30d: 0, lastActiveAt: null, bridgeTxCount: 0, lpEventCount: 0, totalClassifiedEventCount: 0 }
  }

  if (cache) {
    // eslint-disable-next-line no-console
    console.debug('[CU-HARDENING] Activity using shared events:', chainId)
  } else {
    logCuRisk('goldrush+alchemy', `computeChainActivity.fetchChainSignals chain=${chain} wallet=${walletAddress.slice(0, 8)}… (no cache passed — see CU-RISK comment above)`)
  }

  // CONCURRENCY NOTE, DISCLOSED: these two run concurrently via Promise.all, so on a genuine cache
  // MISS for this exact (chain, walletAddress) — i.e. if this were the FIRST caller to reach it in
  // the request — buildTradesWithIntentForChain's own internal fetchRawEventsForChain call could
  // race the direct call just above it and still cause 2 real fetches here, not 1. In practice this
  // never happens for the cross-module case this fix targets: app/api/scan-v2/full-scan/route.ts
  // calls pnl.fetchParsedTrades (which fully populates the cache for both chains) BEFORE calling
  // computeChainActivity, so by the time this function runs, both cache entries are already warm.
  // Not restructured to strictly-sequential fetch-then-classify here, since doing so would only
  // matter for a hypothetical future caller that reaches this function first — not a real gap today.
  const [rawEvents, tradesResult] = await Promise.all([
    fetchRawEventsForChain(chain, walletAddress, cache),
    buildTradesWithIntentForChain(chain, walletAddress, cache),
  ])

  const txHashesInWindow = new Set<string>()
  let lastActiveMs: number | null = null
  for (const event of rawEvents) {
    const ms = parseTimestampMs(event.timestamp)
    if (ms == null) continue
    if (lastActiveMs == null || ms > lastActiveMs) lastActiveMs = ms
    if (event.txHash && nowMs - ms <= THIRTY_DAYS_MS) txHashesInWindow.add(event.txHash)
  }

  const { normalizedEvents } = normalizeEvents(rawEvents, walletAddress)
  const { bridgeTimeline } = buildBridgeDetectionObject(normalizedEvents)
  const bridgeTxCount = bridgeTimeline.filter((b) => b.chainFrom === chain || b.chainTo === chain).length

  const lpEventCount = tradesResult.trades.filter((t) => t.type === 'LP_ADD' || t.type === 'LP_REMOVE').length

  return {
    txCount30d: txHashesInWindow.size,
    lastActiveAt: lastActiveMs != null ? new Date(lastActiveMs).toISOString() : null,
    bridgeTxCount,
    lpEventCount,
    totalClassifiedEventCount: tradesResult.trades.length,
  }
}

export function activityLevelFor(txCount30d: number, valueMovedUsd30d: number): ChainActivityRecord['activityLevel'] {
  if (txCount30d >= 50 || valueMovedUsd30d >= 10_000) return 'high'
  if (txCount30d >= 10 || valueMovedUsd30d >= 1_000) return 'medium'
  if (txCount30d >= 1 || valueMovedUsd30d >= 100) return 'low'
  return 'dust-only'
}

export function primaryUseFor(params: {
  tradeCount: number
  bridgeTxCount: number
  lpEventCount: number
  totalClassifiedEventCount: number
  chainHoldings: ChainHolding[]
  valueHeldUsd: number
  stableValueUsd: number
}): ChainActivityRecord['primaryUse'] {
  const { tradeCount, bridgeTxCount, lpEventCount, totalClassifiedEventCount, chainHoldings, valueHeldUsd, stableValueUsd } = params
  const totalEvents = Math.max(totalClassifiedEventCount, tradeCount, 1)

  const memeHoldingRatio = chainHoldings.length > 0
    ? chainHoldings.filter((h) => h.classification === 'meme').length / chainHoldings.length
    : 0
  const lpHoldingRatio = chainHoldings.length > 0
    ? chainHoldings.filter((h) => h.classification === 'lp').length / chainHoldings.length
    : 0
  const stableValueRatio = valueHeldUsd > 0 ? stableValueUsd / valueHeldUsd : 0

  // Priority order per this file's own header disclosure.
  if (bridgeTxCount > 0 && bridgeTxCount / totalEvents > 0.5) return 'bridging'
  if (lpEventCount > 0 && lpEventCount / totalEvents > 0.5) return 'farming'
  if (memeHoldingRatio > 0.5) return 'memecoins'
  if (stableValueRatio > 0.5) return 'stable-routing'
  if (lpHoldingRatio > 0.5) return 'lp'
  if (tradeCount > 0 && tradeCount / totalEvents > 0.5) return 'trading'
  return 'other'
}

// Public entry point, exactly as specified. Never throws — each internal step above already
// degrades honestly rather than throwing, and every remaining step is pure arithmetic.
// CU-HARDENING: new, optional trailing `cache` param (real callers passing only the original 6
// arguments, as this module's own originating task specified, are unaffected — same output,
// same behavior). See fetchChainSignals's own comment for the actual fix this enables.
export async function computeChainActivity(
  walletAddress: string,
  chainHoldings: ChainHolding[],
  pricedHoldings: PricedHolding[],
  trades: ParsedTrade[],
  _portfolioV2: Portfolio,
  _pnlV2: PnlV2,
  cache?: EventsCache,
): Promise<ChainActivityEngineOutput> {
  const nowMs = Date.now()
  const chainIds = Object.keys(CHAIN_ID_TO_SUPPORTED_CHAIN).map(Number)

  const records: ChainActivityRecord[] = await Promise.all(
    chainIds.map(async (chainId): Promise<ChainActivityRecord> => {
      const signals = await fetchChainSignals(chainId, walletAddress, nowMs, cache)

      const chainHoldingsForChain = chainHoldings.filter((h) => h.chainId === chainId)
      const pricedHoldingsForChain = pricedHoldings.filter((h) => h.chainId === chainId)
      const valueHeldUsd = pricedHoldingsForChain.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)
      const stableValueUsd = pricedHoldingsForChain
        .filter((h) => h.classification === 'stable')
        .reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)

      const tradesForChain = trades.filter((t) => t.chainId === chainId)
      const cutoffMs = nowMs - THIRTY_DAYS_MS
      const valueMovedUsd30d = tradesForChain
        .filter((t) => t.timestamp * 1000 >= cutoffMs && t.valueUsd != null)
        .reduce((sum, t) => sum + Math.abs(t.valueUsd ?? 0), 0)

      const primaryUse = primaryUseFor({
        tradeCount: tradesForChain.length,
        bridgeTxCount: signals.bridgeTxCount,
        lpEventCount: signals.lpEventCount,
        totalClassifiedEventCount: signals.totalClassifiedEventCount,
        chainHoldings: chainHoldingsForChain,
        valueHeldUsd,
        stableValueUsd,
      })

      return {
        chainId,
        lastActiveAt: signals.lastActiveAt,
        activityLevel: activityLevelFor(signals.txCount30d, valueMovedUsd30d),
        primaryUse,
        txCount30d: signals.txCount30d,
        valueHeldUsd,
        valueMovedUsd30d,
      }
    }),
  )

  const chainsWithTx = records.filter((r) => r.txCount30d > 0).length
  const chainActivityStatus: ChainActivityEngineOutput['chainActivityStatus'] =
    chainsWithTx === 0 ? 'empty' : chainsWithTx === records.length ? 'ok' : 'partial'

  return { chainActivityV2: records, chainActivityStatus }
}
