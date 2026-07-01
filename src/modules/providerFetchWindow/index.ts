// MODULE 1 — providerFetchWindow
//
// Fetches the shallow (30-40 day) provider window from GoldRush + Alchemy for a single chain.
// This is the ONLY module in /src/modules permitted to make a network call. Everything it
// produces (RawProviderEvent[]) is inert data consumed by module 2 (normalization) onward.
//
// Architecture rules enforced here (Steps 1 / 7 §1 / 8 §1):
//   - provider_fetch_window_days is fixed within [30, 40]
//   - if one provider fails, use the other
//   - if both fail, mark the chain provider_unavailable
//   - never deep-page (single bounded page per provider, see utils.ts)
//   - never fetch receipts outside the window (no receipt fetching happens in this module at all)

import type {
  ProviderFetchWindowResult,
  ProviderStatus,
  RawProviderEvent,
  SingleProviderFetchResult,
  SupportedChain,
} from './types'
import { clampWindowDays, dedupeRawEventKey, fetchAlchemyRawEvents, fetchGoldrushRawEvents } from './utils'

export type {
  ProviderFetchWindowResult,
  ProviderName,
  ProviderStatus,
  RawProviderEvent,
  SingleProviderFetchResult,
  SupportedChain,
} from './types'
export {
  MAX_RAW_EVENTS_PER_PROVIDER,
  PROVIDER_FETCH_WINDOW_DAYS_DEFAULT,
  PROVIDER_FETCH_WINDOW_DAYS_MAX,
  PROVIDER_FETCH_WINDOW_DAYS_MIN,
} from './types'

// PURE. Merges two already-fetched raw event arrays, deduplicating by
// (txHash, contract, fromAddress, toAddress, amountRaw). Preferring the GoldRush copy of a
// duplicate leg when both providers report it (arbitrary but deterministic tiebreak — neither
// provider's copy carries more information at this raw, pre-normalization stage).
export function mergeProviderResults(
  goldrushEvents: RawProviderEvent[],
  alchemyEvents: RawProviderEvent[],
): RawProviderEvent[] {
  const merged = new Map<string, RawProviderEvent>()
  for (const event of [...goldrushEvents, ...alchemyEvents]) {
    const key = dedupeRawEventKey(event)
    if (!merged.has(key)) merged.set(key, event)
  }
  return [...merged.values()]
}

// PURE. Decides providerStatus from each provider's own ok/fail outcome.
//   - both ok            -> "ok"
//   - exactly one ok      -> "partial"
//   - neither ok           -> "provider_unavailable"
export function detectProviderUnavailable(
  goldrushResult: SingleProviderFetchResult,
  alchemyResult: SingleProviderFetchResult,
): ProviderStatus {
  if (goldrushResult.ok && alchemyResult.ok) return 'ok'
  if (goldrushResult.ok || alchemyResult.ok) return 'partial'
  return 'provider_unavailable'
}

// Fetches the shallow window for a single chain from both providers, in parallel, and combines
// the results. Never throws — each provider call is individually failure-isolated inside
// fetchGoldrushRawEvents/fetchAlchemyRawEvents, so one provider failing never prevents the other
// from being used (Architecture Step 7 §1).
export async function fetchProviderWindow(
  chain: SupportedChain,
  walletAddress: string,
  windowDays?: number,
): Promise<ProviderFetchWindowResult> {
  const resolvedWindowDays = clampWindowDays(windowDays)

  const [goldrushResult, alchemyResult] = await Promise.all([
    fetchGoldrushRawEvents(chain, walletAddress, resolvedWindowDays),
    fetchAlchemyRawEvents(chain, walletAddress, resolvedWindowDays),
  ])

  const providerStatus = detectProviderUnavailable(goldrushResult, alchemyResult)
  const rawEvents = providerStatus === 'provider_unavailable'
    ? []
    : mergeProviderResults(goldrushResult.events, alchemyResult.events)

  return {
    chain,
    providerStatus,
    rawEvents,
    providerResults: { goldrush: goldrushResult, alchemy: alchemyResult },
    providerFetchWindowDays: resolvedWindowDays,
  }
}
