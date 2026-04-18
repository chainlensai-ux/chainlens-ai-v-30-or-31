import { NextResponse } from "next/server";

export async function GET() {
  try {
    // GoldRush trending (Base)
    const gr = await fetch(
      "https://api.goldrushhq.io/v1/tokens/trending?chain=base",
      {
        headers: {
          "x-api-key": process.env.NEXT_PUBLIC_GOLDRUSH_API_KEY || ""
        }
      }
    );
    const grData = await gr.json();

    // CoinGecko trending
    const cg = await fetch("https://api.coingecko.com/api/v3/search/trending");
    const cgData = await cg.json();

    // Normalize GoldRush
    const goldrushTokens = (grData?.data || []).map((t: {
      address: string; symbol: string; name: string;
      price_usd: number; liquidity_usd: number; volume_24h_usd: number; price_change_24h: number;
    }) => ({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      price: t.price_usd,
      liquidity: t.liquidity_usd,
      volume24h: t.volume_24h_usd,
      change24h: t.price_change_24h,
      source: "goldrush"
    }));

    // Normalize Gecko
    const geckoTokens = (cgData?.coins || []).map((c: {
      item: { id: string; symbol: string; name: string; data?: { price?: number; total_volume?: number; price_change_24h?: number } }
    }) => ({
      address: c.item.id,
      symbol: c.item.symbol,
      name: c.item.name,
      price: c.item.data?.price || null,
      liquidity: null,
      volume24h: c.item.data?.total_volume || null,
      change24h: c.item.data?.price_change_24h || null,
      source: "gecko"
    }));

    // Merge + dedupe
    const merged = [...goldrushTokens, ...geckoTokens];
    const deduped = Object.values(
      merged.reduce<Record<string, typeof merged[0]>>((acc, t) => {
        if (!acc[t.symbol]) acc[t.symbol] = t;
        return acc;
      }, {})
    );

    // Sort
    deduped.sort((a, b) => {
      const liqA = (a as { liquidity: number | null }).liquidity || 0;
      const liqB = (b as { liquidity: number | null }).liquidity || 0;
      if (liqA !== liqB) return liqB - liqA;

      const volA = (a as { volume24h: number | null }).volume24h || 0;
      const volB = (b as { volume24h: number | null }).volume24h || 0;
      return volB - volA;
    });

    return NextResponse.json({ data: deduped });
  } catch (err) {
    console.error("Trending API error:", err);
    return NextResponse.json({ data: [] });
  }
}
