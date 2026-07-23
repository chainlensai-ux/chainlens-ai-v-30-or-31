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
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import type { CurrentPriceUsdLookup, MatchedLot, PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { resolvePricingAtTime } from '../modules/pricingAtTimeEngine/index'
import type { PriceableEntry, PriceSources, SourceBreakdown } from '../modules/pricingAtTimeEngine/types'
import { pricingRouteLog, type PricingRouteRecord } from './pricingAtTimeAdapter'

function toPriceableEntry(event: NormalizedEvent, pairRank: number | undefined): PriceableEntry {
  return {
    txHash: event.txHash,
    token: event.contract,
    chain: event.chain,
    timestamp: Date.parse(event.timestamp),
    amount: String(event.amount),
    pairRank,
  }
}

// PURE. Exported for direct unit testing.
//
// COMPLETE-PAIR RANKING, DISCLOSED (confirmed follow-up bug — see pricingAtTimeEngine/index.ts's own
// "COMPLETE-PAIR FIX" comment for the full trace): a flat priority boolean still let a token's
// several closed-lot BUYS all outrank every one of that same token's closed-lot SELLS (buys always
// listed first), so a token with more than one closed lot spent its shared cap on 2 buys and zero
// sells ever priced. This assigns each closed lot a per-token rank (0 = highest priority for that
// token) so its own entry+exit share one rank — priceAllEntries then finishes rank 0's complete pair
// before ever spending a slot on rank 1's, so a bounded cap yields "N complete pairs" rather than
// "2N half pairs." A buy or sell txHash appearing in more than one matched-lot row (a single lot
// partially consumed across multiple sells, or a single sell drawing from multiple lots) keeps the
// LOWEST (best) rank it's needed at across every row — it is never de-prioritized by a later, lower-
// priority appearance.
//
// TIE-BREAK, DISCLOSED: no USD value exists yet at this pre-pricing stage to rank by real
// "meaningfulness" — amount (raw token quantity) is used as a best-effort, honestly-labeled proxy
// for "larger position, more likely meaningful," never a price. Ties broken by earliest closedAt
// (matches FIFO's own oldest-first philosophy), then closedTxHash for full determinism.
export function assignClosedLotPairRanks(
  matchedLots: readonly Pick<MatchedLot, 'token' | 'chain' | 'openedTxHash' | 'closedTxHash' | 'closedAt' | 'amount'>[],
): { entryRankByTxHash: Map<string, number>; exitRankByTxHash: Map<string, number> } {
  const byToken = new Map<string, typeof matchedLots[number][]>()
  for (const lot of matchedLots) {
    const key = `${lot.chain}:${lot.token.toLowerCase()}`
    const list = byToken.get(key) ?? []
    list.push(lot)
    byToken.set(key, list)
  }

  const entryRankByTxHash = new Map<string, number>()
  const exitRankByTxHash = new Map<string, number>()

  for (const lots of byToken.values()) {
    const sorted = [...lots].sort((a, b) =>
      b.amount - a.amount || a.closedAt - b.closedAt || a.closedTxHash.localeCompare(b.closedTxHash))
    sorted.forEach((lot, rank) => {
      const priorEntryRank = entryRankByTxHash.get(lot.openedTxHash)
      if (priorEntryRank === undefined || rank < priorEntryRank) entryRankByTxHash.set(lot.openedTxHash, rank)
      const priorExitRank = exitRankByTxHash.get(lot.closedTxHash)
      if (priorExitRank === undefined || rank < priorExitRank) exitRankByTxHash.set(lot.closedTxHash, rank)
    })
  }

  return { entryRankByTxHash, exitRankByTxHash }
}

// PURE. Exported for direct unit testing (this project's test runner can't reliably mock module
// imports — see fetchPricing.ts's own header for the same disclosed limitation — so the fix below
// is pulled out as an isolated, directly-callable function instead).
//
// DIRECTION-BLIND LOOKUP BUG, DISCLOSED AND FIXED (confirmed, high-severity): costUsd/proceedsUsd
// are both keyed purely by txHash (resolvePricingAtTime's usdByTxHash — see
// pricingAtTimeEngine/index.ts). A single swap transaction produces one inbound (buy) leg and one
// outbound (sell) leg of DIFFERENT tokens sharing that same txHash — the standard shape of virtually
// every on-chain swap. fifoEngine calls this exact lookup for BOTH buy events (buildLots) and sell
// events (matchLotsFIFO) — see fifoEngine/index.ts. The previous
// `costUsd[event.txHash] ?? proceedsUsd[event.txHash]` tried costUsd FIRST regardless of the event's
// own direction: for a sell whose transaction also had a paired buy leg (i.e. almost every real
// sell), costUsd[txHash] was already non-null (the DIFFERENT, paired token's cost), so the ??
// short-circuited and returned that wrong value instead of ever consulting proceedsUsd[txHash] — the
// sell's own correct price. This silently corrupted realized PnL with a different token's price
// whenever PnL actually computed a number, rather than leaving it honestly null. Fixed by dispatching
// on event.direction so each event only ever consults its own correct dictionary — no cross-
// dictionary fallback, matching this codebase's "unpriced stays null, never borrowed from elsewhere"
// convention.
export function resolveEventPriceUsd(
  event: Pick<NormalizedEvent, 'txHash' | 'direction'>,
  costUsd: Record<string, number | null>,
  proceedsUsd: Record<string, number | null>,
): number | null {
  if (event.direction === 'inbound') return costUsd[event.txHash] ?? null
  if (event.direction === 'outbound') return proceedsUsd[event.txHash] ?? null
  return null // 'unknown' direction — never guess which dictionary applies
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
  // HISTORICAL PRICING ATTEMPT LOG, DISCLOSED: real per-attempt records from
  // pricingAtTimeAdapter.ts's chain-aware router (src/pipeline/pricingAtTimeAdapter.ts's
  // pricingRouteLog) — a snapshot/delta slice scoped to exactly this call's own two
  // resolvePricingAtTime passes (at-trade-time + current), same cross-request-leak guard pattern
  // already used around lib/server/rpcDebug.ts's rpcDebugLog elsewhere in this pipeline.
  historicalPricingAttempts: PricingRouteRecord[]
  historicalPricingFailures: PricingRouteRecord[]
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

  // PHASE A — STRUCTURAL (PRICE-FREE) FIFO PRE-PASS, DISCLOSED (confirmed bug fix: fullyPricedLots
  // stayed 0 even after the dense per-token cap was raised, because ALL buys were dispatched before
  // ANY sells — see pricingAtTimeEngine/index.ts's priceAllEntries — so a token bought more than once
  // before being sold had its own repeat buys consume every cap slot ahead of its own sell).
  // fifoEngine's buildLots/matchLotsFIFO already match purely by quantity + chronology — a real price
  // is only ATTACHED afterward, never required to determine which buy pairs with which sell (both
  // default their priceUsdLookup param to "always null" — see fifoEngine/index.ts). Reusing those
  // exact, unmodified, already-exported functions here with no price lookup costs zero network calls
  // and produces the same structural pairing FIFO will use for real once prices exist — exactly
  // enough to know, in advance, which specific (openedTxHash, closedTxHash) pairs are the decisive
  // pricing requirements a verified closed lot actually needs.
  const structuralLots = buildLots(params.normalizedEvents, params.recoveredEvents)
  const { matchedLots: structuralMatchedLots } = matchLotsFIFO(structuralLots, sells)
  const { entryRankByTxHash, exitRankByTxHash } = assignClosedLotPairRanks(structuralMatchedLots)

  const routeLogSnapshotBefore = pricingRouteLog.length

  const atTradeTime = await resolvePricingAtTime({
    buyEntries: buys.map((e) => toPriceableEntry(e, entryRankByTxHash.get(e.txHash))),
    sellEntries: sells.map((e) => toPriceableEntry(e, exitRankByTxHash.get(e.txHash))),
    priceSources: params.priceSources,
  })

  // CLOSED-LOT PRICING COVERAGE DIAGNOSTICS, DISCLOSED, ADDITIVE — bounded (one summary object, no
  // per-event dump). Splits every structural closed lot by exactly which side(s) resolved a real
  // price, so "fullyPricedClosedLots" (both) is never confused with "attributed" (present) or with a
  // lot that only got half its evidence. Computed AFTER resolvePricingAtTime so it reflects the real
  // outcome, not the request.
  let bothPriced = 0
  let entryOnlyPriced = 0
  let exitOnlyPriced = 0
  let neitherPriced = 0
  for (const lot of structuralMatchedLots) {
    const hasEntry = atTradeTime.costUsd[lot.openedTxHash] != null
    const hasExit = atTradeTime.proceedsUsd[lot.closedTxHash] != null
    if (hasEntry && hasExit) bothPriced += 1
    else if (hasEntry) entryOnlyPriced += 1
    else if (hasExit) exitOnlyPriced += 1
    else neitherPriced += 1
  }
  // eslint-disable-next-line no-console
  console.warn('[priceLotsForWallet] closed-lot pricing coverage', {
    structuralClosedLots: structuralMatchedLots.length,
    distinctTokensWithClosedLots: new Set(structuralMatchedLots.map((l) => `${l.chain}:${l.token.toLowerCase()}`)).size,
    fullyPricedClosedLots: bothPriced,
    entryOnlyPriced,
    exitOnlyPriced,
    neitherPriced,
    closedLotEntryRequirements: entryRankByTxHash.size,
    closedLotExitRequirements: exitRankByTxHash.size,
    totalBuyEntries: buys.length,
    totalSellEntries: sells.length,
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

  const priceUsdLookup: PriceUsdLookup = (event) => resolveEventPriceUsd(event, atTradeTime.costUsd, atTradeTime.proceedsUsd)

  const currentPriceUsdLookup: CurrentPriceUsdLookup = (token, chain) =>
    atNow.costUsd[`current:${chain}:${token.toLowerCase()}`] ?? null

  const pricingUnavailableTokens = nowEntries
    .filter((entry) => atNow.costUsd[entry.txHash] == null)
    .map((entry) => `${entry.chain}:${entry.token.toLowerCase()}`)
  if (pricingUnavailableTokens.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[priceLotsForWallet] tokens with no price from any source', { count: pricingUnavailableTokens.length, tokens: pricingUnavailableTokens })
  }

  const routeRecordsThisCall = pricingRouteLog.slice(routeLogSnapshotBefore)
  const historicalPricingAttempts = routeRecordsThisCall.filter((r) => r.route !== 'none')
  const historicalPricingFailures = routeRecordsThisCall.filter((r) => r.route === 'none')

  return {
    priceUsdLookup,
    currentPriceUsdLookup,
    sourceBreakdown: atTradeTime.sourceBreakdown,
    pricingUnavailableTokens,
    historicalPricingAttempts,
    historicalPricingFailures,
  }
}
