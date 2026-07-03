// MODULE — realizedPnl: Realized PnL Engine for Wallet Scanner V2.
//
// STANDALONE, ADDITIVE, NOT WIRED INTO THE PIPELINE — same convention as swapNormalizer,
// tradeIntent, lotOpener, and lotCloser (which this module consumes). Pure aggregation only.
//
// NAMING/TYPE-COLLISION DISCLOSURE: src/modules/pnlEngine/ already exists — a real, already-shipped
// module doing a related-but-DIFFERENT job (a read-model over sellTimelineV2/buyTimeline entries,
// with its OWN `ClosedLot` type, unrelated to lotCloser's). This module lives at
// src/modules/realizedPnl/ instead of "pnlEngine" to avoid recreating that exact naming confusion.
// The `ClosedLot` used below is imported directly from src/modules/lotCloser — never redefined —
// so there is no ambiguity about which "ClosedLot" this module operates on.
//
// CURRENCY HONESTY, DISCLOSED (the core design decision, same principle as lotOpener/lotCloser):
// summing realizedPnl/costBasis/proceeds across lots denominated in different currencies (some USD,
// some WETH, some already-flagged-mismatched) would silently fabricate a meaningless number. So:
//   - The dominant currency is the one with the most closed lots (ties broken by the currency
//     string that sorts first, for full determinism).
//   - totalRealizedPnl/totalCostBasis/totalProceeds/realizedRoi/avgWin/avgLoss are computed ONLY
//     over lots whose OWN pnlCurrency equals the dominant currency AND whose pnlCurrencyMismatch is
//     false. Lots that don't qualify are never silently dropped — they're surfaced via the additive
//     `currencyMismatchLots` (internally mismatched, per the request's own field) and the additive
//     `nonDominantCurrencyLots` (internally consistent, but a different currency than the wallet's
//     dominant one) fields instead.
//   - winRate is computed over ALL closed lots regardless of currency — "did this trade make money"
//     is a directional signal, not a magnitude, so it isn't corrupted by mixing currencies the way a
//     summed dollar figure would be.
//   - holdingTimeAvg/holdingTimeMedian are pure time deltas (closedAt - openedAt) and are currency-
//     independent — computed over ALL closed lots.
//   - byToken applies the same dominant-currency-per-token logic independently for each token, since
//     a single token could in principle have been bought with different funding assets over time.

import type { ClosedLot } from '../lotCloser'

export type RealizedPnlSummary = {
  totalRealizedPnl: number
  totalCostBasis: number
  totalProceeds: number
  /** proceeds / costBasis - 1, computed only over the dominant-currency lots. 0 when costBasis is
   *  0 (no meaningful ratio — never NaN/Infinity leaking into this field). */
  realizedRoi: number
  /** Percentage (0-100), computed over ALL closed lots regardless of currency — see module header. */
  winRate: number
  avgWin: number
  avgLoss: number
  holdingTimeAvg: number
  holdingTimeMedian: number
  /** The dominant pnlCurrency across all closed lots (most lots; alphabetical tiebreak). "NONE"
   *  when there are no closed lots at all. */
  currency: string
  /** Lots whose OWN pnlCurrencyMismatch flag is true (proceeds/cost-basis mismatch within the lot
   *  itself) — per the request's own field, always populated regardless of dominant currency. */
  currencyMismatchLots: ClosedLot[]
  /** Additive — internally-consistent lots (pnlCurrencyMismatch=false) whose pnlCurrency differs
   *  from the wallet-wide dominant currency, and were therefore excluded from the totals above
   *  rather than silently mixed in. Never populated by currencyMismatchLots entries (mutually
   *  exclusive sets). */
  nonDominantCurrencyLots: ClosedLot[]
  byToken: Record<
    string,
    {
      realizedPnl: number
      costBasis: number
      proceeds: number
      roi: number
      count: number
      /** Additive — this token's own dominant currency, same logic as the wallet-level one. */
      currency: string
    }
  >
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function dominantCurrency(lots: ClosedLot[]): string {
  if (lots.length === 0) return 'NONE'
  const counts = new Map<string, number>()
  for (const lot of lots) {
    if (lot.pnlCurrencyMismatch) continue // an internally-mismatched lot's currency label isn't a real currency vote
    counts.set(lot.pnlCurrency, (counts.get(lot.pnlCurrency) ?? 0) + 1)
  }
  if (counts.size === 0) return 'NONE'
  let best: string | null = null
  let bestCount = -1
  for (const [currency, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = currency
      bestCount = count
    }
  }
  return best ?? 'NONE'
}

function safeRoi(proceeds: number, costBasis: number): number {
  return costBasis === 0 ? 0 : proceeds / costBasis - 1
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length
}

// Public entry point. Pure: same input always produces the same output, no I/O, no randomness.
export function computeRealizedPnl(closedLots: ClosedLot[]): RealizedPnlSummary {
  const currency = dominantCurrency(closedLots)

  const currencyMismatchLots = closedLots.filter((l) => l.pnlCurrencyMismatch)
  const nonDominantCurrencyLots = closedLots.filter((l) => !l.pnlCurrencyMismatch && l.pnlCurrency !== currency)
  const countedLots = closedLots.filter((l) => !l.pnlCurrencyMismatch && l.pnlCurrency === currency)

  const totalRealizedPnl = countedLots.reduce((sum, l) => sum + l.realizedPnl, 0)
  const totalCostBasis = countedLots.reduce((sum, l) => sum + l.costBasis, 0)
  const totalProceeds = countedLots.reduce((sum, l) => sum + l.proceeds, 0)
  const realizedRoi = safeRoi(totalProceeds, totalCostBasis)

  // winRate: ALL closed lots, any currency — see module header.
  const winners = closedLots.filter((l) => l.realizedPnl > 0)
  const winRate = closedLots.length === 0 ? 0 : (winners.length / closedLots.length) * 100

  // avgWin/avgLoss: dominant-currency lots only — magnitudes, not directional signals.
  const countedWins = countedLots.filter((l) => l.realizedPnl > 0).map((l) => l.realizedPnl)
  const countedLosses = countedLots.filter((l) => l.realizedPnl < 0).map((l) => l.realizedPnl)
  const avgWin = mean(countedWins)
  const avgLoss = mean(countedLosses)

  // Holding time: pure time deltas, currency-independent, ALL closed lots.
  const holdingTimes = closedLots.map((l) => l.closedAt - l.openedAt)
  const holdingTimeAvg = mean(holdingTimes)
  const holdingTimeMedian = median(holdingTimes)

  // Per-token breakdown, same dominant-currency-per-token logic applied independently.
  const byTokenLots = new Map<string, ClosedLot[]>()
  for (const lot of closedLots) {
    const key = lot.token.address.toLowerCase() || lot.token.symbol
    const list = byTokenLots.get(key) ?? []
    list.push(lot)
    byTokenLots.set(key, list)
  }

  const byToken: RealizedPnlSummary['byToken'] = {}
  for (const [tokenKey, lots] of byTokenLots.entries()) {
    const tokenCurrency = dominantCurrency(lots)
    const tokenCounted = lots.filter((l) => !l.pnlCurrencyMismatch && l.pnlCurrency === tokenCurrency)
    const tokenRealizedPnl = tokenCounted.reduce((sum, l) => sum + l.realizedPnl, 0)
    const tokenCostBasis = tokenCounted.reduce((sum, l) => sum + l.costBasis, 0)
    const tokenProceeds = tokenCounted.reduce((sum, l) => sum + l.proceeds, 0)
    byToken[tokenKey] = {
      realizedPnl: tokenRealizedPnl,
      costBasis: tokenCostBasis,
      proceeds: tokenProceeds,
      roi: safeRoi(tokenProceeds, tokenCostBasis),
      count: lots.length,
      currency: tokenCurrency,
    }
  }

  return {
    totalRealizedPnl,
    totalCostBasis,
    totalProceeds,
    realizedRoi,
    winRate,
    avgWin,
    avgLoss,
    holdingTimeAvg,
    holdingTimeMedian,
    currency,
    currencyMismatchLots,
    nonDominantCurrencyLots,
    byToken,
  }
}

// ─── Worked examples (illustrative only — see pnlSummary.test.ts for executable versions) ───
//
// 1. ALL WINS — 3 closed lots, all realizedPnl > 0, all currency "USD":
//    -> winRate=100, avgLoss=0 (no losses), totalRealizedPnl = sum of all 3.
//
// 2. MIXED WINS/LOSSES — 2 wins (+50, +30), 1 loss (-20), all "USD":
//    -> winRate = 66.67 (2/3 * 100), avgWin = 40 (mean of 50,30), avgLoss = -20.
//
// 3. CURRENCY MISMATCH — 2 lots currency "USD" (no mismatch), 1 lot pnlCurrencyMismatch=true:
//    -> currencyMismatchLots contains the 1 flagged lot; totals only sum the 2 clean USD lots;
//       winRate still counts all 3 (directional signal, currency-independent).
//
// 4. LONG VS SHORT HOLDING TIME — lot A held 30 days, lot B held 1 hour:
//    -> holdingTimeAvg averages both real deltas; holdingTimeMedian is the middle value with an odd
//       count, or the average of the two middle values with an even count.
//
// 5. MULTI-TOKEN BREAKDOWN — lots for DEGEN and BRETT, both currency "USD":
//    -> byToken has two independent keyed entries, each with its own realizedPnl/costBasis/
//       proceeds/roi/count, summing correctly to the same totals as the wallet-wide aggregate
//       when every lot shares the same dominant currency.
