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
async function fetchProviderWindowLive(
  chain: SupportedChain,
  walletAddress: string,
  resolvedWindowDays: number,
): Promise<ProviderFetchWindowResult> {
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

// REQUEST-SCOPED PROMISE COALESCING, DISCLOSED (provider-call-audit follow-up task, confirmed real
// duplicate-call source): a prior fix made src/pipeline/index.ts AWAIT its Redis cache write before
// returning, so the V2 engine chain's later read would normally hit that cache instead of
// re-fetching. That closed the common case but not a slow/timing-out provider: fetchProviderWindow
// can legitimately take up to 12s (per-provider AbortSignal timeout, see utils.ts) to even RESOLVE
// — every caller within that window (old pipeline's own per-chain Promise.all, the V2 chain's
// trades/chainActivity modules, any other consumer reached before the first call settles) was still
// each independently starting a brand-new live fetch, because there was nothing IN-PROCESS
// coalescing concurrent/overlapping calls for the same (chain, wallet). This map closes that gap:
// the FIRST caller for a given (chain, wallet) starts the real fetch and every other caller
// (concurrent, or arriving after the first has already settled) receives the exact same
// promise/result — including a timeout/failure result, per this task's explicit requirement that
// later stages must not retry live within the same request. Cross-request Redis caching
// (src/pipeline/index.ts, app/api/_shared/walletChainPipeline.ts) is completely unaffected — this
// sits UNDERNEATH that layer, only deduplicating calls within one process's lifetime, and is reset
// once per real scan job (see resetProviderFetchWindowRequestCache, called from
// walletScanWorker.ts alongside this codebase's other established per-job counter resets) so it
// never leaks results across unrelated scans/wallets on a warm serverless instance.
//
// KEY BUG, CONFIRMED AND FIXED (this follow-up task): the PRIOR version of this map keyed on
// `${chain}:${wallet}:${resolvedWindowDays}` — including the resolved window. The old pipeline
// always requests exactly 90 (PROVIDER_FETCH_WINDOW_DAYS_USED, src/pipeline/index.ts) while the V2
// engine chain requests `getEffectiveFetchWindow()` (app/api/_shared/walletChainPipeline.ts), which
// only differs from 90 when the opt-in PROVIDER_FETCH_WINDOW_OVERRIDE env var is set — but ANY
// deployment where it IS set (or any future caller passing a different explicit windowDays) silently
// produced two DIFFERENT keys for the exact same (chain, wallet), so the two engines' calls were
// never coalesced with each other at all — each independently ran its own full 2-provider fetch,
// which is exactly the "4 Base transactions_v3 calls" symptom this task investigates (2 real
// window-groups x 2 providers each, or worse under overlap/retry). Fixed below by keying ONLY on
// canonical (chain, wallet) and reusing the LARGEST known in-flight/settled window's result — a
// caller asking for a narrower window gets that same fetch, locally sliced to its own cutoff,
// instead of triggering its own live call. A caller asking for a WIDER window than what's already
// known still correctly triggers its own fresh (wider) live fetch — a narrower prior result can
// never be silently reused as if it covered a wider window.
type CoalescedEntry = {
  windowDays: number
  promise: Promise<ProviderFetchWindowResult>
  settled: boolean
}
const requestScopedFetches = new Map<string, CoalescedEntry>()

// COUNTERS, DISCLOSED (this follow-up task's explicit diagnostic requirement): real, per-job counts
// — never estimates. `liveFetches` = real fetchProviderWindowLive calls actually started (the only
// thing that costs a genuine provider call). `coalescedHits` = callers that reused an entry whose
// live fetch was STILL IN FLIGHT at the time (true request coalescing, avoiding a race-triggered
// duplicate). `settledReuseHits` = callers that reused an entry whose live fetch had ALREADY
// resolved (ordinary in-process cache reuse, no race involved). `resetCount` = how many times
// resetProviderFetchWindowRequestCache actually ran — proves reset timing directly instead of
// inferring it from map-size logs alone.
let liveFetches = 0
let coalescedHits = 0
let settledReuseHits = 0
let resetCount = 0

export function getProviderFetchWindowCoalescingCounters(): {
  liveFetches: number
  coalescedHits: number
  settledReuseHits: number
  resetCount: number
} {
  return { liveFetches, coalescedHits, settledReuseHits, resetCount }
}

// MODULE-INSTANCE MARKER, DISCLOSED: a constant computed once when this module is first evaluated.
// If old-pipeline and V2-engine callers ever logged two DIFFERENT values for this across the same
// job, that alone would prove the bundler instantiated two separate copies of this module (defeating
// the shared map entirely) — the real, direct way to "confirm old and V2 imports share one
// module-scoped map in production bundling" this task asks for, rather than inferring it indirectly.
const moduleInstanceId = `pfw-${Math.floor(Math.random() * 1e9)}-${typeof process !== 'undefined' ? process.pid : 0}`

function canonicalWallet(walletAddress: string): string {
  return walletAddress.trim().toLowerCase()
}

function canonicalKey(chain: SupportedChain, walletAddress: string): string {
  return `${chain}:${canonicalWallet(walletAddress)}`
}

// Filters an already-fetched WIDER window's raw events down to a caller-requested NARROWER window,
// purely a local, zero-cost slice — never a new provider call, never a fabricated event. Events with
// no parseable timestamp are kept (never dropped on ambiguity — matches this module's own "never
// silently discard real data" convention elsewhere, e.g. fetchGoldrushRawEvents's own window filter).
function sliceToWindow(result: ProviderFetchWindowResult, windowDays: number): ProviderFetchWindowResult {
  if (result.providerFetchWindowDays === windowDays) return result
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000
  const keep = (e: RawProviderEvent) => {
    if (!e.timestamp) return true
    const ms = Date.parse(e.timestamp)
    return Number.isNaN(ms) ? true : ms >= cutoffMs
  }
  const slicedGoldrush = { ...result.providerResults.goldrush, events: result.providerResults.goldrush.events.filter(keep) }
  const slicedAlchemy = { ...result.providerResults.alchemy, events: result.providerResults.alchemy.events.filter(keep) }
  return {
    ...result,
    rawEvents: result.rawEvents.filter(keep),
    providerResults: { goldrush: slicedGoldrush, alchemy: slicedAlchemy },
    providerFetchWindowDays: windowDays,
  }
}

export function resetProviderFetchWindowRequestCache(): void {
  requestScopedFetches.clear()
  liveFetches = 0
  coalescedHits = 0
  settledReuseHits = 0
  resetCount += 1
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] providerFetchWindow request-scoped cache reset', { resetCount, moduleInstanceId, timestamp: Date.now() })
}

export async function fetchProviderWindow(
  chain: SupportedChain,
  walletAddress: string,
  windowDays?: number,
  stage: string = 'unknown',
): Promise<ProviderFetchWindowResult> {
  const resolvedWindowDays = clampWindowDays(windowDays)
  const key = canonicalKey(chain, walletAddress)

  const existing = requestScopedFetches.get(key)
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] fetchProviderWindow invocation', {
    stage,
    wallet: canonicalWallet(walletAddress),
    chain,
    requestedWindowDays: windowDays ?? null,
    resolvedWindowDays,
    key,
    mapSize: requestScopedFetches.size,
    existingEntryWindowDays: existing?.windowDays ?? null,
    hit: Boolean(existing && existing.windowDays >= resolvedWindowDays),
    moduleInstanceId,
    timestamp: Date.now(),
  })

  if (existing && existing.windowDays >= resolvedWindowDays) {
    if (existing.settled) settledReuseHits += 1
    else coalescedHits += 1
    const result = await existing.promise
    return sliceToWindow(result, resolvedWindowDays)
  }

  // No usable existing entry (none at all, or the existing one covers a NARROWER window than this
  // caller needs) — a real, fresh live fetch is required. This intentionally REPLACES a narrower
  // existing entry so any later, still-narrower caller can now reuse this wider one instead.
  liveFetches += 1
  const entry: CoalescedEntry = { windowDays: resolvedWindowDays, promise: undefined as unknown as Promise<ProviderFetchWindowResult>, settled: false }
  const promise = fetchProviderWindowLive(chain, walletAddress, resolvedWindowDays)
  entry.promise = promise
  requestScopedFetches.set(key, entry)
  // Defensive cleanup only: fetchProviderWindowLive is disclosed as never throwing (both provider
  // calls resolve to an { ok: false, ... } shape on failure, never a rejection) — this guards
  // against that contract ever being violated by a future change, so an unexpected rejection can't
  // permanently poison this key for the rest of the request.
  promise.then(
    () => { entry.settled = true },
    () => { if (requestScopedFetches.get(key) === entry) requestScopedFetches.delete(key) },
  )
  return promise
}
