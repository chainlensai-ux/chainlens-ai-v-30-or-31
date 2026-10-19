// Lot price outlier guard: keeps an impossible per-trade price out of realized PnL.
//
// Confirmed production case: a same-transaction stablecoin quote paired $24 of USDC with a dust
// 0.00004-token leg, deriving $603,963 per token; replayed across the wallet's real-sized sells it
// published $236B of realized PnL. No single derivation step can see that the number is absurd, but
// the scan as a whole can: every other trade of that token prices it orders of magnitude lower.
//
// A transaction side is an outlier when either
//   1. its per-unit price is more than OUTLIER_FACTOR away (either direction) from the median
//      per-unit price of that token's other priced sides (needs MIN_TOKEN_SAMPLES distinct sides), or
//   2. its USD value exceeds both WALLET_VALUE_FLOOR_USD and OUTLIER_FACTOR times the wallet's median
//      side value — catches a bad price on a token too thinly traded for check 1.
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
  reason: 'token_price_outlier' | 'wallet_value_outlier'
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
        samples.set(key, { key, tokenKey: `${lot.chain}:${lot.token.toLowerCase()}`, perUnitUsd: usd / lot.amount, valueUsd: usd, amount: lot.amount })
      }
    }
  }
  return samples
}

type PriceSample = { key: string; tokenKey: string; perUnitUsd: number; valueUsd: number }
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
  const tokenMedian = new Map<string, number>()
  for (const [tokenKey, prices] of byToken) if (prices.length >= LOT_PRICE_OUTLIER_MIN_TOKEN_SAMPLES) tokenMedian.set(tokenKey, median(prices))
  const walletMedianValueUsd = median(all.map((s) => s.valueUsd))
  for (const sample of all) {
    const reference = tokenMedian.get(sample.tokenKey) ?? null
    const factor = isMajorTokenKey(sample.tokenKey) ? LOT_PRICE_MAJOR_OUTLIER_FACTOR : LOT_PRICE_OUTLIER_FACTOR
    if (reference !== null && reference > 0
      && (sample.perUnitUsd > reference * factor || sample.perUnitUsd < reference / factor)) {
      verdicts.set(sample.key, { reason: 'token_price_outlier', tokenMedianPerUnitUsd: reference })
    } else if (sample.valueUsd > LOT_PRICE_OUTLIER_WALLET_VALUE_FLOOR_USD && sample.valueUsd > walletMedianValueUsd * LOT_PRICE_OUTLIER_FACTOR) {
      verdicts.set(sample.key, { reason: 'wallet_value_outlier', tokenMedianPerUnitUsd: reference })
    }
  }
  return verdicts
}

export function demotePriceOutlierLots(lots: readonly MatchedLot[]): LotPriceOutlierResult {
  const samples = collectSideSamples(lots)
  const verdicts = detectPriceOutliers(samples.values())
  if (verdicts.size === 0) return { lots: [...lots], demotedLotCount: 0, outliers: [] }
  const outliers: LotPriceOutlier[] = []
  for (const [key, verdict] of verdicts) {
    const sample = samples.get(key)!
    const [chain, token, txHash, side] = key.split(':')
    outliers.push({ chain, token, txHash, side: side as Side, perUnitUsd: sample.perUnitUsd, tokenMedianPerUnitUsd: verdict.tokenMedianPerUnitUsd, valueUsd: sample.valueUsd, reason: verdict.reason })
  }
  let demotedLotCount = 0
  const guarded = lots.map((lot) => {
    if (!isCanonicalVerifiedPublishedLot(lot)) return lot
    if (!verdicts.has(sideKey(lot, 'entry')) && !verdicts.has(sideKey(lot, 'exit'))) return lot
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
export function guardPriceUsdLookup(events: readonly NormalizedEvent[], lookup: PriceUsdLookup): { lookup: PriceUsdLookup; rejectedEvents: number; rejectedValueUsd: number } {
  const samples = new Map<string, PriceSample>()
  for (const event of events) {
    if (!(event.amount > 0) || !Number.isFinite(event.amount)) continue
    const key = eventKey(event)
    if (samples.has(key)) continue
    const usd = lookup(event)
    if (!isCanonicalPositiveUsd(usd)) continue
    samples.set(key, { key, tokenKey: `${event.chain}:${event.contract.toLowerCase()}`, perUnitUsd: usd / event.amount, valueUsd: usd })
  }
  const verdicts = detectPriceOutliers(samples.values())
  let rejectedValueUsd = 0
  for (const key of verdicts.keys()) rejectedValueUsd += samples.get(key)!.valueUsd
  return {
    lookup: verdicts.size === 0 ? lookup : (event) => (verdicts.has(eventKey(event)) ? null : lookup(event)),
    rejectedEvents: verdicts.size,
    rejectedValueUsd,
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
