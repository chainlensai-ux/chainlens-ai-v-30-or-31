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

// ---------- Chain name map ----------

// GoldRush / Covalent require specific chain slugs
const GOLDRUSH_CHAIN: Record<SupportedChain, string> = {
  base: "base-mainnet",
  ethereum: "eth-mainnet",
  polygon: "matic-mainnet",
  bnb: "bsc-mainnet",
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

// Anthropic — system field separate from user message; latest model
async function callAnthropic(prompt: string, context: unknown) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);

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
        "You are Clark, an on-chain AI analyst for Base and EVM chains. " +
        "You receive raw on-chain and market data as JSON and return concise, " +
        "actionable analysis for degen traders. Be direct. No filler.",
      messages: [
        {
          role: "user",
          content: `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`,
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
  const chain: SupportedChain = "base";

  const [boosted, latest] = await Promise.all([
    callDexScreener("token-boosts/top/v1"),
    callDexScreener("token-profiles/latest/v1"),
  ]);

  return { feature: "base-radar", chain, boosted, latest };
}

async function handleClarkAI(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";

  const context = {
    chain,
    addressOrToken: body.addressOrToken,
    walletAddress: body.walletAddress,
    tokenAddress: body.tokenAddress,
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
