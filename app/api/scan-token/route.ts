import { NextRequest, NextResponse } from "next/server";
import { fetchGoPlus } from "@/lib/goplus";
import { getOrFetchCached } from "@/lib/coingeckoCache";

export const dynamic = "force-dynamic";

const GT = "https://api.geckoterminal.com/api/v2";
const GT_HEADERS = { accept: "application/json", origin: "https://chainlens.ai" };

// ---------- Types ----------

interface PoolAttrs {
  name?: string;
  base_token_price_usd?: string;
  reserve_in_usd?: string;
  volume_usd?: { h24?: string };
  price_change_percentage?: { h24?: number };
}

interface GTPool {
  id: string;
  attributes: PoolAttrs;
  relationships?: {
    base_token?: { data?: { id: string } };
    network?: { data?: { id: string } };
  };
}

interface GTToken {
  id: string;
  type: string;
  attributes: { name?: string; symbol?: string; address?: string };
}

// ---------- Helpers ----------

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? null : n;
}

// GeckoTerminal IDs are "{network}_{address}" — strip the prefix to get the address
function idToAddress(id: string): string {
  const idx = id.indexOf("_");
  return idx === -1 ? id : id.slice(idx + 1);
}

function findTokenMeta(included: GTToken[], contract: string): GTToken["attributes"] | null {
  const norm = contract.toLowerCase();
  const hit = included.find(
    (t) =>
      t.type === "token" &&
      (t.attributes?.address?.toLowerCase() === norm || idToAddress(t.id).toLowerCase() === norm)
  );
  return hit?.attributes ?? null;
}

// ---------- GeckoTerminal fetchers ----------

// Returns the Base contract address of the top matching pool, or null
async function resolveNameToContract(query: string): Promise<{ contract: string | null; warning?: string }> {
  const result = await getOrFetchCached<{ data?: GTPool[] }>({
    key: `coingecko:token-lookup:${query.toLowerCase()}`,
    ttlMs: 60_000,
    onLog: msg => console.info(`[scan-token] ${msg}`),
    fetcher: async () => {
      const url = `${GT}/search/pools?query=${encodeURIComponent(query)}&network=base`;
      const res = await fetch(url, { headers: GT_HEADERS, cache: "no-store" });
      if (!res.ok) throw new Error(`GeckoTerminal lookup failed (${res.status})`);
      return res.json() as Promise<{ data?: GTPool[] }>;
    },
  });

  const pools: GTPool[] = Array.isArray(result.data?.data) ? result.data.data : [];

  // Keep only Base pools and pick the first
  const pool = pools.find(
    (p) =>
      p.id?.startsWith("base_") ||
      p.relationships?.network?.data?.id === "base"
  );
  if (!pool) return { contract: null, warning: result.warning };

  const tokenId = pool.relationships?.base_token?.data?.id ?? "";
  const address = idToAddress(tokenId);
  return { contract: address.startsWith("0x") ? address : null, warning: result.warning };
}

// Returns pools + included token metadata for a Base contract
async function fetchPools(
  contract: string
): Promise<{ pools: GTPool[]; included: GTToken[]; warning?: string }> {
  const cacheKey = `coingecko:token-scan:${contract.toLowerCase()}`;
  const result = await getOrFetchCached<{ data?: GTPool[]; included?: GTToken[] }>({
    key: cacheKey,
    ttlMs: 120_000,
    onLog: msg => console.info(`[scan-token] ${msg}`),
    fetcher: async () => {
      const url = `${GT}/networks/base/tokens/${contract}/pools?include=base_token,quote_token`;
      const res = await fetch(url, { headers: GT_HEADERS, cache: "no-store" });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GeckoTerminal ${res.status}: ${text.slice(0, 120)}`);
      }

      return res.json() as Promise<{ data?: GTPool[]; included?: GTToken[] }>;
    },
  });

  return {
    pools: Array.isArray(result.data?.data) ? result.data.data : [],
    included: Array.isArray(result.data?.included) ? result.data.included : [],
    warning: result.warning,
  };
}

// ---------- Response builder ----------

function buildToken(contract: string, pools: GTPool[], included: GTToken[]) {
  const meta = findTokenMeta(included, contract);

  // Sort by liquidity descending, use the top pool as the price reference
  const sorted = [...pools].sort(
    (a, b) => (toNum(b.attributes.reserve_in_usd) ?? 0) - (toNum(a.attributes.reserve_in_usd) ?? 0)
  );
  const top = sorted[0];

  return {
    name: meta?.name ?? top?.attributes?.name?.split(" / ")[0] ?? "Unknown",
    symbol: meta?.symbol ?? "?",
    contract,
    price: toNum(top?.attributes?.base_token_price_usd),
    liquidity: toNum(top?.attributes?.reserve_in_usd),
    volume24h: toNum(top?.attributes?.volume_usd?.h24),
    priceChange24h: toNum(top?.attributes?.price_change_percentage?.h24),
    pools: sorted.map((p) => ({
      address: idToAddress(p.id),
      name: p.attributes.name,
      price: toNum(p.attributes.base_token_price_usd),
      liquidity: toNum(p.attributes.reserve_in_usd),
      volume24h: toNum(p.attributes.volume_usd?.h24),
      priceChange24h: toNum(p.attributes.price_change_percentage?.h24),
    })),
  };
}

// ---------- Handler ----------

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const query    = searchParams.get("query")?.trim();
  const contract = searchParams.get("contract")?.trim();

  if (!query && !contract) {
    return NextResponse.json(
      { error: "Provide ?query=<name> or ?contract=<0x address>" },
      { status: 400 }
    );
  }

  try {
    let resolvedContract: string | null = null;
    let cacheWarning: string | undefined;

    if (contract) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
        return NextResponse.json(
          { error: "Invalid contract address — must be a 42-character 0x hex string." },
          { status: 400 }
        );
      }
      resolvedContract = contract;
    } else if (query) {
      const resolved = await resolveNameToContract(query);
      resolvedContract = resolved.contract;
      cacheWarning = resolved.warning;
      if (!resolvedContract) {
        return NextResponse.json({ error: "Token not found", query }, { status: 404 });
      }
    }

    if (!resolvedContract) {
      return NextResponse.json({ error: "Token not found", query }, { status: 404 });
    }

    const origin = req.nextUrl.origin;
    const [{ pools, included, warning: poolsWarning }, goPlusRes] = await Promise.all([
      fetchPools(resolvedContract),
      fetchGoPlus(resolvedContract, origin),
    ]);

    if (pools.length === 0) {
      return NextResponse.json(
        { error: "Token not found", query: query ?? resolvedContract },
        { status: 404 }
      );
    }

    const token = buildToken(resolvedContract, pools, included);
    return NextResponse.json({
      ok: true,
      data: { ...token, goplus: goPlusRes.ok ? goPlusRes.data : null },
      warning: poolsWarning ?? cacheWarning,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed";
    console.error("[scan-token]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
