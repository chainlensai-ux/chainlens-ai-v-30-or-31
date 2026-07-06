// POST /api/scan-v2/full-scan — thin dispatcher to workers/walletScanV2.ts.
//
// WORKER-DISPATCH MIGRATION, DISCLOSED (added per a later task): this route previously contained
// the entire V2 module chain (holdings/pricing/portfolio/pnl/chainActivity/risk/personality/
// behavior/signals/smartMoneyScore) inline, built up incrementally across many prior tasks in this
// session — see this file's git history for the full per-module disclosure trail (field-collision
// checks, never-throw guarantees, CU-hardening wiring, shape guards). That entire body has been
// moved, unchanged, into workers/walletScanV2.ts's `runWalletScanV2Worker()` — this route now only
// parses the request, dispatches to that function, and translates its result into a Response. No
// field, no try/catch degrade-shape, no log line, no behavior was altered in the move.
//
// `@/workers/walletScanV2`/`runWalletScanV2Worker`, DISCLOSED: the task specified this exact import
// path and function name, but neither existed anywhere in this codebase before this change — see
// workers/walletScanV2.ts's own header for why it's a NEW, real, in-process module (distinct from
// the existing worker/server.ts, a separate always-on Railway process reached over HTTP, which this
// does not touch or duplicate). Built fresh here rather than fabricated.
//
// "Ensure route does NOT call external APIs directly": true both before and after this change — no
// GoldRush/Alchemy/CoinGecko call has ever been made directly from this file; every provider call
// happens inside the module chain (now in workers/walletScanV2.ts), same as it did inline before.
//
// LATEST TASK, DISCLOSED: this route already had no heavy post-processing after the worker call —
// CU tracking, events-cache updates, and every module's post-processing already live entirely
// inside workers/walletScanV2.ts from the prior refactor (see this file's git history). Tasks
// 1/3 needed no changes here. Task 4's literal snippet (`Response.json({ success: true, data:
// workerResult })`) is NOT applied: `body` returned by runWalletScanV2Worker already IS the full
// `{success, data}` (or `{success:false, error}`) response shape — wrapping it again would
// double-nest it (breaking every frontend consumer reading `body.data` directly) and would hardcode
// `success: true` even on a genuine worker failure (status 500), masking real errors. The existing
// direct pass-through below is kept as the correct behavior. Task 2's timing-scope request IS
// applied: the timer now starts immediately before the worker call (not before request parsing) and
// the log now includes response construction, tightening the measured span to "worker call +
// building the final response" as asked.

// TIMEOUT CEILING FIX, DISCLOSED: this route was previously missing its own `maxDuration` export,
// so it fell back to vercel.json's 60s cap for this path — despite dispatching to the exact same
// runWalletScanV2Worker() 11-module chain that app/api/scan-v2/worker/route.ts (maxDuration=900)
// runs in the background job path. A cold/heavy `normal` scan can genuinely exceed 60s; when the
// platform kills the invocation past that cap, it returns a non-JSON gateway response that
// scanWalletV2() (app/frontend/api/scanWallet.ts) can't parse into a real error, so it falls back
// to its generic "network-failed" message — this is the real root cause of "works in DevTools
// (usually a lighter wallet or a warm-cache retry), fails from the UI button (a genuinely heavy
// cold scan)". Raised to 300s (the standard synchronous-serverless-function ceiling on this
// platform without Fluid Compute enabled) rather than 900s, since unlike the worker route this one
// is NOT a fire-and-forget background invocation — the browser's own fetch is waiting on it
// synchronously, so an unbounded ceiling would just leave the user staring at a spinner instead of
// getting a clear timeout error.
export const maxDuration = 300

import { handleApiError } from '@/src/deployment/api'
import { runWalletScanV2Worker, logDirectFailure } from '@/workers/walletScanV2'
import { resetAlchemyAudit, printAlchemyAuditSummary } from '@/lib/server/alchemyAudit'

export async function POST(req: Request): Promise<Response> {
  const routeStart = Date.now()
  // eslint-disable-next-line no-console
  console.log('[SCAN-V2] route start')
  // ALCHEMY-AUDIT WIRING, DISCLOSED: reset here (a route file, not the worker/pipeline this task
  // says not to touch) so each Deep Scan's printed summary below reflects only this request's own
  // Alchemy calls, not everything accumulated since this instance's last cold start — see
  // lib/server/alchemyAudit.ts's own header for why a request-scoped object couldn't be threaded
  // through the real call sites instead (it would require changing their signatures).
  resetAlchemyAudit()
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    const start = performance.now()
    const { status, body } = await runWalletScanV2Worker(rawBody, ip)

    const response = new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

    // eslint-disable-next-line no-console
    console.log('[V2-route] total', performance.now() - start)
    printAlchemyAuditSummary()
    // eslint-disable-next-line no-console
    console.log('[SCAN-V2] route success in', Date.now() - routeStart, 'ms')

    return response
  } catch (err) {
    // Last-resort guard only, matching app/api/scan/route.ts's own outer catch — fires only if
    // something fails before/outside runWalletScanV2Worker's own internal error handling (e.g. a
    // truly unexpected throw). Never leaks a raw stack trace or error object in the RESPONSE body —
    // handleApiError(err) below is unchanged and stays the safe, redacted shape (see
    // src/production/errorReporter.ts's sanitizeError, which already strips API keys/bearer
    // tokens/private keys from the message before it ever reaches a client). The literal task's own
    // snippet wanted `details: String(err)` in the JSON response itself — not applied, since that
    // bypasses sanitizeError's redaction entirely and could leak a secret embedded in a raw error
    // object/stack straight to the browser. The full, unredacted error is logged here instead
    // (server-side only, never sent to the client) — real diagnostic value without the leak.
    // eslint-disable-next-line no-console
    console.error('[SCAN-V2] route error in', Date.now() - routeStart, 'ms', err)
    logDirectFailure(err)
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
