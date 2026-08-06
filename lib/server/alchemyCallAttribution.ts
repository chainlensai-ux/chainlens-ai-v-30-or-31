// MODULE — alchemyCallAttribution (Alchemy cost-audit follow-up task, issue #3 — confirmed
// production gap: [provider-call-audit]/[wallet-provider-cost-audit] logs show only
// alchemy_getAssetTransfers volume for a Wallet Scanner job, while the Alchemy dashboard reports a
// large, unexplained eth_getBalance CU total elsewhere. The Wallet Scanner worker's own logs simply
// have no eth_getBalance entries at all — proving that whatever is generating that dashboard total
// is not visible from this worker's existing logging, and therefore cannot currently be attributed
// to a specific route/worker/module/chain/job by anyone reading these logs).
//
// PURPOSE, DISCLOSED: a single, real, pure logging choke point every real eth_getBalance call site
// in this codebase calls THROUGH — never a network call of its own, never a behavior change to the
// call it wraps. Prints route/worker/module/chain/jobId/scanMode and a non-reversible key
// fingerprint (never the raw key) for every eth_getBalance attempt, so a live deployment's own logs
// can directly answer "which route/worker/chain/job issued this call" instead of only a bare method
// name. If a future eth_getBalance call site is ever added anywhere outside this module's own
// callers, its CU usage will be genuinely invisible to this attribution — the fix for that is to
// route the new call site through here too, not to widen this file's own scope speculatively.

// KEY FINGERPRINT, DISCLOSED: a short, non-reversible fragment (last 4 characters) — enough to
// distinguish "was this the same key as last time" in a log line without ever printing a usable
// credential. `null` when no key was supplied (e.g. a public RPC fallback with no Alchemy key at
// all), never a fabricated fingerprint.
export function fingerprintAlchemyKey(key: string | null | undefined): string | null {
  if (!key || key.length === 0) return null
  return key.length <= 4 ? `***${key}` : `***${key.slice(-4)}`
}

export type AlchemyCallAttribution = {
  route: string
  // 'worker' distinguishes the in-process wallet-scan worker (workers/walletScanV2.ts) from a
  // direct API route call — both null when neither applies (a route calling this directly).
  worker: string | null
  module: string | null
  chain: string
  jobId: string | null
  scanMode: string | null
  method: string
  keyFingerprint: string | null
}

// console.warn (never log/debug) — same convention as every other production-surviving diagnostic
// in this codebase (next.config's compiler.removeConsole strips log/info/debug from the production
// build, warn/error do not).
export function logAlchemyCallAttribution(attribution: AlchemyCallAttribution): void {
  try {
    // eslint-disable-next-line no-console
    console.warn('[alchemy-call-attribution]', attribution)
  } catch {
    // Never throws, never surfaces to the caller — a logging failure must never break a real call.
  }
}
