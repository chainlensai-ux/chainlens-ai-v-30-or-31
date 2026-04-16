import { NextResponse } from "next/server";

export async function POST(req: Request) {
  return NextResponse.json({ ok: true, message: "scan-token backend placeholder" });
}
