import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    chain: "base",
    websocket: "wss://io.dexscreener.com/dex/screener/pairs/base",
    message: "Use this WebSocket in the frontend to stream live Base chain pairs and compute trending tokens client-side."
  });
}
