import { NextRequest, NextResponse } from "next/server";
import { fetchWalletSnapshot } from "@/lib/server/walletSnapshot";

const {
  GOLDRUSH_API_KEY,
  ZERION_KEY,
  COVALENT_API_KEY,
  ANTHROPIC_API_KEY,
  BASESCAN_API_KEY,
  ALCHEMY_ETHEREUM_KEY,
  ALCHEMY_BASE_KEY,
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
  | "clark-ai"
  | "scan-token";

interface ClarkRequestBody {
  feature: ClarkFeature;
  message?: string;
  mode?: string;
  context?: unknown;
  addressOrToken?: string;
  walletAddress?: string;
  tokenAddress?: string;
  chain?: SupportedChain;
  prompt?: string;
  query?: string;
  tokenData?: unknown;
}

interface ClarkContext {
  trending?: unknown[];
  gtPools?: unknown[];
  tokenData?: unknown;
  walletScan?: unknown;
  analysis?: unknown;
  holderScan?: unknown;
}

type ClarkIntent =
  | "casual_help"
  | "general_market"
  | "educational"
  | "routing_help"
  | "analysis"
  | "token_name_lookup"
  | "token_analysis"
  | "wallet_balance"
  | "wallet_quality"
  | "wallet_analysis"
  | "dev_wallet"
  | "liquidity_safety"
  | "base_radar"
  | "whale_alert"
  | "feature_context"
  | "unknown";

type ClarkSource = "casual" | "feature_context" | "tool_call" | "fallback";
type ClarkReplyMode =
  | "casual_help"
  | "general_market"
  | "educational"
  | "routing_help"
  | "analysis"
  | "feature_context"
  | "unknown";

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

function idToAddress(id: string): string {
  const idx = id.indexOf("_");
  return idx === -1 ? id : id.slice(idx + 1);
}

function extractTokenLookupQuery(prompt: string): string | null {
  const t = prompt.trim().toLowerCase();
  const patterns = [
    /(?:scan|analyze|analyse|check)\s+([a-z0-9._-]{2,32})(?:\s+on\s+base)?\b/i,
    /what about\s+([a-z0-9._-]{2,32})(?:\s+on\s+base)?\b/i,
    /is\s+([a-z0-9._-]{2,32})\s+safe\b/i,
    /what'?s happening with\s+([a-z0-9._-]{2,32})(?:\s+on\s+base)?\b/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function gtNetwork(chain: SupportedChain): "base" | "eth" {
  return chain === "ethereum" ? "eth" : "base";
}

function hasWalletIntent(text: string): boolean {
  return /\b(wallet|wallet value|balance|balances|balence|ballance|bal|holdings?|holds|portfolio|tokens held|scan wallet|wallet scan)\b/i.test(text);
}

function hasWalletQualityIntent(text: string): boolean {
  return /\b(good wallet|copy\s*-?\s*trade|smart money|should i follow|worth following)\b/i.test(text);
}

function hasDevWalletIntent(text: string): boolean {
  return /\b(dev wallet|deployer|who deployed)\b/i.test(text);
}

function hasLiquidityIntent(text: string): boolean {
  return /\b(liquidity|lp safe|liquidity risk|lp\b)\b/i.test(text);
}

function hasTokenIntent(text: string): boolean {
  return /\b(token|contract|scan|analyz|analyse|safe|risk|check|verdict)\b/i.test(text);
}

function hasMarketIntent(text: string): boolean {
  return /\b(what'?s pumping on base|what'?s moving on base|show hot base tokens|top movers on base|new base launches|biggest gainers|what should i watch|trending|hot tokens?)\b/i.test(text);
}

function detectIntent(prompt: string): { intent: ClarkIntent; address: string | null } {
  const t = prompt.trim().toLowerCase();
  const address = extractAddress(prompt);

  if (/(<token_data>|<wallet_scan>|<analysis>|feature context|ask clark)/i.test(prompt)) {
    return { intent: "feature_context", address };
  }

  if (/^(hi|hey|hello|yo|gm|sup)\b|what can you do|help|who are you|what is chainlens/i.test(t)) {
    return { intent: "casual_help", address };
  }

  if (hasWalletQualityIntent(t) && address) {
    return { intent: "wallet_quality", address };
  }

  if (hasWalletIntent(t) && address) {
    return { intent: "wallet_balance", address };
  }

  if (hasDevWalletIntent(t) && address) {
    return { intent: "dev_wallet", address };
  }

  if (hasLiquidityIntent(t) && address) {
    return { intent: "liquidity_safety", address };
  }

  if (hasTokenIntent(t)) {
    if (!address) {
      const tokenQuery = extractTokenLookupQuery(prompt);
      if (tokenQuery) return { intent: "token_name_lookup", address: null };
    }
    if (address) return { intent: "analysis", address };
  }

  if (hasMarketIntent(t) || /\bbase radar\b/.test(t)) {
    return { intent: "general_market", address };
  }

  if (/what is liquidity risk|what is a dev wallet|what does holder concentration mean|why is lp lock important|what is holder concentration|what is lp lock/i.test(t)) {
    return { intent: "educational", address };
  }

  if (/how do i scan|where do i check deployer|how do i track a wallet|how do i use this|which feature|where should i go/i.test(t)) {
    return { intent: "routing_help", address };
  }

  if (/whale/i.test(t) && address) return { intent: "whale_alert", address };

  if (!address) {
    const tokenQuery = extractTokenLookupQuery(prompt);
    if (tokenQuery) return { intent: "token_name_lookup", address: null };
  }

  return { intent: "unknown", address };
}

function detectReplyMode(body: ClarkRequestBody): ClarkReplyMode {
  const prompt = body.prompt ?? "";
  const t = prompt.toLowerCase();
  const explicitMode = String(body.mode ?? "").toLowerCase();
  if (explicitMode === "chat") {
    const { intent, address } = detectIntent(prompt);
    if (intent === "casual_help") return "casual_help";
    if (intent === "general_market" || intent === "base_radar") return "general_market";
    if (intent === "educational") return "educational";
    if (intent === "routing_help") return "routing_help";
    if (intent === "token_name_lookup") return "analysis";
    if ((intent === "analysis" || intent === "token_analysis" || intent === "wallet_balance" || intent === "wallet_quality" || intent === "wallet_analysis" || intent === "dev_wallet" || intent === "liquidity_safety") && address) {
      return "analysis";
    }
    if (address) return "analysis";
    return "unknown";
  }
  if (explicitMode === "casual_help") return "casual_help";
  if (explicitMode === "analyst") {
    const { intent } = detectIntent(prompt);
    if (intent === "general_market" || intent === "base_radar") return "general_market";
    if (intent === "educational") return "educational";
    return "analysis";
  }
  const featureModes = new Set(["dev-wallet", "base-radar", "token-analysis", "wallet-analysis", "liquidity-safety", "scan-token"]);
  if (featureModes.has(explicitMode)) return "feature_context";
  const hasStructuredMode = /\[mode\s*:/i.test(prompt) || body.context != null;
  if (hasStructuredMode) return "feature_context";

  const { intent, address } = detectIntent(prompt);
  if (intent === "casual_help") return "casual_help";
  if (intent === "general_market") return "general_market";
  if (intent === "educational") return "educational";
  if (intent === "routing_help") return "routing_help";
  if (intent === "base_radar") return "general_market";
  if (intent === "feature_context") return "feature_context";
  if (intent === "analysis") return "analysis";
  if ((intent === "token_analysis" || intent === "wallet_balance" || intent === "wallet_quality" || intent === "wallet_analysis" || intent === "dev_wallet" || intent === "liquidity_safety" || intent === "whale_alert") && address) {
    return "analysis";
  }
  if (/scan|analyz|check|verdict|risk/.test(t) && address) return "analysis";
  return "unknown";
}

function buildEducationalReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/liquidity risk/.test(t)) return "Liquidity risk is the chance you can’t exit cleanly—usually from low depth, unlocked LP, or concentrated LP ownership.";
  if (/dev wallet/.test(t)) return "A dev wallet is a deployer-linked wallet that can reveal insider coordination, funding links, or early sell pressure.";
  if (/holder concentration/.test(t)) return "Holder concentration means too much supply sits in a few wallets, increasing dump and manipulation risk.";
  if (/lp lock/.test(t)) return "LP lock matters because unlocked liquidity can be pulled, which can collapse tradability and price.";
  return "Great question. Share the exact risk concept and I’ll break it down quickly.";
}

function buildRoutingHelpReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/track a wallet|wallet/.test(t)) return "Use Wallet Scanner to track wallet behavior and flows, then ask Clark to summarize the risk read.";
  if (/deployer|dev wallet/.test(t)) return "Use Dev Wallet Detector with the token contract to check likely deployer links and suspicious wallet clusters.";
  if (/scan a token|token/.test(t)) return "Use Token Scanner with the contract address for contract and risk checks, then ask Clark for a final read.";
  return "Use Base Radar for discovery, Token Scanner for contract checks, Wallet Scanner for behavior, and Dev Wallet Detector for deployer risk.";
}

function buildGeneralMarketNoContextReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/what should i watch/.test(t)) {
    return "I can’t pull live Base movers right now. What to watch: fresh 24h volume expansion, liquidity depth above ~$50k, repeat buyers across multiple candles, dev-wallet behavior, and holder concentration. Paste a contract and I’ll scan it.";
  }
  if (/what'?s pumping|what'?s moving|show hot|top movers|biggest gainers|new launches?/.test(t)) {
    return "I can’t pull live movers right now. To find real Base pumps, look for: rising 24h volume, liquidity above ~$50k, strong but not ridiculous price movement, and no obvious LP/dev-wallet red flags. Paste a contract and I’ll scan it.";
  }
  return "I can’t pull live Base movers right now, but the right way to read pumps is volume + liquidity + 24h change together. Paste any contract and I’ll scan it, or refresh Base Radar.";
}

function formatUsdShort(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

type BaseMarketToken = {
  symbol: string;
  name: string;
  contract: string;
  price: number | null;
  liquidity: number | null;
  volume: number | null;
  change24h: number | null;
};

function buildBaseMarketBriefing(tokens: BaseMarketToken[]): string {
  const STABLES = new Set(["USDC", "USDBC", "DAI", "USDT"]);
  const sorted = tokens
    .filter((p) => !STABLES.has((p.symbol ?? "").toUpperCase()))
    .filter((p) => (p.change24h ?? 0) > 0 && (p.volume ?? 0) > 0 && (p.liquidity ?? 0) > 0)
    .sort((a, b) => {
      if ((b.change24h ?? 0) !== (a.change24h ?? 0)) return (b.change24h ?? 0) - (a.change24h ?? 0);
      if ((b.volume ?? 0) !== (a.volume ?? 0)) return (b.volume ?? 0) - (a.volume ?? 0);
      if ((b.liquidity ?? 0) !== (a.liquidity ?? 0)) return (b.liquidity ?? 0) - (a.liquidity ?? 0);
      return (b.price ?? 0) - (a.price ?? 0);
    })
    .slice(0, 5);

  if (sorted.length === 0) return "I can’t pull live Base movers right now, but the right way to read pumps is volume + liquidity + 24h change together. Paste any contract and I’ll scan it, or refresh Base Radar.";

  const avgChange = sorted.reduce((sum, t) => sum + (t.change24h ?? 0), 0) / sorted.length;
  const summary = avgChange >= 8
    ? "CoinGecko Terminal Base market feed shows strong upside momentum across top active pools."
    : avgChange >= 3
      ? "CoinGecko Terminal Base market feed shows selective upside with mixed quality across pools."
      : "CoinGecko Terminal Base market feed is active, but momentum is uneven and needs tighter selection.";

  const lines = sorted.slice(0, 4).map((token) => {
    const liqNum = token.liquidity ?? 0;
    const move = token.change24h ?? 0;
    const volNum = token.volume ?? 0;
    const reason = liqNum < 25_000
      ? (move > 500
          ? "extreme move, but liquidity is tiny — likely noisy until scanned"
          : "thin liquidity / high noise")
      : liqNum < 50_000
        ? "thin liquidity, needs scan"
        : liqNum > 100_000 && volNum > 75_000
          ? "stronger market signal, still needs scan"
        : move > 80 && liqNum < 150_000
          ? "likely noisy"
          : "risk appears lower from available market data";

    return `- ${token.symbol}: ${(token.change24h ?? 0).toFixed(1)}% 24h, volume ${formatUsdShort(token.volume)}, liquidity ${formatUsdShort(token.liquidity)}, ${reason}.`;
  });

  return `Base Market:
${summary}

Moving now:
${lines.join("\n")}

Best next step:
Scan the strongest token before touching it.`;
}

function mapTrendingTokens(raw: unknown[]): BaseMarketToken[] {
  return (Array.isArray(raw) ? raw : [])
    .map((t) => {
      const token = t as Record<string, unknown>;
      return {
        symbol: String(token.symbol ?? "TOKEN"),
        name: String(token.name ?? "Token"),
        contract: String(token.contract ?? ""),
        price: typeof token.price === "number" ? token.price : null,
        liquidity: typeof token.liquidity === "number" ? token.liquidity : null,
        volume: typeof token.volume === "number" ? token.volume : null,
        change24h: typeof token.change24h === "number" ? token.change24h : null,
      } satisfies BaseMarketToken;
    })
    .filter((t) => /^0x[a-fA-F0-9]{40}$/.test(t.contract));
}

function mapGtPoolsToMarketTokens(gtRaw: unknown): BaseMarketToken[] {
  const root = (gtRaw ?? {}) as Record<string, unknown>;
  const pools = Array.isArray(root.data) ? (root.data as Array<Record<string, unknown>>) : [];
  const included = Array.isArray(root.included) ? (root.included as Array<Record<string, unknown>>) : [];
  const tokenMap = new Map<string, { symbol: string; name: string; address: string }>();

  for (const item of included) {
    if (item.type !== "token") continue;
    const attrs = (item.attributes ?? {}) as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    const address = typeof attrs.address === "string" ? attrs.address : "";
    if (!id || !address) continue;
    tokenMap.set(id, {
      symbol: String(attrs.symbol ?? "TOKEN"),
      name: String(attrs.name ?? "Token"),
      address,
    });
  }

  const out: BaseMarketToken[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    const attrs = (pool.attributes ?? {}) as Record<string, unknown>;
    const rel = (pool.relationships ?? {}) as Record<string, unknown>;
    const baseData = ((rel.base_token ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const baseId = typeof baseData?.id === "string" ? baseData.id : "";
    const meta = tokenMap.get(baseId);
    if (!meta) continue;
    const key = meta.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const volumeObj = (attrs.volume_usd ?? {}) as Record<string, unknown>;
    const changeObj = (attrs.price_change_percentage ?? {}) as Record<string, unknown>;
    out.push({
      symbol: meta.symbol,
      name: meta.name,
      contract: meta.address,
      price: typeof attrs.base_token_price_usd === "string" ? Number(attrs.base_token_price_usd) : null,
      liquidity: typeof attrs.reserve_in_usd === "string" ? Number(attrs.reserve_in_usd) : null,
      volume: typeof volumeObj.h24 === "string" ? Number(volumeObj.h24) : typeof volumeObj.h24 === "number" ? volumeObj.h24 : null,
      change24h: typeof changeObj.h24 === "string" ? Number(changeObj.h24) : typeof changeObj.h24 === "number" ? changeObj.h24 : null,
    });
  }
  return out;
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function inferAssetLine(userContent: string, isDevWalletMode: boolean): string {
  const contractM = userContent.match(/"contract"\s*:\s*"(0x[a-fA-F0-9]{40})"/);
  const walletM = userContent.match(/"address"\s*:\s*"(0x[a-fA-F0-9]{40})"/);
  const nameM = userContent.match(/"name"\s*:\s*"([^"]+)"/);
  const symbolM = userContent.match(/"symbol"\s*:\s*"([^"]+)"/);
  if (nameM?.[1] && symbolM?.[1] && symbolM[1] !== "?") return `${nameM[1]} (${symbolM[1]})`;
  if (isDevWalletMode && contractM?.[1]) return `Dev wallet scan ${shortAddress(contractM[1])}`;
  if (contractM?.[1]) return `Unknown token (${shortAddress(contractM[1])})`;
  if (walletM?.[1]) return `Wallet ${shortAddress(walletM[1])}`;
  return "Unknown asset";
}

function buildTokenAnalysisFallback(tokenData: unknown, address: string): string {
  const t = tokenData as Record<string, unknown>;
  const name = String(t.name ?? "Token");
  const symbol = String(t.symbol ?? "UNKNOWN");
  const liquidity = formatUsdShort(typeof t.liquidity === "number" ? t.liquidity : null);
  const volume = formatUsdShort(typeof t.volume24h === "number" ? t.volume24h : null);
  return buildStructuredVerdict(
    "SCAN DEEPER",
    "Low",
    `${name} (${symbol}) on Base has market data, but full risk context is incomplete.`,
    [`Token resolved: ${symbol} (${address})`, `Liquidity: ${liquidity}`, `24h volume: ${volume}`],
    ["Security and holder concentration are not fully verified in this pass.", "Market data alone is not enough to call it safe."],
    "Run Token Scanner and validate contract/security fields before entry."
  );
}

function buildWalletAnalysisFallback(walletData: unknown, address: string): string {
  const w = walletData as Record<string, unknown>;
  const holdings = Array.isArray(w.holdings) ? w.holdings.length : 0;
  const totalValue = typeof w.totalValue === "number" ? formatUsdShort(w.totalValue) : "n/a";
  return buildStructuredVerdict(
    "SCAN DEEPER",
    "Low",
    `Wallet ${address} was detected and basic portfolio data is available.`,
    [`Wallet recognized on Base-compatible flow`, `Holdings detected: ${holdings}`, `Estimated total value: ${totalValue}`],
    ["Behavioral and counterpart risk requires deeper scanner context.", "Single-pass wallet data is not enough for a strong trust call."],
    "Run Wallet Scanner for deeper behavior and transfer-risk analysis."
  );
}

function missingAddressReply(intent: ClarkIntent): string {
  if (intent === "wallet_balance" || intent === "wallet_quality" || intent === "wallet_analysis" || intent === "whale_alert") {
    return "I can run that, but I need a wallet address first. Paste a full 0x wallet and I’ll analyze the available data.";
  }
  return "I can run that, but I need a token contract first. Paste a full 0x contract and I’ll analyze the available data.";
}

async function callInternalApi(origin: string, path: string, payload: Record<string, unknown>) {
  try {
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 503, json: {} };
  }
}

function buildStructuredVerdict(
  verdict: "AVOID" | "WATCH" | "SCAN DEEPER" | "TRUSTWORTHY" | "UNKNOWN",
  confidence: "Low" | "Medium" | "High",
  read: string,
  signals: string[],
  risks: string[],
  action: string,
  asset?: string
): string {
  return (
    `${asset ? `Asset: ${asset}\n` : ""}` +
    `Verdict: ${verdict}\n` +
    `Confidence: ${confidence}\n\n` +
    `Read:\n${capWords(read, 35)}\n\n` +
    `Key signals:\n${toBullets(signals.slice(0, 3))}\n\n` +
    `Risks:\n${toBullets(risks.slice(0, 3))}\n\n` +
    `Next action:\n${capWords(action, 25)}`
  );
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

// Uses req.nextUrl.origin so the call always targets the same deployment
async function callGeckoTerminal(network: "base" | "eth", origin: string) {
  const res = await fetch(`${origin}/api/proxy/gt?network=${network}`, {
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GeckoTerminal proxy ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// Uses req.nextUrl.origin so the call always targets the same deployment
async function callTrending(origin: string): Promise<unknown[]> {
  const res = await fetch(`${origin}/api/trending`, {
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trending ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data ?? [];
}

// Calls the new /api/scan-token endpoint — GeckoTerminal only, no external keys needed
async function callScanToken(
  value: string,
  type: "query" | "contract",
  origin: string
): Promise<unknown> {
  const param = type === "contract"
    ? `contract=${encodeURIComponent(value)}`
    : `query=${encodeURIComponent(value)}`;
  try {
    const res = await fetch(`${origin}/api/scan-token?${param}`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    return json.ok ? json.data : null;
  } catch {
    return null;
  }
}

type BaseTokenCandidate = {
  name: string;
  symbol: string;
  contract: string;
};

async function searchBaseTokenCandidates(query: string): Promise<BaseTokenCandidate[]> {
  try {
    const url = `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=base`;
    const res = await fetch(url, { headers: { accept: "application/json", origin: "https://chainlens.ai" }, cache: "no-store" });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({}));
    const pools = Array.isArray((json as Record<string, unknown>)?.data) ? (json as { data: unknown[] }).data : [];

    const out: BaseTokenCandidate[] = [];
    const seen = new Set<string>();
    for (const raw of pools) {
      const pool = raw as Record<string, unknown>;
      const relationships = (pool.relationships ?? {}) as Record<string, unknown>;
      const baseTokenRel = (relationships.base_token ?? {}) as Record<string, unknown>;
      const baseTokenData = (baseTokenRel.data ?? {}) as Record<string, unknown>;
      const tokenId = typeof baseTokenData.id === "string" ? baseTokenData.id : "";
      const contract = idToAddress(tokenId);
      if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) continue;
      if (seen.has(contract.toLowerCase())) continue;
      seen.add(contract.toLowerCase());

      const attrs = (pool.attributes ?? {}) as Record<string, unknown>;
      const poolName = typeof attrs.name === "string" ? attrs.name : "";
      const tokenNameGuess = poolName.split(" / ")[0]?.trim() || contract;
      const symbolGuess = tokenNameGuess.split(" ").slice(-1)[0] ?? tokenNameGuess;
      out.push({ name: tokenNameGuess, symbol: symbolGuess.toUpperCase(), contract });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

function shouldFetchMarketContext(prompt: string): boolean {
  const t = prompt.toLowerCase()
  const SKIP = /\b(wallet|balance|balances|holdings?|portfolio|copy[\s-]?trade?|smart\s+money)\b|^(what\s+is|what'?s?\s+a|how\s+does|explain|define|help)/
  if (SKIP.test(t)) return false
  const MARKET = /\b(pump|pumping|hot\b|movers?|gainers?|runners?|trending|new\s+launches?|new\s+tokens?|token|price|liquidity|volume|lp\b|honeypot|tax\b|dex\b|chart|pool|contract)\b|0x[a-fA-F0-9]{40}/
  return MARKET.test(t)
}

// Anthropic — injects context as XML blocks so Clark sees structured data
async function callAnthropic(prompt: string, context: ClarkContext | null) {
  const apiKey = requireEnv("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);

  const trending: unknown[]  = Array.isArray(context?.trending)  ? context!.trending  : [];
  const gtPools:  unknown[]  = Array.isArray(context?.gtPools)   ? context!.gtPools   : [];
  const tokenData: unknown   = context?.tokenData  ?? {};
  const walletScan: unknown  = context?.walletScan ?? {};
  const analysis: unknown    = context?.analysis   ?? {};

  const holderScan   = context?.holderScan ?? null;
  const goPlusSecurity = (tokenData as Record<string, unknown>)?.goplus_security ?? null;

  const contractRiskBlock = goPlusSecurity
    ? `<contract_risk>\n${JSON.stringify(goPlusSecurity)}\n</contract_risk>\n\n`
    : "";

  const holderScanBlock = holderScan
    ? `<holder_contract_analysis>\n${JSON.stringify(holderScan)}\n</holder_contract_analysis>\n\n`
    : "";

  const userContent =
    `${prompt}\n\n` +
    `<trending_tokens>\n${JSON.stringify(trending)}\n</trending_tokens>\n\n` +
    `<gt_pools>\n${JSON.stringify(gtPools)}\n</gt_pools>\n\n` +
    `<token_data>\n${JSON.stringify(tokenData)}\n</token_data>\n\n` +
    `<analysis>\n${JSON.stringify(analysis)}\n</analysis>\n\n` +
    `<wallet_scan>\n${JSON.stringify(walletScan)}\n</wallet_scan>\n\n` +
    contractRiskBlock +
    holderScanBlock;

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
        "You are Clark, ChainLens AI's on-chain analyst for Base and EVM markets.\n\n" +
        "VOICE:\n" +
        "- Sharp, direct, crypto-native, professional.\n" +
        "- Slightly punchy, never hypey, never childish.\n" +
        "- Start with the verdict quickly.\n" +
        "- Strongest reason first.\n" +
        "- Short paragraphs and tight bullets.\n\n" +
        "HARD RULES:\n" +
        "- Use only provided fields from context blocks.\n" +
        "- Never invent numbers or certainty.\n" +
        "- Do not mention sources that are not present.\n" +
        "- Do not mention internal provider names.\n" +
        "- Mention Honeypot.is only when Honeypot fields are present.\n" +
        "- Do not claim LP is unlocked unless LP lock data is explicitly present and false.\n" +
        "- Do not claim holder concentration unless holder data is explicitly present.\n" +
        "- If key data is missing, say: 'Not enough verified data to make a strong call.'\n\n" +
        "DEFAULT OUTPUT FORMAT (unless user requests a different format):\n" +
        "Verdict: WATCH / AVOID / SCAN DEEPER / TRUSTWORTHY / UNKNOWN\n" +
        "Confidence: Low / Medium / High\n\n" +
        "Read:\n" +
        "1-2 short sentences.\n\n" +
        "Key signals:\n" +
        "- up to 3 bullets\n\n" +
        "Risks:\n" +
        "- up to 3 bullets\n\n" +
        "Next action:\n" +
        "One clear sentence.\n\n" +
        "LENGTH:\n" +
        "- Normal: 80-140 words.\n" +
        "- Deep report: up to 220 words.\n" +
        "- If user asks for full detail, allow longer.\n\n" +
        "STYLE PHRASES YOU MAY USE SPARINGLY:\n" +
        "- 'This is the main risk.'\n" +
        "- 'That's the signal.'\n" +
        "- 'Not enough data to call it clean.'\n" +
        "- 'Clean contract does not equal safe trade.'\n" +
        "- 'Watch only.'\n" +
        "- 'Avoid for now.'\n" +
        "- 'Scan deeper before touching it.'\n\n" +
        "If the user explicitly asks for strict JSON, return strict JSON only.",
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = (data?.content ?? []).find((b: { type: string }) => b.type === "text");
  const rawText = textBlock?.text ?? JSON.stringify(data);
  return enforceClarkResponseFormat(rawText, prompt, userContent);
}

function enforceClarkResponseFormat(raw: string, prompt: string, userContent: string): string {
  const wantsStrictJson = /return\s+only\s+json|strict json|valid json/i.test(prompt);
  if (wantsStrictJson) return raw.trim();

  const featureContext = hasStructuredFeatureContext(userContent, prompt);
  if (!featureContext) {
    if (isCasualAssistantPrompt(prompt)) {
      return buildCasualClarkReply(prompt);
    }
    if (isMarketHelperPrompt(prompt)) {
      return buildMarketHelperReply(prompt);
    }
    if (isScanRequestWithoutContext(prompt, userContent)) {
      return "I need a scan result or valid ChainLens context to make a proper call. Open Token Scanner or paste a full contract or wallet address and I’ll analyze the available data.";
    }
  }

  const deepMode = /\b(deep|detailed|full breakdown|full detail|long form)\b/i.test(prompt);
  const allowProviderNames = /\b(source|sources|provider|providers)\b/i.test(prompt);
  const text = sanitizeFreeform(raw, { allowProviderNames }).replace(/\r/g, "").trim();
  const upper = text.toUpperCase();
  const ctx = extractClarkContext(userContent);
  const isDevWalletMode = /\bdev-wallet\b|dev wallet follow-up/i.test(prompt) || /\blikely deployer:/i.test(userContent);

  const verdictMatch = upper.match(/\b(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/);
  let verdict = (verdictMatch?.[1] ?? "UNKNOWN") as "AVOID" | "WATCH" | "SCAN DEEPER" | "TRUSTWORTHY" | "UNKNOWN";
  if (ctx.explicitVerdict) verdict = ctx.explicitVerdict;

  const confidenceMatch = text.match(/\b(Confidence)\s*:\s*(Low|Medium|High)\b/i);
  const confidence = ctx.explicitConfidence ??
    (confidenceMatch?.[2]
    ? `${confidenceMatch[2].charAt(0).toUpperCase()}${confidenceMatch[2].slice(1).toLowerCase()}`
    : "Medium");

  const criticalRisk = hasCriticalVerifiedRisk(ctx);
  if (criticalRisk && verdict === "WATCH") verdict = "AVOID";
  if (isDevWalletMode) {
    const derived = deriveDevWalletVerdict(ctx);
    if (ctx.explicitVerdict === "AVOID" && criticalRisk) verdict = "AVOID";
    else if (ctx.explicitVerdict === "UNKNOWN" && derived !== "AVOID") verdict = "WATCH";
    else if (!ctx.explicitVerdict || ctx.explicitVerdict === "UNKNOWN") verdict = derived;
    else if (ctx.explicitVerdict === "WATCH" || ctx.explicitVerdict === "AVOID") verdict = criticalRisk ? "AVOID" : ctx.explicitVerdict;
    else verdict = derived;
  }

  const formatted = normalizeClarkOutput({
    text,
    prompt,
    userContent,
    verdict,
    confidence,
    isDevWalletMode,
    ctx,
  });

  if (deepMode) return formatted;
  return capWordsKeepBreaks(formatted, 150);
}

function normalizeClarkOutput(input: {
  text: string;
  prompt: string;
  userContent: string;
  verdict: "AVOID" | "WATCH" | "SCAN DEEPER" | "TRUSTWORTHY" | "UNKNOWN";
  confidence: string;
  isDevWalletMode: boolean;
  ctx: ClarkContextExtract;
}): string {
  const normalizedText = input.text
    .replace(/\*\*/g, "")
    .replace(/\r/g, "")
    .replace(/[–—]/g, "-")
    .trim();

  const read = capWords(
    input.isDevWalletMode ? buildDevWalletRead(input.ctx, input.verdict) : buildCleanRead(normalizedText),
    55
  );
  const ctxSignals = deriveContextSignals(input.userContent, input.isDevWalletMode ? buildDevWalletSignals(input.ctx) : []);
  const ctxRisks = deriveContextRisks(input.userContent, input.isDevWalletMode ? buildDevWalletRisks(input.ctx) : []);
  const proseSignals = pickBullets(normalizedText, ["key signals", "signals", "strengths"], 3, []);
  const proseRisks = pickBullets(normalizedText, ["risks", "risk flags", "concerns"], 3, []);
  const inferred = inferBulletsFromProse(normalizedText);

  const keySignals = uniqueBullets([...ctxSignals, ...proseSignals, ...inferred.signals]).slice(0, 3);
  const risks = uniqueBullets([...ctxRisks, ...proseRisks, ...inferred.risks]).slice(0, 3);
  const confidence = normalizeConfidence(input.confidence, normalizedText);
  let verdict = input.verdict;
  const combinedRiskText = [...risks, ...ctxRisks].join(" ").toLowerCase();
  if (verdict === "TRUSTWORTHY" && (confidence !== "High" || /unverified|needs review|linked-wallet|holder distribution|lp lock|lp control/i.test(combinedRiskText))) {
    verdict = confidence === "High" ? "WATCH" : "SCAN DEEPER";
  }
  const nextAction = capWords(cleanLine(defaultAction(verdict)), 25);
  const asset = inferAssetLine(input.userContent, input.isDevWalletMode);

  const safeSignals = keySignals.length > 0 ? keySignals : ["Verified data shows mixed but usable token signals."];
  const safeRisks = risks.length > 0 ? risks : ["Some important risk fields are still unverified."];

  return (
    `Asset: ${asset}\n` +
    `Verdict: ${verdict}\n` +
    `Confidence: ${confidence}\n\n` +
    `Read:\n${read}\n\n` +
    `Key signals:\n${toBullets(safeSignals)}\n\n` +
    `Risks:\n${toBullets(safeRisks)}\n\n` +
    `Next action:\n${nextAction}`
  );
}

function normalizeConfidence(confidence: string, text: string): "Low" | "Medium" | "High" {
  const c = `${confidence} ${text}`.toLowerCase();
  if (/\bhigh\b/.test(c) && !/medium-high|high-medium/.test(c)) return "High";
  if (/medium-high|high-medium/.test(c)) return "Medium";
  if (/\blow\b/.test(c)) return "Low";
  return "Medium";
}

function cleanLine(line: string): string {
  return line
    .replace(/\*\*/g, "")
    .replace(/\b(verdict|confidence|read|key signals|risks|next action)\s*:/gi, "")
    .replace(/0x[a-fA-F0-9]{40}/g, "")
    .replace(/\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCleanRead(text: string): string {
  const readSection = extractSection(text, "Read:", ["Key signals:", "Risks:", "Next action:"]);
  const source = readSection || text;
  const cleaned = source
    .split("\n")
    .map(cleanLine)
    .filter(Boolean)
    .filter(l => !/^(avoi|watch|scan deeper|trustworthy|unknown)\b/i.test(l))
    .filter(l => !/(price:|\bvolume\b|\bliquidity\b|\bmarket cap\b|\bfdv\b|\b24h\b|\b%\b)/i.test(l))
    .filter(l => !/\b0x[a-fA-F0-9]{8,}\b/.test(l))
    .filter(l => l.split(" ").length <= 24)
    .join(" ");
  return toSentencePair(cleaned || "Not enough verified data to make a strong call.");
}

function uniqueBullets(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const cleaned = cleanLine(item).replace(/^[\-\u2022]\s*/, "");
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    if (key.includes("not enough verified data")) continue;
    seen.add(key);
    out.push(capWords(cleaned, 12));
  }
  return out;
}

function deriveContextSignals(userContent: string, seed: string[]): string[] {
  const out = [...seed];
  if (/owner_renounced["']?\s*:\s*["']?1/.test(userContent)) out.push("Owner appears renounced");
  if (/is_open_source["']?\s*:\s*["']?1/.test(userContent)) out.push("Open-source contract");
  if (/buy_tax["']?\s*:\s*["']?0/.test(userContent) && /sell_tax["']?\s*:\s*["']?0/.test(userContent)) out.push("0% buy and sell tax");
  if (/is_honeypot["']?\s*:\s*["']?0/.test(userContent)) out.push("Honeypot not flagged");
  return out;
}

function deriveContextRisks(userContent: string, seed: string[]): string[] {
  const out = [...seed];
  if (!/lpLocked|lpLockDataAvailable|liquidity_locked/.test(userContent)) out.push("LP lock or control is unverified");
  if (/holder data available\s*:\s*false/i.test(userContent) || !/token_holders|holders/i.test(userContent)) out.push("Holder distribution needs review");
  if (!/linked wallets\s*:\s*0/i.test(userContent)) out.push("Linked-wallet behavior needs review");
  return out;
}

function inferBulletsFromProse(text: string): { signals: string[]; risks: string[] } {
  const lines = text.split("\n").map(cleanLine).filter(Boolean);
  const signals: string[] = [];
  const risks: string[] = [];
  for (const line of lines) {
    const l = line.toLowerCase();
    if (/(open.source|renounced|no mint|0% buy|0% sell|honeypot not|liquidity|volume)/.test(l)) signals.push(line);
    if (/(unverified|needs review|thin|volatile|lp lock|holder|linked-wallet|risk)/.test(l)) risks.push(line);
  }
  return { signals, risks };
}

function blockIsMeaningful(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed) return false;
  if (trimmed === "{}" || trimmed === "[]" || trimmed === "null") return false;
  return true;
}

function extractContextBlock(userContent: string, tag: string): string {
  const m = userContent.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, "i"));
  return m?.[1] ?? "";
}

function hasStructuredFeatureContext(userContent: string, prompt: string): boolean {
  const tokenDataBlock = extractContextBlock(userContent, "token_data");
  const walletScanBlock = extractContextBlock(userContent, "wallet_scan");
  const analysisBlock = extractContextBlock(userContent, "analysis");
  const holderBlock = extractContextBlock(userContent, "holder_contract_analysis");
  const contractRiskBlock = extractContextBlock(userContent, "contract_risk");

  if (blockIsMeaningful(tokenDataBlock)) return true;
  if (blockIsMeaningful(walletScanBlock)) return true;
  if (blockIsMeaningful(analysisBlock)) return true;
  if (blockIsMeaningful(holderBlock)) return true;
  if (blockIsMeaningful(contractRiskBlock)) return true;

  return /\b(base radar|token scanner|wallet scanner|dev wallet|liquidity safety|whale alerts|pump alerts)\b/i.test(prompt);
}

function isCasualAssistantPrompt(prompt: string): boolean {
  const t = prompt.trim().toLowerCase();
  if (!t) return false;
  if (/^(hi|hey|hello|yo|gm|sup|what'?s up)\b[!.?]*$/.test(t)) return true;
  return /\b(help|what can you do|who are you|what is chainlens|how do i scan|how to scan|how does this work)\b/i.test(t);
}

function isMarketHelperPrompt(prompt: string): boolean {
  return /\b(what'?s moving on base|trending tokens|what should i scan|explain liquidity risk|what are whales buying|where should i start)\b/i.test(prompt);
}

function isScanRequestWithoutContext(prompt: string, userContent: string): boolean {
  const wantsAnalysis = /\b(scan|analyze|analysis|is this safe|safe\?|risk|verdict|check)\b/i.test(prompt);
  if (!wantsAnalysis) return false;
  const hasAddress = /0x[a-fA-F0-9]{40}/.test(prompt);
  const tokenDataBlock = extractContextBlock(userContent, "token_data");
  const walletScanBlock = extractContextBlock(userContent, "wallet_scan");
  return !hasAddress && !blockIsMeaningful(tokenDataBlock) && !blockIsMeaningful(walletScanBlock);
}

function buildCasualClarkReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/\bwhat can you do|help|who are you\b/.test(t)) {
    return "I’m Clark — ChainLens on-chain analyst for Base. I can scan token risk, break down wallet behavior, check liquidity safety, flag dev-wallet links, and summarize what’s moving. Drop a contract, wallet, or feature context and I’ll give you a clean read.";
  }
  if (/\bwhat is chainlens\b/.test(t)) {
    return "ChainLens is your Base intelligence terminal. Use Base Radar for fresh movers, Token Scanner for contract checks, Wallet Scanner for behavior reads, and Dev Wallet Detector for deployer risk mapping.";
  }
  if (/\bhow do i scan|how to scan\b/.test(t)) {
    return "Paste a Base contract into Token Scanner for risk + liquidity checks, or a wallet into Wallet Scanner for flow analysis. If you share the result here, I’ll turn it into a sharp action read.";
  }
  return "Yo — Clark here. Paste a Base token, wallet, or alert and I’ll break it down. I can scan risk, liquidity, deployer behavior, wallet flows, and Base Radar signals.";
}

function buildMarketHelperReply(prompt: string): string {
  if (/\bliquidity risk\b/i.test(prompt)) {
    return "Liquidity risk is mainly lock status, concentration, and exit depth. Use Liquidity Safety first, then Token Scanner for contract flags. Share the output and I’ll translate it into entry risk.";
  }
  if (/\bwhales buying\b/i.test(prompt)) {
    return "Use Whale Alerts plus Wallet Scanner to see real position changes and transfer patterns. If you paste a wallet or alert context, I’ll break down whether the flow looks accumulation or distribution.";
  }
  return "Use Base Radar for fresh launches, Token Scanner for contract checks, and Dev Wallet Detector for deployer and linked-wallet risk. Paste a contract or wallet and I’ll break it down.";
}

function sanitizeFreeform(raw: string, opts: { allowProviderNames: boolean }): string {
  let out = raw
    .replace(/^\s{0,3}#{1,6}\s.+$/gm, "")
    .replace(/^\s*[-=]{3,}\s*$/gm, "")
    .replace(/\|.*\|/g, "")
    .replace(/^\s*dev wallet follow[- ]?up:?/gim, "")
    .trim();

  if (!opts.allowProviderNames) {
    out = out
      .replace(/\bGoPlus\b/gi, "Security scan")
      .replace(/\bCovalent\b/gi, "available scan data")
      .replace(/\bGoldRush\b/gi, "available scan data")
      .replace(/\bGeckoTerminal\b/gi, "market data");
  }
  return out;
}

type ClarkContextExtract = {
  explicitVerdict: "AVOID" | "WATCH" | "SCAN DEEPER" | "TRUSTWORTHY" | "UNKNOWN" | null
  explicitConfidence: "Low" | "Medium" | "High" | null
  deployerKnown: boolean
  linkedWallets: number | null
  holderDataAvailable: boolean | null
  suspiciousTransfers: boolean | null
  suspiciousReasonsNone: boolean
  honeypot: boolean | null
  buyTax: number | null
  sellTax: number | null
  lpLocked: boolean | null
  lpLockDataAvailable: boolean | null
  lpHolderConcentration: number | null
  lpHolderDataAvailable: boolean | null
  supplyControlled: number | null
  hasAnySecurityOrLiquidityData: boolean
}

function hasCriticalVerifiedRisk(ctx: ClarkContextExtract): boolean {
  const honeypot = ctx.honeypot === true;
  const highTax = (ctx.buyTax !== null && ctx.buyTax > 15) || (ctx.sellTax !== null && ctx.sellTax > 15);
  const unlockedLp = ctx.lpLockDataAvailable === true && ctx.lpLocked === false;
  const lpConcentration = ctx.lpHolderDataAvailable === true && ctx.lpHolderConcentration !== null && ctx.lpHolderConcentration >= 80;
  const suspiciousFunding = ctx.suspiciousTransfers === true && (ctx.linkedWallets ?? 0) >= 5;
  const holderConcentration = ctx.holderDataAvailable === true && ctx.supplyControlled !== null && ctx.supplyControlled >= 50;
  return honeypot || highTax || unlockedLp || lpConcentration || suspiciousFunding || holderConcentration;
}

function extractClarkContext(userContent: string): ClarkContextExtract {
  const getNum = (label: string): number | null => {
    const m = userContent.match(new RegExp(`${label}\\s*:\\s*([-+]?\\d+(?:\\.\\d+)?)`, "i"));
    return m ? Number(m[1]) : null;
  };
  const getBool = (label: string): boolean | null => {
    const m = userContent.match(new RegExp(`${label}\\s*:\\s*(true|false|yes|no|1|0)`, "i"));
    if (!m) return null;
    return /true|yes|1/i.test(m[1]);
  };
  const verdictM = userContent.match(/\bVerdict\s*:\s*(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/i);
  const confM = userContent.match(/\bConfidence\s*:\s*(Low|Medium|High)\b/i);
  const linked = getNum("Linked wallets");
  const suspiciousReasonsNone = /Suspicious reasons\s*:\s*(none|n\/a)/i.test(userContent);
  const hasDeployerAddress = /\bdeployer(?:\s+wallet|\s+address)?\s*:\s*0x[a-fA-F0-9]{40}\b/i.test(userContent);
  const hasLiquidityOrSecurityData =
    /\b(honeypot|buy tax|sell tax|lpLocked|lpLockDataAvailable|lpHolderConcentration|lpHolderDataAvailable|Supply controlled|Holder data available)\s*:/i.test(userContent);

  return {
    explicitVerdict: verdictM ? verdictM[1].toUpperCase() as ClarkContextExtract["explicitVerdict"] : null,
    explicitConfidence: confM ? `${confM[1].charAt(0).toUpperCase()}${confM[1].slice(1).toLowerCase()}` as ClarkContextExtract["explicitConfidence"] : null,
    deployerKnown: hasDeployerAddress || (!/Likely deployer:\s*(unknown|null|none)/i.test(userContent) && /Likely deployer:/i.test(userContent)),
    linkedWallets: linked,
    holderDataAvailable: getBool("Holder data available"),
    suspiciousTransfers: getBool("Suspicious transfers"),
    suspiciousReasonsNone,
    honeypot: getBool("Honeypot"),
    buyTax: getNum("Buy tax"),
    sellTax: getNum("Sell tax"),
    lpLocked: getBool("lpLocked"),
    lpLockDataAvailable: getBool("lpLockDataAvailable"),
    lpHolderConcentration: getNum("lpHolderConcentration"),
    lpHolderDataAvailable: getBool("lpHolderDataAvailable"),
    supplyControlled: getNum("Supply controlled"),
    hasAnySecurityOrLiquidityData: hasLiquidityOrSecurityData,
  };
}

function deriveDevWalletVerdict(ctx: ClarkContextExtract): "AVOID" | "WATCH" | "UNKNOWN" {
  if (hasCriticalVerifiedRisk(ctx)) return "AVOID";

  const hasLinkedWalletSignals = (ctx.linkedWallets ?? 0) > 0;
  const hasUsefulSignal =
    ctx.deployerKnown ||
    hasLinkedWalletSignals ||
    ctx.holderDataAvailable === false ||
    ctx.explicitConfidence === "Medium" ||
    ctx.explicitConfidence === "Low" ||
    (ctx.suspiciousReasonsNone && hasLinkedWalletSignals);

  if (hasUsefulSignal) return "WATCH";

  const noUsefulSignalsAtAll =
    !ctx.deployerKnown &&
    !hasLinkedWalletSignals &&
    ctx.holderDataAvailable !== true &&
    !ctx.hasAnySecurityOrLiquidityData &&
    ctx.suspiciousTransfers !== true;

  return noUsefulSignalsAtAll ? "UNKNOWN" : "WATCH";
}

function buildDevWalletRead(ctx: ClarkContextExtract, verdict: string): string {
  if (verdict === "WATCH" && ctx.deployerKnown && (ctx.linkedWallets ?? 0) > 0 && ctx.holderDataAvailable === false) {
    const conf = (ctx.explicitConfidence ?? "Medium").toLowerCase();
    return `Likely deployer is identified with ${conf} confidence, and ${ctx.linkedWallets} linked wallets were found. Holder distribution is still unavailable, so this is watch-only.`;
  }
  const deployerLine = ctx.deployerKnown ? "Likely deployer is identified." : "Likely deployer is not identified.";
  const linkedLine = ctx.linkedWallets !== null ? `${ctx.linkedWallets} linked wallets detected.` : "Linked wallet count is not verified.";
  const caution = verdict === "WATCH" ? "Not enough verified data to call it clean." : "This is the main risk.";
  return toSentencePair(`${deployerLine} ${linkedLine} ${caution}`.replace(/\*\*/g, ""));
}

function buildDevWalletSignals(ctx: ClarkContextExtract): string[] {
  const out: string[] = [];
  if (ctx.deployerKnown) out.push("Likely deployer identified");
  if (ctx.linkedWallets !== null) out.push(`${ctx.linkedWallets} linked wallets found`);
  if (ctx.suspiciousReasonsNone) out.push("No suspicious reasons confirmed");
  return out.slice(0, 3);
}

function buildDevWalletRisks(ctx: ClarkContextExtract): string[] {
  const out: string[] = [];
  if (ctx.holderDataAvailable === false) out.push("Holder distribution unavailable");
  if (ctx.explicitConfidence === "Medium" || ctx.explicitConfidence === "Low") out.push(`Deployer confidence is ${ctx.explicitConfidence?.toLowerCase()}`);
  if ((ctx.linkedWallets ?? 0) > 0) out.push("Linked wallets need monitoring");
  return out.slice(0, 3);
}

function pickRead(text: string): string {
  const readSection = extractSection(text, "Read:", ["Key signals:", "Risks:", "Next action:"]);
  if (readSection) return toSentencePair(readSection);
  return toSentencePair(text);
}

function pickBullets(text: string, headers: string[], max: number, fallback: string[]): string[] {
  for (const h of headers) {
    const section = extractSection(text, `${h}:`, ["Read:", "Key signals:", "Risks:", "Next action:"]);
    if (!section) continue;
    const bullets = section
      .split(/\n|•|;/)
      .map(l => l.replace(/^[\-\u2022]\s*/, "").trim())
      .filter(Boolean)
      .map(l => capWords(l, 12))
      .slice(0, max);
    if (bullets.length > 0) return bullets;
  }
  if (fallback.length > 0) return fallback.slice(0, max);
  return ["Not enough verified data to make a strong call."].slice(0, max);
}

function pickNextAction(text: string, verdict: string): string {
  const section = extractSection(text, "Next action:", ["Read:", "Key signals:", "Risks:"]);
  if (section) return section.split("\n").map(s => s.trim()).filter(Boolean)[0] ?? defaultAction(verdict);
  return defaultAction(verdict);
}

function defaultAction(verdict: string): string {
  if (verdict === "AVOID") return "Avoid until the critical risk is resolved or verified safe."
  if (verdict === "TRUSTWORTHY") return "Monitor normally; no major risk surfaced from available data."
  if (verdict === "SCAN DEEPER") return "Run Token Scanner and Dev Wallet Detector before touching it."
  if (verdict === "WATCH") return "Watch only; verify holder distribution, LP control, and linked-wallet behavior before trusting it."
  return "Not enough verified data to make a strong call."
}

function extractSection(text: string, start: string, stops: string[]): string {
  const lines = text.split("\n");
  const startIdx = lines.findIndex(l => l.toLowerCase().startsWith(start.toLowerCase()));
  if (startIdx === -1) return "";
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (stops.some(s => line.toLowerCase().startsWith(s.toLowerCase()))) break;
    if (line.trim()) out.push(line.trim());
  }
  return out.join(" ");
}

function toSentencePair(text: string): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return "Not enough verified data to make a strong call.";
  return sentences.slice(0, 2).join(" ");
}

function toBullets(items: string[]): string {
  return items.slice(0, 3).map(i => `- ${i}`).join("\n");
}

function capWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function capWordsKeepBreaks(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  let count = 0;
  const out: string[] = [];
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (!part.trim()) {
      out.push(part);
      continue;
    }
    count += 1;
    if (count > maxWords) break;
    out.push(part);
  }
  return `${out.join("").trim()}…`;
}

// ---------- Scanner functions ----------

async function scanTokenData(address: string, chain: SupportedChain = "base", origin: string): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);

  const results = await Promise.allSettled([
    callGoPlus(address, chain),
    callGoldrush(`${chainName}/tokens/${address}/token_holders_v2/`, { "page-size": "50" }),
    callBasescan({ module: "token", action: "tokeninfo", contractaddress: address }),
    callGeckoTerminal(network, origin),
    callTrending(origin),
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

async function scanLiquidityData(address: string, chain: SupportedChain = "base", origin: string): Promise<ClarkContext> {
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);

  const results = await Promise.allSettled([
    callGoldrush(`${chainName}/xy=k/address/${address}/pools/`),
    callGoPlus(address, chain),
    callGeckoTerminal(network, origin),
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

async function scanBaseRadarData(origin: string): Promise<ClarkContext> {
  const results = await Promise.allSettled([
    callTrending(origin),
    callGeckoTerminal("base", origin),
    callGeckoTerminal("eth", origin),
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

async function scanPumpData(address: string, chain: SupportedChain = "base", origin: string): Promise<ClarkContext> {
  const network = gtNetwork(chain);

  const results = await Promise.allSettled([
    callGoPlus(address, chain),
    callGeckoTerminal(network, origin),
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
  chain: SupportedChain = "base",
  origin: string
): Promise<ClarkContext | null> {
  const t = prompt.toLowerCase();
  const address = extractAddress(prompt);

  if (address && (hasWalletIntent(t) || hasWalletQualityIntent(t))) {
    return scanWalletData(address, chain);
  }
  if (address && hasDevWalletIntent(t)) {
    return scanDevWalletData(address, chain);
  }
  if (address && hasLiquidityIntent(t)) {
    return scanLiquidityData(address, chain, origin);
  }
  if (address && /\bwhale\b/.test(t)) {
    return scanWhaleData(address, chain);
  }
  if (address && /\bpump\b/.test(t)) {
    return scanPumpData(address, chain, origin);
  }
  if (address && hasTokenIntent(t)) {
    return scanTokenData(address, chain, origin);
  }
  if (hasMarketIntent(t) || /\bbase radar\b/.test(t)) {
    return { gtPools: [] };
  }
  if (address) {
    return scanTokenData(address, chain, origin);
  }

  return null;
}

// ---------- Feature handlers ----------

async function handleTokenScanner(body: ClarkRequestBody, origin: string) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [holders, gtData, trending] = await Promise.all([
    callGoldrush(`${chainName}/tokens/${tokenAddress}/token_holders_v2/`, { "page-size": "100" }),
    callGeckoTerminal(network, origin),
    callTrending(origin),
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

  const results = await Promise.allSettled([
    callCovalent(`${chainName}/address/${walletAddress}/balances_v2/`),
    callCovalent(`${chainName}/address/${walletAddress}/transactions_v3/`, { "page-size": "20" }),
    callZerion(`wallets/${walletAddress}/positions/`, {
      currency: "usd",
      "filter[positions]": "only_simple",
      "filter[trash]": "only_non_trash",
    }),
  ]);

  type ZPos = { attributes?: { value?: { usd?: number }; fungible_info?: { symbol?: string; name?: string } } };
  const zerionRaw = results[2].status === "fulfilled" ? results[2].value : null;
  const allPositions: ZPos[] = Array.isArray((zerionRaw as { data?: unknown[] })?.data)
    ? (zerionRaw as { data: ZPos[] }).data
    : [];
  const top10 = allPositions
    .filter(p => (p.attributes?.value?.usd ?? 0) > 0)
    .sort((a, b) => (b.attributes?.value?.usd ?? 0) - (a.attributes?.value?.usd ?? 0))
    .slice(0, 10)
    .map(p => ({
      symbol: p.attributes?.fungible_info?.symbol ?? "?",
      name: p.attributes?.fungible_info?.name ?? "?",
      usd: p.attributes?.value?.usd ?? 0,
    }));

  const context: ClarkContext = {
    walletScan: {
      type: "wallet-scan",
      address: walletAddress,
      chain,
      balances: results[0].status === "fulfilled" ? results[0].value : null,
      transactions: results[1].status === "fulfilled" ? results[1].value : null,
      zerion_top10: top10,
    },
  };

  const prompt = body.prompt
    ? `${body.prompt}\n\nWallet address: ${walletAddress}`
    : `Analyze wallet ${walletAddress}. Use the WALLET SCAN FORMAT. Focus on holdings, behavior, PnL, and end with WATCH/AVOID/COPY verdict.`;

  const analysis = await callAnthropic(prompt, context);
  return { feature: "wallet-scanner", chain, walletAddress, analysis };
}

async function handleDevWalletDetector(body: ClarkRequestBody) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const results = await Promise.allSettled([
    callGoldrush(`${chainName}/tokens/${tokenAddress}/token_holders_v2/`, { "page-size": "200" }),
    callGoPlus(tokenAddress, chain),
  ]);

  const context: ClarkContext = {
    tokenData: {
      type: "dev-wallet-scan",
      address: tokenAddress,
      chain,
      top_holders: results[0].status === "fulfilled" ? results[0].value : null,
      goplus_security: results[1].status === "fulfilled" ? results[1].value : null,
    },
  };

  const prompt = `Identify the dev/deployer wallet for token ${tokenAddress}. Analyze top holders and GoPlus security flags for concentration risk, suspicious mechanics, or insider wallets. Give a clear verdict: is this dev wallet a red flag?`;
  const analysis = await callAnthropic(prompt, context);
  return { feature: "dev-wallet-detector", chain, tokenAddress, analysis };
}

async function handleLiquiditySafety(body: ClarkRequestBody, origin: string) {
  const chain = body.chain ?? "base";
  const chainName = GOLDRUSH_CHAIN[chain];
  const network = gtNetwork(chain);
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [goldrushPools, gtData] = await Promise.all([
    callGoldrush(`${chainName}/xy=k/address/${tokenAddress}/pools/`),
    callGeckoTerminal(network, origin),
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

  const results = await Promise.allSettled([
    callCovalent(`${chainName}/address/${walletAddress}/transactions_v3/`, { "page-size": "50" }),
    callZerion(`wallets/${walletAddress}/positions/`, {
      currency: "usd",
      "filter[positions]": "only_simple",
    }),
  ]);

  const context: ClarkContext = {
    walletScan: {
      type: "whale-scan",
      address: walletAddress,
      chain,
      transactions: results[0].status === "fulfilled" ? results[0].value : null,
      zerion_positions: results[1].status === "fulfilled" ? results[1].value : null,
    },
  };

  const prompt = `Analyze whale wallet ${walletAddress}. Identify large moves, accumulation patterns, and key tokens. Is this wallet worth following? End with WATCH or AVOID verdict.`;
  const analysis = await callAnthropic(prompt, context);
  return { feature: "whale-alerts", chain, walletAddress, analysis };
}

async function handlePumpAlerts(body: ClarkRequestBody, origin: string) {
  const chain = body.chain ?? "base";
  const network = gtNetwork(chain);
  const tokenAddress = body.tokenAddress ?? body.addressOrToken;
  if (!tokenAddress) throw new Error("tokenAddress or addressOrToken is required");

  const [security, gtData] = await Promise.all([
    callGoPlus(tokenAddress, chain),
    callGeckoTerminal(network, origin),
  ]);

  return {
    feature: "pump-alerts",
    chain,
    tokenAddress,
    tokenData: { security },
    gtPools: (gtData as { data?: unknown[] })?.data ?? [],
  };
}

async function handleScanToken(body: ClarkRequestBody, origin: string) {
  // Use pre-fetched token data if the caller already has it (avoids redundant fetch)
  let scanData: unknown = body.tokenData ?? null;

  if (!scanData) {
    const contract = body.tokenAddress ?? body.addressOrToken;
    const nameQuery = body.query ?? body.prompt;

    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      scanData = await callScanToken(contract, "contract", origin);
    } else if (nameQuery) {
      scanData = await callScanToken(nameQuery.trim(), "query", origin);
    }
  }

  if (!scanData) {
    const label = body.tokenAddress ?? body.addressOrToken ?? body.query ?? body.prompt ?? "unknown";
    return {
      feature: "scan-token",
      analysis: `Token "${label}" was not found on GeckoTerminal Base data. Check the name or contract and try again.`,
    };
  }

  const context: ClarkContext = { tokenData: scanData };
  const prompt =
    `Use the SCAN-TOKEN format from your system prompt. Analyze the token in <token_data>. ` +
    `Follow the format exactly: Analysis, Market, Signals, Risks, Verdict (Send/Mid/Avoid). ` +
    `Max 12 lines. Dot points only. Bold keywords. No paragraphs. No filler.` +
    (body.prompt ? ` User asked: ${body.prompt}` : "");

  const analysis = await callAnthropic(prompt, context);
  return { feature: "scan-token", data: scanData, analysis };
}

async function handleBaseRadar(_body: ClarkRequestBody, origin: string) {
  const [trending, gtBase, gtEth] = await Promise.all([
    callTrending(origin),
    callGeckoTerminal("base", origin),
    callGeckoTerminal("eth", origin),
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

function buildWalletBalanceReply(walletData: unknown, address: string): string {
  const data = (walletData ?? {}) as Record<string, unknown>;
  const holdings = Array.isArray(data.holdings) ? (data.holdings as Array<Record<string, unknown>>) : [];
  const sorted = holdings
    .slice()
    .sort((a, b) => (Number(b.value ?? 0)) - (Number(a.value ?? 0)));
  const top = sorted.slice(0, 3);
  const largest = top[0];

  const summary = [
    `- Portfolio value: ${typeof data.totalValue === "number" ? formatUsdShort(data.totalValue as number) : "n/a"}`,
    `- Token count: ${holdings.length || "n/a"}`,
    `- Largest holding: ${largest ? `${String(largest.symbol ?? largest.name ?? "TOKEN")} / ${formatUsdShort(Number(largest.value ?? 0))}` : "n/a"}`,
  ];

  const holdingLines = top.length > 0
    ? top.map((h) => `- ${String(h.symbol ?? h.name ?? "TOKEN")}: ${Number(h.balance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} / ${formatUsdShort(Number(h.value ?? 0))}`)
    : ["- No priced holdings returned by wallet feed."];

  return `Wallet:
${shortAddress(address)}

Summary:
${summary.join("\n")}

Top holdings:
${holdingLines.join("\n")}

Data note:
Wallet balances are from the wallet feed and may be partial for unsupported assets.`;
}

function buildWalletQualityReply(walletData: unknown, address: string): string {
  const data = (walletData ?? {}) as Record<string, unknown>;
  const holdings = Array.isArray(data.holdings) ? (data.holdings as Array<Record<string, unknown>>) : [];
  const totalValue = typeof data.totalValue === "number" ? (data.totalValue as number) : null;
  const txCount = typeof data.txCount === "number" ? (data.txCount as number) : null;

  let verdict: "WATCH" | "SCAN DEEPER" | "AVOID" | "UNKNOWN" = "UNKNOWN";
  let confidence: "Low" | "Medium" | "High" = "Low";

  if ((totalValue ?? 0) > 25_000 && holdings.length >= 4) {
    verdict = "WATCH";
    confidence = "Medium";
  } else if (holdings.length > 0) {
    verdict = "SCAN DEEPER";
    confidence = "Low";
  }

  const signals = [
    totalValue !== null ? `Portfolio value is ${formatUsdShort(totalValue)}.` : "Portfolio value is unavailable.",
    `Holdings detected: ${holdings.length}.`,
    txCount !== null ? `Ethereum nonce indicates ${txCount} outbound txs.` : "Behavior history depth is limited in this pass.",
  ];

  const risks = [
    "Balance snapshots alone cannot prove smart-money behavior.",
    "PnL, timing, and transfer counterparties are not fully verified here.",
    holdings.length < 2 ? "Portfolio concentration is high or unclear." : "Needs deeper flow analysis before trust.",
  ];

  const read = verdict === "WATCH"
    ? "This wallet has meaningful value and enough holdings to be worth monitoring, but balances alone are not enough to treat it as smart money."
    : "Not enough behavior data to call this a high-quality wallet from balances alone. It needs deeper flow analysis.";

  return buildStructuredVerdict(
    verdict,
    confidence,
    read,
    signals,
    risks,
    "Use Wallet Scanner for transaction behavior before making follow decisions.",
    `Wallet ${shortAddress(address)}`
  );
}

async function handleClarkAI(body: ClarkRequestBody, origin: string) {
  const chain = body.chain ?? "base";
  const network = gtNetwork(chain);
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";
  const replyMode = detectReplyMode(body);
  const { intent, address } = detectIntent(prompt);

  if (replyMode === "casual_help") {
    return { feature: "clark-ai", chain, mode: "casual_help", analysis: buildCasualClarkReply(prompt) };
  }

  if (replyMode === "general_market") {
    let tokens: BaseMarketToken[] = [];
    try {
      const trendingRaw = await callTrending(origin);
      tokens = mapTrendingTokens(trendingRaw);
    } catch {
      tokens = [];
    }
    if (tokens.length === 0) {
      try {
        const gtRaw = await callGeckoTerminal("base", origin);
        tokens = mapGtPoolsToMarketTokens(gtRaw);
      } catch {
        tokens = [];
      }
    }
    if (tokens.length > 0) {
      return { feature: "clark-ai", chain, mode: "general_market", analysis: buildBaseMarketBriefing(tokens) };
    }
    return { feature: "clark-ai", chain, mode: "general_market", analysis: buildGeneralMarketNoContextReply(prompt) };
  }

  if (replyMode === "educational") {
    return { feature: "clark-ai", chain, mode: "educational", analysis: buildEducationalReply(prompt) };
  }

  if (replyMode === "routing_help") {
    return { feature: "clark-ai", chain, mode: "routing_help", analysis: buildRoutingHelpReply(prompt) };
  }

  if (replyMode === "analysis" && !address && intent !== "token_name_lookup") {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: "Paste a Base contract, wallet, or scan result and I’ll analyze it.",
    };
  }

  if (replyMode === "analysis" && address && intent === "unknown") {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: "Is this a token contract or wallet? I can scan either.",
    };
  }

  if (intent === "token_name_lookup") {
    const tokenQuery = extractTokenLookupQuery(prompt) ?? prompt.trim();
    const candidates = await searchBaseTokenCandidates(tokenQuery);
    if (candidates.length === 0) {
      return {
        feature: "clark-ai",
        chain,
        mode: "token_name_lookup",
        analysis: `I couldn’t find a Base token match for '${tokenQuery}'. Paste the contract address or open Token Scanner.`,
      };
    }
    if (candidates.length > 1) {
      const options = candidates.slice(0, 3).map((c, i) => `${i + 1}. ${c.symbol} — ${c.contract}`).join("\n");
      return {
        feature: "clark-ai",
        chain,
        mode: "token_name_lookup",
        analysis: `I found multiple Base matches for '${tokenQuery}'. Pick one:\n${options}\nSend the number or paste the contract.`,
      };
    }

    const selected = candidates[0];
    const tokenData = await callScanToken(selected.contract, "contract", origin);
    if (!tokenData) {
      return {
        feature: "clark-ai",
        chain,
        mode: "token_name_lookup",
        analysis: `I couldn’t find a Base token match for '${tokenQuery}'. Paste the contract address or open Token Scanner.`,
      };
    }
    const context: ClarkContext = { tokenData };
    let analysis: string;
    try {
      analysis = await callAnthropic(`Analyze Base token ${selected.symbol} (${selected.contract}) and assess current risk.`, context);
    } catch {
      analysis = buildTokenAnalysisFallback(tokenData, selected.contract);
    }
    return { feature: "clark-ai", chain, mode: "analysis", analysis };
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && (intent === "token_analysis" || intent === "wallet_analysis" || intent === "dev_wallet" || intent === "liquidity_safety" || intent === "whale_alert") && !address) {
    return { feature: "clark-ai", chain, analysis: missingAddressReply(intent) };
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && intent === "dev_wallet" && address) {
    const devWalletRes = await callInternalApi(origin, "/api/dev-wallet", { contractAddress: address });
    if (!devWalletRes.ok) {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I can do that once this feature backend is wired. For now, open Dev Wallet Detector and paste the contract.",
      };
    }

    const data = devWalletRes.json as Record<string, unknown>;
    const verdict = (data?.clarkVerdict as Record<string, unknown> | null) ?? null;
    if (verdict) {
      const rawLabel = String(verdict.label ?? "WATCH").toUpperCase();
      const mappedVerdict = rawLabel === "LOW" ? "TRUSTWORTHY" : rawLabel === "MEDIUM" ? "WATCH" : rawLabel === "HIGH" ? "AVOID" : "UNKNOWN";
      const rawConfidence = String(verdict.confidence ?? "low").toLowerCase();
      const confidence = rawConfidence === "high" ? "High" : rawConfidence === "medium" ? "Medium" : "Low";
      return {
        feature: "clark-ai",
        chain,
        analysis: buildStructuredVerdict(
          mappedVerdict,
          confidence,
          String(verdict.summary ?? "Not enough verified data to make a strong call."),
          Array.isArray(verdict.keySignals) ? verdict.keySignals.map(String) : ["Likely deployer and linked-wallet checks completed."],
          Array.isArray(verdict.risks) ? verdict.risks.map(String) : ["Some data is unverified in the current scan."],
          String(verdict.nextAction ?? "Use Dev Wallet Detector details before any entry.")
        ),
      };
    }
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && intent === "wallet_balance" && address) {
    try {
      const walletData = await fetchWalletSnapshot(address);
      return { feature: "clark-ai", chain, analysis: buildWalletBalanceReply(walletData, address) };
    } catch {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I couldn’t fetch wallet balances right now. Try Wallet Scanner or paste another Base wallet.",
      };
    }
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && intent === "wallet_quality" && address) {
    try {
      const walletData = await fetchWalletSnapshot(address);
      return { feature: "clark-ai", chain, analysis: buildWalletQualityReply(walletData, address) };
    } catch {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I couldn’t fetch wallet balances right now. Try Wallet Scanner or paste another Base wallet.",
      };
    }
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && (intent === "token_analysis" || intent === "analysis") && address) {
    const tokenRes = await fetch(`${origin}/api/scan-token?contract=${encodeURIComponent(address)}`, { cache: "no-store" });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson?.ok) {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I can do that once this feature backend is wired. For now, open Token Scanner and paste the contract.",
      };
    }
    const context: ClarkContext = { tokenData: tokenJson.data ?? {} };
    const analysis = await callAnthropic(prompt, context);
    return { feature: "clark-ai", chain, analysis };
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && intent === "wallet_analysis" && address) {
    const walletRes = await callInternalApi(origin, "/api/wallet", { address });
    if (!walletRes.ok) {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I couldn’t fetch wallet balances right now. Try Wallet Scanner or paste another Base wallet.",
      };
    }
    const context: ClarkContext = { walletScan: walletRes.json ?? {} };
    const analysis = await callAnthropic(prompt, context);
    return { feature: "clark-ai", chain, analysis };
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && intent === "liquidity_safety" && address) {
    const liqRes = await callInternalApi(origin, "/api/liquidity-safety", { contract: address });
    if (!liqRes.ok || !(liqRes.json as Record<string, unknown>)?.ok) {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I can do that once this feature backend is wired. For now, open Liquidity Safety and paste the contract.",
      };
    }
    const liqData = (liqRes.json as Record<string, unknown>)?.data ?? {};
    const context: ClarkContext = { tokenData: liqData };
    const analysis = await callAnthropic(prompt, context);
    return { feature: "clark-ai", chain, analysis };
  }

  if (replyMode === "feature_context" && intent === "base_radar") {
    const radarRes = await fetch(`${origin}/api/radar`, { cache: "no-store" });
    const radarJson = await radarRes.json().catch(() => ({}));
    if (!radarRes.ok) {
      return {
        feature: "clark-ai",
        chain,
        analysis: "Use Base Radar for fresh launches and momentum reads, then ask Clark with that context for a tighter verdict.",
      };
    }
    const radarTokens = Array.isArray((radarJson as Record<string, unknown>)?.tokens)
      ? ((radarJson as Record<string, unknown>).tokens as unknown[])
      : [];
    const context: ClarkContext = { trending: radarTokens, gtPools: [] };
    const analysis = await callAnthropic(prompt, context);
    return { feature: "clark-ai", chain, analysis };
  }

  let trending: unknown[] = [];
  let gtPools: unknown[] = [];

  if (shouldFetchMarketContext(prompt)) {
    const [trendingResult, gtRawResult] = await Promise.allSettled([
      callTrending(origin),
      callGeckoTerminal(network, origin),
    ]);
    if (trendingResult.status === "fulfilled" && Array.isArray(trendingResult.value))
      trending = trendingResult.value;
    if (gtRawResult.status === "fulfilled" && Array.isArray((gtRawResult.value as { data?: unknown[] })?.data))
      gtPools = ((gtRawResult.value as { data: unknown[] }).data as unknown[]).slice(0, 5);
  }

  // Route-specific context — non-fatal if unavailable
  let tokenData: unknown = {};
  let walletScan: unknown = {};
  let contractAnalysis: unknown = {};

  try {
    const routeCtx = await routeCommand(prompt, chain, origin);
    if (routeCtx?.tokenData  != null) tokenData       = routeCtx.tokenData;
    if (routeCtx?.walletScan != null) walletScan       = routeCtx.walletScan;
    if (routeCtx?.analysis   != null) contractAnalysis = routeCtx.analysis;
    if (Array.isArray(routeCtx?.trending) && (routeCtx.trending as unknown[]).length > 0)
      trending = routeCtx.trending as unknown[];
    if (Array.isArray(routeCtx?.gtPools) && (routeCtx.gtPools as unknown[]).length > 0)
      gtPools = (routeCtx.gtPools as unknown[]).slice(0, 5);
  } catch (err) {
    console.error("[Clark router]", err instanceof Error ? err.message : err);
  }

  const context: ClarkContext = {
    trending,
    gtPools,
    tokenData:  tokenData       ?? {},
    walletScan: walletScan      ?? {},
    analysis:   contractAnalysis ?? {},
  };

  if (replyMode !== "analysis" && replyMode !== "feature_context") {
    return { feature: "clark-ai", chain, mode: "unknown", analysis: buildGeneralMarketNoContextReply(prompt) };
  }

  const analysis = await callAnthropic(prompt, context);
  return { feature: "clark-ai", chain, mode: replyMode, analysis };
}

// ---------- Main handler ----------

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ClarkRequestBody;
    if (body.message && !body.prompt) body.prompt = body.message;
    // Derive origin from the incoming request — always correct for any deployment
    const origin = req.nextUrl.origin;

    if (!body.feature) {
      return NextResponse.json(
        { error: "Missing 'feature' in request body" },
        { status: 400 }
      );
    }

    let result: unknown;

    switch (body.feature) {
      case "token-scanner":
        result = await handleTokenScanner(body, origin);
        break;
      case "wallet-scanner":
        result = await handleWalletScanner(body);
        break;
      case "dev-wallet-detector":
        result = await handleDevWalletDetector(body);
        break;
      case "liquidity-safety":
        result = await handleLiquiditySafety(body, origin);
        break;
      case "whale-alerts":
        result = await handleWhaleAlerts(body);
        break;
      case "pump-alerts":
        result = await handlePumpAlerts(body, origin);
        break;
      case "scan-token":
        result = await handleScanToken(body, origin);
        break;
      case "base-radar":
        result = await handleBaseRadar(body, origin);
        break;
      case "clark-ai":
        result = await handleClarkAI(body, origin);
        break;
      default:
        return NextResponse.json(
          { error: `Unknown feature: ${body.feature}` },
          { status: 400 }
        );
    }

    return NextResponse.json(
      { ok: true, feature: body.feature, data: normalizeApiReplyShape(result, body) },
      { status: 200 }
    );
  } catch (err: unknown) {
    console.error("[Clark]", err instanceof Error ? err.message : err);
    const safeMsg = "Clark could not fetch that data right now. Try again in a moment or open the matching scanner.";
    return NextResponse.json({
      ok: true,
      feature: "clark-ai",
      data: { reply: safeMsg, response: safeMsg, analysis: safeMsg, verdict: "SCAN DEEPER", source: "fallback" },
    }, { status: 200 });
  }
}

function normalizeApiReplyShape(result: unknown, body: ClarkRequestBody) {
  const obj = (result && typeof result === "object") ? { ...(result as Record<string, unknown>) } : {};
  const reply =
    (typeof obj.reply === "string" ? obj.reply : null) ??
    (typeof obj.analysis === "string" ? obj.analysis : null) ??
    (typeof obj.response === "string" ? obj.response : null) ??
    (typeof obj.message === "string" ? obj.message : null) ??
    (typeof obj.text === "string" ? obj.text : null) ??
    (typeof result === "string" ? result : "");

  const verdictMatch = reply.match(/\bVerdict:\s*(AVOID|WATCH|SCAN DEEPER|TRUSTWORTHY|UNKNOWN)\b/i);
  const confMatch = reply.match(/\bConfidence:\s*(Low|Medium|High)\b/i);
  const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : null;
  const confidence = confMatch ? `${confMatch[1].charAt(0).toUpperCase()}${confMatch[1].slice(1).toLowerCase()}` : null;
  const source: ClarkSource = verdict
    ? (body.feature === "clark-ai" ? "feature_context" : "tool_call")
    : (isCasualAssistantPrompt(body.prompt ?? "") ? "casual" : "fallback");

  return {
    ...obj,
    reply,
    response: reply,
    message: reply,
    text: reply,
    verdict,
    confidence,
    mode: (typeof obj.mode === "string" ? obj.mode : null) ?? body.mode ?? body.feature,
    source,
  };
}
