import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch(
      "https://api.dexscreener.com/latest/dex/pairs/base",
      {
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: "DexScreener fetch failed" },
        { status: 500 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: "Proxy error", details: (err as Error)?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
