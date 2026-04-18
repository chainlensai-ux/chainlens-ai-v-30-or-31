import { NextResponse } from "next/server";

export async function GET() {
  try {
    const key = process.env.GOLDRUSH_API_KEY;
    const proxy = process.env.NEXT_PUBLIC_PROXY_URL;

    const res = await fetch(`${proxy}/proxy/v1/chains`, {
      headers: {
        Authorization: `Bearer ${key}`
      }
    });

    const text = await res.text();

    return NextResponse.json({ ok: true, raw: text });
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error });
  }
}
