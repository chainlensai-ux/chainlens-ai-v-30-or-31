import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getVerifiedUserPlan } from "@/lib/supabase/userSettings";

// TRACKED-WALLETS ADD ROUTE, DISCLOSED (FOMO board integration). Whale Alerts' tracked_wallets
// table (docs/supabase-whale-alerts.sql) previously had no write path anywhere in the app — every
// existing consumer (app/api/whale-alerts/sync, app/api/whale-alerts/route.ts) only ever reads it;
// the ~60-66 rows are hand-seeded via docs/whale-wallets-seed.sql. The FOMO board's "Add to
// tracker" button needs a real mutation to push a discovered EVM wallet into this same table so the
// existing Sync pipeline picks it up on its next run — this route is that mutation, built to match
// the table's existing shape and RLS (service-role only) rather than inventing a parallel store.
//
// Gated the same way app/api/whale-alerts/sync/route.ts gates its own write action (free plan
// blocked) since this writes to the same shared, privileged tracked-wallet set.

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// GET returns just the set of currently-tracked addresses (no labels/confidence/etc — those are
// internal detail this endpoint has no reason to expose) so the FOMO board can mark rows "Tracked"
// without a separate per-row lookup.
export async function GET() {
  const db = getServiceClient();
  if (!db) return NextResponse.json({ ok: true, addresses: [] });
  const { data, error } = await db
    .from("tracked_wallets")
    .select("address")
    .eq("is_active", true);
  if (error) return NextResponse.json({ ok: false, error: "wallet_load_failed" }, { status: 500 });
  const addresses = (data ?? [])
    .map((row) => (typeof row.address === "string" ? row.address.toLowerCase() : null))
    .filter((a): a is string => a != null);
  return NextResponse.json({ ok: true, addresses });
}

export async function POST(request: Request) {
  const verifiedPlan = await getVerifiedUserPlan(request);
  if (verifiedPlan === "free") {
    return NextResponse.json(
      { ok: false, error: "Included in Pro and Elite.", planGate: { verifiedPlan, requiredPlan: "pro" } },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const rawAddress = typeof body?.address === "string" ? body.address.trim() : "";
  if (!EVM_ADDRESS_RE.test(rawAddress)) {
    return NextResponse.json({ ok: false, error: "A valid EVM (0x) wallet address is required." }, { status: 400 });
  }
  const normalizedAddress = rawAddress.toLowerCase();
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 200) || null : null;
  const source = typeof body?.source === "string" ? body.source.trim().slice(0, 100) || "fomo-board" : "fomo-board";

  const db = getServiceClient();
  if (!db) return NextResponse.json({ ok: false, error: "Service unavailable" }, { status: 503 });

  const { data: existing, error: lookupError } = await db
    .from("tracked_wallets")
    .select("id,is_active")
    .eq("address", normalizedAddress)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ ok: false, error: lookupError.message }, { status: 500 });

  if (existing) {
    if (existing.is_active) {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    // Previously deactivated (e.g. a stale/inactive row) — reactivate rather than error on the
    // unique(address) constraint by trying to insert a duplicate row.
    const { error: reactivateError } = await db
      .from("tracked_wallets")
      .update({ is_active: true })
      .eq("id", existing.id);
    if (reactivateError) return NextResponse.json({ ok: false, error: reactivateError.message }, { status: 500 });
    return NextResponse.json({ ok: true, status: "added" });
  }

  const { error: insertError } = await db.from("tracked_wallets").insert({
    address: normalizedAddress,
    label,
    category: "fomo_trader",
    source,
    is_active: true,
  });
  if (insertError) return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
  return NextResponse.json({ ok: true, status: "added" });
}
