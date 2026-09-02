import { NextResponse } from "next/server";
import { fetchFomoLeaderboard, FOMO_ALLOWED_WINDOWS, type FomoWindow } from "@/lib/server/fomoApi";
import { getVerifiedUserPlan } from "@/lib/supabase/userSettings";
import { canAccessFomoBoard } from "@/lib/planFeatures";

// GET /api/fomo/leaderboard?window=24h&limit=100 — server-side, cached FOMO board read for the
// Whale Alerts "FOMO board" tab. Elite-only. This is the ONLY place the app talks to the FOMO API;
// the browser only ever calls this route. FOMO_API_KEY never leaves lib/server/fomoApi.ts and is
// never included in this route's response. Non-Elite callers receive 403 and never trigger a FOMO fetch.

const DEFAULT_WINDOW: FomoWindow = "24h";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export const FOMO_BOARD_ELITE_REQUIRED = {
  error: "elite_required",
  message: "FOMO Board requires Elite.",
} as const;

export function authorizeFomoLeaderboardRequest(plan: string | null | undefined):
  | { allowed: true }
  | { allowed: false; status: 403; body: typeof FOMO_BOARD_ELITE_REQUIRED } {
  if (canAccessFomoBoard(plan)) return { allowed: true };
  return { allowed: false, status: 403, body: FOMO_BOARD_ELITE_REQUIRED };
}

function errorMessage(reason: string | null): string {
  switch (reason) {
    case "missing_api_key": return "FOMO board is not configured yet.";
    case "rate_limited": return "FOMO API rate limit reached. Try again shortly.";
    case "http_error": return "FOMO API returned an error. Try again shortly.";
    case "timeout": return "FOMO API took too long to respond. Try again shortly.";
    case "network_error": return "Could not reach the FOMO API. Try again shortly.";
    default: return "FOMO board is temporarily unavailable.";
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const url = new URL(request.url);

  const rawWindow = url.searchParams.get("window") ?? DEFAULT_WINDOW;
  if (!FOMO_ALLOWED_WINDOWS.includes(rawWindow as FomoWindow)) {
    return NextResponse.json(
      { ok: false, error: `Invalid window. Allowed: ${FOMO_ALLOWED_WINDOWS.join(", ")}.` },
      { status: 400 },
    );
  }
  const window = rawWindow as FomoWindow;

  const verifiedPlan = await getVerifiedUserPlan(request);
  const access = authorizeFomoLeaderboardRequest(verifiedPlan);
  if (!access.allowed) {
    return NextResponse.json(access.body, { status: access.status });
  }

  const rawLimitParam = url.searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? DEFAULT_LIMIT : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT;

  const result = await fetchFomoLeaderboard(window, limit);

  const evmResolvedCount = result.traders.filter(t => t.canAddToBaseTracker).length;
  const solOnlyCount = result.traders.filter(t => t.walletStatus === "sol_only").length;
  const walletPendingCount = result.traders.filter(t => t.walletStatus === "pending" || t.walletStatus === "unresolved").length;

  const fomoLeaderboardAudit = {
    window,
    limit,
    cacheHit: result.cacheHit,
    cacheAgeMs: result.cacheAgeMs,
    apiCalled: result.apiCalled,
    status: result.status,
    rateLimit: result.rateLimit,
    rateRemaining: result.rateRemaining,
    tradersReturned: result.traders.length,
    evmResolvedCount,
    solOnlyCount,
    walletPendingCount,
    durationMs: Date.now() - startedAt,
    errorReason: result.errorReason,
  };

  // A hard failure with nothing to show (no traders at all, including no stale cache to fall back
  // on) surfaces as a real error status; anything with traders — even served from a stale cache
  // after a 429 — is a 200 with an honest errorReason in the audit, so the UI can show data plus a
  // "showing cached data" note instead of a blank error screen.
  if (!result.ok && result.traders.length === 0) {
    const status = result.errorReason === "rate_limited" ? 429 : result.errorReason === "missing_api_key" ? 503 : 502;
    return NextResponse.json({ ok: false, error: errorMessage(result.errorReason), fomoLeaderboardAudit }, { status });
  }

  return NextResponse.json({ ok: true, window, limit, traders: result.traders, fomoLeaderboardAudit });
}
