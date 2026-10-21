// Lot price outlier guard: keeps an impossible per-trade price out of realized PnL.
//
// Confirmed production case: a same-transaction stablecoin quote paired $24 of USDC with a dust
// 0.00004-token leg, deriving $603,963 per token; replayed across the wallet's real-sized sells it
// published $236B of realized PnL. No single derivation step can see that the number is absurd, but
// the scan as a whole can: every other trade of that token prices it orders of magnitude lower.
//
// A transaction side is an outlier when either
//   1. its per-unit price is more than OUTLIER_FACTOR away (either direction) from the median
//      per-unit price of that token's other priced sides (needs MIN_TOKEN_SAMPLES distinct sides),
//   2. its per-unit price is more than LOCAL_OUTLIER_FACTOR away from the median of that token's
//      other sides within LOCAL_WINDOW_MS of it, or DAY_OUTLIER_FACTOR away from those within
//      DAY_WINDOW_MS (each needs LOCAL_MIN_NEIGHBORS sides), or more than TIGHT_BAND_DEVIATION
//      outside a same-hour band its neighbours all agree on within TIGHT_BAND_MAX_SPREAD, or more
//      than ANCHORED_DAY_OUTLIER_FACTOR from the same-day median of a token anchored to one price, or
//   3. its USD value exceeds both WALLET_VALUE_FLOOR_USD and OUTLIER_FACTOR times the wallet's median
//      side value — catches a bad price on a token too thinly traded for check 1.
// Reconciled lots are also checked one at a time (lotLevelOutlierReason): a lot whose proceeds are
// more than LOT_RETURN_OUTLIER_FACTOR times its cost, or a same-transaction dust leg.
// Applied twice: to FIFO's per-event USD lookup (guardPriceUsdLookup), so an outlier price never
// becomes a lot's cost basis or proceeds — realized or unrealized — and to the reconciled lots
// (demotePriceOutlierLots), which catches outliers re-entering from stored accepted evidence. A demoted
// lot is 'unpriced' (the convention demoteLotsOnIncompleteAcceptedSides uses): never summed into
// realized PnL, never seeded as accepted evidence. Nothing is repriced or invented.

import type { MatchedLot, PriceUsdLookup } from '../modules/fifoEngine/types'
import type { NormalizedEvent } from '../modules/normalization/types'
import { isCanonicalPositiveUsd, isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot'
import { isMajorVolatileToken } from './majorMarketPrice'

export const LOT_PRICE_OUTLIER_FACTOR = 1_000
export const LOT_PRICE_OUTLIER_MIN_TOKEN_SAMPLES = 3
export const LOT_PRICE_OUTLIER_WALLET_VALUE_FLOOR_USD = 1_000_000
// Majors (ETH/WETH, cbBTC) never move 1.5x inside a scan window. Production showed WETH sides at $330
// and $730 and cbBTC at $27.8k next to a $2,409 / $81.5k median — liquidity legs and split side values
// a 1000x band can never catch.
export const LOT_PRICE_MAJOR_OUTLIER_FACTOR = 1.5
// A whole-window median has to tolerate a token's real moves, so its band is wide. Trades hours apart
// do not need that room: production published a CHIP sell at $0.0064 between sides of the same
// token at ~$0.04 within the same few hours (a stored side value spread over ~6x too many tokens),
// turning one round trip into a -$1,377 loss.
export const LOT_PRICE_LOCAL_OUTLIER_FACTOR = 5
export const LOT_PRICE_LOCAL_WINDOW_MS = 60 * 60 * 1000
export const LOT_PRICE_LOCAL_MIN_NEIGHBORS = 3
// A thinly traded token rarely has three trades inside the hour. Production then published a VIRTUAL
// sell at $0.00085 (~780x under its $0.66 trades that day), a DRB sell 30x under the buy 3 minutes
// earlier and an AAPLc buy at $28.64 between same-day sides at $200-$342. Same-day trades get a
// wider band than same-hour ones, but far tighter than the whole window's.
export const LOT_PRICE_DAY_OUTLIER_FACTOR = 10
// A token whose other sides within the hour all sit inside a TIGHT band (max/min <= this) is trading
// at a known price; one side more than LOT_PRICE_TIGHT_BAND_DEVIATION outside that band is a bad side
// value, not a move. Production published a tokenized-stock buy at $234.69 36 seconds before a sell
// at $342.71, while every sell of that token that hour was $342.68-$342.78; the 5x hourly band never
// sees a 1.46x gap. A volatile token's neighbours are not this tight, so it is never judged by it.
// The band is judged around the neighbours' median and only needs most of them inside it: the same
// token's hour also held one sell at ~$398, which made max/min 1.16 and hid the $234.69 buy.
export const LOT_PRICE_TIGHT_BAND_MAX_SPREAD = 1.05
export const LOT_PRICE_TIGHT_BAND_MIN_SHARE = 0.75
export const LOT_PRICE_TIGHT_BAND_DEVIATION = 1.25
// Majors skip the meme-sized local bands, but their whole-window 1.5x band still let production
// publish WETH sides at $1,774 and $1,797 between same-day sides at ~$2,400 (+$130.81 on a 94-second
// round trip). ETH and BTC never move 10% inside an hour or 20% inside a day of one wallet's trades.
export const LOT_PRICE_MAJOR_LOCAL_OUTLIER_FACTOR = 1.1
export const LOT_PRICE_MAJOR_DAY_OUTLIER_FACTOR = 1.2
export const LOT_PRICE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000
// A token whose sides keep landing within ANCHORED_MAX_SPREAD of one price, again and again over
// hours, trades like a stock, not a meme: the tight band needs three neighbours inside one hour,
// which a thinly traded tokenized stock rarely has. Production published that stock's buys at
// $200.38, $210.49 and $270.05 and a sell at $424.66 one minute after two $1,000 USDC sells at
// $342.71, while five of its sides sat at $338-$343 across 32 hours: +$334 of fake profit. Such a
// token gets a same-day band as narrow as a major's.
export const LOT_PRICE_ANCHORED_MAX_SPREAD = 1.02
export const LOT_PRICE_ANCHORED_MIN_SAMPLES = 4
export const LOT_PRICE_ANCHORED_MIN_SPAN_MS = 6 * 60 * 60 * 1000
export const LOT_PRICE_ANCHORED_DAY_OUTLIER_FACTOR = 1.2
// A single lot returning more than this multiple of its own cost basis is a bad price on one side,
// not a trade: production published a lot bought for $3.9e-14 and sold for $70 (a 1.8e15x return)
// on a token with too few trades for the per-token median check.
export const LOT_RETURN_OUTLIER_FACTOR = 10_000
// A lot opened and closed in the same transaction with both sides under this USD value is a dust
// leg passing through the wallet (router leftovers, refunds), not a trade.
export const SAME_TX_DUST_LOT_USD = 0.01

function isMajorTokenKey(tokenKey: string): boolean {
  const [chain, token] = tokenKey.split(':')
  return isMajorVolatileToken(chain, token)
}

type Side = 'entry' | 'exit'
type SideSample = PriceSample

export type LotPriceOutlier = {
  chain: string
  token: string
  txHash: string
  side: Side
  perUnitUsd: number
  tokenMedianPerUnitUsd: number | null
  valueUsd: number
  reason: 'token_price_outlier' | 'token_local_price_outlier' | 'wallet_value_outlier' | 'lot_return_outlier' | 'same_tx_dust_lot' | 'event_price_outlier'
}

export type LotPriceOutlierResult = {
  lots: MatchedLot[]
  demotedLotCount: number
  outliers: LotPriceOutlier[]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function sideKey(lot: MatchedLot, side: Side): string {
  const txHash = side === 'entry' ? lot.openedTxHash : lot.closedTxHash
  return `${lot.chain}:${lot.token.toLowerCase()}:${txHash.toLowerCase()}:${side}`
}

// One sample per transaction side: partial fills of the same side share one price and must not
// outvote the token's other trades. The side's value is the sum over its lots.
function collectSideSamples(lots: readonly MatchedLot[]): Map<string, SideSample> {
  const samples = new Map<string, SideSample & { amount: number }>()
  for (const lot of lots) {
    if (!isCanonicalVerifiedPublishedLot(lot) || !(lot.amount > 0) || !Number.isFinite(lot.amount)) continue
    for (const side of ['entry', 'exit'] as const) {
      const usd = side === 'entry' ? lot.costBasisUsd : lot.proceedsUsd
      if (!isCanonicalPositiveUsd(usd)) continue
      const key = sideKey(lot, side)
      const existing = samples.get(key)
      if (existing) {
        existing.valueUsd += usd
        existing.amount += lot.amount
        existing.perUnitUsd = existing.valueUsd / existing.amount
      } else {
        samples.set(key, {
          key, tokenKey: `${lot.chain}:${lot.token.toLowerCase()}`, perUnitUsd: usd / lot.amount, valueUsd: usd, amount: lot.amount,
          timestampMs: side === 'entry' ? lot.openedAt : lot.closedAt,
        })
      }
    }
  }
  return samples
}

type PriceSample = { key: string; tokenKey: string; perUnitUsd: number; valueUsd: number; timestampMs?: number }
type OutlierVerdict = { reason: LotPriceOutlier['reason']; tokenMedianPerUnitUsd: number | null }

// The shared rule: one median per token (with at least MIN_TOKEN_SAMPLES samples a single bad value
// cannot move it) and one median side value for the whole wallet.
function detectPriceOutliers(samples: Iterable<PriceSample>): Map<string, OutlierVerdict> {
  const all = [...samples]
  const verdicts = new Map<string, OutlierVerdict>()
  if (all.length === 0) return verdicts
  const byToken = new Map<string, number[]>()
  for (const sample of all) {
    const prices = byToken.get(sample.tokenKey)
    if (prices) prices.push(sample.perUnitUsd)
    else byToken.set(sample.tokenKey, [sample.perUnitUsd])
  }
  const bySampleToken = new Map<string, PriceSample[]>()
  for (const sample of all) {
    const list = bySampleToken.get(sample.tokenKey)
    if (list) list.push(sample)
    else bySampleToken.set(sample.tokenKey, [sample])
  }
  const tokenMedian = new Map<string, number>()
  for (const [tokenKey, prices] of byToken) if (prices.length >= LOT_PRICE_OUTLIER_MIN_TOKEN_SAMPLES) tokenMedian.set(tokenKey, median(prices))
  const walletMedianValueUsd = median(all.map((s) => s.valueUsd))
  for (const sample of all) {
    const reference = tokenMedian.get(sample.tokenKey) ?? null
    const major = isMajorTokenKey(sample.tokenKey)
    const factor = major ? LOT_PRICE_MAJOR_OUTLIER_FACTOR : LOT_PRICE_OUTLIER_FACTOR
    const tokenSamples = bySampleToken.get(sample.tokenKey)!
    const local = major ? majorLocalOutlierReference(sample, tokenSamples) : localOutlierReference(sample, tokenSamples)
    if (reference !== null && reference > 0 && outsideBand(sample.perUnitUsd, reference, factor)) {
      verdicts.set(sample.key, { reason: 'token_price_outlier', tokenMedianPerUnitUsd: reference })
    } else if (local !== null) {
      verdicts.set(sample.key, { reason: 'token_local_price_outlier', tokenMedianPerUnitUsd: local })
    } else if (sample.valueUsd > LOT_PRICE_OUTLIER_WALLET_VALUE_FLOOR_USD && sample.valueUsd > walletMedianValueUsd * LOT_PRICE_OUTLIER_FACTOR) {
      verdicts.set(sample.key, { reason: 'wallet_value_outlier', tokenMedianPerUnitUsd: reference })
    }
  }
  return verdicts
}

function outsideBand(perUnitUsd: number, reference: number, factor: number): boolean {
  return perUnitUsd > reference * factor || perUnitUsd < reference / factor
}

// The neighbouring median a sample breaks (same hour first, then same day), or null when it breaks neither.
function localOutlierReference(sample: PriceSample, tokenSamples: readonly PriceSample[]): number | null {
  const tight = tightBandReference(sample, tokenSamples) ?? anchoredBandReference(sample, tokenSamples)
  if (tight !== null) return tight
  for (const [windowMs, factor] of [[LOT_PRICE_LOCAL_WINDOW_MS, LOT_PRICE_LOCAL_OUTLIER_FACTOR], [LOT_PRICE_DAY_WINDOW_MS, LOT_PRICE_DAY_OUTLIER_FACTOR]]) {
    const reference = localMedianPerUnit(sample, tokenSamples, windowMs)
    if (reference !== null && reference > 0 && outsideBand(sample.perUnitUsd, reference, factor)) return reference
  }
  return null
}

// Same-hour and same-day bands for majors, much tighter than the meme-sized ones.
function majorLocalOutlierReference(sample: PriceSample, tokenSamples: readonly PriceSample[]): number | null {
  for (const [windowMs, factor] of [[LOT_PRICE_LOCAL_WINDOW_MS, LOT_PRICE_MAJOR_LOCAL_OUTLIER_FACTOR], [LOT_PRICE_DAY_WINDOW_MS, LOT_PRICE_MAJOR_DAY_OUTLIER_FACTOR]]) {
    const reference = localMedianPerUnit(sample, tokenSamples, windowMs)
    if (reference !== null && reference > 0 && outsideBand(sample.perUnitUsd, reference, factor)) return reference
  }
  return null
}

// The median of the token's other same-hour sides when most of them sit within the tight band around
// it and this side falls well outside; null otherwise.
function tightBandReference(sample: PriceSample, tokenSamples: readonly PriceSample[]): number | null {
  const prices = neighbourPrices(sample, tokenSamples, LOT_PRICE_LOCAL_WINDOW_MS)
  if (prices === null || prices.length < LOT_PRICE_LOCAL_MIN_NEIGHBORS) return null
  const reference = median(prices)
  if (!(reference > 0)) return null
  const inside = prices.filter((price) => !outsideBand(price, reference, LOT_PRICE_TIGHT_BAND_MAX_SPREAD)).length
  if (inside < prices.length * LOT_PRICE_TIGHT_BAND_MIN_SHARE) return null
  return outsideBand(sample.perUnitUsd, reference, LOT_PRICE_TIGHT_BAND_DEVIATION) ? reference : null
}

// The token's same-day median when the token is price-anchored around it (MIN_SAMPLES of its other
// sides within ANCHORED_MAX_SPREAD of that median, spread over MIN_SPAN_MS) and this side falls more
// than ANCHORED_DAY_OUTLIER_FACTOR away from it; null otherwise.
function anchoredBandReference(sample: PriceSample, tokenSamples: readonly PriceSample[]): number | null {
  const reference = localMedianPerUnit(sample, tokenSamples, LOT_PRICE_DAY_WINDOW_MS)
  if (reference === null || !(reference > 0) || !outsideBand(sample.perUnitUsd, reference, LOT_PRICE_ANCHORED_DAY_OUTLIER_FACTOR)) return null
  let count = 0
  let first = Infinity
  let last = -Infinity
  for (const other of tokenSamples) {
    if (other.key === sample.key || other.timestampMs === undefined || !Number.isFinite(other.timestampMs)) continue
    if (outsideBand(other.perUnitUsd, reference, LOT_PRICE_ANCHORED_MAX_SPREAD)) continue
    count += 1
    first = Math.min(first, other.timestampMs)
    last = Math.max(last, other.timestampMs)
  }
  return count >= LOT_PRICE_ANCHORED_MIN_SAMPLES && last - first >= LOT_PRICE_ANCHORED_MIN_SPAN_MS ? reference : null
}

function neighbourPrices(sample: PriceSample, tokenSamples: readonly PriceSample[], windowMs: number): number[] | null {
  const at = sample.timestampMs
  if (at === undefined || !Number.isFinite(at)) return null
  const prices: number[] = []
  for (const other of tokenSamples) {
    if (other.key === sample.key || other.timestampMs === undefined || !Number.isFinite(other.timestampMs)) continue
    if (Math.abs(other.timestampMs - at) <= windowMs) prices.push(other.perUnitUsd)
  }
  return prices
}

// Median per-unit price of the token's other sides within windowMs, or null without enough of them.
function localMedianPerUnit(sample: PriceSample, tokenSamples: readonly PriceSample[], windowMs: number): number | null {
  const prices = neighbourPrices(sample, tokenSamples, windowMs)
  return prices !== null && prices.length >= LOT_PRICE_LOCAL_MIN_NEIGHBORS ? median(prices) : null
}

// Checks one lot on its own, no other trades needed: an impossible return, or a same-transaction
// dust leg. Only called on canonically verified lots, so both sides are positive and finite.
function lotLevelOutlierReason(lot: MatchedLot): 'lot_return_outlier' | 'same_tx_dust_lot' | null {
  const cost = lot.costBasisUsd as number
  const proceeds = lot.proceedsUsd as number
  if (proceeds > cost * LOT_RETURN_OUTLIER_FACTOR) return 'lot_return_outlier'
  if (lot.openedTxHash.toLowerCase() === lot.closedTxHash.toLowerCase() && cost < SAME_TX_DUST_LOT_USD && proceeds < SAME_TX_DUST_LOT_USD) return 'same_tx_dust_lot'
  return null
}

// `rejectedSideKeys` are the sides guardPriceUsdLookup already rejected at event level, where it
// saw every trade of the token. Recovery and stored accepted evidence can price such a side again
// after FIFO (production: a $0.068 entry the event guard rejected came back from accepted evidence
// and published +$30 of a $57 total); the lot-level check alone sees too few trades to catch it.
export function demotePriceOutlierLots(
  lots: readonly MatchedLot[],
  options: { rejectedSideKeys?: ReadonlySet<string> } = {},
): LotPriceOutlierResult {
  const samples = collectSideSamples(lots)
  const verdicts = detectPriceOutliers(samples.values())
  for (const key of options.rejectedSideKeys ?? []) {
    if (samples.has(key) && !verdicts.has(key)) verdicts.set(key, { reason: 'event_price_outlier', tokenMedianPerUnitUsd: null })
  }
  const outliers: LotPriceOutlier[] = []
  for (const [key, verdict] of verdicts) {
    const sample = samples.get(key)!
    const [chain, token, txHash, side] = key.split(':')
    outliers.push({ chain, token, txHash, side: side as Side, perUnitUsd: sample.perUnitUsd, tokenMedianPerUnitUsd: verdict.tokenMedianPerUnitUsd, valueUsd: sample.valueUsd, reason: verdict.reason })
  }
  let demotedLotCount = 0
  const guarded = lots.map((lot) => {
    if (!isCanonicalVerifiedPublishedLot(lot)) return lot
    const lotReason = lotLevelOutlierReason(lot)
    if (lotReason) {
      outliers.push({
        chain: lot.chain, token: lot.token.toLowerCase(), txHash: lot.closedTxHash.toLowerCase(), side: 'exit',
        perUnitUsd: lot.amount > 0 ? (lot.proceedsUsd as number) / lot.amount : 0, tokenMedianPerUnitUsd: null,
        valueUsd: lot.proceedsUsd as number, reason: lotReason,
      })
    } else if (!verdicts.has(sideKey(lot, 'entry')) && !verdicts.has(sideKey(lot, 'exit'))) {
      return lot
    }
    demotedLotCount += 1
    return { ...lot, evidenceQuality: 'unpriced' as const }
  })
  return { lots: guarded, demotedLotCount, outliers }
}

const eventKey = (event: NormalizedEvent) =>
  `${event.chain}:${event.contract.toLowerCase()}:${event.txHash.toLowerCase()}:${event.direction}:${event.amount}`

/**
 * The same rule applied to FIFO's per-event USD lookup, before any lot is built: an event whose USD
 * value is an outlier for its token (or the wallet) reads as unpriced, so it can reach neither
 * realized nor unrealized PnL. `events` is every event FIFO will look up; others pass through.
 */
// A rejected ETH/WETH/cbBTC side is the value of a known amount of a major asset, so when the scan
// holds that asset's market price within an hour of the trade (majorMarketValueUsd) the side reads
// amount x market price instead of nothing. Every other rejected side stays unpriced.
export function guardPriceUsdLookup(
  events: readonly NormalizedEvent[],
  lookup: PriceUsdLookup,
  options: { majorMarketValueUsd?: (event: NormalizedEvent) => number | null } = {},
): { lookup: PriceUsdLookup; rejectedEvents: number; rejectedValueUsd: number; repricedMajorEvents: number; rejectedSideKeys: Set<string> } {
  const samples = new Map<string, PriceSample>()
  for (const event of events) {
    if (!(event.amount > 0) || !Number.isFinite(event.amount)) continue
    const key = eventKey(event)
    if (samples.has(key)) continue
    const usd = lookup(event)
    if (!isCanonicalPositiveUsd(usd)) continue
    samples.set(key, {
      key, tokenKey: `${event.chain}:${event.contract.toLowerCase()}`, perUnitUsd: usd / event.amount, valueUsd: usd,
      timestampMs: Date.parse(event.timestamp),
    })
  }
  const verdicts = detectPriceOutliers(samples.values())
  let rejectedValueUsd = 0
  for (const key of verdicts.keys()) rejectedValueUsd += samples.get(key)!.valueUsd
  const repriced = new Map<string, number>()
  if (options.majorMarketValueUsd) {
    for (const event of events) {
      const key = eventKey(event)
      if (!verdicts.has(key) || repriced.has(key) || !isMajorVolatileToken(event.chain, event.contract)) continue
      const usd = options.majorMarketValueUsd(event)
      if (isCanonicalPositiveUsd(usd)) repriced.set(key, usd)
    }
  }
  // Lot side keys (sideKey's format) of the events that stay rejected: inbound legs are entries,
  // outbound legs exits. Repriced major sides are priced, not rejected.
  const rejectedSideKeys = new Set<string>()
  for (const event of events) {
    const key = eventKey(event)
    if (!verdicts.has(key) || repriced.has(key) || event.direction === 'unknown') continue
    rejectedSideKeys.add(`${event.chain}:${event.contract.toLowerCase()}:${event.txHash.toLowerCase()}:${event.direction === 'inbound' ? 'entry' : 'exit'}`)
  }
  return {
    rejectedSideKeys,
    lookup: verdicts.size === 0 ? lookup : (event) => {
      const key = eventKey(event)
      if (!verdicts.has(key)) return lookup(event)
      return repriced.get(key) ?? null
    },
    rejectedEvents: verdicts.size - repriced.size,
    rejectedValueUsd,
    repricedMajorEvents: repriced.size,
  }
}

/** A lot below this share of its transaction side's total quantity carries no meaningful value. */
export const NEGLIGIBLE_LOT_SHARE = 1e-6

/**
 * Indexes of unpriced lots too small to matter on any side they share: a 1e-12-token "refund" leg in
 * a liquidity transaction, priced out by the outlier guard, must not demote the dozens of real lots
 * that close against the same sell. Its share of every side's allocation is effectively zero, so
 * leaving it out of the shared-side completeness rule changes no published total.
 */
export function negligibleUnpricedLotIndexes(lots: readonly MatchedLot[]): Set<number> {
  const quantityBySide = new Map<string, number>()
  const add = (key: string, amount: number) => quantityBySide.set(key, (quantityBySide.get(key) ?? 0) + amount)
  for (const lot of lots) {
    if (!(lot.amount > 0)) continue
    add(sideKey(lot, 'entry'), lot.amount)
    add(sideKey(lot, 'exit'), lot.amount)
  }
  const negligible = new Set<number>()
  lots.forEach((lot, index) => {
    if (isCanonicalVerifiedPublishedLot(lot)) return
    const largestSide = Math.max(quantityBySide.get(sideKey(lot, 'entry')) ?? 0, quantityBySide.get(sideKey(lot, 'exit')) ?? 0)
    if (largestSide > 0 && lot.amount <= largestSide * NEGLIGIBLE_LOT_SHARE) negligible.add(index)
  })
  return negligible
}
