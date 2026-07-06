// src/utils/timeout.ts — generic promise timeout helper.
//
// NOTE: does not cancel/abort the underlying `promise` itself — that promise keeps running to
// completion (or failure) in the background even after this rejects with SCAN_TIMEOUT_<ms>ms; it
// only stops the CALLER from waiting on it past `ms`. This matches every other real timeout in
// this codebase (e.g. AbortSignal.timeout(...) on individual fetch calls elsewhere) in the sense
// that the caller gets a bounded wait, not in the sense of forcibly killing in-flight work — the
// underlying work here (runWalletScanV2Worker) has no cancellation hook to call even if this
// function wanted to.

export async function withScanTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
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
