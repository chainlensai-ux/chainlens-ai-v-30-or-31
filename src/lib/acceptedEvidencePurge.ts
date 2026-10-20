// Which stored accepted-evidence records are unusable and should be deleted (used by
// scripts/purge-bad-accepted-evidence.ts). Accepted evidence is immutable by design, so a record
// written by a broken scan — the $603,963/token USDC dust quote, a $1e17 side — would otherwise be
// reloaded by every later scan. The guards in pnlReconciliation keep such values out of published
// PnL; deleting them lets the side be priced again from scratch.

import { acceptedEvidenceCoveredQuantity } from './canonicalPnlSampleManifest'
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
