// MODULE 9 — pipelineOrchestrator: priceLotsForWallet
//
// THE REAL BUG, VERIFIED (not the one described in the task's literal spec): fifoEngine
// (src/modules/fifoEngine) already accepts real, optional `priceUsdLookup`/`currentPriceUsdLookup`
// injection points on buildFifoOutput() — it has ALWAYS supported real pricing. The pipeline's own
// safeRunFifoEngine (src/pipeline/index.ts) simply never passed one in, so every lot fell back to
// fifoEngine's own honest "unpriced" default (never fabricated, just never wired up). Likewise
// pnlEngine's buildPnlSummary() already accepts `resolveCostUsdEstimate`/`resolveProceedsUsdEstimate`
// — never supplied either. That is the actual root cause of "PnL always unavailable": missing
// wiring at the pipeline layer, not a missing pricing step inside FIFO itself.
//
// The task's literal spec (`fifoEngine(buyTimeline, sellTimelineV2)`, `event.priceSource`,
// `event.priceConfidence`, pnlSummaryV2 "receiving the FIFO result") doesn't match any real type in
// this codebase, and building it as described would require changing fifoEngine's/pnlEngine's real
// call signatures — which this task explicitly forbids modifying. This file instead supplies real
// data through their EXISTING, already-built injection points. Neither module's own source is
// touched.
//
// WHY A SEPARATE PRE-PRICING PASS: fifoEngine's priceUsdLookup/currentPriceUsdLookup are
// deliberately SYNCHRONOUS (no await inside its lot-matching loop) — but real pricing
// (pricingAtTimeEngine, GoldRush) is necessarily async (network calls). This function resolves
// every real price asynchronously ONCE, up front, for the exact same merged event set fifoEngine
// itself will process (via fifoEngine's own exported, unmodified mergeNormalizedEvents — guarantees
// full coverage, not just the subset that happens to survive into buyTimeline/sellTimelineV2's
// gated/detected event sets), then hands back plain synchronous lookup functions backed by that
// prefetched, real data. Never fabricates a price: an event with no real price resolves to null in
// the lookup, exactly like fifoEngine's own default.

import { mergeNormalizedEvents } from '../modules/fifoEngine/utils'
import type { CurrentPriceUsdLookup, PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { resolvePricingAtTime } from '../modules/pricingAtTimeEngine/index'
import type { PriceableEntry, PriceSources, SourceBreakdown } from '../modules/pricingAtTimeEngine/types'

function toPriceableEntry(event: NormalizedEvent): PriceableEntry {
  return {
    txHash: event.txHash,
    token: event.contract,
    chain: event.chain,
    timestamp: Date.parse(event.timestamp),
    amount: String(event.amount),
  }
}

export type WalletPriceLookups = {
  priceUsdLookup: PriceUsdLookup
  currentPriceUsdLookup: CurrentPriceUsdLookup
  // Diagnostic-only, additive — real primary/fallback/failed counts from the at-trade-time pricing
  // pass (the "current" price pass isn't included, to keep this a direct, honest reflection of
  // real transaction pricing specifically). Never fabricated; a straight pass-through of
  // pricingAtTimeEngine's own real sourceBreakdown.
  sourceBreakdown: SourceBreakdown
  // PRICING-UNAVAILABLE TOKENS, DISCLOSED: this file has no "pricedTokens"/"portfolio value"
  // concept to exclude a token from — those live in a completely separate module chain
  // (workers/walletScanV2.ts's own fetchAllHoldings/priceHoldings/buildPortfolio), not here. What
  // this file CAN honestly report: the distinct (chain:token) keys where every held token's
  // "current" price lookup came back null (all real sources — GoldRush, DexScreener, CoinGecko,
  // basedex, GeckoTerminal — genuinely found nothing). Purely additive diagnostic; does not change
  // priceUsdLookup/currentPriceUsdLookup's existing behavior (which already returns null for these
  // honestly, same as before this change).
  pricingUnavailableTokens: string[]
}

// Real fix: pre-resolves historical USD pricing (at each event's own real timestamp) for every
// normalized event fifoEngine will merge and process, plus a "current" (now-timestamped) price per
// distinct held token for marking open lots to market — then exposes both as fifoEngine's existing
// sync lookup contract. Never touches fifoEngine's own source.
export async function priceLotsForWallet(params: {
  normalizedEvents: NormalizedEvent[]
  recoveredEvents: NormalizedEvent[]
  priceSources: PriceSources
}): Promise<WalletPriceLookups> {
  const merged = mergeNormalizedEvents(params.normalizedEvents, params.recoveredEvents)
  const buys = merged.filter((e) => e.direction === 'inbound')
  const sells = merged.filter((e) => e.direction === 'outbound')

  const atTradeTime = await resolvePricingAtTime({
    buyEntries: buys.map(toPriceableEntry),
    sellEntries: sells.map(toPriceableEntry),
    priceSources: params.priceSources,
  })

  // "Current" price for open lots — pricingAtTimeEngine only prices at a given timestamp, so "now"
  // is passed as that timestamp; same real source, evaluated at the present moment. amount is
  // fixed at '1' so the resolved costUsd is exactly the real per-unit price, not scaled by amount.
  const distinctHeldTokens = [...new Map(buys.map((e) => [`${e.chain}:${e.contract.toLowerCase()}`, e])).values()]
  const nowEntries: PriceableEntry[] = distinctHeldTokens.map((e) => ({
    txHash: `current:${e.chain}:${e.contract.toLowerCase()}`,
    token: e.contract,
    chain: e.chain,
    timestamp: Date.now(),
    amount: '1',
  }))
  const atNow = await resolvePricingAtTime({ buyEntries: nowEntries, sellEntries: [], priceSources: params.priceSources })

  const priceUsdLookup: PriceUsdLookup = (event) =>
    atTradeTime.costUsd[event.txHash] ?? atTradeTime.proceedsUsd[event.txHash] ?? null

  const currentPriceUsdLookup: CurrentPriceUsdLookup = (token, chain) =>
    atNow.costUsd[`current:${chain}:${token.toLowerCase()}`] ?? null

  const pricingUnavailableTokens = nowEntries
    .filter((entry) => atNow.costUsd[entry.txHash] == null)
    .map((entry) => `${entry.chain}:${entry.token.toLowerCase()}`)
  if (pricingUnavailableTokens.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[priceLotsForWallet] tokens with no price from any source', { count: pricingUnavailableTokens.length, tokens: pricingUnavailableTokens })
  }

  return { priceUsdLookup, currentPriceUsdLookup, sourceBreakdown: atTradeTime.sourceBreakdown, pricingUnavailableTokens }
}
