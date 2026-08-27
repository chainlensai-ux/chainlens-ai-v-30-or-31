import { createRateLimiter, getClientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });

// CLARK PIPELINE AUDIT, DISCLOSED: this proxy is GeckoTerminal's own shared internal gateway —
// every Clark market/token/radar-adjacent read that calls callGeckoTerminal() ultimately lands
// here. Before this fix, a GeckoTerminal outage returned `{ data: [], error: "..." }` with NO
// second source ever attempted, so Clark's market_get_base_movers tool (and anything else routed
// through this proxy) reported "Market feed is temporarily limited" even when DexScreener — a
// real, independent Base data source ChainLens already integrates elsewhere (app/api/radar's own
// GeckoTerminal->DexScreener fallback) — was live. Reshapes DexScreener's boosted/profile-listed
// Base pairs into GeckoTerminal's own pool/token JSON:API-ish shape so every existing caller of
// this proxy (Clark, and anything else built against it) gets a real fallback for free, with zero
// caller-side changes. Never fabricates data: on a DexScreener miss too, the honest empty/error
// shape is preserved, and NO_ETH/BNB fallback is claimed (DexScreener's boost/profile lists are
// not chain-filterable reliably outside 'base', so eth/other networks get the honest failure only).
async function fetchDexScreenerFallback(network: "base" | "eth"): Promise<{ data: unknown[]; included: unknown[]; error: string | null }> {
  if (network !== "base") {
    return { data: [], included: [], error: "No fallback source available for this network." };
  }
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8000);
    try {
      const [profilesRes, boostsRes] = await Promise.allSettled([
        fetch("https://api.dexscreener.com/token-profiles/latest/v1", { signal: ac.signal, cache: "no-store" }),
        fetch("https://api.dexscreener.com/token-boosts/latest/v1", { signal: ac.signal, cache: "no-store" }),
      ]);
      const addresses = new Set<string>();
      for (const settled of [profilesRes, boostsRes]) {
        if (settled.status !== "fulfilled" || !settled.value.ok) continue;
        const json = await settled.value.json().catch(() => null);
        const rows = Array.isArray(json) ? json : [];
        for (const row of rows) {
          const chainId = typeof row?.chainId === "string" ? row.chainId : null;
          const tokenAddress = typeof row?.tokenAddress === "string" ? row.tokenAddress : null;
          if (chainId === "base" && tokenAddress) addresses.add(tokenAddress);
          if (addresses.size >= 30) break;
        }
      }
      if (addresses.size === 0) {
        return { data: [], included: [], error: "DexScreener returned no Base candidates." };
      }
      const tokensRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${[...addresses].join(",")}`, { signal: ac.signal, cache: "no-store" });
      if (!tokensRes.ok) {
        return { data: [], included: [], error: `DexScreener token lookup ${tokensRes.status}` };
      }
      const tokensJson = await tokensRes.json().catch(() => null);
      const pairs: Array<Record<string, unknown>> = Array.isArray(tokensJson?.pairs) ? tokensJson.pairs : [];
      const pools: unknown[] = [];
      const included: unknown[] = [];
      const seenTokenIds = new Set<string>();
      for (const pair of pairs) {
        if (pair.chainId !== "base") continue;
        const pairAddr = typeof pair.pairAddress === "string" ? pair.pairAddress : null;
        const baseTokenRaw = pair.baseToken as Record<string, unknown> | undefined;
        const baseTokenAddr = typeof baseTokenRaw?.address === "string" ? baseTokenRaw.address : null;
        if (!pairAddr || !baseTokenAddr) continue;
        const tokenId = `dexfallback_token_${baseTokenAddr.toLowerCase()}`;
        const liquidity = pair.liquidity as Record<string, unknown> | undefined;
        const volume = pair.volume as Record<string, unknown> | undefined;
        const priceChange = pair.priceChange as Record<string, unknown> | undefined;
        const pairCreatedAtMs = typeof pair.pairCreatedAt === "number" ? pair.pairCreatedAt : null;
        pools.push({
          id: `dexfallback_pool_${pairAddr.toLowerCase()}`,
          relationships: { base_token: { data: { id: tokenId } }, dex: { data: { id: typeof pair.dexId === "string" ? pair.dexId : "unknown" } } },
          attributes: {
            address: pairAddr,
            name: `${typeof baseTokenRaw?.symbol === "string" ? baseTokenRaw.symbol : "?"} / ${typeof (pair.quoteToken as Record<string, unknown> | undefined)?.symbol === "string" ? (pair.quoteToken as Record<string, unknown>).symbol : "?"}`,
            base_token_price_usd: pair.priceUsd ?? null,
            reserve_in_usd: liquidity?.usd ?? null,
            fdv_usd: pair.fdv ?? null,
            market_cap_usd: pair.marketCap ?? null,
            pool_created_at: pairCreatedAtMs != null ? new Date(pairCreatedAtMs).toISOString() : null,
            volume_usd: { h24: volume?.h24 ?? null },
            price_change_percentage: { h24: priceChange?.h24 ?? null, h6: priceChange?.h6 ?? null, h1: priceChange?.h1 ?? null },
          },
        });
        if (!seenTokenIds.has(tokenId)) {
          seenTokenIds.add(tokenId);
          included.push({
            type: "token", id: tokenId,
            attributes: { address: baseTokenAddr, symbol: typeof baseTokenRaw?.symbol === "string" ? baseTokenRaw.symbol : "?", name: typeof baseTokenRaw?.name === "string" ? baseTokenRaw.name : "Unknown" },
          });
        }
      }
      return { data: pools, included, error: pools.length ? null : "DexScreener returned no usable Base pairs." };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return { data: [], included: [], error: err instanceof Error ? err.message : "DexScreener fallback failed." };
  }
}

export async function GET(req: Request) {
  if (!limiter.check(getClientIp(req))) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const network = searchParams.get("network");
  const type = (searchParams.get("type") ?? "pools").toLowerCase();
  const pageRaw = Number(searchParams.get("page") ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.min(10, Math.floor(pageRaw)) : 1;
  const perPageRaw = Number(searchParams.get("per_page") ?? "20");
  const perPage = Number.isFinite(perPageRaw) ? Math.min(20, Math.max(10, Math.floor(perPageRaw))) : 20;

  if (!network) {
    return Response.json({ error: "Missing network param" }, { status: 400 });
  }

  if (network !== "base" && network !== "eth") {
    return Response.json({ error: "Invalid network. Must be 'base' or 'eth'" }, { status: 400 });
  }

  if (!["pools", "trending", "new"].includes(type)) {
    return Response.json({ error: "Invalid type. Must be 'pools', 'trending', or 'new'" }, { status: 400 });
  }

  const endpoint =
    type === "pools"
      ? `networks/${network}/pools`
      : `networks/${network}/${type}_pools`;
  const url = `https://api.geckoterminal.com/api/v2/${endpoint}?page=${page}&include=base_token,quote_token&per_page=${perPage}`;

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "origin": "https://chainlens.ai",
      },
      cache: "no-store",
      signal: ac.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json().catch(() => ({ data: [] }));
      return Response.json({ ...data, source: "geckoterminal" });
    }
  } catch {
    console.log("GT PROXY ERROR");
  }

  // GeckoTerminal failed or threw — try the independent DexScreener fallback before reporting
  // "unavailable". Never claimed for non-'base' networks (fetchDexScreenerFallback returns the
  // honest empty/error shape for those instead of guessing at wrong-chain data).
  const fallback = await fetchDexScreenerFallback(network);
  if (fallback.data.length > 0) {
    return Response.json({ data: fallback.data, included: fallback.included, source: "dexscreener_fallback" });
  }
  return Response.json({ data: [], error: fallback.error ?? "Market source unavailable", source: "none" }, { status: 200 });
}
