// FOMO board (Whale Alerts) — server-only client for the FOMO API leaderboard.
//
// Requested: "Implement FOMO leaderboard integration on ChainLens Whale Alerts." Free-plan-safe by
// design — one endpoint only (GET /v2/leaderboard/{window}), 10-minute in-process cache so a burst
// of page loads never re-hits the upstream API, and clean handling of a 429 (serves the last known
// cache rather than failing the whole panel). FOMO_API_KEY is read here only, server-side — never
// forwarded to the client, never logged, never included in any returned payload.
//
// Deliberately NOT wired here (custom-plan-only per the FOMO API, out of scope for this pass):
// /v2/users/{handle}/trades, /v2/users/{handle}/balances, any websocket endpoint.

const FOMO_BASE_URL = "https://api.fomoapi.io";
export const FOMO_CACHE_TTL_MS = 10 * 60_000;
const FOMO_FETCH_TIMEOUT_MS = 10_000;

export type FomoWindow = "24h" | "7d" | "30d" | "all";
export const FOMO_ALLOWED_WINDOWS: readonly FomoWindow[] = ["24h", "7d", "30d", "all"];

export type FomoWalletStatus = "resolved" | "sol_only" | "pending" | "unresolved";

export type FomoTraderRow = {
  rank: number;
  handle: string;
  displayName: string | null;
  pnlUsd: number | null;
  volumeUsd: number | null;
  trades: number | null;
  followers: number | null;
  holdingsCount: number | null;
  solanaWallet: string | null;
  evmWallet: string | null;
  walletStatus: FomoWalletStatus;
  verified: boolean;
  topTokens: string[];
  canAddToBaseTracker: boolean;
};

/** Rank FOMO traders by most PnL (desc). Null PnL sorts last. Ranks are rewritten 1..N. */
export function rankFomoTradersByPnl(traders: FomoTraderRow[]): FomoTraderRow[] {
  return [...traders]
    .sort((a, b) => (b.pnlUsd ?? Number.NEGATIVE_INFINITY) - (a.pnlUsd ?? Number.NEGATIVE_INFINITY))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// Raw wallet field values that mean "still being resolved" rather than "known to be absent" — the
// FOMO API's own wording for this isn't documented here, so this is deliberately permissive: any of
// these markers (case-insensitive) is treated as "pending", never silently swallowed into
// "unresolved" (which would incorrectly imply the wallet was checked and found to not exist).
const PENDING_WALLET_MARKERS = new Set(["resolving", "pending", "unknown", "processing"]);

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A raw wallet field can come back as: a real address string, null/undefined (never resolved and
 * not pending), or a status marker string (still resolving). Splits those three cases apart instead
 * of collapsing "not returned" and "still resolving" into the same falsy value — the two need
 * different Add-button copy ("SOL only"/nothing to show vs. "Wallet pending").
 */
function readWalletField(value: unknown): { address: string | null; pending: boolean } {
  if (typeof value !== "string") return { address: null, pending: false };
  const trimmed = value.trim();
  if (!trimmed) return { address: null, pending: false };
  if (PENDING_WALLET_MARKERS.has(trimmed.toLowerCase())) return { address: null, pending: true };
  return { address: trimmed, pending: false };
}

/**
 * holdings is documented as a COUNT only, never a token list — reads either a bare number or an
 * object carrying a count field, and never treats an array/object as the holdings themselves.
 */
function readHoldingsCount(raw: Record<string, unknown>): number | null {
  const direct = raw.holdings;
  if (typeof direct === "number" || typeof direct === "string") return asFiniteNumber(direct);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const obj = direct as Record<string, unknown>;
    return asFiniteNumber(obj.count ?? obj.holdingsCount ?? obj.total ?? null);
  }
  return asFiniteNumber(raw.holdingsCount ?? raw.holdings_count ?? null);
}

export function normalizeFomoTrader(raw: unknown, fallbackIndex: number): FomoTraderRow {
  const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const walletsRaw = (r.wallets && typeof r.wallets === "object") ? r.wallets as Record<string, unknown> : {};

  const solana = readWalletField(walletsRaw.solana ?? r.solanaWallet ?? r.wallet_solana ?? null);
  const evmRaw = readWalletField(walletsRaw.evm ?? r.evmWallet ?? r.wallet_evm ?? null);
  const evmValid = evmRaw.address != null && EVM_ADDRESS_RE.test(evmRaw.address);
  const evmWallet = evmValid ? (evmRaw.address as string).toLowerCase() : null;

  const walletStatus: FomoWalletStatus = evmWallet
    ? "resolved"
    : (evmRaw.pending || (evmRaw.address != null && !evmValid))
      ? "pending"
      : (solana.address != null)
        ? "sol_only"
        : "unresolved";

  const topTokensRaw = Array.isArray(r.topTokens) ? r.topTokens : Array.isArray(r.top_tokens) ? r.top_tokens : [];
  const topTokens = topTokensRaw.filter((t): t is string => typeof t === "string").slice(0, 5);

  return {
    rank: asFiniteNumber(r.rank) ?? fallbackIndex + 1,
    handle: asString(r.handle) ?? asString(r.username) ?? `trader_${fallbackIndex + 1}`,
    displayName: asString(r.displayName) ?? asString(r.display_name) ?? asString(r.name),
    pnlUsd: asFiniteNumber(r.pnlUsd ?? r.pnl_usd ?? r.pnl),
    volumeUsd: asFiniteNumber(r.volumeUsd ?? r.volume_usd ?? r.volume),
    trades: asFiniteNumber(r.trades ?? r.tradeCount ?? r.trade_count),
    followers: asFiniteNumber(r.followers ?? r.followerCount ?? r.follower_count),
    holdingsCount: readHoldingsCount(r),
    solanaWallet: solana.address,
    evmWallet,
    walletStatus,
    verified: r.verified === true,
    topTokens,
    canAddToBaseTracker: evmWallet != null,
  };
}

export type FomoLeaderboardFetchResult = {
  ok: boolean;
  traders: FomoTraderRow[];
  cacheHit: boolean;
  cacheAgeMs: number | null;
  apiCalled: boolean;
  status: number | null;
  rateLimit: number | null;
  rateRemaining: number | null;
  durationMs: number;
  errorReason: string | null;
};

type CacheEntry = { at: number; result: FomoLeaderboardFetchResult };
const leaderboardCache = new Map<string, CacheEntry>();

/** Test-only: clears the in-process cache so each test run starts clean. */
export function clearFomoLeaderboardCache(): void {
  leaderboardCache.clear();
}

function parseRateHeader(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function freshResultFromCache(entry: CacheEntry, overrides: Partial<FomoLeaderboardFetchResult>, startedAt: number): FomoLeaderboardFetchResult {
  return {
    ...entry.result,
    cacheHit: true,
    cacheAgeMs: Date.now() - entry.at,
    durationMs: Date.now() - startedAt,
    ...overrides,
  };
}

// IN-FLIGHT DE-DUPE, DISCLOSED (live report: "one leaderboard load appears to cost multiple
// credits/requests"). The 10-minute cache only helps once a result is already stored — two
// concurrent callers for the same window+limit (React StrictMode's dev-only double effect
// invocation, a fast tab switch remounting the panel, two browser tabs open at once) both saw a
// cache MISS and BOTH called the real FOMO API, since the original check-then-fetch had no lock
// between the miss and the .set() that follows a successful fetch. A single shared in-flight
// Promise per cache key means every concurrent caller for the same key gets the one real request's
// result — one external call really does mean one external call, however many UI callers ask for
// it in that window.
const inFlight = new Map<string, Promise<FomoLeaderboardFetchResult>>();

export async function fetchFomoLeaderboard(window: FomoWindow, limit: number): Promise<FomoLeaderboardFetchResult> {
  const cacheKey = `${window}:${limit}`;
  const cached = leaderboardCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FOMO_CACHE_TTL_MS) {
    return freshResultFromCache(cached, { apiCalled: false }, Date.now());
  }
  const existingInFlight = inFlight.get(cacheKey);
  if (existingInFlight) return existingInFlight;

  const promise = fetchFomoLeaderboardUncached(window, limit, cacheKey, cached ?? null);
  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function fetchFomoLeaderboardUncached(
  window: FomoWindow,
  limit: number,
  cacheKey: string,
  cached: CacheEntry | null,
): Promise<FomoLeaderboardFetchResult> {
  const startedAt = Date.now();
  const apiKey = process.env.FOMO_API_KEY;
  if (!apiKey) {
    // No key configured — serve stale cache if we have any (better than nothing), otherwise a
    // clean, honest "not configured" result. Never a thrown error, never a crash.
    if (cached) return freshResultFromCache(cached, { apiCalled: false, errorReason: "missing_api_key_served_stale" }, startedAt);
    return { ok: false, traders: [], cacheHit: false, cacheAgeMs: null, apiCalled: false, status: null, rateLimit: null, rateRemaining: null, durationMs: Date.now() - startedAt, errorReason: "missing_api_key" };
  }

  try {
    const res = await fetch(`${FOMO_BASE_URL}/v2/leaderboard/${window}?limit=${limit}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(FOMO_FETCH_TIMEOUT_MS),
    });
    const rateLimit = parseRateHeader(res.headers.get("x-ratelimit-limit"));
    const rateRemaining = parseRateHeader(res.headers.get("x-ratelimit-remaining"));

    if (res.status === 429) {
      // Clean 429 handling: never throw, never hammer again this pass — serve stale cache if we
      // have one so the board stays usable through a rate-limit window rather than going blank.
      if (cached) return freshResultFromCache(cached, { apiCalled: true, status: 429, rateLimit, rateRemaining, errorReason: "rate_limited_served_stale" }, startedAt);
      return { ok: false, traders: [], cacheHit: false, cacheAgeMs: null, apiCalled: true, status: 429, rateLimit, rateRemaining, durationMs: Date.now() - startedAt, errorReason: "rate_limited" };
    }

    if (!res.ok) {
      if (cached) return freshResultFromCache(cached, { apiCalled: true, status: res.status, rateLimit, rateRemaining, errorReason: "http_error_served_stale" }, startedAt);
      return { ok: false, traders: [], cacheHit: false, cacheAgeMs: null, apiCalled: true, status: res.status, rateLimit, rateRemaining, durationMs: Date.now() - startedAt, errorReason: "http_error" };
    }

    const json = await res.json().catch(() => null) as unknown;
    const j = (json && typeof json === "object") ? json as Record<string, unknown> : {};
    const rawList = Array.isArray(j.data) ? j.data
      : Array.isArray(j.traders) ? j.traders
      : Array.isArray(j.leaderboard) ? j.leaderboard
      : Array.isArray(json) ? json as unknown[]
      : [];
    const traders = rankFomoTradersByPnl(rawList.slice(0, limit).map((row, i) => normalizeFomoTrader(row, i)));

    const result: FomoLeaderboardFetchResult = {
      ok: true, traders, cacheHit: false, cacheAgeMs: 0, apiCalled: true, status: res.status,
      rateLimit, rateRemaining, durationMs: Date.now() - startedAt, errorReason: null,
    };
    leaderboardCache.set(cacheKey, { at: Date.now(), result });
    return result;
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const reason = timedOut ? "timeout" : "network_error";
    if (cached) return freshResultFromCache(cached, { apiCalled: true, status: null, rateLimit: null, rateRemaining: null, errorReason: `${reason}_served_stale` }, startedAt);
    return { ok: false, traders: [], cacheHit: false, cacheAgeMs: null, apiCalled: true, status: null, rateLimit: null, rateRemaining: null, durationMs: Date.now() - startedAt, errorReason: reason };
  }
}
