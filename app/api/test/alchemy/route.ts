import { NextRequest, NextResponse } from "next/server";

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
  const ip = getIp(req);
  // Block in production unless IP is whitelisted or internal
  if (process.env.NODE_ENV === "production") {
    const adminSecret = req.headers.get("x-admin-secret");
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ error: "Not available" }, { status: 404 });
    }
  }
  if (!checkRate(ip)) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }
  try {
    const key = process.env.ALCHEMY_ETHEREUM_KEY;
    if (!key) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 500 });
    const url = `https://eth-mainnet.g.alchemy.com/v2/${key}`;
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
