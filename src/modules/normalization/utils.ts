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

// CHAIN-SCOPED DEDUPE KEY, DISCLOSED (Wallet Scanner graph/API support audit): the caller
// (src/pipeline/index.ts) fetches every requested chain concurrently and flattens all chains'
// raw events into ONE array (`allRawEvents`) before this dedupe key is ever applied — confirmed by
// reading the call site, and the live wallet-scanner UI does request multiple chains
// (['base','eth']) in a single scan. The key previously omitted `chain`, so two structurally
// distinct events on different chains that happened to share the same txHash/contract/from/to/
// amountRaw would collide and the second chain's real event would be dropped as
// 'duplicate_event' — silently under-counting that chain's FIFO evidence. In practice this needs
// an exact txHash collision across chains, which EIP-155 (chain ID baked into what's signed) makes
// vanishingly unlikely for real wallet-signed transactions — but it is a real, closable gap in the
// key's own stated scope, not a hypothetical one, and adding the field the caller already has on
// every event is a same-shape, zero-behavior-change fix for the (overwhelmingly common) single-chain
// or non-colliding case: it only changes the outcome for the specific colliding case this key exists
// to prevent.
export function normalizedDedupeKey(event: RawProviderEvent): string {
  return `${event.chain ?? ''}|${event.txHash ?? ''}|${(event.contract ?? '').toLowerCase()}|${(event.fromAddress ?? '').toLowerCase()}|${(event.toAddress ?? '').toLowerCase()}|${event.amountRaw ?? ''}`
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
