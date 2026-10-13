// Robinhood verified-swap → FIFO audit — OBSERVATIONAL ONLY (never changes verification, pricing or FIFO).
//
// Takes the exact canonical verified-swap set behind the "Verified swaps" count (main lane), plus the recovery /
// deep-acquisition swaps that also feed FIFO, and re-runs FIFO INDEPENDENTLY on raw integer quantities with the
// engine's own rules: token key = lowercase contract (chain-scoped), quote legs (ETH / WETH / stables) never open or
// close lots, input ordered by (timestamp, block, log index, tx hash), a sell only consumes lots opened before it
// (chronology guard), exact-duplicate legs counted once. Matching does NOT depend on pricing in the engine; pricing only
// decides whether a matched lot is "verified" (both cost basis and proceeds known) or "unpriced". Comparing the
// simulation with the engine's actual matched lots separates "no overlap exists" from a real matching defect.

type Swap = {
  txHash: string; timestampSec: number; blockNumber: number; firstLogIndex: number
  inputToken: string; outputToken: string; inputRaw: bigint; outputRaw: bigint
}
type Evidence = { swapTxHash: string; bothLegsVerified: boolean; inputPriceUsd: number | null; outputPriceUsd: number | null }
type Lot = { openedTxHash: string; closedTxHash: string; token: string; amount: number; evidenceQuality: string }

export type RhVerifiedFifoBlocker =
  | 'none' | 'no_earlier_verified_buy' | 'no_later_verified_sell' | 'token_key_mismatch' | 'buy_after_sell'
  | 'insufficient_verified_buy_quantity' | 'sell_quantity_already_consumed' | 'buy_quantity_already_consumed'
  | 'missing_buy_price' | 'missing_sell_price' | 'pricing_gate' | 'duplicate_or_deduped_swap'
  | 'excluded_by_fifo_source_filter' | 'ordering_issue' | 'unknown'

export type RhVerifiedSwapFifoRow = {
  txHash: string; timestamp: number; token: string | null; normalizedTokenKey: string | null; side: 'buy' | 'sell' | 'quote_only'
  verifiedRaw: string | null; nativeRaw: string | null; tokenRaw: string | null
  verificationSource: string; attributionClass: string | null; inCanonicalCount: boolean
  bothLegPriced: boolean; tokenPriceUsd: number | null; nativePriceUsd: number | null
  fifoEligibleBeforePricing: boolean
  /** Matching ignores pricing; this says whether a lot from this leg can be a VERIFIED (priced) lot. */
  fifoEligibleAfterPricing: boolean
  fifoInputIndex: number | null
  matchedAgainstTxHashes: string[]; matchedRaw: string; unmatchedRaw: string
  openLotRawCreated: string; openLotRawConsumed: string
  /** Engine (production) lots for this leg: structural count, verified (priced) count. */
  actualLotCount: number; actualVerifiedLotCount: number
  earlierVerifiedBuys?: Array<{ txHash: string; raw: string; timestamp: number }>
  exactFifoBlocker: RhVerifiedFifoBlocker
}

export type RhVerifiedFifoTokenGroup = {
  token: string; normalizedTokenKey: string
  verifiedBuyCount: number; verifiedSellCount: number; verifiedBuyRaw: string; verifiedSellRaw: string
  earliestVerifiedBuyTs: number | null; latestVerifiedBuyTs: number | null; earliestVerifiedSellTs: number | null; latestVerifiedSellTs: number | null
  buyBeforeSellExists: boolean; bothSidesPriced: boolean
  /** Independent simulation: raw quantity FIFO can close for this token. */
  fifoMatchableRaw: string
  /** Engine: structural matched lots for this token (amounts are decimal units, not raw). */
  actualClosedAmount: number; closedLotCount: number; verifiedClosedLotCount: number
  definiteFifoDefect: boolean
  blocker: RhVerifiedFifoBlocker
}

export type RhVerifiedFifoSummary = {
  verifiedSwapCount: number; verifiedBuyCount: number; verifiedSellCount: number; distinctVerifiedTokens: number
  tokensWithBothVerifiedBuyAndSell: number; tokensWithBuyBeforeSell: number
  bothLegPricedBuyCount: number; bothLegPricedSellCount: number; fifoEligibleBuyCount: number; fifoEligibleSellCount: number
  theoreticalMatchableRawByToken: Record<string, string>
  actualClosedLotCount: number; actualVerifiedClosedLotCount: number; actualClosedAmountByToken: Record<string, number>
  unmatchedVerifiedBuyCount: number; unmatchedVerifiedSellCount: number; verifiedSellsWithNoEarlierVerifiedBuy: number
  verifiedPairsBlockedByPricing: number; verifiedPairsBlockedByTokenKeyMismatch: number; verifiedPairsBlockedByOrdering: number
  verifiedPairsExcludedBeforeFifo: number
  /** True when the simulation closes raw quantity for a token the engine closed nothing for. */
  definiteFifoDefect: boolean
  /**
   * "No overlap" is only a statement about the VERIFIED SAMPLE. It is the complete-history verdict
   * ('zero_closed_lots_correct_no_overlap') only when the scan's history coverage is proven complete; otherwise
   * the qualified form says coverage is incomplete / unknown (earlier acquisitions may lie outside the sample).
   */
  conclusion:
    | 'zero_closed_lots_correct_no_overlap'
    | 'zero_closed_lots_no_overlap_in_sample_coverage_incomplete'
    | 'zero_closed_lots_no_overlap_in_sample_coverage_unknown'
    | 'closed_lots_exist_but_unpriced' | 'closed_lots_exist' | 'fifo_defect'
  historyCoverage: RhHistoryCoverageStatus
  historyCoverageReasons: string[]
}

export type RhHistoryCoverageStatus = 'complete' | 'incomplete' | 'unknown'

const ZERO = BigInt(0)
const lower = (s: string) => s.toLowerCase()

/** PURE. */
export function robinhoodVerifiedSwapFifoAudit(input: {
  chain: string
  isQuote: (token: string) => boolean
  /** The canonical verified-swap set behind the "Verified swaps" count. */
  canonicalSwaps: readonly Swap[]
  /** Other verified swaps that also feed FIFO (acquisition / deep recovery), with their source. */
  extraSwaps: ReadonlyArray<{ swap: Swap; source: string }>
  evidence: readonly Evidence[]
  matchedLots: readonly Lot[]
  attributionByTx?: ReadonlyMap<string, string>
  /** The scan's wallet-history coverage (robinhoodHistoryCoverage). Absent = unknown, never assumed complete. */
  historyCoverage?: { status: RhHistoryCoverageStatus; reasons: string[] }
}): { rows: RhVerifiedSwapFifoRow[]; tokens: RhVerifiedFifoTokenGroup[]; summary: RhVerifiedFifoSummary } {
  const ev = new Map(input.evidence.map((e) => [lower(e.swapTxHash), e]))
  const all = [
    ...input.canonicalSwaps.map((s) => ({ s, source: 'main_lane', canonical: true })),
    ...input.extraSwaps.map((x) => ({ s: x.swap, source: x.source, canonical: false })),
  ]
  // Engine order: timestamp, block, log index, tx hash.
  const ordered = [...all].sort((a, b) => a.s.timestampSec - b.s.timestampSec || a.s.blockNumber - b.s.blockNumber || a.s.firstLogIndex - b.s.firstLogIndex || a.s.txHash.localeCompare(b.s.txHash))
  type Leg = { i: number; tx: string; ts: number; token: string; raw: bigint; side: 'buy' | 'sell'; quoteRaw: bigint | null; source: string; canonical: boolean; dup: boolean }
  const legs: Leg[] = []
  const quoteOnly: typeof ordered = []
  const seen = new Set<string>()
  for (const { s, source, canonical } of ordered) {
    const inQ = input.isQuote(s.inputToken)
    const outQ = input.isQuote(s.outputToken)
    if (inQ && outQ) { quoteOnly.push({ s, source, canonical }); continue }
    const push = (token: string, raw: bigint, side: 'buy' | 'sell', quoteRaw: bigint | null) => {
      const key = `${lower(s.txHash)}|${lower(token)}|${side}|${raw}`
      const dup = seen.has(key)
      seen.add(key)
      legs.push({ i: legs.length, tx: lower(s.txHash), ts: s.timestampSec, token: lower(token), raw, side, quoteRaw, source, canonical, dup })
    }
    if (!inQ) push(s.inputToken, s.inputRaw, 'sell', outQ ? s.outputRaw : null)
    if (!outQ) push(s.outputToken, s.outputRaw, 'buy', inQ ? s.inputRaw : null)
  }
  // Independent FIFO on raw integers (dupes excluded, like the engine's exact-key merge).
  const live = legs.filter((l) => !l.dup)
  const lots = new Map<string, Array<{ leg: Leg; left: bigint }>>()
  for (const l of live.filter((x) => x.side === 'buy').sort((a, b) => a.ts - b.ts || a.i - b.i)) {
    const q = lots.get(l.token) ?? []
    q.push({ leg: l, left: l.raw })
    lots.set(l.token, q)
  }
  const sim = new Map<number, { matched: bigint; against: string[]; consumed: bigint }>()
  const get = (i: number) => { const v = sim.get(i) ?? { matched: ZERO, against: [], consumed: ZERO }; sim.set(i, v); return v }
  for (const sell of live.filter((x) => x.side === 'sell').sort((a, b) => a.ts - b.ts || a.i - b.i)) {
    let need = sell.raw
    for (const lot of lots.get(sell.token) ?? []) {
      if (need <= ZERO) break
      if (lot.leg.i > sell.i) break // chronology guard: engine order (timestamp, block, log index), not whole seconds
      if (lot.left <= ZERO) continue
      const take = lot.left < need ? lot.left : need
      lot.left -= take
      need -= take
      const sr = get(sell.i); sr.matched += take; sr.against.push(lot.leg.tx)
      const br = get(lot.leg.i); br.consumed += take; br.against.push(sell.tx)
    }
  }
  const lotsFor = (tx: string, side: 'buy' | 'sell', token: string) => input.matchedLots.filter((l) => lower(l.token) === token && lower(side === 'sell' ? l.closedTxHash : l.openedTxHash) === tx)
  const priced = (tx: string) => ev.get(tx)?.bothLegsVerified === true

  const rows: RhVerifiedSwapFifoRow[] = legs.map((l) => {
    const e = ev.get(l.tx)
    const r = sim.get(l.i) ?? { matched: ZERO, against: [], consumed: ZERO }
    const actual = lotsFor(l.tx, l.side, l.token)
    const tokenPriceUsd = e ? (l.side === 'sell' ? e.inputPriceUsd : e.outputPriceUsd) : null
    const nativePriceUsd = e ? (l.side === 'sell' ? e.outputPriceUsd : e.inputPriceUsd) : null
    const sameToken = live.filter((x) => x.token === l.token)
    const earlierBuys = sameToken.filter((x) => x.side === 'buy' && x.i < l.i && x.tx !== l.tx)
    const laterSells = sameToken.filter((x) => x.side === 'sell' && x.i > l.i && x.tx !== l.tx)
    // Token identity: the engine keys lots by chain + LOWERCASE contract, so checksum vs lowercase never splits a
    // token. token_key_mismatch is reserved for a leg whose lowercase key differs from the engine's (none today).
    let blocker: RhVerifiedFifoBlocker
    if (l.dup) blocker = 'duplicate_or_deduped_swap'
    else if (l.side === 'sell') {
      if (r.matched > ZERO && actual.length === 0) blocker = 'ordering_issue' // simulation closes, engine did not
      else if (r.matched > ZERO) {
        const unpricedLot = actual.some((a) => a.evidenceQuality !== 'verified')
        blocker = !unpricedLot ? (r.matched < l.raw ? 'insufficient_verified_buy_quantity' : 'none')
          : !priced(l.tx) ? 'missing_sell_price' : actual.some((a) => !priced(lower(a.openedTxHash))) ? 'missing_buy_price' : 'pricing_gate'
      } else if (earlierBuys.length > 0) blocker = 'buy_quantity_already_consumed'
      else if (sameToken.some((x) => x.side === 'buy')) blocker = 'buy_after_sell'
      else blocker = 'no_earlier_verified_buy'
    } else {
      if (r.consumed > ZERO && actual.length === 0) blocker = 'ordering_issue'
      else if (r.consumed > ZERO) {
        const unpricedLot = actual.some((a) => a.evidenceQuality !== 'verified')
        blocker = !unpricedLot ? 'none' : !priced(l.tx) ? 'missing_buy_price' : actual.some((a) => !priced(lower(a.closedTxHash))) ? 'missing_sell_price' : 'pricing_gate'
      } else if (laterSells.length > 0) blocker = 'sell_quantity_already_consumed'
      else blocker = 'no_later_verified_sell'
    }
    return {
      txHash: l.tx, timestamp: l.ts, token: l.token, normalizedTokenKey: `${input.chain}:${l.token}`, side: l.side,
      verifiedRaw: l.raw.toString(), nativeRaw: l.quoteRaw?.toString() ?? null, tokenRaw: l.raw.toString(),
      verificationSource: l.source, attributionClass: input.attributionByTx?.get(l.tx) ?? null, inCanonicalCount: l.canonical,
      bothLegPriced: priced(l.tx), tokenPriceUsd, nativePriceUsd,
      fifoEligibleBeforePricing: !l.dup, fifoEligibleAfterPricing: !l.dup && priced(l.tx),
      fifoInputIndex: l.dup ? null : live.indexOf(l),
      matchedAgainstTxHashes: [...new Set(r.against)],
      matchedRaw: (l.side === 'sell' ? r.matched : r.consumed).toString(),
      unmatchedRaw: (l.raw - (l.side === 'sell' ? r.matched : r.consumed)).toString(),
      openLotRawCreated: l.side === 'buy' && !l.dup ? l.raw.toString() : '0',
      openLotRawConsumed: l.side === 'buy' ? r.consumed.toString() : '0',
      actualLotCount: actual.length, actualVerifiedLotCount: actual.filter((a) => a.evidenceQuality === 'verified').length,
      ...(l.side === 'sell' ? { earlierVerifiedBuys: earlierBuys.map((b) => ({ txHash: b.tx, raw: b.raw.toString(), timestamp: b.ts })) } : {}),
      exactFifoBlocker: blocker,
    }
  })
  for (const { s, source, canonical } of quoteOnly) {
    rows.push({
      txHash: lower(s.txHash), timestamp: s.timestampSec, token: null, normalizedTokenKey: null, side: 'quote_only', verifiedRaw: null,
      nativeRaw: s.inputRaw.toString(), tokenRaw: null, verificationSource: source, attributionClass: input.attributionByTx?.get(lower(s.txHash)) ?? null,
      inCanonicalCount: canonical, bothLegPriced: priced(lower(s.txHash)), tokenPriceUsd: null, nativePriceUsd: null,
      fifoEligibleBeforePricing: false, fifoEligibleAfterPricing: false, fifoInputIndex: null, matchedAgainstTxHashes: [], matchedRaw: '0', unmatchedRaw: '0',
      openLotRawCreated: '0', openLotRawConsumed: '0', actualLotCount: 0, actualVerifiedLotCount: 0, exactFifoBlocker: 'excluded_by_fifo_source_filter',
    })
  }

  const tokens: RhVerifiedFifoTokenGroup[] = [...new Set(live.map((l) => l.token))].sort().map((token) => {
    const buys = live.filter((l) => l.token === token && l.side === 'buy')
    const sells = live.filter((l) => l.token === token && l.side === 'sell')
    const matchable = sells.reduce((t, s) => t + (sim.get(s.i)?.matched ?? ZERO), ZERO)
    const actual = input.matchedLots.filter((l) => lower(l.token) === token)
    const ts = (xs: typeof buys, f: 'min' | 'max') => (xs.length ? Math[f](...xs.map((x) => x.ts)) : null)
    const defect = matchable > ZERO && actual.length === 0
    const tokenRows = rows.filter((r) => r.token === token && r.side === 'sell')
    const blocker: RhVerifiedFifoBlocker = defect ? 'ordering_issue'
      : sells.length === 0 ? 'no_later_verified_sell'
      : buys.length === 0 ? 'no_earlier_verified_buy'
      : tokenRows.find((r) => r.exactFifoBlocker !== 'none')?.exactFifoBlocker ?? 'none'
    return {
      token, normalizedTokenKey: `${input.chain}:${token}`,
      verifiedBuyCount: buys.length, verifiedSellCount: sells.length,
      verifiedBuyRaw: buys.reduce((t, b) => t + b.raw, ZERO).toString(), verifiedSellRaw: sells.reduce((t, s) => t + s.raw, ZERO).toString(),
      earliestVerifiedBuyTs: ts(buys, 'min'), latestVerifiedBuyTs: ts(buys, 'max'), earliestVerifiedSellTs: ts(sells, 'min'), latestVerifiedSellTs: ts(sells, 'max'),
      buyBeforeSellExists: buys.some((b) => sells.some((s) => b.i < s.i)),
      bothSidesPriced: buys.some((b) => priced(b.tx)) && sells.some((s) => priced(s.tx)),
      fifoMatchableRaw: matchable.toString(),
      actualClosedAmount: actual.reduce((t, l) => t + l.amount, 0), closedLotCount: actual.length,
      verifiedClosedLotCount: actual.filter((l) => l.evidenceQuality === 'verified').length,
      definiteFifoDefect: defect, blocker,
    }
  })

  const canonicalRows = rows.filter((r) => r.inCanonicalCount)
  const buyRows = canonicalRows.filter((r) => r.side === 'buy')
  const sellRows = canonicalRows.filter((r) => r.side === 'sell')
  const defect = tokens.some((t) => t.definiteFifoDefect)
  const coverage = input.historyCoverage ?? { status: 'unknown' as const, reasons: ['history_coverage_not_provided'] }
  const closed = input.matchedLots.length
  const verifiedClosed = input.matchedLots.filter((l) => l.evidenceQuality === 'verified').length
  return {
    rows, tokens,
    summary: {
      verifiedSwapCount: input.canonicalSwaps.length, verifiedBuyCount: buyRows.length, verifiedSellCount: sellRows.length,
      distinctVerifiedTokens: new Set(canonicalRows.map((r) => r.token).filter(Boolean)).size,
      tokensWithBothVerifiedBuyAndSell: tokens.filter((t) => t.verifiedBuyCount > 0 && t.verifiedSellCount > 0).length,
      tokensWithBuyBeforeSell: tokens.filter((t) => t.buyBeforeSellExists).length,
      bothLegPricedBuyCount: buyRows.filter((r) => r.bothLegPriced).length, bothLegPricedSellCount: sellRows.filter((r) => r.bothLegPriced).length,
      fifoEligibleBuyCount: buyRows.filter((r) => r.fifoEligibleBeforePricing).length, fifoEligibleSellCount: sellRows.filter((r) => r.fifoEligibleBeforePricing).length,
      theoreticalMatchableRawByToken: Object.fromEntries(tokens.filter((t) => t.fifoMatchableRaw !== '0').map((t) => [t.token, t.fifoMatchableRaw])),
      actualClosedLotCount: closed, actualVerifiedClosedLotCount: verifiedClosed,
      actualClosedAmountByToken: Object.fromEntries(tokens.filter((t) => t.closedLotCount > 0).map((t) => [t.token, t.actualClosedAmount])),
      unmatchedVerifiedBuyCount: buyRows.filter((r) => r.unmatchedRaw !== '0').length,
      unmatchedVerifiedSellCount: sellRows.filter((r) => r.unmatchedRaw !== '0').length,
      verifiedSellsWithNoEarlierVerifiedBuy: sellRows.filter((r) => r.exactFifoBlocker === 'no_earlier_verified_buy' || r.exactFifoBlocker === 'buy_after_sell').length,
      verifiedPairsBlockedByPricing: rows.filter((r) => r.side === 'sell' && ['missing_buy_price', 'missing_sell_price', 'pricing_gate'].includes(r.exactFifoBlocker)).length,
      verifiedPairsBlockedByTokenKeyMismatch: rows.filter((r) => r.exactFifoBlocker === 'token_key_mismatch').length,
      verifiedPairsBlockedByOrdering: rows.filter((r) => r.exactFifoBlocker === 'ordering_issue').length,
      verifiedPairsExcludedBeforeFifo: rows.filter((r) => r.exactFifoBlocker === 'excluded_by_fifo_source_filter' || r.exactFifoBlocker === 'duplicate_or_deduped_swap').length,
      definiteFifoDefect: defect,
      conclusion: defect ? 'fifo_defect'
        : closed === 0
          ? (coverage.status === 'complete' ? 'zero_closed_lots_correct_no_overlap'
            : coverage.status === 'incomplete' ? 'zero_closed_lots_no_overlap_in_sample_coverage_incomplete'
            : 'zero_closed_lots_no_overlap_in_sample_coverage_unknown')
          : verifiedClosed === 0 ? 'closed_lots_exist_but_unpriced' : 'closed_lots_exist',
      historyCoverage: coverage.status,
      historyCoverageReasons: coverage.reasons,
    },
  }
}
