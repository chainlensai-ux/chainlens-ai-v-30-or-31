import { NextResponse } from "next/server";
import { scanTokenCommand } from "./commands/scan-token";

export async function POST(req: Request) {
  const { input } = await req.json();

  if (!input) {
    return NextResponse.json({ error: "No input provided" }, { status: 400 });
  }

  const lower = input.toLowerCase();

  // scan token command
  if (lower.startsWith("scan token")) {
    const address = input.split(" ")[2];
    return NextResponse.json(await scanTokenCommand(address));
  }

  return NextResponse.json({
    ok: false,
    message: "Unknown command",
  });
}
