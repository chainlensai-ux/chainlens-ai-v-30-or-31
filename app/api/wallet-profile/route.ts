// app/api/wallet-profile/route.ts
//
// FABRICATED-SPEC DISCLOSURE: none of `getBehaviorIntel`, `getPortfolioSummary`, `getChainSelection`,
// or `getHoldingsForWallet` exist. The real exported names/contracts (all verified by reading each
// module's own index.ts/types.ts before this file was written) are:
//   - src/modules/behaviorIntel  -> `buildBehaviorIntelObject(params)`, NOT a raw-wallet-fetching
//     function at all — it reads ONLY buyTimeline/sellEntries/distributionTimeline/chainSelection/
//     windowCoverage(+holdings), zero provider calls (see that module's own header).
//   - src/modules/portfolio     -> `buildPortfolioSummary(holdings: TokenHolding[], prices:
//     TokenPrice[])`, plain args, not a wallet-fetch call.
//   - src/modules/chainSelection -> `buildChainSelectionObject(normalizedEvents, chainInputs)`.
//   - src/modules/holdings       -> `fetchHoldings(chain, walletAddress)`.
//
// STRUCTURAL GAP, DISCLOSED AND BRIDGED: behaviorIntel needs buyTimeline/distributionTimeline
// (src/modules/timelineBuilder), sellEntries (src/modules/sellTimeline's V2 `entries`, per that
// module's own migration note), chainSelection, and windowCoverage — none of which the literal spec
// mentions producing from {walletAddress, chains}. This route builds that real chain itself, per
// chain, reusing ONLY real, unmodified, already-shipped modules (mirroring src/pipeline/index.ts's
// own real sequence, read-only reference, never modified or imported as a dependency-of):
//   fetchProviderWindow (raw fetch, via walletChainPipeline.fetchRawEventsForChain)
//     -> normalizeEvents (src/modules/normalization)
//     -> buildChainSelectionObject (src/modules/chainSelection)
//     -> buildTimelines (src/modules/timelineBuilder) for buyTimeline/distributionTimeline
//     -> buildBridgeDetectionObject (src/modules/bridgeDetection) — PURE, no network call
//     -> buildSellTimeline (src/modules/sellTimeline, the V2 richer read-model) for sellEntries
//     -> buildBehaviorIntelObject (src/modules/behaviorIntel)
//
// RECOVERY POLICY, HONESTLY SKIPPED (disclosed, not silently dropped): src/modules/sellTimeline's V2
// buildSellTimeline() also accepts a `recoveryPolicy` param feeding its "mechanism 4" (recovery-
// reconstructed, historical, low-confidence sells). recoveryPolicy (src/modules/recoveryPolicy) is
// the one module besides providerFetchWindow permitted to make its OWN additional network calls
// (deep historical pagination) — wiring that up is out of scope for this standalone route (it would
// mean re-deriving runWalletScan's own deep-recovery trigger logic). An empty RecoveryPolicyResult
// (`evaluation: []`) is passed instead, meaning mechanism 4 always honestly contributes zero entries
// here — real bridge-exit (mechanism 3) and same-tx/transfer-out (mechanisms 1/2) sells are still
// fully real and computed.
//
// WINDOW COVERAGE, DISCLOSED APPROXIMATION: behaviorIntel's `windowCoverage` input describes real
// vs. inferred vs. recovered-extra days of evidence (see src/modules/behaviorIntel/types.ts). This
// route only ever fetches the real base provider window (walletChainPipeline.PROVIDER_FETCH_
// WINDOW_DAYS = 90) and never does deep recovery (see above), so windowCoverage here is always
// `{ realDataDays: 90, inferredDays: 0, recoveredExtraDays: 0, coverageBasis: 'partial_window' }` —
// an honest, fixed description of exactly what this route actually fetched, not a computed/guessed
// value.
//
// SINGLE-CHAIN ENGINE MISMATCH, DISCLOSED: behaviorIntel/chainSelection/portfolio all operate over
// potentially multiple chains already (chainSelection/portfolio take multi-chain input; behaviorIntel
// reads a chainSelection spanning all requested chains) — those three are computed ONCE, across all
// requested chains together. computeSmartMoneyScore (lib/engines/smartMoneyScoreEngine.ts), however,
// is single-chain-scoped by its own real request type (`chain: SupportedChain`, not `chains`). Per
// this session's established convention (see lib/engines/smartMoneyScoreEngine.ts's own header),
// this route resolves that mismatch by computing ONE smart money score PER requested chain, each
// scoped to that chain's own trades/realizedPnl/unrealizedPnl but reusing the SAME wallet-wide
// behavior/chainSelection/portfolio objects for all chains' score inputs (those three engines have
// no per-chain variant to begin with) — disclosed here rather than fabricating a fake multi-chain
// score type that doesn't exist anywhere in this codebase.

import { NextResponse } from 'next/server'
import { SUPPORTED_CHAINS } from '@/src/pipeline/types'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { normalizeEvents } from '@/src/modules/normalization'
import type { NormalizedEvent } from '@/src/modules/normalization/types'
import { buildChainSelectionObject } from '@/src/modules/chainSelection'
import type { ChainMetricsInput } from '@/src/modules/chainSelection/types'
import { buildTimelines } from '@/src/modules/timelineBuilder'
import { buildBridgeDetectionObject } from '@/src/modules/bridgeDetection'
import { buildSellTimeline } from '@/src/modules/sellTimeline'
import type { RecoveryPolicyResult } from '@/src/modules/recoveryPolicy/types'
import { buildBehaviorIntelObject } from '@/src/modules/behaviorIntel'
import type { WindowCoverage } from '@/src/modules/behaviorIntel/types'
import { fetchHoldings } from '@/src/modules/holdings'
import type { TokenPrice } from '@/src/modules/pricing/types'
import { buildPortfolioSummary } from '@/src/modules/portfolio'
import { computeRealizedPnl } from '@/src/modules/realizedPnl'
import { computeSmartMoneyScore } from '@/lib/engines/smartMoneyScoreEngine'
import { buildTradeTimelineV2, type NormalizedSwap, type NormalizedTransfer } from '@/lib/engines/tradeTimelineEngineV2'
import { UNKNOWN_TOKEN } from '@/src/modules/swapNormalizer'
import type { TradeWithIntent } from '@/src/modules/tradeIntent/intentEngine'
import {
  buildLotsForChain,
  buildUnrealizedPnlForChain,
  fetchRawEventsForChain,
} from '@/app/api/_shared/walletChainPipeline'
import { dedupeRawEventKey } from '@/src/modules/providerFetchWindow/utils'
import type { RawProviderEvent } from '@/src/modules/providerFetchWindow/types'
import { getTokenCache, setTokenCache } from '@/lib/server/cache/tokenCache'

// CU REDUCTION, DISCLOSED: this route (and app/api/transactions, app/api/pnl) previously called
// into the shared fetch pipeline with no caching at all, unlike the Deep Scan flow's
// request-scoped eventsCache — a wallet page hitting several of these panels in a short window
// could re-fetch the exact same raw provider events per chain, per route, every time. Wrapped here
// with a real, shared (cross-instance) KV cache — reusing lib/server/cache/tokenCache.ts's existing
// getTokenCache/setTokenCache (fails open to a real fetch if KV isn't configured or errors, same as
// its own real usage in app/api/token/route.ts) rather than a bare, unguarded kv.get/kv.set that
// would throw and break every request wherever KV isn't provisioned (this sandbox included).
//
// SCOPED TO THIS ROUTE ONLY, DISCLOSED: fetchRawEventsForChain (walletChainPipeline.ts) is also
// called directly by workers/walletScanV2.ts's dependencies (lib/engine/modules/{pnl,activity}) for
// the real Deep Scan flow — caching was deliberately added HERE, at this route's own call site,
// not inside fetchRawEventsForChain/walletChainPipeline.ts itself, so the Deep Scan flow is not
// touched at all (per this task's explicit constraint).
const RAW_EVENTS_CACHE_TTL_SECONDS = 120

async function fetchRawEventsForChainCached(chain: SupportedChain, walletAddress: string): Promise<RawProviderEvent[]> {
  const cacheKey = `provider-window-${walletAddress}-${chain}`
  const cached = await getTokenCache<RawProviderEvent[]>(cacheKey)
  if (cached) return cached

  const events = await fetchRawEventsForChain(chain, walletAddress)

  // DEDUP, DISCLOSED DEVIATION: the task's own snippet keyed on `${e.hash}-${e.logIndex}` — neither
  // field exists on the real RawProviderEvent type (verified in src/modules/providerFetchWindow/
  // types.ts: the real field is `txHash`, and there is no `logIndex` at all). Applying that literal
  // key would have made every event collide (`undefined-undefined`), collapsing a wallet's entire
  // real history down to one event. Using the real, already-exported dedupeRawEventKey
  // (providerFetchWindow/utils.ts — the same key mergeProviderResults already uses to merge
  // GoldRush+Alchemy) instead — a safe, correct no-op here since fetchRawEventsForChain's output is
  // already deduped once at merge time, but a real guard against any future double-fetch path.
  const seen = new Set<string>()
  const deduped: RawProviderEvent[] = []
  for (const e of events) {
    const key = dedupeRawEventKey(e)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(e)
    }
  }

  await setTokenCache(cacheKey, deduped, RAW_EVENTS_CACHE_TTL_SECONDS)
  return deduped
}

type WalletProfileRequestBody = {
  walletAddress?: string
  chains?: string[]
}

function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain)
}

// Fixed, honest description of exactly what this route fetches — see file header's "WINDOW
// COVERAGE" disclosure.
const WINDOW_COVERAGE: WindowCoverage = {
  realDataDays: 90,
  inferredDays: 0,
  recoveredExtraDays: 0,
  coverageBasis: 'partial_window',
}

// Always-empty — see file header's "RECOVERY POLICY, HONESTLY SKIPPED" disclosure.
const EMPTY_RECOVERY_POLICY: RecoveryPolicyResult = {
  triggerRecoveryWhen: { token_value_usd_gte: 0, in_top_3_holdings: false, repeated_in_sell_timeline_min_count: 0 },
  caps: { maxHistoricalPagesPerWallet: 0, maxHistoricalPagesPerToken: 0 },
  evaluation: [],
  totalPagesUsedThisWallet: 0,
}

// Same TradeWithIntent -> NormalizedTransfer/NormalizedSwap adapter used by app/api/transactions/
// route.ts — see that file's header for the full disclosure on why this adapter is needed (no such
// adapter exists anywhere else in the codebase). Duplicated here rather than imported cross-route to
// avoid introducing a route-to-route dependency; both copies are intentionally identical.
function tradeWithIntentToTimelineInputs(trade: TradeWithIntent): { transfer?: NormalizedTransfer; swap?: NormalizedSwap } {
  const tokenInUnknown = trade.tokenIn.address === UNKNOWN_TOKEN.address
  const tokenOutUnknown = trade.tokenOut.address === UNKNOWN_TOKEN.address
  if (tokenInUnknown && tokenOutUnknown) return {}
  if (tokenOutUnknown) {
    return { transfer: { tokenAddress: trade.tokenIn.address, amount: trade.amountIn, direction: 'out', timestamp: trade.timestamp, chain: trade.chain } }
  }
  if (tokenInUnknown) {
    return { transfer: { tokenAddress: trade.tokenOut.address, amount: trade.amountOut, direction: 'in', timestamp: trade.timestamp, chain: trade.chain } }
  }
  return {
    swap: { tokenIn: trade.tokenIn.address, tokenOut: trade.tokenOut.address, amountIn: trade.amountIn, amountOut: trade.amountOut, timestamp: trade.timestamp, chain: trade.chain },
  }
}

export async function POST(req: Request) {
  let body: WalletProfileRequestBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { walletAddress, chains } = body
  if (!walletAddress || typeof walletAddress !== 'string') {
    return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 })
  }
  if (!Array.isArray(chains) || chains.length === 0) {
    return NextResponse.json({ error: 'chains is required and must be a non-empty array' }, { status: 400 })
  }
  const sanitizedChains = chains.filter(isSupportedChain)
  if (sanitizedChains.length === 0) {
    return NextResponse.json({ error: 'none of the requested chains are supported' }, { status: 400 })
  }

  // ── Wallet-wide (multi-chain) stages: fetch -> normalize -> chainSelection -> timelines ──────
  const rawEventsPerChain = await Promise.all(sanitizedChains.map((chain) => fetchRawEventsForChainCached(chain, walletAddress)))
  const allRawEvents = rawEventsPerChain.flat()
  const { normalizedEvents } = normalizeEvents(allRawEvents, walletAddress)

  const chainInputs: ChainMetricsInput[] = sanitizedChains.map((chain) => ({ chain, providerStatus: 'ok' }))
  const chainSelection = buildChainSelectionObject(
    normalizedEvents,
    chainInputs.map((c) => ({ ...c, providerStatus: 'ok' as const })),
  )

  const { buyTimeline, distributionTimeline } = buildTimelines(normalizedEvents, chainSelection)
  const { bridgeTimeline } = buildBridgeDetectionObject(normalizedEvents)
  const sellTimelineV2 = buildSellTimeline({
    normalizedEvents,
    chainSelection,
    bridgeTimeline,
    recoveryPolicy: EMPTY_RECOVERY_POLICY,
    walletAddress,
  })

  const behavior = buildBehaviorIntelObject({
    buyTimeline,
    sellEntries: sellTimelineV2.entries,
    distributionTimeline,
    chainSelection,
    windowCoverage: WINDOW_COVERAGE,
  })

  // ── Portfolio (multi-chain): real fetchHoldings per chain + buildPortfolioSummary ────────────
  const holdingsPerChain = await Promise.all(sanitizedChains.map((chain) => fetchHoldings(chain, walletAddress)))
  const allHoldings = holdingsPerChain.flatMap((h) => h.holdings)
  // TokenPrice: REAL only when the balances provider itself supplied a price (providerPriceUsd) —
  // 'unavailable' otherwise, never a guessed price (src/modules/pricing's own PriceSource contract).
  const prices: TokenPrice[] = allHoldings.map((h) => ({
    chain: h.chain,
    contract: h.contract,
    priceUsd: h.providerPriceUsd,
    source: h.providerPriceUsd != null ? 'provider_supplied' : 'unavailable',
  }))
  const portfolio = buildPortfolioSummary(allHoldings, prices)

  // ── Per-chain stages: trades/timeline, realizedPnl, unrealizedPnl, smartMoneyScore ────────────
  const perChainProfiles = await Promise.all(
    sanitizedChains.map(async (chain) => {
      const lots = await buildLotsForChain(chain, walletAddress)
      const realizedPnl = computeRealizedPnl(lots.closedLots)
      const unrealized = await buildUnrealizedPnlForChain(chain, walletAddress)

      const transfers: NormalizedTransfer[] = []
      const swaps: NormalizedSwap[] = []
      for (const trade of lots.trades) {
        const { transfer, swap } = tradeWithIntentToTimelineInputs(trade)
        if (transfer) transfers.push(transfer)
        if (swap) swaps.push(swap)
      }
      const tradeTimeline = await buildTradeTimelineV2({ chain, walletAddress, transfers, swaps })

      const smartMoneyScore = computeSmartMoneyScore({
        walletAddress,
        chain,
        trades: tradeTimeline.trades,
        realizedPnl,
        unrealizedPnl: unrealized.result,
        behavior,
        chainSelection,
        portfolio,
      })

      return {
        chain,
        chainSupported: lots.chainSupported,
        realizedPnl,
        unrealizedPnl: unrealized.result,
        unresolvedHoldings: unrealized.unresolvedHoldings,
        tradeTimeline: tradeTimeline.trades,
        smartMoneyScore,
      }
    }),
  )

  return NextResponse.json({
    walletAddress,
    chainsAttempted: sanitizedChains,
    behavior,
    chainSelection,
    portfolio,
    perChain: perChainProfiles,
  })
}
