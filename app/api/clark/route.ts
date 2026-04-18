import { NextRequest, NextResponse } from "next/server";

const {
  GOLDRUSH_API_KEY,
  ZERION_KEY,
  COVALENT_API_KEY,
  ANTHROPIC_API_KEY,
  BASESCAN_API_KEY,
} = process.env;

// ---------- Types ----------

type SupportedChain = "base" | "ethereum" | "polygon" | "bnb";

type ClarkFeature =
  | "token-scanner"
  | "wallet-scanner"
  | "dev-wallet-detector"
  | "liquidity-safety"
  | "whale-alerts"
  | "pump-alerts"
  | "base-radar"
  | "clark-ai";

interface ClarkRequestBody {
  feature: ClarkFeature;
  addressOrToken?: string;
  walletAddress?: string;
  tokenAddress?: string;
  chain?: SupportedChain;
  prompt?: string;
}

interface ClarkContext {
  trending?: unknown[];
  gtPools?: unknown[];
  tokenData?: unknown;
  walletScan?: unknown;
  analysis?: unknown;
}

// ---------- Chain name maps ----------

const GOLDRUSH_CHAIN: Record<SupportedChain, string> = {
  base: "base-mainnet",
  ethereum: "eth-mainnet",
  polygon: "matic-mainnet",
  bnb: "bsc-mainnet",
};

const GOPLUS_CHAIN_ID: Record<SupportedChain, string> = {
  base: "8453",
  ethereum: "1",
  polygon: "137",
  bnb: "56",
};

// ---------- Helpers ----------

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function extractAddress(text: string): string | null {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0] : null;
}

function gtNetwork(chain: SupportedChain): "base" | "eth" {
  return chain === "ethereum" ? "eth" : "base";
}

// ---------- API clients ----------

async function callGoldrush(
  path: string,
  params: Record<string, string> = {}
) {
  const apiKey = requireEnv("GOLDRUSH_API_KEY", GOLDRUSH_API_KEY);
  const url = new URL(`https://api.covalenthq.com/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GoldRush ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function callCovalent(
  path: string,
  params: Record<string, string> = {}
) {
  const apiKey = requireEnv("COVALENT_API_KEY", COVALENT_API_KEY);
  const url = new URL(`https://api.covalenthq.com/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Covalent ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function callZerion(
  path: string,
  params: Record<string, string> = {}
) {
  const apiKey = requireEnv("ZERION_KEY", ZERION_KEY);
  const url = new URL(`https://api.zerion.io/v1/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    },
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zerion ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function callBasescan(params: Record<string, string> = {}) {
  const url = new URL("https://api.basescan.org/api");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (BASESCAN_API_KEY) url.searchParams.set("apikey", BASESCAN_API_KEY);

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Basescan ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

async function callGoPlus(address: string, chain: SupportedChain = "base") {
  const chainId = GOPLUS_CHAIN_ID[chain];
  const url = new URL(`https://api.gopluslabs.io/api/v1/token_security/${chainId}`);
  url.searchParams.set("contract_addresses", address);

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GoPlus ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// GeckoTerminal via internal proxy (avoids direct server-side blocking)
async function callGeckoTerminal(network: "base" | "eth") {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  const res = await fetch(`${baseUrl}/api/proxy/gt?network=${network}`, {
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GeckoTerminal proxy ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// Trending via internal endpoint (merges CoinGecko + GeckoTerminal)
async function callTrending(): Promise<unknown[]> {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  const res = await fetch(`${baseUrl}/api/trending`, {
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trending ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data ?? [];
}

// Anthropic — injects context as XML blocks so Clark sees structured data
async function callAnthropic(prompt: string, context: ClarkContext | null) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);

  const trending: unknown[]  = Array.isArray(context?.trending)  ? context!.trending  : [];
  const gtPools:  unknown[]  = Array.isArray(context?.gtPools)   ? context!.gtPools   : [];
  const tokenData: unknown   = context?.tokenData  ?? {};
  const walletScan: unknown  = context?.walletScan ?? {};
  const analysis: unknown    = context?.analysis   ?? {};

  const userContent =
    `${prompt}\n\n` +
    `<trending_tokens>\n${JSON.stringify(trending)}\n</trending_tokens>\n\n` +
    `<gt_pools>\n${JSON.stringify(gtPools)}\n</gt_pools>\n\n` +
    `<token_data>\n${JSON.stringify(tokenData)}\n</token_data>\n\n` +
    `<analysis>\n${JSON.stringify(analysis)}\n</analysis>\n\n` +
    `<wallet_scan>\n${JSON.stringify(walletScan)}\n</wallet_scan>`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system:
        "You are Clark — an onchain AI analyst for ChainLens AI.\n\n" +

        "DATA SOURCES (these are your ONLY sources — no exceptions):\n" +
        "- <trending_tokens>: powered by /api/trending, which merges CoinGecko + GeckoTerminal. Fields: contract, symbol, name, chain, price, liquidity, volume, change24h, source.\n" +
        "- <gt_pools>: GeckoTerminal pools via /api/proxy/gt. Authoritative source for liquidity, volume, and pool-level data.\n" +
        "- <token_data>: token metadata, holders, contract functions, risks, whales, deployer info — from GoldRush + GeckoTerminal backend.\n" +
        "- <analysis>: contract analysis results — owner status, liquidity status, honeypot check, suspicious functions — from the backend.\n" +
        "- <wallet_scan>: wallet holdings, inflows/outflows, risk patterns — from GoldRush + Zerion backend.\n\n" +

        "HARD RULES:\n" +
        "1. Clark must ONLY use the data provided in the XML blocks above. No external APIs. No assumptions.\n" +
        "2. All onchain data comes exclusively from the ChainLens backend: /api/trending, /api/token, /api/proxy/gt.\n" +
        "3. Trending analysis is powered ONLY by /api/trending, which merges CoinGecko + GeckoTerminal.\n" +
        "4. Clark must treat <gt_pools> as the authoritative source for liquidity, volume, and pool-level data.\n" +
        "5. If a field is missing (liquidity, volume, price change), Clark must say \"data unavailable\" instead of guessing.\n" +
        "6. Never guess, hallucinate, invent numbers, or fabricate contract data.\n" +
        "7. If data is missing entirely, say \"No data available for this token/wallet.\"\n" +
        "8. Keep responses short, sharp, Base-native, and human-readable.\n" +
        "9. Never output markdown unless asked. Default to clean text or JSON.\n" +
        "10. When returning structured results, ALWAYS output JSON only.\n\n" +

        "Your personality:\n" +
        "- Confident, fast, and direct.\n" +
        "- Speaks like an onchain analyst, not a chatbot.\n" +
        "- Gives verdicts, not essays.\n" +
        "- Uses simple language, no fluff.\n" +
        "- Base-native tone: degen-aware but professional.\n\n" +

        "Behavior rules:\n" +
        "TRENDING: use <trending_tokens>. Format as a numbered list. For each token show: name (symbol), price, 24h change, volume, liquidity, chain, and contract if available. If the array is empty, say \"No trending data available right now.\"\n" +
        "TOKEN: use <token_data> first, then <analysis>, then <trending_tokens>, then say \"No data available.\"\n" +
        "WALLET: use <wallet_scan> only. Identify patterns, risks, top tokens, inflows/outflows.\n" +
        "COMPARISONS: use available data only. If one token lacks data, say so explicitly.\n" +
        "RISK SCORING: use liquidity, volume, age, holders, deployer, contract functions from provided data. Never invent numbers.\n\n" +

        "Output formats:\n" +
        "- Trending query → numbered list, one token per line, plain text.\n" +
        "- JSON requested → return JSON only.\n" +
        "- Summary requested → short, sharp summary.\n" +
        "- Verdict requested → give a verdict.\n\n" +

        "Trending token line format (use exactly this):\n" +
        "1. TOKEN_NAME (SYMBOL) | Price: $X.XX | 24h: +X.XX% | Vol: $XM | Liq: $XM | Chain: base | contract: 0xADDRESS\n\n" +

        "Fallback: if backend provides no data, say \"No data available.\" Offer no speculation.\n\n" +
        "You must ALWAYS follow these rules.",
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = (data?.content ?? []).find((b: { type: string }) => b.type === "text");
  return textBlock?.text ?? JSON.stringify(data);
}

// ---------- Scanner functions ----------

async function scanTokenData(address: string, chain: SupportedChain = "base"): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);

  const results = await Promise.allSettled([
    callGoPlus(address, chain),
    callGoldrush(`${chainName}/tokens/${address}/token_holders_v2/`, { "page-size": "50" }),
    callBasescan({ module: "token", action: "tokeninfo", contractaddress: address }),
    callGeckoTerminal(network),
    callTrending(),
  ]);

  return {
    tokenData: {
      type: "token-scan",
      address,
      chain,
      goplus_security: results[0].status === "fulfilled" ? results[0].value : null,
      holders:         results[1].status === "fulfilled" ? results[1].value : null,
      basescan_info:   results[2].status === "fulfilled" ? results[2].value : null,
    },
    gtPools:  results[3].status === "fulfilled" ? ((results[3].value as { data?: unknown[] })?.data ?? []) : [],
    trending: results[4].status === "fulfilled" ? (results[4].value as unknown[]) : [],
  };
}

async function scanWalletData(address: string, chain: SupportedChain = "base"): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];

  const results = await Promise.allSettled([
    callCovalent(`${chainName}/address/${address}/balances_v2/`),
    callCovalent(`${chainName}/address/${address}/transactions_v3/`, { "page-size": "20" }),
    callZerion(`wallets/${address}/positions/`, {
      currency: "usd",
      "filter[positions]": "only_simple",
      "filter[trash]": "only_non_trash",
    }),
  ]);

  return {
    walletScan: {
      type: "wallet-scan",
      address,
      chain,
      balances:         results[0].status === "fulfilled" ? results[0].value : null,
      transactions:     results[1].status === "fulfilled" ? results[1].value : null,
      zerion_positions: results[2].status === "fulfilled" ? results[2].value : null,
    },
  };
}

async function scanLiquidityData(address: string, chain: SupportedChain = "base"): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);

  const results = await Promise.allSettled([
    callGoldrush(`${chainName}/xy=k/address/${address}/pools/`),
    callGoPlus(address, chain),
    callGeckoTerminal(network),
  ]);

  return {
    tokenData: {
      type: "liquidity-scan",
      address,
      chain,
      goldrush_pools:  results[0].status === "fulfilled" ? results[0].value : null,
      goplus_security: results[1].status === "fulfilled" ? results[1].value : null,
    },
    gtPools: results[2].status === "fulfilled" ? ((results[2].value as { data?: unknown[] })?.data ?? []) : [],
  };
}

async function scanDevWalletData(address: string, chain: SupportedChain = "base"): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];

  const results = await Promise.allSettled([
    callGoldrush(`${chainName}/tokens/${address}/token_holders_v2/`, { "page-size": "200" }),
    callGoPlus(address, chain),
    callBasescan({ module: "contract", action: "getsourcecode", address }),
  ]);

  return {
    tokenData: {
      type: "dev-wallet-scan",
      address,
      chain,
      top_holders:     results[0].status === "fulfilled" ? results[0].value : null,
      goplus_security: results[1].status === "fulfilled" ? results[1].value : null,
      contract_source: results[2].status === "fulfilled" ? results[2].value : null,
    },
  };
}

async function scanBaseRadarData(): Promise<ClarkContext> {
  const results = await Promise.allSettled([
    callTrending(),
    callGeckoTerminal("base"),
    callGeckoTerminal("eth"),
  ]);

  return {
    trending: results[0].status === "fulfilled" ? (results[0].value as unknown[]) : [],
    gtPools: [
      ...(results[1].status === "fulfilled" ? ((results[1].value as { data?: unknown[] })?.data ?? []) : []),
      ...(results[2].status === "fulfilled" ? ((results[2].value as { data?: unknown[] })?.data ?? []) : []),
    ],
  };
}

async function scanWhaleData(address: string, chain: SupportedChain = "base"): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];

  const results = await Promise.allSettled([
    callCovalent(`${chainName}/address/${address}/transactions_v3/`, { "page-size": "50" }),
    callZerion(`wallets/${address}/positions/`, {
      currency: "usd",
      "filter[positions]": "only_simple",
    }),
    callBasescan({
      module: "account", action: "txlist",
      address, page: "1", offset: "20", sort: "desc",
    }),
  ]);

  return {
    walletScan: {
      type: "whale-scan",
      address,
      chain,
      transactions:     results[0].status === "fulfilled" ? results[0].value : null,
      zerion_positions: results[1].status === "fulfilled" ? results[1].value : null,
      basescan_txs:     results[2].status === "fulfilled" ? results[2].value : null,
    },
  };
}

async function scanPumpData(address: string, chain: SupportedChain = "base"): Promise<ClarkContext> {
  const network = gtNetwork(chain);

  const results = await Promise.allSettled([
    callGoPlus(address, chain),
    callGeckoTerminal(network),
  ]);

  return {
    tokenData: {
      type: "pump-scan",
      address,
      chain,
      security: results[0].status === "fulfilled" ? results[0].value : null,
    },
    gtPools: results[1].status === "fulfilled" ? ((results[1].value as { data?: unknown[] })?.data ?? []) : [],
  };
}

// ---------- Command router ----------

async function routeCommand(
  prompt: string,
  chain: SupportedChain = "base"
): Promise<ClarkContext | null> {
  const t = prompt.toLowerCase();
  const address = extractAddress(prompt);

  if (t.includes("base radar") || t.includes("trending") || t.includes("what's hot")) {
    return scanBaseRadarData();
  }
  if ((t.includes("scan wallet") || t.includes("wallet scan")) && address) {
    return scanWalletData(address, chain);
  }
  if ((t.includes("dev wallet") || t.includes("dev wallets")) && address) {
    return scanDevWalletData(address, chain);
  }
  if (t.includes("liquidity") && address) {
    return scanLiquidityData(address, chain);
  }
  if (t.includes("whale") && address) {
    return scanWhaleData(address, chain);
  }
  if (t.includes("pump") && address) {
    return scanPumpData(address, chain);
  }
  if (address) {
    return scanTokenData(address, chain);
  }

  return null;
}

// ---------- Feature handlers ----------

async function handleTokenScanner(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [holders, gtData, trending] = await Promise.all([
    callGoldrush(`${chainName}/tokens/${tokenAddress}/token_holders_v2/`, { "page-size": "100" }),
    callGeckoTerminal(network),
    callTrending(),
  ]);

  return {
    feature: "token-scanner",
    chain,
    tokenAddress,
    tokenData: { holders },
    gtPools: (gtData as { data?: unknown[] })?.data ?? [],
    trending: trending ?? [],
  };
}

async function handleWalletScanner(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const walletAddress = body.walletAddress ?? body.addressOrToken;
  if (!walletAddress) throw new Error("walletAddress or addressOrToken is required");

  const [covalentBalances, zerionPositions] = await Promise.all([
    callCovalent(`${chainName}/address/${walletAddress}/balances_v2/`),
    callZerion(`wallets/${walletAddress}/positions/`, {
      currency: "usd",
      "filter[positions]": "only_simple",
      "filter[trash]": "only_non_trash",
    }),
  ]);

  return {
    feature: "wallet-scanner",
    chain,
    walletAddress,
    walletScan: { covalentBalances, zerionPositions },
  };
}

async function handleDevWalletDetector(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const holders = await callGoldrush(
    `${chainName}/tokens/${tokenAddress}/token_holders_v2/`,
    { "page-size": "200" }
  );

  return {
    feature: "dev-wallet-detector",
    chain,
    tokenAddress,
    tokenData: { holders },
  };
}

async function handleLiquiditySafety(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [goldrushPools, gtData] = await Promise.all([
    callGoldrush(`${chainName}/xy=k/address/${tokenAddress}/pools/`),
    callGeckoTerminal(network),
  ]);

  return {
    feature: "liquidity-safety",
    chain,
    tokenAddress,
    tokenData: { goldrush_pools: goldrushPools },
    gtPools: (gtData as { data?: unknown[] })?.data ?? [],
  };
}

async function handleWhaleAlerts(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const walletAddress = body.walletAddress ?? body.addressOrToken;
  if (!walletAddress) throw new Error("walletAddress or addressOrToken is required");

  const txs = await callCovalent(
    `${chainName}/address/${walletAddress}/transactions_v3/`,
    { "page-size": "50" }
  );

  return {
    feature: "whale-alerts",
    chain,
    walletAddress,
    walletScan: { transactions: txs },
  };
}

async function handlePumpAlerts(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const network = gtNetwork(chain);
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [security, gtData] = await Promise.all([
    callGoPlus(tokenAddress, chain),
    callGeckoTerminal(network),
  ]);

  return {
    feature: "pump-alerts",
    chain,
    tokenAddress,
    tokenData: { security },
    gtPools: (gtData as { data?: unknown[] })?.data ?? [],
  };
}

async function handleBaseRadar(_body: ClarkRequestBody) {
  const [trending, gtBase, gtEth] = await Promise.all([
    callTrending(),
    callGeckoTerminal("base"),
    callGeckoTerminal("eth"),
  ]);

  const trendingData: unknown[] = Array.isArray(trending) ? trending : [];
  const gtPools: unknown[] = [
    ...((gtBase as { data?: unknown[] })?.data ?? []),
    ...((gtEth as { data?: unknown[] })?.data ?? []),
  ];

  const context: ClarkContext = {
    trending: trendingData,
    gtPools,
    tokenData: {},
    walletScan: {},
  };

  const analysis = await callAnthropic(
    "What's trending on Base right now? List the top tokens with their symbol, price, 24h change, volume, and liquidity. Be concise.",
    context
  );

  return { feature: "base-radar", chain: "base", analysis };
}

async function handleClarkAI(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const network = gtNetwork(chain);
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";

  // Always fetch baseline sources in parallel — never rely on routeCommand alone
  const [trendingResult, gtRawResult] = await Promise.allSettled([
    callTrending(),
    callGeckoTerminal(network),
  ]);

  let trending: unknown[] = trendingResult.status === "fulfilled" && Array.isArray(trendingResult.value)
    ? trendingResult.value
    : [];

  let gtPools: unknown[] = gtRawResult.status === "fulfilled"
    ? (Array.isArray((gtRawResult.value as { data?: unknown[] })?.data)
        ? (gtRawResult.value as { data: unknown[] }).data
        : [])
    : [];

  // Route-specific context — non-fatal if unavailable; enriches all context fields
  let tokenData: unknown = {};
  let walletScan: unknown = {};
  let contractAnalysis: unknown = {};

  try {
    const routeCtx = await routeCommand(prompt, chain);
    if (routeCtx?.tokenData  != null) tokenData        = routeCtx.tokenData;
    if (routeCtx?.walletScan != null) walletScan        = routeCtx.walletScan;
    if (routeCtx?.analysis   != null) contractAnalysis  = routeCtx.analysis;
    if (Array.isArray(routeCtx?.trending)  && (routeCtx.trending  as unknown[]).length > 0)
      trending = routeCtx.trending  as unknown[];
    if (Array.isArray(routeCtx?.gtPools)   && (routeCtx.gtPools   as unknown[]).length > 0)
      gtPools  = routeCtx.gtPools   as unknown[];
  } catch (err) {
    console.error("[Clark router]", err instanceof Error ? err.message : err);
  }

  const context: ClarkContext = {
    trending,
    gtPools,
    tokenData:  tokenData        ?? {},
    walletScan: walletScan        ?? {},
    analysis:   contractAnalysis  ?? {},
  };

  const analysis = await callAnthropic(prompt, context);

  return { feature: "clark-ai", chain, analysis };
}

// ---------- Main handler ----------

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ClarkRequestBody;

    if (!body.feature) {
      return NextResponse.json(
        { error: "Missing 'feature' in request body" },
        { status: 400 }
      );
    }

    let result: unknown;

    switch (body.feature) {
      case "token-scanner":
        result = await handleTokenScanner(body);
        break;
      case "wallet-scanner":
        result = await handleWalletScanner(body);
        break;
      case "dev-wallet-detector":
        result = await handleDevWalletDetector(body);
        break;
      case "liquidity-safety":
        result = await handleLiquiditySafety(body);
        break;
      case "whale-alerts":
        result = await handleWhaleAlerts(body);
        break;
      case "pump-alerts":
        result = await handlePumpAlerts(body);
        break;
      case "base-radar":
        result = await handleBaseRadar(body);
        break;
      case "clark-ai":
        result = await handleClarkAI(body);
        break;
      default:
        return NextResponse.json(
          { error: `Unknown feature: ${body.feature}` },
          { status: 400 }
        );
    }

    return NextResponse.json(
      { ok: true, feature: body.feature, data: result },
      { status: 200 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[Clark]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
