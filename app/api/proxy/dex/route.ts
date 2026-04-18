import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch("https://devworker.chainlensai.workers.dev/", {
      cache: "no-store"
    });

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
