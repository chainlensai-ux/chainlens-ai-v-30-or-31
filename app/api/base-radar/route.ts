import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    chain: "base",
    proxy: "/api/proxy/gt?network=base",
    message: "Fetch live Base chain pool data from /api/proxy/gt?network=base (GeckoTerminal via backend proxy)."
  });
}
