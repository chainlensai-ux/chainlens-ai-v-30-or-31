// MODULE 2 — normalization: type definitions.
// Converts RawProviderEvent[] (module 1's output) into a single, deduplicated, direction-resolved
// NormalizedEvent[]. Pure transform — no provider calls, no side effects (Architecture Step 8 §1).

import type { ProviderName, RawProviderEvent, SupportedChain } from '../providerFetchWindow/types'

export type Direction = 'inbound' | 'outbound' | 'unknown'

export type NormalizedEvent = {
  provider: ProviderName
  chain: SupportedChain
  txHash: string
  timestamp: string
  fromAddress: string
  toAddress: string
  contract: string
  symbol: string
  amount: number
  amountRaw: string | null
  tokenDecimals: number
  direction: Direction
}

export type NormalizationErrorReason =
  | 'missing_tx_hash'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'missing_contract'
  | 'invalid_contract'
  | 'missing_amount'
  | 'invalid_amount'
  | 'zero_amount'
  | 'duplicate_event'

export type NormalizationError = {
  reason: NormalizationErrorReason
  provider: ProviderName | null
  chain: SupportedChain | null
  txHash: string | null
}

export type NormalizationResult = {
  normalizedEvents: NormalizedEvent[]
  normalizationErrors: NormalizationError[]
}

export type { RawProviderEvent }
