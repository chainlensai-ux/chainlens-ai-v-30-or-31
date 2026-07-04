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
import type { RawTransfer, RawTxBundle, SwapNormalizerChain } from '@/src/modules/swapNormalizer/types'
import { normalizeTrades } from '@/src/modules/swapNormalizer'
import { classifyTradeIntent, type TradeWithIntent } from '@/src/modules/tradeIntent/intentEngine'
import { openLots, type IntentLot } from '@/src/modules/lotOpener'
import { closeLots, type ClosedLot, type CloseLotsResult } from '@/src/modules/lotCloser'
import { fetchHoldings } from '@/src/modules/holdings'
import { computeUnrealizedPnl, type Holding, type UnrealizedPnlResult } from '@/lib/engines/unrealizedPnlEngine'
import { UNKNOWN_TOKEN } from '@/src/modules/swapNormalizer'
import { buildTradeTimelineV2, type NormalizedSwap, type NormalizedTransfer, type TradeEntry } from '@/lib/engines/tradeTimelineEngineV2'

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

export async function fetchRawEventsForChain(chain: SupportedChain, walletAddress: string): Promise<RawProviderEvent[]> {
  const result = await fetchProviderWindow(chain, walletAddress, getProviderFetchWindowDays())
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
export async function buildTradesWithIntentForChain(chain: SupportedChain, walletAddress: string): Promise<TradesWithIntentForChainResult> {
  if (!isSwapNormalizerChain(chain)) {
    return { chain, chainSupported: false, trades: [] }
  }
  const rawEvents = await fetchRawEventsForChain(chain, walletAddress)
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
export async function buildLotsForChain(chain: SupportedChain, walletAddress: string): Promise<LotsForChainResult> {
  const { chainSupported, trades } = await buildTradesWithIntentForChain(chain, walletAddress)
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

// GENUINE UPSTREAM GAP, BRIDGED (see app/api/pnl/route.ts's header for the full disclosure):
// computeUnrealizedPnl's Holding requires a real acquiredAtTimestamp that fetchHoldings' current-
// balance snapshot never carries. Bridged here by cross-referencing this SAME chain's real, open
// (not-yet-closed) FIFO lots — each with a genuine acquisition timestamp — by token address. A held
// token with no matching open lot is honestly excluded from the computation and surfaced in
// `unresolvedHoldings`, never assigned a guessed timestamp.
export async function buildUnrealizedPnlForChain(chain: SupportedChain, walletAddress: string): Promise<UnrealizedForChainResult> {
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
      // honestly 0 (never guessed) otherwise, matching unrealizedPnlEngine's own "no price found ->
      // costBasisUsd/values fall to 0, confidence carries the honesty signal" pattern.
      currentPriceUsd: h.providerPriceUsd ?? 0,
      currentValueUsd: h.providerValueUsd ?? (h.providerPriceUsd != null ? h.providerPriceUsd * h.amount : 0),
      acquiredAtTimestamp: match.timestamp,
    })
  }

  const result = await computeUnrealizedPnl({ chain, walletAddress, holdings: usableHoldings })
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
export async function buildTradeTimelineForChain(chain: SupportedChain, walletAddress: string): Promise<TradeTimelineForChainResult> {
  const { chainSupported, trades } = await buildTradesWithIntentForChain(chain, walletAddress)
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
