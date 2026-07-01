// MODULE 2 — normalization
//
// Converts raw provider events into a single, deduplicated, direction-resolved event set.
// Pure transform: no provider calls, no side effects (Architecture Step 8 §1). A malformed event
// is skipped (never fabricated into a placeholder shape) and recorded in normalizationErrors —
// normalization continues past any individual failure (Architecture Step 7 §2).

import type { RawProviderEvent } from '../providerFetchWindow/types'
import type {
  Direction,
  NormalizationError,
  NormalizationResult,
  NormalizedEvent,
} from './types'
import { firstFailingReason, isValidAddress, normalizedDedupeKey, parseAmount } from './utils'

export type {
  Direction,
  NormalizationError,
  NormalizationErrorReason,
  NormalizationResult,
  NormalizedEvent,
} from './types'

// PURE. Resolves an event's direction relative to the scanned wallet. An event whose to/from
// doesn't match the wallet on either side is 'unknown' — it is never guessed at or forced into
// inbound/outbound (Architecture Step 9 §1: normalized events must be trustworthy, not invented).
export function classifyDirection(event: RawProviderEvent, walletAddress: string): Direction {
  const walletLower = (walletAddress ?? '').toLowerCase()
  const toLower = (event.toAddress ?? '').toLowerCase()
  const fromLower = (event.fromAddress ?? '').toLowerCase()
  if (toLower && toLower === walletLower) return 'inbound'
  if (fromLower && fromLower === walletLower) return 'outbound'
  return 'unknown'
}

// PURE constructor — builds a NormalizationError record. "Recording" an error in a pure-function
// world means returning the record for the caller (normalizeEvents) to collect into an array,
// never mutating a shared/external array as a side effect.
export function recordNormalizationError(
  event: RawProviderEvent,
  reason: NormalizationError['reason'],
): NormalizationError {
  return {
    reason,
    provider: event.provider ?? null,
    chain: event.chain ?? null,
    txHash: event.txHash ?? null,
  }
}

// PURE. Validates, deduplicates, and direction-classifies a batch of raw events. Never throws;
// never triggers a provider call; a single malformed event never stops processing of the rest.
export function normalizeEvents(rawEvents: RawProviderEvent[], walletAddress: string): NormalizationResult {
  const normalizedEvents: NormalizedEvent[] = []
  const normalizationErrors: NormalizationError[] = []
  const seen = new Set<string>()

  for (const event of rawEvents) {
    const failingReason = firstFailingReason(event)
    if (failingReason) {
      normalizationErrors.push(recordNormalizationError(event, failingReason))
      continue
    }

    const amount = parseAmount(event.amountRaw, event.tokenDecimals)
    if (amount == null) {
      normalizationErrors.push(recordNormalizationError(event, 'invalid_amount'))
      continue
    }
    if (amount <= 0) {
      normalizationErrors.push(recordNormalizationError(event, 'zero_amount'))
      continue
    }

    const dedupeKey = normalizedDedupeKey(event)
    if (seen.has(dedupeKey)) {
      normalizationErrors.push(recordNormalizationError(event, 'duplicate_event'))
      continue
    }
    seen.add(dedupeKey)

    normalizedEvents.push({
      provider: event.provider,
      chain: event.chain,
      txHash: event.txHash as string,
      timestamp: event.timestamp as string,
      fromAddress: isValidAddress(event.fromAddress) ? event.fromAddress : '',
      toAddress: isValidAddress(event.toAddress) ? event.toAddress : '',
      contract: (event.contract as string).toLowerCase(),
      symbol: event.symbol ?? '?',
      amount,
      amountRaw: event.amountRaw,
      tokenDecimals: typeof event.tokenDecimals === 'number' ? event.tokenDecimals : 18,
      direction: classifyDirection(event, walletAddress),
    })
  }

  return { normalizedEvents, normalizationErrors }
}
