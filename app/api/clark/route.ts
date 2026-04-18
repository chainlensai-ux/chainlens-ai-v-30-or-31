import { NextRequest, NextResponse } from "next/server";

const {
  ALCHEMY_BNB_KEY,
  ALCHEMY_POLYGON_KEY,
  ALCHEMY_BASE_KEY,
  ALCHEMY_ETHEREUM_KEY,
  GOLDRUSH_API_KEY,
  ZERION_KEY,
  COVALENT_API_KEY,
  ANTHROPIC_API_KEY,
  NEXT_PUBLIC_PROXY_URL,
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

// ---------- Chain name maps ----------

// GoldRush / Covalent require specific chain slugs
const GOLDRUSH_CHAIN: Record<SupportedChain, string> = {
  base: "base-mainnet",
  ethereum: "eth-mainnet",
  polygon: "matic-mainnet",
  bnb: "bsc-mainnet",
};

// GoPlus uses numeric chain IDs
const GOPLUS_CHAIN_ID: Record<SupportedChain, string> = {
  base: "8453",
  ethereum: "1",
  polygon: "137",
  bnb: "56",
};

// ---------- Helpers ----------

function getAlchemyKey(chain: SupportedChain | undefined) {
  switch (chain) {
    case "base":     return ALCHEMY_BASE_KEY;
    case "ethereum": return ALCHEMY_ETHEREUM_KEY;
    case "polygon":  return ALCHEMY_POLYGON_KEY;
    case "bnb":      return ALCHEMY_BNB_KEY;
    default:         return ALCHEMY_BASE_KEY;
  }
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Extract the first 0x address found in a string
function extractAddress(text: string): string | null {
  const match = text.match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0] : null;
}

// ---------- API clients ----------

// GoldRush (rebranded Covalent) — https://api.covalenthq.com/v1/
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

// Covalent — same service as GoldRush; uses Bearer auth, not query-param key
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

// Zerion — Basic auth with "apiKey:" (colon, no password)
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

// DexScreener — no auth required; call directly from server (no CORS on server-side)
async function callDexScreener(
  path: string,
  params: Record<string, string> = {}
) {
  const url = new URL(`https://api.dexscreener.com/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    next: { revalidate: 15 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DexScreener ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// Basescan — Etherscan-compatible API for Base chain
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

// GoPlus — free token security API, no auth required
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

// Anthropic — system field separate from user message; latest model
async function callAnthropic(prompt: string, context: unknown) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);

  // Embed live data directly in the user message so the model sees it as current context
  const userContent = context
    ? `${prompt}\n\nLive on-chain data:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``
    : prompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system:
        "You are Clark — a Base-native crypto analyst.\n" +
        "Your job is to give SHORT, USEFUL, HUMAN summaries.\n\n" +
        "RULES:\n" +
        "- Max 6–10 bullet points unless user says 'expand'.\n" +
        "- Start with the single biggest risk or opportunity.\n" +
        "- Speak like a real Base degen analyst: confident, direct, no fluff.\n" +
        "- Never dump raw data. Always summarize.\n" +
        "- Never write more than 120 words unless user says 'expand'.\n" +
        "- Always give:\n" +
        "  • Risk rating (Low / Medium / High)\n" +
        "  • Verdict (Bullish / Neutral / Risky / Avoid)\n" +
        "  • Trade setup (if relevant)\n" +
        "- Use bullets, not paragraphs.\n" +
        "- If user says 'expand' → THEN give full deep-dive analysis.",
      messages: [
        {
          role: "user",
          content: userContent,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.content?.[0]?.text ?? JSON.stringify(data);
}

// ---------- Scanner functions (fetch structured data for LLM context) ----------

async function scanTokenData(address: string, chain: SupportedChain = "base") {
  const chainName = GOLDRUSH_CHAIN[chain];

  const results = await Promise.allSettled([
    callDexScreener(`latest/dex/tokens/${address}`),
    callGoPlus(address, chain),
    callGoldrush(`${chainName}/tokens/${address}/token_holders_v2/`, { "page-size": "50" }),
    callBasescan({ module: "token", action: "tokeninfo", contractaddress: address }),
  ]);

  return {
    type: "token-scan",
    address,
    chain,
    dexscreener:     results[0].status === "fulfilled" ? results[0].value : null,
    goplus_security: results[1].status === "fulfilled" ? results[1].value : null,
    holders:         results[2].status === "fulfilled" ? results[2].value : null,
    basescan_info:   results[3].status === "fulfilled" ? results[3].value : null,
  };
}

async function scanWalletData(address: string, chain: SupportedChain = "base") {
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
    type: "wallet-scan",
    address,
    chain,
    balances:          results[0].status === "fulfilled" ? results[0].value : null,
    transactions:      results[1].status === "fulfilled" ? results[1].value : null,
    zerion_positions:  results[2].status === "fulfilled" ? results[2].value : null,
  };
}

async function scanLiquidityData(address: string, chain: SupportedChain = "base") {
  const chainName = GOLDRUSH_CHAIN[chain];

  const results = await Promise.allSettled([
    callDexScreener(`latest/dex/tokens/${address}`),
    callGoldrush(`${chainName}/xy=k/address/${address}/pools/`),
    callGoPlus(address, chain),
  ]);

  return {
    type: "liquidity-scan",
    address,
    chain,
    dexscreener_pairs: results[0].status === "fulfilled" ? results[0].value : null,
    goldrush_pools:    results[1].status === "fulfilled" ? results[1].value : null,
    goplus_security:   results[2].status === "fulfilled" ? results[2].value : null,
  };
}

async function scanDevWalletData(address: string, chain: SupportedChain = "base") {
  const chainName = GOLDRUSH_CHAIN[chain];

  const results = await Promise.allSettled([
    callGoldrush(`${chainName}/tokens/${address}/token_holders_v2/`, { "page-size": "200" }),
    callGoPlus(address, chain),
    callBasescan({ module: "contract", action: "getsourcecode", address }),
  ]);

  return {
    type: "dev-wallet-scan",
    address,
    chain,
    top_holders:     results[0].status === "fulfilled" ? results[0].value : null,
    goplus_security: results[1].status === "fulfilled" ? results[1].value : null,
    contract_source: results[2].status === "fulfilled" ? results[2].value : null,
  };
}

async function scanBaseRadarData() {
  const data = await callDexScreener("latest/dex/pairs/base");
  const baseOnly = (data?.pairs ?? []).filter(
    (p: Record<string, unknown>) => p.chainId === "base"
  );
  return { type: "base-radar", chain: "base", trending: baseOnly };
}

async function scanWhaleData(address: string, chain: SupportedChain = "base") {
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
    type: "whale-scan",
    address,
    chain,
    transactions:      results[0].status === "fulfilled" ? results[0].value : null,
    zerion_positions:  results[1].status === "fulfilled" ? results[1].value : null,
    basescan_txs:      results[2].status === "fulfilled" ? results[2].value : null,
  };
}

async function scanPumpData(address: string, chain: SupportedChain = "base") {
  const results = await Promise.allSettled([
    callDexScreener(`latest/dex/tokens/${address}`),
    callGoPlus(address, chain),
  ]);

  return {
    type: "pump-scan",
    address,
    chain,
    market_data: results[0].status === "fulfilled" ? results[0].value : null,
    security:    results[1].status === "fulfilled" ? results[1].value : null,
  };
}

// ---------- Command router ----------

// Inspects the user's prompt and runs the appropriate scanner.
// Returns structured on-chain data to inject as LLM context, or null for plain AI.
async function routeCommand(
  prompt: string,
  chain: SupportedChain = "base"
): Promise<Record<string, unknown> | null> {
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
  // Any prompt containing a token address defaults to a full token scan
  if (address) {
    return scanTokenData(address, chain);
  }

  return null;
}

// ---------- Feature handlers ----------

async function handleTokenScanner(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [holders, marketData] = await Promise.all([
    callGoldrush(`${chainName}/tokens/${tokenAddress}/token_holders_v2/`, {
      "page-size": "100",
    }),
    callDexScreener(`latest/dex/tokens/${tokenAddress}`),
  ]);

  return { feature: "token-scanner", chain, tokenAddress, holders, marketData };
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
    covalentBalances,
    zerionPositions,
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

  return { feature: "dev-wallet-detector", chain, tokenAddress, holders };
}

async function handleLiquiditySafety(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  // xy=k is Covalent's constant-product AMM (Uniswap-style) DEX endpoint
  const [pools, pairs] = await Promise.all([
    callGoldrush(`${chainName}/xy=k/address/${tokenAddress}/pools/`),
    callDexScreener(`latest/dex/tokens/${tokenAddress}`),
  ]);

  return { feature: "liquidity-safety", chain, tokenAddress, pools, pairs };
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

  return { feature: "whale-alerts", chain, walletAddress, txs };
}

async function handlePumpAlerts(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const marketData = await callDexScreener(`latest/dex/tokens/${tokenAddress}`);

  return { feature: "pump-alerts", chain, tokenAddress, marketData };
}

async function handleBaseRadar(_body: ClarkRequestBody) {
  const data = await callDexScreener("latest/dex/pairs/base");
  const baseOnly = (data?.pairs ?? []).filter(
    (p: Record<string, unknown>) => p.chainId === "base"
  );
  return { feature: "base-radar", chain: "base", trending: baseOnly };
}

async function handleClarkAI(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";

  // Route the prompt to the appropriate scanner to gather live on-chain context.
  // Scanner failures are non-fatal — the LLM still responds without data.
  let scannerData: Record<string, unknown> | null = null;
  try {
    scannerData = await routeCommand(prompt, chain);
  } catch (err) {
    console.error("[Clark router]", err instanceof Error ? err.message : err);
  }

  const analysis = await callAnthropic(prompt, scannerData);

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
