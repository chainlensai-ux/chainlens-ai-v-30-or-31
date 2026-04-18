// app/api/proxy/goldrush/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const path = request.nextUrl.searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { ok: false, error: "Missing path parameter" },
        { status: 400 }
      );
    }

    // Build the full URL correctly
    const url = `https://api.covalenthq.com/${path}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GOLDRUSH_API_KEY}`,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `Request failed with status ${response.status}`,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
