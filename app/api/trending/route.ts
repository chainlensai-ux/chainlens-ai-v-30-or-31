import { NextResponse } from "next/server";

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

interface GTIncluded {
  id: string;
  attributes: { address: string; symbol: string; name: string };
}

interface GTPool {
  relationships: { base_token: { data: { id: string } } };
  attributes: {
    price_usd: string | null;
    reserve_in_usd: string | null;
    volume_usd: { h24: string | null };
    price_change_percentage: { h24: string | null };
  };
}

export async function GET() {
  try {
    /*
    // GoldRush trending (Base)
    const gr = await fetch(
      "https://api.goldrushhq.io/v1/tokens/search?query=base",
      {
        headers: {
          "x-api-key": process.env.NEXT_PUBLIC_GOLDRUSH_API_KEY || ""
        }
      }
    );
    const grData = await gr.json();

    // Normalize GoldRush
    const goldrushTokens = (grData?.results || []).map((t: {
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
    */

    // GeckoTerminal Base + Ethereum pools
    const gtBase = await fetch(
      "https://api.geckoterminal.com/api/v2/networks/base/pools?page=1&include=base_token,quote_token"
    );
    const gtEth = await fetch(
      "https://api.geckoterminal.com/api/v2/networks/eth/pools?page=1&include=base_token,quote_token"
    );

    const gtBaseData = await gtBase.json();
    const gtEthData = await gtEth.json();

    // Helper: extract token metadata from included[]
    function extractTokenMeta(included: any[], tokenId: string) {
      const item = included.find(i => i.id === tokenId);
      if (!item) return null;
      return {
        address: item.attributes.address,
        symbol: item.attributes.symbol,
        name: item.attributes.name
      };
    }

    // Normalize GeckoTerminal pools (BASE token only)
    function normalizeGT(pool: any, included: any[]): MergedToken | null {
      console.log("POOL ATTRIBUTES:", pool.attributes);
      const baseTokenId = pool.relationships.base_token.data.id;
      console.log("BASE TOKEN ID:", baseTokenId);
      console.log("INCLUDED LENGTH:", included.length);
      const meta = extractTokenMeta(included, baseTokenId);
      console.log("META:", meta);
      if (!meta) return null;

      return {
        address: meta.address,
        symbol: meta.symbol,
        name: meta.name,
        price: Number(pool.attributes.base_token_price_usd),
        liquidity: Number(pool.attributes.reserve_in_usd),
        volume24h: Number(pool.attributes.volume_usd.h24),
        change24h: Number(pool.attributes.price_change_percentage.h24),
        source: "geckoterminal"
      };
    }

    const gtBaseTokens = (gtBaseData?.data || [])
      .map((pool: GTPool) => normalizeGT(pool, gtBaseData?.included || []))
      .filter(Boolean);

    const gtEthTokens = (gtEthData?.data || [])
      .map((pool: GTPool) => normalizeGT(pool, gtEthData?.included || []))
      .filter(Boolean);

    const gtTokens: MergedToken[] = [...gtBaseTokens, ...gtEthTokens];

    // CoinGecko trending
    const cg = await fetch("https://api.coingecko.com/api/v3/search/trending");
    const cgData = await cg.json();

    const cgTokens: MergedToken[] = (cgData?.coins || []).map((c: {
      item: { id: string; symbol: string; name: string; data?: { price?: number; total_volume?: number; price_change_24h?: number } }
    }) => ({
      address: c.item.id,
      symbol: c.item.symbol,
      name: c.item.name,
      price: c.item.data?.price || null,
      liquidity: null,
      volume24h: c.item.data?.total_volume || null,
      change24h: c.item.data?.price_change_24h || null,
      source: "coingecko"
    }));

    // Merge + dedupe
    const merged = [...gtTokens, ...cgTokens];
    const deduped = Object.values(
      merged.reduce<Record<string, MergedToken>>((acc, t) => {
        if (!acc[t.symbol]) acc[t.symbol] = t;
        return acc;
      }, {})
    );

    // Sort by liquidity → volume
    deduped.sort((a, b) => {
      const liqA = a.liquidity || 0;
      const liqB = b.liquidity || 0;
      if (liqA !== liqB) return liqB - liqA;

      const volA = a.volume24h || 0;
      const volB = b.volume24h || 0;
      return volB - volA;
    });

    return NextResponse.json({ data: deduped });
  } catch (err) {
    console.error("Trending API error:", err);
    return NextResponse.json({ data: [] });
  }
}
