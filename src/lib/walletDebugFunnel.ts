// TEMPORARY DIAGNOSTIC — Wallet Scanner "missed buys/sells" investigation.
// Enabled only with WALLET_DEBUG=1. Read-only: builds a per-stage count funnel from values the
// pipeline has already computed and logs it once per scan as `[wallet-debug-funnel]`. Changes no
// scan logic and makes no provider calls. Remove once the investigation is closed.

import type { NormalizedEvent } from '../modules/normalization/types'
import type { NormalizationError } from '../modules/normalization/types'
import type { ProviderFetchWindowResult, RawProviderEvent } from '../modules/providerFetchWindow/types'
import type { TimelineBuilderResult } from '../modules/timelineBuilder/types'
import type { FifoOutput } from '../modules/fifoEngine/types'
import { classifyEvents, type EventClassificationContext } from '../modules/eventClassification/index'

export function isWalletDebugEnabled(): boolean {
  return process.env.WALLET_DEBUG === '1'
}

const NATIVE_ASSET_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
/** alchemy_getAssetTransfers maxCount used by providerFetchWindow (0xC8) per direction. */
const ALCHEMY_PAGE_SIZE = 200

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) { const k = key(item); out[k] = (out[k] ?? 0) + 1 }
  return out
}

function category(event: RawProviderEvent): 'native' | 'erc20' {
  return (event.contract ?? '').toLowerCase() === NATIVE_ASSET_ADDRESS ? 'native' : 'erc20'
}

type ProviderStageRow = {
  chain: string
  provider: 'goldrush' | 'alchemy'
  ok: boolean
  errorReason: string | null
  rawByCategory: Record<string, number>
  rawByDirection: { outbound: number; inbound: number; other: number }
  pagination: {
    pagesRequested: number | null
    nextPageKeyPresent: boolean | null
    providerCapReached: boolean | null
    /** Why fetching stopped: exhausted (all history in range read), page_cap (more pages existed but
     *  this module never follows pageKey), event_cap (MAX_RAW_EVENTS_PER_PROVIDER), failed. */
    stoppedBecause: 'exhausted' | 'page_cap_more_available' | 'event_cap' | 'failed' | 'unknown'
    /** Alchemy only: a direction whose page came back full (200) — older rows in that direction were never read. */
    fullDirections: string[]
  }
  budgetRefusals: number
  http429Count: number
}

export type WalletDebugFunnel = {
  wallet: string
  windowDays: number | null
  stage1_providers: ProviderStageRow[]
  stage2_merge: { goldrushPlusAlchemy: number; afterCrossProviderDedupe: number; crossProviderDuplicates: number; afterHistoricalStabilization: number }
  stage3_normalization: { in: number; out: number; droppedByReason: Record<string, number> }
  stage4_spamAndDust: { note: string; dustNonEconomic: number }
  stage5_txPairing: {
    txs: number
    pairedSwapTxs: number
    inboundOnlyTxs: number
    outboundOnlyTxs: number
    outboundOnlyToKnownRouter: number
    outboundOnlyNativeQuoteInvisible: number
  }
  stage6_classification: Record<string, number>
  stage7_timelines: { buyTimeline: number; buyBySource: Record<string, number>; outboundEvents: number; sellTimeline: number; outboundNotSellShaped: number }
  stage8_fifo: {
    inboundFedToFifo: number
    outboundFedToFifo: number
    matchedLots: number
    lotsByEvidence: Record<string, number>
    lotsMissingPrice: number
    unmatchedBuys: number
    unmatchedSells: number
    estimateOnlyLotsExcluded: number
    syntheticLotsExcluded: number
    hardInvalid: boolean
  }
  /** User-facing drop taxonomy, each mapped to the stage that produces it. */
  dropReasons: {
    no_price: number
    router_unmatched: number
    unmatched_sell_no_prior_buy: number
    one_legged: number
    deduped: number
    cost_gate: number
    depth_limit: number
  }
  survivors: { buys: number; sells: number; closedTrades: number; pricedClosedTrades: number }
}

export type WalletDebugFunnelInput = {
  walletAddress: string
  windowDays: number | null
  providerResults: readonly ProviderFetchWindowResult[]
  stabilizedRawEventCount: number
  normalizedEvents: readonly NormalizedEvent[]
  normalizationErrors: readonly NormalizationError[]
  timelines: TimelineBuilderResult
  fifo: FifoOutput
  fifoEligibleEvents: readonly NormalizedEvent[]
  classificationContext: EventClassificationContext
}

/** PURE. */
export function buildWalletDebugFunnel(input: WalletDebugFunnelInput): WalletDebugFunnel {
  const wallet = input.walletAddress.toLowerCase()

  const stage1: ProviderStageRow[] = []
  let goldrushPlusAlchemy = 0
  let afterCrossProviderDedupe = 0
  let budgetRefusalsTotal = 0
  let depthLimitedSources = 0
  for (const r of input.providerResults) {
    afterCrossProviderDedupe += r.rawEvents.length
    for (const provider of ['goldrush', 'alchemy'] as const) {
      const p = r.providerResults[provider]
      goldrushPlusAlchemy += p.events.length
      const outbound = p.events.filter(e => (e.fromAddress ?? '').toLowerCase() === wallet).length
      const inbound = p.events.filter(e => (e.toAddress ?? '').toLowerCase() === wallet).length
      const fullDirections = provider === 'alchemy'
        ? [outbound >= ALCHEMY_PAGE_SIZE ? 'outbound' : null, inbound >= ALCHEMY_PAGE_SIZE ? 'inbound' : null].filter((d): d is string => d != null)
        : []
      const pg = p.pagination
      const stoppedBecause: ProviderStageRow['pagination']['stoppedBecause'] = !p.ok ? 'failed'
        : !pg ? 'unknown'
        : pg.nextPageKeyPresent ? 'page_cap_more_available'
        : pg.providerCapReached ? 'event_cap'
        : 'exhausted'
      if (stoppedBecause === 'page_cap_more_available' || stoppedBecause === 'event_cap') depthLimitedSources += 1
      const budgetRefusals = p.diagnostics?.budgetRefusals ?? (p.errorReason === 'provider_budget_exhausted' ? 1 : 0)
      budgetRefusalsTotal += budgetRefusals
      stage1.push({
        chain: r.chain,
        provider,
        ok: p.ok,
        errorReason: p.errorReason ?? null,
        rawByCategory: countBy(p.events, category),
        rawByDirection: { outbound, inbound, other: p.events.length - outbound - inbound },
        pagination: {
          pagesRequested: pg?.pagesRequested ?? null,
          nextPageKeyPresent: pg?.nextPageKeyPresent ?? null,
          providerCapReached: pg?.providerCapReached ?? null,
          stoppedBecause,
          fullDirections,
        },
        budgetRefusals,
        http429Count: (p.diagnostics as { http429Count?: number } | undefined)?.http429Count ?? 0,
      })
    }
  }

  const droppedByReason = countBy(input.normalizationErrors, e => e.reason)

  // tx-hash pairing, the same grouping timelineBuilder/eventClassification use.
  const byTx = new Map<string, NormalizedEvent[]>()
  for (const e of input.normalizedEvents) {
    const k = `${e.chain}:${e.txHash.toLowerCase()}`
    const list = byTx.get(k); if (list) list.push(e); else byTx.set(k, [e])
  }
  let pairedSwapTxs = 0, inboundOnlyTxs = 0, outboundOnlyTxs = 0, outboundOnlyToKnownRouter = 0, outboundOnlyNativeQuoteInvisible = 0
  for (const legs of byTx.values()) {
    const ins = legs.filter(l => l.direction === 'inbound')
    const outs = legs.filter(l => l.direction === 'outbound')
    const paired = ins.some(i => outs.some(o => o.contract.toLowerCase() !== i.contract.toLowerCase()))
    if (paired) pairedSwapTxs += 1
    else if (ins.length > 0 && outs.length === 0) inboundOnlyTxs += 1
    else if (outs.length > 0 && ins.length === 0) {
      outboundOnlyTxs += 1
      if (outs.some(o => input.classificationContext.knownDexRouterAddresses.has(o.toAddress.toLowerCase()))) {
        outboundOnlyToKnownRouter += 1
        // A token sent to a router with nothing coming back in the fetched data: the classic
        // token→ETH sell whose ETH arrives as an internal transfer (not fetched: erc20-only query).
        if (outs.every(o => o.contract.toLowerCase() !== NATIVE_ASSET_ADDRESS)) outboundOnlyNativeQuoteInvisible += 1
      }
    }
  }

  const classified = classifyEvents(input.normalizedEvents, input.classificationContext)
  const classification = countBy(classified, c => c.classification)

  const buyBySource = countBy(input.timelines.buyTimeline.entries, e => e.sourceType)
  const outboundEvents = input.normalizedEvents.filter(e => e.direction === 'outbound').length
  const sellTimeline = input.timelines.sellTimeline.totalSells

  const lots = input.fifo.matchedLots
  const lotsByEvidence = countBy(lots, l => l.evidenceQuality)
  const lotsMissingPrice = lots.filter(l => l.costBasisUsd == null || l.proceedsUsd == null).length
  const pricedClosedTrades = lots.filter(l => l.costBasisUsd != null && l.proceedsUsd != null && l.realizedPnlUsd != null).length

  return {
    wallet,
    windowDays: input.windowDays,
    stage1_providers: stage1,
    stage2_merge: {
      goldrushPlusAlchemy,
      afterCrossProviderDedupe,
      crossProviderDuplicates: goldrushPlusAlchemy - afterCrossProviderDedupe,
      afterHistoricalStabilization: input.stabilizedRawEventCount,
    },
    stage3_normalization: {
      in: input.stabilizedRawEventCount,
      out: input.normalizedEvents.length,
      droppedByReason,
    },
    stage4_spamAndDust: {
      note: 'No dedicated spam filter in this pipeline: GoldRush is queried with no-spam=true, Alchemy is not filtered; sub-1e-6 amounts are classified dust.',
      dustNonEconomic: classification.dust_non_economic ?? 0,
    },
    stage5_txPairing: { txs: byTx.size, pairedSwapTxs, inboundOnlyTxs, outboundOnlyTxs, outboundOnlyToKnownRouter, outboundOnlyNativeQuoteInvisible },
    stage6_classification: classification,
    stage7_timelines: {
      buyTimeline: input.timelines.buyTimeline.totalBuys,
      buyBySource,
      outboundEvents,
      sellTimeline,
      outboundNotSellShaped: outboundEvents - sellTimeline,
    },
    stage8_fifo: {
      inboundFedToFifo: input.fifoEligibleEvents.filter(e => e.direction === 'inbound').length,
      outboundFedToFifo: input.fifoEligibleEvents.filter(e => e.direction === 'outbound').length,
      matchedLots: lots.length,
      lotsByEvidence,
      lotsMissingPrice,
      unmatchedBuys: input.fifo.unmatchedBuys,
      unmatchedSells: input.fifo.unmatchedSells,
      estimateOnlyLotsExcluded: input.fifo.integrityFlags.estimateOnlyLotsExcluded,
      syntheticLotsExcluded: input.fifo.integrityFlags.syntheticLotsExcluded,
      hardInvalid: input.fifo.integrityFlags.hardInvalid,
    },
    dropReasons: {
      no_price: lotsMissingPrice + input.fifo.integrityFlags.estimateOnlyLotsExcluded,
      router_unmatched: classification.router_intermediary ?? 0,
      unmatched_sell_no_prior_buy: input.fifo.unmatchedSells,
      one_legged: outboundEvents - sellTimeline,
      deduped: (goldrushPlusAlchemy - afterCrossProviderDedupe) + (droppedByReason.duplicate_event ?? 0),
      cost_gate: budgetRefusalsTotal,
      depth_limit: depthLimitedSources,
    },
    survivors: {
      buys: input.timelines.buyTimeline.totalBuys,
      sells: sellTimeline,
      closedTrades: lots.length,
      pricedClosedTrades,
    },
  }
}

export function logWalletDebugFunnel(funnel: WalletDebugFunnel): void {
  console.warn('[wallet-debug-funnel]', JSON.stringify(funnel))
}
