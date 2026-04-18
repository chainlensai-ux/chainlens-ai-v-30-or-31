import { NextResponse } from "next/server";

export async function GET() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/proxy/dex`, {
      cache: "no-store"
    });

    const data = await res.json();

    const baseOnly = data.pairs?.filter((p: { chainId: string }) => p.chainId === "base") || [];

    return NextResponse.json({
      chain: "base",
      trending: baseOnly
    });
  } catch (err) {
    return NextResponse.json({
      chain: "base",
      trending: [],
      error: "Base Radar failed",
      details: (err as Error).message
    });
  }
}
