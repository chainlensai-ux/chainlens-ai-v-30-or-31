import { NextResponse } from "next/server";

export async function GET() {
  try {
    const wsUrl = "wss://io.dexscreener.com/dex/screener/pairs/base";

    return NextResponse.json({
      websocket: wsUrl,
      message: "Connect to this WebSocket from the frontend to get live Base chain pairs."
    });
  } catch (e) {
    return NextResponse.json(
      { error: "WebSocket setup failed", details: String(e) },
      { status: 500 }
    );
  }
}
