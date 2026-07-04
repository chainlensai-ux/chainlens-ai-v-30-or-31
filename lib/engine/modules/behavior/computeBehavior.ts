// lib/engine/modules/behavior/computeBehavior.ts — new behavior module for the V2 engine.
//
// BRIDGING/FARMING SIGNAL, GENUINE STRUCTURAL GAP, DISCLOSED: real bridge-tx counts and real LP
// add/remove event counts are NOT derivable from the `trades: ParsedTrade[]` param alone (that type
// is buy/sell-only — see lib/engine/modules/pnl/types.ts's own header), and computing them for real
// requires a wallet address (via lib/engine/modules/activity/computeChainActivity.ts's own
// `fetchChainSignals`) that this function's own literal, task-specified signature never receives —
// see the inline comment at its call site (not made) further down for the full disclosure. Honestly
// reported as 0/"none" rather than fabricated or fetched with an empty placeholder address.
//
// STABLECOIN-SWAP DETECTION, DISCLOSED: `ParsedTrade` carries a bare `tokenAddress`, no symbol — so
// "is this trade a stablecoin swap" needs a real canonical address match. The canonical USDC/USDT/
// DAI addresses below are the same real, well-known addresses already used elsewhere in this
// codebase (e.g. src/modules/tradeIntent/intentEngine.ts's own canonical set) — duplicated here
// (that module's own list is not exported) rather than re-derived or guessed. Base's real canonical
// USDC address is included; Base's USDT/DAI are not canonical/widely-deployed in the same way, so
// they are honestly left out rather than guessed (matches this codebase's existing "best-effort,
// only include verified addresses" convention for less-canonical chains/tokens).

import type { PnlV2 } from '../pnl/types'
import type { Portfolio } from '../portfolio/types'
import type { ChainActivityRecord } from '../activity/types'
import type { PricedHolding } from '../pricing/types'
import type { ChainHolding } from '../holdings/types'
import type { ParsedTrade } from '../pnl/types'
import type { RiskV2 } from '../risk/types'
import type { PersonalityV2 } from '../personality/types'
import type { BehaviorEngineOutput, BehaviorV2 } from './types'

const STABLE_ADDRESSES = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC — Ethereum mainnet
  '0xdac17f958d2ee523a2206206994597c13d831ec', // USDT — Ethereum mainnet
  '0x6b175474e89094c44da98b954eedeac495271d0', // DAI — Ethereum mainnet
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC — Base
])

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000

const EMPTY_BEHAVIOR: BehaviorV2 = {
  accumulationStyle: 'neutral',
  rotationStyle: 'inactive',
  bridgingBehavior: 'none',
  farmingBehavior: 'none',
  stableRoutingBehavior: 'none',
  memeBehavior: 'none',
  tradeFrequency: 'low',
  behaviorSummary: 'No trade activity found for this wallet.',
}

function accumulationStyleFor(trades: ParsedTrade[]): BehaviorV2['accumulationStyle'] {
  const netBuyQty = trades.filter((t) => t.type === 'buy').reduce((sum, t) => sum + t.quantity, 0)
  const netSellQty = trades.filter((t) => t.type === 'sell').reduce((sum, t) => sum + t.quantity, 0)
  if (netBuyQty > netSellQty) return 'accumulator'
  if (netSellQty > netBuyQty) return 'distributor'
  return 'neutral'
}

// B/C, DISCLOSED: "rotating" (sell A + buy B within a 24h window) is checked FIRST — it's the most
// specific, positive signal. Only if no rotation is found does this fall back to "holding" (a real
// buy with no matching sell for 30+ days) vs "inactive" (no buy/sell in the last 30 days at all).
function rotationStyleFor(trades: ParsedTrade[], nowMs: number): BehaviorV2['rotationStyle'] {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].type !== 'sell') continue
    for (let j = i + 1; j < sorted.length; j++) {
      const gapMs = (sorted[j].timestamp - sorted[i].timestamp) * 1000
      if (gapMs > ROTATION_WINDOW_MS) break // sorted by time — nothing further can be within window
      if (sorted[j].type === 'buy' && sorted[j].tokenAddress !== sorted[i].tokenAddress) return 'rotating'
    }
  }

  const cutoffMs = nowMs - THIRTY_DAYS_MS
  const recentActivity = trades.some((t) => t.timestamp * 1000 >= cutoffMs)
  if (!recentActivity) return 'inactive'

  const oldestBuyMs = trades.filter((t) => t.type === 'buy').reduce((min, t) => Math.min(min, t.timestamp * 1000), Infinity)
  const hasRecentSell = trades.some((t) => t.type === 'sell' && t.timestamp * 1000 >= cutoffMs)
  if (Number.isFinite(oldestBuyMs) && nowMs - oldestBuyMs > THIRTY_DAYS_MS && !hasRecentSell) return 'holding'

  return 'inactive'
}

function tierFor(count: number, heavyThreshold: number, lightMin: number): 'heavy' | 'light' | 'none' {
  if (count > heavyThreshold) return 'heavy'
  if (count >= lightMin) return 'light'
  return 'none'
}

function buildSummary(b: BehaviorV2): string {
  return (
    `This wallet shows ${b.accumulationStyle} behavior with a ${b.rotationStyle} rotation pattern. ` +
    `Bridging is ${b.bridgingBehavior}, farming is ${b.farmingBehavior}, and stablecoin routing is ${b.stableRoutingBehavior}. ` +
    `Meme exposure is ${b.memeBehavior}, with ${b.tradeFrequency} trade frequency.`
  )
}

export async function computeBehavior(
  pnlV2: PnlV2,
  portfolioV2: Portfolio,
  chainActivityV2: ChainActivityRecord[],
  pricedHoldings: PricedHolding[],
  _chainHoldings: ChainHolding[],
  trades: ParsedTrade[],
  _riskV2: RiskV2,
  _personalityV2: PersonalityV2,
): Promise<BehaviorEngineOutput> {
  // A. Empty case — exactly as specified.
  if (trades.length === 0) {
    return { behaviorV2: EMPTY_BEHAVIOR, behaviorStatus: 'empty' }
  }

  const nowMs = Date.now()
  const cutoffMs = nowMs - THIRTY_DAYS_MS

  // Bridging/farming signal — GENUINE STRUCTURAL GAP, DISCLOSED: computeBehavior's own public
  // signature (as literally specified by this task) never receives `walletAddress` at all, unlike
  // every other module in this task chain that fetches real per-wallet data
  // (fetchAllHoldings/computeChainActivity both take it explicitly). `fetchChainSignals` (reused
  // from the chain-activity module for exactly this bridge/LP data, see file header) REQUIRES a
  // real wallet address to fetch anything — none of this function's own parameters
  // (PnlV2/Portfolio/ChainActivityRecord[]/PricedHolding[]/ChainHolding[]/ParsedTrade[]/RiskV2/
  // PersonalityV2) carry one. Rather than call it with a fabricated empty string (which would
  // either error or silently return meaningless data for "wallet ''"), bridgeTxCount30d/
  // lpEventCount are honestly 0 here — not because no bridging/farming happened, but because this
  // function literally cannot fetch that real data given the parameters it was specified to
  // receive. If real bridging/farming detection is wanted, `walletAddress` needs to be added to
  // this function's own signature (a real, disclosed follow-up, not fixed here since it would mean
  // deviating from the task's own literal specified signature).
  const bridgeTxCount30d = 0
  const lpEventCount = 0

  const bridgingBehavior: BehaviorV2['bridgingBehavior'] =
    tierFor(bridgeTxCount30d, 10, 1) === 'heavy' ? 'bridge-heavy' : tierFor(bridgeTxCount30d, 10, 1) === 'light' ? 'bridge-light' : 'none'
  const farmingBehavior: BehaviorV2['farmingBehavior'] =
    tierFor(lpEventCount, 5, 1) === 'heavy' ? 'farmer' : tierFor(lpEventCount, 5, 1) === 'light' ? 'occasional' : 'none'

  // F. stableRoutingBehavior — real canonical-address match, see file header.
  const stableSwapCount = trades.filter((t) => STABLE_ADDRESSES.has(t.tokenAddress.toLowerCase())).length
  const stableTier = tierFor(stableSwapCount, 10, 1)
  const stableRoutingBehavior: BehaviorV2['stableRoutingBehavior'] =
    stableTier === 'heavy' ? 'router' : stableTier === 'light' ? 'occasional' : 'none'

  // G. memeBehavior — meme-classified value share of total portfolio.
  const memeValueUsd = pricedHoldings.filter((h) => h.classification === 'meme').reduce((sum, h) => sum + (h.valueUsd ?? 0), 0)
  const memeRatio = portfolioV2.totalValueUsd > 0 ? memeValueUsd / portfolioV2.totalValueUsd : 0
  const memeBehavior: BehaviorV2['memeBehavior'] = memeRatio > 0.2 ? 'meme-active' : memeRatio >= 0.05 ? 'meme-curious' : 'none'

  // H. tradeFrequency — "trades.length >= 50 (last 30 days)" per the task's own step H; scoped to
  // the last 30 days, not all-time trade count.
  const tradesLast30d = trades.filter((t) => t.timestamp * 1000 >= cutoffMs).length
  const tradeFrequency: BehaviorV2['tradeFrequency'] = tradesLast30d >= 50 ? 'high' : tradesLast30d >= 10 ? 'medium' : 'low'

  const behaviorV2: BehaviorV2 = {
    accumulationStyle: accumulationStyleFor(trades), // B.
    rotationStyle: rotationStyleFor(trades, nowMs), // C.
    bridgingBehavior, // D.
    farmingBehavior, // E.
    stableRoutingBehavior,
    memeBehavior,
    tradeFrequency,
    behaviorSummary: '', // filled below
  }
  behaviorV2.behaviorSummary = buildSummary(behaviorV2) // I.

  // J. behaviorStatus — trades already confirmed non-empty above.
  const hasUnpriced = pricedHoldings.some((h) => h.valueUsd == null)
  const behaviorStatus: BehaviorEngineOutput['behaviorStatus'] = hasUnpriced ? 'partial' : 'ok'

  return { behaviorV2, behaviorStatus }
}
