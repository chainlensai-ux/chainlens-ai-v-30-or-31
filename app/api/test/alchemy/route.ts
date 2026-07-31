import { NextRequest, NextResponse } from "next/server";
import { logRpcCall } from "@/lib/server/rpcDebug";
import { auditGlobalAlchemyCall } from "@/lib/server/globalRpcAudit";
import { isDevOnlyProviderRouteAllowed, devOnlyProviderRouteBlockedResponse } from "@/lib/server/devOnlyProviderRoute";
import { recordAlchemyUsage } from "@/lib/server/alchemyUsageAttribution";
import { estimatedCuForMethod } from "@/lib/server/alchemyCallBudget";

const rateMap = new Map<string, { count: number; resetAt: number }>();
const MAX_PER_MINUTE = 3;

function getIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function checkRate(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || entry.resetAt <= now) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= MAX_PER_MINUTE) return false;
  entry.count++;
  return true;
}

export async function GET(req: NextRequest) {
  // CU-LEAK AUDIT HARDENING, DISCLOSED (this task): ALWAYS blocked in production now — no
  // ADMIN_SECRET bypass. A bypass, however gated, is still a live path to a real Alchemy call in
  // production; this route is now local-development-only, with zero exception.
  if (!isDevOnlyProviderRouteAllowed()) {
    return devOnlyProviderRouteBlockedResponse();
  }
  const ip = getIp(req);
  if (!checkRate(ip)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }
  try {
    const key = process.env.ALCHEMY_ETHEREUM_KEY;
    if (!key) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 500 });
    const url = `https://eth-mainnet.g.alchemy.com/v2/${key}`;
    logRpcCall({ route: "/api/test/alchemy", chain: "eth", method: "eth_blockNumber" });
    auditGlobalAlchemyCall("eth_blockNumber", { chain: "eth", route: "/api/test/alchemy" });
    // USAGE ATTRIBUTION, DISCLOSED (this task) — see lib/server/alchemyUsageAttribution.ts's own
    // header: never logs the API key/wallet/token contents, only the shape of the call itself.
    recordAlchemyUsage({
      requestId: crypto.randomUUID(),
      route: "/api/test/alchemy",
      feature: "provider_connectivity_check",
      method: "eth_blockNumber",
      chain: "eth",
      cacheHit: false,
      userClassification: "anonymous",
      sourceCategory: "admin",
      estimatedCu: estimatedCuForMethod("eth_blockNumber"),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error });
  }
}
