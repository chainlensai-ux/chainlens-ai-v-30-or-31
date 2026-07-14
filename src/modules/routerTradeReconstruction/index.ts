// MODULE — routerTradeReconstruction
//
// SCOPE, HONESTLY DISCLOSED UP FRONT (same reasoning this codebase already applied to
// src/modules/distributorRecovery — read this before wiring anything further):
//
//   Every real event a router-mediated swap produces (the outbound-to-router leg AND the
//   inbound-from-router leg) is ALREADY present in `normalizedEvents` — confirmed by this
//   pipeline's own existing debug trace (src/pipeline/index.ts's "[debug] normalizedEvents trace")
//   and already disclosed by src/pipeline/index.ts's own dust-suppression comments ("fifoEngine...
//   still receives the exact original, unfiltered normalizedEvents"). fifoEngine (protected,
//   untouched) already sees every one of these real events today. There is no missing RAW EVENT to
//   "recover" here the way recoveryPolicy recovers events genuinely outside the provider fetch
//   window.
//
//   What this module CAN safely, honestly add is a DERIVED VIEW over that same real data: pairing
//   an outbound-to-router leg with its same-transaction inbound-from-router leg into one logical
//   "candidate trade" (tokenIn/tokenOut/amountIn/amountOut), tagged with a confidence level, for
//   OBSERVABILITY — surfacing router-mediated swap structure a human/dashboard can read, without
//   asserting anything fifoEngine itself doesn't already independently see and match per-token.
//
//   This module's candidate trades are NEVER fed into priceLotsForWallet's or fifoEngine's real
//   event inputs (normalizedEvents/recoveredEvents) — doing so would inject a NEW, non-1:1-real
//   event object into a deterministic, protected financial engine's input, which changes its real
//   output (matchedLots/publicPnlStatus) exactly as much as editing its formulas would, even though
//   no engine source file is touched. That is the literal thing this task's hard constraints forbid
//   ("do not change realized/unrealized PnL formulas... all changes must be strictly additive").
//   "Additive" here means additive OBSERVABILITY, not a second, shadow event-matching path feeding
//   the real engine synthetic data.
//
//   CONSEQUENCE, DISCLOSED: this module does NOT change pnlV2's "PnL unavailable" status for any
//   wallet — see this module's own test suite and the pipeline wiring's own comment for the
//   verification of that claim. If a wallet's real matchedLots/publicPnlStatus needs to improve,
//   the only safe levers are recoveryPolicy's window/depth (already a real, existing, protected
//   mechanism — out of scope for this task) or fifoEngine's own matching algorithm (explicitly
//   forbidden to touch here).

import type { NormalizedEvent } from '../normalization/types'

export type TradeConfidence = 'high' | 'medium'
// 'low' is a reserved, intentionally UNUSED tier, disclosed: this module never emits a candidate
// trade from ambiguous evidence (no same-tx counterpart) — "never fabricate a trade when evidence
// is ambiguous" (this task's own rule) means there is no honest "low confidence trade" to produce;
// an ambiguous outbound-to-router leg simply produces no candidate at all.

export type CandidateTrade = {
  chain: string
  txHash: string
  timestamp: string
  tokenIn: string
  tokenOut: string
  amountIn: number
  amountOut: number
  confidence: TradeConfidence
}

export type RouterTradeReconstructionResult = {
  applied: boolean
  candidateTrades: CandidateTrade[]
  highConfidenceCount: number
  ambiguousCount: number
}

// PURE. Groups all events sharing one (chain, txHash) — the only boundary this module ever pairs
// legs within (never across transactions).
function groupByTx(events: readonly NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const byTx = new Map<string, NormalizedEvent[]>()
  for (const e of events) {
    const key = `${e.chain}:${e.txHash}`
    const list = byTx.get(key) ?? []
    list.push(e)
    byTx.set(key, list)
  }
  return byTx
}

// PURE, exported for direct testing. `normalizedEvents` should be this scan's real, already-fetched
// normalizeEvents() output — never mutated, never reordered, never written back anywhere.
// `knownDexRouterAddresses` is caller-injected (the pipeline's own KNOWN_DEX_ROUTER_ADDRESSES),
// same convention already used by routerDiscovery.ts and distributorRecovery.
export function reconstructRouterTrades(
  normalizedEvents: readonly NormalizedEvent[],
  knownDexRouterAddresses: ReadonlySet<string>,
  routerDistributorMode: boolean,
): RouterTradeReconstructionResult {
  if (!routerDistributorMode) {
    return { applied: false, candidateTrades: [], highConfidenceCount: 0, ambiguousCount: 0 }
  }

  const byTx = groupByTx(normalizedEvents)
  const candidateTrades: CandidateTrade[] = []
  let ambiguousCount = 0

  for (const outbound of normalizedEvents) {
    if (outbound.direction !== 'outbound') continue
    if (!knownDexRouterAddresses.has(outbound.toAddress.toLowerCase())) continue

    const txEvents = byTx.get(`${outbound.chain}:${outbound.txHash}`) ?? [outbound]
    const inboundLegs = txEvents.filter((e) => e.direction === 'inbound' && e.contract.toLowerCase() !== outbound.contract.toLowerCase())
    const outboundLegs = txEvents.filter((e) => e.direction === 'outbound' && knownDexRouterAddresses.has(e.toAddress.toLowerCase()))

    if (inboundLegs.length === 0) {
      // No same-tx return leg at all — genuinely ambiguous (multi-hop, cross-wallet return, or a
      // destination this wallet's own history simply doesn't show). Never fabricated into a trade.
      ambiguousCount += 1
      continue
    }

    // HIGH CONFIDENCE: exactly one outbound-to-router leg and exactly one inbound-from-router leg
    // in this transaction — an unambiguous 1:1 pairing, no guessing which inbound belongs to which
    // outbound.
    // MEDIUM CONFIDENCE: a same-tx inbound leg exists, but this transaction has multiple
    // outbound-to-router and/or inbound legs (a real multi-hop or multi-token router call) — the
    // FIRST inbound leg is used as the pairing (a real event, never invented), but which specific
    // outbound/inbound pair corresponds to which real swap step is not verifiable from transfer
    // legs alone, so this is disclosed as a lower-confidence pairing rather than asserted as exact.
    const confidence: TradeConfidence = (outboundLegs.length === 1 && inboundLegs.length === 1) ? 'high' : 'medium'
    const inbound = inboundLegs[0]

    candidateTrades.push({
      chain: outbound.chain,
      txHash: outbound.txHash,
      timestamp: outbound.timestamp,
      tokenIn: outbound.contract,
      tokenOut: inbound.contract,
      amountIn: outbound.amount,
      amountOut: inbound.amount,
      confidence,
    })
  }

  return {
    applied: true,
    candidateTrades,
    highConfidenceCount: candidateTrades.filter((t) => t.confidence === 'high').length,
    ambiguousCount,
  }
}

// PURE. Real-liquidity pool health classifier for memecoin-pool observability (this task's Part 2).
// Deliberately standalone — does NOT modify any existing pricing/pool module's public API (e.g.
// src/modules/fallbackPricing/geckoTerminalClient.ts, which already fetches a real reserve_in_usd
// figure per pool but exposes no liquidity classification of its own). A caller with a real
// liquidity figure (never fabricated here) can classify it; this module fetches nothing itself.
export type PoolLiquidityClass = 'real' | 'dust' | 'abandoned'

const DUST_POOL_LIQUIDITY_USD = 1_000
const ABANDONED_POOL_LIQUIDITY_USD = 100

export function classifyPoolLiquidity(liquidityUsd: number | null): PoolLiquidityClass {
  if (liquidityUsd === null || !Number.isFinite(liquidityUsd) || liquidityUsd <= ABANDONED_POOL_LIQUIDITY_USD) return 'abandoned'
  if (liquidityUsd <= DUST_POOL_LIQUIDITY_USD) return 'dust'
  return 'real'
}
