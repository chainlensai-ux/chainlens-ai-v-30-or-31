import { NextResponse } from "next/server";
import { requireAuthenticatedUser, unauthorizedResponse } from "@/lib/server/requireAuth";

// AUTH-GUARD, DISCLOSED (auth hardening audit — "/api/base-radar" is explicitly named as needing
// an auth guard): this stub returns no real Base Radar data today (the actual feed lives at
// /api/radar, already guarded), but Base Radar is a Pro/Elite feature per PLAN_FEATURES, so this
// pointer route is gated the same way for consistency and to close the gap before any real data
// is ever wired into it.
export async function GET(req: Request) {
  if (!(await requireAuthenticatedUser(req))) return unauthorizedResponse();
  return NextResponse.json({
    chain: "base",
    proxy: "/api/proxy/gt?network=base",
    message: "Fetch live Base chain pool data from /api/proxy/gt?network=base (GeckoTerminal via backend proxy)."
  });
}
