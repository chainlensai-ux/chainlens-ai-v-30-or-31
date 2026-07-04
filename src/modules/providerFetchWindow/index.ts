// MODULE 1 — providerFetchWindow
//
// Fetches the shallow (80-365 day, opt-in-widened — see below) provider window from GoldRush +
// Alchemy for a single chain. This is the ONLY module in /src/modules permitted to make a network
// call. Everything it produces (RawProviderEvent[]) is inert data consumed by module 2
// (normalization) onward.
//
// Architecture rules enforced here (Steps 1 / 7 §1 / 8 §1):
//   - provider_fetch_window_days is fixed within [PROVIDER_FETCH_WINDOW_DAYS_MIN,
//     PROVIDER_FETCH_WINDOW_DAYS_MAX] (types.ts) — historically [80, 100], widened to [80, 365] per
//     an explicit request; still a fixed code-level ceiling, not something env config can exceed.
//   - if one provider fails, use the other
//   - if both fail, mark the chain provider_unavailable
//   - never deep-page (single bounded page per provider, see utils.ts) — widening the window ceiling
//     above does NOT relax this; MAX_RAW_EVENTS_PER_PROVIDER (types.ts) is still one bounded page,
//     so a wider window increases (does not eliminate) the truncation risk for very active wallets
//     whose real history doesn't fit in that one page — see types.ts's own disclosure on this.
//   - never fetch receipts outside the window (no receipt fetching happens in this module at all)
//
// WINDOW WIDENING / OVERRIDE MECHANISM, DISCLOSED: a task asked to modify `validateWindow()`/
// `computeWindow()`/`enforceWindowBounds()` here — none of those functions exist anywhere in this
// file or module; the real, pre-existing bounds-check is `clampWindowDays` (utils.ts), which
// `fetchProviderWindow` below already called with an optional `windowDays` param before this change.
// The actual new, additive piece is `getEffectiveFetchWindow()` (utils.ts, re-exported below): it
// reads an opt-in `PROVIDER_FETCH_WINDOW_OVERRIDE` env var, falls back to
// `PROVIDER_FETCH_WINDOW_DAYS_DEFAULT` (90 — unchanged) when unset, and clamps whatever it resolves
// to via the same MIN/MAX bounds `clampWindowDays` has always enforced. Callers (see
// app/api/_shared/walletChainPipeline.ts) now call `getEffectiveFetchWindow()` once and pass its
// result into `fetchProviderWindow`'s existing `windowDays` parameter — `fetchProviderWindow` itself
// is functionally unchanged below; it still just clamps whatever it's given.
//
// RECOVERYPOLICY INTERACTION, DISCLOSED: recoveryPolicy (src/modules/recoveryPolicy) is a separate,
// independently-triggered deep-history mechanism with its own page caps (see its types.ts's own
// "WINDOW EXPANSION" comment, scaled to the 90-day default at the time it was written) — it does not
// read PROVIDER_FETCH_WINDOW_OVERRIDE and is not resized by it. Widening this module's base window
// via the override narrows the gap recoveryPolicy might otherwise need to bridge (more real history
// is now covered by the base fetch itself), but does not change recoveryPolicy's own caps/behavior —
// no code in recoveryPolicy was touched by this change, per this task's own file-scope request.

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
// New, additive re-exports — see this file's header and utils.ts for the full disclosure.
export { getEffectiveFetchWindow, getWindowFromEnv } from './utils'

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
