// Real, network-calling provider implementations for lib/server/clarkMarketData.ts's
// resolveClarkMarketData(). Kept separate from the pure orchestration module so the provider
// order/caching/formatting logic stays unit-testable with fake providers, while this file is the
// one place that actually talks to CoinGecko/DexScreener/GeckoTerminal. Every function here
// returns null on any failure (bad response, timeout, no match) — never throws, never fabricates
// a quote.

import type { ClarkMarketDataProviders, ClarkMarketQuote } from "./clarkMarketData";

const CHAIN_ID_BY_SLUG: Record<string, number> = {
  ethereum: 1, eth: 1, base: 8453, bnb: 56, bsc: 56, polygon: 137, robinhood: 4663,
};

// CoinGecko coin ids for common majors/top symbols — real, verified ids (not a guess: these are
// CoinGecko's own canonical `/coins/list` ids for each ticker). Extends the existing
// ethereum/bitcoin pair already used by fetchCoinGeckoMajors() in app/api/clark/route.ts so a
// bare "ETH"/"BTC"/"SOL" question resolves without a network round-trip to /search first.
const COINGECKO_MAJOR_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", XRP: "ripple",
  ADA: "cardano", DOGE: "dogecoin", TRX: "tron", TON: "the-open-network", AVAX: "avalanche-2",
  LINK: "chainlink", DOT: "polkadot", MATIC: "matic-network", LTC: "litecoin", SHIB: "shiba-inu",
  UNI: "uniswap", ARB: "arbitrum", OP: "optimism", SUI: "sui", APT: "aptos", NEAR: "near",
  ATOM: "cosmos", FIL: "filecoin", ICP: "internet-computer", HBAR: "hedera-hashgraph",
  ETC: "ethereum-classic", XLM: "stellar", INJ: "injective-protocol", TIA: "celestia",
  SEI: "sei-network", PEPE: "pepe", WIF: "dogwifcoin", BONK: "bonk", RUNE: "thorchain",
  FTM: "fantom", ALGO: "algorand", GRT: "the-graph", SAND: "the-sandbox", MANA: "decentraland",
  AAVE: "aave", MKR: "maker", CRV: "curve-dao-token", LDO: "lido-dao", RNDR: "render-token",
  IMX: "immutable-x", STX: "blockstack", USDC: "usd-coin", USDT: "tether",
};

function coingeckoHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}

async function fetchCoingeckoMarketsById(id: string): Promise<ClarkMarketQuote | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}&price_change_percentage=24h`,
      { headers: coingeckoHeaders(), cache: "no-store", signal: AbortSignal.timeout(7000) },
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null) as Array<Record<string, unknown>> | null;
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
      provider: "coingecko",
      name: typeof row.name === "string" ? row.name : null,
      symbol: typeof row.symbol === "string" ? row.symbol.toUpperCase() : null,
      address: null,
      chainId: null,
      chain: null,
      priceUsd: typeof row.current_price === "number" ? row.current_price : null,
      change24hPct: typeof row.price_change_percentage_24h === "number" ? row.price_change_percentage_24h : null,
      marketCapUsd: typeof row.market_cap === "number" ? row.market_cap : null,
      fdvUsd: typeof row.fully_diluted_valuation === "number" ? row.fully_diluted_valuation : null,
      volume24hUsd: typeof row.total_volume === "number" ? row.total_volume : null,
      liquidityUsd: null,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/** Real CoinGecko provider: a known major resolves directly by id; any other symbol is resolved
 * via /search first — if more than one real coin shares the ticker, all candidates are returned
 * as `matches` so the caller can ask the user which one they meant, instead of guessing. */
export async function coingeckoMarketProvider(symbol: string): Promise<{ quote: ClarkMarketQuote; matches: ClarkMarketQuote[] } | null> {
  const upper = symbol.toUpperCase();
  const knownId = COINGECKO_MAJOR_IDS[upper];
  if (knownId) {
    const quote = await fetchCoingeckoMarketsById(knownId);
    return quote ? { quote, matches: [quote] } : null;
  }
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`, {
      headers: coingeckoHeaders(), cache: "no-store", signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null) as { coins?: Array<{ id: string; symbol: string; name: string }> } | null;
    const coins = (json?.coins ?? []).filter((c) => c.symbol?.toUpperCase() === upper).slice(0, 5);
    if (coins.length === 0) return null;
    if (coins.length === 1) {
      const quote = await fetchCoingeckoMarketsById(coins[0].id);
      return quote ? { quote, matches: [quote] } : null;
    }
    const quotes = (await Promise.all(coins.map((c) => fetchCoingeckoMarketsById(c.id)))).filter((q): q is ClarkMarketQuote => q != null);
    if (quotes.length === 0) return null;
    return { quote: quotes[0], matches: quotes };
  } catch {
    return null;
  }
}

function dexScreenerPairToQuote(pair: Record<string, unknown>): ClarkMarketQuote | null {
  const baseToken = pair.baseToken as Record<string, unknown> | undefined;
  if (!baseToken) return null;
  const priceUsd = typeof pair.priceUsd === "string" ? parseFloat(pair.priceUsd) : null;
  const change24h = pair.priceChange && typeof (pair.priceChange as Record<string, unknown>).h24 === "number"
    ? (pair.priceChange as Record<string, unknown>).h24 as number : null;
  const liquidity = pair.liquidity && typeof (pair.liquidity as Record<string, unknown>).usd === "number"
    ? (pair.liquidity as Record<string, unknown>).usd as number : null;
  const volume24h = pair.volume && typeof (pair.volume as Record<string, unknown>).h24 === "number"
    ? (pair.volume as Record<string, unknown>).h24 as number : null;
  const chainSlug = typeof pair.chainId === "string" ? pair.chainId.toLowerCase() : null;
  return {
    provider: "dexscreener",
    name: typeof baseToken.name === "string" ? baseToken.name : null,
    symbol: typeof baseToken.symbol === "string" ? baseToken.symbol.toUpperCase() : null,
    address: typeof baseToken.address === "string" ? baseToken.address : null,
    chainId: chainSlug ? (CHAIN_ID_BY_SLUG[chainSlug] ?? null) : null,
    chain: chainSlug,
    priceUsd: priceUsd != null && Number.isFinite(priceUsd) ? priceUsd : null,
    change24hPct: change24h,
    marketCapUsd: typeof pair.marketCap === "number" ? pair.marketCap : null,
    fdvUsd: typeof pair.fdv === "number" ? pair.fdv : null,
    volume24hUsd: volume24h,
    liquidityUsd: liquidity,
    fetchedAt: Date.now(),
  };
}

/** Real DexScreener provider. For a contract address, reads its token endpoint directly (a
 * single, unambiguous subject). For a bare symbol, uses DexScreener's search endpoint and — when
 * several distinct base-token addresses share the ticker — returns them all as `matches` rather
 * than silently picking the highest-liquidity one. */
export async function dexScreenerMarketProvider(symbolOrAddress: string, _chain: string | null): Promise<{ quote: ClarkMarketQuote; matches: ClarkMarketQuote[] } | null> {
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(symbolOrAddress) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(symbolOrAddress);
  try {
    if (isAddress) {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${symbolOrAddress}`, { cache: "no-store", signal: AbortSignal.timeout(7000) });
      if (!res.ok) return null;
      const json = await res.json().catch(() => null) as { pairs?: Array<Record<string, unknown>> } | null;
      const pairs = json?.pairs ?? [];
      if (pairs.length === 0) return null;
      const ranked = [...pairs].sort((a, b) => (Number((b.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)) - (Number((a.liquidity as Record<string, unknown> | undefined)?.usd ?? 0)));
      const quote = dexScreenerPairToQuote(ranked[0]);
      return quote ? { quote, matches: [quote] } : null;
    }
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbolOrAddress)}`, { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null) as { pairs?: Array<Record<string, unknown>> } | null;
    const pairs = (json?.pairs ?? []).filter((p) => {
      const baseToken = p.baseToken as Record<string, unknown> | undefined;
      return typeof baseToken?.symbol === "string" && baseToken.symbol.toUpperCase() === symbolOrAddress.toUpperCase();
    });
    if (pairs.length === 0) return null;
    const byAddress = new Map<string, Record<string, unknown>>();
    for (const p of pairs) {
      const addr = ((p.baseToken as Record<string, unknown> | undefined)?.address as string | undefined)?.toLowerCase();
      if (!addr) continue;
      const existing = byAddress.get(addr);
      const liq = Number((p.liquidity as Record<string, unknown> | undefined)?.usd ?? 0);
      const existingLiq = existing ? Number((existing.liquidity as Record<string, unknown> | undefined)?.usd ?? 0) : -1;
      if (!existing || liq > existingLiq) byAddress.set(addr, p);
    }
    const distinctPairs = [...byAddress.values()].sort((a, b) => Number((b.liquidity as Record<string, unknown> | undefined)?.usd ?? 0) - Number((a.liquidity as Record<string, unknown> | undefined)?.usd ?? 0));
    const quotes = distinctPairs.map(dexScreenerPairToQuote).filter((q): q is ClarkMarketQuote => q != null).slice(0, 5);
    if (quotes.length === 0) return null;
    return { quote: quotes[0], matches: quotes };
  } catch {
    return null;
  }
}

/** Real GeckoTerminal provider — address-keyed only, used when DexScreener has nothing for a
 * specific chain+address pair. */
export async function geckoTerminalMarketProvider(address: string, chain: string | null): Promise<ClarkMarketQuote | null> {
  const network = chain === "bnb" ? "bsc" : (chain ?? "eth");
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${address}`, {
      headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null) as { data?: { attributes?: Record<string, unknown> } } | null;
    const attrs = json?.data?.attributes;
    if (!attrs) return null;
    const priceUsd = typeof attrs.price_usd === "string" ? parseFloat(attrs.price_usd) : null;
    return {
      provider: "geckoterminal",
      name: typeof attrs.name === "string" ? attrs.name : null,
      symbol: typeof attrs.symbol === "string" ? attrs.symbol.toUpperCase() : null,
      address,
      chainId: chain ? (CHAIN_ID_BY_SLUG[chain] ?? null) : null,
      chain,
      priceUsd: priceUsd != null && Number.isFinite(priceUsd) ? priceUsd : null,
      change24hPct: null,
      marketCapUsd: typeof attrs.market_cap_usd === "string" ? parseFloat(attrs.market_cap_usd) : null,
      fdvUsd: typeof attrs.fdv_usd === "string" ? parseFloat(attrs.fdv_usd) : null,
      volume24hUsd: attrs.volume_usd && typeof (attrs.volume_usd as Record<string, unknown>).h24 === "string"
        ? parseFloat((attrs.volume_usd as Record<string, unknown>).h24 as string) : null,
      liquidityUsd: typeof attrs.total_reserve_in_usd === "string" ? parseFloat(attrs.total_reserve_in_usd) : null,
      fetchedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/** Maps /api/token's real JSON response onto a market quote — reads the same normalized
 * top-level fields (priceUsd/marketCapUsd/fdvUsd/volume24hUsd/liquidityUsd) the rest of this
 * codebase already treats as the canonical resolved values, never a second independent parse of
 * raw provider payloads. Returns null only when the scan itself returned no usable price/market
 * data at all (never fabricates a $0 in that case). */
export function tokenScannerQuoteFromApiJson(json: Record<string, unknown>, address: string, chainSlug: string): ClarkMarketQuote | null {
  const priceUsd = typeof json.priceUsd === "number" ? json.priceUsd : null;
  const marketCapUsd = typeof json.marketCapUsd === "number" ? json.marketCapUsd : null;
  const fdvUsd = typeof json.fdvUsd === "number" ? json.fdvUsd : null;
  const volume24hUsd = typeof json.volume24hUsd === "number" ? json.volume24hUsd : null;
  const liquidityUsd = typeof json.liquidityUsd === "number" ? json.liquidityUsd : null;
  if (priceUsd == null && marketCapUsd == null && volume24hUsd == null) return null;
  const trend = json.marketTrendSnapshot as { changes?: Array<{ label?: string; value?: number | null }> } | undefined;
  const change24h = trend?.changes?.find((c) => c.label === "24h")?.value ?? null;
  return {
    provider: "token_scanner_api",
    name: typeof json.name === "string" ? json.name : null,
    symbol: typeof json.symbol === "string" ? json.symbol.toUpperCase() : null,
    address,
    chainId: CHAIN_ID_BY_SLUG[chainSlug] ?? null,
    chain: chainSlug,
    priceUsd,
    change24hPct: typeof change24h === "number" ? change24h : null,
    marketCapUsd,
    fdvUsd,
    volume24hUsd,
    liquidityUsd,
    fetchedAt: Date.now(),
  };
}

/** Maps the token evidence already cached in Clark's session memory (the token the user is
 * actively looking at/just scanned) onto a market quote — the "ChainLens active scan/session
 * context" provider, tried before any network call. */
export function sessionContextQuote(input: {
  address: string | null;
  symbol: string | null;
  name: string | null;
  chain: string | null;
  market: { price?: number | null; change24h?: number | null; volume24h?: number | null; liquidity?: number | null; marketCap?: number | null; fdv?: number | null } | null | undefined;
}): ClarkMarketQuote | null {
  const m = input.market;
  if (!m) return null;
  if (m.price == null && m.marketCap == null && m.volume24h == null) return null;
  return {
    provider: "chainlens_session",
    name: input.name,
    symbol: input.symbol ? input.symbol.toUpperCase() : null,
    address: input.address,
    chainId: input.chain ? (CHAIN_ID_BY_SLUG[input.chain] ?? null) : null,
    chain: input.chain,
    priceUsd: m.price ?? null,
    change24hPct: m.change24h ?? null,
    marketCapUsd: m.marketCap ?? null,
    fdvUsd: m.fdv ?? null,
    volume24hUsd: m.volume24h ?? null,
    liquidityUsd: m.liquidity ?? null,
    fetchedAt: Date.now(),
  };
}

/** Wires the real network providers together in the required order. `tokenScannerApi` and
 * `sessionContext` are request-scoped (need the caller's origin/auth/session), so they're passed
 * in by the route handler rather than defaulted here. */
export function createClarkMarketDataProviders(input: {
  sessionContext?: ClarkMarketDataProviders["sessionContext"];
  tokenScannerApi?: ClarkMarketDataProviders["tokenScannerApi"];
}): ClarkMarketDataProviders {
  return {
    sessionContext: input.sessionContext,
    tokenScannerApi: input.tokenScannerApi,
    dexScreener: dexScreenerMarketProvider,
    geckoTerminal: geckoTerminalMarketProvider,
    coingecko: coingeckoMarketProvider,
  };
}
