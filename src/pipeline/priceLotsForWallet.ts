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
import { pricingRouteLog, isSanePrice, type PricingRouteRecord } from './pricingAtTimeAdapter'
import {
  deriveSameTransactionQuotePrice,
  groupSwapLegsByTransaction,
  swapLegGroupKey,
  isVerifiedQuoteLegAddress,
  isNativePseudoAddress,
  isCanonicalWethAddress,
  resolveNativePricingToken,
  type QuoteLegPriceResult,
  type SwapLeg,
} from '../modules/quoteLegPricing/index'

// ADDRESS-BASED NATIVE/WETH RECOGNITION, DISCLOSED (confirmed production bug: nativeQuoteRequirementsFound
// stayed 0 despite 84 valid opposite legs — the previous symbol==='ETH'/'WETH' check was a weaker
// signal than the canonical address every leg actually carries; see quoteLegPricing/index.ts's own
// isNativePseudoAddress/isCanonicalWethAddress for the full trace). Symbol kept only as a fallback OR
// for legs built without going through real provider synthesis.
function isNativeOrWethLeg(chain: NormalizedEvent['chain'], leg: SwapLeg): boolean {
  return isNativePseudoAddress(leg.contract) || isCanonicalWethAddress(chain, leg.contract) || leg.symbol === 'ETH' || leg.symbol === 'WETH'
}

function isFinitePositiveAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0
}

// SYNTHETIC DICTIONARY KEY, DISCLOSED: costUsd/proceedsUsd are Record<txHash, usd> — ONE slot per
// real txHash. A native/WETH quote leg that never touches the wallet directly shares its target's
// own txHash, so pricing it under that same literal txHash would silently collide with (and can
// clobber) the target's own entry in the very same dictionary. Mirrors this file's own existing
// `current:${chain}:${contract}` synthetic-key convention (see the "current" price pass below) —
// a made-up dictionary key used only to give this requirement its own unambiguous slot, never a
// real transaction hash.
function nativeQuoteRequirementKey(chain: string, txHash: string): string {
  return `native-quote:${chain}:${txHash.toLowerCase()}`
}

function toPriceableEntry(event: NormalizedEvent, pairRank: number | undefined): PriceableEntry {
  return {
    txHash: event.txHash,
    // NATIVE PRICING ROUTE, DISCLOSED (see quoteLegPricing/index.ts's resolveNativePricingToken for
    // the full trace): only the TOKEN STRING passed to the price source is routed to the chain's
    // canonical WETH contract when this event's own contract is the native pseudo-address — the
    // dictionary key (event.txHash, above) and every other stored field are untouched.
    token: resolveNativePricingToken(event.chain, event.contract),
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

  // RANK PROPAGATION BY TX, NOT BY LEG DIRECTION, DISCLOSED (confirmed production bug: 84 valid
  // opposite legs found, 0 recovered, missing_verified_native_price: 42). entryRankByTxHash/
  // exitRankByTxHash are keyed by which SIDE of a closed lot a txHash represents (opened vs closed),
  // not by which array a given LEG of that same transaction happens to land in. A swap's ETH/WETH
  // quote leg shares its target's own txHash but is virtually always the OPPOSITE direction (the
  // target is inbound on a buy, so its own tx's ETH leg is outbound — landing in `sells`, which only
  // ever consulted exitRankByTxHash, keyed by CLOSE transactions; this buy's txHash was never a close
  // transaction, so the ETH leg's rank lookup always missed, no matter how important that specific
  // tx's pricing was). Checking BOTH maps for every leg's own txHash (regardless of which array it's
  // in) means a transaction's priority rank now reaches every leg of that transaction, ETH/WETH
  // included, so priceAllEntries' existing rank-sort/per-token-cap correctly favors it over ordinary,
  // unranked token lookups — using the SAME already-existing priority machinery, no new mechanism.
  function rankForTxHash(txHash: string): number | undefined {
    const entryRank = entryRankByTxHash.get(txHash)
    const exitRank = exitRankByTxHash.get(txHash)
    if (entryRank === undefined) return exitRank
    if (exitRank === undefined) return entryRank
    return Math.min(entryRank, exitRank)
  }

  // NATIVE/WETH QUOTE-LEG REQUIREMENTS, DISCLOSED, ADDITIVE: a quote leg that never touches the
  // wallet directly (direction 'unknown' — a router-to-pool transfer) is correctly excluded from
  // `buys`/`sells` (only 'inbound'/'outbound' events are real pricing requirements for fifoEngine's
  // own cost basis) and so was NEVER sent to resolvePricingAtTime at all — no rank-propagation fix
  // can recover a price that was never requested. For every transaction that a verified closed lot
  // actually needs priced, if its grouped legs contain a canonical ETH/WETH leg with direction
  // 'unknown', one extra PriceableEntry is added (into sellEntries, arbitrarily but consistently — a
  // quote-only entry, not a real portfolio sell) carrying that SAME transaction's own priority rank
  // and its OWN historical timestamp (never "now" — see NEVER-CURRENT-PRICE note below). This adds
  // candidate entries competing for the SAME already-existing per-token cap (MAX_LOOKUPS_PER_TOKEN in
  // pricingAtTimeEngine/index.ts, unchanged) — it does not raise that cap, so the number of REAL
  // provider calls ETH/WETH can ever consume this scan is bounded exactly as it always was; this only
  // changes WHICH of ETH's occurrences win those bounded slots, preferring the ones a real closed lot
  // needs over an arbitrary/unranked one ("replace lower-priority failed token lookups when
  // necessary").
  const swapLegsByTx = groupSwapLegsByTransaction(merged)
  const nativeQuoteRequirementSeen = new Set<string>()
  let nativeQuoteRequirementsFound = 0
  // DIAGNOSTIC SAMPLE, DISCLOSED, BOUNDED: exactly what the "first 10 valid opposite legs" audit
  // asked for — logged once, after the loop, never per-transaction (no unbounded log volume).
  const validOppositeLegSample: Array<{
    chain: string
    txHash: string
    tokenAddress: string
    symbol: string
    direction: string
    classification: 'native_or_weth' | 'other'
    isNativePseudoAddress: boolean
    isCanonicalWeth: boolean
    rejectionReason: string | null
  }> = []
  // CANDIDATE COLLECTION, DISCLOSED — pass 1 of 2: gather every native/WETH quote-leg candidate WITHOUT
  // yet assigning it a rank. Deterministic cross-candidate priority (below) needs the full set first.
  type NativeCandidate = { groupKey: string; chain: NormalizedEvent['chain']; txHash: string; timestamp: number; leg: SwapLeg }
  const nativeCandidates: NativeCandidate[] = []
  for (const lot of structuralMatchedLots) {
    const requirements: Array<{ txHash: string; timestamp: number }> = [
      { txHash: lot.openedTxHash, timestamp: lot.openedAt },
      { txHash: lot.closedTxHash, timestamp: lot.closedAt },
    ]
    for (const { txHash, timestamp } of requirements) {
      const groupKey = swapLegGroupKey(lot.chain, txHash)
      if (nativeQuoteRequirementSeen.has(groupKey)) continue
      const legs = swapLegsByTx.get(groupKey) ?? []
      const oppositeLegs = legs.filter((leg) => !leg.excludeReason && leg.contract.toLowerCase() !== lot.token.toLowerCase())
      for (const leg of oppositeLegs) {
        if (validOppositeLegSample.length >= 10) break
        const isNative = isNativePseudoAddress(leg.contract)
        const isWeth = isCanonicalWethAddress(lot.chain, leg.contract)
        validOppositeLegSample.push({
          chain: lot.chain,
          txHash,
          tokenAddress: leg.contract,
          symbol: leg.symbol,
          direction: leg.direction,
          classification: isNative || isWeth || leg.symbol === 'ETH' || leg.symbol === 'WETH' ? 'native_or_weth' : 'other',
          isNativePseudoAddress: isNative,
          isCanonicalWeth: isWeth,
          rejectionReason: !isFinitePositiveAmount(leg.amount) ? 'invalid_amount' : null,
        })
      }
      const nativeLeg = oppositeLegs.find((leg) => isNativeOrWethLeg(lot.chain, leg) && leg.amount > 0)
      if (!nativeLeg) continue
      nativeQuoteRequirementSeen.add(groupKey)
      nativeQuoteRequirementsFound += 1
      nativeCandidates.push({ groupKey, chain: lot.chain, txHash, timestamp, leg: nativeLeg })
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[quote-leg-native-requirement-audit] first 10 valid opposite legs', { legs: validOppositeLegSample })

  // PRIORITY ASSIGNMENT, DISCLOSED — pass 2 of 2 (confirmed production bug: nativeQuoteRequirementsFound:
  // 42, Priced: 0, Capped: 42 — the requirements WERE built, but assignClosedLotPairRanks ranks purely
  // PER TARGET TOKEN (`${chain}:${lot.token}`), so a wallet where most tokens have exactly one closed
  // lot has EVERY closed lot tied at rank 0 within its own token group — a rank that's only ever
  // compared against OTHER lots of that SAME target token (irrelevant for ordinary tokens, each with
  // its own independent per-token cap). ETH/WETH is the one token EVERY one of these 42 different
  // closed lots shares a quote leg for, so its own per-token cap (still 2, unchanged) had to arbitrate
  // among 42 requirements ALL nominally "rank 0" — a tie broken only by original array insertion order,
  // which is exactly why the intended "highest-ranked" requirements did not reliably win, and observed
  // production behavior showed 0 of the 42 surviving. Fixed: every native quote requirement gets a
  // DISTINCT, STRICTLY NEGATIVE rank (below every real closed-lot rank, which is always >= 0) — this
  // guarantees a native quote requirement beats every ordinary (including tied rank-0) requirement AND
  // every unranked/decoy ETH entry for the SAME shared per-token cap slots, without changing
  // MAX_LOOKUPS_PER_TOKEN or any other cap/budget, and without touching pricingAtTimeEngine at all
  // (priceAllEntries' existing `rankOf(entry) ?? UNRANKED` ascending sort already handles negative
  // numbers correctly — no new mechanism, no new file touched).
  //
  // DETERMINISTIC TIE-BREAK, DISCLOSED: among the 42 (or however many) native requirements themselves,
  // rank is assigned by quote amount DESC (a larger swap's quote leg is the more materially significant
  // one to recover first) → timestamp ASC (earlier first, matching FIFO's own oldest-first philosophy)
  // → txHash ASC (final, fully deterministic tie-break).
  const sortedNativeCandidates = [...nativeCandidates].sort(
    (a, b) => b.leg.amount - a.leg.amount || a.timestamp - b.timestamp || a.txHash.localeCompare(b.txHash),
  )
  // rank(i) = i - N: index 0 (best candidate — largest amount) gets the most negative (smallest,
  // highest-priority) rank; every value here is strictly < 0, i.e. strictly better than any real
  // closed-lot rank (always >= 0, per assignClosedLotPairRanks) or unranked entry (UNRANKED sentinel).
  const nativeQuoteRankByGroupKey = new Map<string, number>()
  sortedNativeCandidates.forEach((c, i) => nativeQuoteRankByGroupKey.set(c.groupKey, i - sortedNativeCandidates.length))

  const nativeQuoteEntries: PriceableEntry[] = []
  // Resolves each found requirement's OWN dictionary+key after resolvePricingAtTime runs — a real
  // (already-ordinary, direction-real) leg is looked up in the SAME costUsd/proceedsUsd[txHash] slot
  // its normal rank-fixed requirement already uses (see rankForTxHash above); only a genuinely
  // 'unknown'-direction leg (never otherwise requested) gets its own new synthetic-key entry. This
  // means an already-real requirement is never duplicated into a second, budget-consuming entry —
  // "no budget increase" holds for both sub-cases, not just the synthetic one.
  const nativeQuoteRequirementResolvers: Array<{ dict: 'costUsd' | 'proceedsUsd'; key: string; groupKey: string }> = []
  // Real-direction native legs share their txHash with the ORDINARY buys/sells map below — this
  // override lets that map use the SAME superior priority rank instead of the ordinary (tied) one,
  // keyed by the exact leg identity so it never touches the TARGET's own, unrelated requirement.
  const nativeLegRankOverride = new Map<string, number>()
  for (const candidate of sortedNativeCandidates) {
    const rank = nativeQuoteRankByGroupKey.get(candidate.groupKey)!
    if (candidate.leg.direction === 'unknown') {
      // NEVER-CURRENT-PRICE, DISCLOSED: `timestamp` is this SAME transaction's own historical
      // timestamp (lot.openedAt/lot.closedAt) — the identical value the target leg itself is priced
      // at — never Date.now()/the separate "current"-price pass (`atNow`, built later in this file
      // for open-lot mark-to-market only). A historical swap's native quote leg is priced at the
      // time it happened, exactly like every other historical entry in this same call.
      const syntheticKey = nativeQuoteRequirementKey(candidate.chain, candidate.txHash)
      nativeQuoteEntries.push({
        txHash: syntheticKey,
        // Same NATIVE PRICING ROUTE as toPriceableEntry above — only the price-source token string
        // is routed to canonical WETH; the leg's own stored contract stays the native pseudo-address
        // everywhere else (evidence/diagnostics, the quote-leg derivation, etc.).
        token: resolveNativePricingToken(candidate.chain, candidate.leg.contract),
        chain: candidate.chain,
        timestamp: candidate.timestamp,
        amount: String(candidate.leg.amount),
        pairRank: rank,
      })
      nativeQuoteRequirementResolvers.push({ dict: 'proceedsUsd', key: syntheticKey, groupKey: candidate.groupKey })
    } else {
      nativeLegRankOverride.set(
        `${candidate.chain}:${candidate.txHash.toLowerCase()}:${candidate.leg.contract.toLowerCase()}:${candidate.leg.direction}`,
        rank,
      )
      const dict = candidate.leg.direction === 'inbound' ? 'costUsd' : 'proceedsUsd'
      nativeQuoteRequirementResolvers.push({ dict, key: candidate.txHash, groupKey: candidate.groupKey })
    }
  }

  function rankForEvent(event: NormalizedEvent): number | undefined {
    const override = nativeLegRankOverride.get(`${event.chain}:${event.txHash.toLowerCase()}:${event.contract.toLowerCase()}:${event.direction}`)
    return override ?? rankForTxHash(event.txHash)
  }

  const routeLogSnapshotBefore = pricingRouteLog.length

  const atTradeTime = await resolvePricingAtTime({
    buyEntries: buys.map((e) => toPriceableEntry(e, rankForEvent(e))),
    sellEntries: [...sells.map((e) => toPriceableEntry(e, rankForEvent(e))), ...nativeQuoteEntries],
    priceSources: params.priceSources,
  })

  // CAP-VS-PROVIDER-MISS SPLIT, DISCLOSED (confirmed production bug: 42 native requirements reached
  // pricing with correct negative ranks, i.e. they SURVIVED the cap, but selectedNativeRequirementKeys
  // was still empty — resolveNativePricingToken above is the actual fix; this split makes the
  // difference directly observable rather than merging "never attempted" and "attempted but the real
  // provider genuinely had no data" into one ambiguous "capped" bucket). Uses pricingAtTimeEngine's new
  // additive `cappedTxHashes` (see pricingAtTimeEngine/index.ts's summarizeEntryResults) to tell them
  // apart precisely, instead of guessing from the null result alone.
  const nativeRequirementsSelectedByCap = nativeQuoteRequirementResolvers.filter((r) => !atTradeTime.cappedTxHashes.has(r.key)).length
  const nativeRequirementsActuallyCapped = nativeQuoteRequirementResolvers.filter((r) => atTradeTime.cappedTxHashes.has(r.key)).length
  const nativeRequirementsPriced = nativeQuoteRequirementResolvers.filter((r) => atTradeTime[r.dict][r.key] != null).length
  const nativeRequirementsProviderMiss = nativeQuoteRequirementResolvers.filter(
    (r) => !atTradeTime.cappedTxHashes.has(r.key) && atTradeTime[r.dict][r.key] == null,
  ).length
  const selectedNativeRequirementKeys = nativeQuoteRequirementResolvers
    .filter((r) => atTradeTime[r.dict][r.key] != null)
    .map((r) => r.groupKey)
  // eslint-disable-next-line no-console
  console.warn('[quote-leg-native-cap-priority]', {
    nativeRequirementsSubmittedBeforeCap: nativeQuoteRequirementResolvers.length,
    rankValuesSeenByPricingAtTimeEngine: sortedNativeCandidates.map((c) => nativeQuoteRankByGroupKey.get(c.groupKey)),
    nativeRequirementsSelectedByCap,
    nativeRequirementsActuallyCapped,
    nativeRequirementsProviderMiss,
    nativeRequirementsPriced,
    selectedNativeRequirementKeys,
  })

  function countFullyPriced(): number {
    let both = 0
    for (const lot of structuralMatchedLots) {
      if (atTradeTime.costUsd[lot.openedTxHash] != null && atTradeTime.proceedsUsd[lot.closedTxHash] != null) both += 1
    }
    return both
  }
  const fullyPricedLotsBefore = countFullyPriced()
  const verifiedPricingCoverageBefore = structuralMatchedLots.length > 0 ? fullyPricedLotsBefore / structuralMatchedLots.length : 0

  // SAME-TRANSACTION QUOTE-LEG GAP-FILL PASS, DISCLOSED, ADDITIVE — applied AFTER resolvePricingAtTime
  // (steps 3/4 of the required priority: existing provider historical price, existing on-chain pool
  // price at block — both already attempted, unmodified, inside resolvePricingAtTime) but BEFORE any
  // expensive bounded recovery fallback (pnlReconciliation.ts's own later stage — step 5, untouched).
  // Only ever fills a costUsd/proceedsUsd entry that is currently null — never overwrites, never
  // demotes, an already-resolved (stronger) existing price. Zero provider/network calls: the
  // quote-leg's own USD value is read back from whichever of costUsd/proceedsUsd resolvePricingAtTime
  // already computed for that SAME transaction's opposite-direction leg (already resolved as its own
  // ordinary priced entry — see buys/sells above), never re-fetched. `swapLegsByTx` is the SAME
  // grouping already computed above for the native/WETH quote-leg requirements pass — built once.

  // FORENSIC LOOKUP-BUILD DIAGNOSTICS, DISCLOSED, ADDITIVE — answers "why does every lookup group
  // have no usable opposite leg" directly from real data, without guessing. Confirms (a) the lookup
  // is built from `merged` — the full canonical normalized+recovered event set (mergeNormalizedEvents
  // above), never from `buys`/`sells` (the already-filtered, direction-gated pricing-requirement
  // arrays) — and (b) exactly how many groups are single-leg vs multi-leg, which pins the loss to
  // either "never ingested" (single-leg, no candidate anywhere in `merged`) or "present but
  // mismatched" (multi-leg groups that still failed to match, a real bug in the selection logic
  // rather than an ingestion gap).
  let legCountOne = 0
  let legCountTwo = 0
  let legCountThreeOrMore = 0
  let transactionsWithVerifiedQuoteAddress = 0
  const sampleTransactions: Array<{ groupKey: string; legs: Array<{ contract: string; symbol: string; direction: string }> }> = []
  for (const [groupKey, legs] of swapLegsByTx) {
    if (legs.length === 1) legCountOne += 1
    else if (legs.length === 2) legCountTwo += 1
    else legCountThreeOrMore += 1
    const [chainPart] = groupKey.split(':')
    if (legs.some((leg) => isVerifiedQuoteLegAddress(chainPart as NormalizedEvent['chain'], leg.contract, leg.symbol))) {
      transactionsWithVerifiedQuoteAddress += 1
    }
    if (sampleTransactions.length < 10) {
      sampleTransactions.push({
        groupKey,
        legs: legs.map((leg) => ({ contract: leg.contract, symbol: leg.symbol, direction: leg.direction })),
      })
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[quote-leg-lookup-forensics]', {
    lookupBuiltFrom: 'merged (mergeNormalizedEvents(normalizedEvents, recoveredEvents)) — the full canonical set, never buys/sells',
    mergedEventCount: merged.length,
    transactionsInSwapLookup: swapLegsByTx.size,
    legCountDistribution: { oneLeg: legCountOne, twoLegs: legCountTwo, threeOrMoreLegs: legCountThreeOrMore },
    transactionsWithVerifiedQuoteAddress,
    sampleTransactions,
  })

  const quoteLegCache = new Map<string, QuoteLegPriceResult>()
  let sameTxStablePricesRecovered = 0
  let sameTxNativePricesRecovered = 0
  const rejectionReasonCounts: Record<string, number> = {}
  let requirementsWithValidOppositeLeg = 0
  const sampleRecovered: Array<{
    chain: string
    txHash: string
    token: string
    side: 'entry' | 'exit'
    source: string
    targetQuantity: number
    quoteToken: string
    quoteQuantity: number
    quoteValueUsd: number
    derivedPriceUsd: number
    timestamp: string
  }> = []
  const distinctTransactionsUsed = new Set<string>()
  let targetTransactionFoundInLookup = 0
  let targetTransactionMissingFromLookup = 0

  function applySameTxQuoteLegGapFill(event: NormalizedEvent, targetDict: Record<string, number | null>, side: 'entry' | 'exit'): void {
    if (targetDict[event.txHash] != null) return // an existing, stronger price already resolved — never reordered/overwritten
    const groupKey = swapLegGroupKey(event.chain, event.txHash)
    const legs = swapLegsByTx.get(groupKey) ?? []
    if (legs.length > 0) targetTransactionFoundInLookup += 1
    else targetTransactionMissingFromLookup += 1
    const cacheKey = `${groupKey}:${event.contract.toLowerCase()}:${event.direction}`
    let result = quoteLegCache.get(cacheKey)
    if (!result) {
      // NOT-SAME-DIRECTION MATCH, DISCLOSED (see deriveSameTransactionQuotePrice's own header for the
      // full production trace): the quote leg's direction is resolved relative to the SCANNED WALLET
      // (src/modules/normalization/index.ts's classifyDirection) — a router-to-pool leg that never
      // touches the wallet directly is honestly 'unknown', not the strict opposite of the target's own
      // inbound/outbound. Only requiring "not the same direction as the target" (rather than "exactly
      // the opposite of inbound/outbound") is what actually locates it.
      const quoteLeg = legs.find(
        (leg) => !leg.excludeReason && leg.direction !== event.direction && leg.contract.toLowerCase() !== event.contract.toLowerCase(),
      )
      let historicalNativePrice: number | null = null
      // 'inbound'/'outbound' quote legs were themselves sent through resolvePricingAtTime as ordinary
      // buy/sell entries — their already-resolved USD value is reused directly, at zero additional
      // cost. A genuinely 'unknown'-direction native/WETH quote leg (never touches the wallet) is now
      // ALSO a real pricing requirement — see the NATIVE/WETH QUOTE-LEG REQUIREMENTS block above,
      // which adds it under its own synthetic dictionary key (nativeQuoteRequirementKey) precisely so
      // it never collides with the target's own entry sharing the same real txHash.
      if (quoteLeg && isNativeOrWethLeg(event.chain, quoteLeg) && quoteLeg.amount > 0) {
        const quoteLegOwnUsd =
          quoteLeg.direction === 'inbound'
            ? atTradeTime.costUsd[event.txHash]
            : quoteLeg.direction === 'outbound'
              ? atTradeTime.proceedsUsd[event.txHash]
              : atTradeTime.proceedsUsd[nativeQuoteRequirementKey(event.chain, event.txHash)]
        if (quoteLegOwnUsd != null) historicalNativePrice = quoteLegOwnUsd / quoteLeg.amount
      }
      result = deriveSameTransactionQuotePrice({
        chain: event.chain,
        txHash: event.txHash,
        timestamp: Date.parse(event.timestamp),
        targetToken: event.contract,
        targetDirection: event.direction,
        targetQuantity: event.amount,
        groupedSwapLegs: legs,
        historicalNativePrice,
      })
      quoteLegCache.set(cacheKey, result)
    }
    if (result.evidence.rejectionReason !== 'no_opposite_leg_in_transaction') requirementsWithValidOppositeLeg += 1
    // costUsd/proceedsUsd store the TOTAL resolved USD value of a leg (resolvePricingAtTime's own
    // usd = price * amount — see pricingAtTimeEngine/index.ts's priceAllEntries/multiplyAmount), not
    // a per-unit price. The quote leg's own quoteValueUsd already IS that total (a swap's paid USD
    // amount equals the USD value received) — priceUsd (per-unit) is sanity-checked, but
    // quoteValueUsd is what must be stored to match every other value already in these dicts.
    if (result.priceUsd != null && isSanePrice(result.priceUsd)) {
      targetDict[event.txHash] = result.quoteValueUsd
      if (result.source === 'same_tx_stable_quote') sameTxStablePricesRecovered += 1
      else sameTxNativePricesRecovered += 1
      distinctTransactionsUsed.add(groupKey)
      if (sampleRecovered.length < 10) {
        sampleRecovered.push({
          chain: event.chain,
          txHash: event.txHash,
          token: event.contract,
          side,
          source: result.source,
          targetQuantity: event.amount,
          quoteToken: result.quoteToken,
          quoteQuantity: result.quoteQuantity,
          quoteValueUsd: result.quoteValueUsd,
          derivedPriceUsd: result.priceUsd,
          timestamp: event.timestamp,
        })
      }
    } else if (result.evidence.rejectionReason) {
      rejectionReasonCounts[result.evidence.rejectionReason] = (rejectionReasonCounts[result.evidence.rejectionReason] ?? 0) + 1
    }
  }

  for (const e of buys) applySameTxQuoteLegGapFill(e, atTradeTime.costUsd, 'entry')
  for (const e of sells) applySameTxQuoteLegGapFill(e, atTradeTime.proceedsUsd, 'exit')

  const fullyPricedLotsAfter = countFullyPriced()
  const verifiedPricingCoverageAfter = structuralMatchedLots.length > 0 ? fullyPricedLotsAfter / structuralMatchedLots.length : 0

  // eslint-disable-next-line no-console
  console.warn('[historical-quote-leg-coverage]', {
    closedLots: structuralMatchedLots.length,
    entryRequirements: entryRankByTxHash.size,
    exitRequirements: exitRankByTxHash.size,
    // WHERE THE QUOTE LEG WAS LOST, DISCLOSED — a three-stage funnel so a regression is attributable
    // to a specific stage rather than one opaque total: transactionsInSwapLookup (the tx actually has
    // ANY grouped legs at all — a non-zero floor confirms `merged` itself isn't empty/misgrouped),
    // requirementsWithValidOppositeLeg (a same-tx leg with a different direction than the target was
    // found — this is exactly the count that was 0 in production before this fix, since the previous
    // strict "exactly the opposite of inbound/outbound" match silently excluded every 'unknown'-
    // direction pool-side leg), then the recovered counts below (a valid opposite leg existed AND was
    // a verified stablecoin/native quote AND produced a sane price).
    transactionsInSwapLookup: swapLegsByTx.size,
    targetTransactionFoundInLookup,
    targetTransactionMissingFromLookup,
    requirementsWithValidOppositeLeg,
    nativeQuoteRequirementsFound,
    nativeRequirementsSelectedByCap,
    nativeRequirementsActuallyCapped,
    nativeRequirementsProviderMiss,
    nativeRequirementsPriced,
    sameTxStablePricesRecovered,
    sameTxNativePricesRecovered,
    requirementsSatisfiedBySameTxQuote: sameTxStablePricesRecovered + sameTxNativePricesRecovered,
    distinctTransactionsUsed: distinctTransactionsUsed.size,
    rejectedQuoteCandidates: Object.values(rejectionReasonCounts).reduce((a, b) => a + b, 0),
    rejectionReasonCounts,
    verifiedPricingCoverageBefore,
    verifiedPricingCoverageAfter,
    fullyPricedLotsBefore,
    fullyPricedLotsAfter,
    additionalProviderCalls: 0,
  })
  if (sampleRecovered.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[historical-quote-leg-coverage] sample', { samples: sampleRecovered })
  }

  // CLOSED-LOT PRICING COVERAGE DIAGNOSTICS, DISCLOSED, ADDITIVE — bounded (one summary object, no
  // per-event dump). Splits every structural closed lot by exactly which side(s) resolved a real
  // price, so "fullyPricedClosedLots" (both) is never confused with "attributed" (present) or with a
  // lot that only got half its evidence. Computed AFTER resolvePricingAtTime AND the same-tx
  // quote-leg gap-fill so it reflects the real final outcome, not the pre-gap-fill request.
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
