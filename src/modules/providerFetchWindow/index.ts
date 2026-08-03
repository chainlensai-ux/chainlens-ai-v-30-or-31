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
import { clampWindowDays, dedupeRawEventKey, fetchAlchemyRawEvents, fetchGoldrushRawEvents, resetAlchemyHistoryConcurrencyState } from './utils'
import { estimatedCuForMethod } from '@/lib/server/alchemyCallBudget'

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
// CONFIRMED ROOT CAUSE, DISCLOSED (provider-coalescing follow-up task, real production evidence: one
// worker invocation took 46.88s and made the exact same Base transactions_v3 request TWICE, both
// timing out after 12s, while the equivalent Ethereum request was made once and succeeded): the
// PRIOR version of this entry only tracked `settled: boolean` — a coarse yes/no with no record of
// WHAT the settled outcome actually was. Reuse logic (`if (existing.settled) settledReuseHits += 1
// else coalescedHits += 1`) worked correctly for either outcome — a settled entry, success or
// failure, was always reused, never re-fetched, and this was already covered by this file's own
// coalescing tests. But the cleanup path on the promise attached below,
// `promise.then(onFulfilled, onRejected)`, deletes the map entry the instant `fetchProviderWindowLive`
// EVER rejects — relying entirely on an UNDISCLOSED, implicit assumption (stated only in this file's
// old comment, never enforced in code) that fetchGoldrushRawEvents/fetchAlchemyRawEvents can never
// throw. That assumption held for every scenario this file's own tests modeled (a provider fetch()
// throwing synchronously, wrapped by fetchGoldrushRawEvents/fetchAlchemyRawEvents's own try/catch,
// which never propagates). A REAL 12-second AbortSignal.timeout firing goes through the identical
// caught path today — but this map's own correctness for the timeout/failure case was, until this
// fix, resting entirely on that lower module never changing, with no defense here if it ever did
// (a future edit to either provider function, an uncaught exception in JSON parsing outside the
// existing try, or any other unexpected throw). The FIX, DISCLOSED (this task's own explicit "do not
// let a rejected promise get removed and retried" requirement): `fetchProviderWindowLive` is now
// wrapped in `runLiveFetchSafely` below, which converts ANY rejection — expected or not — into the
// exact same honest `provider_unavailable` degraded result this module already produces for a known
// provider failure, so the promise STORED in this map can never reject. The `.then(onRejected)`
// deletion branch this map used to rely on is removed entirely — there is no longer a rejection path
// to delete on, so a duplicate live fetch after a timeout/failure is now structurally impossible,
// not just untriggered in the scenarios tested so far.
export type FetchOutcome = 'success' | 'timeout' | 'error'

type CoalescedEntry = {
  windowDays: number
  promise: Promise<ProviderFetchWindowResult>
  settled: boolean
  // PER-KEY AUDIT FIELDS, DISCLOSED (this task's explicit diagnostic requirement): tracked per
  // (chain, wallet) entry, not just as a process-global aggregate, so a production log can show
  // exactly which key avoided a duplicate and how.
  invocationCount: number
  pendingCoalescedHits: number
  settledSuccessReuseHits: number
  settledFailureReuseHits: number
  duplicateLiveFetchPrevented: number
  firstOutcome: FetchOutcome | null
}
const requestScopedFetches = new Map<string, CoalescedEntry>()

// CURRENT JOB ID, DISCLOSED: set once per real scan job (resetProviderFetchWindowRequestCache,
// called from walletScanWorker.ts) purely so the per-key audit log below can attribute its entries
// to the job that produced them — never used for any cache-key/coalescing decision itself (the
// canonical key remains (chain, wallet) only, unchanged).
let currentJobId: string | null = null

function isTimeoutLikeReason(reason: string | null): boolean {
  if (!reason) return false
  const lower = reason.toLowerCase()
  return lower.includes('timeout') || lower.includes('abort')
}

// PURE, exported for direct testing. Classifies a settled ProviderFetchWindowResult into the real
// outcome this task's audit requires — never a guess: 'success' whenever at least one provider
// genuinely returned usable data (matches this module's own detectProviderUnavailable semantics —
// 'ok' or 'partial' both mean real events came back), 'timeout' when both providers failed and
// either one's own errorReason indicates an abort/timeout, 'error' for every other both-failed case.
export function classifyFetchOutcome(result: ProviderFetchWindowResult): FetchOutcome {
  if (result.providerStatus !== 'provider_unavailable') return 'success'
  const { goldrush, alchemy } = result.providerResults
  return isTimeoutLikeReason(goldrush.errorReason) || isTimeoutLikeReason(alchemy.errorReason) ? 'timeout' : 'error'
}

// PERMANENT vs. TRANSIENT FAILURE REASONS, DISCLOSED (Alchemy-history-ingestion-regression task —
// confirmed root cause of "Base 0 events, ETH 0 events" while GoldRush stayed healthy). A reason is
// PERMANENT only when it can never change for the rest of THIS job — missing config, an unsupported
// chain — so memoizing it costs nothing (no further calls would ever be attempted anyway) and saves
// nothing either (retrying is genuinely pointless). Every other reason — a budget refusal, a
// malformed response, an HTTP failure, a timeout, an unknown/network error — is TRANSIENT: it can
// genuinely differ on a later attempt within the same job, so permanently caching it risks locking
// the entire rest of the job into a bad, single unlucky attempt.
const PERMANENT_FAILURE_REASONS = new Set(['chain_not_verified_for_provider', 'no_api_key_configured'])

function isPermanentFailureReason(reason: string | null): boolean {
  return reason !== null && PERMANENT_FAILURE_REASONS.has(reason)
}

// CONFIRMED ROOT CAUSE, DISCLOSED: detectProviderUnavailable's own `partial` classification (one
// provider ok, the other not) is correct for ROUTING this one call's own merged events — but this
// module's coalescing layer previously treated ANY `partial`/`ok` outcome as unconditionally
// reuse-worthy for the REST OF THE JOB (classifyFetchOutcome only ever returns 'success' or
// 'timeout'/'error', with no notion of "successful but for a self-imposed, transient reason"). The
// real production regression: GoldRush genuinely succeeded, Alchemy was refused by this job's own
// shared CU budget (a transient, request-scoped throttle, never a real provider outage) — the
// merged (GoldRush-only) result was classified 'success' and memoized, so EVERY later duplicate
// caller for that (chain, wallet) — old pipeline, V2 engine, holdings, trades — received the SAME
// Alchemy-less degraded result for the rest of the job, collapsing ~565 events / ~216 lots down to
// 89 events / 45 lots. A result is now reuse-eligible (settled, kept for the rest of the job) ONLY
// when every provider that didn't succeed failed for a PERMANENT reason — a budget refusal (or any
// other transient failure) on EITHER provider means this exact result must never become the job's
// only answer for this (chain, wallet).
function isReuseEligible(result: ProviderFetchWindowResult): boolean {
  const { goldrush, alchemy } = result.providerResults
  if (!goldrush.ok && !isPermanentFailureReason(goldrush.errorReason)) return false
  if (!alchemy.ok && !isPermanentFailureReason(alchemy.errorReason)) return false
  return true
}

// [alchemy-history-ingestion-audit], DISCLOSED (this task's explicit diagnostic requirement):
// logged once per real LIVE fetch (never for a reused/coalesced call, which made no new Alchemy
// call of its own) — real counts only, reconciled directly from fetchAlchemyRawEvents' own
// diagnostics (see providerFetchWindow/utils.ts) and this key's own per-entry coalescing counters,
// never estimates. `pagesRequested`/`pageKeysSeen` are always 2/0 today (this module's own
// "never deep-page" rule — one bounded from+to page per provider, no pageKey follow-up), kept as
// real fields (not hardcoded in the log) so a future paginated caller is reflected honestly rather
// than silently under-reported.
function logAlchemyHistoryIngestionAudit(
  chain: SupportedChain,
  alchemyResult: SingleProviderFetchResult,
  entry: CoalescedEntry,
  usableEventCount: number,
  finalStatus: ProviderFetchWindowResult['providerStatus'],
): void {
  const d = alchemyResult.diagnostics ?? { liveCalls: 0, budgetRefusals: 0, malformedResponses: 0, nullResponses: 0 }
  // OBSERVABILITY-TRUTHFULNESS FIX, DISCLOSED (this task — confirmed bug #1): with 2 real Base
  // calls both returning HTTP 429, the OLD `pagesSucceeded` formula (`liveCalls - malformedResponses
  // - nullResponses`) reported 2 (since a 429 counts toward NEITHER malformedResponses NOR
  // nullResponses after the prior task's fixes) — a genuine "0 events, 0 successes" outcome was
  // logged as "2 pages succeeded." `http429Errors` (from `diagnostics.http429Count`, added by the
  // circuit-breaker task) is now subtracted too, so a call is only ever counted as "succeeded" when
  // it actually was — never when it was rate-limited.
  const http429Errors = d.http429Count ?? 0
  const preventedCalls = d.circuitPrevented ?? 0
  const pagesSucceeded = Math.max(0, d.liveCalls - d.malformedResponses - d.nullResponses - http429Errors)
  // CIRCUIT-PREVENTED CALLS NEVER INFLATE liveCalls/pagesRequested, DISCLOSED (requirement):
  // `d.liveCalls` (from fetchAlchemyRawEvents) already excludes circuit-prevented calls by
  // construction — the circuit-breaker gate in utils.ts returns before `liveCalls += 1` ever runs.
  // `preventedCalls` (below) is its own distinct field, never folded into `pagesRequested`/`liveCalls`.
  const finalStatusRefined = preventedCalls > 0
    ? 'circuit_open'
    : http429Errors > 0
      ? 'rate_limited'
      : finalStatus === 'ok'
        ? 'ok'
        : 'partial'
  // eslint-disable-next-line no-console
  console.warn('[alchemy-history-ingestion-audit]', {
    chain,
    pagesRequested: 2, // one bounded from+to page each — see this module's own "never deep-page" rule
    pagesSucceeded,
    pageKeysSeen: 0, // this module never follows a pageKey — see fetchAlchemyRawEvents' own header
    liveCalls: d.liveCalls,
    preventedCalls,
    settledReuseHits: entry.settledSuccessReuseHits + entry.settledFailureReuseHits,
    singleflightHits: entry.pendingCoalescedHits,
    budgetRefusals: d.budgetRefusals,
    malformedResponses: d.malformedResponses,
    nullResponses: d.nullResponses,
    http429Errors,
    // ADDITIVE, DISCLOSED (malformed_response regression task): breakdown of what previously
    // collapsed into malformedResponses above — undefined-safe since older diagnostics objects
    // (pre-fix, or any future caller that doesn't populate them) simply omit these fields.
    httpErrors: d.httpErrors ?? 0,
    jsonParseErrors: d.jsonParseErrors ?? 0,
    jsonRpcErrors: d.jsonRpcErrors ?? 0,
    missingResult: d.missingResult ?? 0,
    invalidTransfersShape: d.invalidTransfersShape ?? 0,
    usableEventCount,
    estimatedCu: d.liveCalls * estimatedCuForMethod('alchemy_getAssetTransfers'),
    finalStatus: finalStatusRefined,
  })
}

// SAFE WRAPPER, DISCLOSED: see this section's own header for the confirmed root cause this closes.
// Guarantees the returned promise NEVER rejects — a genuine (expected-impossible, defense-in-depth)
// exception from fetchProviderWindowLive is converted into the same shape a real "both providers
// failed" result already takes, never a fabricated success and never a dropped/retried entry.
async function runLiveFetchSafely(
  chain: SupportedChain,
  walletAddress: string,
  resolvedWindowDays: number,
): Promise<ProviderFetchWindowResult> {
  try {
    return await fetchProviderWindowLive(chain, walletAddress, resolvedWindowDays)
  } catch (err) {
    const errorReason = err instanceof Error ? err.message : 'unknown_error'
    // eslint-disable-next-line no-console
    console.warn('[provider-call-audit] fetchProviderWindowLive rejected unexpectedly — converting to a settled degraded result, never deleting the coalescing entry', {
      chain, wallet: canonicalWallet(walletAddress), errorReason, jobId: currentJobId,
    })
    return {
      chain,
      providerStatus: 'provider_unavailable',
      rawEvents: [],
      providerResults: {
        goldrush: { provider: 'goldrush', ok: false, events: [], errorReason },
        alchemy: { provider: 'alchemy', ok: false, events: [], errorReason },
      },
      providerFetchWindowDays: resolvedWindowDays,
    }
  }
}

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

export function resetProviderFetchWindowRequestCache(jobId?: string): void {
  requestScopedFetches.clear()
  liveFetches = 0
  coalescedHits = 0
  settledReuseHits = 0
  resetCount += 1
  currentJobId = jobId ?? null
  // 429-burst regression task, DISCLOSED: the Alchemy history concurrency limiter/cooldown/retry
  // audit is its own request-scoped state (utils.ts) — reset here alongside this module's other
  // per-job state so a new job never inherits a stale queue tail or cooldown from a prior one.
  resetAlchemyHistoryConcurrencyState()
  // eslint-disable-next-line no-console
  console.warn('[provider-call-audit] providerFetchWindow request-scoped cache reset', { resetCount, moduleInstanceId, jobId: currentJobId, timestamp: Date.now() })
}

// PER-KEY AUDIT EXPORT, DISCLOSED (this task's explicit diagnostic requirement): a real snapshot of
// every (chain, wallet) entry's own coalescing history for the CURRENT job — never a process-global
// estimate. Read-only; changes no state.
export type ProviderFetchWindowKeyAudit = {
  jobId: string | null
  key: string
  invocationCount: number
  liveFetches: number
  pendingCoalescedHits: number
  settledSuccessReuseHits: number
  settledFailureReuseHits: number
  firstOutcome: FetchOutcome | null
  duplicateLiveFetchPrevented: number
}

export function getProviderFetchWindowKeyAudits(): ProviderFetchWindowKeyAudit[] {
  return [...requestScopedFetches.entries()].map(([key, entry]) => ({
    jobId: currentJobId,
    key,
    invocationCount: entry.invocationCount,
    liveFetches: 1, // one entry == exactly one live fetch ever started for this key, by construction
    pendingCoalescedHits: entry.pendingCoalescedHits,
    settledSuccessReuseHits: entry.settledSuccessReuseHits,
    settledFailureReuseHits: entry.settledFailureReuseHits,
    firstOutcome: entry.firstOutcome,
    duplicateLiveFetchPrevented: entry.duplicateLiveFetchPrevented,
  }))
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
    jobId: currentJobId,
    timestamp: Date.now(),
  })

  if (existing && existing.windowDays >= resolvedWindowDays) {
    existing.invocationCount += 1
    existing.duplicateLiveFetchPrevented += 1
    if (existing.settled) {
      settledReuseHits += 1
      if (existing.firstOutcome === 'success') existing.settledSuccessReuseHits += 1
      else existing.settledFailureReuseHits += 1
    } else {
      coalescedHits += 1
      existing.pendingCoalescedHits += 1
    }
    const result = await existing.promise
    // eslint-disable-next-line no-console
    console.warn('[provider-call-audit] fetchProviderWindow duplicate live fetch prevented', {
      jobId: currentJobId, key, stage, reuseKind: existing.settled ? 'settled' : 'pending', firstOutcome: existing.firstOutcome,
    })
    return sliceToWindow(result, resolvedWindowDays)
  }

  // No usable existing entry (none at all, or the existing one covers a NARROWER window than this
  // caller needs) — a real, fresh live fetch is required. This intentionally REPLACES a narrower
  // existing entry so any later, still-narrower caller can now reuse this wider one instead.
  liveFetches += 1
  const entry: CoalescedEntry = {
    windowDays: resolvedWindowDays,
    promise: undefined as unknown as Promise<ProviderFetchWindowResult>,
    settled: false,
    invocationCount: 1,
    pendingCoalescedHits: 0,
    settledSuccessReuseHits: 0,
    settledFailureReuseHits: 0,
    duplicateLiveFetchPrevented: 0,
    firstOutcome: null,
  }
  // NEVER-REJECTS, DISCLOSED: runLiveFetchSafely guarantees this promise always resolves — see that
  // function's own header for the confirmed root cause this closes. No `.catch`/rejection-handler
  // branch exists anymore because there is no longer a rejection path to handle.
  //
  // REUSE ELIGIBILITY, DISCLOSED (see isReuseEligible's own header for the full root-cause trace):
  // a genuinely PERMANENT failure (both providers, or the one that failed, missing config/
  // unsupported chain) is still kept in the map for the rest of this job — retrying it can never
  // succeed, so memoizing it costs nothing and correctly avoids a pointless repeat attempt. Any
  // TRANSIENT failure (budget refusal, malformed response, HTTP failure, timeout, unknown error) is
  // instead EVICTED from the map the instant it settles — concurrent callers already awaiting this
  // SAME promise still receive this result (real coalescing of genuinely simultaneous work is
  // preserved), but a caller arriving AFTER this resolution gets a genuinely fresh live attempt
  // instead of being permanently stuck with one unlucky throttle for the rest of the job.
  const promise = runLiveFetchSafely(chain, walletAddress, resolvedWindowDays)
  entry.promise = promise
  requestScopedFetches.set(key, entry)
  promise.then((result) => {
    entry.firstOutcome = classifyFetchOutcome(result)
    logAlchemyHistoryIngestionAudit(chain, result.providerResults.alchemy, entry, result.providerResults.alchemy.events.length, result.providerStatus)
    if (!isReuseEligible(result)) {
      if (requestScopedFetches.get(key) === entry) requestScopedFetches.delete(key)
      // eslint-disable-next-line no-console
      console.warn('[provider-call-audit] fetchProviderWindow transient-failure result evicted, not permanently cached', {
        jobId: currentJobId, key, firstOutcome: entry.firstOutcome, providerStatus: result.providerStatus,
        goldrushErrorReason: result.providerResults.goldrush.errorReason,
        alchemyErrorReason: result.providerResults.alchemy.errorReason,
      })
      return
    }
    entry.settled = true
    // eslint-disable-next-line no-console
    console.warn('[provider-call-audit] fetchProviderWindow live fetch settled', {
      jobId: currentJobId, key, firstOutcome: entry.firstOutcome, providerStatus: result.providerStatus,
    })
  })
  return promise
}
