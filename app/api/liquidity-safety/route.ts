import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import {
  resolveLpProof,
  buildEvidenceGaps,
  deriveDataModeAndConfidence,
  buildCortexLpRead,
  classifyPoolModel,
  computeLpExitRisk,
  type LpEvidenceGap,
  type PoolModel,
} from '@/lib/server/lpProof'
import {
  selectCanonicalPools,
  computeDisplayLpModel,
  gtPoolToCandidate,
  buildSharedLpMeta,
} from '@/lib/server/lpIntelligence'

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
  [key: string]: unknown;
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
    quote_token?: { data?: { id: string } };
    network?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
}

type ChainKey = "base" | "eth"

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

function normalizeChain(raw: string | null | undefined): ChainKey {
  return raw === "eth" || raw === "ethereum" ? "eth" : "base"
}

async function resolveNameToContract(query: string, chain: ChainKey): Promise<string | null> {
  const url = `${GT}/search/pools?query=${encodeURIComponent(query)}&network=${chain}`;
  const res = await fetch(url, { headers: GT_HEADERS, cache: "no-store", signal: AbortSignal.timeout(7000) });
  if (!res.ok) return null;

  const data = await res.json();
  const pools: GTPool[] = Array.isArray(data?.data) ? data.data : [];

  const pool = pools.find(
    (p) =>
      p.id?.startsWith(`${chain}_`) ||
      p.relationships?.network?.data?.id === chain
  );
  if (!pool) return null;

  const tokenId = pool.relationships?.base_token?.data?.id ?? "";
  const address = idToAddress(tokenId);
  return address.startsWith("0x") ? address : null;
}

async function fetchPools(
  contract: string,
  chain: ChainKey
): Promise<{ pools: GTPool[]; included: GTToken[] }> {
  const url = `${GT}/networks/${chain}/tokens/${contract}/pools?include=base_token,quote_token,dex`;
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

// ─── Evidence gaps & migration proof (no external security provider) ──────────

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
  const adapterRead = req.headers.get('x-chainlens-adapter-route') === 'project-overview'
  if (plan === 'free' && !adapterRead) return NextResponse.json({ ok: false, error: 'Included in Pro and Elite.', rateLimited: false, planGate: { verifiedPlan: plan, requiredPlan: 'pro', settingsRowFound, planSource: token ? 'bearer_token' : 'no_token' } }, { status: 403 })
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
  let chain: ChainKey = "base";

  try {
    const body = await req.json();
    query = typeof body.query === "string" ? body.query.trim() : undefined;
    contract = typeof (body.contract ?? body.address) === "string" ? String(body.contract ?? body.address).trim() : undefined;
    chain = normalizeChain(typeof body.chain === "string" ? body.chain : undefined);
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
      resolvedContract = await resolveNameToContract(query, chain);
      if (!resolvedContract) {
        return NextResponse.json(
          { ok: false, error: `Token not found on ${chain}.` },
          { status: 404 }
        );
      }
    }

    if (!resolvedContract) {
      return NextResponse.json({ ok: false, error: "Token not found." }, { status: 404 });
    }

    const cacheKey = `liq:${chain}:${resolvedContract.toLowerCase()}`
    const cached = liqCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)
    const { pools, included } = await fetchPools(resolvedContract, chain);

    if (pools.length === 0) {
      return NextResponse.json(
        { ok: false, error: `No pools found for this token on ${chain}.` },
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
    const migrationProof = deriveMigrationProof(pools, analysis.lp_total_liquidity_usd);

    // ─── Shared LP pool selection & classification (lib/server/lpIntelligence) ──
    // Same canonical-pool-selection / displayLpModel logic as Token Scanner, so
    // Liquidity Safety never disagrees with Token Scanner about which pool is
    // primary, whether it's concentrated/protocol liquidity, or whether standard
    // ERC-20 LP lock/burn proof applies.
    const lpCandidates = pools.map(gtPoolToCandidate);
    const selection = selectCanonicalPools(lpCandidates);
    const primaryPool = selection.primaryPool;
    const verifyPool = selection.verifyPool;
    const proofPresent = Boolean(verifyPool?.address && verifyPool.hasLpToken === true && verifyPool.isValidAddress);

    const display = computeDisplayLpModel({
      noActivePools: pools.length === 0,
      proofPresent,
      primaryPoolType: primaryPool?.poolType ?? "unknown",
      primaryDexId: primaryPool?.dexId ?? null,
      verifyPoolType: verifyPool?.poolType ?? "unknown",
    });
    const lpProofApplicability = display.proofApplicability;

    const primaryDexIdForModel = primaryPool?.dexId ?? null;
    const primaryCls = classifyPoolModel(primaryDexIdForModel);
    const lpModelProof = {
      model: (primaryCls.poolModel === "aerodrome_v2" ? "constant_product" : primaryCls.poolModel) as "constant_product" | "concentrated" | "stableswap" | "unknown",
      dexName: primaryDexIdForModel,
      standardLockApplies: primaryCls.standardLockApplies,
    };

    let lpProof: { lpLockStatus: "locked" | "burned" | "unlocked" | "unverified"; lpLockAmount: number | null; lpUnlockTime: number | null; lpLockProvider: "PinkLock" | null; lpController: "wallet" | "contract" | "burn" | "lockContract" | "unknown"; reasonCode?: string };
    let lpProofSkipReason: string | null = null;
    let proofAddress: string | null = null;

    if (lpProofApplicability === "applicable" && proofPresent && verifyPool?.address) {
      proofAddress = verifyPool.address;
      lpProof = await resolveLpProof(chain, proofAddress);
    } else {
      // Standard ERC-20 LP proof does not apply to this pool model — never fake a
      // lock/burn result for concentrated/NFT-position/unclassified pools.
      lpProof = { lpLockStatus: "unverified", lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null, lpController: "unknown", reasonCode: "proofNotApplicable" };
      lpProofSkipReason = display.lockBurnReason;
    }

    const { lpLockStatus, lpLockAmount, lpUnlockTime, lpLockProvider, lpController } = lpProof;

    const { lp_data_mode, lp_data_confidence } = deriveDataModeAndConfidence(pools.length > 0, lpLockStatus);
    const evidenceGaps: LpEvidenceGap[] = buildEvidenceGaps({
      lpLockStatus, lpController,
      proofApplicability: lpProofApplicability,
      controllerProofAttempted: Boolean(proofAddress),
      includeTokenGaps: false, // LP safety scan does not run token-level checks
    });
    const lpExitRiskResult = computeLpExitRisk({
      proofApplicability: lpProofApplicability,
      lpLockStatus,
      lpController,
      liquidityUsd: analysis.lp_total_liquidity_usd,
      poolModel: primaryCls.poolModel,
      hasPool: pools.length > 0,
    });
    const cortexLpRead = buildCortexLpRead({
      name, symbol,
      totalLiq: analysis.lp_total_liquidity_usd,
      fragments: analysis.lp_fragments,
      riskTier: analysis.lp_risk_tier,
      lpModel: lpModelProof,
      migrationSummary: `Migration signal: ${migrationProof.status} (confidence: ${migrationProof.confidence}). ${migrationProof.reason} Pool creation date is unavailable, so pool age cannot be factored into this assessment.`,
      mode: lp_data_mode,
      confidence: lp_data_confidence,
      gaps: evidenceGaps,
      lpLockStatus,
      lpLockProvider,
      lpUnlockTime,
    });

    // ─── Shared lpControl summary (rules 1/2/4) ────────────────────────────────
    // Liquidity Safety does not run on-chain holder-level burn/lock/team-control
    // scanning (that's Token Scanner's job) — lpControl here reflects only the
    // shared pool-model classification and the LP-token lock/burn proof above,
    // so it never contradicts Token Scanner's primary-pool model.
    let lpControlStatus: string;
    let lpControlConfidence: "high" | "medium" | "low" | "unverified";
    let lpControlReason: string;
    if (display.displayLpModel === "no_pool") {
      lpControlStatus = "no_pool";
      lpControlConfidence = "unverified";
      lpControlReason = display.lockBurnReason;
    } else if (display.displayLpModel === "concentrated_liquidity") {
      lpControlStatus = "concentrated_liquidity";
      lpControlConfidence = "medium";
      lpControlReason = display.lockBurnReason;
    } else if (lpLockStatus === "locked" || lpLockStatus === "burned") {
      lpControlStatus = lpLockStatus;
      lpControlConfidence = "high";
      lpControlReason = `LP token ${lpLockStatus} (verification pool ${proofAddress ?? "unknown"}).`;
    } else if (display.displayLpModel === "erc20_lp_token") {
      lpControlStatus = "open_check";
      lpControlConfidence = "low";
      lpControlReason = "LP token lock/burn status not confirmed on-chain.";
    } else {
      lpControlStatus = "open_check";
      lpControlConfidence = "low";
      lpControlReason = display.lockBurnReason;
    }

    const lpControl = {
      status: lpControlStatus,
      confidence: lpControlConfidence,
      reason: lpControlReason,
      poolType: primaryPool?.poolType ?? "unknown",
      source: "liquidity-safety",
      evidence: [] as string[],
      secondaryLpControlSignals: null as null,
    };

    const lpMeta = buildSharedLpMeta({ selection, display, chain });

    const payload = {
      ok: true,
      data: {
        name,
        symbol,
        contract: resolvedContract,
        chain,
        ...analysis,
        lpLockStatus,
        lpLockAmount,
        lpUnlockTime,
        lpLockProvider,
        lpController,
        lpProofApplicability,
        displayLpModel: display.displayLpModel,
        lockBurnApplicable: display.lockBurnApplicable,
        lockBurnReason: display.lockBurnReason,
        lpControl,
        lpExitRisk: lpExitRiskResult.lpExitRisk,
        lpExitRiskReason: lpExitRiskResult.lpExitRiskReason,
        liquidityDepthRisk: lpExitRiskResult.liquidityDepthRisk,
        lp_data_mode,
        lp_data_confidence,
        lp_evidence_gaps: evidenceGaps,
        lp_model_proof: lpModelProof,
        lp_migration_proof: migrationProof,
        cortex_lp_read: cortexLpRead,
        lpMeta,
      },
      diagnostics: process.env.NODE_ENV === 'development' ? { cacheHit: false, providerStatus: 'ok', rateLimited: false, lpProofSkipReason } : undefined,
    };
    liqCache.set(cacheKey, { exp: Date.now() + LIQ_CACHE_TTL_MS, payload })
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[liquidity-safety]", err instanceof Error ? err.message : "Liquidity scan failed");
    return NextResponse.json({ ok: false, error: "Liquidity scan unavailable right now." }, { status: 200 });
  }
}


export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const address = url.searchParams.get("address") ?? url.searchParams.get("contract") ?? ""
  const chain = normalizeChain(url.searchParams.get("chain"))

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ ok: false, error: "Invalid or missing address parameter." }, { status: 400 })
  }

  const syntheticReq = new Request(req.url, {
    method: "POST",
    headers: { ...Object.fromEntries(req.headers.entries()), "x-chainlens-adapter-route": "project-overview" },
    body: JSON.stringify({ contract: address, chain }),
  })
  return POST(syntheticReq as NextRequest)
}
