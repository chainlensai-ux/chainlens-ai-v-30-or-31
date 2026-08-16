// GET /api/debug-rpc-usage — temporary diagnostic route exposing lib/server/rpcDebug.ts's
// in-process RPC-call log.
//
// COVERAGE (kept current — see lib/server/rpcDebug.ts's own header for the full, up-to-date list;
// this comment previously went stale after coverage was expanded in later work and is deliberately
// kept short here to avoid recurring): every real Alchemy/GoldRush/Covalent call site in the
// codebase now logs here, across both legacy app/api/* routes and the V2 engine's fetch modules.
// This buffer is in-memory/per-instance only — it does not aggregate across Vercel's serverless
// fleet, same limitation as every other in-memory cache this codebase used before KV caching
// existed.
//
// GATING, DISCLOSED (security audit): this was the one sibling diagnostic route missing the
// production admin gate every other one in this family already has (app/api/cu-diagnostics,
// app/api/diagnostics/pricing, app/api/diagnostics/pricing-source, app/api/diagnostics/divergence
// all require ADMIN_SECRET in production) — publicly exposed internal RPC call volume/routing
// metadata and sanitized-but-real stack fragments (module structure) with no auth at all. Same
// exact convention applied here: unrestricted in development, requires ADMIN_SECRET as a Bearer
// token in production. No data shape changed — same response for an authorized caller as before.

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

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!process.env.ADMIN_SECRET || token !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "Not available in production" }, { status: 404 });
    }
  }
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
