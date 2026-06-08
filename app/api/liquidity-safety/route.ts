import { NextRequest, NextResponse } from "next/server";
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

// ─── LP scoring heuristics ────────────────────────────────────────────────────

function scoreLiquidityDepth(pools: GTPool[]): {
  lp_total_liquidity_usd: number | null;
  lp_fragments: number;
  liquidity_depth_score: number;
  lp_risk_tier: "low" | "medium" | "high" | "extreme";
  positives: string[];
  negatives: string[];
  pool_breakdown: Array<{
    name: string | undefined;
    address: string;
    liquidity: number | null;
    volume24h: number | null;
    priceChange24h: number | null;
    priceChange1h: number | null;
    dexName: string | null;
    buys24: number | null;
    sells24: number | null;
    volumeH1: number | null;
    volumeH6: number | null;
    liquidityShare: number | null;
    isPrimary: boolean;
    volLiqRatio: number | null;
    isStale: boolean;
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
    liquidity_depth_score: score,
    lp_risk_tier,
    positives,
    negatives,
    pool_breakdown: sorted.map((p, i) => {
      const liq = toNum(p.attributes.reserve_in_usd);
      const vol24 = toNum(p.attributes.volume_usd?.h24);
      const buys = p.attributes.transactions?.h24?.buys ?? null;
      const sells = p.attributes.transactions?.h24?.sells ?? null;
      return {
        name: p.attributes.name,
        address: idToAddress(p.id),
        liquidity: liq,
        volume24h: vol24,
        priceChange24h: toNum(p.attributes.price_change_percentage?.h24),
        priceChange1h: toNum(p.attributes.price_change_percentage?.h1),
        dexName: p.relationships?.dex?.data?.id ?? null,
        buys24: buys,
        sells24: sells,
        volumeH1: toNum(p.attributes.volume_usd?.h1),
        volumeH6: toNum(p.attributes.volume_usd?.h6),
        liquidityShare: liq != null && totalLiq ? Math.round((liq / totalLiq) * 1000) / 10 : null,
        isPrimary: i === 0,
        volLiqRatio: vol24 != null && liq != null && liq > 0 ? Math.round((vol24 / liq) * 100) / 100 : null,
        isStale: (vol24 ?? 0) === 0 && (buys ?? 0) === 0 && (sells ?? 0) === 0,
      };
    }),
  };
}

// ─── Evidence gaps & LP model/migration proofs (no external security provider) ─

export interface LpEvidenceGap {
  id: string;
  label: string;
  explanation: string;
  nextAction: string;
}

const EVIDENCE_GAPS: LpEvidenceGap[] = [
  { id: "LOCK_STATUS_UNVERIFIED", label: "LOCK STATUS UNVERIFIED", explanation: "No active lock-proof provider is available for this scan, so LP lock status cannot be confirmed.", nextAction: "Verify the LP lock directly on-chain or via a lock-proof explorer before trusting any lock claims." },
  { id: "BURN_PROOF_UNCONFIRMED", label: "BURN PROOF UNCONFIRMED", explanation: "Whether LP tokens were burned to a dead address has not been confirmed by this scan.", nextAction: "Check the LP token holder list on-chain for transfers to a burn address." },
  { id: "CONTROLLER_UNKNOWN", label: "CONTROLLER UNKNOWN", explanation: "The contract owner / controller address has not been confirmed by this scan.", nextAction: "Inspect the token contract's owner() / admin functions on a block explorer." },
  { id: "POOL_AGE_UNKNOWN", label: "POOL AGE UNKNOWN", explanation: "Pool creation date is not available from the data used in this scan.", nextAction: "Check the pool creation transaction on a block explorer to determine its age." },
  { id: "MINTABILITY_UNAVAILABLE", label: "MINTABILITY UNAVAILABLE", explanation: "Whether the token contract can mint new supply has not been confirmed by this scan.", nextAction: "Review the token contract source code for mint functions." },
  { id: "HONEYPOT_CHECK_UNAVAILABLE", label: "HONEYPOT CHECK UNAVAILABLE", explanation: "This scan does not include a honeypot / sell-simulation check.", nextAction: "Run a dedicated honeypot simulation before trading meaningful size." },
  { id: "TAX_CHECK_UNAVAILABLE", label: "TAX CHECK UNAVAILABLE", explanation: "Buy/sell tax has not been verified by this scan.", nextAction: "Simulate a buy and sell to confirm actual transaction tax." },
  { id: "RENOUNCE_STATUS_UNKNOWN", label: "RENOUNCE STATUS UNKNOWN", explanation: "Whether contract ownership has been renounced is not confirmed by this scan.", nextAction: "Check the contract's owner address on a block explorer for renouncement." },
];

function buildEvidenceGaps(): LpEvidenceGap[] {
  return EVIDENCE_GAPS;
}

function deriveLpModelProof(pools: GTPool[]): {
  model: "constant_product" | "concentrated" | "stableswap" | "unknown";
  dexName: string | null;
  standardLockApplies: boolean;
} {
  const primary = pools[0];
  const dexId = (primary?.relationships?.dex?.data?.id ?? "").toLowerCase();
  let model: "constant_product" | "concentrated" | "stableswap" | "unknown" = "unknown";
  if (dexId.includes("curve")) model = "stableswap";
  else if (dexId.includes("v3") || dexId.includes("slipstream") || dexId.includes("concentrated")) model = "concentrated";
  else if (dexId.includes("uniswap") || dexId.includes("aerodrome") || dexId.includes("sushiswap") || dexId.includes("v2")) model = "constant_product";

  return {
    model,
    dexName: primary?.relationships?.dex?.data?.id ?? null,
    standardLockApplies: model !== "concentrated",
  };
}

function deriveMigrationProof(pools: GTPool[], totalLiq: number | null): {
  status: "low" | "watch" | "flagged" | "unknown";
  confidence: "high" | "medium" | "low" | "unverified";
  reason: string;
  dexsUsed: string[];
  primaryDex: string | null;
  liquidityDistribution: string;
  signals: string[];
  missingEvidence: string[];
  nextAction: string;
} {
  const dexsUsed = Array.from(new Set(pools.map((p) => p.relationships?.dex?.data?.id).filter((d): d is string => !!d)));
  const primaryDex = pools[0]?.relationships?.dex?.data?.id ?? null;
  const liquidities = pools.map((p) => toNum(p.attributes.reserve_in_usd) ?? 0);
  const topShare = totalLiq && totalLiq > 0 ? (liquidities[0] ?? 0) / totalLiq : null;

  const signals: string[] = [];
  let status: "low" | "watch" | "flagged" | "unknown" = "unknown";
  let confidence: "high" | "medium" | "low" | "unverified" = "unverified";
  let reason = "Not enough pool data to assess migration risk.";
  let liquidityDistribution = "unknown";

  if (pools.length > 0 && topShare != null) {
    liquidityDistribution = topShare >= 0.7 ? "concentrated in primary pool" : topShare >= 0.4 ? "moderately distributed" : "spread thinly across pools";

    if (dexsUsed.length > 1) signals.push(`Liquidity is split across ${dexsUsed.length} different DEXs.`);
    if (pools.length > 1 && topShare < 0.4) signals.push("No single pool holds a clear majority of liquidity.");
    if (pools.length === 1) signals.push("All observed liquidity sits in a single pool.");

    if (dexsUsed.length > 1 && topShare < 0.4) {
      status = "watch";
      confidence = "low";
      reason = "Liquidity is fragmented across multiple DEXs with no dominant pool — could indicate an in-progress or past migration.";
    } else if (dexsUsed.length === 1 && topShare >= 0.7) {
      status = "low";
      confidence = "medium";
      reason = "Liquidity is concentrated in a single DEX and primary pool — no migration signal observed.";
    } else {
      status = "watch";
      confidence = "low";
      reason = "Pool distribution shows mixed signals — insufficient evidence to rule out migration activity.";
    }
  }

  return {
    status,
    confidence,
    reason,
    dexsUsed,
    primaryDex,
    liquidityDistribution,
    signals,
    missingEvidence: ["pool_creation_date_unavailable"],
    nextAction: "Confirm pool creation dates and historical liquidity moves on a block explorer before drawing migration conclusions.",
  };
}

function deriveDataModeAndConfidence(pools: GTPool[], totalLiq: number | null): {
  lp_data_mode: "strict" | "minimal" | "fallback" | "insufficient";
  lp_data_confidence: "high" | "medium" | "low" | "unverified";
} {
  if (pools.length === 0) return { lp_data_mode: "insufficient", lp_data_confidence: "unverified" };
  if (totalLiq == null || totalLiq < 1000) return { lp_data_mode: "minimal", lp_data_confidence: "low" };
  return { lp_data_mode: "fallback", lp_data_confidence: "medium" };
}

function buildCortexLpRead(params: {
  name: string;
  symbol: string;
  totalLiq: number | null;
  fragments: number;
  riskTier: string;
  lpModel: ReturnType<typeof deriveLpModelProof>;
  migration: ReturnType<typeof deriveMigrationProof>;
  mode: string;
  confidence: string;
  gaps: LpEvidenceGap[];
}): {
  mode: string;
  confidence: string;
  riskSummary: string;
  liquidityAnalysis: string;
  poolStructureAnalysis: string;
  migrationAnalysis: string;
  evidenceGaps: string[];
  nextActions: string[];
} {
  const { name, symbol, totalLiq, fragments, riskTier, lpModel, migration, mode, confidence, gaps } = params;
  const liqStr = totalLiq != null ? `$${totalLiq.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "an unknown amount";

  const riskSummary = `${name} (${symbol}) shows a "${riskTier}" liquidity-depth risk tier based on observed pool data. This reflects liquidity depth and pool structure only — lock, burn, ownership, mintability, honeypot and tax status remain unconfirmed (data mode: ${mode}, confidence: ${confidence}).`;

  const liquidityAnalysis = `Total observed liquidity across tracked pools is approximately ${liqStr}, spread across ${fragments} pool${fragments === 1 ? "" : "s"}.`;

  const poolStructureAnalysis = lpModel.model === "unknown"
    ? "The AMM model could not be determined from the available DEX data."
    : `The primary pool runs on a ${lpModel.model.replace("_", "-")} model${lpModel.dexName ? ` (DEX: ${lpModel.dexName})` : ""}.${lpModel.standardLockApplies ? "" : " Standard LP lock proofs may not apply to concentrated-liquidity positions — lock verification methods differ for this model."}`;

  const migrationAnalysis = `Migration signal: ${migration.status} (confidence: ${migration.confidence}). ${migration.reason} Pool creation date is unavailable, so pool age cannot be factored into this assessment.`;

  return {
    mode,
    confidence,
    riskSummary,
    liquidityAnalysis,
    poolStructureAnalysis,
    migrationAnalysis,
    evidenceGaps: gaps.map((g) => g.label),
    nextActions: [
      "Confirm LP lock and burn status directly on-chain before trusting any safety claims.",
      "Verify contract ownership/renouncement and mintability via the contract source code.",
      "Run a honeypot and tax simulation prior to trading.",
      ...(lpModel.standardLockApplies ? [] : ["Use a concentrated-liquidity-aware lock verification method for this pool."]),
    ],
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
    const { pools, included } = await fetchPools(resolvedContract);

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

    const analysis = scoreLiquidityDepth(pools);
    const lpModelProof = deriveLpModelProof(pools);
    const migrationProof = deriveMigrationProof(pools, analysis.lp_total_liquidity_usd);
    const { lp_data_mode, lp_data_confidence } = deriveDataModeAndConfidence(pools, analysis.lp_total_liquidity_usd);
    const evidenceGaps = buildEvidenceGaps();
    const cortexLpRead = buildCortexLpRead({
      name, symbol,
      totalLiq: analysis.lp_total_liquidity_usd,
      fragments: analysis.lp_fragments,
      riskTier: analysis.lp_risk_tier,
      lpModel: lpModelProof,
      migration: migrationProof,
      mode: lp_data_mode,
      confidence: lp_data_confidence,
      gaps: evidenceGaps,
    });

    const payload = {
      ok: true,
      data: {
        name,
        symbol,
        contract: resolvedContract,
        ...analysis,
        lockStatus: "unverified" as const,
        lp_data_mode,
        lp_data_confidence,
        lp_evidence_gaps: evidenceGaps,
        lp_model_proof: lpModelProof,
        lp_migration_proof: migrationProof,
        cortex_lp_read: cortexLpRead,
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
