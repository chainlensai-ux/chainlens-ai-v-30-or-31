import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface MergedToken {
  address: string;
  symbol: string;
  name: string;
  price: number | null;
  liquidity: number | null;
  volume24h: number | null;
  change24h: number | null;
  source: string;
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

function extractTokenMeta(included: any[], tokenId: string) {
  const item = included.find((i: any) => i.id === tokenId);
  if (!item) return null;
  return {
    address: item.attributes?.address ?? "",
    symbol: item.attributes?.symbol ?? "",
    name: item.attributes?.name ?? "",
  };
}

function normalizeGT(pool: any, included: any[]): MergedToken | null {
  try {
    const baseTokenId = pool?.relationships?.base_token?.data?.id;
    if (!baseTokenId) return null;
    const meta = extractTokenMeta(included, baseTokenId);
    if (!meta || !meta.symbol) return null;
    return {
      address: meta.address,
      symbol: meta.symbol,
      name: meta.name,
      price: Number(pool.attributes?.base_token_price_usd) || null,
      liquidity: Number(pool.attributes?.reserve_in_usd) || null,
      volume24h: Number(pool.attributes?.volume_usd?.h24) || null,
      change24h: Number(pool.attributes?.price_change_percentage?.h24) || null,
      source: "geckoterminal",
    };
  } catch {
    return null;
  }
}

async function fetchGT(baseUrl: string): Promise<MergedToken[]> {
  try {
    const res = await fetch(`${baseUrl}/api/proxy/gt?network=base`, { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    const included: any[] = Array.isArray(data?.included) ? data.included : [];
    return (Array.isArray(data?.data) ? data.data : [])
      .map((pool: any) => normalizeGT(pool, included))
      .filter((t: MergedToken | null): t is MergedToken => t !== null);
  } catch {
    return [];
  }
}

async function fetchCoinGecko(): Promise<MergedToken[]> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/search/trending", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data?.coins) ? data.coins : []).map((c: any) => ({
      address: c?.item?.id ?? "",
      symbol: c?.item?.symbol ?? "",
      name: c?.item?.name ?? "",
      price: c?.item?.data?.price ?? null,
      liquidity: null,
      volume24h: c?.item?.data?.total_volume ?? null,
      change24h: c?.item?.data?.price_change_24h ?? null,
      source: "coingecko",
    }));
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "";

    const [gtTokens, cgTokens] = await Promise.all([
      fetchGT(baseUrl),
      fetchCoinGecko(),
    ]);

    const merged = [...gtTokens, ...cgTokens];

    const deduped = Object.values(
      merged.reduce<Record<string, MergedToken>>((acc, t) => {
        if (t.symbol && !acc[t.symbol]) acc[t.symbol] = t;
        return acc;
      }, {})
    );

    deduped.sort((a, b) => {
      const liqDiff = (b.liquidity ?? 0) - (a.liquidity ?? 0);
      if (liqDiff !== 0) return liqDiff;
      return (b.volume24h ?? 0) - (a.volume24h ?? 0);
    });

    return NextResponse.json({ data: deduped });
  } catch (err) {
    console.error("Trending API error:", err);
    return NextResponse.json({ data: [], error: "trending_failed" }, { status: 200 });
  }
}
