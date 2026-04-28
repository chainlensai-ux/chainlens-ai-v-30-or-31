export type BaseMarketMode = "pumping" | "new_launches" | "liquid_movers" | "microcaps" | "cooling_watchlist";

export type BaseMarketCandidate = {
  tokenAddress: string | null;
  poolAddress: string | null;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  txns24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  poolAgeHours: number | null;
  dex: string | null;
  sourceTags: string[];
  reasonTags: string[];
};

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSymbol(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: BaseMarketCandidate[] }>();
const STABLES = new Set(["USDC", "USDBC", "USDT", "DAI"]);
const MAJORS = new Set(["WETH", "CBBTC"]);

async function fetchJsonTimeout(url: string, timeoutMs = 5000): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ac.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(t);
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function ageHours(createdAt: unknown): number | null {
  if (typeof createdAt !== "string") return null;
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, (Date.now() - ts) / 3_600_000);
}

function normalizePool(raw: Record<string, unknown>, source: string): BaseMarketCandidate | null {
  const a = (raw?.attributes ?? {}) as Record<string, unknown>;
  const pcp = (a?.price_change_percentage ?? {}) as Record<string, unknown>;
  const vol = (a?.volume_usd ?? {}) as Record<string, unknown>;
  const tx = (a?.transactions ?? {}) as Record<string, unknown>;
  const tx24 = (tx?.h24 ?? {}) as Record<string, unknown>;
  const rel = (raw?.relationships ?? {}) as Record<string, unknown>;
  const baseTokenRel = (rel?.base_token ?? {}) as Record<string, unknown>;
  const baseTokenData = (baseTokenRel?.data ?? {}) as Record<string, unknown>;
  const baseTokenId = typeof baseTokenData?.id === "string" ? baseTokenData.id : undefined;
  const poolId = raw?.id as string | undefined;
  const tokenAddress = typeof baseTokenId === "string" ? baseTokenId.split("_").pop() ?? null : null;
  const poolAddress = typeof poolId === "string" ? poolId.split("_").pop() ?? null : null;
  const name = typeof a?.name === "string" ? String(a.name).split("/")[0].trim() : null;
  const symbol = name ? name.split(" ").slice(-1)[0]?.toUpperCase() ?? null : null;
  if (!symbol || !name) return null;
  return {
    tokenAddress,
    poolAddress,
    symbol,
    name,
    priceUsd: toNum(a?.base_token_price_usd),
    change1h: toNum(pcp?.h1),
    change6h: toNum(pcp?.h6),
    change24h: toNum(pcp?.h24),
    volume24h: toNum(vol?.h24),
    liquidityUsd: toNum(a?.reserve_in_usd),
    fdv: toNum(a?.fdv_usd),
    marketCap: toNum(a?.market_cap_usd),
    txns24h: toNum(tx24?.buys) != null && toNum(tx24?.sells) != null ? Number(toNum(tx24?.buys)! + toNum(tx24?.sells)!) : null,
    buys24h: toNum(tx24?.buys),
    sells24h: toNum(tx24?.sells),
    poolAgeHours: ageHours(a?.pool_created_at),
    dex: typeof a?.dex_id === "string" ? a.dex_id : null,
    sourceTags: [source],
    reasonTags: [],
  };
}

function rankAndTag(items: BaseMarketCandidate[], mode: BaseMarketMode): BaseMarketCandidate[] {
  const micro = mode === "microcaps";
  const filtered = items.filter((t) => {
    if (!t.symbol || !t.name) return false;
    if (STABLES.has(t.symbol)) return false;
    if (!micro && MAJORS.has(t.symbol)) return false;
    if ((t.volume24h ?? 0) <= 0 && (t.liquidityUsd ?? 0) <= 0) return false;
    if (!micro && (t.liquidityUsd ?? 0) < 500) return false;
    return true;
  });

  const scored = filtered.map((t) => {
    let score = 0;
    score += Math.max(0, t.change24h ?? 0) * 1.4;
    score += Math.max(0, t.change6h ?? 0) * 0.8;
    score += Math.max(0, t.change1h ?? 0) * 0.4;
    score += Math.min(20, Math.log10((t.volume24h ?? 0) + 1) * 3);
    score += Math.min(20, Math.log10((t.liquidityUsd ?? 0) + 1) * 3);
    if ((t.volume24h ?? 0) > 0 && (t.liquidityUsd ?? 0) > 0) score += Math.min(6, (t.volume24h! / t.liquidityUsd!) * 3);
    if ((t.liquidityUsd ?? 0) < 2_000 && (t.change24h ?? 0) > 80) score -= 10;
    if ((t.volume24h ?? 0) < 3_000) score -= 4;
    if (mode === "new_launches" && (t.poolAgeHours ?? 1e6) < 72) score += 7;
    if (mode === "cooling_watchlist" && (t.change24h ?? 0) < 0 && (t.volume24h ?? 0) > 10_000) score += 4;

    const reasonTags: string[] = [];
    if ((t.liquidityUsd ?? 0) > 100_000 && (t.volume24h ?? 0) > 100_000) reasonTags.push("liquid mover");
    if ((t.volume24h ?? 0) > 0 && (t.liquidityUsd ?? 0) > 0 && (t.volume24h! / t.liquidityUsd!) > 1.2) reasonTags.push("volume expansion");
    if ((t.liquidityUsd ?? 0) < 10_000 && (t.change24h ?? 0) > 40) reasonTags.push("thin-liquidity moonshot");
    if ((t.poolAgeHours ?? 9999) < 72) reasonTags.push("new pool");
    if ((t.change24h ?? 0) < 0 && (t.liquidityUsd ?? 0) > 40_000) reasonTags.push("cooling but liquid");
    if (reasonTags.length === 0) reasonTags.push("established Base name");

    return { item: { ...t, reasonTags }, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

function qualityScore(item: BaseMarketCandidate): number {
  return (item.liquidityUsd ?? 0) * 0.65 + (item.volume24h ?? 0) * 0.35 + Math.max(0, item.change24h ?? 0) * 150;
}

function mergeCandidate(prev: BaseMarketCandidate, next: BaseMarketCandidate): BaseMarketCandidate {
  const better = qualityScore(next) > qualityScore(prev) ? next : prev;
  const other = better === next ? prev : next;
  return {
    ...better,
    sourceTags: [...new Set([...(better.sourceTags ?? []), ...(other.sourceTags ?? [])])],
    reasonTags: better.reasonTags.length ? better.reasonTags : other.reasonTags,
    tokenAddress: better.tokenAddress ?? other.tokenAddress,
    poolAddress: better.poolAddress ?? other.poolAddress,
  };
}

function dedupe(items: BaseMarketCandidate[]): BaseMarketCandidate[] {
  const byToken = new Map<string, BaseMarketCandidate>();
  for (const item of items) {
    const tokenKey = item.tokenAddress?.toLowerCase();
    if (!tokenKey) continue;
    const prev = byToken.get(tokenKey);
    byToken.set(tokenKey, prev ? mergeCandidate(prev, item) : item);
  }

  const tokenCollapsed = items.map((item) => {
    const tokenKey = item.tokenAddress?.toLowerCase();
    return tokenKey ? (byToken.get(tokenKey) ?? item) : item;
  });

  const byPool = new Map<string, BaseMarketCandidate>();
  for (const item of tokenCollapsed) {
    const key = item.poolAddress?.toLowerCase();
    if (!key) continue;
    const prev = byPool.get(key);
    byPool.set(key, prev ? mergeCandidate(prev, item) : item);
  }

  const poolCollapsed = tokenCollapsed.map((item) => {
    const key = item.poolAddress?.toLowerCase();
    return key ? (byPool.get(key) ?? item) : item;
  });

  const bySymbolName = new Map<string, BaseMarketCandidate>();
  for (const item of poolCollapsed) {
    const symbol = normalizeSymbol(item.symbol);
    const name = normalizeName(item.name);
    const key = `${symbol}|${name}`;
    const prev = bySymbolName.get(key);
    bySymbolName.set(key, prev ? mergeCandidate(prev, item) : item);
  }

  return [...new Set([...bySymbolName.values()])];
}

function dedupeRanked(items: BaseMarketCandidate[], includePoolVariants = false): BaseMarketCandidate[] {
  const out: BaseMarketCandidate[] = [];
  const seenToken = new Set<string>();
  const seenPool = new Set<string>();
  const seenSymName = new Set<string>();
  const seenSymbol = new Set<string>();
  for (const item of items) {
    const token = item.tokenAddress?.toLowerCase() ?? "";
    const pool = item.poolAddress?.toLowerCase() ?? "";
    const symbol = normalizeSymbol(item.symbol);
    const name = normalizeName(item.name);
    const symName = `${symbol}|${name}`;
    if (token && seenToken.has(token)) continue;
    if (pool && seenPool.has(pool)) continue;
    if (seenSymName.has(symName)) continue;
    if (!includePoolVariants && symbol && seenSymbol.has(symbol)) continue;
    if (token) seenToken.add(token);
    if (pool) seenPool.add(pool);
    seenSymName.add(symName);
    if (symbol) seenSymbol.add(symbol);
    out.push(item);
  }
  return out;
}

export async function getBaseMarketUniverse(input: {
  origin: string;
  mode: BaseMarketMode;
  requestedCount: number;
  // reserved for future paging heuristics on conversational "more" requests
  followup?: boolean;
  excludeAddresses?: string[];
  includePoolVariants?: boolean;
}): Promise<{ candidates: BaseMarketCandidate[]; clamped: boolean; cappedMessage: string | null; }> {
  const requested = Number.isFinite(input.requestedCount) ? Math.max(1, Math.floor(input.requestedCount)) : 10;
  const clampedCount = Math.min(100, requested);
  const clamped = requested > 100;
  const cappedMessage = clamped ? "I can show up to 100 usable Base candidates at a time." : null;
  const large = clampedCount >= 100;
  // normal requests: 3 pages/source, explicit 100-style requests: 10 pages/source
  const pages = large ? 10 : 3;
  const perPage = 20;
  const key = `${input.mode}:${large ? "lg" : "sm"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    let c = hit.data;
    const ex = new Set((input.excludeAddresses ?? []).map((x) => x.toLowerCase()));
    if (ex.size) c = c.filter((x) => !x.tokenAddress || !ex.has(x.tokenAddress.toLowerCase()));
    const deduped = dedupeRanked(c, input.includePoolVariants);
    return { candidates: deduped, clamped, cappedMessage };
  }

  const all: BaseMarketCandidate[] = [];
  const pushPools = (json: unknown, source: string) => {
    const payload = (json && typeof json === "object") ? (json as Record<string, unknown>) : {};
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const n = normalizePool(row as Record<string, unknown>, source);
      if (n) all.push(n);
    }
  };

  const pageFetches: Promise<void>[] = [];
  // Lightweight universe only: no deep/security/dev/liquidity endpoints are called here.
  for (let p = 1; p <= pages; p++) {
    for (const type of ["pools", "trending", "new"] as const) {
      const u = `${input.origin}/api/proxy/gt?network=base&type=${type}&page=${p}&per_page=${perPage}`;
      pageFetches.push(fetchJsonTimeout(u).then((j) => {
        const payload = (j && typeof j === "object") ? (j as Record<string, unknown>) : null;
        if (payload && !payload.error) pushPools(payload, `gt_${type}`);
      }).catch(() => undefined));
    }
  }
  pageFetches.push(
    fetchJsonTimeout(`${input.origin}/api/trending`).then((j) => {
      const payload = (j && typeof j === "object") ? (j as Record<string, unknown>) : {};
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        all.push({
          tokenAddress: typeof r?.contract === "string" && /^0x[a-fA-F0-9]{40}$/.test(r.contract) ? r.contract : null,
          poolAddress: null,
          symbol: typeof r?.symbol === "string" ? r.symbol.toUpperCase() : null,
          name: typeof r?.name === "string" ? r.name : null,
          priceUsd: toNum(r?.price),
          change1h: null,
          change6h: null,
          change24h: toNum(r?.change24h),
          volume24h: toNum(r?.volume),
          liquidityUsd: toNum(r?.liquidity),
          fdv: null,
          marketCap: null,
          txns24h: null,
          buys24h: null,
          sells24h: null,
          poolAgeHours: null,
          dex: null,
          sourceTags: ["trending_feed"],
          reasonTags: [],
        });
      }
    }).catch(() => undefined)
  );

  const timeoutMs = large ? 20_000 : 12_000;
  await Promise.race([
    Promise.allSettled(pageFetches),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  const ranked = dedupeRanked(rankAndTag(dedupe(all), input.mode), input.includePoolVariants);
  cache.set(key, { at: Date.now(), data: ranked });
  let out = ranked;
  const ex = new Set((input.excludeAddresses ?? []).map((x) => x.toLowerCase()));
  if (ex.size) out = out.filter((x) => !x.tokenAddress || !ex.has(x.tokenAddress.toLowerCase()));
  return { candidates: out, clamped, cappedMessage };
}
