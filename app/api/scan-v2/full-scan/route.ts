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

import { handleApiError } from '@/src/deployment/api'
import { runWalletScanV2Worker, logDirectFailure } from '@/workers/walletScanV2'

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    const { status, body } = await runWalletScanV2Worker(rawBody, ip)

    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // Last-resort guard only, matching app/api/scan/route.ts's own outer catch — fires only if
    // something fails before/outside runWalletScanV2Worker's own internal error handling (e.g. a
    // truly unexpected throw). Never leaks a raw stack trace or error object.
    logDirectFailure(err)
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
