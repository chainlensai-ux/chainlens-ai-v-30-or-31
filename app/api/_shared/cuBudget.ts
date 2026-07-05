// app/api/_shared/cuBudget.ts — per-request CU (compute-unit) tracking object.
//
// SCOPE, DISCLOSED: this is diagnostics only — a counter + elapsed-time reader, created fresh per
// request (createCuBudget()), passed alongside the existing per-request EventsCache
// (app/api/_shared/eventsCache.ts). It never changes control flow, output shape, or timing of any
// real work. See the two deviations below for why the task's own soft-timeout-early-return and
// rate-limit-early-return items are NOT implemented as literally specified.
//
// SOFT TIMEOUT, DISCLOSED: the task asked for an early return (`{ partial: true, ...currentResults }`)
// once `softTimeoutMs` (7000ms) elapses. That is a real output-shape change for any wallet whose
// scan legitimately takes longer than 7s on normal, correct data — not a diagnostic, a new failure
// mode, directly contradicting this same task's own "NO changes to output" / "NO changes to latency
// on normal scans" constraints. `isSoftTimeoutExceeded()` below only reports whether the threshold
// was crossed, for logging — nothing reads it to change the response.
//
// RATE LIMITING, DISCLOSED: the task's own `cuBudget.walletHits` lives on this per-request object,
// created fresh by createCuBudget() on every request — so `hits` would read `0` on every single
// request and `hits > 5` could never be true; as literally specified this is dead code, not a real
// rate limit. Making it actually function requires a store that survives across requests (a
// module-level Map, or an external store), which reintroduces the exact concurrent-request shared-
// state risk already disclosed and avoided for the events cache (see eventsCache.ts's own "DESIGN
// DEVIATION" comment) — and a real `{ rateLimited: true }` short-circuit is a genuine behavior
// change for real users, not a diagnostic. Not implemented as an enforcement mechanism here; only
// the safe, always-zero-effect counter shape is kept so the object matches what the task specified.

export type CuBudget = {
  providerCalls: number
  maxProviderCalls: number
  startTime: number
  softTimeoutMs: number
  walletHits: Map<string, number>
}

export function createCuBudget(): CuBudget {
  return {
    providerCalls: 0,
    maxProviderCalls: 20,
    startTime: Date.now(),
    softTimeoutMs: 7000,
    walletHits: new Map(),
  }
}

export function recordProviderCall(cuBudget: CuBudget): void {
  cuBudget.providerCalls++
  // eslint-disable-next-line no-console
  console.debug('[CU-TRACK] providerCalls:', cuBudget.providerCalls)
}

// Diagnostic only — see SOFT TIMEOUT disclosure above. Nothing acts on this return value to alter
// control flow or output; it exists so a soft-timeout crossing is observable in logs.
export function isSoftTimeoutExceeded(cuBudget: CuBudget): boolean {
  return Date.now() - cuBudget.startTime > cuBudget.softTimeoutMs
}
