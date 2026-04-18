import { NextResponse } from "next/server";

export async function GET() {
  const res = await fetch("https://api.dexscreener.com/latest/dex/pairs/base");
  const data = await res.json();
  return NextResponse.json(data);
}
