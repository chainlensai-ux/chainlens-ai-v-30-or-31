// app/api/proxy/goldrush/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/server/rateLimit";

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// Only allow alphanumeric chars, slashes, dots, hyphens, underscores, and query strings
const SAFE_PATH = /^[a-zA-Z0-9/_\-:.?=&%+]+$/;

export async function GET(request: NextRequest) {
  // Require a bearer token in production — this proxy exposes server API credits.
  // Balances.tsx (the only client that calls this) is dead code, so in production
  // we block unauthenticated access entirely.
  if (process.env.NODE_ENV === "production") {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.length < 20) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
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
