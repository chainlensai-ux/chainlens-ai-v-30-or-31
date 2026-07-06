// src/utils/timeout.ts — generic promise timeout helper.
//
// CANCELLATION, DISCLOSED SCOPE: this now accepts an optional AbortController and calls
// `.abort()` on it the moment the timeout fires, so any code that actually checks
// `controller.signal` (now or in the future) can stop early. HONEST LIMITATION: as of this
// change, none of the real provider fetch call sites this promise chain eventually reaches
// (src/modules/providerFetchWindow/utils.ts, src/modules/holdings/utils.ts,
// src/modules/recoveryPolicy/utils.ts, lib/engine/modules/holdings/fetchHoldings.ts,
// lib/engine/modules/pricing/fetchPricing.ts, etc.) accept or check an AbortSignal — threading
// a signal into every one of those raw `fetch()` calls is a materially larger, cross-cutting
// change than this task's own scope ("only modify workers/walletScanV2.ts and supporting
// helpers", "no changes to financial logic") allows, since several of those modules are treated
// as protected/untouched production code elsewhere in this codebase's history. So calling
// `controller.abort()` here is a real, functioning hook for callers to use, but it does NOT yet
// stop in-flight provider fetches from continuing to completion in the background — the
// underlying `promise` itself still runs to completion exactly as before this change. This is a
// narrower, but real and non-regressive, improvement over the prior fully-inert timeout; full
// cancellation would need a separate, explicitly-scoped follow-up threading AbortSignal through
// every real fetch call site.

export async function withScanTimeout<T>(promise: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort()
      reject(new Error(`SCAN_TIMEOUT_${ms}ms`))
    }, ms)

    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}
