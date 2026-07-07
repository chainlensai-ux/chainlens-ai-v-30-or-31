// lib/server/globalRpcAudit.ts — global, cross-route Alchemy call audit (hidden-CU-burn task).
//
// SCOPE CORRECTION, DISCLOSED: this task's own wording assumed an Alchemy SDK client instance
// (`alchemy.core`/`.transact`/`.ws`), an `alchemyClient` export, an ethers.js provider pointed at
// Alchemy, and client-side ("React hook") Alchemy usage. Verified by search before writing this
// file: NONE of those exist anywhere in this codebase. Every real Alchemy call, everywhere in this
// repo, is a plain `fetch()` POST to a hand-built `https://<network>.g.alchemy.com/v2/<key>` URL —
// same pattern already documented in lib/server/alchemyAudit.ts for the scan pipeline's three call
// sites. There is also zero client-side ('use client') code that ever touches Alchemy — doing so
// would require shipping a real API key to the browser, which nothing in this codebase does. So
// requirement 1's "wrap alchemy.core/transact/ws" and requirement 7's "React hook detector" have no
// real target; this module instruments the pattern that actually exists instead.
//
// WHY A SEPARATE MODULE FROM lib/server/alchemyAudit.ts, DISCLOSED: that file is the scan
// pipeline's own audit registry, explicitly in scope for the scan-worker tasks this session has
// already shipped (per-module RPC threshold, per-scan RPC budget) — this task explicitly says NOT
// to touch the scan worker/modules/RPC budget. This is a distinct registry for the OTHER, non-scan-
// pipeline call sites (test/diagnostic routes, dev-wallet, scan-holder, whale-alerts, lpProof), so
// instrumenting them can never interact with or change the scan pipeline's own counters/behavior.
//
// /tmp/alchemy-audit.log, DISCLOSED WHY NOT USED: this task's own spec suggested writing to
// /tmp/alchemy-audit.log. On this codebase's real deployment target (Vercel serverless functions),
// /tmp is ephemeral PER INVOCATION — it does not persist or accumulate across requests, and
// concurrent invocations don't share a filesystem at all. A burst/poll-loop detector needs state
// that survives across requests within one warm instance, which is exactly what a module-level
// in-memory Map already provides (the same pattern lib/server/alchemyAudit.ts already uses) — a
// per-invocation temp file would be strictly worse for this purpose, not better. Logging via
// console.info/console.warn instead, which Vercel's real log aggregation already collects centrally
// across invocations — the actually useful sink for this data in production.

export type GlobalRpcAuditCall = {
  method: string
  params: unknown
  timestamp: number
  callerFile: string
}

// EVENT QUEUE, DISCLOSED (browser-visible-audit-feed task): additive only — every push here happens
// alongside the existing console.info/console.warn calls below, never instead of them. Consumed by
// app/api/debug/rpc-audit-stream/route.ts via drainAuditEventQueue(), which empties it on each SSE
// flush; if nothing is draining it (no debug stream connected), MAX_QUEUE_SIZE bounds memory the
// same way MAX_ENTRIES_PER_CALLER already does for callsByCaller.
export type AuditEvent = {
  type: 'call' | 'burst' | 'poll'
  callerFile: string
  method: string
  timestamp: number
  count: number
}

const MAX_QUEUE_SIZE = 1000
const auditEventQueue: AuditEvent[] = []

function pushAuditEvent(event: AuditEvent): void {
  auditEventQueue.push(event)
  if (auditEventQueue.length > MAX_QUEUE_SIZE) auditEventQueue.shift()
}

const MAX_ENTRIES_PER_CALLER = 500 // bounds memory on a long-lived warm instance; oldest entries drop first
const BURST_WINDOW_MS = 5_000
const BURST_THRESHOLD = 50
const POLL_MIN_SAMPLES = 4
const POLL_MIN_INTERVAL_MS = 1_000
const POLL_MAX_INTERVAL_MS = 5_000
const POLL_INTERVAL_TOLERANCE_MS = 250

const callsByCaller = new Map<string, GlobalRpcAuditCall[]>()

// STACK-TRACE CALLER EXTRACTION, DISCLOSED: `new Error().stack` includes this file's own frame
// (auditGlobalAlchemyCall/extractCallerFile) plus Node/Next.js internal frames before reaching the
// real caller — skips this file and any node_modules/node:internal frame, returns the first
// remaining `/path/to/file.ts:line:col` match. Best-effort: returns 'unknown' if no frame parses
// (e.g. a minified production bundle with no readable paths) rather than throwing.
function extractCallerFile(stack: string | undefined): string {
  if (!stack) return 'unknown'
  const lines = stack.split('\n').slice(1) // drop the "Error" header line
  for (const line of lines) {
    if (line.includes('globalRpcAudit.ts')) continue
    if (line.includes('node_modules')) continue
    if (line.includes('node:internal')) continue
    const match = line.match(/(\/[^\s():]+):(\d+):(\d+)/)
    if (match) return match[1]
  }
  return 'unknown'
}

function detectBurst(callerFile: string, entries: GlobalRpcAuditCall[], method: string): void {
  const cutoff = Date.now() - BURST_WINDOW_MS
  const recent = entries.filter((e) => e.timestamp >= cutoff)
  if (recent.length > BURST_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn('[GLOBAL-RPC-AUDIT] BURST DETECTED', { callerFile, method, count: recent.length, windowMs: BURST_WINDOW_MS })
    pushAuditEvent({ type: 'burst', callerFile, method, timestamp: Date.now(), count: recent.length })
  }
}

// POLL-LOOP DETECTION, DISCLOSED: looks at the gaps between the last POLL_MIN_SAMPLES calls from
// this exact caller file. If every gap falls within [POLL_MIN_INTERVAL_MS, POLL_MAX_INTERVAL_MS]
// and all gaps are within POLL_INTERVAL_TOLERANCE_MS of their own average, that's a real,
// suspiciously-regular interval — the signature of a setInterval/polling loop, not organic,
// irregularly-timed user-triggered traffic.
function detectPollLoop(callerFile: string, entries: GlobalRpcAuditCall[], method: string): void {
  if (entries.length < POLL_MIN_SAMPLES) return
  const recent = entries.slice(-POLL_MIN_SAMPLES)
  const intervals: number[] = []
  for (let i = 1; i < recent.length; i++) intervals.push(recent[i].timestamp - recent[i - 1].timestamp)
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
  if (avg < POLL_MIN_INTERVAL_MS || avg > POLL_MAX_INTERVAL_MS) return
  const allWithinTolerance = intervals.every((i) => Math.abs(i - avg) <= POLL_INTERVAL_TOLERANCE_MS)
  if (allWithinTolerance) {
    // eslint-disable-next-line no-console
    console.warn('[GLOBAL-RPC-AUDIT] POLL LOOP DETECTED', { callerFile, method, intervalMs: Math.round(avg) })
    pushAuditEvent({ type: 'poll', callerFile, method, timestamp: Date.now(), count: entries.length })
  }
}

// Call this at every real (non-scan-pipeline) Alchemy fetch call site. Never throws — a logging/
// detection failure must never break the real call it's instrumenting.
export function auditGlobalAlchemyCall(method: string, params: unknown): void {
  try {
    const callerFile = extractCallerFile(new Error().stack)
    const entry: GlobalRpcAuditCall = { method, params, timestamp: Date.now(), callerFile }

    // eslint-disable-next-line no-console
    console.info('[GLOBAL-RPC-AUDIT]', JSON.stringify({ method, callerFile, timestamp: entry.timestamp }))

    const existing = callsByCaller.get(callerFile) ?? []
    existing.push(entry)
    if (existing.length > MAX_ENTRIES_PER_CALLER) existing.shift()
    callsByCaller.set(callerFile, existing)

    pushAuditEvent({ type: 'call', callerFile, method, timestamp: entry.timestamp, count: existing.length })

    detectBurst(callerFile, existing, method)
    detectPollLoop(callerFile, existing, method)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[GLOBAL-RPC-AUDIT] audit itself failed (never affects the real call)', err instanceof Error ? err.message : String(err))
  }
}

// Test/diagnostic support — not called anywhere in real request handling.
export function resetGlobalRpcAudit(): void {
  callsByCaller.clear()
  auditEventQueue.length = 0
}

export function getGlobalRpcAuditSnapshot(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [caller, entries] of callsByCaller.entries()) out[caller] = entries.length
  return out
}

// Called by app/api/debug/rpc-audit-stream/route.ts on each SSE flush — returns everything queued
// since the last drain and empties the queue (per requirement 3, "clear events after sending to
// avoid duplicates"). Safe to call with no SSE stream connected too (just returns []).
export function drainAuditEventQueue(): AuditEvent[] {
  const drained = auditEventQueue.slice()
  auditEventQueue.length = 0
  return drained
}
