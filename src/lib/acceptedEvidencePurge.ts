// Which stored accepted-evidence records are unusable and should be deleted (used by
// scripts/purge-bad-accepted-evidence.ts). Accepted evidence is immutable by design, so a record
// written by a broken scan — the $603,963/token USDC dust quote, a $1e17 side — would otherwise be
// reloaded by every later scan. The guards in pnlReconciliation keep such values out of published
// PnL; deleting them lets the side be priced again from scratch.

import type { MatchedLot } from '../modules/fifoEngine/types'
import { buildAcceptedEvidenceKey } from './acceptedEvidenceStore'
import { acceptedEvidenceCoveredQuantity } from './canonicalPnlSampleManifest'
import type { LotPriceOutlier } from './lotPriceOutlierGuard'
import { isMajorVolatileToken } from './majorMarketPrice'

// No side of a wallet trade on these chains is plausibly worth more than this.
export const PURGE_MAX_SIDE_VALUE_USD = 10_000_000
// No token priced in this app trades above this per unit (BTC-backed tokens included).
export const PURGE_MAX_PER_UNIT_USD = 1_000_000

export type AcceptedEvidencePurgeReason = 'not_an_object' | 'non_positive_or_non_finite_value' | 'side_value_too_large' | 'per_unit_price_too_large'

export function acceptedEvidencePurgeReason(raw: unknown): AcceptedEvidencePurgeReason | null {
  if (raw === null || typeof raw !== 'object') return 'not_an_object'
  const record = raw as { chain?: unknown; token?: unknown; priceUsd?: unknown; coverageFingerprint?: unknown; coveredLotCount?: unknown }
  const priceUsd = record.priceUsd
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) return 'non_positive_or_non_finite_value'
  if (priceUsd > PURGE_MAX_SIDE_VALUE_USD) return 'side_value_too_large'
  const quantity = acceptedEvidenceCoveredQuantity(
    typeof record.coverageFingerprint === 'string' ? record.coverageFingerprint : null,
    typeof record.coveredLotCount === 'number' ? record.coveredLotCount : 1,
  )
  const major = typeof record.chain === 'string' && typeof record.token === 'string' && isMajorVolatileToken(record.chain, record.token)
  if (!major && quantity !== null && priceUsd / quantity > PURGE_MAX_PER_UNIT_USD) return 'per_unit_price_too_large'
  return null
}

// Outlier reasons that name the bad side itself. A lot-level return outlier only says one of its
// two sides is wrong, so neither side's record is deleted for it.
const SIDE_OUTLIER_REASONS: ReadonlySet<LotPriceOutlier['reason']> = new Set(['token_price_outlier', 'token_local_price_outlier', 'wallet_value_outlier'])

/**
 * Accepted-evidence keys of the transaction sides the in-scan outlier guard rejected. Those values
 * disagree with the token's own trades in the same scan; a stored record of one would be reloaded
 * (immutably) by every later scan, so the caller deletes it and the side is priced again.
 */
export function acceptedEvidenceKeysForOutlierSides(lots: readonly MatchedLot[], outliers: readonly LotPriceOutlier[]): string[] {
  const outlierSides = new Set(outliers
    .filter((o) => SIDE_OUTLIER_REASONS.has(o.reason))
    .map((o) => `${o.chain}:${o.token.toLowerCase()}:${o.txHash.toLowerCase()}:${o.side}`))
  const keys = new Set<string>()
  for (const lot of lots) {
    for (const side of ['entry', 'exit'] as const) {
      const txHash = side === 'entry' ? lot.openedTxHash : lot.closedTxHash
      if (!outlierSides.has(`${lot.chain}:${lot.token.toLowerCase()}:${txHash.toLowerCase()}:${side}`)) continue
      keys.add(buildAcceptedEvidenceKey({
        chain: lot.chain, token: lot.token, txHash, side,
        timestamp: side === 'entry' ? lot.openedAt : lot.closedAt, lotIdentityVersion: '',
      }))
    }
  }
  return [...keys]
}
