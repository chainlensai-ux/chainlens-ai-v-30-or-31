// GET /api/debug-rpc-usage — temporary diagnostic route exposing lib/server/rpcDebug.ts's
// in-process RPC-call log. Fully additive: new route, new helper file, and one instrumented
// call site (lib/server/v2Adapters.ts, a file this session built from scratch — not a V2 engine
// internal, not pre-existing production code).
//
// COVERAGE DISCLOSURE: this only reflects calls logged from lib/server/v2Adapters.ts's
// runV2Scan() — it does NOT capture the other ~13 real RPC call sites across this codebase
// (including 3 V2 engine internals — src/modules/providerFetchWindow, recoveryPolicy, holdings —
// and the legacy lib/server/walletSnapshot.ts). Instrumenting those was explicitly scoped out:
// doing so for real would mean modifying V2 internals (forbidden by this same task) and ~11 other
// existing production files, contradicting "fully additive." See lib/server/rpcDebug.ts's own
// header for the full disclosure. This buffer is also in-memory/per-instance only — it does not
// aggregate across Vercel's serverless fleet, same limitation as every other in-memory cache this
// codebase used before KV caching existed.

import { NextResponse } from "next/server";
import { rpcDebugLog } from "@/lib/server/rpcDebug";

export const dynamic = "force-dynamic";

function groupBy(arr: typeof rpcDebugLog, key: "chain" | "method" | "route"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k = item[key] || "unknown";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

export async function GET() {
  try {
    return NextResponse.json({
      ok: true,
      count: rpcDebugLog.length,
      recent: rpcDebugLog.slice(-50),
      summary: {
        byChain: groupBy(rpcDebugLog, "chain"),
        byMethod: groupBy(rpcDebugLog, "method"),
        byRoute: groupBy(rpcDebugLog, "route"),
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Debug RPC usage is currently unavailable." });
  }
}
