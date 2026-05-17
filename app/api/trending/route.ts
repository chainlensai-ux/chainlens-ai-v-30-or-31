import { NextResponse, type NextRequest } from "next/server";
import { getOrFetchCached } from "@/lib/coingeckoCache";
import { createRateLimiter, getClientIp } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

interface MergedToken {
  contract: string;
  symbol: string;
  name: string;
  chain: string;
  price: number | null;
  liquidity: number | null;
  volume: number | null;
  change24h: number | null;
  source: string;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "nan") return null;
    const normalized = trimmed.replace(/[$,\s]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickVolume(pool: GTPool): number | null {
  const attrs = pool.attributes;
  const candidates = [
    attrs?.volume_usd?.h24,
    (attrs as { volume_usd?: unknown } | undefined)?.volume_usd,
    (attrs as { h24_volume_usd?: unknown } | undefined)?.h24_volume_usd,
  ];

  for (const candidate of candidates) {
    const parsed = parseNumeric(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}
type GTPool = {
  relationships?: { base_token?: { data?: { id?: string } } }
  attributes?: {
    base_token_price_usd?: number | string
    reserve_in_usd?: number | string
    volume_usd?: { h24?: number | string }
    price_change_percentage?: { h24?: number | string }
  }
}
type CGCoin = {
  item?: {
    id?: string
    symbol?: string
    name?: string
    data?: {
      price?: number | string
      total_volume?: number | null
      price_change_percentage_24h?: { usd?: number | null }
    }
  }
}

/*
// GoldRush trending (Base) — kept for future use
const gr = await fetch(
  "https://api.goldrushhq.io/v1/tokens/search?query=base",
  { headers: { "x-api-key": process.env.NEXT_PUBLIC_GOLDRUSH_API_KEY || "" } }
);
const grData = await gr.json();
const goldrushTokens = (grData?.results || []).map((t: {
  address: string; symbol: string; name: string;
  price_usd: number; liquidity_usd: number; volume_24h_usd: number; price_change_24h: number;
}) => ({
  address: t.address, symbol: t.symbol, name: t.name,
  price: t.price_usd, liquidity: t.liquidity_usd,
  volume24h: t.volume_24h_usd, change24h: t.price_change_24h, source: "goldrush"
}));
*/

function extractTokenMeta(included: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string } }>, tokenId: string) {
  const item = included.find((i) => i.id === tokenId);
  if (!item) return null;
  return {
    address: item.attributes?.address ?? "",
    symbol: item.attributes?.symbol ?? "",
    name: item.attributes?.name ?? "",
  };
}

function normalizeGT(pool: GTPool, included: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string } }>): MergedToken | null {
  try {
    const baseTokenId = pool?.relationships?.base_token?.data?.id;
    if (!baseTokenId) return null;
    const meta = extractTokenMeta(included, baseTokenId);
    if (!meta || !meta.symbol) return null;
    return {
      contract: meta.address,
      symbol: meta.symbol,
      name: meta.name,
      chain: "base",
      price: parseNumeric(pool.attributes?.base_token_price_usd),
      liquidity: parseNumeric(pool.attributes?.reserve_in_usd),
      volume: pickVolume(pool),
      change24h: parseNumeric(pool.attributes?.price_change_percentage?.h24),
      source: "geckoterminal",
    };
  } catch {
    return null;
  }
}

async function fetchGT(): Promise<{ tokens: MergedToken[]; warning?: string }> {
  try {
    const result = await getOrFetchCached<{ data?: GTPool[]; included?: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string } }> }>({
      key: 'coingecko:trending-base',
      ttlMs: 60_000,
      onLog: msg => console.info(`[trending] ${msg}`),
      fetcher: async () => {
        const res = await fetch(
          'https://api.geckoterminal.com/api/v2/networks/base/pools?page=1&include=base_token,quote_token',
          { headers: { accept: 'application/json' }, cache: 'no-store' }
        )
        if (!res.ok) throw new Error(`GeckoTerminal trending failed (${res.status})`)
        return res.json() as Promise<{ data?: GTPool[]; included?: Array<{ id?: string; attributes?: { address?: string; symbol?: string; name?: string } }> }>
      },
    })

    const included = Array.isArray(result.data?.included) ? result.data.included : []
    const tokens = (Array.isArray(result.data?.data) ? result.data.data : [])
      .map((pool: GTPool) => normalizeGT(pool, included))
      .filter((t: MergedToken | null): t is MergedToken => t !== null)

    return { tokens, warning: result.warning }
  } catch {
    return { tokens: [] }
  }
}

async function fetchCoinGecko(): Promise<{ tokens: MergedToken[]; warning?: string }> {
  try {
    const result = await getOrFetchCached<{ coins?: CGCoin[] }>({
      key: 'coingecko:trending-search',
      ttlMs: 120_000,
      onLog: msg => console.info(`[trending] ${msg}`),
      fetcher: async () => {
        const res = await fetch("https://api.coingecko.com/api/v3/search/trending", { cache: "no-store" })
        if (!res.ok) throw new Error(`CoinGecko trending failed (${res.status})`)
        return res.json() as Promise<{ coins?: CGCoin[] }>
      },
    })

    const tokens = (Array.isArray(result.data?.coins) ? result.data.coins : []).map((c: CGCoin) => {
      const rawPrice = c?.item?.data?.price;
      const price = typeof rawPrice === "number"
        ? rawPrice
        : typeof rawPrice === "string"
          ? parseFloat(rawPrice.replace(/[^0-9.]/g, "")) || null
          : null;
      return {
        contract: c?.item?.id ?? "",
        symbol: c?.item?.symbol ?? "",
        name: c?.item?.name ?? "",
        chain: "coingecko",
        price,
        liquidity: null,
        volume: c?.item?.data?.total_volume ?? null,
        change24h: c?.item?.data?.price_change_percentage_24h?.usd ?? null,
        source: "coingecko",
      };
    })

    return { tokens, warning: result.warning }
  } catch {
    return { tokens: [] }
  }
}

export async function GET(req: NextRequest) {
  if (!limiter.check(getClientIp(req))) {
    return NextResponse.json({ data: [], error: "Too many requests" }, { status: 429 });
  }

  try {
    const [gtResult, cgResult] = await Promise.all([
      fetchGT(),
      fetchCoinGecko(),
    ]);

    const merged = [...gtResult.tokens, ...cgResult.tokens];

    const deduped = Object.values(
      merged.reduce<Record<string, MergedToken>>((acc, t) => {
        if (t.symbol && !acc[t.symbol]) acc[t.symbol] = t;
        return acc;
      }, {})
    );

    deduped.sort((a, b) => {
      const liqDiff = (b.liquidity ?? 0) - (a.liquidity ?? 0);
      if (liqDiff !== 0) return liqDiff;
      return (b.volume ?? 0) - (a.volume ?? 0);
    });

    return NextResponse.json({ data: deduped, warning: gtResult.warning ?? cgResult.warning });
  } catch (err) {
    console.error("Trending API error:", err);
    return NextResponse.json({ data: [], error: "trending_failed" }, { status: 200 });
  }
}
