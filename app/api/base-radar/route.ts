import { NextResponse } from "next/server";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;

export async function GET() {
  if (!BASE_URL) {
    return NextResponse.json(
      {
        chain: "base",
        trending: [],
        error: "NEXT_PUBLIC_BASE_URL is not set",
      },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(`${BASE_URL}/api/proxy/dex`, {
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        {
          chain: "base",
          trending: [],
          error: "Base Radar upstream failed",
          status: res.status,
        },
        { status: 500 }
      );
    }

    const data = await res.json();

    const baseOnly = data.pairs?.filter(
      (p: { chainId: string }) => p.chainId === "base"
    ) || [];

    return NextResponse.json({
      chain: "base",
      trending: baseOnly,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        chain: "base",
        trending: [],
        error: "Base Radar failed",
        details: (err as Error)?.message ?? "Unknown error",
      },
      { status: 500 }
    );
  }
}
