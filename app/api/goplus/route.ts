import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createRateLimiter, getClientIp } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";

async function getAccessToken(key: string, secret: string): Promise<string | null> {
  try {
    const time = Math.floor(Date.now() / 1000);
    const sign = createHash("md5").update(key + time + secret).digest("hex").toUpperCase();
    const res = await fetch(`${GOPLUS_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_key: key, time, sign }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.result?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json(
      { ok: false, error: "Invalid or missing address parameter." },
      { status: 400 }
    );
  }

  try {
    const key    = process.env.GOPLUS_APP_KEY;
    const secret = process.env.GOPLUS_APP_SECRET;

    // Try authenticated request if credentials exist, else fall back to public API
    const headers: Record<string, string> = { accept: "application/json" };
    if (key && secret) {
      const token = await getAccessToken(key, secret);
      if (token) headers["Authorization"] = token;
    }

    const securityRes = await fetch(
      `${GOPLUS_BASE}/token_security/8453?contract_addresses=${address.toLowerCase()}`,
      { headers, cache: "no-store" }
    );

    if (!securityRes.ok) {
      return NextResponse.json(
        { ok: false, error: `GoPlus API returned ${securityRes.status}.` },
        { status: 502 }
      );
    }

    const securityJson = await securityRes.json();
    return NextResponse.json({ ok: true, data: securityJson?.result ?? {} });
  } catch {
    return NextResponse.json(
      { ok: false, error: "GoPlus request failed." },
      { status: 500 }
    );
  }
}

