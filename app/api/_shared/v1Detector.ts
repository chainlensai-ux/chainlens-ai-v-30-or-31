// app/api/_shared/v1Detector.ts — diagnostic-only "is the frontend still falling back off the
// direct V2 scan route" detector.
//
// WHAT "V1" MEANS HERE, DISCLOSED: there is no dead/legacy "V1 engine" in this codebase to detect —
// src/pipeline/src/modules (via router.handleScanRequest) is the live production scanner, used by
// EVERY scan route, including the fallback route this file actually watches. Marking that real
// engine itself as "V1 triggered" would fire on every single scan regardless of path, which is the
// opposite of what this detector is for. "V1" is used here in the same sense a prior task in this
// session established: app/frontend/api/scanWallet.ts's scanWalletV2() tries the direct, synchronous
// /api/scan-v2/full-scan route first, and only falls back to the older job/poll route
// (/api/scan-v2/full-scan-job/start) on failure. markV1Triggered() is called from that job-route
// handler (see its own file), so `wasV1Triggered()` genuinely answers "has the frontend fallen back
// off the direct V2 route since this instance last restarted" — the real thing worth watching for.
//
// DURABILITY CAVEAT, DISCLOSED: same as cuUsageStore.ts — this is per-instance in-memory state, not
// durable storage. It resets on cold start and isn't shared across concurrent serverless instances.

let v1Triggered = false

export function markV1Triggered(context: string): void {
  v1Triggered = true
  // eslint-disable-next-line no-console
  console.warn('[V1-DETECTOR] V1 engine usage attempted:', context)
}

export function wasV1Triggered(): boolean {
  return v1Triggered
}
