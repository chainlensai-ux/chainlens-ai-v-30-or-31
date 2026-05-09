import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { fetchGoPlus } from "@/lib/goplus";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'

export const dynamic = "force-dynamic";

const GT = "https://api.geckoterminal.com/api/v2";
const GT_HEADERS = { accept: "application/json", origin: "https://chainlens.ai" };
const LIQ_CACHE_TTL_MS = 3 * 60 * 1000
const liqCache = new Map<string, { exp: number; payload: unknown }>()
const liqRate = new Map<string, { count: number; resetAt: number; lastAt: number }>()
const LIQ_RATE_LIMIT: Record<'free' | 'pro' | 'elite', number> = { free: 3, pro: 10, elite: 20 }
const LIQ_COOLDOWN_MS: Record<'free' | 'pro' | 'elite', number> = { free: 25_000, pro: 10_000, elite: 5_000 }

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolAttrs {
  name?: string;
  base_token_price_usd?: string;
  reserve_in_usd?: string;
  volume_usd?: { h24?: string; h6?: string; h1?: string };
  price_change_percentage?: { h24?: number; h6?: number; h1?: number };
  transactions?: { h24?: { buys?: number; sells?: number } };
}

interface GTPool {
  id: string;
  attributes: PoolAttrs;
  relationships?: {
    base_token?: { data?: { id: string } };
    network?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
}

interface GTToken {
  id: string;
  type: string;
  attributes: { name?: string; symbol?: string; address?: string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? null : n;
}

function idToAddress(id: string): string {
  const idx = id.indexOf("_");
  return idx === -1 ? id : id.slice(idx + 1);
}

async function resolveNameToContract(query: string): Promise<string | null> {
  const url = `${GT}/search/pools?query=${encodeURIComponent(query)}&network=base`;
  const res = await fetch(url, { headers: GT_HEADERS, cache: "no-store", signal: AbortSignal.timeout(7000) });
  if (!res.ok) return null;

  const data = await res.json();
  const pools: GTPool[] = Array.isArray(data?.data) ? data.data : [];

  const pool = pools.find(
    (p) =>
      p.id?.startsWith("base_") ||
      p.relationships?.network?.data?.id === "base"
  );
  if (!pool) return null;

  const tokenId = pool.relationships?.base_token?.data?.id ?? "";
  const address = idToAddress(tokenId);
  return address.startsWith("0x") ? address : null;
}

async function fetchPools(
  contract: string
): Promise<{ pools: GTPool[]; included: GTToken[] }> {
  const url = `${GT}/networks/base/tokens/${contract}/pools?include=base_token,quote_token,dex`;
  const res = await fetch(url, { headers: GT_HEADERS, cache: "no-store", signal: AbortSignal.timeout(8000) });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GeckoTerminal ${res.status}: ${text.slice(0, 120)}`);
  }

  const data = await res.json();
  return {
    pools: Array.isArray(data?.data) ? data.data : [],
    included: Array.isArray(data?.included) ? data.included : [],
  };
}

// ─── GoPlus LP lock data ──────────────────────────────────────────────────────

interface GoPlusHolder {
  address?: string;
  tag?: string;
  is_contract?: number;
  balance?: string;
  percent?: string;
  is_locked?: number;
  locked_detail?: Array<{ amount?: string; end_time?: string; opt_time?: string }>;
}

interface GoPlusLockData {
  lp_lock_pct: number | null;
  lp_owner: string | null;
  lp_lock_provider: string | null;
  lp_unlock_ts: number | null;
}

// In-memory token cache (survives across requests in a warm serverless instance)
let _gpToken: string | null = null;
let _gpTokenExpiry = 0;

async function getGoPlusToken(): Promise<string | null> {
  const appKey    = process.env.GOPLUS_APP_KEY;
  const appSecret = process.env.GOPLUS_APP_SECRET;
  if (!appKey || !appSecret) return null;

  const now = Math.floor(Date.now() / 1000);
  if (_gpToken && now < _gpTokenExpiry - 60) return _gpToken;

  const sign = createHash("md5").update(appKey + now + appSecret).digest("hex").toUpperCase();
  try {
    const res = await fetch("https://api.gopluslabs.io/api/v1/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_key: appKey, time: now, sign }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    _gpToken      = json?.result?.access_token ?? null;
    _gpTokenExpiry = now + (json?.result?.expires_in ?? 3600);
    return _gpToken;
  } catch {
    return null;
  }
}

async function fetchGoPlusLockData(contract: string): Promise<GoPlusLockData> {
  const empty: GoPlusLockData = { lp_lock_pct: null, lp_owner: null, lp_lock_provider: null, lp_unlock_ts: null };
  try {
    const token = await getGoPlusToken();
    const url = `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${contract.toLowerCase()}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers["Authorization"] = token;
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return empty;

    const json = await res.json();
    const tokenData = json?.result?.[contract.toLowerCase()] ?? json?.result?.[Object.keys(json?.result ?? {})[0]];
    if (!tokenData) return empty;

    const holders: GoPlusHolder[] = Array.isArray(tokenData.lp_holders) ? tokenData.lp_holders : [];
    if (!holders.length) return empty;

    // Total lock % = sum of percent for locked holders
    const lockedHolders = holders.filter(h => h.is_locked === 1);
    const lp_lock_pct = lockedHolders.length
      ? Math.round(lockedHolders.reduce((s, h) => s + parseFloat(h.percent ?? "0"), 0) * 100)
      : 0;

    // Lock provider = tag of first locked holder
    const lp_lock_provider = lockedHolders[0]?.tag?.trim() || null;

    // Earliest unlock timestamp across all locked holders
    let lp_unlock_ts: number | null = null;
    for (const h of lockedHolders) {
      for (const d of h.locked_detail ?? []) {
        const ts = d.end_time ? parseInt(d.end_time, 10) : null;
        if (ts && (!lp_unlock_ts || ts < lp_unlock_ts)) lp_unlock_ts = ts;
      }
    }

    // LP owner = largest non-locked, non-zero holder (likely deployer or treasury)
    const unlockedHolders = holders.filter(h => !h.is_locked || h.is_locked === 0);
    const lp_owner = unlockedHolders[0]?.address ?? null;

    return { lp_lock_pct, lp_owner, lp_lock_provider, lp_unlock_ts };
  } catch {
    return empty;
  }
}

// ─── LP scoring heuristics ────────────────────────────────────────────────────

function scoreLiquidity(pools: GTPool[]): {
  lp_total_liquidity_usd: number | null;
  lp_fragments: number;
  lp_stability_score: number;
  lp_risk_tier: "low" | "medium" | "high" | "extreme";
  positives: string[];
  negatives: string[];
  pool_breakdown: Array<{
    name: string | undefined;
    address: string;
    liquidity: number | null;
    volume24h: number | null;
    priceChange24h: number | null;
  }>;
} {
  const sorted = [...pools].sort(
    (a, b) =>
      (toNum(b.attributes.reserve_in_usd) ?? 0) -
      (toNum(a.attributes.reserve_in_usd) ?? 0)
  );

  const liquidities = sorted.map((p) => toNum(p.attributes.reserve_in_usd) ?? 0);
  const totalLiq = liquidities.reduce((s, v) => s + v, 0) || null;
  const fragments = sorted.length;

  let score = 50; // baseline
  const positives: string[] = [];
  const negatives: string[] = [];

  // Liquidity depth
  if (totalLiq == null || totalLiq < 10_000) {
    score += 40;
    negatives.push("Total liquidity below $10K — extremely thin, highly manipulation-prone.");
  } else if (totalLiq < 50_000) {
    score += 30;
    negatives.push("Total liquidity under $50K — shallow depth, significant slippage risk.");
  } else if (totalLiq < 100_000) {
    score += 15;
    negatives.push("Liquidity under $100K — moderate depth, susceptible to whale moves.");
  } else if (totalLiq < 500_000) {
    score += 5;
  } else if (totalLiq >= 1_000_000) {
    score -= 15;
    positives.push(`Strong total liquidity of $${(totalLiq / 1_000_000).toFixed(2)}M across pools.`);
  } else {
    score -= 5;
    positives.push("Healthy liquidity depth above $500K.");
  }

  // Fragmentation
  if (fragments >= 10) {
    score += 10;
    negatives.push(`Highly fragmented across ${fragments} pools — liquidity is diluted and unstable.`);
  } else if (fragments >= 5) {
    score += 5;
    negatives.push(`Liquidity split across ${fragments} pools — moderate fragmentation.`);
  } else if (fragments === 1) {
    score -= 5;
    positives.push("Liquidity concentrated in a single pool — easier to monitor.");
  } else {
    positives.push(`Liquidity spread across ${fragments} pools — manageable diversification.`);
  }

  // Concentration: top pool should hold >50% of liquidity
  if (fragments > 1 && totalLiq) {
    const topShare = liquidities[0] / totalLiq;
    if (topShare < 0.3) {
      score += 10;
      negatives.push("No dominant liquidity pool — high fragmentation increases exit risk.");
    } else if (topShare >= 0.7) {
      score -= 5;
      positives.push("Top pool holds majority of liquidity — concentrated and trackable.");
    }
  }

  // 24h price volatility across top pools
  const changes = sorted
    .slice(0, 3)
    .map((p) => toNum(p.attributes.price_change_percentage?.h24))
    .filter((v): v is number => v != null);
  if (changes.length > 0) {
    const maxAbs = Math.max(...changes.map(Math.abs));
    if (maxAbs > 50) {
      score += 20;
      negatives.push(`Extreme 24h price swing of ${maxAbs.toFixed(1)}% — highly volatile LP.`);
    } else if (maxAbs > 20) {
      score += 10;
      negatives.push(`Significant 24h price swing of ${maxAbs.toFixed(1)}% — elevated volatility.`);
    } else if (maxAbs < 5) {
      score -= 5;
      positives.push("Low 24h price volatility — LP is relatively stable.");
    }
  }

  // Volume vs liquidity health
  const topVol = toNum(sorted[0]?.attributes.volume_usd?.h24);
  if (topVol != null && totalLiq != null && totalLiq > 0) {
    const turnover = topVol / totalLiq;
    if (turnover > 10) {
      score += 10;
      negatives.push("Volume/liquidity ratio extremely high — suggests wash trading or LP drain risk.");
    } else if (turnover > 3) {
      score += 5;
      negatives.push("High volume-to-liquidity ratio — monitor for LP imbalance.");
    } else if (turnover > 0.5) {
      positives.push("Healthy trading volume relative to liquidity depth.");
    } else if (topVol < 1_000) {
      score += 5;
      negatives.push("Very low 24h trading volume — illiquid market with low price discovery.");
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let lp_risk_tier: "low" | "medium" | "high" | "extreme";
  if (score <= 30) lp_risk_tier = "low";
  else if (score <= 55) lp_risk_tier = "medium";
  else if (score <= 75) lp_risk_tier = "high";
  else lp_risk_tier = "extreme";

  return {
    lp_total_liquidity_usd: totalLiq,
    lp_fragments: fragments,
    lp_stability_score: score,
    lp_risk_tier,
    positives,
    negatives,
    pool_breakdown: sorted.map((p) => ({
      name: p.attributes.name,
      address: idToAddress(p.id),
      liquidity: toNum(p.attributes.reserve_in_usd),
      volume24h: toNum(p.attributes.volume_usd?.h24),
      priceChange24h: toNum(p.attributes.price_change_percentage?.h24),
    })),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  let plan: 'free' | 'pro' | 'elite' = 'free'
  let settingsRowFound = false
  if (token) {
    const planData = await getCurrentUserPlanFromBearerToken(token).catch(() => null)
    if (planData) { plan = planData.plan; settingsRowFound = planData.settingsRowFound }
  }
  if (plan === 'free') return NextResponse.json({ ok: false, error: 'Included in Pro and Elite.', rateLimited: false, planGate: { verifiedPlan: plan, requiredPlan: 'pro', settingsRowFound, planSource: token ? 'bearer_token' : 'no_token' } }, { status: 403 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const now = Date.now()
  const rk = `${ip}:${plan}`
  const rr = liqRate.get(rk)
  if (!rr || rr.resetAt <= now) liqRate.set(rk, { count: 1, resetAt: now + 60_000, lastAt: now })
  else if (now - rr.lastAt < LIQ_COOLDOWN_MS[plan]) return NextResponse.json({ ok: false, error: "Cooldown active. Please retry shortly.", rateLimited: true }, { status: 429 })
  else if (rr.count >= LIQ_RATE_LIMIT[plan]) return NextResponse.json({ ok: false, error: "Rate limit reached. Try again shortly.", rateLimited: true }, { status: 429 })
  else { rr.count += 1; rr.lastAt = now }
  let query: string | undefined;
  let contract: string | undefined;

  try {
    const body = await req.json();
    query = body.query?.trim();
    contract = body.contract?.trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!query && !contract) {
    return NextResponse.json(
      { ok: false, error: "Provide query or contract in request body." },
      { status: 400 }
    );
  }

  try {
    let resolvedContract: string | null = null;

    if (contract) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
        return NextResponse.json(
          { ok: false, error: "Invalid contract address." },
          { status: 400 }
        );
      }
      resolvedContract = contract;
    } else if (query) {
      resolvedContract = await resolveNameToContract(query);
      if (!resolvedContract) {
        return NextResponse.json(
          { ok: false, error: "Token not found on Base." },
          { status: 404 }
        );
      }
    }

    if (!resolvedContract) {
      return NextResponse.json({ ok: false, error: "Token not found." }, { status: 404 });
    }

    const cacheKey = `liq:${resolvedContract.toLowerCase()}`
    const cached = liqCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)
    const origin = req.nextUrl.origin;
    const [{ pools, included }, lockData, goPlusRes] = await Promise.all([
      fetchPools(resolvedContract),
      fetchGoPlusLockData(resolvedContract),
      fetchGoPlus(resolvedContract, origin),
    ]);

    if (pools.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No pools found for this token on Base." },
        { status: 404 }
      );
    }

    // Resolve token name/symbol
    const norm = resolvedContract.toLowerCase();
    const tokenMeta = included.find(
      (t) =>
        t.type === "token" &&
        (t.attributes?.address?.toLowerCase() === norm ||
          idToAddress(t.id).toLowerCase() === norm)
    );
    const name = tokenMeta?.attributes?.name ?? pools[0]?.attributes?.name?.split(" / ")[0] ?? "Unknown";
    const symbol = tokenMeta?.attributes?.symbol ?? "?";

    const analysis = scoreLiquidity(pools);

    const payload = {
      ok: true,
      data: {
        name,
        symbol,
        contract: resolvedContract,
        ...analysis,
        ...lockData,
        goplus: goPlusRes.ok ? goPlusRes.data : null,
      },
      diagnostics: process.env.NODE_ENV === 'development' ? { cacheHit: false, providerStatus: 'ok', rateLimited: false } : undefined,
    };
    liqCache.set(cacheKey, { exp: Date.now() + LIQ_CACHE_TTL_MS, payload })
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[liquidity-safety]", err instanceof Error ? err.message : "Liquidity scan failed");
    return NextResponse.json({ ok: false, error: "Liquidity scan unavailable right now." }, { status: 200 });
  }
}
