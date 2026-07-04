// POST /api/scan-v2/full-scan-edge — Edge Function variant of the unified full scan.
//
// STATUS: ADDITIVE, NOT WIRED UP. This is a new, parallel route — the frontend (`scanWalletV2` in
// app/frontend/api/scanWallet.ts) still calls the existing synchronous
// `/api/scan-v2/full-scan/route.ts` (Node runtime), which is left completely untouched. Switching
// the frontend to call this route instead is a separate, deliberate decision this task didn't ask
// for ("do not modify frontend UI components") — this file exists so that decision CAN be made
// later, once its real Edge-compatibility (see below) is confirmed against an actual Vercel Edge
// deployment, which this sandbox cannot do.
//
// EDGE COMPATIBILITY, HONESTLY DISCLOSED (not just asserted): Vercel's Edge runtime forbids Node
// built-ins (`fs`, `net`, `Buffer`-heavy code, etc.) and only supports a subset of the Node API.
// Two real dependencies sit in this route's call graph:
//   - viem (used by src/modules/pricingAtTimeEngine/sources/basedex.ts for on-chain DEX pricing) —
//     genuinely Edge-safe. viem's `http()` transport is fetch-based with no Node-only APIs; this is
//     a well-established, widely-used-on-Edge library, not a guess.
//   - @covalenthq/client-sdk (GoldRushClient, used by src/pipeline/index.ts's buildPriceSources and
//     lib/providers/goldrush.ts) — checked its dist/ output directly: `graphql-ws`/`graphqurl` (its
//     only WebSocket/Node-flavored dependencies) are referenced ONLY by its separate
//     `StreamingService` module, which nothing in this codebase imports or calls. The REST-based
//     methods this codebase actually uses (balances/pricing) appear to be plain fetch/HTTP calls.
//     This is a real, code-verified signal that the SDK's core methods are LIKELY Edge-compatible —
//     but "likely, based on static inspection of the bundled dist output" is not the same as
//     "verified," since bundler behavior and any deeper transitive Node dependency can only be
//     confirmed by an actual Edge deployment test, which is outside what this sandbox can perform.
// No `fs`/`net`/`Buffer` usage was found anywhere in the real V2 scan call graph itself (the one
// `Buffer.from(...)` call in this codebase lives in lib/server/walletSnapshot.ts, the disabled V1
// legacy engine — not part of runWalletScanV2 at all).
//
// Recommendation: treat this as a promising, best-effort candidate to validate in a real staging
// deployment before relying on it — not a guaranteed drop-in replacement.

export const runtime = 'edge'

import { router } from '@/src/deployment/index'
import { handleApiError } from '@/src/deployment/api'

export async function POST(req: Request): Promise<Response> {
  try {
    const rawBody = await req.json().catch(() => null)
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    // Identical call to the existing Node-runtime full-scan route — same real, single-invocation
    // orchestrator, same never-throwing internal guarantees, same FinalReport-shaped response.
    const result = await router.handleScanRequest(rawBody, ip)

    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify(handleApiError(err)), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
