// MODULE 2 — normalization: pure helper functions. No provider calls, no side effects.

import type { RawProviderEvent } from '../providerFetchWindow/types'
import type { NormalizationErrorReason } from './types'

const ADDRESS_RE = /^0x[a-f0-9]{40}$/

export function isValidAddress(address: string | null): address is string {
  return typeof address === 'string' && ADDRESS_RE.test(address.toLowerCase())
}

export function isValidContract(contract: string | null): contract is string {
  return typeof contract === 'string' && ADDRESS_RE.test(contract.toLowerCase())
}

export function isValidTimestamp(timestamp: string | null): timestamp is string {
  return typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp))
}

// Parses a raw provider amount (string, decimal-scaled) into a finite, non-negative number.
// Returns null when the value cannot be safely parsed — callers must treat null as "skip", never
// silently coerce it to 0 (0 would misrepresent "no amount reported" as "reported amount of zero").
export function parseAmount(amountRaw: string | null, tokenDecimals: number | null): number | null {
  if (amountRaw == null) return null
  const decimals = typeof tokenDecimals === 'number' && Number.isFinite(tokenDecimals) ? tokenDecimals : 18
  const parsed = Number(amountRaw)
  if (!Number.isFinite(parsed)) return null
  // GoldRush `delta` values arrive pre-scaled by raw units; Alchemy `rawContract.value` values are
  // also raw-unit integers. Both need division by 10^decimals to reach a human-readable amount.
  const value = Math.abs(parsed) / Math.pow(10, decimals)
  return Number.isFinite(value) ? value : null
}

export function normalizedDedupeKey(event: RawProviderEvent): string {
  return `${event.txHash ?? ''}|${(event.contract ?? '').toLowerCase()}|${(event.fromAddress ?? '').toLowerCase()}|${(event.toAddress ?? '').toLowerCase()}|${event.amountRaw ?? ''}`
}

export function firstFailingReason(event: RawProviderEvent): NormalizationErrorReason | null {
  if (!event.txHash) return 'missing_tx_hash'
  if (!event.timestamp) return 'missing_timestamp'
  if (!isValidTimestamp(event.timestamp)) return 'invalid_timestamp'
  if (!event.contract) return 'missing_contract'
  if (!isValidContract(event.contract)) return 'invalid_contract'
  if (event.amountRaw == null) return 'missing_amount'
  return null
}
