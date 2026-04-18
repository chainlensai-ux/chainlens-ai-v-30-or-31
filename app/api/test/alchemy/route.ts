import { NextResponse } from "next/server";

export async function GET() {
  try {
    const key = process.env.ALCHEMY_ETHEREUM_KEY;
    const url = `https://eth-mainnet.g.alchemy.com/v2/${key}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "1",
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: []
      })
    });

    const data = await res.json();
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error });
  }
}
