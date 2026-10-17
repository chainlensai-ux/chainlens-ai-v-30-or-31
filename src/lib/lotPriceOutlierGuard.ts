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
// Every verified lot on an outlier side is demoted to 'unpriced' (the same convention
// demoteLotsOnIncompleteAcceptedSides uses), so it is neither summed into realized PnL nor seeded as
// accepted evidence. Values are left untouched for diagnostics; nothing is repriced or invented.

import type { MatchedLot } from '../modules/fifoEngine/types'
import { isCanonicalPositiveUsd, isCanonicalVerifiedPublishedLot } from './canonicalVerifiedLot'

export const LOT_PRICE_OUTLIER_FACTOR = 1_000
export const LOT_PRICE_OUTLIER_MIN_TOKEN_SAMPLES = 3
export const LOT_PRICE_OUTLIER_WALLET_VALUE_FLOOR_USD = 1_000_000

type Side = 'entry' | 'exit'
type SideSample = { key: string; tokenKey: string; perUnitUsd: number; valueUsd: number }

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

export function demotePriceOutlierLots(lots: readonly MatchedLot[]): LotPriceOutlierResult {
  const samples = collectSideSamples(lots)
  if (samples.size === 0) return { lots: [...lots], demotedLotCount: 0, outliers: [] }

  const byToken = new Map<string, SideSample[]>()
  for (const sample of samples.values()) byToken.set(sample.tokenKey, [...(byToken.get(sample.tokenKey) ?? []), sample])
  const walletMedianValueUsd = median([...samples.values()].map((s) => s.valueUsd))

  const outlierKeys = new Set<string>()
  const outliers: LotPriceOutlier[] = []
  for (const sample of samples.values()) {
    const tokenSamples = byToken.get(sample.tokenKey) ?? []
    // Median of the token's OTHER sides, so a single bad side cannot drag its own reference.
    const others = tokenSamples.filter((s) => s.key !== sample.key).map((s) => s.perUnitUsd)
    const tokenMedian = tokenSamples.length >= LOT_PRICE_OUTLIER_MIN_TOKEN_SAMPLES ? median(others) : null
    let reason: LotPriceOutlier['reason'] | null = null
    if (tokenMedian !== null
      && (sample.perUnitUsd > tokenMedian * LOT_PRICE_OUTLIER_FACTOR || sample.perUnitUsd < tokenMedian / LOT_PRICE_OUTLIER_FACTOR)) {
      reason = 'token_price_outlier'
    } else if (sample.valueUsd > LOT_PRICE_OUTLIER_WALLET_VALUE_FLOOR_USD && sample.valueUsd > walletMedianValueUsd * LOT_PRICE_OUTLIER_FACTOR) {
      reason = 'wallet_value_outlier'
    }
    if (!reason) continue
    outlierKeys.add(sample.key)
    const [chain, token, txHash, side] = sample.key.split(':')
    outliers.push({ chain, token, txHash, side: side as Side, perUnitUsd: sample.perUnitUsd, tokenMedianPerUnitUsd: tokenMedian, valueUsd: sample.valueUsd, reason })
  }
  if (outlierKeys.size === 0) return { lots: [...lots], demotedLotCount: 0, outliers: [] }

  let demotedLotCount = 0
  const guarded = lots.map((lot) => {
    if (!isCanonicalVerifiedPublishedLot(lot)) return lot
    if (!outlierKeys.has(sideKey(lot, 'entry')) && !outlierKeys.has(sideKey(lot, 'exit'))) return lot
    demotedLotCount += 1
    return { ...lot, evidenceQuality: 'unpriced' as const }
  })
  return { lots: guarded, demotedLotCount, outliers }
}
