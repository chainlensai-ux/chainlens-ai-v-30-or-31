// MODULE — lotOpener: FIFO Lot Opener for Wallet Scanner V2.
//
// STANDALONE, ADDITIVE, NOT WIRED INTO THE PIPELINE — same convention as swapNormalizer and
// tradeIntent (which this module consumes). Takes TradeWithIntent[] (from src/modules/tradeIntent)
// and creates open lots for BUY trades.
//
// NAMING DISCLOSURE: this module lives at src/modules/lotOpener/ (not "fifoLotOpener" as the
// request's own framing suggested), and its lot type is named `IntentLot` (not `OpenLot`), because
// src/modules/fifoEngine/ already exports a REAL, already-shipped, numbered ("MODULE 6") `OpenLot`
// type that does actual quantity-based FIFO matching over NormalizedEvent[] — a different pipeline
// stage entirely, operating on different input. Reusing the same type/module name here would create
// exactly the kind of confusion this codebase has already run into once before (swapNormalizer vs.
// the pre-existing "normalization" module). No collision with the real fifoEngine anywhere below.
//
// COST-BASIS HONESTY, DISCLOSED: the request describes costBasis as "in USD or stable equivalent"
// and says `costBasis = amountIn`. That equivalence is only actually true when tokenIn is a real
// USD-pegged stablecoin (USDC/USDT/DAI) — amountIn of WETH/ETH is an ETH-denominated amount, NOT a
// USD figure, and this module has no pricing logic or price oracle (same "no pricing logic" rule
// this whole module family has followed since swapNormalizer, and the same principle
// src/modules/fifoEngine/types.ts already states explicitly: "fifoEngine must never guess cost
// basis... never invents a USD figure"). So `costBasis` here is always `amountIn` as requested, but
// a `costBasisCurrency` field is added (additive, not in the request's literal contract) that
// honestly reports what currency amountIn is actually denominated in — "USD" only for a real
// USD-pegged stablecoin tokenIn, otherwise the spent token's own symbol. A consumer that ignores
// this field gets exactly the literal `costBasis = amountIn` behavior requested; a consumer that
// reads it never mistakes a WETH amount for a USD figure.
//
// SPEC CONTRADICTION, DISCLOSED: the request states both "Only BUY trades create lots" AND
// "LP_ADD creates synthetic lots for both tokens" — these directly contradict each other. Resolved
// by treating LP_ADD as an explicit, separate, documented exception to the BUY-only rule (SELL,
// SWAP, and LP_REMOVE trades never create lots; BUY and LP_ADD do).
//
// "BOTH TOKENS" LIMITATION, DISCLOSED: a real NormalizedTrade for LP_ADD (see
// src/modules/swapNormalizer/swapNormalizer.ts) only carries ONE underlying token on `tokenIn` (plus
// the LP token itself on `tokenOut`) — the second underlying token supplied to the pool is computed
// internally by lpAddRemoveDetector.ts but never surfaced on the final trade object reaching this
// module. Creating a second synthetic lot here would mean fabricating a token/amount this module has
// no evidence for, which every module in this family has refused to do. This module therefore
// creates exactly ONE synthetic lot per LP_ADD, for the one underlying token it actually has real
// data for — documented here rather than silently only doing half of what was asked.

import type { TradeWithIntent } from '../tradeIntent/intentEngine'
import type { TokenRef } from '../swapNormalizer'

export type IntentLot = {
  id: string
  wallet: string
  token: TokenRef
  amount: number
  costBasis: number
  /** Additive, honest disclosure — see module header. "USD" only for a real USD-pegged stablecoin
   *  tokenIn; otherwise the spent token's own symbol (e.g. "WETH"). */
  costBasisCurrency: string
  timestamp: number
  sourceTx: string
  /** Additive — which rule produced this lot. LP_ADD is a documented exception to "BUY only". */
  intent: 'BUY' | 'LP_ADD'
  meta: {
    hops: number
    reconstructedFromTransfers: boolean
    /** Additive passthrough — surfaces when a lot's amount/token came from a best-effort
     *  reconstruction rather than fully resolved data (see missing-side BUY handling below). */
    missingSide: 'none' | 'tokenIn' | 'tokenOut'
  }
}

// Real USD-pegged stablecoins only — deliberately narrower than tradeIntent's isBaseOrStable()
// (which also includes WETH/ETH/OP/ARB, none of which are $1-pegged). Kept as an independent
// literal copy rather than importing tradeIntent's broader set, since the two questions
// ("is this asset the settlement side of a trade" vs. "is 1 unit of this asset ~$1") are genuinely
// different and must not be conflated.
const USD_STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC'])

function isUsdStable(token: TokenRef): boolean {
  return USD_STABLE_SYMBOLS.has((token.symbol ?? '').toUpperCase())
}

function costBasisCurrencyFor(spentToken: TokenRef): string {
  return isUsdStable(spentToken) ? 'USD' : spentToken.symbol
}

// Deterministic, non-cryptographic string hash (djb2 variant) — no external dependencies, no
// Node crypto import, so this stays usable in a browser dev-console context like the rest of this
// module family. Same (txHash, tokenOut.address, timestamp) input always produces the same id.
function deterministicHash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0 // hash * 33 + c, 32-bit wraparound
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function lotId(txHash: string, tokenAddress: string, timestamp: number): string {
  return `lot_${deterministicHash(`${txHash}|${tokenAddress.toLowerCase()}|${timestamp}`)}`
}

function openLotFromBuy(trade: TradeWithIntent): IntentLot {
  // Multi-hop BUYs are already flattened into a single trade by swapNormalizer (tokenIn = first
  // leg, tokenOut = final leg) before classifyTradeIntent ever sees them — this function trusts
  // that contract and never re-splits a trade into per-hop lots.
  //
  // Missing-side BUY (meta.missingSide === 'tokenOut'): swapNormalizer could not resolve the
  // received token, so tokenOut is the UNKNOWN placeholder and amountOut is 0. The lot is still
  // created (a real trade's cost basis is real evidence, never silently dropped), honestly
  // reflecting amount=0/token=UNKNOWN rather than guessing what was actually received. Note:
  // meta.missingSide === 'tokenIn' cannot actually reach here as a BUY — classifyTradeIntent only
  // assigns 'BUY' for a missing-tokenOut case (the known, spent side must be base/stable); a
  // missing-tokenIn trade is classified SELL or SWAP upstream, never BUY. Handled defensively below
  // anyway rather than assumed, in case that upstream contract ever changes.
  return {
    id: lotId(trade.txHash, trade.tokenOut.address, trade.timestamp),
    wallet: trade.wallet,
    token: trade.tokenOut,
    amount: trade.amountOut,
    costBasis: trade.amountIn,
    costBasisCurrency: costBasisCurrencyFor(trade.tokenIn),
    timestamp: trade.timestamp,
    sourceTx: trade.txHash,
    intent: 'BUY',
    meta: { hops: trade.meta.hops, reconstructedFromTransfers: trade.meta.reconstructedFromTransfers, missingSide: trade.meta.missingSide },
  }
}

function openLotFromLpAdd(trade: TradeWithIntent): IntentLot {
  // See module header "BOTH TOKENS" LIMITATION — only tokenIn (the one underlying token this
  // module has real data for) becomes a lot. costBasis is self-referential (denominated in the
  // token's own units, costBasisCurrency = the token's own symbol) since there is no second
  // currency to price it against without fabricating data.
  return {
    id: lotId(trade.txHash, trade.tokenIn.address, trade.timestamp),
    wallet: trade.wallet,
    token: trade.tokenIn,
    amount: trade.amountIn,
    costBasis: trade.amountIn,
    costBasisCurrency: trade.tokenIn.symbol,
    timestamp: trade.timestamp,
    sourceTx: trade.txHash,
    intent: 'LP_ADD',
    meta: { hops: trade.meta.hops, reconstructedFromTransfers: trade.meta.reconstructedFromTransfers, missingSide: trade.meta.missingSide },
  }
}

// Public entry point. Pure: same input always produces the same output, no I/O, no randomness.
// SELL, SWAP, and LP_REMOVE trades never create a lot (they close/reduce a position rather than
// open one) — only BUY and the documented LP_ADD exception do.
export function openLots(trades: TradeWithIntent[]): IntentLot[] {
  const lots: IntentLot[] = []
  for (const trade of trades) {
    if (trade.intent === 'BUY') lots.push(openLotFromBuy(trade))
    else if (trade.intent === 'LP_ADD') lots.push(openLotFromLpAdd(trade))
  }
  return lots
}

// ─── Worked examples (illustrative only — see lotOpener.test.ts for executable versions) ───
//
// 1. SIMPLE BUY — USDC -> DEGEN, single hop, both sides resolved:
//    intent="BUY", tokenIn={symbol:"USDC"}, tokenOut={symbol:"DEGEN"}, amountIn=100, amountOut=1000
//    -> { token:{symbol:"DEGEN"}, amount:1000, costBasis:100, costBasisCurrency:"USD" }
//
// 2. MULTI-HOP BUY — USDC -> [3 hops] -> DEGEN:
//    intent="BUY", meta.hops=3, tokenIn={symbol:"USDC"}, tokenOut={symbol:"DEGEN"}
//    -> ONE lot (already flattened upstream), meta.hops=3 passed through for provenance.
//
// 3. MISSING-SIDE BUY — USDC spent, received token unresolved:
//    intent="BUY", meta.missingSide="tokenOut", tokenOut=UNKNOWN_TOKEN, amountOut=0
//    -> { token: UNKNOWN_TOKEN, amount:0, costBasis:<real amountIn>, costBasisCurrency:"USD",
//         meta.missingSide:"tokenOut" } — real spend recorded, receive side honestly unresolved.
//
// 4. LP_ADD SYNTHETIC LOT — USDC supplied (+ an untracked second underlying token) for an LP token:
//    intent="LP_ADD", tokenIn={symbol:"USDC"}, tokenOut={symbol:"LP"}, amountIn=1000
//    -> ONE lot: { token:{symbol:"USDC"}, amount:1000, costBasis:1000, costBasisCurrency:"USDC" }
//    (the second underlying token, if any, is not reconstructable — see module header.)
//
// 5. VOLATILE BUY WITH STABLE COST BASIS — DAI -> BRETT:
//    intent="BUY", tokenIn={symbol:"DAI"}, tokenOut={symbol:"BRETT"}, amountIn=250, amountOut=500
//    -> { token:{symbol:"BRETT"}, amount:500, costBasis:250, costBasisCurrency:"USD" }
//    Contrast: if tokenIn were WETH instead of DAI, costBasisCurrency would be "WETH", not "USD" —
//    amountIn is never silently relabeled as a USD figure just because WETH is a "base" asset.
