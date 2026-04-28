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
  | "clark-ai"
  | "scan-token";

interface ClarkRequestBody {
  feature: ClarkFeature;
  message?: string;
  mode?: string;
  uiModeHint?: string;
  context?: unknown;
  history?: Array<{ role?: string; content?: string }>;
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
  | "wallet_analysis"
  | "dev_wallet"
  | "liquidity_safety"
  | "base_radar"
  | "whale_alert"
  | "feature_context"
  | "unknown";

type ClarkPlannerIntent =
  | "casual"
  | "help"
  | "educational"
  | "strategy"
  | "market"
  | "token_analysis"
  | "token_full_report_request"
  | "wallet_balance"
  | "wallet_quality"
  | "wallet_compare_request"
  | "dev_wallet"
  | "liquidity_safety"
  | "feature_context"
  | "unknown";

type ClarkToolName =
  | "market_get_base_movers"
  | "token_resolve"
  | "token_scan"
  | "wallet_get_snapshot"
  | "wallet_analyze_quality"
  | "dev_wallet_analyze"
  | "liquidity_analyze";

type ClarkPlanTool = {
  name: ClarkToolName;
  args: Record<string, unknown>;
  required: boolean;
};

type ClarkToolPlan = {
  intent: ClarkPlannerIntent;
  tools: ClarkPlanTool[];
  depth: "short" | "normal" | "deep";
  followupContext: {
    address: string | null;
    lastTokenAddress: string | null;
    lastWalletAddress: string | null;
    marketFollowup: boolean;
    selectedOptionIndex: number | null;
  };
};

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
    /(?:full report on|complete report on|deep scan|full analysis of|full analysis on|run all checks on)\s+([a-z0-9._-]{2,32})(?:\s+on\s+base)?\b/i,
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

function detectIntent(prompt: string): { intent: ClarkIntent; address: string | null } {
  const t = prompt.trim().toLowerCase();
  const address = extractAddress(prompt);

  const WALLET_INTENT_RE = /\b(wallet|balance|balances|holdings?|portfolio|hold\b|copy[\s-]?trad(?:e|ing)?|smart\s+money)\b/i;
  const MARKET_INTENT_RE = /what'?s pumping on base|what'?s moving on base|new base tokens|show me hot tokens|what should i watch|what'?s trending|trending|\b(pump(?:ing)?|movers?|gainers?|runners?|new\s+launches?|new\s+tokens?)\b/i;

  if (/(<token_data>|<wallet_scan>|<analysis>|feature context|ask clark)/i.test(prompt)) {
    return { intent: "feature_context", address };
  }
  if (/^(hi|hey|hello|yo|gm|sup)\b|what can you do|help|who are you|what is chainlens/i.test(t)) {
    return { intent: "casual_help", address };
  }
  if (/what is liquidity risk|explain liquidity risk|what is a dev wallet|what does holder concentration mean|why is lp lock important|what is holder concentration|what is lp lock|what is slippage|explain slippage/i.test(t)) {
    return { intent: "educational", address };
  }
  if (/how do i scan|where do i check deployer|how do i track a wallet|how do i use this|which feature|where should i go/i.test(t)) {
    return { intent: "routing_help", address };
  }
  if (/base radar/.test(t)) {
    return { intent: "base_radar", address };
  }
  // Wallet balance/holdings takes priority when address is present
  if (address && WALLET_INTENT_RE.test(t)) {
    return { intent: "wallet_analysis", address };
  }
  if (MARKET_INTENT_RE.test(t)) {
    return { intent: "general_market", address };
  }
  if (/whale|smart money/i.test(t)) {
    if (address) return { intent: "whale_alert", address };
    return { intent: "unknown", address };
  }
  if (/dev wallet|deployer|who deployed/i.test(t)) {
    return { intent: "dev_wallet", address };
  }
  if (/liquidity|lp safe|liquidity risk/i.test(t)) {
    return { intent: "liquidity_safety", address };
  }
  if (/wallet/.test(t)) {
    return { intent: "wallet_analysis", address };
  }
  if (/token|contract|scan|analyz|safe|risk|check|verdict/i.test(t)) {
    if (!address) {
      const tokenQuery = extractTokenLookupQuery(prompt);
      if (tokenQuery) return { intent: "token_name_lookup", address: null };
    }
    return { intent: "analysis", address };
  }
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
    if ((intent === "analysis" || intent === "token_analysis" || intent === "wallet_analysis" || intent === "dev_wallet" || intent === "liquidity_safety") && address) {
      return "analysis";
    }
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
  if ((intent === "token_analysis" || intent === "wallet_analysis" || intent === "dev_wallet" || intent === "liquidity_safety" || intent === "whale_alert") && address) {
    return "analysis";
  }
  if (/scan|analyz|check|verdict|risk/.test(t) && address) return "analysis";
  return "unknown";
}

function getHistoryMessages(history: ClarkRequestBody["history"]): string[] {
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => (typeof h?.content === "string" ? h.content : ""))
    .filter(Boolean)
    .slice(-12);
}

function findLastAddressInTextList(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const a = extractAddress(lines[i] ?? "");
    if (a) return a;
  }
  return null;
}

function pickAddressBySelection(historyLines: string[], selectedIndex: number): string | null {
  if (selectedIndex < 1) return null;
  for (let i = historyLines.length - 1; i >= 0; i--) {
    const line = historyLines[i] ?? "";
    const regex = new RegExp(`(?:^|\\n)\\s*${selectedIndex}\\.\\s+[^\\n]*?(0x[a-fA-F0-9]{40})`, "m");
    const m = line.match(regex);
    if (m?.[1]) return m[1];
  }
  return null;
}

function isMarketFollowupPrompt(prompt: string): boolean {
  const t = prompt.trim().toLowerCase();
  return /^(more|give me more|other tokens|other ones|next|show more)$/i.test(t) || /\bgive me other tokens\b/i.test(t);
}

function classifyPlannerIntent(prompt: string, address: string | null): ClarkPlannerIntent {
  const t = prompt.trim().toLowerCase();
  if (/^(hi|hey|hello|yo|gm|sup)\b/.test(t)) return "casual";
  if (/what can you do|help|who are you/.test(t)) return "help";
  if (/what is liquidity risk|explain liquidity risk|what is a dev wallet|holder concentration|lp lock|what is slippage|explain slippage/i.test(t)) return "educational";
  if (/what should i watch|watch today|framework|strategy/i.test(t)) return "strategy";
  if (/full report|complete report|deep scan|full analysis|run all checks|scan this properly|is this token safe|give me the full report/.test(t)) return "token_full_report_request";
  if (/compare .*wallet/.test(t)) return "wallet_compare_request";
  if (/dev wallet|deployer|who deployed/.test(t)) return "dev_wallet";
  if (/liquidity|lp safe|liquidity risk/.test(t)) return "liquidity_safety";
  if (/balance|holdings?|portfolio|what does .*wallet hold|tell me the balance/.test(t) && address) return "wallet_balance";
  if (/(good wallet|worth following|copy[\s-]?trad|smart money|is it safe|wallet quality)/.test(t) && (address || /it\b/.test(t))) return "wallet_quality";
  if (/pumping on base|moving on base|trending|movers|gainers|runners|more/.test(t)) return "market";
  if (/scan|token|contract|safe|risk|brett|0x[a-fA-F0-9]{40}/.test(t)) return "token_analysis";
  if (/\[mode\s*:|feature context|<token_data>|<wallet_scan>/i.test(prompt)) return "feature_context";
  return "unknown";
}

function buildClarkToolPlan(input: {
  message: string;
  mode?: string;
  uiModeHint?: string;
  context?: unknown;
  history?: ClarkRequestBody["history"];
}): ClarkToolPlan {
  const message = input.message ?? "";
  const historyLines = getHistoryMessages(input.history);
  const trimmed = message.trim().toLowerCase();
  const selectedOptionIndex =
    (/^\s*([1-9])\s*$/.test(trimmed) ? Number(trimmed) : null) ??
    (/first one|that one|this one/.test(trimmed) ? 1 : null) ??
    (/second one/.test(trimmed) ? 2 : null) ??
    (/third one/.test(trimmed) ? 3 : null);
  const directAddress = extractAddress(message);
  const selectedAddress = selectedOptionIndex ? pickAddressBySelection(historyLines, selectedOptionIndex) : null;
  const inferredAddress = directAddress ?? selectedAddress;
  const lastHistoryAddress = findLastAddressInTextList(historyLines);
  const marketFollowup = isMarketFollowupPrompt(message);
  const explicitFollowupRef = /\b(this token|this wallet|it|this one|that one|first one|second one|third one)\b/i.test(message);
  let plannerIntent = classifyPlannerIntent(message, inferredAddress);
  if (selectedAddress && (plannerIntent === "unknown" || plannerIntent === "feature_context")) plannerIntent = "token_analysis";
  const reportFollowupIntent = plannerIntent === "token_full_report_request" || plannerIntent === "dev_wallet" || plannerIntent === "liquidity_safety";
  const allowHistoryEntity = Boolean(selectedOptionIndex || marketFollowup || explicitFollowupRef || reportFollowupIntent);
  const fallbackAddress = inferredAddress ?? (allowHistoryEntity ? lastHistoryAddress : null);
  if (/^it\b/i.test(trimmed) && fallbackAddress) plannerIntent = plannerIntent === "unknown" ? "token_analysis" : plannerIntent;
  if (/^is it safe\??$/i.test(trimmed) && fallbackAddress) {
    const historyText = historyLines.join("\n").toLowerCase();
    if (/contract|token|scan|full report|asset:/i.test(historyText) && !/wallet:/i.test(historyText)) {
      plannerIntent = "token_full_report_request";
    }
  }
  const depth: ClarkToolPlan["depth"] =
    /\b(deep|detailed|full detail|full breakdown)\b/i.test(message) ? "deep" :
    /\b(quick|short|brief)\b/i.test(message) ? "short" : "normal";

  const followupContext = {
    address: fallbackAddress ?? null,
    lastTokenAddress: fallbackAddress ?? null,
    lastWalletAddress: fallbackAddress ?? null,
    marketFollowup,
    selectedOptionIndex,
  };

  const tools: ClarkPlanTool[] = [];
  const tokenLookup = extractTokenLookupQuery(message);
  const looksWallet = /\b(wallet|balance|portfolio|copy[\s-]?trade|smart money)\b/i.test(message);

  switch (plannerIntent) {
    case "market":
    case "strategy":
      tools.push({ name: "market_get_base_movers", args: { page: 1, perPage: 20 }, required: false });
      break;
    case "wallet_balance":
      if (fallbackAddress) tools.push({ name: "wallet_get_snapshot", args: { address: fallbackAddress }, required: true });
      break;
    case "wallet_quality":
      if (fallbackAddress) {
        tools.push({ name: "wallet_get_snapshot", args: { address: fallbackAddress }, required: true });
        tools.push({ name: "wallet_analyze_quality", args: { address: fallbackAddress }, required: false });
      }
      break;
    case "dev_wallet":
      if (fallbackAddress) tools.push({ name: "dev_wallet_analyze", args: { address: fallbackAddress }, required: true });
      break;
    case "liquidity_safety":
      if (fallbackAddress) tools.push({ name: "liquidity_analyze", args: { address: fallbackAddress }, required: true });
      break;
    case "token_full_report_request":
      if (!fallbackAddress && tokenLookup) {
        tools.push({ name: "token_resolve", args: { query: tokenLookup }, required: true });
      }
      tools.push({ name: "token_scan", args: { address: fallbackAddress ?? "" }, required: false });
      tools.push({ name: "liquidity_analyze", args: { address: fallbackAddress ?? "" }, required: false });
      tools.push({ name: "dev_wallet_analyze", args: { address: fallbackAddress ?? "" }, required: false });
      tools.push({ name: "market_get_base_movers", args: { page: 1, perPage: 20 }, required: false });
      break;
    case "token_analysis":
      if (!fallbackAddress && tokenLookup) {
        tools.push({ name: "token_resolve", args: { query: tokenLookup }, required: true });
      } else if (fallbackAddress && looksWallet) {
        tools.push({ name: "wallet_get_snapshot", args: { address: fallbackAddress }, required: false });
      } else if (fallbackAddress) {
        tools.push({ name: "token_scan", args: { address: fallbackAddress }, required: true });
      }
      break;
    default:
      break;
  }

  return {
    intent: plannerIntent,
    tools,
    depth,
    followupContext,
  };
}

function buildEducationalReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/liquidity risk/.test(t)) return "Liquidity risk is the chance you can’t exit cleanly—usually from low depth, unlocked LP, or concentrated LP ownership.";
  if (/slippage/.test(t)) return "Slippage is the price impact between quoted and executed price. Thin liquidity and large orders increase slippage and worsen entries/exits.";
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

function buildGeneralMarketNoContextReply(): string {
  return "I couldn’t pull live Base Radar data right now. Paste a contract and I’ll scan it directly.";
}

function formatUsdShort(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function buildGTMarketBriefing(pools: unknown[]): string {
  type GTPool = {
    attributes?: {
      name?: string;
      reserve_in_usd?: string | number;
      volume_usd?: { h24?: string | number };
      price_change_percentage?: { h24?: string | number };
    };
  };

  const valid = (pools as GTPool[]).filter(p => {
    const a = p.attributes ?? {};
    return a.name && parseFloat(String(a.reserve_in_usd ?? 0)) > 5000;
  });

  const sorted = [...valid].sort((a, b) => {
    const ca = Number(a.attributes?.price_change_percentage?.h24 ?? 0);
    const cb = Number(b.attributes?.price_change_percentage?.h24 ?? 0);
    return cb - ca;
  });

  const picks = sorted.slice(0, 5).map(p => {
    const a = p.attributes!;
    const token = String(a.name ?? "").split(" / ")[0]?.trim() ?? "Unknown";
    const change = Number(a.price_change_percentage?.h24 ?? 0);
    const changeStr = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
    const vol = formatUsdShort(parseFloat(String(a.volume_usd?.h24 ?? 0)));
    const liq = parseFloat(String(a.reserve_in_usd ?? 0));
    const liqStr = formatUsdShort(liq);
    const liqNote = liq < 50_000 ? " — thin liquidity" : "";
    return `- ${token}: 24h ${changeStr}, vol ${vol}, liq ${liqStr}${liqNote}`;
  });

  if (picks.length === 0) {
    return "I couldn't pull live Base market data right now. Paste a contract and I'll scan it directly.";
  }

  return (
    "Base Market:\n" +
    "Top movers on Base right now.\n\n" +
    "Moving now:\n" +
    picks.join("\n") +
    "\n\nClark’s read:\n" +
    "Momentum is active, but thin-liquidity names can reverse fast.\n" +
    "\n\nBest next step:\n" +
    "Scan the strongest token before touching it. Market data alone does not confirm safety."
  );
}

function buildBaseRadarBriefing(tokens: unknown[]): string {
  const picks = tokens
    .slice(0, 3)
    .map((t) => {
      const token = t as Record<string, unknown>;
      const symbol = String(token.symbol ?? token.name ?? "TOKEN");
      const liq = formatUsdShort(typeof token.liquidityUsd === "number" ? token.liquidityUsd : null);
      const vol = formatUsdShort(typeof token.volume24h === "number" ? token.volume24h : null);
      const risk = String(token.riskLevel ?? "UNKNOWN");
      return `- ${symbol}: Liquidity ${liq}, 24h volume ${vol}, risk ${risk}.`;
    });
  if (picks.length === 0) return "Base Radar is live, but no strong movers surfaced from the current feed. Try refreshing or paste a contract.";
  return `Base Radar:\nLive Base feed pulled successfully.\n\nMoving now:\n${picks.join("\n")}\n\nBest next step:\nScan the strongest one before touching it.`;
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

function enforceWalletAssetLabel(text: string, address: string): string {
  const walletLine = `Asset: Wallet ${shortAddress(address)}`;
  if (/^Asset:/im.test(text)) {
    return text.replace(/^Asset:.*$/im, walletLine);
  }
  return `${walletLine}\n${text.trim()}`;
}

function buildWalletQualityVerdict(snapshot: NonNullable<ClarkToolEvidence["walletSnapshot"]>, address: string, prompt?: string): string {
  const top = snapshot.holdingsTop10;
  const topValue = top.reduce((s, h) => s + h.value, 0);
  const top1 = top[0]?.value ?? 0;
  const concentration = topValue > 0 ? (top1 / topValue) * 100 : 0;
  const breadth = snapshot.tokenCount;
  const stablePct = snapshot.totalValue > 0 ? (snapshot.stablecoinExposureUsd / snapshot.totalValue) * 100 : 0;
  const activity = snapshot.txCount ?? 0;

  let verdict: "WATCH" | "SCAN DEEPER" | "AVOID" | "TRUSTWORTHY" = "WATCH";
  let confidence: "Low" | "Medium" | "High" = "Medium";

  if (snapshot.totalValue < 500 && breadth < 5) {
    verdict = "SCAN DEEPER";
    confidence = "Low";
  } else if (concentration >= 80 && snapshot.totalValue > 10_000) {
    verdict = "WATCH";
    confidence = "Medium";
  } else if (snapshot.totalValue >= 25_000 && breadth >= 8 && stablePct >= 10 && activity >= 20) {
    verdict = "WATCH";
    confidence = "High";
  }

  const profile =
    snapshot.totalValue >= 25_000 && activity >= 20 ? "tracker-worthy whale/watch wallet" :
    breadth >= 20 ? "broad rotation/farmer-style wallet" :
    "lower-signal concentrated wallet";

  const signals = [
    `Portfolio value: ${formatUsdShort(snapshot.totalValue)}`,
    `Concentration: top holding is ${concentration.toFixed(1)}% of visible top holdings`,
    `Stablecoin exposure: ${formatUsdShort(snapshot.stablecoinExposureUsd)} (${stablePct.toFixed(1)}%)`,
  ];
  const risks = [
    snapshot.dustOrUnpricedHidden ? "Dust or unpriced holdings exist and are hidden in this summary" : "Major holdings are mostly priced",
    breadth < 5 ? "Low breadth increases single-asset dependency risk" : "Breadth is acceptable for watchlist monitoring",
    activity < 10 ? "Low observed activity can indicate low signal quality" : "Observed activity is sufficient for behavior tracking",
  ];
  const read = `This looks like a ${profile}. I can rate it as a watch wallet, not proven smart money, unless timing/PnL evidence is added.`;
  const copyTradePrompt = /\bcopy[\s-]?trade\b/i.test(prompt ?? "");
  const nextAction = copyTradePrompt
    ? "Do not copy from balance alone. Track entries/exits, sizing, and repeat behavior first."
    : "Track this wallet’s future entries/exits before treating it as a lead wallet.";

  return enforceWalletAssetLabel(
    buildStructuredVerdict(
      verdict,
      confidence,
      read,
      signals,
      risks,
      nextAction
    ),
    address
  );
}

function formatInt(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return value.toLocaleString("en-US");
}

function normalizeWalletSnapshotEvidence(rawWallet: Record<string, unknown>, address: string): NonNullable<ClarkToolEvidence["walletSnapshot"]> {
  const holdings = Array.isArray(rawWallet.holdings) ? (rawWallet.holdings as Array<Record<string, unknown>>) : [];
  const totalValue = typeof rawWallet.totalValue === "number" ? rawWallet.totalValue : 0;
  const ranked = [...holdings]
    .map((h) => ({
      symbol: String(h.symbol ?? "?"),
      value: typeof h.value === "number" ? h.value : 0,
      balance: typeof h.balance === "number" ? h.balance : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const topHoldings = ranked.filter((h) => h.value > 1 && h.symbol !== "?").slice(0, 8);
  const hiddenHoldingsCount = Math.max(ranked.length - topHoldings.length, 0);
  const dustOrUnpricedHidden = ranked.some((h) => h.value <= 1 || h.symbol === "?");
  const stablecoinExposureUsd = ranked
    .filter((h) => /^(USDC|USDT|DAI|LUSD|USDE|USDBC|EURC)$/i.test(h.symbol))
    .reduce((sum, h) => sum + h.value, 0);
  const hasHoldings = ranked.length > 0;
  const hasValue = totalValue > 0;
  const txCount = typeof rawWallet.txCount === "number" ? rawWallet.txCount : null;
  const walletAgeDays = typeof rawWallet.walletAgeDays === "number" ? rawWallet.walletAgeDays : null;
  const hasTxMeta = txCount !== null || walletAgeDays !== null;
  const dataQuality: "Complete" | "Partial" | "Limited" = hasHoldings && hasValue && hasTxMeta ? "Complete" : (hasHoldings || hasValue ? "Partial" : "Limited");

  return {
    ok: true,
    address,
    totalValue,
    holdingsTop10: topHoldings,
    hiddenHoldingsCount,
    dustOrUnpricedHidden,
    stablecoinExposureUsd,
    tokenCount: ranked.length,
    txCount,
    walletAgeDays,
    dataQuality,
  };
}

function formatWalletBalanceSummary(snapshot: NonNullable<ClarkToolEvidence["walletSnapshot"]>): string {
  const top = snapshot.holdingsTop10.slice(0, 8).map((h) => `- ${h.symbol}: ${formatUsdShort(h.value)}`);
  const notes = [
    `- Dust/unpriced holdings hidden: ${snapshot.hiddenHoldingsCount}`,
    "- Wallet balances may be partial for unsupported assets.",
  ];
  if (snapshot.holdingsTop10.length < 3) notes.push("- Fewer than 3 priced holdings were available in this scan.");

  return [
    "Wallet:",
    shortAddress(snapshot.address),
    "",
    "Summary:",
    `- Portfolio value: ${formatUsdShort(snapshot.totalValue)}`,
    `- Wallet age: ${snapshot.walletAgeDays != null ? `${formatInt(snapshot.walletAgeDays)} days` : "n/a"}`,
    `- Tx count: ${formatInt(snapshot.txCount)}`,
    `- Token count: ${formatInt(snapshot.tokenCount)}`,
    "",
    "Top holdings:",
    ...(top.length > 0 ? top : ["- No priced holdings above $1 found"]),
    "",
    "Data note:",
    ...notes,
  ].join("\n");
}

function missingAddressReply(intent: ClarkIntent): string {
  if (intent === "wallet_analysis" || intent === "whale_alert") {
    return "I can run that, but I need a wallet address first. Paste a full 0x wallet and I’ll analyze the available data.";
  }
  return "I can run that, but I need a token contract first. Paste a full 0x contract and I’ll analyze the available data.";
}

async function callInternalApi(origin: string, path: string, payload: Record<string, unknown>) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
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
  const text = sanitizeFreeform(raw, { allowProviderNames: false }).replace(/\r/g, "").trim();
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

  const MARKET_KEYWORDS = /\b(pumping|pump(?:ing)?|hot\b|movers?|gainers?|runners?|new\s+launches?|new\s+tokens?)\b/;
  const WALLET_KEYWORDS = /\b(wallet|balance|balances|holdings?|portfolio|hold\b|copy[\s-]?trade?|smart\s+money)\b/;

  if (t.includes("base radar") || t.includes("trending") || t.includes("what's hot") || MARKET_KEYWORDS.test(t)) {
    return scanBaseRadarData(origin);
  }
  if ((t.includes("scan wallet") || t.includes("wallet scan") || WALLET_KEYWORDS.test(t)) && address) {
    return scanWalletData(address, chain);
  }
  if ((t.includes("dev wallet") || t.includes("dev wallets")) && address) {
    return scanDevWalletData(address, chain);
  }
  if (t.includes("liquidity") && address) {
    return scanLiquidityData(address, chain, origin);
  }
  if (t.includes("whale") && address) {
    return scanWhaleData(address, chain);
  }
  if (t.includes("pump") && address) {
    return scanPumpData(address, chain, origin);
  }
  if (address) {
    return scanTokenData(address, chain, origin);
  }

  return null;
}

type ClarkToolEvidence = {
  market?: {
    ok: boolean;
    candidates: Array<{ token: string; change24h: number; volume24h: number; liquidity: number }>;
    source: "gt_proxy";
    errorSafeMessage?: string;
  };
  tokenResolve?: {
    ok: boolean;
    query: string;
    matches: Array<{ symbol: string; contract: string }>;
    selected?: { symbol: string; contract: string } | null;
    errorSafeMessage?: string;
  };
  tokenScan?: {
    ok: boolean;
    token: { name: string; symbol: string; address: string } | null;
    market: { price: number | null; change24h: number | null; volume24h: number | null; liquidity: number | null };
    security: { honeypot: boolean | null; buyTax: number | null; sellTax: number | null };
    liquidity: { pools: number; topPoolLiquidity: number | null };
    warnings: string[];
    errorSafeMessage?: string;
  };
  walletSnapshot?: {
    ok: boolean;
    address: string;
    totalValue: number;
    holdingsTop10: Array<{ symbol: string; value: number; balance: number }>;
    hiddenHoldingsCount: number;
    dustOrUnpricedHidden: boolean;
    stablecoinExposureUsd: number;
    tokenCount: number;
    txCount: number | null;
    walletAgeDays: number | null;
    dataQuality: "Complete" | "Partial" | "Limited";
    errorSafeMessage?: string;
  };
  walletQuality?: {
    ok: boolean;
    analysis: string;
    errorSafeMessage?: string;
  };
  devWallet?: {
    ok: boolean;
    deployerAddress: string | null;
    linkedWallets: number;
    confidence: "Low" | "Medium" | "High";
    verdict: "WATCH" | "AVOID" | "TRUSTWORTHY" | "UNKNOWN" | "SCAN DEEPER";
    warnings: string[];
    errorSafeMessage?: string;
  };
  liquidity?: {
    ok: boolean;
    token: { name: string; symbol: string; address: string } | null;
    liquidityUsd: number | null;
    riskTier: string | null;
    stabilityScore: number | null;
    warnings: string[];
    errorSafeMessage?: string;
  };
};

async function executeClarkToolPlan(input: {
  plan: ClarkToolPlan;
  origin: string;
  prompt: string;
  chain: SupportedChain;
}): Promise<{ evidence: ClarkToolEvidence; toolsUsed: ClarkToolName[]; resolvedAddress: string | null }> {
  const evidence: ClarkToolEvidence = {};
  const toolsUsed: ClarkToolName[] = [];
  let resolvedAddress: string | null = input.plan.followupContext.address;

  for (const tool of input.plan.tools) {
    toolsUsed.push(tool.name);
    try {
      if (tool.name === "market_get_base_movers") {
        const gtRaw = await callGeckoTerminal("base", input.origin).catch(() => null);
        const allPools: Array<Record<string, unknown>> = Array.isArray((gtRaw as { data?: unknown[] })?.data)
          ? ((gtRaw as { data: unknown[] }).data as Array<Record<string, unknown>>)
          : [];
        const candidates = allPools
          .map((p) => {
            const a = (p.attributes ?? {}) as Record<string, unknown>;
            return {
              token: String(a.name ?? "Unknown").split(" / ")[0]?.trim() ?? "Unknown",
              change24h: Number((a.price_change_percentage as Record<string, unknown> | undefined)?.h24 ?? 0),
              volume24h: parseFloat(String((a.volume_usd as Record<string, unknown> | undefined)?.h24 ?? 0)),
              liquidity: parseFloat(String(a.reserve_in_usd ?? 0)),
            };
          })
          .filter((x) => x.liquidity > 5000)
          .sort((a, b) => b.change24h - a.change24h)
          .slice(0, 8);
        evidence.market = { ok: candidates.length > 0, candidates, source: "gt_proxy", errorSafeMessage: candidates.length ? undefined : "Market feed is temporarily limited." };
        continue;
      }

      if (tool.name === "token_resolve") {
        const query = String(tool.args.query ?? "").trim();
        const matches = query ? await searchBaseTokenCandidates(query) : [];
        evidence.tokenResolve = {
          ok: matches.length > 0,
          query,
          matches: matches.map((m) => ({ symbol: m.symbol, contract: m.contract })),
          selected: matches.length === 1 ? { symbol: matches[0].symbol, contract: matches[0].contract } : null,
          errorSafeMessage: matches.length ? undefined : "I couldn’t find a clear Base token match yet.",
        };
        if (matches.length === 1) resolvedAddress = matches[0].contract;
        continue;
      }

      if (tool.name === "token_scan") {
        const addrArg = String(tool.args.address ?? "").trim();
        const addr = addrArg || String(resolvedAddress ?? "").trim();
        const tokenData = addr && /^0x[a-fA-F0-9]{40}$/.test(addr) ? await callScanToken(addr, "contract", input.origin) : null;
        const t = (tokenData ?? {}) as Record<string, unknown>;
        const g = (t.goplus ?? {}) as Record<string, unknown>;
        const hp = (t.honeypot ?? {}) as Record<string, unknown>;
        const warnings: string[] = [];
        if (!tokenData) warnings.push("Token scan data is limited right now.");
        evidence.tokenScan = {
          ok: Boolean(tokenData),
          token: tokenData ? { name: String(t.name ?? "Unknown"), symbol: String(t.symbol ?? "?"), address: String(t.contract ?? addr) } : null,
          market: {
            price: typeof t.price === "number" ? t.price : null,
            change24h: typeof t.priceChange24h === "number" ? t.priceChange24h : null,
            volume24h: typeof t.volume24h === "number" ? t.volume24h : null,
            liquidity: typeof t.liquidity === "number" ? t.liquidity : null,
          },
          security: {
            honeypot: typeof hp.isHoneypot === "boolean" ? hp.isHoneypot : (g.is_honeypot != null ? String(g.is_honeypot) === "1" : null),
            buyTax: typeof hp.buyTax === "number" ? hp.buyTax : (g.buy_tax != null ? Number(g.buy_tax) : null),
            sellTax: typeof hp.sellTax === "number" ? hp.sellTax : (g.sell_tax != null ? Number(g.sell_tax) : null),
          },
          liquidity: {
            pools: Array.isArray(t.pools) ? t.pools.length : 0,
            topPoolLiquidity: typeof t.liquidity === "number" ? t.liquidity : null,
          },
          warnings,
          errorSafeMessage: tokenData ? undefined : "I couldn’t complete a token scan right now.",
        };
        resolvedAddress = evidence.tokenScan.token?.address ?? resolvedAddress;
        continue;
      }

      if (tool.name === "wallet_get_snapshot") {
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const walletRes = await callInternalApi(input.origin, "/api/wallet", { address });
        const w = (walletRes.json ?? {}) as Record<string, unknown>;
        const normalized = normalizeWalletSnapshotEvidence(w, address);
        evidence.walletSnapshot = {
          ...normalized,
          ok: walletRes.ok && !w.error,
          errorSafeMessage: walletRes.ok ? undefined : "Wallet data is temporarily unavailable.",
        };
        resolvedAddress = address;
        continue;
      }

      if (tool.name === "wallet_analyze_quality") {
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const context: ClarkContext = { walletScan: evidence.walletSnapshot ?? {} };
        let analysis = "";
        try {
          analysis = await callAnthropic(`Analyze wallet ${address}. Use the standard Clark verdict format and include uncertainty if smart-money proof is missing.`, context);
        } catch {
          analysis = buildWalletAnalysisFallback(evidence.walletSnapshot ?? {}, address);
        }
        evidence.walletQuality = { ok: true, analysis };
        continue;
      }

      if (tool.name === "dev_wallet_analyze") {
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const devWalletRes = await callInternalApi(input.origin, "/api/dev-wallet", { contractAddress: address });
        const d = (devWalletRes.json ?? {}) as Record<string, unknown>;
        const verdictRaw = ((d.clarkVerdict as Record<string, unknown> | null)?.label ?? "UNKNOWN") as string;
        const confRaw = ((d.clarkVerdict as Record<string, unknown> | null)?.confidence ?? "low") as string;
        const normalizedVerdict = (() => {
          const v = verdictRaw.toUpperCase();
          if (v === "HIGH") return "AVOID";
          if (v === "LOW") return "TRUSTWORTHY";
          if (v === "MEDIUM") return "WATCH";
          if (v === "AVOID" || v === "WATCH" || v === "UNKNOWN" || v === "SCAN DEEPER" || v === "TRUSTWORTHY") return v;
          return "UNKNOWN";
        })() as "AVOID" | "WATCH" | "UNKNOWN" | "SCAN DEEPER" | "TRUSTWORTHY";
        evidence.devWallet = {
          ok: devWalletRes.ok,
          deployerAddress: typeof d.deployerAddress === "string" ? d.deployerAddress : null,
          linkedWallets: Array.isArray(d.linkedWallets) ? d.linkedWallets.length : 0,
          confidence: confRaw.toLowerCase() === "high" ? "High" : confRaw.toLowerCase() === "medium" ? "Medium" : "Low",
          verdict: normalizedVerdict,
          warnings: Array.isArray(d.warnings) ? d.warnings.map(String).slice(0, 5) : [],
          errorSafeMessage: devWalletRes.ok ? undefined : "Dev wallet scan is not available right now.",
        };
        continue;
      }

      if (tool.name === "liquidity_analyze") {
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const liqRes = await callInternalApi(input.origin, "/api/liquidity-safety", { contract: address });
        const l = (((liqRes.json as Record<string, unknown>)?.data ?? {}) as Record<string, unknown>);
        evidence.liquidity = {
          ok: liqRes.ok && Boolean((liqRes.json as Record<string, unknown>)?.ok),
          token: liqRes.ok ? { name: String(l.name ?? "Unknown"), symbol: String(l.symbol ?? "?"), address: String(l.contract ?? address) } : null,
          liquidityUsd: typeof l.lp_total_liquidity_usd === "number" ? l.lp_total_liquidity_usd : null,
          riskTier: typeof l.lp_risk_tier === "string" ? l.lp_risk_tier : null,
          stabilityScore: typeof l.lp_stability_score === "number" ? l.lp_stability_score : null,
          warnings: liqRes.ok ? [] : ["Liquidity data is currently limited."],
          errorSafeMessage: liqRes.ok ? undefined : "Liquidity scan is temporarily unavailable.",
        };
        continue;
      }
    } catch (err) {
      console.error("[Clark tools]", tool.name, err instanceof Error ? err.message : err);
    }
  }

  return { evidence, toolsUsed, resolvedAddress };
}

type ClarkFullReportEvidence = {
  token: {
    symbol: string | null;
    name: string | null;
    address: string | null;
    chain: "base";
  };
  market: {
    price: number | null;
    change24h: number | null;
    volume24h: number | null;
    liquidity: number | null;
    fdv: number | null;
    poolAge: string | null;
    marketSourceAvailable: boolean;
  };
  contract: {
    openSource: boolean | null;
    proxy: boolean | null;
    mintable: boolean | null;
    buyTax: number | null;
    sellTax: number | null;
    honeypot: boolean | null;
    warnings: string[];
  };
  liquidity: {
    liquidityUsd: number | null;
    lpLocked: boolean | null;
    lpOwner: string | null;
    lpConcentration: number | null;
    volumeToLiquidity: number | null;
    warnings: string[];
  };
  devWallet: {
    likelyDeployer: string | null;
    linkedWallets: number | null;
    suspiciousPatterns: string[];
    confidence: "Low" | "Medium" | "High" | null;
    warnings: string[];
  };
  missing: string[];
};

function boolToWord(value: boolean | null): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unverified";
}

function buildFullReportEvidence(evidence: ClarkToolEvidence, resolvedAddress: string | null): ClarkFullReportEvidence {
  const tokenAddress = evidence.tokenScan?.token?.address ?? evidence.liquidity?.token?.address ?? resolvedAddress ?? null;
  const tokenName = evidence.tokenScan?.token?.name ?? evidence.liquidity?.token?.name ?? null;
  const tokenSymbol = evidence.tokenScan?.token?.symbol ?? evidence.liquidity?.token?.symbol ?? null;
  const market = evidence.tokenScan?.market ?? { price: null, change24h: null, volume24h: null, liquidity: null };
  const contractWarnings = [...(evidence.tokenScan?.warnings ?? [])];
  const devWarnings = [...(evidence.devWallet?.warnings ?? [])];
  const liqWarnings = [...(evidence.liquidity?.warnings ?? [])];
  const liqUsd = evidence.liquidity?.liquidityUsd ?? market.liquidity ?? null;
  const volumeToLiquidity = (market.volume24h != null && liqUsd != null && liqUsd > 0) ? (market.volume24h / liqUsd) : null;

  const out: ClarkFullReportEvidence = {
    token: { symbol: tokenSymbol, name: tokenName, address: tokenAddress, chain: "base" },
    market: {
      price: market.price,
      change24h: market.change24h,
      volume24h: market.volume24h,
      liquidity: market.liquidity,
      fdv: null,
      poolAge: null,
      marketSourceAvailable: market.price != null || market.volume24h != null || market.liquidity != null,
    },
    contract: {
      openSource: null,
      proxy: null,
      mintable: null,
      buyTax: evidence.tokenScan?.security.buyTax ?? null,
      sellTax: evidence.tokenScan?.security.sellTax ?? null,
      honeypot: evidence.tokenScan?.security.honeypot ?? null,
      warnings: contractWarnings,
    },
    liquidity: {
      liquidityUsd: liqUsd,
      lpLocked: null,
      lpOwner: null,
      lpConcentration: null,
      volumeToLiquidity,
      warnings: liqWarnings,
    },
    devWallet: {
      likelyDeployer: evidence.devWallet?.deployerAddress ?? null,
      linkedWallets: evidence.devWallet?.linkedWallets ?? null,
      suspiciousPatterns: devWarnings.filter((w) => /suspicious|linked|deployer|holder/i.test(w)).slice(0, 5),
      confidence: evidence.devWallet?.confidence ?? null,
      warnings: devWarnings,
    },
    missing: [],
  };

  if (!out.token.address) out.missing.push("Token contract");
  if (!out.market.marketSourceAvailable) out.missing.push("Market price/volume/liquidity");
  if (out.contract.openSource === null) out.missing.push("Contract open-source verification");
  if (out.contract.proxy === null) out.missing.push("Proxy status");
  if (out.contract.mintable === null) out.missing.push("Mintability");
  if (out.contract.honeypot === null) out.missing.push("Honeypot check");
  if (out.liquidity.lpLocked === null) out.missing.push("LP lock/control");
  if (out.devWallet.likelyDeployer === null) out.missing.push("Likely deployer identity");

  return out;
}

function evaluateFullReportVerdict(report: ClarkFullReportEvidence): {
  verdict: "WATCH" | "SCAN DEEPER" | "AVOID" | "UNKNOWN";
  confidence: "Low" | "Medium" | "High";
  signals: string[];
  risks: string[];
  clarkRead: string;
  nextAction: string;
} {
  const signals: string[] = [];
  const risks: string[] = [];

  if (report.market.liquidity != null) signals.push(`Liquidity observed around ${formatUsdShort(report.market.liquidity)}.`);
  if (report.market.volume24h != null) signals.push(`24h volume observed around ${formatUsdShort(report.market.volume24h)}.`);
  if (report.contract.honeypot === false) signals.push("No honeypot flag detected in current checks.");
  if ((report.devWallet.linkedWallets ?? 0) > 0) risks.push(`Linked deployer-wallet cluster detected (${report.devWallet.linkedWallets}).`);
  if (report.contract.honeypot === true) risks.push("Honeypot risk is flagged.");
  if ((report.contract.buyTax ?? 0) > 15 || (report.contract.sellTax ?? 0) > 15) risks.push("High transfer tax is flagged.");
  if ((report.liquidity.liquidityUsd ?? 0) < 20_000 && report.liquidity.liquidityUsd !== null) risks.push("Liquidity is thin for meaningful exits.");
  if (report.missing.length > 0) risks.push("Important risk checks are still unverified.");

  let verdict: "WATCH" | "SCAN DEEPER" | "AVOID" | "UNKNOWN" = "SCAN DEEPER";
  let confidence: "Low" | "Medium" | "High" = "Medium";

  const critical = report.contract.honeypot === true || (report.contract.buyTax ?? 0) > 20 || (report.contract.sellTax ?? 0) > 20;
  if (critical) {
    verdict = "AVOID";
    confidence = "High";
  } else if (!report.token.address || (!report.market.marketSourceAvailable && report.missing.length >= 5)) {
    verdict = "UNKNOWN";
    confidence = "Low";
  } else if ((report.liquidity.liquidityUsd ?? 0) >= 100_000 && report.contract.honeypot === false && report.missing.length <= 3) {
    verdict = "WATCH";
    confidence = "Medium";
  } else {
    verdict = "SCAN DEEPER";
    confidence = report.missing.length > 5 ? "Low" : "Medium";
  }

  const safeLine = verdict === "AVOID"
    ? "This token has confirmed risk flags that make it unsuitable right now."
    : verdict === "WATCH"
      ? "This token has usable market depth and no major confirmed contract red flags, but still needs active monitoring."
      : verdict === "UNKNOWN"
        ? "There is not enough verified scanner coverage to make a reliable call yet."
        : "I can’t call it safe from market data alone; risk coverage is still incomplete.";

  const nextAction = verdict === "AVOID"
    ? "Avoid until the flagged risks are resolved and re-verified."
    : "Run follow-up checks on LP control, deployer behavior, and holder structure before sizing any position.";

  return { verdict, confidence, signals: signals.slice(0, 5), risks: risks.slice(0, 5), clarkRead: safeLine, nextAction };
}

function renderFullTokenReport(report: ClarkFullReportEvidence): string {
  const verdict = evaluateFullReportVerdict(report);
  const name = report.token.name ?? "Unknown token";
  const symbol = report.token.symbol ?? "?";
  const address = report.token.address ?? "Unresolved";
  const summary = verdict.verdict === "AVOID"
    ? "Confirmed risk flags are present. This setup fails a basic risk screen and needs hard risk resolution before any further consideration."
    : verdict.verdict === "WATCH"
      ? "The token has enough market activity to monitor, but not enough complete risk coverage to treat as clean."
      : verdict.verdict === "UNKNOWN"
        ? "Current scanner coverage is too incomplete for a reliable risk call. More verified contract/liquidity/dev data is needed."
        : "Market activity exists, but missing risk fields prevent a clean conviction call.";

  const missing = report.missing.length ? report.missing.map((m) => `- ${m}`).join("\n") : "- No major gaps in the currently available scan fields.";
  const signals = verdict.signals.length ? verdict.signals.map((s) => `- ${s}`).join("\n") : "- No strong positive signals were confirmed.";
  const risks = verdict.risks.length ? verdict.risks.map((r) => `- ${r}`).join("\n") : "- No major risk flags were confirmed in available fields.";

  return [
    `Asset:\n${name} (${symbol}) — Base`,
    `Contract:\n${address}`,
    "",
    `Verdict:\n${verdict.verdict}`,
    "",
    `Confidence:\n${verdict.confidence}`,
    "",
    "Summary:",
    summary,
    "",
    "Market:",
    `- Price: ${report.market.price != null ? `$${report.market.price}` : "Unverified"}`,
    `- 24h: ${report.market.change24h != null ? `${report.market.change24h.toFixed(2)}%` : "Unverified"}`,
    `- Volume: ${formatUsdShort(report.market.volume24h)}`,
    `- Liquidity: ${formatUsdShort(report.market.liquidity)}`,
    `- FDV: ${report.market.fdv != null ? formatUsdShort(report.market.fdv) : "Unverified"}`,
    `- Pool age: ${report.market.poolAge ?? "Unverified"}`,
    "",
    "Contract:",
    `- Open source: ${boolToWord(report.contract.openSource)}`,
    `- Proxy: ${boolToWord(report.contract.proxy)}`,
    `- Mintable: ${boolToWord(report.contract.mintable)}`,
    `- Buy/sell tax: ${report.contract.buyTax != null || report.contract.sellTax != null ? `${report.contract.buyTax ?? "?"}% / ${report.contract.sellTax ?? "?"}%` : "Unverified"}`,
    `- Honeypot: ${boolToWord(report.contract.honeypot)}`,
    "",
    "Liquidity:",
    `- Pool depth: ${formatUsdShort(report.liquidity.liquidityUsd)}`,
    `- LP lock/control: ${boolToWord(report.liquidity.lpLocked)}${report.liquidity.lpOwner ? ` (owner: ${shortAddress(report.liquidity.lpOwner)})` : ""}`,
    `- Volume/liquidity read: ${report.liquidity.volumeToLiquidity != null ? report.liquidity.volumeToLiquidity.toFixed(2) : "Unverified"}`,
    "",
    "Dev wallet:",
    `- Likely deployer: ${report.devWallet.likelyDeployer ? shortAddress(report.devWallet.likelyDeployer) : "Unverified"}`,
    `- Linked wallets: ${report.devWallet.linkedWallets != null ? report.devWallet.linkedWallets : "Unverified"}`,
    `- Suspicious patterns: ${report.devWallet.suspiciousPatterns.length ? report.devWallet.suspiciousPatterns.join("; ") : "None confirmed from available scan"}`,
    `- Confidence: ${report.devWallet.confidence ?? "Unverified"}`,
    "",
    "Key signals:",
    signals,
    "",
    "Risks:",
    risks,
    "",
    "What’s missing:",
    missing,
    "",
    "Clark’s read:",
    verdict.clarkRead,
    "",
    "Next action:",
    verdict.nextAction,
  ].join("\n");
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

async function handleWalletScanner(body: ClarkRequestBody, origin: string) {
  const chain = body.chain ?? "base";
  const walletAddress = body.walletAddress ?? body.addressOrToken;
  if (!walletAddress) throw new Error("walletAddress or addressOrToken is required");

  const userPrompt = (body.prompt ?? "").trim();
  const t = userPrompt.toLowerCase();
  const isBalanceQuestion = /\b(balance|balances|holdings?|portfolio|what(?:'s| is) in|how much|show me)\b/i.test(t);
  const isQualityQuestion = /\b(good wallet|worth following|smart money|copy trad|is this|analyze|review|verdict)\b/i.test(t);

  const { ok, json: walletData } = await callInternalApi(origin, "/api/wallet", { address: walletAddress });

  if (!ok || (walletData as Record<string, unknown>)?.error) {
    return {
      feature: "wallet-scanner",
      chain,
      walletAddress,
      analysis: `I couldn't pull wallet data for ${shortAddress(walletAddress)} right now. The wallet may be new or the data source is temporarily unavailable.`,
    };
  }

  const w = walletData as {
    address: string;
    totalValue: number;
    holdings: Array<{ name: string; symbol: string; balance: number; value: number; chain: string | null; change24h: number | null }>;
    txCount: number | null;
    walletAgeDays: number | null;
    firstTxDate: string | null;
  };

  // Balance / holdings question — return plain summary, no verdict format
  if (isBalanceQuestion && !isQualityQuestion) {
    const normalized = normalizeWalletSnapshotEvidence(w as unknown as Record<string, unknown>, walletAddress);
    return { feature: "wallet-scanner", chain, walletAddress, analysis: formatWalletBalanceSummary(normalized) };
  }

  const normalized = normalizeWalletSnapshotEvidence(w as unknown as Record<string, unknown>, walletAddress);
  const analysis = buildWalletQualityVerdict(normalized, walletAddress, userPrompt);
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

async function handleClarkAI(body: ClarkRequestBody, origin: string) {
  const chain = body.chain ?? "base";
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";
  const replyMode = detectReplyMode(body);
  const directIntent = detectIntent(prompt);
  const plan = buildClarkToolPlan({
    message: prompt,
    mode: body.mode,
    uiModeHint: body.uiModeHint,
    context: body.context,
    history: body.history,
  });
  const { evidence, toolsUsed, resolvedAddress } = await executeClarkToolPlan({ plan, origin, prompt, chain });

  if (replyMode === "casual_help" || plan.intent === "casual" || plan.intent === "help") {
    return { feature: "clark-ai", chain, mode: "casual_help", analysis: buildCasualClarkReply(prompt), intent: plan.intent, toolsUsed };
  }

  if (replyMode === "educational" || plan.intent === "educational") {
    return { feature: "clark-ai", chain, mode: "educational", analysis: buildEducationalReply(prompt), intent: plan.intent, toolsUsed };
  }

  if (replyMode === "routing_help") {
    return { feature: "clark-ai", chain, mode: "routing_help", analysis: buildRoutingHelpReply(prompt), intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "wallet_compare_request") {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: "Wallet compare is planned for the next phase. For now, share one wallet and I’ll score it with available evidence.",
      intent: plan.intent,
      toolsUsed,
    };
  }

  if (plan.intent === "token_full_report_request") {
    if (evidence.tokenResolve?.ok && evidence.tokenResolve.matches.length > 1) {
      const options = evidence.tokenResolve.matches.slice(0, 4).map((c, i) => `${i + 1}. ${c.symbol} — ${c.contract}`).join("\n");
      return {
        feature: "clark-ai",
        chain,
        mode: "token_name_lookup",
        analysis: `I found multiple Base matches for '${evidence.tokenResolve.query}'. Pick one before I run the full report:\n${options}\nSend the number or paste the contract.`,
        intent: plan.intent,
        toolsUsed,
      };
    }

    if (!resolvedAddress && !evidence.tokenScan?.token?.address) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        analysis: "Which Base token should I run the full report on? Paste a symbol or contract.",
        intent: plan.intent,
        toolsUsed,
      };
    }

    const reportEvidence = buildFullReportEvidence(evidence, resolvedAddress);
    const analysis = renderFullTokenReport(reportEvidence);
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis,
      intent: plan.intent,
      toolsUsed,
    };
  }

  if (plan.intent === "market" || plan.intent === "strategy" || replyMode === "general_market") {
    if (evidence.market?.ok) {
      const list = evidence.market.candidates.slice(0, 5).map((c) => ({
        attributes: {
          name: `${c.token} / USDC`,
          reserve_in_usd: c.liquidity,
          volume_usd: { h24: c.volume24h },
          price_change_percentage: { h24: c.change24h },
        },
      }));
      return {
        feature: "clark-ai",
        chain,
        mode: "general_market",
        analysis: buildGTMarketBriefing(list),
        intent: plan.intent,
        toolsUsed,
      };
    }
    return { feature: "clark-ai", chain, mode: "general_market", analysis: buildGeneralMarketNoContextReply(), intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "wallet_balance") {
    const w = evidence.walletSnapshot;
    if (!w?.ok) {
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "I couldn’t pull this wallet snapshot right now. Paste the wallet again and I’ll retry.", intent: plan.intent, toolsUsed };
    }
    const summary = formatWalletBalanceSummary(w);
    return { feature: "clark-ai", chain, mode: "analysis", analysis: summary, intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "wallet_quality") {
    if (!resolvedAddress) {
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "Share the wallet address and I’ll evaluate quality with available evidence.", intent: plan.intent, toolsUsed };
    }
    if (evidence.walletSnapshot?.ok) {
      const quality = buildWalletQualityVerdict(evidence.walletSnapshot, resolvedAddress, prompt);
      return { feature: "clark-ai", chain, mode: "analysis", analysis: quality, intent: plan.intent, toolsUsed };
    }
    if (evidence.walletQuality?.analysis) {
      return { feature: "clark-ai", chain, mode: "analysis", analysis: enforceWalletAssetLabel(evidence.walletQuality.analysis, resolvedAddress), intent: plan.intent, toolsUsed };
    }
    const fallback = evidence.walletSnapshot
      ? enforceWalletAssetLabel(buildWalletAnalysisFallback(evidence.walletSnapshot, resolvedAddress), resolvedAddress)
      : "I can judge this as a whale/watch wallet only. Not enough verified data to call it smart money yet.";
    return { feature: "clark-ai", chain, mode: "analysis", analysis: fallback, intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "dev_wallet") {
    if (!resolvedAddress) return { feature: "clark-ai", chain, mode: "analysis", analysis: missingAddressReply("dev_wallet"), intent: plan.intent, toolsUsed };
    if (evidence.devWallet?.ok) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        analysis: buildStructuredVerdict(
          evidence.devWallet.verdict,
          evidence.devWallet.confidence,
          evidence.devWallet.deployerAddress ? "Likely deployer and linked-wallet analysis completed." : "Deployer identity is still uncertain from available data.",
          [
            evidence.devWallet.deployerAddress ? `Likely deployer: ${shortAddress(evidence.devWallet.deployerAddress)}` : "Likely deployer not confirmed",
            `Linked wallets detected: ${evidence.devWallet.linkedWallets}`,
            "Use this as watch evidence, not certainty.",
          ],
          evidence.devWallet.warnings.length ? evidence.devWallet.warnings : ["Some deployer-link fields are still unverified."],
          "Track linked wallets and re-check holder distribution before trusting this token."
        ),
        intent: plan.intent,
        toolsUsed,
      };
    }
    return { feature: "clark-ai", chain, mode: "analysis", analysis: "Dev wallet scan is temporarily unavailable. Open Dev Wallet Detector and retry.", intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "liquidity_safety") {
    if (!resolvedAddress) return { feature: "clark-ai", chain, mode: "analysis", analysis: missingAddressReply("liquidity_safety"), intent: plan.intent, toolsUsed };
    if (evidence.liquidity?.ok && evidence.liquidity.token) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        analysis: buildStructuredVerdict(
          evidence.liquidity.riskTier === "low" ? "WATCH" : evidence.liquidity.riskTier === "extreme" ? "AVOID" : "SCAN DEEPER",
          evidence.liquidity.riskTier === "low" ? "Medium" : "Low",
          `${evidence.liquidity.token.name} liquidity scan completed with ${evidence.liquidity.riskTier ?? "unknown"} LP risk tier.`,
          [
            `Total liquidity: ${formatUsdShort(evidence.liquidity.liquidityUsd)}`,
            `LP stability score: ${evidence.liquidity.stabilityScore ?? "n/a"}`,
            "Liquidity depth and turnover were checked from available pools.",
          ],
          evidence.liquidity.warnings.length ? evidence.liquidity.warnings : ["LP lock ownership may still require manual verification."],
          "Use Liquidity Safety panel details before any entry."
        ),
        intent: plan.intent,
        toolsUsed,
      };
    }
    return { feature: "clark-ai", chain, mode: "analysis", analysis: "Liquidity scan is temporarily unavailable. Retry with the contract address.", intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "token_analysis") {
    if (evidence.tokenResolve?.ok && evidence.tokenResolve.matches.length > 1) {
      const options = evidence.tokenResolve.matches.slice(0, 3).map((c, i) => `${i + 1}. ${c.symbol} — ${c.contract}`).join("\n");
      return {
        feature: "clark-ai",
        chain,
        mode: "token_name_lookup",
        analysis: `I found multiple Base matches for '${evidence.tokenResolve.query}'. Pick one:\n${options}\nSend the number or paste the contract.`,
        intent: plan.intent,
        toolsUsed,
      };
    }

    if (plan.tools.some((t) => t.name === "token_resolve") && evidence.tokenResolve?.selected?.contract) {
      const tokenData = await callScanToken(evidence.tokenResolve.selected.contract, "contract", origin);
      if (tokenData) evidence.tokenScan = {
        ok: true,
        token: { name: String((tokenData as Record<string, unknown>).name ?? "Token"), symbol: String((tokenData as Record<string, unknown>).symbol ?? "?"), address: String((tokenData as Record<string, unknown>).contract ?? evidence.tokenResolve.selected.contract) },
        market: {
          price: typeof (tokenData as Record<string, unknown>).price === "number" ? (tokenData as Record<string, unknown>).price as number : null,
          change24h: typeof (tokenData as Record<string, unknown>).priceChange24h === "number" ? (tokenData as Record<string, unknown>).priceChange24h as number : null,
          volume24h: typeof (tokenData as Record<string, unknown>).volume24h === "number" ? (tokenData as Record<string, unknown>).volume24h as number : null,
          liquidity: typeof (tokenData as Record<string, unknown>).liquidity === "number" ? (tokenData as Record<string, unknown>).liquidity as number : null,
        },
        security: { honeypot: null, buyTax: null, sellTax: null },
        liquidity: { pools: Array.isArray((tokenData as Record<string, unknown>).pools) ? ((tokenData as Record<string, unknown>).pools as unknown[]).length : 0, topPoolLiquidity: typeof (tokenData as Record<string, unknown>).liquidity === "number" ? (tokenData as Record<string, unknown>).liquidity as number : null },
        warnings: [],
      };
    }

    const token = evidence.tokenScan?.token;
    if (!token) {
      if (resolvedAddress && (plan.followupContext.selectedOptionIndex !== null || plan.tools.some((t) => t.name === "token_scan"))) {
        return {
          feature: "clark-ai",
          chain,
          mode: "analysis",
          analysis: `I resolved your selection to ${shortAddress(resolvedAddress)}, but the token scan is temporarily unavailable. Paste the same contract again and I’ll retry.`,
          intent: plan.intent,
          toolsUsed,
        };
      }
      if (directIntent.address && !/wallet|balance|portfolio|copy[\s-]?trade/i.test(prompt)) {
        return { feature: "clark-ai", chain, mode: "analysis", analysis: "Is this address a token contract or a wallet? Tell me which scan you want.", intent: plan.intent, toolsUsed };
      }
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "Paste a Base token contract (or token name) and I’ll scan it.", intent: plan.intent, toolsUsed };
    }
    const context: ClarkContext = {
      tokenData: {
        name: token.name,
        symbol: token.symbol,
        contract: token.address,
        price: evidence.tokenScan?.market.price,
        liquidity: evidence.tokenScan?.market.liquidity,
        volume24h: evidence.tokenScan?.market.volume24h,
        priceChange24h: evidence.tokenScan?.market.change24h,
        security: evidence.tokenScan?.security,
      },
    };
    let analysis: string;
    try {
      analysis = await callAnthropic(prompt, context);
    } catch {
      analysis = buildTokenAnalysisFallback(context.tokenData ?? {}, token.address);
    }
    return { feature: "clark-ai", chain, mode: "analysis", analysis, intent: plan.intent, toolsUsed };
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && !resolvedAddress && directIntent.intent !== "token_name_lookup") {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: "Paste a Base contract, wallet, or scan result and I’ll analyze it.",
      intent: plan.intent,
      toolsUsed,
    };
  }

  let trending: unknown[] = [];
  let gtPools: unknown[] = [];
  const network = gtNetwork(chain);
  if (shouldFetchMarketContext(prompt)) {
    const [trendingResult, gtRawResult] = await Promise.allSettled([
      callTrending(origin),
      callGeckoTerminal(network, origin),
    ]);
    if (trendingResult.status === "fulfilled" && Array.isArray(trendingResult.value)) trending = trendingResult.value;
    if (gtRawResult.status === "fulfilled" && Array.isArray((gtRawResult.value as { data?: unknown[] })?.data)) gtPools = ((gtRawResult.value as { data: unknown[] }).data as unknown[]).slice(0, 5);
  }

  const context: ClarkContext = {
    trending,
    gtPools,
    tokenData: evidence.tokenScan ?? {},
    walletScan: evidence.walletSnapshot ?? {},
    analysis: body.context ?? {},
  };
  const analysis = await callAnthropic(prompt, context);
  return { feature: "clark-ai", chain, mode: replyMode, analysis, intent: plan.intent, toolsUsed };
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
        result = await handleWalletScanner(body, origin);
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
