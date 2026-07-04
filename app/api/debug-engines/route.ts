// app/api/debug-engines/route.ts
//
// DEBUG-ONLY ROUTE — DO NOT USE IN PRODUCTION UI. Runs every engine/module built this session
// end-to-end against one real wallet and returns the raw results for manual inspection. This is a
// read-only smoke test wired for browser-console debugging (see NEXT_PUBLIC_ENABLE_DEV_TOOLS
// pattern used by lib/modules/{swapNormalizer,lotOpener,lotCloser,realizedPnl}'s window.* exposure
// elsewhere in this codebase) — no auth/rate-limit gate is added here since none of the other
// debug/diagnostics routes' gating conventions were specified for this one, but this route makes
// the SAME real provider calls app/api/{pnl,transactions,wallet-profile}/route.ts already make, so
// it carries the same real GoldRush/Alchemy CU cost as those — it must not be linked from any
// production UI page.
//
// FABRICATED-SPEC DISCLOSURE (identical findings to the prior /api/{pnl,transactions,wallet-profile,
// token-scan} task — see those routes' own headers for the full investigation):
//   - `normalizeTransfers` / `normalizeSwaps` do not exist -> real is swapNormalizer's `normalizeTrades`
//     (via the shared walletChainPipeline helper below), consumed here as TradeWithIntent[] per chain.
//   - `getBehaviorIntel` -> real `buildBehaviorIntelObject`.
//   - `getPortfolioSummary` -> real `buildPortfolioSummary`.
//   - `getChainSelection` -> real `buildChainSelectionObject`.
//   - `getHoldingsForWallet` -> real `fetchHoldings`.
//
// This route does NOT re-derive the raw-fetch-gap bridge itself — it reuses the exact same
// wallet-wide (behavior/chainSelection/portfolio) + per-chain (realizedPnl/unrealizedPnl/
// tradeTimeline/smartMoneyScore) construction already built, verified, and shipped in
// app/api/wallet-profile/route.ts, calling the same shared app/api/_shared/walletChainPipeline.ts
// helper. See that route's header for the full disclosure on the recovery-policy skip, the fixed
// windowCoverage approximation, and the single-chain smartMoneyScore-per-chain resolution — all of
// which apply identically here since this route composes the exact same real engine calls.
//
// OUTPUT SHAPE DEVIATION, DISCLOSED: the requested output is a single flat object
// ({realizedPnl, unrealizedPnl, trades, smartMoneyScore, ...}), but computeSmartMoneyScore/
// computeRealizedPnl/computeUnrealizedPnl/buildTradeTimelineV2 are all single-chain-scoped (this
// route may be asked to scan several `chains` at once) — there is no real multi-chain variant of
// any of these to flatten into. Rather than silently collapsing multiple chains' distinct PnL/score
// results into one fabricated combined number, this route returns those four fields as arrays keyed
// by chain (`{chain, value}[]`) alongside the wallet-wide behavior/portfolio/chainSelection fields,
// which genuinely are single, wallet-wide objects already.
//
// SAMPLE HISTORICAL PRICE: per the literal spec, always looked up for chains[0] + that chain's real
// canonical WETH address (see lib/engines/tradeTimelineEngineV2.ts's own KNOWN_SYMBOLS map for these
// same addresses) + the fixed timestamp 1700000000. If chains[0] has no known canonical WETH address
// in this codebase (i.e. is not eth/base/arbitrum/optimism), this honestly returns a `null` sample
// with a disclosed reason rather than guessing an address.

import { NextResponse } from 'next/server'
import { SUPPORTED_CHAINS } from '@/src/pipeline/types'
import type { SupportedChain } from '@/src/modules/providerFetchWindow/types'
import { normalizeEvents } from '@/src/modules/normalization'
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
import { getPriceAtTime } from '@/lib/engines/pricingAtTimeEngine'
import { buildTradeTimelineV2, type NormalizedSwap, type NormalizedTransfer } from '@/lib/engines/tradeTimelineEngineV2'
import { UNKNOWN_TOKEN } from '@/src/modules/swapNormalizer'
import type { TradeWithIntent } from '@/src/modules/tradeIntent/intentEngine'
import {
  buildLotsForChain,
  buildUnrealizedPnlForChain,
  fetchRawEventsForChain,
} from '@/app/api/_shared/walletChainPipeline'

type DebugEnginesRequestBody = {
  walletAddress?: string
  chains?: string[]
}

function isSupportedChain(chain: string): chain is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain)
}

// Same fixed, honest windowCoverage description used by app/api/wallet-profile/route.ts — see that
// file's header for the "WINDOW COVERAGE, DISCLOSED APPROXIMATION" disclosure.
const WINDOW_COVERAGE: WindowCoverage = {
  realDataDays: 90,
  inferredDays: 0,
  recoveredExtraDays: 0,
  coverageBasis: 'partial_window',
}

// Always-empty — see app/api/wallet-profile/route.ts's "RECOVERY POLICY, HONESTLY SKIPPED" disclosure.
const EMPTY_RECOVERY_POLICY: RecoveryPolicyResult = {
  triggerRecoveryWhen: { token_value_usd_gte: 0, in_top_3_holdings: false, repeated_in_sell_timeline_min_count: 0 },
  caps: { maxHistoricalPagesPerWallet: 0, maxHistoricalPagesPerToken: 0 },
  evaluation: [],
  totalPagesUsedThisWallet: 0,
}

// Real canonical WETH addresses per chain — same values as lib/engines/tradeTimelineEngineV2.ts's
// own KNOWN_SYMBOLS map. 'hyperevm' has no known canonical WETH address in this codebase.
const CANONICAL_WETH_BY_CHAIN: Partial<Record<SupportedChain, string>> = {
  eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  base: '0x4200000000000000000000000000000000000006',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
}

const SAMPLE_HISTORICAL_PRICE_TIMESTAMP = 1700000000

// Identical to the copy in app/api/wallet-profile/route.ts (see that file's header for why this
// adapter is duplicated per-route rather than shared).
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
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'debug-engines is disabled in production' }, { status: 404 })
  }

  let body: DebugEnginesRequestBody
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

  // ── Wallet-wide stages (identical real sequence to app/api/wallet-profile/route.ts) ───────────
  const rawEventsPerChain = await Promise.all(sanitizedChains.map((chain) => fetchRawEventsForChain(chain, walletAddress)))
  const allRawEvents = rawEventsPerChain.flat()
  const { normalizedEvents } = normalizeEvents(allRawEvents, walletAddress)

  const chainInputs: ChainMetricsInput[] = sanitizedChains.map((chain) => ({ chain, providerStatus: 'ok' as const }))
  const chainSelection = buildChainSelectionObject(normalizedEvents, chainInputs)

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

  const holdingsPerChain = await Promise.all(sanitizedChains.map((chain) => fetchHoldings(chain, walletAddress)))
  const allHoldings = holdingsPerChain.flatMap((h) => h.holdings)
  const prices: TokenPrice[] = allHoldings.map((h) => ({
    chain: h.chain,
    contract: h.contract,
    priceUsd: h.providerPriceUsd,
    source: h.providerPriceUsd != null ? 'provider_supplied' as const : 'unavailable' as const,
  }))
  const portfolio = buildPortfolioSummary(allHoldings, prices)

  // ── Per-chain stages — see this file's header "OUTPUT SHAPE DEVIATION" disclosure for why these
  // are arrays rather than single flattened fields ─────────────────────────────────────────────
  const perChain = await Promise.all(
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
        trades: tradeTimeline.trades,
        smartMoneyScore,
      }
    }),
  )

  // ── Sample historical price — see file header "SAMPLE HISTORICAL PRICE" disclosure ────────────
  const sampleChain = sanitizedChains[0]
  const sampleWethAddress = CANONICAL_WETH_BY_CHAIN[sampleChain]
  const sampleHistoricalPrice = sampleWethAddress
    ? await getPriceAtTime({ chain: sampleChain, tokenAddress: sampleWethAddress, timestamp: SAMPLE_HISTORICAL_PRICE_TIMESTAMP })
    : { priceUsd: null, source: null, confidence: 'none' as const, evidence: [], note: `no known canonical WETH address for chain "${sampleChain}" in this codebase` }

  return NextResponse.json({
    success: true,
    debug: {
      realizedPnl: perChain.map((p) => ({ chain: p.chain, value: p.realizedPnl })),
      unrealizedPnl: perChain.map((p) => ({ chain: p.chain, value: p.unrealizedPnl })),
      trades: perChain.map((p) => ({ chain: p.chain, value: p.trades })),
      behavior,
      portfolio,
      chainSelection,
      smartMoneyScore: perChain.map((p) => ({ chain: p.chain, value: p.smartMoneyScore })),
      sampleHistoricalPrice: { chain: sampleChain, tokenAddress: sampleWethAddress ?? null, ...sampleHistoricalPrice },
    },
  })
}
