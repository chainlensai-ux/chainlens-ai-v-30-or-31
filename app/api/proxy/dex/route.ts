import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    proxy: "/api/proxy/gt?network=base",
    message: "Use /api/proxy/gt?network=base to fetch live Base chain pool data from GeckoTerminal."
  });
}
