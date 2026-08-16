// app/api/proxy/goldrush/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/server/rateLimit";
import { logRpcCall } from "@/lib/server/rpcDebug";
import { createAnonSupabaseClient } from "@/lib/supabase/userSettings";

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// Only allow alphanumeric chars, slashes, dots, hyphens, underscores, and query strings
const SAFE_PATH = /^[a-zA-Z0-9/_\-:.?=&%+]+$/;

// AUTH-CHECK FIX, DISCLOSED (security audit): the previous check only verified the Authorization
// header was "Bearer "-prefixed and >=20 characters long — never validated against Supabase, so
// any request with e.g. "Bearer aaaaaaaaaaaaaaaaaaaaaa" passed. Since this proxy spends this
// server's own paid GOLDRUSH_API_KEY credits against an operator-chosen upstream path (SAFE_PATH
// allows any Covalent API path, not one fixed endpoint), that made it a real, unauthenticated open
// proxy against a paid credential. Replaced with the same real Supabase token verification every
// other authenticated route in this codebase uses (anon.auth.getUser(token)), and — since this
// route's own comment already confirms its one caller (Balances.tsx) is dead code, meaning there is
// no legitimate unauthenticated caller today — applied in every environment, not just production.
async function verifyBearerToken(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return false;
  const anon = createAnonSupabaseClient();
  if (!anon) return false;
  try {
    const { data } = await anon.auth.getUser(token);
    return Boolean(data.user);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!(await verifyBearerToken(request))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!limiter.check(getClientIp(request))) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
  }

  try {
    const path = request.nextUrl.searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { ok: false, error: "Missing path parameter" },
        { status: 400 }
      );
    }

    // Block path traversal and unsafe characters
    if (!SAFE_PATH.test(path) || path.includes("..")) {
      return NextResponse.json(
        { ok: false, error: "Invalid path parameter" },
        { status: 400 }
      );
    }

    const url = `https://api.covalenthq.com/${path}`;

    logRpcCall({ route: "/api/proxy/goldrush", chain: path.split("/")[1] || "unknown", method: path });
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GOLDRUSH_API_KEY}`,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Upstream request failed`,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ ok: true, data });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request failed" },
      { status: 500 }
    );
  }
}
