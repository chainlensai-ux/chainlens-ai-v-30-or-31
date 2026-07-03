// MODULE — lotCloser: FIFO Lot Closer for Wallet Scanner V2.
//
// STANDALONE, ADDITIVE, NOT WIRED INTO THE PIPELINE — same convention as swapNormalizer,
// tradeIntent, and lotOpener (which this module consumes). Takes IntentLot[] (from
// src/modules/lotOpener) and TradeWithIntent[] (from src/modules/tradeIntent) and closes lots in
// strict FIFO order against SELL trades.
//
// NAMING NOTE: `ClosedLot` does not collide with anything in src/modules/fifoEngine/ (that module's
// equivalent type is `MatchedLot`, doing a related-but-separate job: real quantity-based FIFO
// matching over NormalizedEvent[] with optional USD price-lookup hooks). This module is a different,
// standalone pipeline stage operating on TradeWithIntent[]/IntentLot[] — kept distinct per the
// naming-collision lesson from swapNormalizer/lotOpener.
//
// CURRENCY HONESTY, DISCLOSED (the single most important design decision here): a SELL trade's
// `amountOut` is denominated in whatever `tokenOut` actually is — real USD only when tokenOut is a
// genuine USD-pegged stablecoin (USDC/USDT/DAI/USDBC), otherwise it's an amount of that other base
// asset (e.g. WETH). Likewise a lot's `costBasis` is denominated in `costBasisCurrency` (set by
// lotOpener the same way). Subtracting a WETH-denominated costBasis from a USDC-denominated proceeds
// figure (or vice versa) would silently produce a meaningless mixed-currency number. So:
//   - `realizedPnl` is computed as `proceeds - costBasis` for the closed portion EXACTLY as
//     requested, in every case (the required field is always a number, never omitted).
//   - An additive `pnlCurrency` field reports the currency this subtraction was actually performed
//     in when it's valid (proceeds and cost basis share the same currency), OR flags the mismatch
//     explicitly when they don't (`pnlCurrencyMismatch: true`) — never silently fabricating a USD
//     figure from two different assets. A consumer that ignores the additive fields gets exactly the
//     literal `realizedPnl = proceeds - costBasis` behavior requested; a consumer that reads them
//     never mistakes a mixed-currency number for a real USD PnL.

import type { IntentLot } from '../lotOpener'
import type { TradeWithIntent } from '../tradeIntent/intentEngine'
import type { TokenRef } from '../swapNormalizer'

export type ClosedLot = {
  lotId: string
  wallet: string
  token: TokenRef
  amountClosed: number
  costBasis: number
  proceeds: number
  realizedPnl: number
  openedAt: number
  closedAt: number
  openTx: string
  closeTx: string
  meta: { hops: number; reconstructedFromTransfers: boolean }
  /** Additive — see module header. "USD" or the shared asset symbol when proceeds and cost basis
   *  are genuinely the same currency; otherwise a disclosed mismatch label. */
  pnlCurrency: string
  /** Additive — true when proceeds and cost basis were NOT in the same currency, meaning
   *  `realizedPnl` above mixes two different assets and should not be treated as a real PnL figure. */
  pnlCurrencyMismatch: boolean
}

export type CloseLotsResult = {
  closedLots: ClosedLot[]
  remainingLots: IntentLot[]
  /** Additive — SELL volume that could not be matched to any open lot (no lot evidence exists for
   *  that wallet+token, or available lots were smaller than the sell amount). Never fabricated as a
   *  closed lot with invented cost basis; surfaced here instead so it's visible, not silently
   *  dropped. See "SELL with no matching lot" in the worked examples below. */
  unmatchedSells: Array<{ wallet: string; token: TokenRef; amountUnmatched: number; txHash: string; timestamp: number }>
}

// Same narrower "is this really USD" set as lotOpener.ts — deliberately independent literal copies
// per this codebase's "no runtime coupling between modules" convention (see swapNormalizer's own
// GOLDRUSH_VERIFIED_CHAIN_SLUGS precedent for the same pattern).
const USD_STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC'])

function currencyOf(token: TokenRef): string {
  return USD_STABLE_SYMBOLS.has((token.symbol ?? '').toUpperCase()) ? 'USD' : token.symbol
}

function tokenKey(wallet: string, tokenAddress: string): string {
  return `${wallet.toLowerCase()}|${tokenAddress.toLowerCase()}`
}

// Working, mutable copy of a lot during FIFO consumption — kept separate from the public IntentLot
// shape so partial-close bookkeeping never mutates a caller's original objects.
type LotCursor = {
  original: IntentLot
  remainingAmount: number
}

// Public entry point. Pure: same input always produces the same output, no I/O, no randomness.
// Only SELL trades close lots — BUY, SWAP, LP_ADD, and LP_REMOVE are ignored entirely by this
// module (BUY/LP_ADD already handled by lotOpener; SWAP/LP_REMOVE are out of scope by design, per
// the request's own "keep scope tight" rule).
export function closeLots(lots: IntentLot[], trades: TradeWithIntent[]): CloseLotsResult {
  // Defensive, deterministic ordering — never trusts input array order. FIFO within each
  // (wallet, token) group is by lot timestamp ascending, tie-broken by sourceTx for full
  // determinism when two lots share a timestamp.
  const cursorsByKey = new Map<string, LotCursor[]>()
  for (const lot of lots) {
    const key = tokenKey(lot.wallet, lot.token.address)
    const list = cursorsByKey.get(key) ?? []
    list.push({ original: lot, remainingAmount: lot.amount })
    cursorsByKey.set(key, list)
  }
  for (const list of cursorsByKey.values()) {
    list.sort((a, b) => {
      if (a.original.timestamp !== b.original.timestamp) return a.original.timestamp - b.original.timestamp
      return a.original.sourceTx.localeCompare(b.original.sourceTx)
    })
  }

  const sells = trades
    .filter((t) => t.intent === 'SELL')
    .slice()
    .sort((a, b) => (a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.txHash.localeCompare(b.txHash)))

  const closedLots: ClosedLot[] = []
  const unmatchedSells: CloseLotsResult['unmatchedSells'] = []

  for (const sell of sells) {
    // A SELL's tokenIn is the token the wallet disposes of — that's what must match an open lot's
    // token, NOT tokenOut (the base/stable asset received, i.e. the proceeds side).
    const key = tokenKey(sell.wallet, sell.tokenIn.address)
    const queue = cursorsByKey.get(key) ?? []
    const proceedsCurrency = currencyOf(sell.tokenOut)

    let remainingSellAmount = sell.amountIn
    let remainingProceeds = sell.amountOut

    for (const cursor of queue) {
      if (remainingSellAmount <= 0) break
      if (cursor.remainingAmount <= 0) continue

      const amountClosed = Math.min(cursor.remainingAmount, remainingSellAmount)
      // Proportional allocation: this lot's share of the sale, and this sale's share of proceeds —
      // both scaled by the fraction of the SELL this particular lot actually covers. Never applies
      // a lot's FULL cost basis when only partially closing it.
      const fractionOfLot = amountClosed / cursor.original.amount
      const fractionOfSell = amountClosed / sell.amountIn
      const costBasisForClose = cursor.original.costBasis * fractionOfLot
      const proceedsForClose = sell.amountOut * fractionOfSell

      const lotCurrency = cursor.original.costBasisCurrency
      const mismatch = lotCurrency !== proceedsCurrency
      const realizedPnl = proceedsForClose - costBasisForClose

      closedLots.push({
        lotId: cursor.original.id,
        wallet: sell.wallet,
        token: cursor.original.token,
        amountClosed,
        costBasis: costBasisForClose,
        proceeds: proceedsForClose,
        realizedPnl,
        openedAt: cursor.original.timestamp,
        closedAt: sell.timestamp,
        openTx: cursor.original.sourceTx,
        closeTx: sell.txHash,
        meta: { hops: sell.meta.hops, reconstructedFromTransfers: sell.meta.reconstructedFromTransfers },
        pnlCurrency: mismatch ? `${lotCurrency}/${proceedsCurrency} (mismatched — not a reliable PnL figure)` : lotCurrency,
        pnlCurrencyMismatch: mismatch,
      })

      cursor.remainingAmount -= amountClosed
      remainingSellAmount -= amountClosed
      remainingProceeds -= proceedsForClose
    }

    // SELL with no matching lot at all, or lots insufficient to cover the full sell amount — never
    // fabricate a closed lot with an invented cost basis for the uncovered remainder. Surfaced as an
    // honest gap instead.
    if (remainingSellAmount > 0) {
      unmatchedSells.push({
        wallet: sell.wallet,
        token: sell.tokenIn,
        amountUnmatched: remainingSellAmount,
        txHash: sell.txHash,
        timestamp: sell.timestamp,
      })
    }
  }

  const remainingLots: IntentLot[] = []
  for (const list of cursorsByKey.values()) {
    for (const cursor of list) {
      if (cursor.remainingAmount <= 0) continue
      const fractionRemaining = cursor.remainingAmount / cursor.original.amount
      remainingLots.push({
        ...cursor.original,
        amount: cursor.remainingAmount,
        // Cost basis shrinks proportionally with the remaining amount — a partially-closed lot's
        // leftover portion never keeps the FULL original cost basis.
        costBasis: cursor.original.costBasis * fractionRemaining,
      })
    }
  }
  // Deterministic output order — ascending by original open timestamp, tie-broken by sourceTx.
  remainingLots.sort((a, b) => (a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.sourceTx.localeCompare(b.sourceTx)))

  return { closedLots, remainingLots, unmatchedSells }
}

// ─── Worked examples (illustrative only — see lotCloser.test.ts for executable versions) ───
//
// 1. SIMPLE FULL CLOSE — one BUY opens a 1000 DEGEN lot (cost 100 USDC), one SELL fully closes it:
//    lot: { amount:1000, costBasis:100, costBasisCurrency:"USD" }
//    sell: tokenIn=DEGEN amountIn=1000, tokenOut=USDC amountOut=150
//    -> closedLots=[{ amountClosed:1000, costBasis:100, proceeds:150, realizedPnl:50,
//                     pnlCurrency:"USD", pnlCurrencyMismatch:false }], remainingLots=[]
//
// 2. PARTIAL CLOSE — same 1000 DEGEN lot, SELL only 400:
//    -> closedLots=[{ amountClosed:400, costBasis:40 (=100*400/1000), proceeds:60, realizedPnl:20 }]
//    remainingLots=[{ amount:600, costBasis:60 (=100*600/1000) }]
//
// 3. MULTI-LOT CLOSE — two BUYs open lots of 500 DEGEN (cost 50) then 500 DEGEN (cost 60), one SELL
//    of 800 DEGEN for 200 USDC:
//    -> closedLots covers the OLDER lot fully (500, cost 50, proceeds 125) then 300 of the newer lot
//       (cost 36 = 60*300/500, proceeds 75) — strict FIFO, oldest lot consumed first.
//    remainingLots=[{ amount:200 (=500-300), costBasis:24 (=60*200/500) }]
//
// 4. SELL WITH NO MATCHING LOT — a SELL for a token with zero open lots for that wallet:
//    -> closedLots=[] for that sell, unmatchedSells=[{ amountUnmatched: sell.amountIn, ... }] —
//       never fabricates a closed lot with an invented cost basis.
//
// 5. MIXED TOKENS — lots exist for both DEGEN and BRETT; a SELL of DEGEN only closes DEGEN lots:
//    the BRETT lot passes through untouched into remainingLots, unaffected by the DEGEN SELL.
