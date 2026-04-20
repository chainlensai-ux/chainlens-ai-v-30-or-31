import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { address } = await req.json();

  return NextResponse.json({
    ok: true,
    address,
    message: "Token scanner backend reached successfully.",
  });
}
