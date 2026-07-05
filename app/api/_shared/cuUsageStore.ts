// app/api/_shared/cuUsageStore.ts — in-memory daily CU (provider-call) usage counter.
//
// SCOPE, DISCLOSED: diagnostic-only, matching the task's own literal shape (`Record<string,
// CuUsageRecord>` module-level object) — no new provider calls, no change to any scan's output or
// latency. recordCuUsage()/getCuUsageSummary() are read/write on plain in-memory state; nothing
// here can throw or block a request.
//
// DURABILITY CAVEAT, DISCLOSED: this is a per-instance in-memory object, not durable storage. In a
// serverless environment a warm instance's counts reset on cold start, and concurrent instances
// each keep their own independent copy — there is no single "last 24 hours" total across the whole
// deployment, only "since this particular instance's own last cold start." The task allowed this
// exact lightweight shape as one of its options ("JSON file or KV entry") but its own reference
// code is the in-memory object below; kept as specified since a real KV/file-backed store is a
// meaningfully bigger, less reversible change (new dependency or filesystem writes in a serverless
// function) than this task's "zero-overhead, additive" framing asked for. If a true durable daily
// total is needed later, this should be swapped for a real KV/DB write — not done here.

export type CuUsageRecord = {
  date: string // "2026-07-05"
  providerCalls: number
  cacheHits: number
}

const cuUsage: Record<string, CuUsageRecord> = {}

export function recordCuUsage(providerCalls: number, cacheHits: number): void {
  const today = new Date().toISOString().slice(0, 10)
  if (!cuUsage[today]) {
    cuUsage[today] = { date: today, providerCalls: 0, cacheHits: 0 }
  }
  cuUsage[today].providerCalls += providerCalls
  cuUsage[today].cacheHits += cacheHits
}

export function getCuUsageSummary(): Record<string, CuUsageRecord> {
  return cuUsage
}
