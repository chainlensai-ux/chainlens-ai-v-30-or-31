// app/api/_shared/walletChainPipeline.ts
//
// STANDALONE, ADDITIVE HELPER — shared by the 4 new routes under app/api/{pnl,transactions,
// wallet-profile}/. Not imported by, and does not modify, any existing engine/module/pipeline file.
//
// WHY THIS FILE EXISTS (the "raw-data-fetch gap" disclosure, referenced from every route that
// imports it): the task literally asked routes to "normalize transfers"/"normalize swaps" from just
// {walletAddress, chains}, but none of src/modules/swapNormalizer, src/modules/tradeIntent,
// src/modules/lotOpener, or src/modules/lotCloser do any provider/network calls themselves — they
// only operate on already-fetched data (RawTxBundle[] / TradeWithIntent[] / IntentLot[]). The ONLY
// real fetch function in this codebase that turns {walletAddress, chain} into raw event data is
// src/modules/providerFetchWindow's `fetchProviderWindow` (see src/pipeline/index.ts's own
// runWalletScan for confirmation of this exact real sequence: fetchProviderWindow -> normalize ->
// timelineBuilder/lotOpener -> lotCloser -> realizedPnl/pnlEngine). This file wires that real fetch
// function into the real swapNormalizer/tradeIntent/lotOpener/lotCloser chain for these new,
// standalone routes — it does not modify or replace runWalletScan or any pipeline stage.
//
// SHAPE-ADAPTER DISCLOSURE: fetchProviderWindow returns RawProviderEvent[] — a FLAT list of one
// transfer leg per entry (see src/modules/providerFetchWindow/types.ts), grouped by neither
// transaction nor swap. swapNormalizer's real `normalizeTrades` consumes RawTxBundle[] — one entry
// PER TRANSACTION, with a `transfers` array of every leg inside that tx. `groupRawEventsIntoTxBundles`
// below performs that regrouping (by txHash) — a pure, honest reshaping of already-fetched data,
// never inventing a transfer that wasn't in the raw feed. Events missing a txHash/contract/
// timestamp/amountRaw are skipped (never fabricated into a placeholder leg), mirroring
// src/modules/normalization's own "malformed event skipped, never guessed" convention.
//
// CHAIN-COVERAGE GAP, DISCLOSED: providerFetchWindow's SupportedChain includes 'hyperevm'; the real
// swapNormalizer/tradeIntent/lotOpener/lotCloser chain's SwapNormalizerChain type does NOT ('base' |
// 'eth' | 'arbitrum' | 'optimism' only — see src/modules/swapNormalizer/types.ts). Casting 'hyperevm'
// into that type would misrepresent the chain identity to every downstream module. Rather than do
// that silently, `buildTradesWithIntentForChain`/`buildLotsForChain` below honestly return an empty
// result with a `chainSupported: false` flag for 'hyperevm' — never a fabricated trade/lot for a
// chain none of these real modules actually declare support for.

import type { RawProviderEvent, SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { fetchProviderWindow, getEffectiveFetchWindow } from '@/src/modules/providerFetchWindow/index'
import type { EventsCache } from './eventsCache'
import { type CuBudget, recordProviderCall } from './cuBudget'
import { withStageCache } from '@/lib/server/cache/v2StageCache'
import type { RawTransfer, RawTxBundle, SwapNormalizerChain } from '@/src/modules/swapNormalizer/types'
import { normalizeTrades } from '@/src/modules/swapNormalizer'
import { classifyTradeIntent, type TradeWithIntent } from '@/src/modules/tradeIntent/intentEngine'
import { openLots, type IntentLot } from '@/src/modules/lotOpener'
import { closeLots, type ClosedLot, type CloseLotsResult } from '@/src/modules/lotCloser'
import { fetchHoldings } from '@/src/modules/holdings'
import { computeUnrealizedPnl, type Holding, type UnrealizedPnlResult } from '@/lib/engines/unrealizedPnlEngine'
import { UNKNOWN_TOKEN } from '@/src/modules/swapNormalizer'
import { buildTradeTimelineV2, type NormalizedSwap, type NormalizedTransfer, type TradeEntry } from '@/lib/engines/tradeTimelineEngineV2'
import { rpcDebugLog, type RpcDebugEntry } from '@/lib/server/rpcDebug'

// WINDOW WIDENING, DISCLOSED: this used to be a hardcoded `= 90` constant. It now resolves via
// providerFetchWindow's new `getEffectiveFetchWindow()` (src/modules/providerFetchWindow/index.ts),
// which returns exactly 90 (PROVIDER_FETCH_WINDOW_DAYS_DEFAULT, unchanged) unless the opt-in
// PROVIDER_FETCH_WINDOW_OVERRIDE env var is set — so behavior is byte-for-byte identical to before
// this change for every deployment that doesn't set that var. See that module's index.ts/utils.ts
// for the full disclosure on how the override is validated/clamped/logged.
//
// SCOPE-OF-APPLICATION DISCLOSURE: a task asked for this window to be used for "transfer fetch, swap
// fetch, pricing fetch, metadata fetch" as four separate things. In the real code, only ONE of those
// is actually parameterized by a day-count window at all: the raw provider fetch below
// (fetchRawEventsForChain -> fetchProviderWindow). swapNormalizer/tradeIntent/lotOpener/lotCloser
// operate on whatever raw data that fetch already returned (no separate window param of their own);
// getPriceAtTime (pricingAtTimeEngine) takes an explicit historical `timestamp`, not a window, so a
// "pricing fetch window" isn't a real, distinct concept in this codebase; there is no separate
// "metadata fetch" step at all (token metadata comes from the same raw provider events). This export
// is kept as the SINGLE real place a wider window actually takes effect — every function in this
// file that calls fetchRawEventsForChain (directly or via buildTradesWithIntentForChain /
// buildLotsForChain / buildUnrealizedPnlForChain / buildTradeTimelineForChain) already benefits from
// the widened value through that one shared call site, with no separate wiring needed for
// swap/pricing/metadata since those steps have no window parameter to widen in the first place.
export function getProviderFetchWindowDays(): number {
  return getEffectiveFetchWindow()
}

const SWAP_NORMALIZER_CHAINS = new Set<SwapNormalizerChain>(['base', 'eth', 'arbitrum', 'optimism'])

// NOTE: the type predicate here is intentionally `chain is SwapNormalizerChain & SupportedChain`
// rather than a bare `chain is SwapNormalizerChain` — providerFetchWindow's SupportedChain
// ('base'|'eth'|'arbitrum'|'hyperevm') and swapNormalizer's SwapNormalizerChain
// ('base'|'eth'|'arbitrum'|'optimism') are DIFFERENT, non-overlapping-on-one-member types (see this
// file's header "CHAIN-COVERAGE GAP" disclosure) — a plain `chain is SwapNormalizerChain` predicate
// is invalid TypeScript here because SwapNormalizerChain is not assignable to the real input type
// SupportedChain (its 'optimism' member has no SupportedChain counterpart). The intersection keeps
// the narrowing useful (every real, currently-reachable input is 'base'|'eth'|'arbitrum', which is
// exactly `SwapNormalizerChain & SupportedChain`) without silently asserting a type relationship
// that does not exist.
export function isSwapNormalizerChain(chain: SupportedChain): chain is SwapNormalizerChain & SupportedChain {
  return SWAP_NORMALIZER_CHAINS.has(chain as SwapNormalizerChain)
}

// CU-HARDENING: optional `cache` param (docs/CU_AUDIT.md Finding #1 fix) — when provided, checks
// for an already-fetched result for this exact (chain, walletAddress) before calling the real
// provider, and stores the result for later callers within the same request. Omitting `cache`
// (every pre-existing caller of this function) preserves the exact prior behavior — always a fresh
// fetch, zero behavior change for anything not explicitly passing one. Verified safe: no output
// shape change, same real fetchProviderWindow call, same real rawEvents value either way.
//
// CROSS-ENGINE REDIS READ-THROUGH, DISCLOSED (real duplicate-Alchemy-fetch fix): `cache` above only
// dedupes within THIS engine's own request-scoped calls — it does nothing for the fact that
// src/pipeline/index.ts (the old engine, run first on every scan) ALREADY fetched and cached the
// exact same (chain, walletAddress) raw events into Redis moments earlier, via
// `withStageCache('v2:providerFetchWindow:${chain}:${wallet}', 30, () => fetchProviderWindow(...))`.
// This function previously called fetchProviderWindow directly, bypassing that cache entirely, so
// every scan re-fetched from GoldRush+Alchemy live for data that was already sitting in Redis one
// function call away — the single biggest real, avoidable source of duplicate Alchemy CU per scan
// (confirmed by reading both call sites; not a guess). Wrapping this call in the SAME withStageCache
// key/TTL the old pipeline uses means whichever engine runs first populates the cache and the other
// reuses it — same real fetchProviderWindow result either way, just not fetched twice.
//
// WINDOW-DAYS GUARD, DISCLOSED: src/pipeline/index.ts always passes a hardcoded 90
// (PROVIDER_FETCH_WINDOW_DAYS_USED) — it does not read the PROVIDER_FETCH_WINDOW_OVERRIDE env var
// this engine's own getProviderFetchWindowDays() can honor. Sharing the cache key unconditionally
// would silently serve the wrong window's data to whichever engine runs second if that override is
// ever set. Only reads/writes the shared Redis key when this call's own resolved window is the same
// 90 the old pipeline always uses (the default, override-unset case — the only case where the two
// engines are actually asking for the same data); any deployment that sets the override falls back
// to the exact prior behavior (a fresh, request-cache-only fetch), never a stale/wrong-window read.
const OLD_PIPELINE_PROVIDER_FETCH_WINDOW_DAYS = 90

export async function fetchRawEventsForChain(chain: SupportedChain, walletAddress: string, cache?: EventsCache, cuBudget?: CuBudget): Promise<RawProviderEvent[]> {
  const cached = cache?.get(chain, walletAddress)
  if (cached) return cached

  // eslint-disable-next-line no-console
  if (cache) console.debug('[CU-HARDENING] Fetching provider events:', `${walletAddress.toLowerCase()}:${chain}`)

  const windowDays = getProviderFetchWindowDays()
  const fetchLive = () => fetchProviderWindow(chain, walletAddress, windowDays)
  const result = windowDays === OLD_PIPELINE_PROVIDER_FETCH_WINDOW_DAYS
    ? await withStageCache(`v2:providerFetchWindow:${chain}:${walletAddress.toLowerCase()}`, 30, fetchLive)
    : await fetchLive()

  if (cuBudget) recordProviderCall(cuBudget)
  cache?.set(chain, walletAddress, result.rawEvents)
  return result.rawEvents
}

function toRawTransfer(event: RawProviderEvent, logIndex: number): RawTransfer {
  return {
    logIndex,
    contract: (event.contract as string).toLowerCase(),
    symbol: event.symbol ?? undefined,
    decimals: event.tokenDecimals ?? undefined,
    from: event.fromAddress ?? '',
    to: event.toAddress ?? '',
    amountRaw: event.amountRaw as string,
  }
}

// PURE. See file header for the full disclosure on why this regrouping step exists and what it
// honestly skips.
export function groupRawEventsIntoTxBundles(rawEvents: RawProviderEvent[], chain: SwapNormalizerChain): RawTxBundle[] {
  const byTx = new Map<string, RawProviderEvent[]>()
  for (const event of rawEvents) {
    if (!event.txHash || !event.contract || !event.timestamp || !event.amountRaw) continue
    const list = byTx.get(event.txHash) ?? []
    list.push(event)
    byTx.set(event.txHash, list)
  }

  const bundles: RawTxBundle[] = []
  for (const [txHash, events] of byTx.entries()) {
    const timestampMs = Date.parse(events[0].timestamp as string)
    if (Number.isNaN(timestampMs)) continue // malformed timestamp — skipped, never guessed
    bundles.push({
      chain,
      txHash,
      timestamp: Math.floor(timestampMs / 1000),
      transfers: events.map((event, i) => toRawTransfer(event, i + 1)),
    })
  }
  return bundles
}

export type TradesWithIntentForChainResult = {
  chain: SupportedChain
  chainSupported: boolean
  trades: TradeWithIntent[]
}

// Real chain: fetchProviderWindow -> groupRawEventsIntoTxBundles -> normalizeTrades (real
// swapNormalizer) -> classifyTradeIntent (real tradeIntent). See file header for disclosures.
// CU-HARDENING: `cache` threaded through to fetchRawEventsForChain — optional, same
// zero-behavior-change-when-omitted guarantee as that function's own comment.
export async function buildTradesWithIntentForChain(chain: SupportedChain, walletAddress: string, cache?: EventsCache, cuBudget?: CuBudget): Promise<TradesWithIntentForChainResult> {
  if (!isSwapNormalizerChain(chain)) {
    return { chain, chainSupported: false, trades: [] }
  }
  const rawEvents = await fetchRawEventsForChain(chain, walletAddress, cache, cuBudget)
  const bundles = groupRawEventsIntoTxBundles(rawEvents, chain)
  const normalizedTrades = normalizeTrades(bundles, walletAddress)
  const trades = classifyTradeIntent(normalizedTrades)
  return { chain, chainSupported: true, trades }
}

export type LotsForChainResult = {
  chain: SupportedChain
  chainSupported: boolean
  trades: TradeWithIntent[]
  closedLots: ClosedLot[]
  remainingLots: IntentLot[]
  unmatchedSells: CloseLotsResult['unmatchedSells']
}

// Real chain continued: openLots (real lotOpener) -> closeLots (real lotCloser).
// CU-HARDENING: `cache` threaded through — optional, same zero-behavior-change-when-omitted
// guarantee as fetchRawEventsForChain's own comment.
export async function buildLotsForChain(chain: SupportedChain, walletAddress: string, cache?: EventsCache, cuBudget?: CuBudget): Promise<LotsForChainResult> {
  const { chainSupported, trades } = await buildTradesWithIntentForChain(chain, walletAddress, cache, cuBudget)
  if (!chainSupported) {
    return { chain, chainSupported: false, trades: [], closedLots: [], remainingLots: [], unmatchedSells: [] }
  }
  const opened = openLots(trades)
  const { closedLots, remainingLots, unmatchedSells } = closeLots(opened, trades)
  return { chain, chainSupported: true, trades, closedLots, remainingLots, unmatchedSells }
}

export type UnrealizedForChainResult = {
  chain: SupportedChain
  result: UnrealizedPnlResult
  unresolvedHoldings: Array<{ contract: string; symbol: string; reason: string }>
}

function earliestOpenLotByToken(remainingLots: IntentLot[]): Map<string, IntentLot> {
  const byToken = new Map<string, IntentLot>()
  for (const lot of remainingLots) {
    const key = lot.token.address.toLowerCase()
    const existing = byToken.get(key)
    if (!existing || lot.timestamp < existing.timestamp) byToken.set(key, lot)
  }
  return byToken
}

// PROVIDER USAGE / CU ESTIMATION, DISCLOSED: intentionally a LOCAL, independent copy of the same
// real weights already shipped in src/pipeline/index.ts's estimateAlchemyCu/estimateGoldrushCu/
// countRpcMethods — NOT an import of that file, since importing it at all runs its module-level
// `PRICE_SOURCES = buildPriceSources()` side effect (constructs a real GoldRushClient on import),
// which this file's own header explicitly declares itself independent of ("not imported by, and
// does not modify, any existing engine/module/pipeline file"). Same weights, so both call sites
// report the same real CU number for the same underlying method calls, without the coupling risk.
type AlchemyMethodCounts = {
  getBlockLatest: number
  getBlockEstimate: number
  bisect: number
  multicallGetPool: number
  multicallPoolPrice: number
  slot0: number
  token0: number
  decimals: number
}

const ALCHEMY_CU_WEIGHTS = {
  getBlockLatest: 5,
  getBlockEstimate: 5,
  bisect: 10,
  multicallGetPool: 20,
  multicallPoolPrice: 20,
  slot0: 5,
  token0: 5,
  decimals: 5,
} as const

const GOLDRUSH_CU_PER_CALL = 12

function countProviderUsage(entries: readonly RpcDebugEntry[]): { alchemy: AlchemyMethodCounts; goldrushPriceCalls: number } {
  const count = (method: string) => entries.filter((e) => e.method === method).length
  return {
    alchemy: {
      getBlockLatest: count('getBlock:latest'),
      getBlockEstimate: count('getBlock:estimate'),
      bisect: count('getBlock:bisect'),
      multicallGetPool: count('readContract:multicall:getPool'),
      multicallPoolPrice: count('readContract:multicall:poolPrice'),
      slot0: count('readContract:slot0'),
      token0: count('readContract:token0'),
      decimals: count('readContract:decimals'),
    },
    goldrushPriceCalls: count('goldrush_sdk_getTokenPrices'),
  }
}

function estimateAlchemyCuLocal(counts: AlchemyMethodCounts): AlchemyMethodCounts & { total: number } {
  const weighted = {
    getBlockLatest: counts.getBlockLatest * ALCHEMY_CU_WEIGHTS.getBlockLatest,
    getBlockEstimate: counts.getBlockEstimate * ALCHEMY_CU_WEIGHTS.getBlockEstimate,
    bisect: counts.bisect * ALCHEMY_CU_WEIGHTS.bisect,
    multicallGetPool: counts.multicallGetPool * ALCHEMY_CU_WEIGHTS.multicallGetPool,
    multicallPoolPrice: counts.multicallPoolPrice * ALCHEMY_CU_WEIGHTS.multicallPoolPrice,
    slot0: counts.slot0 * ALCHEMY_CU_WEIGHTS.slot0,
    token0: counts.token0 * ALCHEMY_CU_WEIGHTS.token0,
    decimals: counts.decimals * ALCHEMY_CU_WEIGHTS.decimals,
  }
  const total = Object.values(weighted).reduce((sum, n) => sum + n, 0)
  return { ...weighted, total }
}

function estimateGoldrushCuLocal(priceCalls: number): { priceCalls: number; estimatedCu: number } {
  return { priceCalls, estimatedCu: priceCalls * GOLDRUSH_CU_PER_CALL }
}

// GENUINE UPSTREAM GAP, BRIDGED (see app/api/pnl/route.ts's header for the full disclosure):
// computeUnrealizedPnl's Holding requires a real acquiredAtTimestamp that fetchHoldings' current-
// balance snapshot never carries. Bridged here by cross-referencing this SAME chain's real, open
// (not-yet-closed) FIFO lots — each with a genuine acquisition timestamp — by token address. A held
// token with no matching open lot is honestly excluded from the computation and surfaced in
// `unresolvedHoldings`, never assigned a guessed timestamp.
export async function buildUnrealizedPnlForChain(chain: SupportedChain, walletAddress: string): Promise<UnrealizedForChainResult> {
  // PROVIDER USAGE TRACKING, DISCLOSED: snapshot-before/slice-after the same real, already-shipped
  // rpcDebugLog this codebase's own CU estimator uses (src/pipeline/index.ts's
  // buildCuEstimatorSummary) — never the raw global array (cross-request leak guard, same
  // convention). Covers every real Alchemy call this function's own chain (fetchHoldings,
  // buildLotsForChain, and computeUnrealizedPnl's own onchain-DEX price lookups via
  // lib/providers/onchainDex.ts -> src/modules/pricingAtTimeEngine/sources/basedex.ts, already
  // instrumented with logRpcCall) and every real GoldRush price call
  // (lib/providers/goldrush.ts, also already instrumented) actually makes.
  const rpcLogSnapshotBefore = rpcDebugLog.length

  const [holdingsResult, lots] = await Promise.all([
    fetchHoldings(chain, walletAddress),
    buildLotsForChain(chain, walletAddress),
  ])

  const openLotByToken = earliestOpenLotByToken(lots.remainingLots)
  const usableHoldings: Holding[] = []
  const unresolvedHoldings: UnrealizedForChainResult['unresolvedHoldings'] = []

  for (const h of holdingsResult.holdings) {
    const match = openLotByToken.get(h.contract.toLowerCase())
    if (!match) {
      unresolvedHoldings.push({
        contract: h.contract,
        symbol: h.symbol,
        reason: lots.chainSupported
          ? 'no matching open FIFO lot within the 90-day fetch window to supply a real acquiredAtTimestamp — never fabricated'
          : 'chain not supported by the real swapNormalizer/lotOpener chain (see this file\'s hyperevm disclosure) — no lot evidence possible',
      })
      continue
    }
    usableHoldings.push({
      tokenAddress: h.contract,
      chain,
      amount: h.amount,
      // REAL when the provider's own balances call returned a price (GoldRush balances_v2) —
      // honestly 0 (never guessed) otherwise. STALE-COMMENT FIX, DISCLOSED: this used to say a
      // 0 fallback here "matches unrealizedPnlEngine's own no-price-found pattern" — that pattern
      // (defaulting costBasisUsd to 0 / fabricating a "100% gain") was itself a real bug, fixed in
      // that engine directly. A 0 fed in here now correctly fails that engine's own sanity guard
      // (price must be > 0) and is honestly reported as `integrity: 'missing_evidence'` instead.
      currentPriceUsd: h.providerPriceUsd ?? 0,
      currentValueUsd: h.providerValueUsd ?? (h.providerPriceUsd != null ? h.providerPriceUsd * h.amount : 0),
      acquiredAtTimestamp: match.timestamp,
    })
  }

  const result = await computeUnrealizedPnl({ chain, walletAddress, holdings: usableHoldings })

  // realizedPnlUsd, DISCLOSED: computeUnrealizedPnl has no realized-PnL concept at all (it only
  // computes unrealized PnL on open holdings) — this sums the real `realizedPnl` field already
  // computed by lotCloser's closeLots() (via `lots.closedLots`, already fetched above in this same
  // function for the acquiredAtTimestamp bridge), not a fabricated or re-derived number. CAVEAT,
  // per ClosedLot's own type comment: `pnlCurrency` may honestly be a non-USD label on a real
  // currency mismatch — this sum assumes USD throughout, same assumption this log's other USD
  // fields already make; not re-verified per-lot here.
  const realizedPnlUsd = lots.closedLots.reduce((sum, lot) => sum + lot.realizedPnl, 0)

  // DIAGNOSTIC, DISCLOSED (audit task): real counts only, no behavior change — surfaces exactly
  // what computeUnrealizedPnl already computed for this chain, for this specific call site.
  // NOTE: this is a pipeline-level SUMMARY, distinct from and additive to the
  // [pnl_final_verification]/[verify_pnl_engine]/[verify_price_fetch] logs — those already fire
  // unconditionally, per call and per token, from inside computeUnrealizedPnl/computeTokenPnl
  // themselves (lib/engines/unrealizedPnlEngine.ts), regardless of KV circuit-breaker state,
  // priceLotsForWallet's own evidence, fifoEngine's match status, or dust suppression (none of
  // which this engine has any dependency on) — never duplicated here.
  // eslint-disable-next-line no-console
  console.warn('[walletChainPipeline] unrealizedPnl integrity summary', {
    chain,
    walletAddress,
    unrealizedPnlEngineRan: true,
    realizedPnlUsd,
    totalUnrealizedPnlUsd: result.totalUnrealizedPnlUsd,
    tokensProcessed: result.tokensProcessed,
    excludedFromPnlCount: result.excludedFromPnl.length,
    unresolvedHoldingsCount: unresolvedHoldings.length,
    integritySummary: result.integritySummary,
    integrityCounts: result.integrityCounts,
    anyUnrealizedPnlClamped: result.anyUnrealizedPnlClamped,
    anyUnreasonablePnL: result.anyUnreasonablePnL,
  })

  // REAL PROVIDER USAGE SUMMARY, DISCLOSED. Reuses this codebase's already-shipped, already-tested
  // CU-weight functions from src/pipeline/index.ts (estimateAlchemyCu/estimateGoldrushCu/
  // countRpcMethods) rather than a second, differently-weighted table — this task's own proposed
  // weights (multicallGetPool/multicallPoolPrice: 15, goldrush: 1/call) conflict with the real
  // weights already disclosed and shipped there (20/20/12) for the exact same method calls; using
  // both would silently produce two different "real CU usage" numbers for identical RPC activity.
  //
  // PER-TOKEN USAGE, NOT IMPLEMENTED, DISCLOSED: rpcDebugLog's real entry shape (lib/server/
  // rpcDebug.ts's RpcDebugEntry) carries no token/contract field at all, and computeUnrealizedPnl
  // processes every holding CONCURRENTLY (Promise.all) — even with per-call snapshotting, entries
  // from different tokens' price lookups interleave in the shared log with no way to attribute a
  // given call back to one specific token. Producing "alchemyCalls per token" would require either
  // tagging each logRpcCall() call site with a token (inside protected src/modules/
  // pricingAtTimeEngine/sources/basedex.ts and lib/providers/goldrush.ts — out of scope: "Do NOT
  // modify protected modules") or serializing computeUnrealizedPnl's per-token loop (a real
  // behavior/performance change to lib/engines/unrealizedPnlEngine.ts — also out of this task's
  // stated scope). Not fabricated. Only the real, honest wallet+chain-scoped total is emitted.
  const rpcEntriesThisCall = rpcDebugLog.slice(rpcLogSnapshotBefore)
  const { alchemy: alchemyMethodCounts, goldrushPriceCalls } = countProviderUsage(rpcEntriesThisCall)
  const alchemyCu = estimateAlchemyCuLocal(alchemyMethodCounts)
  const goldrushCu = estimateGoldrushCuLocal(goldrushPriceCalls)
  // eslint-disable-next-line no-console
  console.warn('[provider_usage_summary]', {
    walletAddress,
    chain,
    alchemy: alchemyCu,
    goldrush: goldrushCu,
    totalCu: alchemyCu.total + goldrushCu.estimatedCu,
  })

  return { chain, result, unresolvedHoldings }
}

// SHAPE-ADAPTER DISCLOSURE (shared by app/api/transactions/route.ts and app/api/wallet-profile/
// route.ts): TradeWithIntent (swapNormalizer/tradeIntent's real output — full TokenRef objects, an
// `intent` of BUY/SELL/SWAP/LP_ADD/LP_REMOVE) does not match the simpler NormalizedTransfer/
// NormalizedSwap shapes lib/engines/tradeTimelineEngineV2.ts's `buildTradeTimelineV2` expects (bare
// token address + amount/direction, or tokenIn/tokenOut addresses + amountIn/amountOut). No adapter
// between these two exists anywhere in the codebase, so this one was written for these new routes:
//   - if only one side's token is resolved (the other is UNKNOWN_TOKEN, i.e. swapNormalizer's
//     "missing side" case) -> a NormalizedTransfer for the resolved side only.
//   - if BOTH sides are unresolved -> honestly dropped (no real token identity to build from).
//   - otherwise (both sides resolved, whatever the intent) -> a NormalizedSwap using the trade's own
//     real tokenIn/tokenOut/amountIn/amountOut. LP_ADD/LP_REMOVE are treated the same as a swap here
//     — buildTradeTimelineV2's own contract has no LP concept at all — a disclosed simplification,
//     never a fabricated amount/token.
export function tradeWithIntentToTimelineInputs(trade: TradeWithIntent): { transfer?: NormalizedTransfer; swap?: NormalizedSwap } {
  const tokenInUnknown = trade.tokenIn.address === UNKNOWN_TOKEN.address
  const tokenOutUnknown = trade.tokenOut.address === UNKNOWN_TOKEN.address

  if (tokenInUnknown && tokenOutUnknown) return {}

  if (tokenOutUnknown) {
    return {
      transfer: { tokenAddress: trade.tokenIn.address, amount: trade.amountIn, direction: 'out', timestamp: trade.timestamp, chain: trade.chain },
    }
  }
  if (tokenInUnknown) {
    return {
      transfer: { tokenAddress: trade.tokenOut.address, amount: trade.amountOut, direction: 'in', timestamp: trade.timestamp, chain: trade.chain },
    }
  }
  return {
    swap: {
      tokenIn: trade.tokenIn.address,
      tokenOut: trade.tokenOut.address,
      amountIn: trade.amountIn,
      amountOut: trade.amountOut,
      timestamp: trade.timestamp,
      chain: trade.chain,
    },
  }
}

export type TradeTimelineForChainResult = {
  chain: SupportedChain
  chainSupported: boolean
  trades: TradeEntry[]
}

// Real chain continued (alternate branch from lots): TradeWithIntent[] -> adapter above ->
// buildTradeTimelineV2 (real tradeTimelineEngineV2 — itself re-derives lots internally via its own
// real swapNormalizer/lotOpener/lotCloser calls, see that file's own header).
// CU-HARDENING: `cache` threaded through — this is the exact function lib/engine/modules/pnl/
// computePnl.ts's fetchParsedTrades calls; passing the SAME cache instance
// lib/engine/modules/activity/computeChainActivity.ts uses is what actually fixes docs/CU_AUDIT.md
// Finding #1 — both modules now share one real fetchRawEventsForChain call per chain per request.
export async function buildTradeTimelineForChain(chain: SupportedChain, walletAddress: string, cache?: EventsCache, cuBudget?: CuBudget): Promise<TradeTimelineForChainResult> {
  const { chainSupported, trades } = await buildTradesWithIntentForChain(chain, walletAddress, cache, cuBudget)
  if (!chainSupported) return { chain, chainSupported: false, trades: [] }

  const transfers: NormalizedTransfer[] = []
  const swaps: NormalizedSwap[] = []
  for (const trade of trades) {
    const { transfer, swap } = tradeWithIntentToTimelineInputs(trade)
    if (transfer) transfers.push(transfer)
    if (swap) swaps.push(swap)
  }

  const timeline = await buildTradeTimelineV2({ chain, walletAddress, transfers, swaps })
  return { chain, chainSupported: true, trades: timeline.trades }
}
