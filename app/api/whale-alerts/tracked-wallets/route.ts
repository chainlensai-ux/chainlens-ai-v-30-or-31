import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getVerifiedUserPlan } from "@/lib/supabase/userSettings";
import { requireAuthenticatedUser, unauthorizedResponse } from "@/lib/server/requireAuth";

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
//
// FOMO-ADD-RETRY-BUG FIX, DISCLOSED (live report: "clicking + Add does not visibly work" / "add
// failed shows Retry with no reason"). Root-caused to a shared bug in getVerifiedUserPlan
// (lib/supabase/userSettings.ts) — fixed there, see that file's own disclosure — but two more
// things in THIS route made a failure invisible even after that fix: (1) every error path returned
// only a generic message, never surfaced to the row's Retry state client-side; (2) there was no way
// to tell "plan blocked" from "RLS blocked" from "genuinely failed insert" apart. Both fixed below
// via the fomoAddTrackerAudit object every response now carries.

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Postgres error codes surfaced by PostgREST for conditions this route needs to tell apart in its
// audit — never inferred from message text, which can change wording across Postgres versions.
const PG_UNDEFINED_COLUMN = "42703";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type ServiceClient = ReturnType<typeof getServiceClient>;

async function activeWalletCount(db: NonNullable<ServiceClient>): Promise<number | null> {
  const { count, error } = await db
    .from("tracked_wallets")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);
  if (error) return null;
  return count ?? null;
}

// GET returns just the set of currently-tracked addresses (no labels/confidence/etc — those are
// internal detail this endpoint has no reason to expose) so the FOMO board can mark rows "Tracked"
// without a separate per-row lookup. Also returns the count directly so the UI never has to trust
// addresses.length as a proxy for "how many wallets are tracked" if that ever diverges.
export async function GET(request: Request) {
  // AUTH-GUARD, DISCLOSED (auth hardening audit — "fomo/whale elite endpoints" must require
  // sign-in): this route previously had no auth check at all — Whale Alerts is a Pro/Elite feature
  // (PLAN_FEATURES), so its tracked-wallet set should not be readable by a signed-out caller.
  if (!(await requireAuthenticatedUser(request))) return unauthorizedResponse();
  const db = getServiceClient();
  if (!db) return NextResponse.json({ ok: true, addresses: [], count: 0 });
  const { data, error } = await db
    .from("tracked_wallets")
    .select("address")
    .eq("is_active", true);
  if (error) return NextResponse.json({ ok: false, error: "wallet_load_failed" }, { status: 500 });
  const addresses = (data ?? [])
    .map((row) => (typeof row.address === "string" ? row.address.toLowerCase() : null))
    .filter((a): a is string => a != null);
  return NextResponse.json({ ok: true, addresses, count: addresses.length });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;

  // FOMO-ADD METADATA, DISCLOSED: address is the only thing that was ever accepted/stored before —
  // requested to also carry chainSlug/source/fomoHandle/fomoRank/fomoWindow/tags so a tracked
  // wallet's origin (which FOMO board rank/window it came from) is provable, not just its address.
  // Handle is read for the label/metadata only — it is NEVER itself treated as, or validated as, a
  // wallet address (hard rule: never add a FOMO handle as a wallet).
  const rawAddress = typeof body?.address === "string" ? body.address.trim() : "";
  const fomoHandle = typeof body?.fomoHandle === "string" ? body.fomoHandle.trim().slice(0, 100) || null : null;
  const fomoRank = typeof body?.fomoRank === "number" && Number.isFinite(body.fomoRank) ? body.fomoRank : null;
  const fomoWindow = typeof body?.fomoWindow === "string" ? body.fomoWindow.trim().slice(0, 20) || null : null;
  const chainSlug = typeof body?.chainSlug === "string" && body.chainSlug.trim() ? body.chainSlug.trim().slice(0, 40) : "base";
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 200) || null : (fomoHandle ? `FOMO: ${fomoHandle}` : null);
  const source = typeof body?.source === "string" ? body.source.trim().slice(0, 100) || "fomo" : "fomo";
  const tags = Array.isArray(body?.tags) ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 10) : [];

  const evmWalletValid = EVM_ADDRESS_RE.test(rawAddress);

  const audit: Record<string, unknown> = {
    handle: fomoHandle,
    rank: fomoRank,
    evmWallet: evmWalletValid ? rawAddress.toLowerCase() : rawAddress || null,
    evmWalletValid,
    source,
    alreadyTracked: false,
    mutationRouteCalled: "/api/whale-alerts/tracked-wallets",
    mutationStatus: null as number | null,
    supabaseInsertAttempted: false,
    supabaseInsertSucceeded: false,
    rlsBlocked: false,
    planBlocked: false,
    trackedWalletCountBefore: null as number | null,
    trackedWalletCountAfter: null as number | null,
    syncWillIncludeWallet: false,
    errorReason: null as string | null,
  };

  if (!evmWalletValid) {
    audit.mutationStatus = 400;
    audit.errorReason = "invalid_evm_address";
    return NextResponse.json({ ok: false, error: "A valid EVM (0x) wallet address is required.", fomoAddTrackerAudit: audit }, { status: 400 });
  }

  const verifiedPlan = await getVerifiedUserPlan(request);
  if (verifiedPlan === "free") {
    audit.planBlocked = true;
    audit.mutationStatus = 403;
    audit.errorReason = "plan_blocked";
    return NextResponse.json(
      { ok: false, error: "Included in Pro and Elite.", planGate: { verifiedPlan, requiredPlan: "pro" }, fomoAddTrackerAudit: audit },
      { status: 403 },
    );
  }

  const normalizedAddress = rawAddress.toLowerCase();
  audit.evmWallet = normalizedAddress;

  const db = getServiceClient();
  if (!db) {
    audit.mutationStatus = 503;
    audit.errorReason = "service_unavailable";
    return NextResponse.json({ ok: false, error: "Service unavailable", fomoAddTrackerAudit: audit }, { status: 503 });
  }

  audit.trackedWalletCountBefore = await activeWalletCount(db);

  const { data: existing, error: lookupError } = await db
    .from("tracked_wallets")
    .select("id,is_active")
    .eq("address", normalizedAddress)
    .maybeSingle();
  if (lookupError) {
    audit.mutationStatus = 500;
    audit.errorReason = lookupError.code === PG_INSUFFICIENT_PRIVILEGE ? "rls_blocked_on_lookup" : "lookup_failed";
    audit.rlsBlocked = lookupError.code === PG_INSUFFICIENT_PRIVILEGE;
    return NextResponse.json({ ok: false, error: lookupError.message, fomoAddTrackerAudit: audit }, { status: 500 });
  }

  if (existing?.is_active) {
    audit.alreadyTracked = true;
    audit.mutationStatus = 200;
    audit.trackedWalletCountAfter = audit.trackedWalletCountBefore;
    audit.syncWillIncludeWallet = true;
    return NextResponse.json({ ok: true, status: "duplicate", alreadyTracked: true, fomoAddTrackerAudit: audit });
  }

  // Metadata columns (chain_slug/tags/fomo_handle/fomo_rank/fomo_window) are additive —
  // docs/supabase-whale-alerts.sql documents the migration, but a production DB that hasn't had it
  // applied yet must never make Add fail outright. Try the full row first; on a genuine "column
  // does not exist" error (42703, never inferred from message text), retry with just the columns
  // that have always existed, so the wallet still gets tracked either way.
  const fullRow = {
    address: normalizedAddress,
    label,
    category: "fomo_trader",
    source,
    is_active: true,
    chain_slug: chainSlug,
    tags,
    fomo_handle: fomoHandle,
    fomo_rank: fomoRank,
    fomo_window: fomoWindow,
  };
  const baseRow = { address: normalizedAddress, label, category: "fomo_trader", source, is_active: true };

  audit.supabaseInsertAttempted = true;

  async function upsertOrInsert(row: Record<string, unknown>) {
    if (existing) {
      return db!.from("tracked_wallets").update(row).eq("id", existing.id);
    }
    return db!.from("tracked_wallets").insert(row);
  }

  let { error: writeError } = await upsertOrInsert(fullRow);
  if (writeError && writeError.code === PG_UNDEFINED_COLUMN) {
    ({ error: writeError } = await upsertOrInsert(baseRow));
  }

  if (writeError) {
    audit.mutationStatus = 500;
    audit.rlsBlocked = writeError.code === PG_INSUFFICIENT_PRIVILEGE;
    audit.errorReason = audit.rlsBlocked ? "rls_blocked_on_write" : "write_failed";
    audit.trackedWalletCountAfter = await activeWalletCount(db);
    return NextResponse.json({ ok: false, error: writeError.message, fomoAddTrackerAudit: audit }, { status: 500 });
  }

  audit.supabaseInsertSucceeded = true;
  audit.mutationStatus = 200;
  audit.syncWillIncludeWallet = true;
  audit.trackedWalletCountAfter = await activeWalletCount(db);

  return NextResponse.json({ ok: true, status: "added", alreadyTracked: false, fomoAddTrackerAudit: audit });
}
