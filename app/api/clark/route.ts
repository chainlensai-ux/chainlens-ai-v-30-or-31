import { NextRequest, NextResponse } from "next/server";
import { getBaseMarketUniverse, type BaseMarketCandidate, type BaseMarketMode } from "@/lib/server/baseMarketUniverse";
import { fetchHoneypotSecurity } from "@/lib/server/honeypotSecurity";
import { getCurrentUserPlanFromBearerToken } from '@/lib/supabase/plans'
import { getVerifiedUserPlan } from '@/lib/supabase/userSettings'

const {
  GOLDRUSH_API_KEY,
  ZERION_KEY,
  COVALENT_API_KEY,
  ANTHROPIC_API_KEY,
  BASESCAN_API_KEY,
} = process.env;

const CLARK_CACHE_TTL_MS = 90 * 1000
const clarkCache = new Map<string, { exp: number; payload: unknown }>()
const clarkRateDaily = new Map<string, { count: number; resetAt: number }>()
const clarkRateMinute = new Map<string, { count: number; resetAt: number }>()
const CLARK_DAILY_BY_PLAN: Record<string, number> = { free: 5, pro: 50, elite: 300, unauth: 3 }
const CLARK_MINUTE_BY_PLAN: Record<string, number> = { free: 2, pro: 5, elite: 5, unauth: 1 }
const CLARK_LOW_COST_MINUTE_BY_PLAN: Record<string, number> = { free: 15, pro: 20, elite: 20, unauth: 8 }
const clarkRateLowCostMinute = new Map<string, { count: number; resetAt: number }>()
let clarkInternalCtx: { authToken?: string; verifiedPlan?: 'free' | 'pro' | 'elite' } = {}
function clarkIp(req: NextRequest): string { return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown' }
function clarkActor(req: NextRequest, authenticated: boolean): string { return authenticated ? (req.headers.get('x-user-id')?.trim() || `ip:${clarkIp(req)}`) : `ip:${clarkIp(req)}` }

// Session memory — lightweight short-term context per session/user
type ClarkSessionMemory = {
  lastToken: {
    address: string;
    symbol: string | null;
    name: string | null;
    scanSummary: string | null;
    ts: number;
  } | null;
  lastWallet: {
    address: string;
    ensName: string | null;
    walletSummary: string | null;
    ts: number;
  } | null;
  lastMomentumList: Array<{
    rank: number;
    symbol: string;
    name: string | null;
    address: string | null;
    liquidity: number | null;
    volume24h: number | null;
    change24h: number | null;
    tag: string | null;
  }>;
  lastMomentumTs: number;
  lastIntent: string | null;
  lastIntentTs: number;
  lastActionableIntent: string | null;
  lastActionableIntentTs: number;
  allowedRankScanUntil: number;
  allowedRankScanUsed: boolean;
  lastMomentumShownCount: number;
};
const SESSION_MEMORY = new Map<string, ClarkSessionMemory>();
const SESSION_MEMORY_TTL_MS = 30 * 60 * 1000; // 30 min
const MOMENTUM_MEMORY_TTL_MS = 20 * 60 * 1000; // 20 min
const INTENT_MEMORY_TTL_MS = 15 * 60 * 1000; // 15 min

function getSessionMemory(key: string): ClarkSessionMemory {
  const now = Date.now();
  const existing = SESSION_MEMORY.get(key);
  if (!existing) {
    const fresh: ClarkSessionMemory = { lastToken: null, lastWallet: null, lastMomentumList: [], lastMomentumTs: 0, lastIntent: null, lastIntentTs: 0, lastActionableIntent: null, lastActionableIntentTs: 0, allowedRankScanUntil: 0, allowedRankScanUsed: false, lastMomentumShownCount: 0 };
    SESSION_MEMORY.set(key, fresh);
    return fresh;
  }
  if (existing.lastToken && now - existing.lastToken.ts > SESSION_MEMORY_TTL_MS) existing.lastToken = null;
  if (existing.lastWallet && now - existing.lastWallet.ts > SESSION_MEMORY_TTL_MS) existing.lastWallet = null;
  if (existing.lastMomentumList.length && now - existing.lastMomentumTs > MOMENTUM_MEMORY_TTL_MS) {
    existing.lastMomentumList = [];
    existing.lastMomentumTs = 0;
    existing.allowedRankScanUntil = 0;
    existing.allowedRankScanUsed = false;
    existing.lastMomentumShownCount = 0;
  }
  if (existing.lastIntent && now - existing.lastIntentTs > INTENT_MEMORY_TTL_MS) existing.lastIntent = null;
  if (existing.lastActionableIntent && now - existing.lastActionableIntentTs > INTENT_MEMORY_TTL_MS) existing.lastActionableIntent = null;
  return existing;
}

function parseRankFollowup(prompt: string): number | null {
  const rankPrompt = prompt.trim().toLowerCase();
  const ordinalMap: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  const ordinalRankMatch = rankPrompt.match(/\b(?:scan|check|full\s+report\s+on|why\s+is)\s+(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+one)?\b/i);
  const numericRankMatch = rankPrompt.match(/\b(?:scan(?:\s+number)?|check|full\s+report\s+on|why\s+is(?:\s+token)?(?:\s+number)?)\s+([1-9]\d{0,2})\b/i);
  const directRankMatch = rankPrompt.match(/^([1-9]\d{0,2})$/);
  return ordinalRankMatch
    ? ordinalMap[ordinalRankMatch[1].toLowerCase()]
    : (numericRankMatch ? Number(numericRankMatch[1]) : (directRankMatch ? Number(directRankMatch[1]) : null));
}

function makeSessionKey(req: NextRequest, authenticated: boolean): string {
  const userId = req.headers.get('x-user-id')?.trim();
  const sessionId = req.headers.get('x-clark-session')?.trim();
  if (authenticated && userId) return `u:${userId}`;
  if (sessionId) return `s:${sessionId}`;
  return `ip:${clarkIp(req)}`;
}
function getSessionKeySource(req: NextRequest, authenticated: boolean): "user" | "session" | "ip" {
  const userId = req.headers.get('x-user-id')?.trim();
  const sessionId = req.headers.get('x-clark-session')?.trim();
  if (authenticated && userId) return "user";
  if (sessionId) return "session";
  return "ip";
}

function updateMemToken(mem: ClarkSessionMemory, address: string, symbol: string | null, name: string | null, scanSummary: string | null) {
  mem.lastToken = { address, symbol, name, scanSummary, ts: Date.now() };
}

function updateMemWallet(mem: ClarkSessionMemory, address: string, ensName: string | null, walletSummary: string | null) {
  mem.lastWallet = { address, ensName, walletSummary, ts: Date.now() };
}

function updateMemMomentum(mem: ClarkSessionMemory, items: ClarkSessionMemory['lastMomentumList']) {
  mem.lastMomentumList = items;
  mem.lastMomentumTs = Date.now();
  mem.lastMomentumShownCount = 0;
}

function updateMemIntent(mem: ClarkSessionMemory, intent: string) {
  const now = Date.now();
  // Keep lastIntent for conversational context, but do not let educational/fallback turns
  // overwrite actionable routing memory.
  mem.lastIntent = intent;
  mem.lastIntentTs = now;
  const actionableIntents = new Set([
    "base_momentum", "market",
    "token_scan", "token_analysis",
    "wallet", "wallet_balance", "wallet_analysis",
    "liquidity", "liquidity_safety",
    "dev_wallet",
    "pump_alerts",
    "whale_alerts", "whale_alert",
  ]);
  if (actionableIntents.has(intent)) {
    mem.lastActionableIntent = intent;
    mem.lastActionableIntentTs = now;
  }
}
// Lightweight prompt cost classifier — determines whether a prompt needs expensive tool calls
const LOW_COST_RE = /^(hi|hey|yo|gm|sup|hello|ok|okay|sure|thanks|thank you|got it|cool|nice|great)\b|^(more|continue|expand|go on|keep going|next|show more|give me more|other tokens)\s*$|^(what does that mean|explain that|can you explain|what is that|what does .{1,40} mean|explain .{1,40})\??$|^(what\s+(?:does|is|are)\s+(?:volume|liquidity|lp|fdv|market\s+cap|holder|concentration|turnover|slippage|honeypot|dev\s+wallet|deployer|whale).{0,60})\??$|what\s+(?:is|are)\s+(?:red\s+flags?|risk\s+flags?|the\s+risks?)|how\s+do\s+(?:i|you)\s+(?:find|track|use|read)/i;

const WATCH_VERDICT_LOW_COST_RE = /\b(should\s+i\s+watch\s+(?:it|this|the\s+token|that\s+token)?|is\s+it\s+worth\s+watching|worth\s+watching|final\s+verdict|what'?s\s+the\s+play|should\s+i\s+monitor\s+(?:it|this)|watch\s+verdict)\b/i;

const WALLET_FOLLOWUP_LOW_COST_RE = /\b(is\s+it\s+worth|worth\s+monitoring|is\s+this\s+wallet|should\s+i\s+watch|should\s+i\s+copy|what\s+are\s+its|any\s+risk|main\s+holdings?|scan\s+its|top\s+holding)\b/i;

const MORE_CONTEXT_RE = /^(more|continue|expand|go on|keep going|give me more|show more)\s*$/i;
const THIS_DEV_RE = /\b(who\s+deployed\s+this|who\s+made\s+this|dev\s+wallet\s+this|origin\s+wallet\s+this|deployer\s+this|creator\s+wallet)\b/i;
const THIS_LIQ_RE = /\b(liquidity\s+check\s+this|lp\s+check\s+this|is\s+lp\s+locked|is\s+liquidity\s+safe|pool\s+safety\s+this)\b/i;

function isLowCostPrompt(prompt: string, sessionMem?: ClarkSessionMemory): boolean {
  const t = prompt.trim();
  if (LOW_COST_RE.test(t)) return true;
  // Watch verdict is low-cost if we have token memory to draw from
  if (WATCH_VERDICT_LOW_COST_RE.test(t) && sessionMem?.lastToken) return true;
  // Wallet follow-up is low-cost if we have wallet memory
  if (WALLET_FOLLOWUP_LOW_COST_RE.test(t) && sessionMem?.lastWallet) return true;
  // "more"/"continue" after a previous answer
  if (MORE_CONTEXT_RE.test(t)) return true;
  return false;
}

function isMajorOrStableLike(symbol: string, name?: string | null): boolean {
  const s = symbol.toUpperCase();
  const n = (name ?? "").toUpperCase();
  const hard = new Set(["USDC", "USDT", "DAI", "USDBC", "WETH", "CBBTC", "CBETH", "WSTETH", "EURC"]);
  if (hard.has(s)) return true;
  if (/^USD|USD$|USDP|BASEUSDP/.test(s)) return true;
  if (/STABLE|PEG|USD/.test(n)) return true;
  return false;
}

function cleanClarkText(text: string): string {
  return text
    .replace(/Security sim:\s*Security sim:/gi, "Security sim:")
    .replace(/unverified\.\./gi, "unverified.")
    .replace(/\.\.+/g, ".")
    .replace(/LP lock\/control unverified\.\n- LP lock\/control is unverified\./gi, "LP lock/control unverified.")
    .replace(/\n{3,}/g, "\n\n");
}

type ClarkRateResult = { allowed: true; commitDaily: () => void } | { allowed: false; window: 'minute' | 'daily' }
function checkClarkRate(actor: string, planKey: string): ClarkRateResult {
  const now = Date.now()
  const minuteKey = `clark:${actor}:${planKey}:minute`
  const dailyKey = `clark:${actor}:${planKey}:daily`
  const minuteLim = CLARK_MINUTE_BY_PLAN[planKey] ?? 1
  const dailyLim = CLARK_DAILY_BY_PLAN[planKey] ?? 3
  const curMinute = clarkRateMinute.get(minuteKey)
  const minuteActive = Boolean(curMinute && curMinute.resetAt > now)
  if (minuteActive && curMinute!.count >= minuteLim) return { allowed: false, window: 'minute' }
  const curDaily = clarkRateDaily.get(dailyKey)
  const dailyActive = Boolean(curDaily && curDaily.resetAt > now)
  if (dailyActive && curDaily!.count >= dailyLim) return { allowed: false, window: 'daily' }
  if (!minuteActive) { clarkRateMinute.set(minuteKey, { count: 1, resetAt: now + 60_000 }) } else { curMinute!.count += 1 }
  const commitDaily = () => {
    const cur = clarkRateDaily.get(dailyKey)
    const active = Boolean(cur && cur.resetAt > Date.now())
    if (!active) { clarkRateDaily.set(dailyKey, { count: 1, resetAt: Date.now() + 24 * 60 * 60 * 1000 }) } else { cur!.count += 1 }
  }
  return { allowed: true, commitDaily }
}

function checkClarkLowCostRate(actor: string, planKey: string): ClarkRateResult {
  const now = Date.now()
  const minuteKey = `clark:${actor}:${planKey}:lowcost:minute`
  const minuteLim = CLARK_LOW_COST_MINUTE_BY_PLAN[planKey] ?? 8
  const curMinute = clarkRateLowCostMinute.get(minuteKey)
  const minuteActive = Boolean(curMinute && curMinute.resetAt > now)
  if (minuteActive && curMinute!.count >= minuteLim) return { allowed: false, window: 'minute' }
  if (!minuteActive) { clarkRateLowCostMinute.set(minuteKey, { count: 1, resetAt: now + 60_000 }) } else { curMinute!.count += 1 }
  // Low-cost messages don't count against daily tool quota
  const commitDaily = () => {}
  return { allowed: true, commitDaily }
}

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
  clarkContext?: {
    lastMarketList?: unknown;
    lastToken?: string | null;
    lastWallet?: string | null;
    lastIntent?: string | null;
    lastSelectedRank?: number | null;
    marketCursor?: { offset?: number; returnedCount?: number; requestedCount?: number; totalCandidates?: number } | null;
    seenMarketAddresses?: string[] | null;
    seenMarketSymbols?: string[] | null;
    previousIntent?: string | null;
  };
  marketContext?: unknown;
  recentMovers?: unknown;
  moversContext?: unknown;
  clientContext?: {
    lastMomentumList?: ClarkSessionMemory["lastMomentumList"];
    lastMomentumShownCount?: number;
    lastToken?: ClarkSessionMemory["lastToken"];
    lastWallet?: ClarkSessionMemory["lastWallet"];
  };
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
  | "trading_boundary"
  | "financial_advice"
  | "capabilities"
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

type LiveIntent = "MARKET_OVERVIEW" | "TOKEN_QUERY" | "BASE_MARKET" | "WALLET_QUERY" | "WHALE_FEED" | "GENERAL_CHAT";

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

const ENS_NAME_RE = /\b([a-z0-9][a-z0-9-]*\.(?:base\.eth|cb\.id|eth))\b/i
function extractEnsName(text: string): string | null {
  const m = text.match(ENS_NAME_RE)
  if (!m) return null
  return m[1].toLowerCase().replace(/[.,;:!?'"]+$/, '')
}
async function resolveEnsOrBasename(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.ensdata.net/${encodeURIComponent(name)}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4500),
    })
    if (!res.ok) return null
    const data = await res.json() as Record<string, unknown>
    const addr = typeof data?.address === 'string' ? data.address : null
    if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) return addr
  } catch { /* timeout or network error */ }
  return null
}
function isValidationOnlyAnalysis(analysis: string): boolean {
  return /I can run that, but I need a wallet address first|I can run that, but I need a token contract first|I couldn't resolve .+ to a wallet address|That doesn't look like a Base token/i.test(analysis)
}

function idToAddress(id: string): string {
  const idx = id.indexOf("_");
  return idx === -1 ? id : id.slice(idx + 1);
}

// Query-level aliases: normalize common token names/phrases to canonical search query.
// Applied in extractTokenLookupQuery before sending to searchBaseTokenCandidates.
const KNOWN_BASE_TOKEN_ALIASES: Record<string, string> = {
  "aerodrome finance": "aero",
  "aerodrome": "aero",
  "virtual protocol": "virtual",
  "virtuals protocol": "virtual",
  "virtuals": "virtual",
  "brett coin": "brett",
  "bretty": "brett",
  "toshi coin": "toshi",
  "degen coin": "degen",
  "higher coin": "higher",
  "normie coin": "normie",
  "based coin": "based",
  "coinbase wrapped eth": "cbeth",
  "wrapped eth": "weth",
};

function extractTokenLookupQuery(prompt: string): string | null {
  const t = prompt.trim().toLowerCase();
  const blockedQueries = new Set([
    "holder", "holders", "holder count", "holder distribution", "holder concentration",
    "concentration", "distribution", "count",
    "liquidity", "lp", "lp lock", "lp control", "deployer", "dev wallet", "transfer controls",
    "security", "tax", "taxes",
  ]);
  const patterns = [
    /\b([a-z0-9._-]{2,32})\s+(?:full report|run full report|give me full report|full analysis)\b/i,
    /(?:scan|analyze|analyse|check)\s+([a-z0-9._-]{2,32})(?:\s+on\s+base)?\b/i,
    /(?:full report on|report on|complete report on|deep scan|full analysis of|full analysis on|run all checks on)\s+([a-z0-9._-]{2,32}(?:\s+[a-z0-9._-]{2,32})?)(?:\s+on\s+base)?\b/i,
    /what about\s+([a-z0-9._-]{2,32}(?:\s+[a-z0-9._-]{2,32})?)(?:\s+on\s+base)?\b/i,
    /is\s+([a-z0-9._-]{2,32})\s+safe\b/i,
    /what'?s happening with\s+([a-z0-9._-]{2,32})(?:\s+on\s+base)?\b/i,
    /(?:who\s+(?:deployed|built|created|made)|deployer\s+of|dev\s+of|dev\s+wallet\s+for)\s+([a-z0-9._-]{2,32})\b/i,
    /(?:liquidity|lp)\s+safe(?:ty)?\s+(?:for|of|on)\s+([a-z0-9._-]{2,32})\b/i,
    /is\s+(?:liquidity|lp)\s+safe(?:ty)?\s+(?:for|of)?\s*([a-z0-9._-]{2,32})\b/i,
    /([a-z0-9._-]{2,32})\s+(?:liquidity|lp)\s+safe(?:ty)?\b/i,
    /(?:liquidity|lp)\s+(?:check|status|for)\s+([a-z0-9._-]{2,32})\b/i,
    /check\s+(?:liquidity|lp)(?:\s+for)?\s+([a-z0-9._-]{2,32})\b/i,
    /is\s+([a-z0-9._-]{2,32})\s+(?:lp\s+locked|lp\s+safe(?:ty)?|liquidity\s+(?:safe|locked))\b/i,
    /([a-z0-9._-]{2,32})\s+(?:liquidity|lp)\s+(?:check|status|locked)\b/i,
    /holder(?:\s+concentration|\s+distribution|\s+count)\s+([a-z0-9._-]{2,32})\b/i,
    /top\s+holders?\s+(?:of\s+|for\s+)?([a-z0-9._-]{2,32})\b/i,
    /supply\s+concentration\s+(?:for\s+)?([a-z0-9._-]{2,32})\b/i,
    /([a-z0-9._-]{2,32})\s+(?:holder\s+concentration|holder\s+distribution|top\s+holders?|supply\s+concentration)\b/i,
    /holders?\s+([a-z0-9._-]{2,32})\b/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]) {
      const q = m[1].trim().toLowerCase();
      if (blockedQueries.has(q)) continue;
      // Normalize multi-word names and common aliases to canonical search query
      return KNOWN_BASE_TOKEN_ALIASES[q] ?? q;
    }
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
  if (/^(hi|hey|hello|yo|gm|sup)\b|what can you do|what can u do|help|who are you|what is chainlens|yo what can u do clark/i.test(t)) {
    return { intent: "casual_help", address };
  }
  if (/\b(should i buy this|should i ape|should i buy)\b/i.test(t)) {
    return { intent: "financial_advice", address };
  }
  if (/what\s+(?:does|is|are)\s+(?:volume[-\s]led|tradable\s+depth|microcap\s+noise|liquidity\s+depth|lp\s+control|liquidity\s+control|turnover|market\s+cap\s+unverified|unverified\s+market\s+cap|holder\s+concentration|token\s+safety|fdv|market\s+cap|slippage|dev\s+wallet|honeypot|whale\s+alert|pump\s+alert|base\s+radar)/.test(t)) {
    return { intent: "educational", address };
  }
  if (/what\s+does\s+.{1,40}\s+mean\??$|explain\s+.{1,60}$/.test(t) && !extractAddress(t)) {
    return { intent: "educational", address };
  }
  if (/what is liquidity risk|explain liquidity risk|what is a dev wallet|what does holder concentration mean|why is lp lock important|what is holder concentration|what is lp lock|what is slippage|explain slippage|what is market cap|what is fdv|what is a honeypot|how do whale alerts work|how do pump alerts work|what is base radar|explain whale alerts?|explain pump alerts?/i.test(t)) {
    return { intent: "educational", address };
  }
  if (/how do i scan|where do i check deployer|how do i track a wallet|how do i use this|which feature|where should i go/i.test(t)) {
    return { intent: "routing_help", address };
  }
  if (/base radar/.test(t)) {
    return { intent: "base_radar", address };
  }
  // Unsupported capabilities — trading, funds movement, privacy evasion, key recovery
  if (/\b(trade for me|execute.*trade|place.*order|snipe.*token|buy.*for me|sell.*for me|hide[\s\w]*transactions?|obfuscat[\s\w]*transactions?|launder|move.*my funds|send.*eth.*for me|transfer.*eth.*for me|private key|seed phrase|mnemonic|recover.*wallet|bypass.*kyc)\b/i.test(t)) {
    return { intent: "trading_boundary", address };
  }
  // Wallet scan patterns — explicit wallet scan/analyze/report prompts
  const WALLET_SCAN_PATTERNS_RE = /\b(scan\s+wallet|analyze\s+wallet|analyse\s+wallet|wallet\s+report|wallet\s+scan|is\s+this\s+wallet\s+worth|should\s+i\s+copy|copy\s+this\s+wallet|worth\s+monitoring\s+wallet|wallet\s+analysis|scan\s+(?:[a-z0-9][a-z0-9-]*\.(?:base\.eth|cb\.id|eth))\b)\b/i;
  if (WALLET_SCAN_PATTERNS_RE.test(t) || (address && /\bscan\s+wallet\b/i.test(t))) {
    return { intent: "wallet_analysis", address };
  }
  // Wallet balance/holdings takes priority when address is present
  if (address && WALLET_INTENT_RE.test(t)) {
    return { intent: "wallet_analysis", address };
  }
  if (MARKET_INTENT_RE.test(t)) {
    return { intent: "general_market", address };
  }
  if (/whale|smart money/i.test(t)) {
    return { intent: "whale_alert", address };
  }
  if (/\b(dev\s+wallet|deployer|who\s+deployed|who\s+made\s+this|who\s+built|who\s+created|check\s+creator|origin\s+wallet|is\s+the\s+dev|check\s+dev|deployer\s+of)\b/i.test(t)) {
    return { intent: "dev_wallet", address };
  }
  if (/\b(liquidity\s+check|lp\s+status|is\s+liquidity\s+locked|is\s+lp\s+locked|check\s+pool\s+safety|liquidity\s+safety|is\s+this\s+pool\s+safe|check\s+liquidity\s+control|is\s+liquidity\s+burnt|lp\s+locked|check\s+lp)\b/i.test(t)) {
    return { intent: "liquidity_safety", address };
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
    if (intent === "trading_boundary" || intent === "financial_advice" || intent === "capabilities") return "casual_help";
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
  if (intent === "trading_boundary" || intent === "financial_advice" || intent === "capabilities") return "casual_help";
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

function buildTradingBoundaryReply(): string {
  return "I can't trade, execute swaps, or move funds for you. I can help you analyze token risk, wallet behavior, liquidity, holder concentration, and whale activity so you can make your own decision. If you want, send a CA or wallet and I'll build a checklist.";
}

function buildFinancialAdviceReply(prompt: string): string {
  const subject = extractAddress(prompt) ?? extractTokenLookupQuery(prompt) ?? "this setup";
  return [
    `I can't give direct buy/sell orders on ${subject}.`,
    "Risk read: treat momentum entries as high-risk until liquidity depth, holder concentration, and deployer behavior are verified.",
    "Bull case: sustained volume with healthy liquidity and no major contract/deployer red flags.",
    "Bear case: thin liquidity, concentrated holders, or suspicious privilege/flow signals.",
    "Missing checks: LP control, top holder concentration, tax/honeypot flags, and recent whale flow.",
    "What to watch next: volume vs liquidity trend, holder concentration changes, and wallet flow quality.",
    "Not financial advice.",
  ].join("\n");
}

function compactHistory(history: ClarkRequestBody["history"]): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(history)) return [];
  return history
    .map((m) => ({
      role: (m?.role === "assistant" || m?.role === "clark" ? "assistant" : "user") as "user" | "assistant",
      content: typeof m?.content === "string" ? m.content.trim() : "",
    }))
    .filter((m) => m.content.length > 0)
    .slice(-10);
}

function buildHistoryContextText(history: ClarkRequestBody["history"]): string {
  const compact = compactHistory(history);
  if (!compact.length) return "";
  return compact.map((m) => `${m.role === "user" ? "User" : "Clark"}: ${m.content}`).join("\n");
}

function getHistoryMessages(history: ClarkRequestBody["history"]): string[] {
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => (typeof h?.content === "string" ? h.content : ""))
    .filter(Boolean)
    .slice(-12);
}

type ClarkTokenContext = {
  address: string | null;
  name: string | null;
  symbol: string | null;
};

type ClarkQuestionType =
  | "casual"
  | "education"
  | "market_overview"
  | "token_scan"
  | "token_full_report"
  | "token_liquidity_followup"
  | "token_dev_followup"
  | "token_safety_followup"
  | "token_move_explainer"
  | "wallet_balance"
  | "wallet_quality"
  | "wallet_strategy"
  | "compare_request"
  | "unknown_general";

type ClarkResolvedContext = {
  lastToken: ClarkTokenContext;
  lastWallet: string | null;
  lastMarketSymbols: string[];
  lastIntent: ClarkPlannerIntent | "unknown";
  userWantsFollowup: boolean;
  explicitAddress: string | null;
  explicitSymbol: string | null;
  questionType: ClarkQuestionType;
};

function extractLastTokenContext(historyLines: string[]): ClarkTokenContext {
  for (let i = historyLines.length - 1; i >= 0; i--) {
    const line = historyLines[i] ?? "";
    const contractMatch =
      line.match(/Contract:\s*(0x[a-fA-F0-9]{40})/i) ??
      line.match(/Token resolved:[^\n]*\((0x[a-fA-F0-9]{40})\)/i) ??
      line.match(/^\s*\d+\.\s+[^\n]*?(0x[a-fA-F0-9]{40})/m) ??
      line.match(/(0x[a-fA-F0-9]{40})/);
    const assetMatch = line.match(/Asset:\s*([^\n(]+)\s*\(([^)\n]+)\)/i);
    if (contractMatch?.[1]) {
      return {
        address: contractMatch[1],
        name: assetMatch?.[1]?.trim() ?? null,
        symbol: assetMatch?.[2]?.trim() ?? null,
      };
    }
  }
  return { address: null, name: null, symbol: null };
}

function extractLastWalletContext(historyLines: string[]): string | null {
  for (let i = historyLines.length - 1; i >= 0; i--) {
    const line = historyLines[i] ?? "";
    if (/wallet/i.test(line)) {
      const addr = extractAddress(line);
      if (addr) return addr;
    }
  }
  return null;
}

function extractLastTokenScanFromHistory(history: ClarkRequestBody["history"]): { contractAddress: string; scanText: string } | null {
  const lines = getHistoryMessages(history);
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = lines[i] ?? "";
    if (!msg.includes("TOKEN SCAN READ") && !msg.includes("CLARK TOKEN SCAN")) continue;
    const m = msg.match(/Contract:\s*(0x[a-fA-F0-9]{40})/i);
    if (m?.[1]) return { contractAddress: m[1], scanText: msg };
  }
  return null;
}

function isBareAddressPrompt(prompt: string): boolean {
  const stripped = prompt.replace(/0x[a-fA-F0-9]{40}/gi, "").trim();
  return /^(here|this|that|it|here it is|this is it)?[\s,.\-:]*$/i.test(stripped);
}

function hasRecentWalletContext(history: ClarkRequestBody["history"]): boolean {
  const WALLET_CONTEXT_RE = /\b(wallet[\s-]?scan|base[\s-]?wallet|check[\s-]?wallet|analyze[\s-]?wallet|this[\s-]?is[\s-]?a[\s-]?wallet|scan[\s-]?a[\s-]?wallet|wallet[\s-]?address|wallet[\s-]?analysis)\b/i;
  const lines = getHistoryMessages(history);
  for (let i = Math.max(0, lines.length - 6); i < lines.length; i++) {
    if (WALLET_CONTEXT_RE.test(lines[i] ?? "")) return true;
  }
  return false;
}

function resolveClarkContext(message: string, history: ClarkRequestBody["history"]): ClarkResolvedContext {
  const historyLines = getHistoryMessages(history);
  const normalized = message.trim().toLowerCase();
  const explicitAddress = extractAddress(message);
  const explicitSymbol = explicitAddress ? null : extractTokenLookupQuery(message);
  const lastToken = extractLastTokenContext(historyLines);
  const lastWallet = extractLastWalletContext(historyLines);
  const marketText = historyLines.slice(-3).join("\n");
  const lastMarketSymbols = [...marketText.matchAll(/\b[A-Z]{2,6}\b/g)].map((m) => m[0]).slice(0, 5);
  const followupWords = /\b(it|this|this token|this wallet|what about|go deeper|why|is it safe|dev wallet|liquidity|holders|risks|more)\b/i.test(normalized);
  const shortFollowup = /^(go|next|continue|deeper|full report|why|is it risky|what should i watch)$/i.test(normalized);
  const lastIntent: ClarkPlannerIntent | "unknown" =
    /TOKEN SCAN READ|CLARK TOKEN SCAN|CLARK FULL REPORT|Bull case|Bear case/i.test(marketText) ? "token_full_report_request" :
    /Which Base token should I run the full report on/i.test(marketText) ? "token_full_report_request" :
    /I can run that, but I need a token contract first/i.test(marketText) ? "token_analysis" :
    /DEV WALLET READ|Dev wallet read:/i.test(marketText) ? "dev_wallet" :
    /Liquidity read:/i.test(marketText) ? "liquidity_safety" :
    /WALLET READ|Wallet:|wallet quality|Asset: Wallet/i.test(marketText) ? "wallet_quality" :
    /Base Market|what'?s pumping|movers?/i.test(marketText) ? "market" :
    "unknown";

  const questionType = classifyClarkQuestionType(normalized, { explicitAddress, explicitSymbol, lastToken, lastWallet, lastIntent, followupWords });
  return {
    lastToken,
    lastWallet,
    lastMarketSymbols,
    lastIntent,
    userWantsFollowup: followupWords || shortFollowup,
    explicitAddress,
    explicitSymbol,
    questionType,
  };
}

function classifyClarkQuestionType(
  normalized: string,
  ctx: {
    explicitAddress: string | null;
    explicitSymbol: string | null;
    lastToken: ClarkTokenContext;
    lastWallet: string | null;
    lastIntent: ClarkPlannerIntent | "unknown";
    followupWords: boolean;
  }
): ClarkQuestionType {
  if (/^(hi|hey|hello|yo|gm|sup)\b/.test(normalized)) return "casual";
  if (/what can you do|help|who are you|how do i find whale wallets|what are red flags in a token|how do i find early wallets/.test(normalized)) return "unknown_general";
  if (/what\s+(?:does|is|are)\s+(?:volume[-\s]led|tradable\s+depth|microcap\s+noise|liquidity\s+depth|lp\s+control|liquidity\s+control|turnover|market\s+cap\s+unverified|unverified\s+market\s+cap|holder\s+concentration|token\s+safety|fdv|market\s+cap|slippage|dev\s+wallet|honeypot|whale\s+alert|pump\s+alert|base\s+radar)/.test(normalized)) return "education";
  if (/what\s+does\s+.{1,40}\s+mean\??$|explain\s+.{1,60}$/.test(normalized) && !ctx.explicitAddress) return "education";
  if (/what is liquidity risk|what is a dev wallet|lp lock|slippage/.test(normalized)) return "education";
  if (/holder concentration/.test(normalized) && !ctx.explicitSymbol && !ctx.explicitAddress) return "education";
  if (/what should i watch|why are base memes moving|strategy|framework/.test(normalized)) return "market_overview";
  if (/what'?s pumping on base|moving on base|trending|movers|gainers|what'?s hot on base|hot on base|base market|trending on base|top base tokens|what'?s happening on base|base radar/.test(normalized)) return "market_overview";
  if (/full report|deep scan|full analysis|run all checks|report on/.test(normalized)) return "token_full_report";
  if (ctx.explicitAddress && ctx.lastIntent === "token_full_report_request") return "token_full_report";
  if (ctx.explicitAddress && ctx.lastIntent === "liquidity_safety") return "token_liquidity_followup";
  if (ctx.explicitAddress && ctx.lastIntent === "dev_wallet") return "token_dev_followup";
  if (/what about liquidity|explain the lp risk/.test(normalized) && (ctx.lastToken.address || ctx.followupWords)) return "token_liquidity_followup";
  if (/what about the dev wallet|dev wallet/.test(normalized) && (ctx.lastToken.address || ctx.followupWords)) return "token_dev_followup";
  if (/(is it safe|is this token safe|token safe\??)/.test(normalized) && (ctx.lastToken.address || ctx.explicitAddress || ctx.explicitSymbol)) return "token_safety_followup";
  if (/why is it moving|why is token\s+\d+\s+moving|explain the move/.test(normalized) && (ctx.lastToken.address || ctx.explicitAddress || ctx.explicitSymbol || ctx.followupWords)) return "token_move_explainer";
  if (/balance|holdings?|portfolio|tell me the balance/.test(normalized) && (ctx.explicitAddress || ctx.lastWallet)) return "wallet_balance";
  if (/(good wallet|worth tracking|copy trade|smart money|wallet quality|is this a good wallet)/.test(normalized) && (ctx.explicitAddress || ctx.lastWallet || ctx.followupWords)) return "wallet_quality";
  if (/copy trade|wallet worth tracking|why is this wallet worth tracking/.test(normalized)) return "wallet_strategy";
  if (/compare .*wallet/.test(normalized)) return "compare_request";
  if (/^(go|next|continue|deeper|full report|why|is it risky|what should i watch)$/.test(normalized) && (ctx.lastToken.address || ctx.followupWords)) return "token_scan";
  // "who deployed X?" / "dev wallet for X?" with a named token — must route before generic token_scan
  if (/who\s+(?:deployed|built|created|made)|deployer\s+of|creator\s+wallet(?:\s+(?:for|of))?|dev\s+wallet\s+(?:for|of)\b/.test(normalized) && ctx.explicitSymbol) return "token_dev_followup";
  // "liquidity safe for X?" / "lp safe X?" with a named token — route before generic token_scan
  if (/(?:liquidity|lp)\s+safe(?:ty)?(?:\s+(?:for|of|on|check))?|is\s+(?:liquidity|lp)\s+safe(?:ty)?/.test(normalized) && ctx.explicitSymbol) return "token_liquidity_followup";
  // Wallet address present and prompt contains wallet keyword — route wallet before token_scan
  if (ctx.explicitAddress && /\bwallet\b/i.test(normalized)) return "wallet_quality";
  if (/scan|check|token scan|contract/.test(normalized) || ctx.explicitAddress || ctx.explicitSymbol) return "token_scan";
  return "unknown_general";
}

function planClarkInvestigation(context: ClarkResolvedContext): { intent: ClarkPlannerIntent; forceAddress: string | null } {
  switch (context.questionType) {
    case "casual": return { intent: "casual", forceAddress: null };
    case "education": return { intent: "educational", forceAddress: null };
    case "market_overview": return { intent: "market", forceAddress: null };
    // Explicit token name wins — only fall back to lastToken when the user hasn't named a different token
    case "token_full_report": return { intent: "token_full_report_request", forceAddress: context.explicitAddress ?? (context.explicitSymbol ? null : context.lastToken.address) };
    case "token_liquidity_followup": return { intent: "liquidity_safety", forceAddress: context.explicitAddress ?? context.lastToken.address };
    case "token_dev_followup": return { intent: "dev_wallet", forceAddress: context.explicitAddress ?? context.lastToken.address };
    case "token_safety_followup": return { intent: "token_full_report_request", forceAddress: context.explicitAddress ?? context.lastToken.address };
    case "token_move_explainer": return { intent: "token_analysis", forceAddress: context.explicitAddress ?? context.lastToken.address };
    case "wallet_balance": return { intent: "wallet_balance", forceAddress: context.explicitAddress ?? context.lastWallet };
    case "wallet_quality":
    case "wallet_strategy": return { intent: "wallet_quality", forceAddress: context.explicitAddress ?? context.lastWallet };
    case "compare_request": return { intent: "wallet_compare_request", forceAddress: null };
    case "token_scan": return { intent: "token_analysis", forceAddress: context.explicitAddress ?? (context.explicitSymbol ? null : context.lastToken.address) };
    default: return { intent: "strategy", forceAddress: null };
  }
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

type MarketListItem = { rank: number; symbol: string; address: string; line: string };
type StructuredMarketItem = {
  rank: number;
  symbol: string;
  name?: string | null;
  tokenAddress?: string | null;
  poolAddress?: string | null;
  reasonTag?: string | null;
  price?: number | null;
  liquidity?: number | null;
  volume24h?: number | null;
  change24h?: number | null;
};

function normalizeStructuredMarketItems(source: unknown): StructuredMarketItem[] {
  if (!Array.isArray(source)) return [];
  const items: StructuredMarketItem[] = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
    if (!Number.isFinite(rank) || rank < 1) continue;
    const symbol = typeof row.symbol === "string" ? row.symbol.trim() : "";
    const tokenAddress = typeof row.tokenAddress === "string" ? row.tokenAddress.trim() : null;
    const poolAddress = typeof row.poolAddress === "string" ? row.poolAddress.trim() : null;
    items.push({
      rank: Math.floor(rank),
      symbol: symbol || "?",
      name: typeof row.name === "string" ? row.name : null,
      tokenAddress,
      poolAddress,
      reasonTag: typeof row.reasonTag === "string" ? row.reasonTag : null,
      price: typeof row.price === "number" ? row.price : null,
      liquidity: typeof row.liquidity === "number" ? row.liquidity : null,
      volume24h: typeof row.volume24h === "number" ? row.volume24h : null,
      change24h: typeof row.change24h === "number" ? row.change24h : null,
    });
  }
  return items.sort((a, b) => a.rank - b.rank);
}

function extractStructuredMarketItems(body: ClarkRequestBody): StructuredMarketItem[] {
  const fromRecentMovers = normalizeStructuredMarketItems(body.recentMovers);
  if (fromRecentMovers.length) return fromRecentMovers;
  if (body.moversContext && typeof body.moversContext === "object") {
    const moversObj = body.moversContext as Record<string, unknown>;
    const fromMoversItems = normalizeStructuredMarketItems(moversObj.items);
    if (fromMoversItems.length) return fromMoversItems;
    const fromMoversDirect = normalizeStructuredMarketItems(body.moversContext);
    if (fromMoversDirect.length) return fromMoversDirect;
  }
  const fromClarkContext = normalizeStructuredMarketItems(body.clarkContext?.lastMarketList);
  if (fromClarkContext.length) return fromClarkContext;
  const contextObj = (body.context && typeof body.context === "object") ? body.context as Record<string, unknown> : null;
  const fromContextRecentMovers = normalizeStructuredMarketItems(contextObj?.recentMovers);
  if (fromContextRecentMovers.length) return fromContextRecentMovers;
  const fromContextList = normalizeStructuredMarketItems(contextObj?.marketList);
  if (fromContextList.length) return fromContextList;
  const contextMarketObj = contextObj?.marketContext;
  if (contextMarketObj && typeof contextMarketObj === "object") {
    const fromContextMarketItems = normalizeStructuredMarketItems((contextMarketObj as Record<string, unknown>).items);
    if (fromContextMarketItems.length) return fromContextMarketItems;
  }
  if (body.marketContext && typeof body.marketContext === "object") {
    const fromTopMarketItems = normalizeStructuredMarketItems((body.marketContext as Record<string, unknown>).items);
    if (fromTopMarketItems.length) return fromTopMarketItems;
  }
  return [];
}

function extractMarketListItemsFromHistory(history: ClarkRequestBody["history"]): MarketListItem[] {
  const lines = getHistoryMessages(history);
  const items: MarketListItem[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const msg = lines[i] ?? "";
    if (!/Base Market|Moving now:|BASE MOMENTUM READ|BASE PUMP MAP|BASE RADAR|Strongest movers:/i.test(msg)) continue;
    const rows = msg.split("\n");
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? "";
      const rankMatch = row.match(/^\s*(\d{1,3})\.\s+/);
      if (!rankMatch) continue;
      const rank = Number(rankMatch[1]);
      // Match symbol with or without **bold** markdown wrapper
      const symbolMatch = row.match(/^\s*\d{1,3}\.\s*\*{0,2}([A-Z0-9$._-]{2,12})\*{0,2}\b/);
      const sym = symbolMatch?.[1] ?? "?";
      const fullAddress = row.match(/0x[a-fA-F0-9]{40}/)?.[0]
        ?? rows[r + 1]?.match(/0x[a-fA-F0-9]{40}/)?.[0]
        ?? null;
      const shortAddress = row.match(/0x[a-fA-F0-9]{4,8}\.\.\.[a-fA-F0-9]{3,8}/)?.[0]
        ?? rows[r + 1]?.match(/0x[a-fA-F0-9]{4,8}\.\.\.[a-fA-F0-9]{3,8}/)?.[0]
        ?? null;
      if (!fullAddress && shortAddress) {
        const maybeFull = msg.match(new RegExp(`${shortAddress.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^\\n]*(0x[a-fA-F0-9]{40})`, "i"))?.[1];
        if (maybeFull) {
          items.push({ rank, symbol: sym, address: maybeFull, line: row });
        } else if (sym !== "?") {
          // No address found — store symbol so rank selection still resolves via token_resolve
          items.push({ rank, symbol: sym, address: "", line: row });
        }
        continue;
      }
      if (fullAddress) {
        items.push({ rank, symbol: sym, address: fullAddress, line: row });
      } else if (sym !== "?") {
        // BASE MOMENTUM READ rows have no address — store symbol for token_resolve fallback
        items.push({ rank, symbol: sym, address: "", line: row });
      }
    }
    if (items.length > 0) break;
  }
  return items.sort((a, b) => a.rank - b.rank);
}

function inferSelectionIndex(
  trimmed: string,
  history: ClarkRequestBody["history"],
  marketList: Array<{ rank: number }> = [],
  lastSelectedRankFromContext?: number | null
): number | null {
  const direct =
    (/^\s*([1-9]\d{0,2})\s*$/.test(trimmed) ? Number(trimmed.match(/^\s*([1-9]\d{0,2})\s*$/)?.[1] ?? 0) : null) ??
    (/\b(?:scan|check|token|full report on|report(?: on)?|why is token|number|pick)\s+([1-9]\d{0,2})\b/.test(trimmed)
      ? Number(trimmed.match(/\b(?:scan|check|token|full report on|report(?: on)?|why is token|number|pick)\s+([1-9]\d{0,2})\b/)?.[1] ?? 0)
      : null) ??
    (/\b([1-9]\d{0,2})\s+of (?:them|those|the list|the candidates|all those)\b/.test(trimmed)
      ? Number(trimmed.match(/\b([1-9]\d{0,2})\s+of (?:them|those|the list|the candidates|all those)\b/)?.[1] ?? 0)
      : null) ??
    (/first one|that one|this one/.test(trimmed) ? 1 : null) ??
    (/second one/.test(trimmed) ? 2 : null) ??
    (/third one/.test(trimmed) ? 3 : null);
  if (direct) return direct;

  const list = marketList.length ? marketList : extractMarketListItemsFromHistory(history);
  if (!list.length) return null;
  const selectedRanks = getHistoryMessages(history).flatMap((line) => {
    const out: number[] = [];
    const m = line.match(/\b(?:scan|check|full report on|report on|token)\s+([1-9]\d{0,2})\b/i);
    if (m?.[1]) out.push(Number(m[1]));
    return out;
  });
  const lastSelected = (typeof lastSelectedRankFromContext === "number" && lastSelectedRankFromContext > 0)
    ? lastSelectedRankFromContext
    : (selectedRanks.length ? selectedRanks[selectedRanks.length - 1] : null);
  if (/\bnext one|next report|report the next one|scan next|full report next|next report on the next one|out of all those|of those|the ones above|the candidates|the list/i.test(trimmed)) {
    if (lastSelected) return Math.min(lastSelected + 1, list[list.length - 1]?.rank ?? lastSelected);
    return list[0]?.rank ?? null;
  }
  return null;
}

function resolveMarketTokenFromFollowup(
  trimmed: string,
  list: StructuredMarketItem[],
  lastSelectedRank?: number | null
): { item: StructuredMarketItem | null; ambiguous: StructuredMarketItem[] } {
  if (!list.length) return { item: null, ambiguous: [] };
  const ordered = [...list].sort((a, b) => a.rank - b.rank);
  const byRank = (rank: number) => ordered.find((x) => x.rank === rank) ?? null;
  const directRank = inferSelectionIndex(trimmed, [], ordered.map((m) => ({ rank: m.rank })), lastSelectedRank) ?? null;
  if (directRank) return { item: byRank(directRank), ambiguous: [] };
  if (/\b(that one|this one|it)\b/.test(trimmed) && lastSelectedRank) return { item: byRank(lastSelectedRank), ambiguous: [] };
  if (/\bnext\b/.test(trimmed)) {
    const nextRank = lastSelectedRank ? lastSelectedRank + 1 : ordered[0].rank;
    return { item: byRank(nextRank), ambiguous: [] };
  }
  const rawToken = trimmed.match(/^(?:scan|check|analy[sz]e|full report on|report on)?\s*([a-z0-9$._-]{2,32})$/i)?.[1]?.toLowerCase() ?? null;
  if (!rawToken) return { item: null, ambiguous: [] };
  const matches = ordered.filter((m) => {
    const symbol = (m.symbol ?? "").toLowerCase();
    const name = (m.name ?? "").toLowerCase();
    return symbol === rawToken || name === rawToken || symbol.includes(rawToken) || name.includes(rawToken);
  });
  if (matches.length === 1) return { item: matches[0], ambiguous: [] };
  if (matches.length > 1) return { item: null, ambiguous: matches.slice(0, 3) };
  return { item: null, ambiguous: [] };
}

function isMarketFollowupPrompt(prompt: string): boolean {
  const t = prompt.trim().toLowerCase();
  if (/^(more|give me more|other tokens|other ones|next|show more|continue)$/i.test(t)) return true;
  if (/\bgive me (other|20 more|100|500)\b/i.test(t)) return true;
  if (/which (is|one is|looks?|seems?) (safest?|best|cleanest|lowest.?risk|least.?risky|most promising)/i.test(t)) return true;
  if (/which (should i|would you|do you) (pick|buy|scan|check|go for|recommend|suggest|choose)/i.test(t)) return true;
  return false;
}

function isBaseMoversComparisonPrompt(prompt: string): boolean {
  const t = prompt.trim().toLowerCase();
  if (/which (is|one is|looks?|seems?) (safest?|best|cleanest|lowest.?risk|least.?risky|most promising)/i.test(t)) return true;
  if (/which (should i|would you|do you) (pick|buy|scan|check|go for|recommend|suggest|choose)/i.test(t)) return true;
  if (/\b(safest|lowest risk|cleanest) (one|token|pick|choice)\b/i.test(t)) return true;
  if (/^which one\??$/i.test(t)) return true;
  return false;
}

function buildMoversComparisonReply(movers: Array<{ rank: number; symbol: string }>, chain: string) {
  const top = movers.slice(0, 5);
  return {
    feature: "clark-ai",
    chain,
    mode: "analysis",
    intent: "market",
    toolsUsed: [] as string[],
    analysis: [
      "Clark doesn't certify any token as safe — every Base mover carries execution risk.",
      "",
      "What I can do is run a full on-chain report on any one and flag real signals: liquidity depth, holder concentration, honeypot simulation, dev wallet behavior.",
      "",
      "Pick a number to scan:",
      ...top.map(m => `${m.rank}. ${m.symbol} — type "scan ${m.rank}" for a full report`),
      "",
      "Liquidity depth and sell-tax simulation are the clearest risk proxies. I'll include both.",
    ].join("\n"),
  };
}

function parseMarketRequest(prompt: string): { count: number; mode: BaseMarketMode; wantsMore: boolean; strictDifferent: boolean; includePoolVariants: boolean } {
  const t = prompt.toLowerCase();
  const num = t.match(/\b(\d{1,3})\b/);
  const explicit = num ? Number(num[1]) : null;
  const wantsMore = /\b(more|continue|other tokens|next)\b/i.test(t);
  const strictDifferent = /\b(different tokens?|different base tokens?|other names|new names|not the same|no repeats|other tokens not the same)\b/i.test(t);
  const includePoolVariants = /\b(pools|all pools|same token pools|every pool|show all .* pools)\b/i.test(t);
  const count = explicit ? Math.min(100, explicit) : (wantsMore ? 10 : 10);
  const mode: BaseMarketMode =
    /new launch|new base launch/.test(t) ? "new_launches" :
    /microcap|degen|low cap|early/.test(t) ? "microcaps" :
    /cooling|pullback/.test(t) ? "cooling_watchlist" :
    /liquid/.test(t) ? "liquid_movers" :
    "pumping";
  return { count, mode, wantsMore, strictDifferent, includePoolVariants };
}

function normalizeMarketName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractSeenMarketState(body: ClarkRequestBody): {
  addresses: Set<string>;
  pools: Set<string>;
  symbols: Set<string>;
  names: Set<string>;
} {
  const addresses = new Set<string>();
  const pools = new Set<string>();
  const symbols = new Set<string>();
  const names = new Set<string>();

  const addFromRaw = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const row = raw as Record<string, unknown>;
    const tokenAddress = typeof row.tokenAddress === "string" ? row.tokenAddress.toLowerCase() : null;
    const poolAddress = typeof row.poolAddress === "string" ? row.poolAddress.toLowerCase() : null;
    const symbol = typeof row.symbol === "string" ? row.symbol.toUpperCase() : null;
    const name = typeof row.name === "string" ? normalizeMarketName(row.name) : null;
    if (tokenAddress?.startsWith("0x")) addresses.add(tokenAddress);
    if (poolAddress?.startsWith("0x")) pools.add(poolAddress);
    if (symbol) symbols.add(symbol);
    if (name) names.add(name);
  };

  for (const item of extractStructuredMarketItems(body)) addFromRaw(item);
  for (const line of getHistoryMessages(body.history)) {
    for (const m of line.matchAll(/0x[a-fA-F0-9]{40}/g)) addresses.add(m[0].toLowerCase());
    const rankRows = line.split("\n").filter((r) => /^\s*\d+\./.test(r));
    for (const row of rankRows) {
      const sm = row.match(/^\s*\d+\.\s*([A-Z0-9$._-]{2,12})/);
      if (sm?.[1]) symbols.add(sm[1].toUpperCase());
      const nm = row.match(/^\s*\d+\.\s*([^-—\n]+?)(?:\s+—|-)/);
      if (nm?.[1]) names.add(normalizeMarketName(nm[1]));
    }
  }

  for (const raw of body.clarkContext?.seenMarketAddresses ?? []) {
    if (typeof raw === "string" && /^0x[a-fA-F0-9]{40}$/.test(raw)) addresses.add(raw.toLowerCase());
  }
  for (const raw of body.clarkContext?.seenMarketSymbols ?? []) {
    if (typeof raw === "string" && raw.trim()) symbols.add(raw.toUpperCase());
  }

  return { addresses, pools, symbols, names };
}

function extractSeenTokenAddresses(history: ClarkRequestBody["history"]): string[] {
  const lines = getHistoryMessages(history);
  const out: string[] = [];
  for (const line of lines) {
    for (const m of line.matchAll(/0x[a-fA-F0-9]{40}/g)) out.push(m[0]);
  }
  return [...new Set(out.map((x) => x.toLowerCase()))];
}

function formatBaseMarketReply(candidates: BaseMarketCandidate[], total: number, offset: number, cappedMessage?: string | null, extended = false): string {
  const rows = candidates.map((c, i) => {
    const idx = offset + i + 1;
    const move = c.change24h != null ? `${c.change24h.toFixed(1)}% 24h` : "n/a 24h";
    const vol = formatUsdShort(c.volume24h);
    const liq = formatUsdShort(c.liquidityUsd);
    const reason = c.reasonTags[0] ?? "watch";
    const addr = c.tokenAddress ?? c.poolAddress ?? "unresolved";
    return `${idx}. ${c.symbol ?? "?"} — ${move}, vol ${vol}, liq ${liq} — ${reason}\n   Contract: ${addr}`;
  });
  const header = extended ? "BASE MARKET READ — extended list:" : "BASE MARKET READ";
  const read = candidates.some((c) => (c.liquidityUsd ?? 0) > 100_000)
    ? "This list is led by tokens with real liquidity, but there are still noisy runners mixed in."
    : "This feed is mostly thinner-liquidity momentum; treat fast moves as high-risk until depth confirms.";
  return [
    header,
    `Clark is seeing ${total} usable Base candidates from current pool data.`,
    cappedMessage ?? "",
    "",
    "Moving now:",
    ...rows,
    "",
    "Short read:",
    read,
    "Ranked by CORTEX momentum quality, not just raw percentage.",
    "Use market momentum as discovery only, then run single-token analysis before conviction.",
    "",
    "Next:",
    "Reply with a rank or symbol and I'll scan it.",
  ].filter(Boolean).join("\n");
}

function classifyPlannerIntent(prompt: string, address: string | null): ClarkPlannerIntent {
  const t = prompt.trim().toLowerCase();
  if (/^(hi|hey|hello|yo|gm|sup)\b/.test(t)) return "casual";
  if (/what can you do|help|who are you/.test(t)) return "help";
  if (/what\s+(?:does|is|are)\s+(?:volume[-\s]led|tradable\s+depth|microcap\s+noise|liquidity\s+depth|lp\s+control|liquidity\s+control|turnover|market\s+cap\s+unverified|unverified\s+market\s+cap|holder\s+concentration|token\s+safety|fdv|market\s+cap|slippage|dev\s+wallet|honeypot|whale\s+alert|pump\s+alert|base\s+radar)/i.test(t)) return "educational";
  if (/what\s+does\s+.{1,40}\s+mean\??$|explain\s+.{1,60}$/i.test(t)) return "educational";
  if (/what is liquidity risk|explain liquidity risk|what is a dev wallet|holder concentration|lp lock|what is slippage|explain slippage/i.test(t)) return "educational";
  if (/what should i watch|watch today|framework|strategy/i.test(t)) return "strategy";
  if (/full report|complete report|deep scan|full analysis|run all checks|scan this properly|is this token safe|give me the full report/.test(t)) return "token_full_report_request";
  if (/compare .*wallet/.test(t)) return "wallet_compare_request";
  if (/dev wallet|deployer|who deployed/.test(t)) return "dev_wallet";
  if (/liquidity|lp safe|liquidity risk/.test(t)) return "liquidity_safety";
  if (/balance|holdings?|portfolio|what does .*wallet hold|tell me the balance/.test(t) && address) return "wallet_balance";
  if (/(good wallet|worth following|copy[\s-]?trad|smart money|is it safe|wallet quality)/.test(t) && (address || /it\b/.test(t))) return "wallet_quality";
  if (/pumping on base|moving on base|trending|movers|gainers|runners|more|base tokens|show 100|give me 100|give me 20/.test(t)) return "market";
  if (/scan|token|contract|safe|risk|is this token safe|brett|0x[a-fA-F0-9]{40}/.test(t)) return "token_analysis";
  if (/\[mode\s*:|feature context|<token_data>|<wallet_scan>/i.test(prompt)) return "feature_context";
  return "unknown";
}

function buildClarkToolPlan(input: {
  message: string;
  mode?: string;
  uiModeHint?: string;
  context?: unknown;
  history?: ClarkRequestBody["history"];
  structuredMarketList?: StructuredMarketItem[];
  clarkContext?: ClarkRequestBody["clarkContext"];
}): ClarkToolPlan {
  const message = input.message ?? "";
  const historyLines = getHistoryMessages(input.history);
  const trimmed = message.trim().toLowerCase();
  const structuredMarketRows = (input.structuredMarketList ?? []).map((m) => ({
    rank: m.rank,
    symbol: m.symbol ?? "?",
    address: m.tokenAddress ?? m.poolAddress ?? "",
    line: `${m.rank}. ${m.symbol ?? "?"}`,
  }));
  const marketItems = structuredMarketRows.length ? structuredMarketRows : extractMarketListItemsFromHistory(input.history);
  const selectedOptionIndex = inferSelectionIndex(trimmed, input.history, marketItems, input.clarkContext?.lastSelectedRank);
  const directAddress = extractAddress(message);
  // HARD PRIORITY OVERRIDE — dev_wallet and liquidity_safety by token name, before any classification
  if (!directAddress) {
    const _DEV_RE = /who\s+(?:deployed|built|created|made)|deployer\s+of|creator\s+wallet|dev\s+wallet\s+(?:for|of)/i;
    const _LIQ_RE = /(?:(?:liquidity|lp)\s+(?:safe(?:ty)?|check|status|for\b|locked)|is\s+(?:liquidity|lp)\s+safe|check\s+(?:liquidity|lp)|is\s+[a-z0-9._-]+\s+(?:lp\s+locked|lp\s+safe(?:ty)?|liquidity\s+safe))/i;
    if (_DEV_RE.test(message)) {
      const _tq = extractTokenLookupQuery(message);
      if (_tq) return { intent: "dev_wallet", tools: [{ name: "token_resolve", args: { query: _tq }, required: true }, { name: "dev_wallet_analyze", args: { address: "" }, required: true }], depth: "normal", followupContext: { address: null, lastTokenAddress: null, lastWalletAddress: null, marketFollowup: false, selectedOptionIndex: null } };
    }
    if (_LIQ_RE.test(message)) {
      const _tq = extractTokenLookupQuery(message);
      if (_tq) return { intent: "liquidity_safety", tools: [{ name: "token_resolve", args: { query: _tq }, required: true }, { name: "liquidity_analyze", args: { address: "" }, required: true }], depth: "normal", followupContext: { address: null, lastTokenAddress: null, lastWalletAddress: null, marketFollowup: false, selectedOptionIndex: null } };
    }
    const _HOLDER_RE = /\b(?:holder(?:s|\s+concentration|\s+distribution|\s+count)?|top\s+holders?|supply\s+concentration)\b/i;
    if (_HOLDER_RE.test(message)) {
      const _tq = extractTokenLookupQuery(message);
      if (_tq) return { intent: "token_analysis", tools: [{ name: "token_resolve", args: { query: _tq }, required: true }, { name: "token_scan", args: { address: "" }, required: true }], depth: "normal", followupContext: { address: null, lastTokenAddress: null, lastWalletAddress: null, marketFollowup: false, selectedOptionIndex: null } };
    }
  }
  // Follow-up: bare token symbol after liquidity_safety context (via lastIntent or recent history output)
  if (!directAddress && /^[a-z0-9._-]{2,32}$/i.test(trimmed)) {
    const _liqLastIntent = input.clarkContext?.lastIntent === "liquidity_safety";
    const _liqHistText = historyLines.join("\n").toLowerCase();
    const _liqHistContext = /\bliquidity(?:\s+safety\s+read|\/control\s+could\s+not|\s+read\b)|\bpool\s+depth:\s*unverified|\blp\s+control:/i.test(_liqHistText);
    const _liqGenericWords = new Set(["scan","check","go","next","ok","yes","no","hi","hey","why","what","how","show","run","full","report","safe","lp","liquidity","holder","holders","dev","wallet","more","it","this","that","do","is","and","the"]);
    if ((_liqLastIntent || _liqHistContext) && !_liqGenericWords.has(trimmed)) {
      const _fq = KNOWN_BASE_TOKEN_ALIASES[trimmed] ?? trimmed;
      return { intent: "liquidity_safety", tools: [{ name: "token_resolve", args: { query: _fq }, required: true }, { name: "liquidity_analyze", args: { address: "" }, required: true }], depth: "normal", followupContext: { address: null, lastTokenAddress: null, lastWalletAddress: null, marketFollowup: false, selectedOptionIndex: null } };
    }
  }
  const _selectedMarketItem = selectedOptionIndex
    ? marketItems.find((m) => m.rank === selectedOptionIndex)
    : null;
  const selectedAddress = selectedOptionIndex
    ? (_selectedMarketItem?.address || pickAddressBySelection(historyLines, selectedOptionIndex) || null)
    : null;
  // Symbol-only item from BASE MOMENTUM READ (no address) — use for token_resolve lookup
  const selectedSymbolLookup = (!selectedAddress && selectedOptionIndex && _selectedMarketItem?.symbol && _selectedMarketItem.symbol !== "?")
    ? _selectedMarketItem.symbol
    : null;
  const tokenContext = extractLastTokenContext(historyLines);
  const followupResolution = resolveMarketTokenFromFollowup(trimmed, input.structuredMarketList ?? [], input.clarkContext?.lastSelectedRank);
  const resolvedMarketItem = followupResolution.item;
  const resolvedContext = resolveClarkContext(message, input.history);
  const investigation = planClarkInvestigation(resolvedContext);
  const inferredAddress = directAddress ?? selectedAddress;
  const lastHistoryAddress = findLastAddressInTextList(historyLines);
  const marketFollowup = isMarketFollowupPrompt(message);
  const explicitFollowupRef = /\b(this token|this wallet|it|this one|that one|first one|second one|third one)\b/i.test(message);
  const tokenFollowupPrompt = /\b(what about the dev wallet|what about liquidity|is it safe|why is it moving|should i watch|what are the risks|go deeper|explain the lp risk|what about holders)\b/i.test(trimmed);
  let plannerIntent = investigation.intent ?? classifyPlannerIntent(message, inferredAddress);
  if (plannerIntent === "strategy" && (selectedAddress || /\btoken\b|\bpools?\b/.test(trimmed))) {
    plannerIntent = classifyPlannerIntent(message, inferredAddress);
  }
  if (selectedAddress && (plannerIntent === "unknown" || plannerIntent === "feature_context")) {
    const historyText = historyLines.join("\n").toLowerCase();
    plannerIntent = /full report|run the full report|token_full_report_request|report the next one|next report/.test(`${historyText}\n${trimmed}`)
      ? "token_full_report_request"
      : "token_analysis";
  }
  // selectedSymbolLookup: rank hit a symbol-only history item (BASE MOMENTUM READ with no address)
  if (!selectedAddress && selectedSymbolLookup && (plannerIntent === "unknown" || plannerIntent === "feature_context" || plannerIntent === "market" || plannerIntent === "strategy")) {
    const historyText = historyLines.join("\n").toLowerCase();
    plannerIntent = /full report|run the full report|token_full_report_request|report the next one|next report/.test(`${historyText}\n${trimmed}`)
      ? "token_full_report_request"
      : "token_analysis";
  }
  if (selectedAddress && /full report|report\b|deep scan|full analysis|run all checks/.test(trimmed)) {
    plannerIntent = "token_full_report_request";
  } else if (selectedAddress && /\b(show all .*pools|show all pools|all pools for|pools for|pool breakdown|token \d+ pools)\b/.test(trimmed)) {
    plannerIntent = "token_analysis";
  } else if (selectedAddress && /why is token|explain the move|why is it moving/.test(trimmed)) {
    plannerIntent = "token_analysis";
  }
  const reportFollowupIntent = plannerIntent === "token_full_report_request" || plannerIntent === "dev_wallet" || plannerIntent === "liquidity_safety";
  const allowHistoryEntity = Boolean(selectedOptionIndex || marketFollowup || explicitFollowupRef || reportFollowupIntent);
  let fallbackAddress = inferredAddress
    ?? resolvedMarketItem?.tokenAddress
    ?? resolvedMarketItem?.poolAddress
    ?? investigation.forceAddress
    ?? (allowHistoryEntity ? (tokenContext.address ?? lastHistoryAddress) : null);
  if (!inferredAddress && tokenContext.address && (tokenFollowupPrompt || reportFollowupIntent || plannerIntent === "token_analysis")) {
    fallbackAddress = tokenContext.address;
  }
  if (!fallbackAddress && resolvedMarketItem && (resolvedMarketItem.symbol || resolvedMarketItem.name)) {
    plannerIntent = "token_analysis";
  }
  // An explicit new token name always wins — do not inherit the previous scanned token's address.
  // This prevents "scan aero" after KAGE from silently rescanning KAGE.
  if (!directAddress && resolvedContext.explicitSymbol) {
    fallbackAddress = null;
  }
  if (plannerIntent === "unknown" && tokenFollowupPrompt && (fallbackAddress || resolvedMarketItem)) {
    plannerIntent = /dev wallet|deployer/.test(trimmed)
      ? "dev_wallet"
      : /liquidity|lp/.test(trimmed)
        ? "liquidity_safety"
        : "token_analysis";
  }
  if (/^it\b/i.test(trimmed) && fallbackAddress) plannerIntent = plannerIntent === "unknown" ? "token_analysis" : plannerIntent;
  if (/^(is it safe|is this token safe)\??$/i.test(trimmed) && fallbackAddress) {
    const historyText = historyLines.join("\n").toLowerCase();
    if (/contract|token|scan|full report|asset:/i.test(historyText) && !/wallet:/i.test(historyText)) {
      plannerIntent = "token_full_report_request";
    }
  }
  if (directAddress && input.clarkContext?.lastIntent) {
    const lastIntent = input.clarkContext.lastIntent.toLowerCase();
    if (/full_report|full report|token_full_report_request/.test(lastIntent)) plannerIntent = "token_full_report_request";
    else if (/liquidity/.test(lastIntent)) plannerIntent = "liquidity_safety";
    else if (/dev_wallet|dev wallet/.test(lastIntent)) plannerIntent = "dev_wallet";
    else if (/move|moving/.test(lastIntent)) plannerIntent = "token_analysis";
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
  const fallbackQuery = !fallbackAddress && resolvedMarketItem
    ? (resolvedMarketItem.symbol || resolvedMarketItem.name || "").toString()
    : "";
  // selectedSymbolLookup: rank-selection hit a history item with no address (BASE MOMENTUM READ)
  const effectiveTokenLookup = tokenLookup || fallbackQuery || selectedSymbolLookup || null;
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
      if (fallbackAddress) {
        tools.push({ name: "dev_wallet_analyze", args: { address: fallbackAddress }, required: true });
      } else if (effectiveTokenLookup) {
        tools.push({ name: "token_resolve", args: { query: effectiveTokenLookup }, required: true });
        tools.push({ name: "dev_wallet_analyze", args: { address: "" }, required: true });
      }
      break;
    case "liquidity_safety":
      if (fallbackAddress) {
        tools.push({ name: "liquidity_analyze", args: { address: fallbackAddress }, required: true });
      } else if (effectiveTokenLookup) {
        tools.push({ name: "token_resolve", args: { query: effectiveTokenLookup }, required: true });
        tools.push({ name: "liquidity_analyze", args: { address: "" }, required: true });
      }
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
      if (!fallbackAddress && effectiveTokenLookup) {
        tools.push({ name: "token_resolve", args: { query: effectiveTokenLookup }, required: true });
      } else if (fallbackAddress && looksWallet) {
        tools.push({ name: "wallet_get_snapshot", args: { address: fallbackAddress }, required: false });
      } else if (fallbackAddress) {
        tools.push({ name: "token_scan", args: { address: fallbackAddress }, required: true });
      }
      break;
    default:
      break;
  }

  if (process.env.NODE_ENV !== 'production') {
    const routeDecision = !directAddress && resolvedContext.explicitSymbol ? 'explicit_token'
      : directAddress ? 'contract'
      : selectedOptionIndex != null ? 'movers_followup'
      : tokenFollowupPrompt || explicitFollowupRef ? 'vague_followup'
      : 'fallback';
    console.log('[clark-route]', JSON.stringify({
      message: message.slice(0, 80),
      intent: plannerIntent,
      routeDecision,
      address: fallbackAddress,
      symbol: resolvedContext.explicitSymbol,
    }));
  }
  return {
    intent: plannerIntent,
    tools,
    depth,
    followupContext,
  };
}


function normalizePromptForIntent(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const BASE_RADAR_HARD_ROUTE_PHRASES = [
  "what's happening on base",
  "whats happening on base",
  "what is happening on base",
  "what's hot on base",
  "whats hot on base",
  "summarize base radar",
  "base radar",
  "base market",
  "trending on base",
  "what's trending on base",
  "top base tokens",
  "base movers",
];

function isBaseRadarHardRoutePrompt(prompt: string): boolean {
  const t = normalizePromptForIntent(prompt);
  return BASE_RADAR_HARD_ROUTE_PHRASES.some((phrase) => t.includes(phrase));
}
function buildEducationalReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/liquidity risk/.test(t)) return "Liquidity risk is the chance you can't exit cleanly—usually from low depth, unlocked LP, or concentrated LP ownership.";
  if (/slippage/.test(t)) return "Slippage is the price impact between quoted and executed price. Thin liquidity and large orders increase slippage and worsen entries/exits.";
  if (/dev wallet/.test(t)) return "A dev wallet is a deployer-linked wallet that can reveal insider coordination, funding links, or early sell pressure.";
  if (/holder concentration/.test(t)) return "Holder concentration means too much supply sits in a few wallets, increasing dump and manipulation risk.";
  if (/lp lock/.test(t)) return "LP lock matters because unlocked liquidity can be pulled, which can collapse tradability and price.";
  if (/market cap/.test(t)) return "Market cap is the total value of all circulating tokens at current price. Low market cap means a small move in price requires less volume — high volatility, both directions.";
  if (/fdv/.test(t)) return "FDV (fully diluted valuation) is market cap calculated using the max token supply, not just circulating. High FDV vs market cap means there's a lot of future dilution risk.";
  if (/honeypot/.test(t)) return "A honeypot token lets you buy but blocks selling via a contract-level restriction. Always check sell simulation before entering any new token.";
  if (/whale alert/.test(t)) return "Whale Alerts track large on-chain moves from monitored wallets. HIGH SIGNAL means the move is large, repeated, or from a tracked active wallet. WATCH means it's noteworthy but unconfirmed direction.";
  if (/pump alert/.test(t)) return "Pump Alerts filter momentum tokens by volume expansion, price change, and liquidity quality. HIGH MOMENTUM means the move is broad and volume-backed; THIN MOONSHOT means big % move but thin liquidity.";
  if (/base radar/.test(t)) return "Base Radar aggregates live Base chain pool data to surface the top movers by volume, price change, and liquidity depth. It's a discovery feed — not a trade signal.";
  if (/volume.led/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "The move is backed by real trading volume, not only a tiny-liquidity price spike.",
    "",
    "Why it matters:",
    "Volume support can make a move more worth watching, but it still does not prove safety.",
    "",
    "How Clark uses it:",
    "CORTEX compares volume against liquidity depth. High volume with usable liquidity is a stronger signal than high price change with no depth.",
    "",
    "No trade call.",
  ].join("\n");
  if (/tradable.*depth|depth.*tradable/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "Tradable depth is the real liquidity available to buy or sell without causing major price impact.",
    "",
    "Why it matters:",
    "Thin depth means a large trade can move price significantly — making exits harder and slippage worse.",
    "",
    "How Clark uses it:",
    "CORTEX flags tokens where depth is too thin for clean execution. This is separate from just showing a high price change.",
    "",
    "No trade call.",
  ].join("\n");
  if (/microcap.*noise|noise.*microcap/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "A token with very small market cap or liquidity where price moves easily on low volume.",
    "",
    "Why it matters:",
    "Microcap noise tokens can show big % moves on tiny trades — the signal is unreliable.",
    "",
    "How Clark uses it:",
    "CORTEX labels tokens as microcap noise when liquidity or market cap is too small to trust the price action.",
    "",
    "No trade call.",
  ].join("\n");
  if (/turnover/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "Turnover is the ratio of 24h trading volume to liquidity. High turnover means the pool is cycling through its full depth many times per day.",
    "",
    "Why it matters:",
    "Very high turnover can indicate heavy attention but also increases slippage and churn risk.",
    "",
    "How Clark uses it:",
    "CORTEX computes volume/liquidity ratio. Ratio above 8x is flagged as extreme turnover.",
    "",
    "No trade call.",
  ].join("\n");
  if (/liquidity\s+depth|depth.*liquidity/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "Liquidity depth is the total value locked in the trading pool, available for buys and sells.",
    "",
    "Why it matters:",
    "Deep liquidity means less slippage and more resilient price action. Thin liquidity means small trades can move price a lot.",
    "",
    "How Clark uses it:",
    "CORTEX classifies depth as strong (>$1M), moderate ($300K–$1M), or thin (<$300K). Thin depth is a risk flag.",
    "",
    "No trade call.",
  ].join("\n");
  if (/market.?cap.*unverified|unverified.*market.?cap/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "Market cap unverified means CORTEX could not confirm the circulating supply from available data, so the shown value is an estimate.",
    "",
    "Why it matters:",
    "An unverified market cap may over- or understate the real value. FDV is shown as a fallback when circulating supply is unavailable.",
    "",
    "How Clark uses it:",
    "CORTEX labels market cap clearly: confirmed, estimated, or FDV fallback. Treat unverified readings as approximate only.",
    "",
    "No trade call.",
  ].join("\n");
  if (/lp\s+control|liquidity\s+control|control.*lp/i.test(t)) return [
    "TERM EXPLAINER",
    "",
    "Meaning:",
    "LP control refers to who can remove or modify the liquidity pool — the deployer, a multisig, or no one if locked.",
    "",
    "Why it matters:",
    "If LP control is not locked, the owner can pull liquidity at any time, collapsing the price.",
    "",
    "How Clark uses it:",
    "CORTEX checks LP lock/control status. If unverified, Clark will never say it is locked.",
    "",
    "No trade call.",
  ].join("\n");
  return "Great question. Share the exact risk concept and I'll break it down quickly.";
}

function buildClarkStrategyReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/what should i watch|watch on base today/.test(t)) {
    return "Focus on liquidity-backed movers, not just top gainers. Watch 24h volume/liquidity balance, sudden deployer-linked selling, and whether momentum holds after the first pullback.";
  }
  if (/base memes moving|why are base memes moving/.test(t)) {
    return "Base memes usually move when short-term liquidity rotates quickly into a few tickers. The key is whether volume is sustaining or just one burst with thin exits.";
  }
  if (/find whale wallets|early wallets/.test(t)) {
    return "Track wallets with repeatable entries before momentum expands, then verify they do not dump immediately on strength. Consistency of behavior matters more than wallet size alone.";
  }
  if (/red flags in a token/.test(t)) {
    return "Main red flags: unclear contract controls, thin liquidity, concentrated ownership, and suspicious deployer-linked flows. If two or more are unresolved, treat it as SCAN DEEPER or avoid.";
  }
  return "Share a token symbol/contract, a wallet address, or ask for Base movers and I'll run a live read.";
}

function detectLiveIntent(prompt: string): LiveIntent {
  const t = normalizePromptForIntent(prompt);
  if (/scan\s+0x[a-f0-9]{40}|check wallet|wallet\b/.test(t)) return "WALLET_QUERY";
  if (/what'?s pumping on base|what'?s trending on base|show base movers|what'?s moving on base|base trending|moving on base|what'?s happening on base radar|base radar|top movers on base|what'?s hot on base|hot on base|base market|trending on base|top base tokens|what'?s happening on base|summarize base/.test(t)) return "BASE_MARKET";
  if (/how is (ethereum|eth|bitcoin|btc)|market right now|crypto sentiment/.test(t)) return "MARKET_OVERVIEW";
  if (/scan\s+[a-z0-9._-]{2,32}|price of [a-z0-9._-]{2,32}|how is [a-z0-9._-]{2,32} going/.test(t)) return "TOKEN_QUERY";
  if (/\bexplain this whale alert\b|\bsummarize whale alert|\bsummarize whale|\bwhale alerts?\b|\bwhale moves?\b|\bwhales? selling\b|\bwhat are whales? (?:doing|buying)\b|\bwhales? buying\b|\bwhale buys?\b|\bstrongest whale\b|\bany accumulation\b|\bany distribution\b|\bwhat should i watch\b.*whale/i.test(t)) return "WHALE_FEED";
  // Row/page-level Ask Clark redirects carry structured alert data in the prompt text
  if (/\bsignal:\s*(high|watch|low)\b|\btop alerts:/i.test(t)) return "WHALE_FEED";
  return "GENERAL_CHAT";
}

function isWhaleFlowPrompt(message: string, history?: ClarkRequestBody["history"]): boolean {
  const t = message.toLowerCase().trim();
  if (extractAddress(message)) return false;
  const directWhalePrompt = /\b(show base whales|base whales|show whales|whale alerts|whale alert|whale moves|whale activity|smart money moves|whales selling|summarize whale|whale feed|what are whales buying on base|what whales are buying on base|what are whales buying|what whales are rotating into|what are whales rotating into|whale rotation|whale flows|base whale flows|smart money on base|what are smart wallets buying|what were whales buying last 7 days|last 7 days whale activity|last week whale activity|7d whale flows|whale buying|whale selling|whale movement|whales? buying\b|whale alerts? right now|show whale activity|whale accumulation|whale distribution)\b/i.test(t);
  if (directWhalePrompt) return true;
  const followupWhalePrompt = /\b(what are they rotating into|what are they buying|last 7 days|last week|7d)\b/i.test(t);
  if (!followupWhalePrompt) return false;
  const historyText = getHistoryMessages(history).join("\n").toLowerCase();
  return /\b(whale|whales|whale flow|whale alerts|smart money on base|whale rotation|whale activity|whale_feed_stored)\b/i.test(historyText);
}

async function handleStoredWhaleFlow(prompt: string, body: ClarkRequestBody, origin: string, authHeader?: string | null) {
  if (process.env.NODE_ENV === "development") console.log("[clark-render]", { matchedIntent: "whale_flow", rendererUsed: "row_level_whale", featureFromClient: body.feature, normalizedPrompt: normalizePromptForIntent(prompt) });
  return handleWhaleAlertFeed(prompt, body, origin, authHeader);
}

async function fetchCoinGeckoMajors() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true", { cache: "no-store" });
  if (!res.ok) throw new Error("coingecko majors failed");
  return res.json() as Promise<Record<string, { usd?: number; usd_24h_change?: number }>>;
}

function pct(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function fmtPrice(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  return value >= 1 ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${value.toFixed(6)}`;
}

function buildRoutingHelpReply(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/track a wallet|wallet/.test(t)) return "Use Wallet Scanner to track wallet behavior and flows, then ask Clark to summarize the risk read.";
  if (/deployer|dev wallet/.test(t)) return "Use Dev Wallet Detector with the token contract to check likely deployer links and suspicious wallet clusters.";
  if (/scan a token|token/.test(t)) return "Use Token Scanner with the contract address for contract and risk checks, then ask Clark for a final read.";
  return "Use Base Radar for discovery, Token Scanner for contract checks, Wallet Scanner for behavior, and Dev Wallet Detector for deployer risk.";
}

function isHolderQuestion(prompt: string): boolean {
  return /\b(how many holders|holders?\??|what about holders|holder count|holder distribution)\b/i.test(prompt.trim().toLowerCase());
}
function isPumpFeedPrompt(prompt: string): boolean {
  // Only explicit pump-alert feed requests — NOT general "pumping on base" market queries
  const t = prompt.toLowerCase()
  return /\b(what are pump alerts right now|show pump alerts|open pump alerts|pump alert feed|refresh pump alerts|high momentum alerts|latest pump alerts|which pump alerts matter)\b/i.test(t)
    || /^pump alerts?\b/i.test(prompt.trim().toLowerCase());
}

function isBaseMomentumPrompt(prompt: string): boolean {
  // Broad "what's pumping / running / moving on Base" → live Base market data, not pump-alerts feed
  // Normalize apostrophes/smart-quotes so what's / what's both match
  const t = prompt.toLowerCase().replace(/[‘’ʼ`´]/g, "'");
  return /(?:^|\s|[^a-z])(what's pumping on base|what tokens are pumping|what's running on base|what's moving up on base|show base pumps|base pumps|early movers on base|early movers|what tokens are running|momentum scan|base pump map|base momentum read|new deployments on base|new base deployments|what's hot on base right now|top base tokens|base runners|base gainers|what tokens are moving|what's moving|what's happening on base)/i.test(t)
    || /\b(pumping on base|base momentum|momentum on base)\b/i.test(t);
}

function isPumpSourceFollowupPrompt(prompt: string): boolean {
  return /\b(no like from coingecko api|is this from coingecko|where is this data from|why is data n\/a)\b/i.test(prompt.toLowerCase());
}

function parseMaybeNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatPctOrUnverified(value: unknown): string {
  const n = parseMaybeNumber(value);
  if (n == null) return "unverified 24h";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}% 24h`;
}

function formatUsdOrUnverified(value: unknown): string {
  const n = parseMaybeNumber(value);
  return n == null ? "unverified" : formatUsdShort(n);
}
function classifyMarketTokenLabel(liq: number | null, vol: number | null, fdv?: number | null, symbol?: string): string {
  const s = String(symbol ?? "").toUpperCase();
  if (new Set(["ETH", "WETH", "CBBTC", "BTC", "WBTC", "CBETH", "STETH", "WSTETH", "USDC", "USDT", "DAI", "USDBC", "EURC"]).has(s)) return "base asset";
  if (fdv != null && fdv > 0 && fdv < 100_000) return "microcap noise";
  if (liq != null && liq < 25_000) return "microcap noise";
  if (liq != null && liq >= 100_000 && vol != null && vol >= 500_000) return "liquid mover";
  if (liq != null && liq > 0 && vol != null && (vol / liq) >= 5) return "volume-led";
  if (liq != null && liq < 100_000) return "thin pump";
  return "needs scan";
}
function buildReasonLine(label: string): string {
  if (label === "liquid mover") return "volume is supported by tradable liquidity.";
  if (label === "volume-led") return "volume is strong vs liquidity, so follow-through matters.";
  if (label === "thin pump") return "the % move is strong, but slippage risk is elevated.";
  if (label === "microcap noise") return "size/depth is small, so this can be noisy.";
  if (label === "base asset") return "deep routing asset flow, not pure alpha rotation.";
  return "signal exists, but structure still needs verification.";
}
type WhaleGroup = { key: string; count: number; totalUsd: number; maxUsd: number; latestTs: number; sides: Set<string> };
function aggregateWhaleRows(rows: WhaleAlertRow[]) {
  const ROUTING = new Set(["USDC", "USDBC", "EURC", "DAI", "USDT", "WETH", "ETH", "CBBTC", "WSTETH"]);
  const groups = new Map<string, WhaleGroup>();
  const newestAlerts = [...rows]
    .sort((a, b) => (new Date(b.occurred_at ?? 0).getTime()) - (new Date(a.occurred_at ?? 0).getTime()))
    .slice(0, 15);
  for (const r of rows) {
    const sym = ((((r as Record<string, unknown>).focus_token_symbol as string | undefined) ?? r.token_symbol ?? "").toUpperCase()).split(" / ").find(Boolean) ?? "UNKNOWN";
    const key = sym.trim();
    const usd = typeof r.amount_usd === "number" && Number.isFinite(r.amount_usd) ? r.amount_usd : 0;
    const ts = r.occurred_at ? new Date(r.occurred_at).getTime() : 0;
    const side = String((r as Record<string, unknown>).side ?? "unknown").toLowerCase();
    const g = groups.get(key) ?? { key, count: 0, totalUsd: 0, maxUsd: 0, latestTs: 0, sides: new Set<string>() };
    g.count += 1; g.totalUsd += usd; g.maxUsd = Math.max(g.maxUsd, usd); g.latestTs = Math.max(g.latestTs, ts); g.sides.add(side); groups.set(key, g);
  }
  const arr = [...groups.values()];
  const nonStable = arr.filter(g => g.key !== "UNKNOWN" && !ROUTING.has(g.key));
  const repeatLeaders = [...nonStable].sort((a, b) => b.count - a.count);
  const valueLeaders = [...nonStable].sort((a, b) => b.totalUsd - a.totalUsd);
  const newestUniqueTokens = [...nonStable].sort((a, b) => b.latestTs - a.latestTs).slice(0, 5);
  const newestTs = newestAlerts[0]?.occurred_at ? new Date(newestAlerts[0].occurred_at).getTime() : 0;
  const usdCoverage = rows.length ? Math.round((rows.filter(r => typeof r.amount_usd === "number").length / rows.length) * 100) : 0;
  const clustered = repeatLeaders.length > 0 && (repeatLeaders[0].count / Math.max(1, nonStable.length ? nonStable.reduce((s, g) => s + g.count, 0) : 1)) > 0.4;
  return { newestAlerts, repeatLeaders, valueLeaders, newestUniqueTokens, nonStableCount: nonStable.length, newestTs, usdCoverage, clustered };
}
function pickBaseRadarTitle(prompt: string): string {
  const t = normalizePromptForIntent(prompt);
  if (/what'?s hot on base|whats hot on base/.test(t)) return "HOT ON BASE";
  if (/what'?s happening on base|whats happening on base|what is happening on base/.test(t)) return "BASE MARKET PULSE";
  if (/summarize base radar|base radar/.test(t)) return "BASE RADAR SUMMARY";
  return "BASE RADAR SNAPSHOT";
}
function pickWhaleTitle(prompt: string): string {
  const t = normalizePromptForIntent(prompt);
  if (/which whale alerts matter most|which alerts matter most/.test(t)) return "TOP WHALE ALERTS TO WATCH";
  if (/smart money/.test(t)) return "SMART MONEY SNAPSHOT";
  if (/whales? selling|sell-side/.test(t)) return "WHALE SELL-SIDE READ";
  if (/summary|summarize/.test(t)) return "WHALE ACTIVITY SUMMARY";
  return "WHALE FLOW READ";
}
function isBaseRadarPrompt(prompt: string): boolean {
  if (isBaseRadarHardRoutePrompt(prompt)) return true;
  return /\b(what'?s happening on base radar|show base radar|open base radar|base radar|base movers|what'?s moving on base|summarize base|what'?s hot on base|hot on base|base market|trending on base|top base tokens|what'?s happening on base|what'?s going on base|whats happening on base|whats hot on base|what is happening on base)\b/i.test(normalizePromptForIntent(prompt));
}
function isFeedSafestFollowup(prompt: string): boolean {
  return /\b(which one is safest|which is safest|what'?s the safest|which is cleanest|which one should i watch)\b/i.test(prompt.toLowerCase());
}
function wasLastFeedEmpty(history: ClarkRequestBody["history"]): boolean {
  const h = getHistoryMessages(history).slice(-4).join("\n").toLowerCase();
  return /(whale flow snapshot|pump alerts snapshot|base radar snapshot)/i.test(h) && /(feed is empty|feed is unavailable|no clean non-stable token signal|no clean candidates|empty right now|unavailable right now)/i.test(h);
}

async function handlePumpFeedSnapshot(origin: string) {
  const authHeader = clarkInternalCtx.authToken ? `Bearer ${clarkInternalCtx.authToken}` : undefined;
  const res = await fetch(`${origin}/api/pump-alerts`, {
    signal: AbortSignal.timeout(5000),
    headers: authHeader ? { authorization: authHeader } : {},
  });
  if (!res.ok) return "PUMP ALERTS READ\nNo fresh pump signal passed the current quality filter.";
  const json = await res.json();
  const alerts = Array.isArray(json?.alerts) ? (json.alerts as Record<string, unknown>[]) : [];
  if (!alerts.length) return "PUMP ALERTS READ\nNo fresh pump signal passed the current quality filter.";

  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const raw of alerts) {
    const key = String(raw.contract ?? raw.address ?? "").trim().toLowerCase() || `sym:${String(raw.symbol ?? "?").toUpperCase()}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(raw as Record<string, unknown>); }
  }

  const RISK_LABEL: Record<string, string> = { HIGH: 'HIGH RISK', MEDIUM: 'WATCH RISK', LOW: 'LOWER RISK' };
  const CAT_LABEL: Record<string, string> = { HIGH_MOMENTUM: 'High Momentum', VOLUME_EXPANSION: 'Vol Expansion', THIN_MOONSHOT: 'Thin Liquidity', WATCH: 'Watchlist' };

  const items = deduped.slice(0, 5);
  const rows = items.map((a, i) => {
    const symbol = String(a.symbol ?? "?").toUpperCase();
    const name = String(a.name ?? "").trim();
    const label = name && name.toUpperCase() !== symbol ? `${symbol} (${name})` : symbol;
    const change = a.change24h ?? a.priceChange24h;
    const liq = a.liquidityUsd ?? a.liquidity_usd;
    const vol = a.volume24hUsd ?? a.volume_usd;
    const fdv = a.fdvUsd ?? a.fdv_usd;
    const cat = CAT_LABEL[String(a.category ?? "")] ?? String(a.category ?? "Unknown");
    const risk = RISK_LABEL[String(a.riskLevel ?? "")] ?? String(a.riskLevel ?? "");
    const tags = Array.isArray(a.tags) && a.tags.length ? ` [${(a.tags as string[]).join(', ')}]` : '';
    const signal = String(a.reason ?? "Momentum candidate — verify before acting.");
    const liqNum = parseMaybeNumber(liq);
    const volNum = parseMaybeNumber(vol);
    const fdvNum = parseMaybeNumber(fdv);
    const cls = classifyMarketTokenLabel(liqNum, volNum, fdvNum, symbol);
    return `${i + 1}. ${label} — ${formatPctOrUnverified(change)} | Vol ${formatUsdOrUnverified(vol)} | Liq ${formatUsdOrUnverified(liq)} | ${cls}\n   Why: ${buildReasonLine(cls)} ${signal}`;
  });

  return [
    "PUMP ALERTS READ",
    "Momentum is active, but quality is mixed across the current leaders.",
    "Strongest candidates:",
    ...rows,
    "Risk notes: thin-liquidity and microcap names can print large % moves without stable follow-through.",
    "Next action: scan the cleanest non-stable mover first, then verify dev wallet + holders. No trade call — this is a watchlist read.",
  ].join("\n");
}


async function handleBasePumpMap(prompt: string, origin: string) {
  const authHeader = clarkInternalCtx.authToken ? `Bearer ${clarkInternalCtx.authToken}` : undefined;
  const EXCLUDED = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'WETH', 'ETH', 'CBBTC', 'BTC', 'WBTC', 'CBETH', 'STETH', 'WSTETH', 'EURC', 'BUSD', 'FRAX', 'USD+', 'AXLUSDC', 'BSDETH']);

  // Primary: live Base market/pool data from trending feed
  let tokens: Record<string, unknown>[] = [];
  try {
    const res = await fetch(`${origin}/api/trending`, {
      signal: AbortSignal.timeout(5500),
      headers: authHeader ? { authorization: authHeader } : {},
    });
    if (res.ok) {
      const json = await res.json();
      const all = Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
      tokens = all.filter(t => {
        const sym = String(t.symbol ?? '').toUpperCase();
        const ch = String(t.chain ?? '');
        return sym && !EXCLUDED.has(sym) && (ch === 'base' || ch === 'geckoterminal' || !ch);
      });
    }
  } catch { /* fallback to pump-alerts only */ }

  // Enrichment: pump-alerts as secondary source
  let pumpAlerts: Record<string, unknown>[] = [];
  try {
    const res = await fetch(`${origin}/api/pump-alerts`, {
      signal: AbortSignal.timeout(4000),
      headers: authHeader ? { authorization: authHeader } : {},
    });
    if (res.ok) {
      const json = await res.json();
      pumpAlerts = Array.isArray(json?.alerts) ? (json.alerts as Record<string, unknown>[]) : [];
    }
  } catch { /* optional — ignore */ }

  // Merge: trending tokens first, then non-duplicate pump-alert items
  const merged: Record<string, unknown>[] = [...tokens];
  const seenSymbols = new Set(tokens.map(t => String(t.symbol ?? '').toUpperCase()));
  for (const pa of pumpAlerts) {
    const sym = String(pa.symbol ?? '').toUpperCase();
    if (sym && !seenSymbols.has(sym) && !EXCLUDED.has(sym)) {
      seenSymbols.add(sym);
      merged.push({
        symbol: pa.symbol,
        name: pa.name,
        change24h: pa.change24h ?? pa.priceChange24h,
        volume: pa.volume24hUsd ?? pa.volume_usd,
        liquidity: pa.liquidityUsd ?? pa.liquidity_usd,
        fdv: pa.fdvUsd ?? pa.fdv_usd,
      });
    }
  }

  if (!merged.length) {
    return { analysis: "BASE MOMENTUM READ\n\nLive Base pool data is incomplete right now. I can still show the available momentum signals, but verify liquidity before acting.\n\nTry again in a moment, or paste a contract address for a direct token scan.", items: [] };
  }

  // Rank: 24h change desc, then volume, then liquidity — filter zero-liquidity noise
  const withLiq = merged.filter(t => Number(t.liquidity ?? 0) > 0 || Number(t.volume ?? 0) > 0);
  const rankSource = withLiq.length >= 3 ? withLiq : merged;
  const ranked = [...rankSource].sort((a, b) => {
    const chDiff = Number(b.change24h ?? 0) - Number(a.change24h ?? 0);
    if (Math.abs(chDiff) > 0.1) return chDiff;
    const volDiff = Number(b.volume ?? 0) - Number(a.volume ?? 0);
    if (Math.abs(volDiff) > 1) return volDiff;
    return Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0);
  });

  const candidates = ranked.slice(0, 12);
  const top = candidates.slice(0, 7);

  const liquidCount = top.filter(t => Number(t.liquidity ?? 0) >= 100_000).length;
  const broadCount = top.filter(t => Number(t.change24h ?? 0) > 5).length;

  const marketRead = liquidCount >= 4
    ? "Momentum is broad with real liquidity support across multiple leaders."
    : liquidCount >= 2
    ? "Momentum is active but mixed — a few liquid names leading, others are thinner pumps."
    : "Moves are mostly thin-liquidity right now. Treat this as a watchlist, not conviction.";

  const breadthNote = broadCount >= 4
    ? "Participation is broad — multiple tokens posting strong 24h moves."
    : "Participation is selective — not all Base tickers are joining the move.";

  const rows = top.map((t, i) => {
    const sym = String(t.symbol ?? '?').toUpperCase();
    const name = String(t.name ?? '').trim();
    const label = name && name.toUpperCase() !== sym ? `${sym} (${name})` : sym;
    const ch = Number(t.change24h ?? 0);
    const chStr = `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%`;
    const vol = formatUsdShort(Number(t.volume ?? 0) || null);
    const liq = formatUsdShort(Number(t.liquidity ?? 0) || null);
    const liqNum = Number(t.liquidity ?? 0) || null;
    const volNum = Number(t.volume ?? 0) || null;
    const fdvNum = t.fdv != null ? Number(t.fdv) : null;
    const cls = classifyMarketTokenLabel(liqNum, volNum, fdvNum, sym);
    // Map internal labels to quality tags
    const qualityTag = cls === "liquid mover" ? "tradable depth"
      : cls === "volume-led" ? "volume-led"
      : cls === "thin pump" ? "thin liquidity"
      : cls === "microcap noise" ? "microcap noise"
      : cls === "base asset" ? "base asset"
      : "watchlist only";
    const reason = buildReasonLine(cls);
    return `${i + 1}. ${label} — ${chStr} | Vol ${vol} | Liq ${liq} | [${qualityTag}]\n   Read: ${reason}`;
  });

  const thinCount = top.filter(t => Number(t.liquidity ?? 0) < 50_000).length;
  const qualityLine = thinCount >= 3
    ? `${thinCount} of top ${top.length} have thin liquidity (<$50K) — slippage risk is elevated. Verify depth before sizing.`
    : liquidCount >= 3
    ? "Several leaders show tradable liquidity depth — stronger base for follow-through than a pure thin pump."
    : "Mixed depth across the list. Verify LP and holders before conviction on any single mover.";

  const pumpNote = pumpAlerts.length > 0
    ? `Pump-alert filter also flags additional momentum candidates — say "show pump alerts" for the dedicated high-momentum filtered feed.`
    : null;

  const lines: string[] = [
    "BASE MOMENTUM READ",
    "",
    `Market read:`,
    `${marketRead} ${breadthNote}`,
    "",
    "Strongest movers:",
    ...rows,
    "",
    `Quality filter:`,
    qualityLine,
    "Watchouts: liquidity, slippage, holder concentration, and dev wallet checks are not yet verified for any of the above.",
    "",
    pumpNote,
    "Next action:",
    "Pick a number and say \"scan 1\" to run a deeper token scan.",
  ].filter((l): l is string => l !== null && l !== undefined);

  const items = top.map((t, i) => ({
    rank: i + 1,
    symbol: String(t.symbol ?? '?').toUpperCase(),
    name: String(t.name ?? '').trim() || null,
    address: typeof t.address === 'string' ? t.address : null,
    liquidity: Number(t.liquidity ?? 0) || null,
    volume24h: Number(t.volume ?? 0) || null,
    change24h: Number(t.change24h ?? 0),
    tag: (() => {
      const liqNum = Number(t.liquidity ?? 0) || null;
      const volNum = Number(t.volume ?? 0) || null;
      const fdvNum = t.fdv != null ? Number(t.fdv) : null;
      const sym = String(t.symbol ?? '?').toUpperCase();
      const cls = classifyMarketTokenLabel(liqNum, volNum, fdvNum, sym);
      return cls === "liquid mover" ? "tradable depth"
        : cls === "volume-led" ? "volume-led"
        : cls === "thin pump" ? "thin liquidity"
        : cls === "microcap noise" ? "microcap noise"
        : cls === "base asset" ? "base asset"
        : "watchlist only";
    })(),
  }));

  return { analysis: lines.join("\n"), items };
}

async function handleBaseRadarSnapshot(origin: string, prompt = "") {
  const authHeader = clarkInternalCtx.authToken ? `Bearer ${clarkInternalCtx.authToken}` : undefined;
  const BASE_RADAR_EXCLUDED = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'WETH', 'ETH', 'CBBTC', 'BTC', 'WBTC', 'BUSD', 'FRAX', 'CBETH', 'STETH', 'RETH', 'WSTETH', 'EURC', 'BSDETH', 'USD+', 'AXLUSDC']);

  let tokens: Record<string, unknown>[] = [];
  try {
    const res = await fetch(`${origin}/api/trending`, {
      signal: AbortSignal.timeout(5000),
      headers: authHeader ? { authorization: authHeader } : {},
    });
    if (res.ok) {
      const json = await res.json();
      tokens = Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
    }
  } catch { /* timeout — tokens stays empty */ }

  // Fallback: if no Base-chain tokens came through (trending may include coingecko cross-chain),
  // relax the chain filter since the `chain` field may be absent.
  const baseFeed = tokens.filter(t => {
    const sym = String(t.symbol ?? '').toUpperCase();
    const ch = String(t.chain ?? '');
    return sym && !BASE_RADAR_EXCLUDED.has(sym) && (ch === 'base' || ch === 'geckoterminal' || !ch);
  });

  if (!baseFeed.length) {
    return { analysis: `${pickBaseRadarTitle(prompt)}\nNo fresh Base Radar data loaded right now. Refresh Base Radar or try again in a moment.`, items: [] };
  }

  const sorted = [...baseFeed].sort((a, b) => Number(b.change24h ?? 0) - Number(a.change24h ?? 0));
  const top = sorted.slice(0, 5);

  const positiveCount = top.filter(t => Number(t.change24h ?? 0) > 0).length;
  const marketRead = positiveCount >= 4
    ? "Moves look broad — most tracked tokens are positive over 24h."
    : positiveCount >= 2
    ? "Mixed market — some momentum tokens up, others cooling or flat."
    : "Moves concentrated — few tokens showing strength, most flat or down.";

  const rows = top.map((t, i) => {
    const sym = String(t.symbol ?? '?').toUpperCase();
    const name = String(t.name ?? '').trim();
    const label = name && name.toUpperCase() !== sym ? `${sym} (${name})` : sym;
    const ch = t.change24h != null ? Number(t.change24h) : null;
    const chStr = ch != null ? `${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% 24h` : 'n/a 24h';
    const price = t.price != null ? fmtPrice(Number(t.price)) : 'n/a';
    const vol = formatUsdShort(t.volume != null ? Number(t.volume) : null);
    const liq = formatUsdShort(t.liquidity != null ? Number(t.liquidity) : null);
    const liqNum = t.liquidity != null ? Number(t.liquidity) : null;
    const volNum = t.volume != null ? Number(t.volume) : null;
    const cls = classifyMarketTokenLabel(liqNum, volNum, null, sym);
    return `${i + 1}. ${label} — ${chStr} | Price ${price} | Vol ${vol} | Liq ${liq} | ${cls}`;
  });
  const title = pickBaseRadarTitle(prompt);
  const watchout = top.some((t) => {
    const liq = t.liquidity != null ? Number(t.liquidity) : null;
    return liq != null && liq < 120_000;
  }) ? "Watchouts: several leaders are still thin, so treat this as a watchlist until token scans confirm structure." : "Watchouts: leaders show better depth, but still verify holders and LP before trusting momentum.";
  const items = top.map((t, i) => ({
    rank: i + 1,
    symbol: String(t.symbol ?? '?').toUpperCase(),
    name: String(t.name ?? '').trim() || null,
    address: typeof t.address === 'string' ? t.address : null,
    liquidity: t.liquidity != null ? Number(t.liquidity) : null,
    volume24h: t.volume != null ? Number(t.volume) : null,
    change24h: t.change24h != null ? Number(t.change24h) : null,
    tag: (() => {
      const liqNum = t.liquidity != null ? Number(t.liquidity) : null;
      const volNum = t.volume != null ? Number(t.volume) : null;
      const sym = String(t.symbol ?? '?').toUpperCase();
      const cls = classifyMarketTokenLabel(liqNum, volNum, null, sym);
      return cls === "liquid mover" ? "tradable depth"
        : cls === "volume-led" ? "volume-led"
        : cls === "thin pump" ? "thin liquidity"
        : cls === "microcap noise" ? "microcap noise"
        : cls === "base asset" ? "base asset"
        : "watchlist only";
    })(),
  }));

  if (title === "HOT ON BASE") {
    return {
      analysis: [
        "HOT ON BASE",
        `Main read: ${marketRead}`,
        "Worth checking:",
        ...rows.slice(0, 3),
        `Noise / caution: ${watchout.replace("Watchouts: ", "")}`,
        "Next: Best next step: scan the cleanest non-stable mover.",
      ].join("\n"),
      items,
    };
  }
  if (title === "BASE MARKET PULSE") {
    const thinCount = top.filter(t => (t.liquidity != null ? Number(t.liquidity) : 0) < 100_000).length;
    return {
      analysis: [
        "BASE MARKET PULSE",
        `Broad read: ${marketRead}`,
        `Leading theme: ${thinCount >= 3 ? "thin pumps are leading" : "liquidity-backed movers are leading"}.`,
        "What’s leading:",
        ...rows.slice(0, 4),
        `Watchouts: ${watchout.replace("Watchouts: ", "")}`,
        "Next: Treat this as watchlist flow, not a trade call. Scan one clean mover deeply.",
      ].join("\n"),
      items,
    };
  }
  return {
    analysis: [
      "BASE RADAR SUMMARY",
      "Top 5 movers:",
      ...rows,
      `Liquidity quality: ${top.filter(t => (t.liquidity != null ? Number(t.liquidity) : 0) >= 100_000).length} liquid vs ${top.filter(t => (t.liquidity != null ? Number(t.liquidity) : 0) < 100_000).length} thin.`,
      `Rotation read: ${marketRead}`,
      "Next: Run Token Scanner + Dev Wallet before trusting the move.",
    ].join("\n"),
    items,
  };
}

function formatUsdShort(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
function isNearZeroLiquidity(value: number | null | undefined): boolean {
  return typeof value !== "number" || !Number.isFinite(value) || value <= 100;
}
function formatLiquiditySafe(value: number | null | undefined): string {
  if (isNearZeroLiquidity(value)) return "near-zero / unverified";
  return formatUsdShort(value);
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
    "\n\nClark's read:\n" +
    "Momentum is active, but thin-liquidity names can reverse fast.\n" +
    "\n\nBest next step:\n" +
    "Scan the strongest token before touching it. Market data alone does not confirm safety."
  );
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function normalizeTrustedWalletLabel(label: string): string {
  const clean = label.trim().toLowerCase();
  if (!clean) return "tracked wallet";
  if (clean.includes("bot farmer")) return "repeat activity wallet";
  if (clean.includes("institutional-style whale")) return "large wallet";
  if (clean.includes("socialfi power user")) return "tracked wallet";
  return label;
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

type WalletBehaviorCtx = {
  status?: string;
  txCount?: number | null;
  activeDays?: number | null;
  topTokens?: string[];
  inboundCount?: number | null;
  outboundCount?: number | null;
  stablecoinActivity?: boolean;
  recentActivitySummary?: string;
};

function buildWalletQualityVerdict(
  snapshot: NonNullable<ClarkToolEvidence["walletSnapshot"]>,
  address: string,
  prompt?: string,
  behavior?: WalletBehaviorCtx | null
): string {
  const top = snapshot.holdingsTop10;
  const topValue = top.reduce((s, h) => s + h.value, 0);
  const top1 = top[0]?.value ?? 0;
  const concentration = topValue > 0 ? (top1 / topValue) * 100 : 0;
  const breadth = snapshot.tokenCount;
  const stablePct = snapshot.totalValue > 0 ? (snapshot.stablecoinExposureUsd / snapshot.totalValue) * 100 : 0;
  const activity = snapshot.txCount ?? 0;
  const behOk = behavior?.status === "ok";
  const behTxCount = behOk ? (behavior?.txCount ?? 0) : 0;
  const behActiveDays = behOk ? (behavior?.activeDays ?? 0) : 0;

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
  // Upgrade confidence when behavior data confirms real activity
  if (behOk && behTxCount >= 20 && behActiveDays >= 5 && confidence === "Low") confidence = "Medium";
  if (behOk && behTxCount >= 50 && snapshot.totalValue >= 5_000 && confidence === "Medium") confidence = "High";

  const profile =
    snapshot.totalValue >= 25_000 && (activity >= 20 || behTxCount >= 30) ? "tracker-worthy whale/watch wallet" :
    breadth >= 20 ? "broad rotation/farmer-style wallet" :
    "lower-signal concentrated wallet";

  const signals: string[] = [
    `Portfolio value: ${formatUsdShort(snapshot.totalValue)}`,
    `Concentration: top holding is ${concentration.toFixed(1)}% of visible top holdings`,
    `Stablecoin exposure: ${formatUsdShort(snapshot.stablecoinExposureUsd)} (${stablePct.toFixed(1)}%)`,
  ];
  if (behOk) {
    signals.push(`Base activity: ${behTxCount} recent transfers across ${behActiveDays} active days`);
    if (behavior?.topTokens?.length) signals.push(`Top Base interactions: ${behavior.topTokens.slice(0, 3).join(", ")}`);
    if (behavior?.stablecoinActivity) signals.push("Stablecoin movement present in recent Base activity");
  }

  const risks = [
    snapshot.dustOrUnpricedHidden ? "Dust or unpriced holdings exist and are hidden in this summary" : "Major holdings are mostly priced",
    breadth < 5 ? "Low breadth increases single-asset dependency risk" : "Breadth is acceptable for watchlist monitoring",
    behOk ? (behTxCount < 10 ? "No fresh Base activity signal in the checked window." : "Liquidity exposure not calculated") : "Not enough verified evidence for Base activity confirmation",
  ];
  const behaviorNote = behOk && behavior?.recentActivitySummary ? `Activity: ${behavior.recentActivitySummary}` : "";
  const read = [
    `This looks like a ${profile}.`,
    behOk && behTxCount > 0 ? `Base activity confirms on-chain presence.` : `Portfolio holdings are visible. No fresh Base activity signal in the checked window.`,
  ].join(" ");
  const copyTradePrompt = /\bcopy[\s-]?trade\b/i.test(prompt ?? "");
  const nextAction = copyTradePrompt
    ? "Do not copy from balance alone. Track entries/exits, sizing, and repeat behavior first."
    : behOk && behTxCount >= 20
      ? "Monitor this wallet's next moves — behavior pattern suggests active on-chain presence."
      : "Track this wallet's future entries/exits before treating it as a lead wallet.";

  return enforceWalletAssetLabel(
    buildStructuredVerdict(
      verdict,
      confidence,
      behaviorNote ? `${read}\n${behaviorNote}` : read,
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
  const top = snapshot.holdingsTop10.slice(0, 8);
  const topLines = top.length > 0 ? top.map((h) => `- ${h.symbol}: ${formatUsdShort(h.value)}`) : ["- No priced holdings above $1 found"];
  const largestHolding = top[0];
  const largestHoldingPct = largestHolding && snapshot.totalValue > 0 ? ((largestHolding.value / snapshot.totalValue) * 100).toFixed(1) : null;
  // Portfolio read
  const portfolioRead = [
    `Total portfolio value: ${formatUsdShort(snapshot.totalValue)}.`,
    largestHolding ? `Largest holding: ${largestHolding.symbol} at ${formatUsdShort(largestHolding.value)}${largestHoldingPct ? ` (${largestHoldingPct}% of visible portfolio)` : ""}.` : "No large single holding identified.",
    `Token count: ${snapshot.tokenCount != null ? formatInt(snapshot.tokenCount) : "n/a"} assets tracked.`,
  ].join(" ");
  // Activity read
  const activityRead = (snapshot.txCount != null || snapshot.walletAgeDays != null)
    ? [
        snapshot.txCount != null ? `${formatInt(snapshot.txCount)} recent transactions.` : null,
        snapshot.walletAgeDays != null ? `Wallet age: ${formatInt(snapshot.walletAgeDays)} days.` : null,
      ].filter(Boolean).join(" ")
    : "Recent activity is incomplete from this scan.";
  // Concentration
  const concentration = largestHoldingPct != null
    ? (Number(largestHoldingPct) >= 70 ? "High concentration — single asset dominates." : Number(largestHoldingPct) >= 40 ? "Moderate concentration." : "Distributed across multiple assets.")
    : "Concentration data incomplete.";
  // Verdict line
  const verdictLine = snapshot.totalValue >= 25_000 && snapshot.tokenCount != null && snapshot.tokenCount >= 8
    ? "WORTH MONITORING"
    : snapshot.totalValue >= 5_000
      ? "ACTIVE WALLET"
      : snapshot.totalValue > 0
        ? "WATCH"
        : "INCOMPLETE READ";

  return [
    "WALLET READ",
    "",
    `Verdict: ${verdictLine}`,
    "",
    "Portfolio read:",
    portfolioRead,
    ...topLines,
    "",
    "Activity read:",
    activityRead,
    "",
    "Risk / concentration:",
    concentration,
    `Unknown/unpriced assets hidden: ${snapshot.hiddenHoldingsCount}.`,
    "",
    "Missing checks:",
    "- PnL, win rate, and intent are not verified from this scan.",
    "- Smart-money status is not confirmed.",
    "",
    "Next action:",
    "Monitor entries/exits before trusting this wallet. Run token scans on major holdings. No trade call.",
  ].join("\n");
}

function missingAddressReply(intent: ClarkIntent): string {
  if (intent === "wallet_analysis" || intent === "whale_alert") {
    return "I can run that, but I need a wallet address first. Paste a full 0x wallet and I'll analyze the available data.";
  }
  return "I can run that, but I need a token contract first. Paste a full 0x contract and I'll analyze the available data.";
}

async function callInternalApi(origin: string, path: string, payload: Record<string, unknown>, authHeader?: string, verifiedPlan?: 'free' | 'pro' | 'elite') {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const tok = authHeader ?? (clarkInternalCtx.authToken ? `Bearer ${clarkInternalCtx.authToken}` : undefined)
  const plan = verifiedPlan ?? clarkInternalCtx.verifiedPlan
  if (tok) headers.Authorization = tok
  if (plan) headers["x-user-plan"] = plan
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(9000),
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
async function callGeckoTerminal(network: "base" | "eth", origin: string, options?: { type?: "pools" | "trending" | "new"; page?: number; perPage?: number }) {
  const type = options?.type ?? "pools";
  const page = options?.page ?? 1;
  const perPage = options?.perPage ?? 20;
  const res = await fetch(`${origin}/api/proxy/gt?network=${network}&type=${type}&page=${page}&per_page=${perPage}`, {
    next: { revalidate: 30 },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GeckoTerminal proxy ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

// Uses req.nextUrl.origin so the call always targets the same deployment
async function callTrending(origin: string): Promise<unknown[]> {
  const authHeader = clarkInternalCtx.authToken ? `Bearer ${clarkInternalCtx.authToken}` : undefined
  const res = await fetch(`${origin}/api/trending`, {
    next: { revalidate: 30 },
    signal: AbortSignal.timeout(8000),
    headers: authHeader ? { Authorization: authHeader } : {},
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
  liquidity?: number;
};

const BASE_TOKEN_ALIAS_MAP: Record<string, BaseTokenCandidate> = {
  brett:            { name: "Brett",             symbol: "BRETT",   contract: "0x532f27101965dd16442e59d40670faf5ebb142e4" },
  aero:             { name: "Aerodrome Finance",  symbol: "AERO",    contract: "0x940181a94a35a4569e4529a3cdfb74e38fd98631" },
  aerodrome:        { name: "Aerodrome Finance",  symbol: "AERO",    contract: "0x940181a94a35a4569e4529a3cdfb74e38fd98631" },
  "aerodrome finance": { name: "Aerodrome Finance", symbol: "AERO", contract: "0x940181a94a35a4569e4529a3cdfb74e38fd98631" },
  virtual:          { name: "Virtual Protocol",   symbol: "VIRTUAL", contract: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b" },
  virtuals:         { name: "Virtual Protocol",   symbol: "VIRTUAL", contract: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b" },
  toshi:            { name: "Toshi",              symbol: "TOSHI",   contract: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4" },
  degen:            { name: "Degen",              symbol: "DEGEN",   contract: "0x4ed4e862860bed51a9570b96d89af5e1b0ebebc4" },
  higher:           { name: "Higher",             symbol: "HIGHER",  contract: "0x0578d8a44db98b23bf096a382e016e29a5ce0ffe" },
};

async function searchBaseTokenCandidates(query: string): Promise<BaseTokenCandidate[]> {
  const qLower = query.trim().toLowerCase();
  const aliasHit = BASE_TOKEN_ALIAS_MAP[qLower];
  const normalizedQuery = aliasHit?.symbol ?? query.trim();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(normalizedQuery)}&network=base`;
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return aliasHit ? [aliasHit] : [];
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;

    const pools = Array.isArray(json.data) ? json.data as unknown[] : [];
    const includedArr = Array.isArray(json.included) ? json.included as unknown[] : [];

    // Build accurate token lookup from the included tokens array
    const tokenById = new Map<string, { symbol: string; name: string; address: string }>();
    for (const inc of includedArr) {
      const t = inc as Record<string, unknown>;
      if (t.type !== "token") continue;
      const id = typeof t.id === "string" ? t.id : "";
      const a = (t.attributes ?? {}) as Record<string, unknown>;
      const address = typeof a.address === "string" ? a.address.toLowerCase() : "";
      const symbol = typeof a.symbol === "string" ? a.symbol : "";
      const name = typeof a.name === "string" ? a.name : "";
      if (id && address) tokenById.set(id, { symbol, name, address });
    }

    const out: BaseTokenCandidate[] = [];
    const seen = new Set<string>();

    for (const raw of pools) {
      const pool = raw as Record<string, unknown>;
      const rels = (pool.relationships ?? {}) as Record<string, unknown>;
      const btRel = (rels.base_token ?? {}) as Record<string, unknown>;
      const btData = (btRel.data ?? {}) as Record<string, unknown>;
      const tokenId = typeof btData.id === "string" ? btData.id : "";

      // Resolve contract: prefer included token address, fallback to id parsing
      const tokenInfo = tokenId ? tokenById.get(tokenId) : undefined;
      const rawContract = tokenInfo?.address || idToAddress(tokenId);
      const contract = rawContract.startsWith("0x") ? rawContract : "";
      if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) continue;
      if (seen.has(contract.toLowerCase())) continue;
      seen.add(contract.toLowerCase());

      // Use accurate symbol/name from included data; fallback to pool-name parsing
      let symbol = tokenInfo?.symbol ?? "";
      let name = tokenInfo?.name ?? "";
      if (!symbol) {
        const attrs = (pool.attributes ?? {}) as Record<string, unknown>;
        const poolName = typeof attrs.name === "string" ? attrs.name : "";
        const part = poolName.split(" / ")[0]?.trim() || contract;
        name = name || part;
        symbol = part.split(" ").slice(-1)[0]?.toUpperCase() ?? part.toUpperCase();
      }

      const attrs = (pool.attributes ?? {}) as Record<string, unknown>;
      const liquidity = parseFloat(String(attrs.reserve_in_usd ?? "0")) || 0;

      out.push({ name: name || symbol, symbol: symbol.toUpperCase(), contract, liquidity });
      if (out.length >= 8) break;
    }

    if (!out.length) return aliasHit ? [aliasHit] : [];

    // Sort: exact symbol match first, then by liquidity descending
    const qUpper = normalizedQuery.trim().toUpperCase();
    out.sort((a, b) => {
      const aEx = a.symbol === qUpper ? 1 : 0;
      const bEx = b.symbol === qUpper ? 1 : 0;
      if (aEx !== bEx) return bEx - aEx;
      return (b.liquidity ?? 0) - (a.liquidity ?? 0);
    });

    // Always pin known alias to position 0 — prevents LP/derivative tokens from beating canonical token
    if (aliasHit) {
      const aliasLower = aliasHit.contract.toLowerCase();
      const existingIdx = out.findIndex(c => c.contract.toLowerCase() === aliasLower);
      if (existingIdx > 0) out.splice(existingIdx, 1);
      if (existingIdx !== 0) out.unshift({ ...aliasHit, liquidity: Number.MAX_SAFE_INTEGER });
    }

    return out.slice(0, 5);
  } catch {
    return aliasHit ? [aliasHit] : [];
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
      return "I need a scan result or valid ChainLens context to make a proper call. Open Token Scanner or paste a full contract or wallet address and I'll analyze the available data.";
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

function humanizeProviderReason(reason: string): string {
  const map: Record<string, string> = {
    contract_bytecode_unavailable_from_rpc: "No signal in checked window from RPC",
    unavailable_circulating_supply_not_verified: "Circulating supply not verified",
    honeypot_simulation_unavailable_from_provider: "Simulation unavailable from provider",
    no_active_liquidity_pool_found: "No active liquidity pool found",
    "No pool address found from provider for LP-holder verification.": "LP holder check unavailable: no pool address found.",
    "Pool uses concentrated/protocol liquidity; LP lock requires protocol-specific verification.": "Unsupported protocol liquidity: LP lock needs protocol-specific verification.",
    "Pool address found, but no standard V2/V3 LP interface was confirmed.": "LP control unverified — liquidity exists, but lock/burn/control could not be proven.",
  };
  if (map[reason]) return map[reason];
  return /^[a-z0-9_]+$/.test(reason) ? reason.replace(/_/g, " ") : reason;
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
    return "I'm Clark — ChainLens on-chain analyst for Base. I can scan token risk, break down wallet behavior, check liquidity safety, flag dev-wallet links, and summarize what's moving. Drop a contract, wallet, or feature context and I'll give you a clean read.";
  }
  if (/\bwhat is chainlens\b/.test(t)) {
    return "ChainLens is your Base intelligence terminal. Use Base Radar for fresh movers, Token Scanner for contract checks, Wallet Scanner for behavior reads, and Dev Wallet Detector for deployer risk mapping.";
  }
  if (/\bhow do i scan|how to scan\b/.test(t)) {
    return "Paste a Base contract into Token Scanner for risk + liquidity checks, or a wallet into Wallet Scanner for flow analysis. If you share the result here, I'll turn it into a sharp action read.";
  }
  return "Yo — Clark here. Paste a Base token, wallet, or alert and I'll break it down. I can scan risk, liquidity, deployer behavior, wallet flows, and Base Radar signals.";
}

function buildMarketHelperReply(prompt: string): string {
  if (/\bliquidity risk\b/i.test(prompt)) {
    return "Liquidity risk is mainly lock status, concentration, and exit depth. Use Liquidity Safety first, then Token Scanner for contract flags. Share the output and I'll translate it into entry risk.";
  }
  if (/\bwhales buying\b/i.test(prompt)) {
    return "Use Whale Alerts plus Wallet Scanner to see real position changes and transfer patterns. If you paste a wallet or alert context, I'll break down whether the flow looks accumulation or distribution.";
  }
  return "Use Base Radar for fresh launches, Token Scanner for contract checks, and Dev Wallet Detector for deployer and linked-wallet risk. Paste a contract or wallet and I'll break it down.";
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
    matches: Array<{ symbol: string; contract: string; liquidity?: number }>;
    selected?: { symbol: string; contract: string } | null;
    errorSafeMessage?: string;
  };
  tokenScan?: {
    ok: boolean;
    token: { name: string; symbol: string; address: string } | null;
    market: { price: number | null; change24h: number | null; volume24h: number | null; liquidity: number | null; marketCap: number | null; fdv: number | null; displayMarketValue: number | null; displayMarketValueLabel: string; displayMarketValueConfidence: string };
    holders?: { top1: number | null; top10: number | null; holderCount: number | null; status: string };
    security: {
      honeypot: boolean | null;
      buyTax: number | null;
      sellTax: number | null;
      transferTax: number | null;
      simulationSuccess: boolean | null;
      securityStatus: "verified" | "partial" | "unverified";
      riskLevel: "low" | "medium" | "high" | "unknown";
      missing: string[];
      proxy: boolean | null;
      mintable: boolean | null;
      ownerRenounced: boolean | null;
    };
    liquidity: { pools: number; topPoolLiquidity: number | null };
    lpControl?: { status: string; reason?: string | null; confidence?: string | null; source?: string | null; poolType?: string | null; poolAddressPresent?: boolean | null } | null;
    poolDetails?: Array<{ dex: string; pair: string; liquidity: number | null; volume24h: number | null; change24h: number | null; poolAddress: string | null }>;
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
    volume24h: number | null;
    primaryPool: string | null;
    warnings: string[];
    errorSafeMessage?: string;
  };
};

async function executeClarkToolPlan(input: {
  plan: ClarkToolPlan;
  origin: string;
  prompt: string;
  chain: SupportedChain;
  authHeader?: string | null;
  verifiedPlan?: 'free' | 'pro' | 'elite';
}): Promise<{ evidence: ClarkToolEvidence; toolsUsed: ClarkToolName[]; resolvedAddress: string | null }> {
  const evidence: ClarkToolEvidence = {};
  const toolsUsed: ClarkToolName[] = [];
  let resolvedAddress: string | null = input.plan.followupContext.address;
  const safeAuthHeader = input.authHeader ?? undefined

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

        let selected: { symbol: string; contract: string } | null = null;
        if (matches.length === 1) {
          selected = { symbol: matches[0].symbol, contract: matches[0].contract };
        } else if (matches.length > 1) {
          const qUpper = query.toUpperCase();
          const exactMatch = matches.find((m) => m.symbol === qUpper);
          const top = matches[0];
          const second = matches[1];
          if (exactMatch) {
            selected = { symbol: exactMatch.symbol, contract: exactMatch.contract };
          } else if (top && second && (top.liquidity ?? 0) > (second.liquidity ?? 0) * 5 && (top.liquidity ?? 0) > 10_000) {
            selected = { symbol: top.symbol, contract: top.contract };
          } else if (top && (top.liquidity ?? 0) > 200_000) {
            selected = { symbol: top.symbol, contract: top.contract };
          }
        }

        // Mismatch guard: if selected symbol doesn't match query and we have a known alias, prefer alias
        const qUpperR = query.trim().toUpperCase();
        if (selected && selected.symbol.toUpperCase() !== qUpperR) {
          const aliasEntry = BASE_TOKEN_ALIAS_MAP[query.trim().toLowerCase()];
          if (aliasEntry && aliasEntry.symbol.toUpperCase() === qUpperR) {
            selected = { symbol: aliasEntry.symbol, contract: aliasEntry.contract };
          }
        }

        evidence.tokenResolve = {
          ok: matches.length > 0 || selected != null,
          query,
          matches: matches.map((m) => ({ symbol: m.symbol, contract: m.contract, liquidity: m.liquidity })),
          selected,
          errorSafeMessage: matches.length ? undefined : "I could not confirm a Base match from current checks. Paste the contract address for a deeper scan.",
        };
        if (selected?.contract) resolvedAddress = selected.contract;
        continue;
      }

      if (tool.name === "token_scan") {
        const addrArg = String(tool.args.address ?? "").trim();
        const addr = addrArg || String(resolvedAddress ?? "").trim();
        const _validAddr = Boolean(addr && /^0x[a-fA-F0-9]{40}$/.test(addr));
        // Run token scan and honeypot check in parallel instead of sequential
        const [tokenData, securitySim] = await Promise.all([
          _validAddr ? callInternalApi(input.origin, "/api/token", { contract: addr }, input.authHeader ?? undefined, input.verifiedPlan) : Promise.resolve(null),
          _validAddr ? fetchHoneypotSecurity(addr, "base") : Promise.resolve(null),
        ]);
        const tokenJson = tokenData?.ok ? tokenData.json : null;
        const t = (tokenJson ?? {}) as Record<string, unknown>;
        const sections = (t.sections ?? {}) as Record<string, unknown>;
        const marketSection = (sections.market ?? {}) as Record<string, unknown>;
        const securitySection = (sections.security ?? {}) as Record<string, unknown>;
        const holdersSection = (sections.holders ?? {}) as Record<string, unknown>;
        // GoPlus result is keyed by lowercase contract address — extract the token-specific entry
        const gpResultRaw = (t.goplus ?? {}) as Record<string, unknown>;
        const g = (gpResultRaw[addr.toLowerCase()] ?? gpResultRaw[addr] ?? {}) as Record<string, unknown>;
        const hp = (t.honeypot ?? {}) as Record<string, unknown>;
        const warnings: string[] = [];
        if (!tokenJson) warnings.push("Token scan data is limited right now.");
        if (securitySim?.warnings?.length) warnings.push(...securitySim.warnings);
        evidence.tokenScan = {
          ok: Boolean(tokenJson),
          token: tokenJson ? { name: String(t.name ?? "Unknown"), symbol: String(t.symbol ?? "?"), address: String(t.contract ?? addr) } : null,
          market: {
            price: typeof t.priceUsd === "number" ? t.priceUsd : (typeof t.price === "number" ? t.price : null),
            change24h: typeof t.priceChange24h === "number" ? t.priceChange24h : null,
            volume24h: typeof t.volume24hUsd === "number" ? t.volume24hUsd : (typeof t.volume24h === "number" ? t.volume24h : null),
            liquidity: typeof t.liquidityUsd === "number" ? t.liquidityUsd : (typeof t.liquidity === "number" ? t.liquidity : null),
            marketCap: typeof t.marketCapUsd === "number" ? t.marketCapUsd : null,
            fdv: typeof t.fdvUsd === "number" ? t.fdvUsd : (typeof t.fdv === "number" ? t.fdv : null),
            displayMarketValue: typeof t.displayMarketValue === "number" ? t.displayMarketValue : null,
            displayMarketValueLabel: typeof t.displayMarketValueLabel === "string" ? t.displayMarketValueLabel : "Market Cap",
            displayMarketValueConfidence: typeof t.displayMarketValueConfidence === "string" ? t.displayMarketValueConfidence : "low",
          },
          holders: {
            top1: typeof (t.holderDistribution as Record<string, unknown> | undefined)?.top1 === "number" ? (t.holderDistribution as Record<string, unknown>).top1 as number : (typeof holdersSection.top1 === "number" ? holdersSection.top1 : null),
            top10: typeof (t.holderDistribution as Record<string, unknown> | undefined)?.top10 === "number" ? (t.holderDistribution as Record<string, unknown>).top10 as number : (typeof holdersSection.top10 === "number" ? holdersSection.top10 : null),
            holderCount: typeof (t.holderDistribution as Record<string, unknown> | undefined)?.holderCount === "number" ? (t.holderDistribution as Record<string, unknown>).holderCount as number : (typeof holdersSection.holderCount === "number" ? holdersSection.holderCount : null),
            status: typeof holdersSection.status === "string" ? String(holdersSection.status) : (typeof (t.holderDistributionStatus as Record<string, unknown> | undefined)?.status === "string" ? String((t.holderDistributionStatus as Record<string, unknown>).status) : "unavailable"),
          },
          security: {
            honeypot: typeof securitySection.honeypot === "boolean" ? securitySection.honeypot : (securitySim?.honeypot ?? (typeof hp.isHoneypot === "boolean" ? hp.isHoneypot : (g.is_honeypot != null ? String(g.is_honeypot) === "1" : null))),
            buyTax: typeof securitySection.buyTax === "number" ? securitySection.buyTax : (securitySim?.buyTax ?? (typeof hp.buyTax === "number" ? hp.buyTax : (g.buy_tax != null ? Number(g.buy_tax) : null))),
            sellTax: typeof securitySection.sellTax === "number" ? securitySection.sellTax : (securitySim?.sellTax ?? (typeof hp.sellTax === "number" ? hp.sellTax : (g.sell_tax != null ? Number(g.sell_tax) : null))),
            transferTax: securitySim?.transferTax ?? (typeof t.honeypot === "object" && t.honeypot && typeof (t.honeypot as Record<string, unknown>).transferTax === "number" ? (t.honeypot as Record<string, unknown>).transferTax as number : null),
            simulationSuccess: (typeof securitySection.simulationSuccess === "boolean" ? securitySection.simulationSuccess : null) ?? securitySim?.simulationSuccess
              ?? (typeof hp.simulationSuccess === "boolean" ? hp.simulationSuccess : null)
              ?? (securitySim?.ok && (securitySim.buyTax != null || securitySim.sellTax != null) ? true : null),
            securityStatus: securitySim?.securityStatus ?? "unverified",
            riskLevel: securitySim?.riskLevel ?? "unknown",
            missing: securitySim?.missing ?? ["honeypot", "buyTax", "sellTax", "transferTax", "simulationSuccess"],
            proxy: g.is_proxy != null ? String(g.is_proxy) === "1" : null,
            mintable: g.is_mintable != null ? String(g.is_mintable) === "1" : null,
            ownerRenounced: g.owner_address == null ? null : String(g.owner_address).toLowerCase() === "0x0000000000000000000000000000000000000000",
          },
          liquidity: {
            pools: Array.isArray(t.pools) ? t.pools.length : 0,
            topPoolLiquidity: typeof t.liquidity === "number" ? t.liquidity : null,
          },
          lpControl: (t.lpControl && typeof t.lpControl === "object") ? {
            status: typeof (t.lpControl as Record<string, unknown>).status === "string" ? String((t.lpControl as Record<string, unknown>).status) : "unverified",
            reason: typeof (t.lpControl as Record<string, unknown>).reason === "string" ? String((t.lpControl as Record<string, unknown>).reason) : null,
            confidence: typeof (t.lpControl as Record<string, unknown>).confidence === "string" ? String((t.lpControl as Record<string, unknown>).confidence) : null,
            source: typeof (t.lpControl as Record<string, unknown>).source === "string" ? String((t.lpControl as Record<string, unknown>).source) : null,
            poolType: typeof (t.lpControl as Record<string, unknown>).poolType === "string" ? String((t.lpControl as Record<string, unknown>).poolType) : null,
            poolAddressPresent: typeof (t.lpControl as Record<string, unknown>).poolAddressPresent === "boolean" ? Boolean((t.lpControl as Record<string, unknown>).poolAddressPresent) : null,
          } : null,
          poolDetails: Array.isArray(t.pools)
            ? (t.pools as Array<Record<string, unknown>>).map((p) => {
              const a = (p.attributes ?? p) as Record<string, unknown>;
              return {
                dex: typeof a.dex === "string" ? a.dex : (typeof a.dex_id === "string" ? a.dex_id : "DEX"),
                pair: typeof a.pair === "string" ? a.pair : (typeof a.name === "string" ? a.name : "pair"),
                liquidity: typeof a.liquidity === "number" ? a.liquidity : (typeof a.reserve_in_usd === "number" ? a.reserve_in_usd : null),
                volume24h: typeof a.volume24h === "number" ? a.volume24h : (typeof (a.volume_usd as Record<string, unknown> | undefined)?.h24 === "number" ? (a.volume_usd as Record<string, unknown>).h24 as number : null),
                change24h: typeof a.change24h === "number" ? a.change24h : (typeof (a.price_change_percentage as Record<string, unknown> | undefined)?.h24 === "number" ? (a.price_change_percentage as Record<string, unknown>).h24 as number : null),
                poolAddress: typeof a.address === "string" ? a.address : (typeof p.id === "string" ? p.id : null),
              };
            })
            : [],
          warnings,
          errorSafeMessage: tokenJson ? undefined : "I couldn't complete a token scan right now.",
        };
        resolvedAddress = evidence.tokenScan.token?.address ?? resolvedAddress;
        continue;
      }

      if (tool.name === "wallet_get_snapshot") {
        if (input.verifiedPlan === "free") {
          evidence.walletSnapshot = { ok: false, address: "", totalValue: 0, holdingsTop10: [], hiddenHoldingsCount: 0, dustOrUnpricedHidden: false, stablecoinExposureUsd: 0, tokenCount: 0, txCount: 0, walletAgeDays: 0, dataQuality: "Limited", errorSafeMessage: "This is a Pro feature. Upgrade to Pro to run wallet/dev/liquidity reports." }
          continue
        }
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const walletRes = await callInternalApi(input.origin, "/api/wallet", { address }, input.authHeader ?? undefined, input.verifiedPlan);
        const w = (walletRes.json ?? {}) as Record<string, unknown>;
        const normalized = normalizeWalletSnapshotEvidence(w, address);
        evidence.walletSnapshot = {
          ...normalized,
          ok: walletRes.ok && !w.error,
          errorSafeMessage: walletRes.ok ? undefined : "Wallet scan has no signal in the checked window.",
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
        if (input.verifiedPlan === "free") {
          evidence.devWallet = { ok: false, deployerAddress: null, linkedWallets: 0, confidence: "Low", verdict: "UNKNOWN", warnings: ["This is a Pro feature. Upgrade to Pro to run wallet/dev/liquidity reports."], errorSafeMessage: "This is a Pro feature. Upgrade to Pro to run wallet/dev/liquidity reports." }
          continue
        }
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const devWalletRes = await callInternalApi(input.origin, "/api/dev-wallet", { contractAddress: address }, input.authHeader ?? undefined, input.verifiedPlan);
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
        if (input.verifiedPlan === "free") {
          evidence.liquidity = { ok: false, token: null, liquidityUsd: null, riskTier: null, stabilityScore: null, volume24h: null, primaryPool: null, warnings: ["This is a Pro feature. Upgrade to Pro to run wallet/dev/liquidity reports."], errorSafeMessage: "This is a Pro feature. Upgrade to Pro to run wallet/dev/liquidity reports." }
          continue
        }
        const addrArg = String(tool.args.address ?? "").trim();
        const address = addrArg || String(resolvedAddress ?? "").trim();
        const liqRes = await callInternalApi(input.origin, "/api/liquidity-safety", { contract: address }, input.authHeader ?? undefined, input.verifiedPlan);
        const l = (((liqRes.json as Record<string, unknown>)?.data ?? {}) as Record<string, unknown>);
        const poolBreakdown = Array.isArray(l.pool_breakdown) ? l.pool_breakdown as Array<Record<string, unknown>> : [];
        const topPool = poolBreakdown[0] ?? null;
        const topPoolVolume = typeof topPool?.volume24h === "number" ? topPool.volume24h as number : null;
        const topPoolPair = typeof topPool?.pair === "string" ? topPool.pair as string : null;
        const topPoolDex = typeof topPool?.dex === "string" ? topPool.dex as string : null;
        const primaryPoolLabel = (topPoolDex && topPoolPair) ? `${topPoolDex} / ${topPoolPair}` : topPoolPair ?? topPoolDex ?? null;
        evidence.liquidity = {
          ok: liqRes.ok && Boolean((liqRes.json as Record<string, unknown>)?.ok),
          token: liqRes.ok ? { name: String(l.name ?? "Unknown"), symbol: String(l.symbol ?? "?"), address: String(l.contract ?? address) } : null,
          liquidityUsd: typeof l.lp_total_liquidity_usd === "number" ? l.lp_total_liquidity_usd : null,
          riskTier: typeof l.lp_risk_tier === "string" ? l.lp_risk_tier : null,
          stabilityScore: typeof l.lp_stability_score === "number" ? l.lp_stability_score : null,
          volume24h: topPoolVolume,
          primaryPool: primaryPoolLabel,
          warnings: liqRes.ok ? [] : ["Liquidity data is currently limited."],
          errorSafeMessage: liqRes.ok ? undefined : "Liquidity check has no signal in the checked window.",
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
    marketCap: number | null;
    poolAge: string | null;
    marketSourceAvailable: boolean;
    displayMarketValue: number | null;
    displayMarketValueLabel: string;
    displayMarketValueConfidence: string;
  };
  holders: {
    holderCount: number | null;
    holderRows: number | null;
    topHolderPct: number | null;
    top10Pct: number | null;
    status: string | null;
    reason: string | null;
  };
  contract: {
    openSource: boolean | null;
    proxy: boolean | null;
    mintable: boolean | null;
    buyTax: number | null;
    sellTax: number | null;
    transferTax: number | null;
    honeypot: boolean | null;
    simulationSuccess: boolean | null;
    securityStatus: "verified" | "partial" | "unverified";
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

type ClarkEvidencePack = {
  asset: string;
  contract: string;
  marketFacts: string[];
  securityFacts: string[];
  liquidityFacts: string[];
  devFacts: string[];
  walletFacts: string[];
  missing: string[];
  confidenceDrivers: string[];
  riskDrivers: string[];
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
  const market = evidence.tokenScan?.market ?? { price: null, change24h: null, volume24h: null, liquidity: null, marketCap: null, fdv: null, displayMarketValue: null, displayMarketValueLabel: 'Market Cap', displayMarketValueConfidence: 'low' };
  const contractWarnings = [...(evidence.tokenScan?.warnings ?? [])];
  const devWarnings = [...(evidence.devWallet?.warnings ?? [])];
  const liqWarnings = [...(evidence.liquidity?.warnings ?? [])];
  const lpControlStatus = evidence.tokenScan?.lpControl?.status ?? "unverified";
  const lpLocked = lpControlStatus === "burned" || lpControlStatus === "locked" ? true : lpControlStatus === "team_controlled" ? false : null;
  {
    const lpc = evidence.tokenScan?.lpControl;
    const pType = lpc?.poolType ?? "unknown";
    if (lpControlStatus === "burned") liqWarnings.push("LP control: LP tokens burned — liquidity removal risk significantly reduced.");
    else if (lpControlStatus === "locked") liqWarnings.push("LP control: LP tokens locked in known locker — verify lock expiry.");
    else if (lpControlStatus === "team_controlled") liqWarnings.push("LP control: Single wallet holds dominant LP share — liquidity removal risk exists.");
    else if (lpControlStatus === "unsupported" && pType === "aerodrome") liqWarnings.push("LP control: Aerodrome protocol pool — requires protocol-specific LP verification.");
    else if (lpControlStatus === "unsupported") liqWarnings.push("LP control: Concentrated/V3 pool — LP lock cannot be verified via V2 holder method.");
    else if (lpc?.poolAddressPresent) liqWarnings.push("LP control unverified — liquidity exists, but lock/burn/control could not be proven from current checks.");
    else liqWarnings.push("LP control unverified — no active pool found or pool address unavailable.");
  }
  const liqUsd = evidence.liquidity?.liquidityUsd ?? market.liquidity ?? null;
  const volumeToLiquidity = (market.volume24h != null && liqUsd != null && liqUsd > 0) ? (market.volume24h / liqUsd) : null;

  const out: ClarkFullReportEvidence = {
    token: { symbol: tokenSymbol, name: tokenName, address: tokenAddress, chain: "base" },
    market: {
      price: market.price,
      change24h: market.change24h,
      volume24h: market.volume24h,
      liquidity: market.liquidity,
      fdv: market.fdv ?? null,
      marketCap: market.marketCap ?? null,
      poolAge: null,
      marketSourceAvailable: market.price != null || market.volume24h != null || market.liquidity != null,
      displayMarketValue: market.displayMarketValue ?? null,
      displayMarketValueLabel: market.displayMarketValueLabel ?? 'Market Cap',
      displayMarketValueConfidence: market.displayMarketValueConfidence ?? 'low',
    },
    holders: {
      holderCount: evidence.tokenScan?.holders?.holderCount ?? null,
      holderRows: evidence.tokenScan?.holders?.holderCount ?? null,
      topHolderPct: evidence.tokenScan?.holders?.top1 ?? null,
      top10Pct: evidence.tokenScan?.holders?.top10 ?? null,
      status: evidence.tokenScan?.holders?.status ?? null,
      reason: null,
    },
    contract: {
      openSource: null,
      proxy: evidence.tokenScan?.security.proxy ?? null,
      mintable: evidence.tokenScan?.security.mintable ?? null,
      buyTax: evidence.tokenScan?.security.buyTax ?? null,
      sellTax: evidence.tokenScan?.security.sellTax ?? null,
      transferTax: evidence.tokenScan?.security.transferTax ?? null,
      honeypot: evidence.tokenScan?.security.honeypot ?? null,
      simulationSuccess: evidence.tokenScan?.security.simulationSuccess ?? null,
      securityStatus: evidence.tokenScan?.security.securityStatus ?? "unverified",
      warnings: contractWarnings,
    },
    liquidity: {
      liquidityUsd: liqUsd,
      lpLocked,
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
  if (out.contract.honeypot === null) out.missing.push(
    out.contract.buyTax != null || out.contract.sellTax != null ? "Full sell simulation" : "Honeypot check"
  );
  if (out.contract.buyTax === null) out.missing.push("Buy tax check");
  if (out.contract.sellTax === null) out.missing.push("Sell tax check");
  if (out.contract.transferTax === null) out.missing.push("Transfer tax check");
  if (out.contract.simulationSuccess === null) out.missing.push("Security simulation");
  if (out.holders.holderCount === null && out.holders.top10Pct === null) out.missing.push("Holder distribution");
  if (out.liquidity.lpLocked === null) out.missing.push("LP lock/control — confirms whether liquidity can be removed or is locked/burned");
  if (out.market.poolAge === null) out.missing.push("Pool age / new pool status");
  if (out.devWallet.likelyDeployer === null) out.missing.push("Likely deployer identity");

  return out;
}

function buildClarkEvidencePack(report: ClarkFullReportEvidence, wallet?: ClarkToolEvidence["walletSnapshot"]): ClarkEvidencePack {
  const asset = `${report.token.name ?? "Unknown token"} (${report.token.symbol ?? "?"})`;
  const marketFacts = [
    `24h move: ${report.market.change24h != null ? `${report.market.change24h.toFixed(2)}%` : "Unverified"}`,
    `Volume: ${formatUsdShort(report.market.volume24h)}`,
    `Liquidity: ${formatUsdShort(report.market.liquidity)}`,
  ];
  const securityFacts = [
    `Honeypot: ${report.contract.honeypot === true ? "Flagged" : report.contract.honeypot === false ? "Not flagged" : "Unverified"}`,
    `Buy tax: ${report.contract.buyTax != null ? `${report.contract.buyTax}%` : "Unverified"}`,
    `Sell tax: ${report.contract.sellTax != null ? `${report.contract.sellTax}%` : "Unverified"}`,
    `Transfer tax: ${report.contract.transferTax != null ? `${report.contract.transferTax}%` : "Unverified"}`,
    `Simulation: ${report.contract.simulationSuccess === true ? "Passed" : report.contract.simulationSuccess === false ? "Failed" : "Unverified"}`,
    `Proxy: ${boolToWord(report.contract.proxy)}`,
  ];
  const liquidityFacts = [
    `Pool depth: ${formatUsdShort(report.liquidity.liquidityUsd)}`,
    `LP control: ${report.liquidity.lpLocked === true ? "Locked (confirmed)" : report.liquidity.lpLocked === false ? "Unlocked (confirmed)" : "LP lock/control: Unverified"}`,
    `Volume/liquidity: ${report.liquidity.volumeToLiquidity != null ? report.liquidity.volumeToLiquidity.toFixed(2) : "Unverified"}`,
  ];
  const devFacts = [
    `Deployer: ${report.devWallet.likelyDeployer ? shortAddress(report.devWallet.likelyDeployer) : "Unverified"}`,
    `Linked wallets: ${report.devWallet.linkedWallets ?? 0}`,
  ];
  const walletFacts = wallet?.ok
    ? [`Wallet value: ${formatUsdShort(wallet.totalValue)}`, `Token count: ${formatInt(wallet.tokenCount)}`]
    : [];
  const confidenceDrivers = dedupeLines([
    report.market.marketSourceAvailable ? "Market data is present." : "",
    report.contract.honeypot === false ? "No honeypot flag in security simulation." : "",
    report.contract.simulationSuccess === true ? "Security simulation passed." : "",
    (report.liquidity.liquidityUsd ?? 0) > 100_000 ? "Liquidity depth is substantial." : "",
  ]).filter(Boolean);
  const riskDrivers = dedupeLines([
    report.contract.honeypot === true ? "Honeypot behavior is flagged in security simulation." : "",
    report.contract.simulationSuccess === false ? "Security simulation failed." : "",
    (report.contract.buyTax ?? 0) > 15 || (report.contract.sellTax ?? 0) > 15 ? "Transfer tax is elevated." : "",
    report.contract.securityStatus === "unverified" ? "Tax/honeypot check unverified." : "",
    report.missing.length ? "Several checks remain unverified." : "",
  ]).filter(Boolean);
  return {
    asset,
    contract: report.token.address ?? "Unresolved",
    marketFacts,
    securityFacts,
    liquidityFacts,
    devFacts,
    walletFacts,
    missing: report.missing,
    confidenceDrivers,
    riskDrivers,
  };
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

  if (!isNearZeroLiquidity(report.market.liquidity)) signals.push(`Liquidity observed around ${formatUsdShort(report.market.liquidity)}.`);
  else if (report.market.volume24h != null && report.market.volume24h > 0) signals.push("24h volume exists, but liquidity quality is weak.");
  if (report.market.volume24h != null) signals.push(`24h volume observed around ${formatUsdShort(report.market.volume24h)}.`);
  if (report.contract.honeypot === false) signals.push("No honeypot flag detected in current checks.");
  if (report.contract.simulationSuccess === true) signals.push("Security simulation passed.");
  if ((report.devWallet.linkedWallets ?? 0) > 0) risks.push(`Linked deployer-wallet cluster detected (${report.devWallet.linkedWallets}).`);
  if (report.contract.honeypot === true) risks.push("Honeypot risk is flagged.");
  if (report.contract.simulationSuccess === false) risks.push("Security simulation failed.");
  if ((report.contract.buyTax ?? 0) > 15 || (report.contract.sellTax ?? 0) > 15) risks.push("High transfer tax is flagged.");
  if ((report.liquidity.liquidityUsd ?? 0) < 20_000 && report.liquidity.liquidityUsd !== null) risks.push("Liquidity is thin for meaningful exits.");
  if (report.missing.length > 0) risks.push("Important risk checks are still unverified.");

  let verdict: "WATCH" | "SCAN DEEPER" | "AVOID" | "UNKNOWN" = "SCAN DEEPER";
  let confidence: "Low" | "Medium" | "High" = "Medium";

  const critical = report.contract.honeypot === true || (report.contract.buyTax ?? 0) > 20 || (report.contract.sellTax ?? 0) > 20;
  const lowCap = buildLowCapRead(report).isLowCap;
  const lowLiq = (report.market.liquidity ?? 0) < 100_000;
  const missingLp = report.liquidity.lpLocked === null;
  const missingHolders = report.holders.holderCount == null && report.holders.top10Pct == null;
  const strongWatchSetup = (report.market.liquidity ?? 0) >= 50_000
    && report.holders.top10Pct != null
    && report.contract.honeypot === false
    && (report.contract.buyTax ?? 999) === 0
    && (report.contract.sellTax ?? 999) === 0
    && report.liquidity.lpLocked === true;
  const cautionSetup = report.liquidity.lpLocked === false || (report.holders.topHolderPct != null && report.holders.topHolderPct >= 20) || (report.holders.top10Pct != null && report.holders.top10Pct >= 60);
  if (critical) {
    verdict = "AVOID";
    confidence = report.contract.securityStatus === "verified" ? "High" : "Medium";
  } else if (!report.token.address || (!report.market.marketSourceAvailable && report.missing.length >= 5)) {
    verdict = "UNKNOWN";
    confidence = "Low";
  } else if (lowCap && lowLiq && missingLp && missingHolders) {
    verdict = "SCAN DEEPER";
    confidence = "Low";
  } else if (strongWatchSetup) {
    verdict = "WATCH";
    confidence = "Medium";
  } else if (cautionSetup) {
    verdict = "SCAN DEEPER";
    confidence = "Low";
  } else if (report.contract.securityStatus === "unverified") {
    verdict = "SCAN DEEPER";
    confidence = "Low";
  } else if ((report.liquidity.liquidityUsd ?? 0) >= 100_000 && report.contract.honeypot === false && (report.contract.buyTax ?? 999) <= 10 && (report.contract.sellTax ?? 999) <= 10 && report.missing.length <= 5) {
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
        : report.contract.securityStatus === "unverified"
          ? "Security simulation is unverified right now. Market and liquidity data alone cannot confirm safety."
          : "I can't call it safe from market data alone; risk coverage is still incomplete.";

  const nextAction = verdict === "AVOID"
    ? "Avoid until the flagged risks are resolved and re-verified."
    : "Treat this as watchlist-only until LP control, holder concentration, contract checks, and deployer behavior are verified on fresh scans.";

  return { verdict, confidence, signals: signals.slice(0, 5), risks: risks.slice(0, 5), clarkRead: safeLine, nextAction };
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function buildLowCapRead(report: ClarkFullReportEvidence): { isLowCap: boolean; lines: string[] } {
  const liq = report.market.liquidity ?? 0;
  const vol = report.market.volume24h ?? 0;
  const mcap = report.market.marketCap;
  const fdv = report.market.fdv;
  const holderCount = report.holders.holderCount;
  const vtl = (report.market.volume24h != null && report.market.liquidity != null && report.market.liquidity > 0)
    ? report.market.volume24h / report.market.liquidity
    : null;
  const isLowCap = liq < 100_000 || vol < 100_000 || mcap == null || mcap < 5_000_000 || (fdv != null && fdv < 5_000_000) || holderCount == null || holderCount < 500;
  if (!isLowCap) return { isLowCap: false, lines: [] };
  const lines = [
    `Depth: liquidity ${formatUsdShort(report.market.liquidity)}, volume ${formatUsdShort(report.market.volume24h)}.`,
    `Flow quality: volume/liquidity ratio ${vtl != null ? vtl.toFixed(2) : "unavailable"} (${vtl != null && vtl > 1.5 ? "fast-turnover microcap flow" : "thin/uncertain turnover"}; turnover signal, not proof of safety).`,
    `Holder pressure: top holder ${report.holders.topHolderPct != null ? `${report.holders.topHolderPct.toFixed(1)}%` : "unavailable"}, top10 ${report.holders.top10Pct != null ? `${report.holders.top10Pct.toFixed(1)}%` : "unavailable"}${(report.holders.topHolderPct != null && report.holders.topHolderPct > 20) || (report.holders.top10Pct != null && report.holders.top10Pct > 50) ? " (concentration risk elevated)" : ""}.`,
    `LP control: ${report.liquidity.lpLocked === true ? "burned/locked signal present" : report.liquidity.lpLocked === false ? "team-controlled / unlocked risk" : "unverified"}.`,
    `Security sim: ${formatSecuritySimulationLine(report).replace("Simulation: ", "")}, taxes ${report.contract.buyTax != null && report.contract.sellTax != null ? `${report.contract.buyTax}% / ${report.contract.sellTax}%` : "unverified"}.`,
  ];
  return { isLowCap: true, lines };
}


function formatSecuritySimulationLine(report: ClarkFullReportEvidence): string {
  const simPassed = (report.contract.simulationSuccess as unknown) === true;
  if (simPassed) return 'Simulation: Passed';
  if (report.contract.honeypot === false && !simPassed) {
    return 'Security sim: Partial — honeypot not flagged, but full simulation failed/unavailable.';
  }
  return `Simulation: ${report.contract.simulationSuccess === false ? 'Failed' : 'No signal in checked window'}`;
}

function explainMissingCheck(item: string): string {
  const map: Record<string,string> = {
    'Contract open-source verification': 'Contract open-source verification — Needs verified source publication or bytecode-level check from current providers.',
    'LP lock/control — confirms whether liquidity can be removed or is locked/burned': 'LP lock/control — Unconfirmed whether LP tokens are burned, locked, or wallet-controlled. Locker proof or protocol-specific verification needed.',
    'LP lock/control': 'LP lock/control — Unconfirmed whether LP tokens are burned, locked, or wallet-controlled.',
    'Pool age / new pool status': 'Pool age / new pool status — Needs pool created/first-seen timestamp.',
    'Likely deployer identity': 'Likely deployer identity — Needs creator/deployer transaction trace or factory event.',
    'Transfer tax check': 'Transfer controls — Needs source/ABI or bytecode check for owner/mint/tax controls.',
    'Buy tax check': 'Transfer controls — Needs source/ABI or bytecode check for owner/mint/tax controls.',
    'Sell tax check': 'Transfer controls — Needs source/ABI or bytecode check for owner/mint/tax controls.',
  }
  return map[item] ?? item
}
function renderQuickTokenScan(report: ClarkFullReportEvidence): string {
  const verdict = evaluateFullReportVerdict(report);
  const name = report.token.name ?? "Unknown token";
  const symbol = report.token.symbol ?? "?";
  const address = report.token.address ?? "Unresolved";
  const quickRead =
    verdict.verdict === "AVOID" ? "Critical risk flags are present right now." :
    verdict.verdict === "WATCH" ? "Setup is tradable to watch, but still requires active risk checks." :
    verdict.verdict === "UNKNOWN" ? "Coverage is too thin for a clean safety call." :
    "This token needs deeper verification before conviction.";
  const signals = dedupeLines(verdict.signals).slice(0, 3);
  const lowCap = buildLowCapRead(report);
  const risks = dedupeLines([
    ...verdict.risks,
    report.holders.topHolderPct != null ? `Top holder controls ${report.holders.topHolderPct.toFixed(1)}% of supply.` : "",
    report.holders.top10Pct != null && report.holders.top10Pct > 40 ? `Top 10 holders control ${report.holders.top10Pct.toFixed(1)}% of supply.` : "",
    report.market.displayMarketValueLabel === 'FDV' ? "Market cap unverified — showing FDV as fallback." : (report.market.displayMarketValueLabel === 'Estimated MC' ? "Estimated market cap — circulating supply not provider-verified." : ""),
    report.liquidity.lpLocked === null ? "LP control not confirmed." : "",
  ]).filter(Boolean).slice(0, 5);
  return [
    "TOKEN SCAN READ",
    `Asset: ${name} (${symbol})`,
    `Contract: ${address}`,
    `Verdict: ${verdict.verdict}`,
    `Confidence: ${verdict.confidence}`,
    "",
    "Quick read:",
    quickRead,
    "",
    ...(lowCap.isLowCap ? ["Low-cap read:", ...lowCap.lines, ""] : []),
    ...(lowCap.isLowCap ? [""] : []),
    "Market / liquidity:",
    `- Price: ${report.market.price != null ? `$${report.market.price}` : "No signal in checked window"}`,
    `- Liquidity: ${formatUsdShort(report.market.liquidity)}`,
    `- 24h volume: ${formatUsdShort(report.market.volume24h)}`,
    `- Market value: ${report.market.displayMarketValue != null ? formatUsdShort(report.market.displayMarketValue) + ` (${report.market.displayMarketValueLabel}${report.market.displayMarketValueLabel === 'Estimated MC' ? ', circulating supply not fully verified' : report.market.displayMarketValueLabel === 'FDV' ? ', true MC unavailable' : ''})` : "No signal in checked window — price/supply data missing"}`,
    `- FDV: ${report.market.fdv != null ? formatUsdShort(report.market.fdv) : "No signal in checked window"}`,
    "",
    "Security / simulation:",
    `- ${report.contract.honeypot === true ? "Honeypot: Flagged" : report.contract.honeypot === false ? `Honeypot: ${report.contract.simulationSuccess == null ? "Not flagged by available checks" : "Not flagged"}` : (report.contract.buyTax != null || report.contract.sellTax != null) ? "Honeypot simulation: No signal in checked window" : "Honeypot: Unverified"}`,
    `- Buy tax: ${report.contract.buyTax != null ? `${report.contract.buyTax}%` : "Unverified"}`,
    `- Sell tax: ${report.contract.sellTax != null ? `${report.contract.sellTax}%` : "Unverified"}`,
    `- ${formatSecuritySimulationLine(report)}`,
    `- Proxy / mint / ownership: ${boolToWord(report.contract.proxy)} / ${boolToWord(report.contract.mintable)} / ${boolToWord(report.devWallet.likelyDeployer ? false : null)}`,
    "",
    "Holder / distribution:",
    `- Holder count: ${report.holders.holderCount != null ? formatInt(report.holders.holderCount) : (report.holders.top10Pct != null ? "Holder rows available; total holder count unavailable" : "No signal in checked window")}`,
    `- Top holder: ${report.holders.topHolderPct != null ? `${report.holders.topHolderPct.toFixed(2)}%` : "No signal in checked window"}`,
    `- Top 10: ${report.holders.top10Pct != null ? `${report.holders.top10Pct.toFixed(2)}%` : "No signal in checked window"}`,
    `- Status: ${report.holders.status ?? "unavailable"}`,
    "",
    "Bull case:",
    ...(signals.length ? signals.map((s) => `- ${s}`) : ["- No strong positive signal confirmed yet."]),
    "",
    "Bear case:",
    ...(risks.length ? risks.map((r) => `- ${r}`) : ["- No major risk flag confirmed in available fields."]),
    "",
    "Missing checks:",
    ...report.missing.slice(0, 4).map((m) => `- ${explainMissingCheck(m)}`),
    "",
    "Next action:",
    verdict.nextAction,
  ].join("\n");
}

function renderFullTokenReport(report: ClarkFullReportEvidence): string {
  const verdict = evaluateFullReportVerdict(report);
  const name = report.token.name ?? "Unknown token";
  const symbol = report.token.symbol ?? "?";
  const address = report.token.address ?? "Unresolved";

  const quickRead =
    verdict.verdict === "AVOID"
      ? "Risk flags are confirmed enough to keep this offside right now."
      : verdict.verdict === "WATCH"
        ? "Market depth is usable and no confirmed contract red flags — monitor actively."
        : verdict.verdict === "UNKNOWN"
          ? "Coverage is too incomplete for a reliable call. Key fields are still unverified."
          : "Usable signals are present, but missing risk checks prevent a conviction rating.";

  const bullCase = dedupeLines([
    !isNearZeroLiquidity(report.market.liquidity) ? `Liquidity visible at ${formatUsdShort(report.market.liquidity)}.` : "",
    report.market.volume24h != null ? `24h volume active around ${formatUsdShort(report.market.volume24h)}.` : "",
    report.contract.honeypot === false ? "No honeypot flag detected in current checks." : "",
    report.contract.buyTax != null && report.contract.sellTax != null && report.contract.buyTax <= 5 && report.contract.sellTax <= 5
      ? "Tax profile looks reasonable in this snapshot." : "",
  ]).filter(Boolean).slice(0, 3);

  const bearCase = dedupeLines([
    report.contract.honeypot === true ? "Honeypot risk is flagged." : "",
    (report.contract.buyTax ?? 0) > 15 || (report.contract.sellTax ?? 0) > 15 ? "High transfer tax present." : "",
    (report.devWallet.linkedWallets ?? 0) > 0 ? `Linked deployer cluster detected (${report.devWallet.linkedWallets}).` : "",
    (report.liquidity.liquidityUsd ?? 0) > 0 && (report.liquidity.liquidityUsd ?? 0) < 20_000 ? "Liquidity depth is thin for clean exits." : "",
    report.holders.topHolderPct != null ? `Top holder controls ${report.holders.topHolderPct.toFixed(1)}% of supply.` : "",
    report.holders.top10Pct != null && report.holders.top10Pct > 40 ? `Top 10 holders control ${report.holders.top10Pct.toFixed(1)}% of supply.` : "",
    report.market.displayMarketValueLabel === 'FDV' ? "Market cap unverified — showing FDV as fallback." : (report.market.displayMarketValueLabel === 'Estimated MC' ? "Estimated market cap — circulating supply not provider-verified." : ""),
    report.liquidity.lpLocked === null ? "LP control not confirmed." : "",
  ]).filter(Boolean).slice(0, 5);

  const lpControl = report.liquidity.lpLocked === true
    ? "Locked (confirmed)"
    : report.liquidity.lpLocked === false
      ? "Unlocked (confirmed)"
      : "Not confirmed — LP lock status unverified.";
  const lowCap = buildLowCapRead(report);

  return [
    "TOKEN SCAN READ",
    `Asset: ${name} (${symbol})`,
    `Contract: ${address}`,
    `Verdict: ${verdict.verdict}`,
    `Confidence: ${verdict.confidence}`,
    "",
    "Quick read:",
    quickRead,
    "",
    ...(lowCap.isLowCap ? ["Low-cap read:", ...lowCap.lines, ""] : []),
    "Market / liquidity:",
    `- Price: ${report.market.price != null ? `$${report.market.price}` : "No signal in checked window"}`,
    `- Liquidity: ${formatUsdShort(report.market.liquidity)}`,
    `- Volume (24h): ${formatUsdShort(report.market.volume24h)}`,
    `- Market value: ${report.market.displayMarketValue != null ? formatUsdShort(report.market.displayMarketValue) + ` (${report.market.displayMarketValueLabel}${report.market.displayMarketValueLabel === 'Estimated MC' ? ', circulating supply not fully verified' : report.market.displayMarketValueLabel === 'FDV' ? ', true MC unavailable' : ''})` : "No signal in checked window — price/supply data missing"}`,
    `- FDV: ${report.market.fdv != null ? formatUsdShort(report.market.fdv) : "No signal in checked window"}`,
    `- Pool depth: ${formatUsdShort(report.liquidity.liquidityUsd)}`,
    `- LP control: ${lpControl}`,
    "",
    "Security / simulation:",
    `- ${report.contract.honeypot === true ? "Honeypot: Flagged" : report.contract.honeypot === false ? `Honeypot: ${report.contract.simulationSuccess == null ? "Not flagged by available checks" : "Not flagged"}` : (report.contract.buyTax != null || report.contract.sellTax != null) ? "Honeypot simulation: No signal in checked window" : "Honeypot: Unverified"}`,
    `- Buy tax: ${report.contract.buyTax != null ? `${report.contract.buyTax}%` : "Unverified"}`,
    `- Sell tax: ${report.contract.sellTax != null ? `${report.contract.sellTax}%` : "Unverified"}`,
    `- ${formatSecuritySimulationLine(report)}`,
    `- Transfer controls: ${report.contract.proxy === true || report.contract.mintable === true ? "Potentially elevated control surface" : "Unverified"}`,
    `- Deployer: ${report.devWallet.likelyDeployer ? shortAddress(report.devWallet.likelyDeployer) : "Unverified"}`,
    "",
    "Holder / distribution:",
    `- Holder count: ${report.holders.holderCount != null ? formatInt(report.holders.holderCount) : "No signal in checked window"}`,
    `- Top holder: ${report.holders.topHolderPct != null ? `${report.holders.topHolderPct.toFixed(2)}%` : "No signal in checked window"}`,
    `- Top 10: ${report.holders.top10Pct != null ? `${report.holders.top10Pct.toFixed(2)}%` : "No signal in checked window"}`,
    "",
    "Bull case:",
    ...(bullCase.length ? bullCase.map((s) => `- ${s}`) : ["- No strong positive signal confirmed yet."]),
    "",
    "Bear case:",
    ...(bearCase.length ? bearCase.map((r) => `- ${r}`) : ["- No major risk flag confirmed in available fields."]),
    "",
    "Missing checks:",
    ...(report.missing.length ? report.missing.slice(0, 5).map((m) => `- ${explainMissingCheck(m)}`) : ["- No major gaps in currently available scan fields."]),
    "",
    "Next action:",
    verdict.nextAction,
  ].join("\n");
}

function renderDevWalletFocusedRead(
  tokenName: string,
  tokenSymbol: string,
  tokenAddress: string,
  devWallet: NonNullable<ClarkToolEvidence["devWallet"]>
): string {
  const originRead = devWallet.deployerAddress
    ? `Deployer identified: ${shortAddress(devWallet.deployerAddress)} (${devWallet.confidence} confidence).`
    : "Origin wallet could not be verified from this pass.";
  const linkedRead = devWallet.linkedWallets > 0
    ? `${devWallet.linkedWallets} linked wallet${devWallet.linkedWallets > 1 ? "s" : ""} found in deployer cluster.`
    : "No linked wallet signals returned.";
  const priorActivity = devWallet.warnings.length > 0
    ? devWallet.warnings.slice(0, 2).filter(w => /deploy|prior|previous|history|created|launch/i.test(w)).join("; ") || "Prior activity data is incomplete."
    : "Prior activity incomplete.";
  const riskFlags = devWallet.warnings.filter(w => /suspicious|overlap|concentration|admin|control|funding|linked/i.test(w)).slice(0, 3);
  const missingChecks: string[] = [];
  if (!devWallet.deployerAddress) missingChecks.push("Deployer identity is unverified from current CORTEX scan.");
  if (devWallet.linkedWallets === 0) missingChecks.push("Linked wallet cluster is unconfirmed.");
  missingChecks.push("PnL, win rate, and deployer history are not verified from this scan.");
  missingChecks.push("Smart-money status is not confirmed.");
  return [
    "DEV WALLET READ",
    "",
    `Token: ${tokenName} (${tokenSymbol})`,
    `Contract: ${tokenAddress}`,
    "",
    "Origin read:",
    originRead,
    "",
    "Linked wallet signals:",
    linkedRead,
    "",
    "Prior activity:",
    priorActivity,
    "",
    "Risk flags:",
    riskFlags.length > 0 ? riskFlags.map(f => `- ${f}`).join("\n") : "- No confirmed risk flags from this CORTEX scan.",
    "",
    "Missing checks:",
    missingChecks.map(m => `- ${m}`).join("\n"),
    "",
    "Next action:",
    "Compare origin wallet activity with holder concentration and liquidity control. No trade call.",
  ].join("\n");
}

function renderLiquidityFocusedRead(
  tokenName: string,
  tokenSymbol: string,
  tokenAddress: string,
  liquidity: NonNullable<ClarkToolEvidence["liquidity"]>
): string {
  const liq = liquidity.liquidityUsd;
  const vol = liquidity.volume24h;
  const short = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;

  // Verdict
  const verdict =
    liq == null ? "INCOMPLETE READ" :
    liq >= 1_000_000 ? "STRONG DEPTH" :
    liq >= 300_000 ? "MODERATE DEPTH" :
    liq >= 50_000 ? "THIN DEPTH" :
    "THIN DEPTH";

  // LP control line — never claim locked without data
  const lpControlLine =
    liquidity.riskTier === "low"
      ? "LP lock/control is unverified. Treat liquidity as usable depth, not guaranteed safety."
      : liquidity.riskTier === "extreme"
        ? "LP structure appears fragile. LP control is unverified from current CORTEX data."
        : "LP lock/control is unverified. Treat liquidity as usable depth, not guaranteed safety.";

  // Depth interpretation
  const depthInterpretation =
    isNearZeroLiquidity(liq) ? "Liquidity data is near-zero/unverified — pool depth quality is weak."
    : liq! >= 1_000_000 ? `${formatUsdShort(liq)} — strong depth for normal lowcap trading.`
    : liq! >= 300_000 ? `${formatUsdShort(liq)} — moderate depth; slippage can matter on larger entries.`
    : liq! >= 50_000 ? `${formatUsdShort(liq)} — thin depth; move can reverse fast on exits.`
    : `${formatUsdShort(liq)} — microcap depth; treat signals as noisy.`;

  // Turnover / flow
  const turnoverLines: string[] = [];
  if (vol != null && liq != null && liq > 100) {
    const ratio = vol / liq;
    const ratioStr = ratio.toFixed(1);
    const quality =
      ratio < 0.5 ? `Volume is ${ratioStr}x liquidity — calm/low turnover.` :
      ratio < 2 ? `Volume is ${ratioStr}x liquidity — active trading flow.` :
      ratio < 8 ? `Volume is ${ratioStr}x liquidity — high turnover; slippage risk elevated.` :
      `Volume is ${ratioStr}x liquidity — extreme churn; pool is turning over fast.`;
    turnoverLines.push(quality);
    turnoverLines.push(`24h vol ${formatUsdShort(vol)} vs liquidity ${formatUsdShort(liq)}.`);
  } else {
    turnoverLines.push("Turnover ratio is not reliable because liquidity is near-zero/unverified.");
  }

  // Primary pool
  const primaryPoolLine = liquidity.primaryPool
    ? liquidity.primaryPool
    : "Primary pool selected from live Base pool data.";

  // Risk flags
  const riskFlags: string[] = [];
  if (!isNearZeroLiquidity(liq) && liq! < 50_000) riskFlags.push("Thin liquidity — exit slippage elevated.");
  if (vol != null && liq != null && liq > 0 && (vol / liq) > 8) riskFlags.push("Extreme volume/liquidity ratio — high churn and slippage risk.");
  riskFlags.push("LP lock/control unverified.");
  if (liquidity.riskTier === "extreme") riskFlags.push("LP structure flagged as fragile by CORTEX data.");
  if (liquidity.warnings.length > 0) riskFlags.push(...liquidity.warnings.slice(0, 2));
  if (isNearZeroLiquidity(liq)) riskFlags.push("Liquidity is near-zero/unverified.");

  // Missing checks
  const missingChecks = [
    "LP lock/control confirmation not available from this scan.",
    "Holder distribution and concentration not included in this pass.",
    "Dev wallet and deployer behavior not verified.",
  ];

  return [
    "LIQUIDITY READ",
    "",
    `Token: ${tokenName} (${tokenSymbol})`,
    `Contract: ${short}`,
    "",
    `Verdict: ${verdict}`,
    "",
    "Primary pool:",
    primaryPoolLine,
    "",
    "Liquidity depth:",
    depthInterpretation,
    "",
    "Turnover / flow:",
    ...turnoverLines,
    "",
    "LP control / lock:",
    lpControlLine,
    "",
    "Risk flags:",
    ...dedupeLines(riskFlags).map(f => `- ${f}`),
    "",
    "Missing checks:",
    ...dedupeLines(missingChecks).map(m => `- ${m}`),
    "",
    "Next action:",
    "Verify LP control, holders, and dev wallet before conviction. No trade call.",
  ].join("\n");
}

function parseAbbrevUsdToNumber(raw: string | null): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, "").match(/\$?\s*([0-9]*\.?[0-9]+)\s*([KMB])?/i);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = !m[2] ? 1 : m[2].toUpperCase() === "K" ? 1_000 : m[2].toUpperCase() === "M" ? 1_000_000 : 1_000_000_000;
  return base * mult;
}

// ---------- Follow-up and casual chat routing ----------

type TokenFollowupType = "lp" | "deployer" | "holders" | "combined";

function detectTokenFollowup(
  prompt: string,
  history: ClarkRequestBody["history"]
): { type: TokenFollowupType; contractAddress: string; scanText: string } | null {
  const t = prompt.trim().toLowerCase();
  const GENERIC_RE = /^(go|do it|run it|check that|next|continue|run follow[\s-]?up checks?|proceed|yes|yep)$/i;
  const LP_RE = /\b(check lp|what about lp|lp check|check liquidity|what about liquidity|lp control|liquidity check)\b/i;
  const DEPLOYER_RE = /\b(check deployer|what about deployer|check dev wallet|deployer check|deployer behavior|check dev)\b/i;
  const HOLDERS_RE = /\b(check holders?|what about holders?|holder check|holder distribution|who holds|holder concentration)\b/i;

  // If prompt names a specific token alongside the LP/deployer keyword, it's a new query — not a followup
  if ((LP_RE.test(t) || DEPLOYER_RE.test(t)) && extractTokenLookupQuery(prompt)) return null;

  const isFollowup = GENERIC_RE.test(t) || LP_RE.test(t) || DEPLOYER_RE.test(t) || HOLDERS_RE.test(t);
  if (!isFollowup) return null;

  const lastScan = extractLastTokenScanFromHistory(history);
  if (!lastScan) return null;

  const type: TokenFollowupType = LP_RE.test(t) ? "lp" : DEPLOYER_RE.test(t) ? "deployer" : HOLDERS_RE.test(t) ? "holders" : "combined";
  return { type, ...lastScan };
}

function buildTokenFollowupReply(type: TokenFollowupType, contractAddress: string, scanText: string): string {
  const ex = (label: string) => {
    const m = scanText.match(new RegExp(`(?:^|\\n)[-\\s]*${label}:\\s*([^\\n]+)`, "i"));
    return m?.[1]?.trim() ?? null;
  };
  const nameRaw = ex("Asset") ?? "";
  const tokenName = nameRaw.split("(")[0].trim() || "Unknown";
  const symbol = nameRaw.match(/\(([^)]+)\)/)?.[1] ?? "?";
  const short = `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;

  if (type === "lp") {
    const liq = ex("Liquidity") ?? ex("Pool depth") ?? "No signal in checked window";
    const lpControl = ex("LP control");
    return [
      `Liquidity / LP — ${tokenName} (${symbol})`,
      `Contract: ${short}`,
      "",
      `Pool depth: ${liq}`,
      `LP control: ${lpControl ?? "Not confirmed from current data"}`,
      "",
      "LP lock and control are not verified in this scan. Use Liquidity Safety with this contract for confirmed LP control status.",
      `Next: Liquidity Safety → ${contractAddress}`,
    ].join("\n");
  }

  if (type === "deployer") {
    return [
      `Deployer check — ${tokenName} (${symbol})`,
      `Contract: ${short}`,
      "",
      "Deployer behavior check is not fully wired in Clark chat follow-ups.",
      "Current scan only covers owner/proxy/mint/security fields.",
      "",
      "To check the deployer cluster: use Dev Wallet Detector with this contract.",
      `Next: Dev Wallet Detector → ${contractAddress}`,
    ].join("\n");
  }

  if (type === "holders") {
    const holderCount = ex("Holder count") ?? "No signal in checked window";
    const topHolder = ex("Top holder") ?? "No signal in checked window";
    const top10 = ex("Top 10") ?? "No signal in checked window";
    const status = ex("Status") ?? "unavailable";
    const top10Num = parseFloat(top10.replace("%", ""));
    const conc = Number.isFinite(top10Num) ? (top10Num >= 60 ? "High" : top10Num >= 30 ? "Medium" : "Low") : "Unknown";
    return [
      `Holder distribution — ${tokenName} (${symbol})`,
      `Contract: ${short}`,
      "",
      `Holder count: ${holderCount}`,
      `Top holder: ${topHolder}`,
      `Top 10 holders: ${top10}`,
      `Concentration: ${conc}`,
      `Data status: ${status}`,
      "",
      "Holder identity is not verified — these are on-chain distribution counts only.",
    ].join("\n");
  }

  // combined
  const liq = ex("Liquidity") ?? ex("Pool depth") ?? "Not available";
  const lpControl = ex("LP control") ?? "Not confirmed";
  const holderCount = ex("Holder count") ?? "Not available";
  const top10 = ex("Top 10") ?? "Not available";
  const missingMatch = scanText.match(/Missing checks:\n([\s\S]*?)(?:\n\n|\nNext action:|$)/i);
  const missingLines = missingMatch?.[1]
    ?.split("\n").filter(l => l.trim().startsWith("-")).slice(0, 3).map(l => l.trim()).join("\n")
    ?? "- LP control\n- Deployer behavior";
  return [
    `Follow-up — ${tokenName} (${symbol})`,
    `Contract: ${short}`,
    "",
    `LP check: pool depth ${liq}, LP control ${lpControl}`,
    `Holder check: count ${holderCount}, top 10 at ${top10}`,
    "Deployer check: not wired in Clark chat — use Dev Wallet Detector for confirmed deployer analysis.",
    "",
    "Still missing from this scan:",
    missingLines,
    "",
    "Next: Dev Wallet Detector for deployer, Liquidity Safety for LP control confirmation.",
  ].join("\n");
}

function buildHolderFocusedReply(report: ClarkFullReportEvidence): string {
  const { token, holders } = report;
  const name = token.name ?? "Unknown";
  const sym = token.symbol ?? "?";
  const addr = token.address ?? null;
  const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "Unverified";
  const holderCount = holders.holderCount != null ? holders.holderCount.toLocaleString() : "Unverified";
  const top1 = holders.topHolderPct != null ? `${holders.topHolderPct.toFixed(1)}%` : "Unverified";
  const top10 = holders.top10Pct != null ? `${holders.top10Pct.toFixed(1)}%` : "Unverified";
  const top10Num = holders.top10Pct ?? null;
  const conc = top10Num != null
    ? (top10Num >= 60 ? "High — concentrated ownership, dump risk elevated" : top10Num >= 30 ? "Medium — watch for coordinated exits" : "Low — distributed holding pattern")
    : "Unknown";
  const dataUnavailable = holders.holderCount == null && holders.top10Pct == null && holders.topHolderPct == null;
  return [
    `Holder distribution — ${name} (${sym})`,
    `Contract: ${short}`,
    "",
    `Holder count: ${holderCount}`,
    `Top holder: ${top1}`,
    `Top 10 holders: ${top10}`,
    `Concentration: ${conc}`,
    "",
    dataUnavailable
      ? "Holder data unavailable in this pass. Holder identities are not verified — on-chain distribution counts only."
      : "Holder identity is not verified — on-chain distribution counts only.",
    "Next: run full report or liquidity check for a complete risk read.",
  ].join("\n");
}

function buildCasualContextualReply(prompt: string, lastScanText: string | null, recentContext: string): string {
  const t = prompt.trim().toLowerCase();
  if (/what do you think|is that bad|risky\??$/i.test(t)) {
    if (lastScanText) {
      const verdict = lastScanText.match(/Verdict:\s*(\w[\w ]*)/i)?.[1]?.trim() ?? "UNKNOWN";
      const name = lastScanText.match(/Asset:\s*([^(\n]+)/i)?.[1]?.trim() ?? "that token";
      return `Last scan for ${name}: ${verdict}. ${
        verdict === "AVOID" ? "Risk flags are confirmed — I'd stay out." :
        verdict === "WATCH" ? "Watch-only. LP control and deployer are still unverified." :
        verdict === "TRUSTWORTHY" ? "No confirmed red flags, but verify LP and deployer independently before sizing." :
        "Coverage is thin — not enough to call it safe or unsafe yet."
      } What specifically do you want to dig into?`;
    }
    return "Share the contract or scan result and I can give you a clearer read.";
  }
  if (/^why$/i.test(t)) {
    if (lastScanText) {
      const verdict = lastScanText.match(/Verdict:\s*(\w[\w ]*)/i)?.[1]?.trim() ?? "UNKNOWN";
      return `The ${verdict} verdict comes from what the scanner could and couldn't verify. ${
        verdict === "AVOID" ? "The bear case signals are confirmed enough to flag it." :
        verdict === "WATCH" ? "No confirmed red flag, but LP control and deployer are unverified — that's the gap." :
        "The scanner didn't have enough data coverage for a stronger call."
      } What part do you want broken down?`;
    }
    return "Why what? Share context or a contract and I can break it down.";
  }
  if (/^explain this$/i.test(t)) {
    if (recentContext.includes("TOKEN SCAN READ") || recentContext.includes("CLARK TOKEN SCAN")) {
      const verdict = recentContext.match(/Verdict:\s*(\w[\w ]*)/i)?.[1]?.trim() ?? "UNKNOWN";
      return `The token came back ${verdict}. ${
        verdict === "AVOID" ? "Confirmed risk flags from security simulation or contract checks." :
        verdict === "WATCH" ? "No confirmed red flags yet, but LP lock, deployer cluster, and some contract fields are unverified." :
        verdict === "TRUSTWORTHY" ? "No major flags in this scan — still verify LP and deployer before conviction." :
        "Not enough evidence for a confident call."
      } What part do you want me to break down?`;
    }
    return "Explain what? Paste a scan result or contract and I'll break it down.";
  }
  if (/^(yo|hey|bro|man|dude)\b/i.test(t)) {
    if (lastScanText) {
      const name = lastScanText.match(/Asset:\s*([^(\n]+)/i)?.[1]?.trim() ?? "that last token";
      const verdict = lastScanText.match(/Verdict:\s*(\w[\w ]*)/i)?.[1]?.trim() ?? "UNKNOWN";
      return `Still on ${name} (${verdict}). Want to go deeper on something specific?`;
    }
    return "Clark here. What are we looking at?";
  }
  return "What do you want me to look at? Paste a contract, wallet, or ask about something specific.";
}

function buildWatchVerdictFromScan(scanText: string, contractAddress: string): string {
  const ex = (label: string) => {
    const m = scanText.match(new RegExp(`(?:^|\\n)[-\\s]*${label}:\\s*([^\\n]+)`, "i"));
    return m?.[1]?.trim() ?? null;
  };
  const nameRaw = ex("Asset") ?? "";
  const tokenName = nameRaw.split("(")[0].trim() || "Unknown";
  const symbol = nameRaw.match(/\(([^)]+)\)/)?.[1] ?? "?";
  const verdict = ex("Verdict") ?? "UNKNOWN";
  const liquidity = ex("Liquidity") ?? ex("Pool depth") ?? null;
  const volume = ex("Volume") ?? ex("24h volume") ?? null;
  const topHolder = ex("Top holder") ?? null;
  const top10 = ex("Top 10") ?? null;
  const lpControl = ex("LP control") ?? null;
  const honeypot = ex("Honeypot") ?? null;
  const sellTax = ex("Sell tax") ?? null;
  const buyTax = ex("Buy tax") ?? null;
  const short = `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;

  // Choose watch decision based on verdict
  const decision =
    verdict === "AVOID" ? "AVOID FOR NOW" :
    verdict === "WATCH" ? "WATCH" :
    verdict === "TRUSTWORTHY" ? "WATCH" :
    verdict === "SCAN DEEPER" ? "SCAN DEEPER" :
    "LOW SIGNAL";

  // Intro line varies by decision
  const intro =
    decision === "WATCH" ? "Worth watching, not enough for conviction." :
    decision === "AVOID FOR NOW" ? "Risk flags present. Monitor only — no entry without clean checks." :
    decision === "SCAN DEEPER" ? "Signal exists but coverage is too thin. Deeper checks needed before watchlist." :
    "Not enough signal yet. This read is too incomplete for confidence.";

  // Build why bullets from available data
  const why: string[] = [];
  if (liquidity) {
    const nearZero = /\$-?0(?:\.0+)?\b|\$0\b/i.test(liquidity);
    why.push(`Liquidity: ${nearZero ? "near-zero / unverified" : liquidity}`);
  }
  if (volume) why.push(`Volume: ${volume}`);
  if (topHolder) why.push(`Top holder: ${topHolder}`);
  if (top10) why.push(`Top 10 holders: ${top10}`);
  if (lpControl) why.push(`LP control: ${lpControl}`);
  else why.push("LP lock/control: unverified");
  if (honeypot && !/unverified/i.test(honeypot)) why.push(`Honeypot: ${honeypot}`);
  if (sellTax && !/unverified/i.test(sellTax)) why.push(`Sell tax: ${sellTax}`);
  if (buyTax && !/unverified/i.test(buyTax)) why.push(`Buy tax: ${buyTax}`);

  // Main risk
  const riskMatch = scanText.match(/Bear case:\n([\s\S]*?)(?:\n\n|\nMissing|$)/i);
  const bearLines = riskMatch?.[1]?.split("\n").filter(l => l.trim().startsWith("-")).slice(0, 2).map(l => l.trim().replace(/^-\s*/, "")) ?? [];
  const mainRisk = bearLines.length
    ? bearLines.join(". ")
    : "LP control and deployer behavior are not fully verified — treat as incomplete until confirmed.";

  // What would change my mind
  const changeMyMind = [
    "Verified LP lock or confirmed LP control status",
    "Holder concentration below 30% for top 10",
    "Volume sustaining after initial momentum",
  ];

  return [
    "WATCH VERDICT",
    "",
    `Token: ${tokenName} (${symbol})`,
    `Contract: ${short}`,
    "",
    `Decision: ${decision}`,
    "",
    intro,
    "",
    "Why:",
    ...why.slice(0, 5).map(b => `- ${b}`),
    "",
    "Main risk:",
    mainRisk,
    "",
    "What would change my read:",
    ...changeMyMind.map(c => `- ${c}`),
    "",
    "Next action:",
    "Run liquidity + holder + dev wallet checks before conviction. No trade call.",
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

async function handleWalletScanner(body: ClarkRequestBody, origin: string, authHeader?: string | null) {
  const chain = body.chain ?? "base";
  const walletAddress = body.walletAddress ?? body.addressOrToken;
  if (!walletAddress) throw new Error("walletAddress or addressOrToken is required");

  const userPrompt = (body.prompt ?? "").trim();
  const t = userPrompt.toLowerCase();
  const isBalanceQuestion = /\b(balance|balances|holdings?|portfolio|what(?:'s| is) in|how much|show me)\b/i.test(t);
  const isQualityQuestion = /\b(good wallet|worth following|smart money|copy trad|is this|analyze|review|verdict)\b/i.test(t);

  const { ok, json: walletData } = await callInternalApi(origin, "/api/wallet", { address: walletAddress }, authHeader ?? undefined);

  if (!ok || (walletData as Record<string, unknown>)?.error) {
    return {
      feature: "wallet-scanner",
      chain,
      walletAddress,
      analysis: `I couldn't pull wallet data for ${shortAddress(walletAddress)} right now. The wallet may be new or the current checks did not return enough verified evidence.`,
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
    const asksPnl = /\b(pnl|profit|loss|cost[-\s]?basis|realized|unrealized)\b/i.test(userPrompt)
    const pnlLine = asksPnl
      ? 'PnL/cost-basis history is not enabled in this release view. Current holdings and concentration are available.'
      : 'History not included in this release view. Current holdings, concentration, and Base activity summary are available.'
    return { feature: "wallet-scanner", chain, walletAddress, analysis: `${formatWalletBalanceSummary(normalized)}\n\n${pnlLine}` };
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
    const rawNameQuery = body.query ?? body.prompt;
    // Parse token name from phrases like "liquidity check BRETT" before passing to scan
    const nameQuery = rawNameQuery ? (extractTokenLookupQuery(rawNameQuery) ?? rawNameQuery.trim()) : null;

    if (contract && /^0x[a-fA-F0-9]{40}$/.test(contract)) {
      scanData = await callScanToken(contract, "contract", origin);
    } else if (nameQuery) {
      scanData = await callScanToken(nameQuery, "query", origin);
    }
  }

  const wantsPoolBreakdown = /\b(show all .*pools|show all pools|all pools for|pools for|token \d+ pools|cas pools|pool breakdown)\b/i.test(body.prompt ?? "");
  if (wantsPoolBreakdown) {
    const token = scanData as Record<string, unknown>;
    const pools = Array.isArray(token.pools) ? token.pools as Array<Record<string, unknown>> : [];
    const rows = pools.map((p) => {
      const a = (p.attributes ?? p) as Record<string, unknown>;
      const liq = formatUsdShort(typeof a.liquidity === "number" ? a.liquidity : (typeof a.reserve_in_usd === "number" ? a.reserve_in_usd : null));
      const vol = formatUsdShort(typeof a.volume24h === "number" ? a.volume24h : (typeof (a.volume_usd as Record<string, unknown> | undefined)?.h24 === "number" ? (a.volume_usd as Record<string, unknown>).h24 as number : null));
      const moveNum = typeof a.change24h === "number" ? a.change24h : (typeof (a.price_change_percentage as Record<string, unknown> | undefined)?.h24 === "number" ? (a.price_change_percentage as Record<string, unknown>).h24 as number : null);
      return {
        dex: typeof a.dex === "string" ? a.dex : (typeof a.dex_id === "string" ? a.dex_id : "DEX"),
        pair: typeof a.pair === "string" ? a.pair : (typeof a.name === "string" ? a.name : "pair"),
        liquidity: liq,
        volume: vol,
        move: moveNum != null ? `${moveNum.toFixed(2)}%` : "Unverified",
        pool: typeof a.address === "string" ? a.address : (typeof p.id === "string" ? p.id : "Unverified"),
        liqRaw: typeof a.liquidity === "number" ? a.liquidity : (typeof a.reserve_in_usd === "number" ? a.reserve_in_usd : 0),
      };
    }).sort((a, b) => (b.liqRaw ?? 0) - (a.liqRaw ?? 0));

    if (!rows.length) {
      return { feature: "scan-token", data: scanData, analysis: "I can't pull all pools right now, but I can still run a full report on the token." };
    }
    const tokenName = String((token.name as string | undefined) ?? "Token");
    const tokenSymbol = String((token.symbol as string | undefined) ?? "?");
    const contract = String((token.contract as string | undefined) ?? body.tokenAddress ?? body.addressOrToken ?? "Unverified");
    const topLiq = rows[0]?.liqRaw ?? 0;
    const totalLiq = rows.reduce((s, r) => s + (r.liqRaw ?? 0), 0);
    const concentrated = totalLiq > 0 && topLiq / totalLiq >= 0.6;
    return {
      feature: "scan-token",
      data: scanData,
      analysis: [
        `Pool breakdown: ${tokenSymbol}`,
        `Contract: ${contract}`,
        "",
        "Pools:",
        ...rows.slice(0, 8).map((r, i) => `${i + 1}. ${r.dex}/${r.pair} — liquidity ${r.liquidity} — 24h vol ${r.volume} — 24h move ${r.move} — pool ${r.pool}`),
        "",
        "Clark's read:",
        concentrated ? "Liquidity is concentrated in one dominant pool, so execution risk can spike if that pool thins out." : "Liquidity is spread across multiple pools, which usually improves execution resilience.",
        "",
        "Next:",
        "Run full report or liquidity check before sizing.",
      ].join("\n"),
    };
  }

  if (!scanData) {
    const label = body.tokenAddress ?? body.addressOrToken ?? body.query ?? body.prompt ?? "unknown";
    return {
      feature: "scan-token",
      analysis: `No Base token match from current checks. Paste a contract address for a deeper scan.`,
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

// ---------- Whale alert context handling ----------

type WhaleAlertRow = {
  wallet_label?: string | null
  wallet_address?: string | null
  token_symbol?: string | null
  focus_token_symbol?: string | null
  side?: string | null
  amount_token?: number | null
  amount_usd?: number | null
  signal_score?: string | null
  legs?: number | null
  repeats?: number | null
  occurred_at?: string | null
  summary?: string | null
  tx_hash?: string | null
  walletContext?: {
    shortAddress: string; behaviorType: string; behaviorScore: number; confidence: string
    repeatedTokens: string[]; alertCount24h: number; alertCount7d: number
    verifiedUsdFlow7d: number | null; monitorReason: string; nextWatch: string
    tags: string[]; isContract: boolean | null
  } | null
}
type WalletBehaviorLeader = {
  address: string; shortAddress: string; behaviorType: string; behaviorScore: number; confidence: string
  repeatedTokens: string[]; verifiedUsdFlow24h: number | null; alertCount24h: number; alertCount7d: number
  monitorReason: string; nextWatch: string
}
type WhaleIntelligence = {
  walletCount: number
  activeWalletCount: number
  pricedAlertCount: number
  unpricedAlertCount: number
  topRepeatedTokens?: string[]
  walletBehavior?: {
    monitoredWallets?: number
    behaviorLeaders?: Array<{
      address?: string
      shortAddress?: string
      behaviorType?: string
      behaviorScore?: number
      confidence?: "high" | "medium" | "low" | string
      repeatedTokens?: string[]
      verifiedUsdFlow24h?: number | null
      alertCount24h?: number
      alertCount7d?: number
      monitorReason?: string
      nextWatch?: string
    }>
    repeatedTokenWalletMap?: Array<{ token?: string; walletCount?: number; wallets?: string[]; totalVerifiedUsd?: number | null }>
  }
  topWallets?: Array<{
    address?: string
    shortAddress?: string
    alertCount24h?: number
    totalVerifiedUsd24h?: number | null
    repeatedTokens?: string[]
    confidence?: string
  }>
}

function formatWhaleAlertForClark(a: WhaleAlertRow): string {
  const label  = a.wallet_label || "Tracked Wallet";
  const tok    = a.token_symbol || "Unknown token";
  const side   = a.side ?? "move";
  const amtUsd = (a.amount_usd != null && a.amount_usd > 0) ? `$${a.amount_usd.toFixed(0)}` : "USD unverified";
  const amtTok = a.amount_token != null ? `${a.amount_token} ${tok}`.trim() : null;
  const amtStr = amtTok ? `${amtTok} (${amtUsd})` : amtUsd;
  const sig    = a.signal_score ?? "LOW";
  const extra  = [
    (a.legs ?? 1) > 1    ? `${a.legs} legs`       : null,
    (a.repeats ?? 1) > 1 ? `×${a.repeats} in 5m`  : null,
  ].filter(Boolean).join(" | ");
  const ctx = a.walletContext;
  const ctxStr = ctx
    ? ` | behavior=${ctx.behaviorType} score=${ctx.behaviorScore} conf=${ctx.confidence}${ctx.repeatedTokens.length ? ` repeats=${ctx.repeatedTokens.slice(0, 2).join(',')}` : ''}${(ctx.verifiedUsdFlow7d ?? 0) > 0 ? ` flow7d=$${Math.round(ctx.verifiedUsdFlow7d!)}` : ''}`
    : '';
  return `[${sig}] ${label} ${side} ${amtStr}${extra ? ` | ${extra}` : ""}${ctxStr}`;
}

// Dedicated Anthropic call for whale alert analysis with a whale-specific system prompt.
// Keeps whale analysis separate from token/wallet/contract analysis paths.
async function callAnthropicWhale(prompt: string, whaleContextXml = ""): Promise<string> {
  const apiKey    = requireEnv("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);
  const userContent = whaleContextXml ? `${prompt}\n\n${whaleContextXml}` : prompt;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system:
        "You are Clark, ChainLens AI's whale activity analyst for Base mainnet.\n\n" +
        "DATA FIELDS (from whale_alerts or inline prompt):\n" +
        "- wallet_label: internal ChainLens tracking label — NOT a verified public identity.\n" +
        "- signal_score: HIGH SIGNAL / WATCH / LOW — derived from token amount, legs, and recency.\n" +
        "- amount_usd: null or 'USD unverified' means no reliable price for this token.\n" +
        "- legs: number of token transfers bundled in one on-chain transaction. More legs = more complex.\n" +
        "- repeats: same wallet + token + side seen multiple times within 5 minutes.\n" +
        "- side: buy / sell / transfer.\n" +
        "- tx_hash: on-chain reference. Do not construct Basescan URLs.\n\n" +
        "BEHAVIOR FIELDS (when present in alert rows):\n" +
        "- behavior=: wallet's derived pattern type (repeat_accumulator, active_rotator, fresh_wallet, etc.).\n" +
        "- score=: 0–100 conservative behavior score. Never treat as win rate or PnL.\n" +
        "- conf=: high/medium/low confidence in the pattern.\n" +
        "- repeats=: tokens this wallet has repeatedly touched.\n" +
        "- flow7d=: verified USD flow over 7 days, when available.\n\n" +
        "HARD RULES:\n" +
        "- Use only data present in the prompt or whale_alerts block. Never invent amounts or identities.\n" +
        "- Never claim insider knowledge, profit certainty, or smart-money status.\n" +
        "- Never call a wallet 'smart money' unless a curated label explicitly says so.\n" +
        "- Say 'worth monitoring', never 'copy trade'.\n" +
        "- If amount_usd is null or 'USD unverified', state that clearly.\n" +
        "- If behavior signal is limited, say 'behavior signal is still forming'.\n" +
        "- Wallet identity is an internal ChainLens label, not a public claim.\n" +
        "- Do not expose raw wallet addresses.\n" +
        "- End every response with 'Not financial advice.'\n\n" +
        "SINGLE ALERT FORMAT:\n" +
        "Verdict: HIGH SIGNAL / WATCH / LOW\n" +
        "Read: 1–2 sentences on what the alert shows.\n" +
        "Why it matters: up to 2 bullets — strongest data signals only.\n" +
        "Risk / Unverified: 1 bullet — what is not confirmed.\n" +
        "Next watch: 1 clear sentence.\n\n" +
        "SUMMARY FORMAT (multiple alerts):\n" +
        "Use plain text labels only (no markdown syntax).\n" +
        "Market read:\n" +
        "Top movements: max 4 lines.\n" +
        "Repeating tokens:\n" +
        "Noise / caveats:\n" +
        "Next watch:\n" +
        "No trade call.\n\n" +
        "WORDING RULES:\n" +
        "- Prefer: activity, rotation, repeat movement, value unverified, direction unverified.\n" +
        "- If buy direction is not verified, say: 'Buy-side direction is not fully verified. Here is the strongest tracked activity instead.'\n" +
        "- Replace 'ChainLens pricing rules' with 'current value filters' or 'unverified USD value'.\n" +
        "- Treat wallet labels as internal tracking only (tracked wallet / repeat activity wallet / large wallet).\n\n" +
        "LENGTH: keep concise and mobile-readable (5-6 short sections).",
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Anthropic whale ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const textBlock = (data?.content ?? []).find((b: { type: string }) => b.type === "text");
  return sanitizeFreeform((textBlock?.text ?? "Not enough verified data."), { allowProviderNames: false });
}

async function handleWhaleAlertFeed(prompt: string, body: ClarkRequestBody, origin: string, authHeader?: string | null) {
  const chain = body.chain ?? "base";
  const ROUTING_ONLY_SYMBOLS = new Set(['USDC', 'USDBC', 'EURC', 'DAI', 'USDT', 'WETH', 'ETH', 'CBBTC', 'WSTETH'])

  // Honest response for unsupported time windows.
  const daysMatch = prompt.match(/\b(\d+)\s*days?\b/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    if (days > 7) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        intent: "whale_alert",
        toolsUsed: [],
        analysis: `I can summarize stored Whale Alerts up to 7 days right now, but not ${days} days. Want a 7-day stored summary instead?`,
      };
    }
  }

  // Detect whether the prompt already carries structured alert data from the
  // whale-alerts page (row-level or feed-level "Ask Clark" redirect).
  const hasInlineContext =
    /\bsignal:\s*(high signal|high|watch|low)\b/i.test(prompt) ||
    /\btop alerts:/i.test(prompt) ||
    /\bexplain this whale alert\b/i.test(prompt);

  try {
    if (hasInlineContext) {
      // Prompt already has structured data — analyze directly, no fetch needed.
      const analysis = await callAnthropicWhale(prompt);
      return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_context"], analysis };
    }

    // Organic query (e.g. "what are whales doing right now?") — use stored feed only.
    const isBuyQuery = /\bwhales? buying\b|\bwhale buys?\b|\bwhat are whales buying\b|\bwhat tokens are base whales buying\b|\bsmart wallets? buying\b/i.test(prompt);
    const isSellQuery = /\bwhales?\s+sell(?:ing)?\b|\bwhat are whales?\s+sell(?:ing)\b|\bsell[\s-]?side\s+whale\b/i.test(prompt);
    const isStoredWhaleQuestion = /\bwhat are whales buying on base\b|\bwhat tokens are base whales buying\b|\bwhat are whales doing\b|\bwhale activity\b|\bbase whale alerts\b|\bshow base whales\b|\bbase whales\b|\bshow whales\b|\bwhat whales are rotating into\b|\bwhat are whales rotating into\b|\bwhale rotation\b|\bwhale flows\b|\bbase whale flows\b|\bsmart money on base\b|\bwhat are smart wallets buying\b|\bwhat are smart wallets rotating into\b|\bwhales? buying\b|\bwhale buys?\b|\blast week whale activity\b|\b7d whale flows\b|\bwhat were whales buying last 7 days\b/i.test(prompt.toLowerCase()) && !extractAddress(prompt);
    const is7dQuery = /\b7d\b|\b7 day\b|\b7 days\b|\blast week\b|\bweek whale\b|\blast 7 days\b/i.test(prompt.toLowerCase());
    const isBehaviorQuery = /\bmonitor\s+whale\s+wallets?\b|\bwhich\s+wallets?\s+(should\s+I\s+)?(track|monitor|watch)\b|\bwallet\s+behav(ior|iour)\b|\btrack\s+whale\s+wallets?\b|\bwhale\s+wallet\s+(monitor|track|watch|behavior|pattern|activity)\b|\bwallet\s+patterns?\b/i.test(prompt);
    const window = is7dQuery ? "7d" : "24h";
    let contextXml = "<whale_alerts>Data unavailable right now.</whale_alerts>";
    try {
      const res = await fetch(`${origin}/api/whale-alerts?window=${window}&interesting=true&valueRange=all&limit=75&t=${Date.now()}`, {
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
        headers: authHeader ? { Authorization: authHeader } : {},
      });
      if (res.status === 403) {
        return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"], analysis: "Whale Alerts are included in Pro and Elite." };
      }
      if (res.ok) {
        const json = await res.json();
        const intel = json?.intelligence as WhaleIntelligence | undefined;
        let raw: WhaleAlertRow[] = Array.isArray(json?.alerts) ? json.alerts : [];
        // Interesting mode may filter all base-asset moves. Fallback to all activity if needed.
        if (raw.length === 0) {
          try {
            const res2 = await fetch(`${origin}/api/whale-alerts?window=${window}&interesting=false&valueRange=all&limit=75&t=${Date.now()}`, {
              signal: AbortSignal.timeout(5000),
              cache: "no-store",
              headers: authHeader ? { Authorization: authHeader } : {},
            });
            if (res2.ok) {
              const json2 = await res2.json();
              const all: WhaleAlertRow[] = Array.isArray(json2?.alerts) ? json2.alerts : [];
              if (all.length > 0) raw = all;
            }
          } catch { /* keep raw empty */ }
        }
        const filtered = isBuyQuery
          ? raw.filter(a => (a as Record<string, unknown>).side === "buy" || !(a as Record<string, unknown>).side)
          : isSellQuery
            ? raw.filter(a => (a as Record<string, unknown>).side === "sell")
            : raw;
        if (isSellQuery && filtered.length === 0 && raw.length > 0) {
          const _topBuy = (() => {
            const _cnt = new Map<string, number>();
            for (const r of raw) {
              const s = (((r as Record<string, unknown>).focus_token_symbol as string | undefined) ?? r.token_symbol ?? '').toUpperCase().split(' / ').find(x => x && !ROUTING_ONLY_SYMBOLS.has(x)) ?? null;
              if (s) _cnt.set(s, (_cnt.get(s) ?? 0) + 1);
            }
            return [..._cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
          })();
          return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"], analysis: `No strong sell-side alerts in the current ${window} Interesting feed.${_topBuy ? ` Buying/swap flow is stronger around ${_topBuy}.` : " No dominant sell pressure found."} Worth monitoring if the picture changes.` };
        }
        if (filtered.length > 0) {
          // Behavior monitoring query — format structured WHALE BEHAVIOR READ from intelligence
          if (isBehaviorQuery) {
            const wb = intel?.walletBehavior;
            const wbLeaders = wb?.behaviorLeaders ?? [];
            if (!wb || wbLeaders.length === 0) {
              return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_behavior", toolsUsed: ["whale_feed_stored"],
                analysis: "Behavior signal is still forming — not enough repeated wallet activity in the current window. Try the 7d view for a broader read." };
            }
            const leaders = wbLeaders.slice(0, 4);
            const tokenMap = (wb.repeatedTokenWalletMap ?? []).slice(0, 5);
            const behaviorTypeLabel = (t: string) => normalizeTrustedWalletLabel(t.replace(/_/g, ' '));
            const lines: string[] = [
              "WHALE BEHAVIOR READ",
              "",
              `Main read: ${leaders.length} wallet${leaders.length > 1 ? 's' : ''} showing notable behavior patterns across ${wb.monitoredWallets} tracked in current view.`,
              "",
              "Wallets worth monitoring:",
            ];
            for (const w of leaders) {
              const short = w.shortAddress ?? 'unknown';
              const bType = w.behaviorType ?? 'unverified';
              const monitorReason = w.monitorReason ?? 'behavior signal is still forming';
              const alertCount24h = w.alertCount24h ?? 0;
              const alertCount7d = w.alertCount7d ?? alertCount24h;
              const repeatedTokens = w.repeatedTokens ?? [];
              lines.push(`- ${short} — ${behaviorTypeLabel(bType)}`);
              lines.push(`  Why: ${monitorReason}`);
              const signals = [
                `${alertCount24h} alert${alertCount24h !== 1 ? 's' : ''}/24h`,
                alertCount7d > alertCount24h ? `${alertCount7d} alerts/7d` : null,
                repeatedTokens.length ? `repeats: ${repeatedTokens.slice(0, 2).join(', ')}` : null,
                (w.verifiedUsdFlow24h ?? 0) > 0 ? `~$${Math.round(w.verifiedUsdFlow24h!).toLocaleString()} 24h flow` : null,
                `confidence: ${w.confidence}`,
              ].filter(Boolean).join(' | ');
              lines.push(`  Signals: ${signals}`);
              lines.push(`  Next watch: ${w.nextWatch ?? 'watch for continued activity'}`);
            }
            if (tokenMap.length > 0) {
              lines.push("", "Repeated token flow:");
              for (const t of tokenMap) {
                const walletCount = t.walletCount ?? 0;
                const token = t.token ?? 'unknown';
                const usdPart = t.totalVerifiedUsd ? ` (~$${Math.round(t.totalVerifiedUsd).toLocaleString()} verified)` : '';
                lines.push(`- ${token}: seen across ${walletCount} wallet${walletCount > 1 ? 's' : ''}${usdPart}`);
              }
            }
            lines.push(
              "",
              "Noise / caveats:",
              "- Buy/sell direction may be unverified for some rows if token side was not captured on-chain.",
              "- USD values are verified only for stablecoins, WETH, cbBTC, and GeckoTerminal-priced tokens.",
              "- Patterns are derived from stored alerts only — not a complete on-chain history.",
              "",
              `Next: Monitor whether activity from these wallets continues or shifts tokens. Worth monitoring, not a trade signal.`,
              "",
              "Not financial advice.",
            );
            return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_behavior", toolsUsed: ["whale_feed_stored", "wallet_behavior"], analysis: lines.join("\n") };
          }
          if (isStoredWhaleQuestion) {
            const agg = aggregateWhaleRows(filtered)
            if (!agg.repeatLeaders.length) {
              return {
                feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"],
                analysis: "WHALE FLOW READ\nStored flow is mostly routing/stable activity right now, so there is no clean non-stable token signal yet.",
              }
            }
            const strongest = agg.repeatLeaders[0]
            const highestValue = agg.valueLeaders.find(g => g.totalUsd > 0) ?? null
            const freshestAlt = agg.newestUniqueTokens.find(g => g.key !== strongest.key) ?? null
            const secondary = agg.repeatLeaders.find(g => g.key !== strongest.key) ?? null
            const stale = agg.newestTs === 0 || (Date.now() - agg.newestTs) > (6 * 60 * 60 * 1000)
            const concentrationLine = agg.nonStableCount < 5
              ? "Flow is concentrated — not much variety in the latest stored alerts."
              : (agg.clustered ? "Flow is clustered around a few repeated names." : "Flow is broader across multiple non-stable names.")
            const confidenceLine = agg.usdCoverage < 30 ? "value unverified on many rows." : "verified values are partial."
            const title = pickWhaleTitle(prompt)
            if (title === "TOP WHALE ALERTS TO WATCH") {
              return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"], analysis: [
                "TOP WHALE ALERTS TO WATCH",
                `- strongest repeat: ${strongest.key} (${strongest.count} repeats).`,
                `- highest confidence value: ${highestValue ? `${highestValue.key} (~$${Math.round(highestValue.totalUsd).toLocaleString()} verified)` : "value unverified on most rows."}`,
                `- freshest unique activity: ${freshestAlt ? freshestAlt.key : "no clear secondary token yet."}`,
                `- noisy / ignore: base or stable routing plus tiny one-off moves.`,
                `- next watch: ${stale ? "latest stored flow is stale; run a refresh." : "check if the same repeat token still leads after refresh."}`,
              ].join("\n") }
            }
            if (title === "WHALE SELL-SIDE READ") {
              const sellLeaders = agg.repeatLeaders.filter(g => g.sides.has("sell")).slice(0, 4)
              if (!sellLeaders.length) {
                return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"], analysis: [
                  "WHALE SELL-SIDE READ",
                  "Sell-side read: no strong repeated sell clusters in current stored flow.",
                  `Buy/swap flow is stronger around ${strongest.key}${secondary ? ` and ${secondary.key}` : ""}.`,
                  `Next: ${stale ? "Latest stored flow is stale; run a full refresh for a cleaner read." : "Watch if sell-side clusters appear after next sync."}`,
                ].join("\n") }
              }
              return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"], analysis: [
                "WHALE SELL-SIDE READ",
                "Sell-side read: repeated exits are visible in stored alerts.",
                ...sellLeaders.map((g, i) => `${i + 1}. ${g.key} — ${g.count} repeats${g.totalUsd > 0 ? `, ~$${Math.round(g.totalUsd).toLocaleString()} verified` : ""}.`),
                `Next: ${stale ? "Latest stored flow is stale; run a full refresh for a cleaner read." : "Monitor whether sell clusters expand beyond current leaders."}`,
              ].join("\n") }
            }
            return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed_stored"], analysis: [
              "WHALE ACTIVITY READ",
              `Market read: ${concentrationLine} ${confidenceLine} Direction unverified on some rows.`,
              ...(isBuyQuery ? ["Buy-side direction is not fully verified. Here is the strongest tracked activity instead."] : []),
              "Top movements:",
              ...([strongest, secondary, freshestAlt].filter((g): g is WhaleGroup => Boolean(g)).slice(0, 3).map((g, i) => `${i + 1}. ${g.key} — repeat activity (${g.count}). ${g.totalUsd > 0 ? "partly verified value." : "value unverified."}`)),
              `4. ${agg.repeatLeaders[3]?.key ?? "Secondary names"} — lower-confidence activity.`,
              `Repeating tokens: ${agg.repeatLeaders.slice(0, 6).map(g => g.key).join(', ')}.`,
              "Noise / caveats: stablecoin and routing flow can dominate sections of this feed, so treat this as activity flow, not confirmed buying.",
              `Next watch: ${stale ? "latest stored flow is stale; run a refresh and re-check repeat movement." : "monitor repeat movement and look for fresh token-side flow from the same wallets."}`,
              "No trade call.",
            ].join("\n") }
          }
          const sigOrder: Record<string, number> = { HIGH: 0, WATCH: 1, LOW: 2 };
          filtered.sort((a, b) => {
            const sA = sigOrder[a.signal_score ?? "LOW"] ?? 2;
            const sB = sigOrder[b.signal_score ?? "LOW"] ?? 2;
            if (sA !== sB) return sA - sB;
            const usdDiff = (b.amount_usd ?? -1) - (a.amount_usd ?? -1);
            if (usdDiff !== 0) return usdDiff;
            const repDiff = (b.repeats ?? 1) - (a.repeats ?? 1);
            if (repDiff !== 0) return repDiff;
            return (b.legs ?? 1) - (a.legs ?? 1);
          });
          const lines = filtered.slice(0, 20).map(formatWhaleAlertForClark);
          const intelBlock = intel ? (() => {
            const behaviorLeaders = (intel.walletBehavior?.behaviorLeaders ?? intel.topWallets ?? []).map(w => ({
              shortAddress: w.shortAddress ?? 'unknown',
              behaviorType: 'behaviorType' in w ? (w.behaviorType ?? 'unverified') : 'unverified',
              behaviorScore: 'behaviorScore' in w ? (w.behaviorScore ?? 0) : 0,
              confidence: w.confidence ?? 'low',
              alertCount24h: w.alertCount24h ?? 0,
              alertCount7d: 'alertCount7d' in w ? (w.alertCount7d ?? (w.alertCount24h ?? 0)) : (w.alertCount24h ?? 0),
              verifiedUsdFlow24h: 'verifiedUsdFlow24h' in w ? (w.verifiedUsdFlow24h ?? null) : ('totalVerifiedUsd24h' in w ? (w.totalVerifiedUsd24h ?? null) : null),
              repeatedTokens: w.repeatedTokens ?? [],
              monitorReason: 'monitorReason' in w ? (w.monitorReason ?? 'behavior signal is still forming') : 'behavior signal is still forming',
              nextWatch: 'nextWatch' in w ? (w.nextWatch ?? 'watch for continued activity') : 'watch for continued activity',
            }))
            const repeatedFlow = intel.walletBehavior?.repeatedTokenWalletMap ?? (intel.topRepeatedTokens ?? []).map(t => ({ token: t }))
            const topWalletLines = behaviorLeaders.slice(0, 3).map(w =>
              `  <wallet short="${w.shortAddress}" behavior="${w.behaviorType}" score="${w.behaviorScore}" confidence="${w.confidence}" alerts24h="${w.alertCount24h}" alerts7d="${w.alertCount7d}" flow24h="${(w.verifiedUsdFlow24h ?? 0) > 0 ? `$${Math.round(w.verifiedUsdFlow24h!)}` : 'unverified'}" tokens="${w.repeatedTokens.slice(0, 3).join(',')}" monitor="${w.monitorReason}" next="${w.nextWatch}" />`
            ).join("\n")
            return `<intelligence wallets="${intel.walletCount}" active="${intel.activeWalletCount}" priced="${intel.pricedAlertCount}" unpriced="${intel.unpricedAlertCount}" top_tokens="${repeatedFlow.map(t => t.token ?? '').filter(Boolean).join(',')}">\n${topWalletLines}\n</intelligence>\n`
          })() : ''
          const topBehaviorPatterns = intel?.walletBehavior?.behaviorLeaders ?? [];
          contextXml =
            `<whale_alerts count="${filtered.length}" window="${window}"${isBuyQuery ? ' side="buy"' : isSellQuery ? ' side="sell"' : ""}>\n` +
            intelBlock +
            lines.join("\n") + "\n\n" +
            (isBuyQuery ? "Focus: summarize which tokens whales are buying, using wallet_label where available (not raw addresses). Group by token.\n" : isSellQuery ? "Focus: summarize which tokens whales are selling, using wallet_label where available (not raw addresses). Group by token. Highlight any HIGH SIGNAL sell pressure.\n" : "") +
            "Note: wallet_label is an internal ChainLens label, not a verified public identity.\n" +
            "USD value shown as 'USD unverified' for tokens outside USDC/USDT/WETH/cbBTC.\n" +
            (topBehaviorPatterns.length
              ? `\nTop behavior patterns:\n${topBehaviorPatterns.slice(0, 3).map(w => `- ${w.shortAddress ?? 'unknown'}: ${(w.behaviorType ?? 'unverified').replace(/_/g, ' ')} (score=${w.behaviorScore ?? 0}, conf=${w.confidence ?? 'low'}${(w.repeatedTokens ?? []).length ? `, repeats=${(w.repeatedTokens ?? []).slice(0,2).join(',')}` : ''})`).join('\n')}\n`
              : '') +
            "</whale_alerts>";
        } else {
          if (isStoredWhaleQuestion) {
            return {
              feature: "clark-ai",
              chain,
              mode: "analysis",
              intent: "whale_alert",
              toolsUsed: ["whale_feed_stored"],
              analysis: `No fresh whale ${isBuyQuery ? "buy " : ""}alerts match the current ${window} Interesting feed. Try All activity or run a full refresh from the Whale Alerts page.`,
            }
          }
          contextXml = `<whale_alerts count="0" window="${window}">No whale ${isBuyQuery ? "buy " : ""}alerts in the past ${window}.</whale_alerts>`;
        }
      }
    } catch { /* fall through with unavailable message */ }

    const analysis = await callAnthropicWhale(prompt, contextXml);
    return { feature: "clark-ai", chain, mode: "analysis", intent: "whale_alert", toolsUsed: ["whale_feed"], analysis };
  } catch {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      intent: "whale_alert",
      toolsUsed: ["whale_feed"],
      analysis: "I couldn't analyze the whale context right now. Try again or paste the alert details directly.",
    };
  }
}

async function handleClarkAI(body: ClarkRequestBody, origin: string, authHeader?: string | null, verifiedPlan?: 'free' | 'pro' | 'elite', sessionMem?: ClarkSessionMemory) {
  // Ensure we always have a session memory object even for recursive calls
  if (!sessionMem) sessionMem = { lastToken: null, lastWallet: null, lastMomentumList: [], lastMomentumTs: 0, lastIntent: null, lastIntentTs: 0, lastActionableIntent: null, lastActionableIntentTs: 0, allowedRankScanUntil: 0, allowedRankScanUsed: false, lastMomentumShownCount: 0 };
  const chain = body.chain ?? "base";
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";
  if (/what can you do|what can u do|help|yo clark what can u do/i.test(prompt.toLowerCase())) {
    return { feature: "clark-ai", chain, mode: "casual_help", intent: "help", toolsUsed: [], analysis: "I can scan tokens and wallets, read Whale Flows, Pump Alerts, and Base Radar, check liquidity/security/holders where data exists, run dev-wallet checks, and explain risk signals." };
  }
  // Wallet Scanner sends pre-loaded context — build verdict directly without a second /api/wallet call
  if (
    String(body.mode ?? "").toLowerCase() === "wallet-analysis" &&
    body.walletAddress &&
    body.context &&
    typeof body.context === "object"
  ) {
    const ctx = body.context as Record<string, unknown>;
    const walletAddr = String(body.walletAddress);
    const topRaw = Array.isArray(ctx.topHoldings) ? (ctx.topHoldings as Array<Record<string, unknown>>) : [];
    const holdingsTop10 = topRaw
      .map((h) => ({
        symbol: String(h.symbol ?? "?"),
        value: typeof h.valueUsd === "number" ? h.valueUsd : typeof h.value === "number" ? h.value : 0,
        balance: typeof h.balance === "number" ? h.balance : 0,
      }))
      .filter((h) => h.value > 0.01)
      .slice(0, 8);
    const totalValue = typeof ctx.portfolioValueUsd === "number" ? ctx.portfolioValueUsd : holdingsTop10.reduce((s, h) => s + h.value, 0);
    const stablecoinExposureUsd = typeof ctx.stablecoinExposureUsd === "number" ? ctx.stablecoinExposureUsd : 0;
    const tokenCount = typeof ctx.tokenCount === "number" ? ctx.tokenCount : holdingsTop10.length;
    const txCount = typeof ctx.transactionCount === "number" ? ctx.transactionCount : null;
    const rawDq = typeof ctx.dataQuality === "string" ? ctx.dataQuality : "Partial";
    const dataQuality: "Complete" | "Partial" | "Limited" = rawDq === "Complete" ? "Complete" : rawDq === "Limited" ? "Limited" : "Partial";

    if (holdingsTop10.length === 0 && totalValue <= 0) {
      return {
        feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: [],
        analysis: [
          "Verdict: SCAN DEEPER",
          "Confidence: Low",
          "",
          "Read:",
          "No priced holdings found in this scan. The wallet may be empty, unsupported chains only, or the data provider returned nothing.",
          "",
          "Key signals:",
          "- No priced token balances retrieved",
          "- Portfolio value is zero or unavailable",
          "- Data quality is limited",
          "",
          "Risks:",
          "- Cannot evaluate wallet behavior without balance data",
          "- May be a new wallet or one on unsupported chains",
          "- Retry after syncing or try a different address",
          "",
          "Next action:",
          "Retry the scan or paste the wallet in Clark AI for a fresh pull.",
        ].join("\n"),
      };
    }

    const snapshot: NonNullable<ClarkToolEvidence["walletSnapshot"]> = {
      ok: true,
      address: walletAddr,
      totalValue,
      holdingsTop10,
      hiddenHoldingsCount: Math.max(tokenCount - holdingsTop10.length, 0),
      dustOrUnpricedHidden: tokenCount > holdingsTop10.length,
      stablecoinExposureUsd,
      tokenCount,
      txCount,
      walletAgeDays: null,
      dataQuality,
    };
    const rawBehavior = ctx.walletBehavior;
    const behavior: WalletBehaviorCtx | null = rawBehavior && typeof rawBehavior === "object"
      ? rawBehavior as WalletBehaviorCtx : null;
    const analysis = buildWalletQualityVerdict(snapshot, walletAddr, prompt, behavior);
    return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: [], analysis };
  }

  if (isWhaleFlowPrompt(prompt, body.history)) {
    return await handleStoredWhaleFlow(prompt, body, origin, authHeader);
  }
  if (isBaseMomentumPrompt(prompt)) {
    if (process.env.NODE_ENV === "development") console.log("[clark-render]", { matchedIntent: "base_pump_map", rendererUsed: "base_pump_map", featureFromClient: body.feature, normalizedPrompt: normalizePromptForIntent(prompt) });
    const pumpResult = await handleBasePumpMap(prompt, origin);
    if (pumpResult.items.length > 0) {
      updateMemMomentum(sessionMem, pumpResult.items);
      updateMemIntent(sessionMem, "market");
    }
    return {
      feature: "clark-ai", chain, mode: "analysis", intent: "market",
      toolsUsed: ["base_market_feed", "pump_alerts_feed"],
      analysis: pumpResult.analysis,
      marketContext: { items: pumpResult.items },
    };
  }
  if (isPumpFeedPrompt(prompt)) {
    if (process.env.NODE_ENV === "development") console.log("[clark-render]", { matchedIntent: "pump_alerts", rendererUsed: "pump_alerts", featureFromClient: body.feature, normalizedPrompt: normalizePromptForIntent(prompt) });
    const analysis = await handlePumpFeedSnapshot(origin);
    return { feature: "clark-ai", chain, mode: "analysis", intent: "market", toolsUsed: ["pump_alerts_feed"], analysis };
  }
  if (isPumpSourceFollowupPrompt(prompt)) {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      intent: "market",
      toolsUsed: ["pump_alerts_feed"],
      analysis: "Pump Alerts uses the existing ChainLens Pump Alerts/Base market feed. Market fields are passed through from the configured provider where available (currently CoinGecko/GeckoTerminal-style Base pool data when wired). If price/liquidity/volume fields are missing in the source payload, I mark them as unverified instead of inventing values.",
    };
  }
  if (isBaseRadarPrompt(prompt)) {
    if (process.env.NODE_ENV === "development") console.log("[clark-render]", { matchedIntent: "base_market", rendererUsed: pickBaseRadarTitle(prompt).toLowerCase().replace(/\s+/g, "_"), featureFromClient: body.feature, normalizedPrompt: normalizePromptForIntent(prompt) });
    const radarResult = await handleBaseRadarSnapshot(origin, prompt);
    if (radarResult.items.length > 0) {
      updateMemMomentum(sessionMem, radarResult.items);
      updateMemIntent(sessionMem, "market");
    }
    return {
      feature: "clark-ai", chain, mode: "analysis", intent: "market",
      toolsUsed: ["base_radar_feed"],
      analysis: radarResult.analysis,
      marketContext: { items: radarResult.items },
    };
  }

  // "should I copy this wallet" — always redirect, never give copy-trade advice
  if (/\bshould\s+i\s+copy[\s-]?(?:this\s+)?(?:trade\s+it|wallet|trade\b|it)\b/i.test(prompt)) {
    return {
      feature: "clark-ai", chain, mode: "casual_help", intent: "casual", toolsUsed: [],
      analysis: "I can't tell you to copy-trade it. I can tell you whether it is worth monitoring.\n\nSend the wallet address and I'll run a WALLET READ — holdings, activity, concentration, and what's missing. No copy-trade call.",
    };
  }

  // "more" / "continue" / "give me more" — use session memory momentum list
  if (MORE_CONTEXT_RE.test(prompt.trim())) {
    const memList = sessionMem.lastMomentumList;
    if (memList.length > 0) {
      const shownCount = Math.max(0, Math.min(sessionMem.lastMomentumShownCount || 0, memList.length));
      const nextTokens = memList.slice(shownCount, shownCount + 8);

      if (nextTokens.length > 0) {
        sessionMem.lastMomentumShownCount = shownCount + nextTokens.length;
        const rows = nextTokens.map(m => {
          const vol = m.volume24h != null ? formatUsdShort(m.volume24h) : "n/a";
          const liq = m.liquidity != null ? formatUsdShort(m.liquidity) : "n/a";
          const change = m.change24h != null ? `${m.change24h >= 0 ? "+" : ""}${m.change24h.toFixed(1)}%` : "n/a";
          const tag = m.tag ?? "watch";
          return `${m.rank}. ${m.symbol ?? "?"} — ${change} | Vol ${vol} | Liq ${liq} | ${tag}`;
        });
        return {
          feature: "clark-ai", chain, mode: "analysis", intent: "market", toolsUsed: [],
          analysis: [
            "MORE BASE MOVERS",
            "",
            "Additional candidates from the latest CORTEX pool read:",
            "",
            ...rows,
            "",
            "Quality note:",
            "These are discovery candidates. Verify liquidity, holders, and dev wallet before conviction.",
            "",
            "Next:",
            `Say "scan ${nextTokens[0]?.rank ?? "1"}" or paste a symbol/contract.`,
          ].join("\n"),
        };
      }
      // No more tokens beyond what's shown
      const firstRank = memList[0]?.rank ?? 1;
      return {
        feature: "clark-ai", chain, mode: "analysis", intent: "market", toolsUsed: [],
        analysis: [
          "MORE CONTEXT",
          "",
          `The latest CORTEX pool read only returned ${memList.length} usable momentum candidates after filtering.`,
          "",
          "What matters now:",
          "1. Pick a rank and scan it.",
          "2. Check liquidity and LP control.",
          "3. Check holder concentration.",
          "4. Check dev and origin wallet.",
          "",
          "Next:",
          `Say "scan ${firstRank}" to start with the strongest mover.`,
        ].join("\n"),
      };
    }
    if (sessionMem.lastToken) {
      const t = sessionMem.lastToken;
      return {
        feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: [],
        analysis: [
          `MORE CONTEXT — ${t.symbol ?? "Last token"}`,
          "",
          "To go deeper on this token, try:",
          `- "liquidity check ${t.symbol ?? "this"}" — LP depth and control`,
          `- "who deployed ${t.symbol ?? "this"}" — deployer and origin wallet`,
          `- "should I watch it?" — watch verdict from current context`,
          "- Holder concentration is the next key check.",
        ].join("\n"),
      };
    }
    return {
      feature: "clark-ai", chain, mode: "casual_help", intent: "casual", toolsUsed: [],
      analysis: "I can help with a token, wallet, liquidity, dev wallet, whale flow, pump alerts, or Base movers. Try 'scan BRETT' or 'what\\'s pumping on Base?'.",
    };
  }

  if (THIS_DEV_RE.test(prompt) && !extractAddress(prompt)) {
    const target = sessionMem.lastToken?.address ?? body.clientContext?.lastToken?.address ?? null;
    if (!target) return { feature: "clark-ai", chain, mode: "analysis", intent: "dev_wallet", toolsUsed: [], analysis: "CORTEX could not verify the origin wallet from live data. Token context is still saved." };
    const devRes = await callInternalApi(origin, "/api/dev-wallet", { contractAddress: target }, authHeader ?? undefined);
    if (!devRes.ok || !devRes.json) {
      return { feature: "clark-ai", chain, mode: "analysis", intent: "dev_wallet", toolsUsed: ["dev_wallet_analyze"], analysis: "CORTEX could not verify the origin wallet from live data. Token context is still saved." };
    }
    const token = sessionMem.lastToken ?? body.clientContext?.lastToken ?? null;
    return {
      feature: "clark-ai", chain, mode: "analysis", intent: "dev_wallet", toolsUsed: ["dev_wallet_analyze"],
      analysis: [
        "DEV WALLET READ", "",
        `Token: ${token?.symbol ?? "Unknown"}`,
        `Contract: ${target}`, "",
        "Origin read:",
        "- Likely deployer/origin was queried from live Base data.",
        "",
        "Linked wallet signals:",
        "- See linked wallet flags in this read where available.",
        "",
        "Prior activity:",
        "- Prior origin-wallet history is partial unless explicitly returned.",
        "",
        "Risk flags:",
        "- Treat unverified origin links as unresolved risk.",
        "",
        "Missing checks:",
        "- Full origin wallet history may be incomplete in this pass.",
        "",
        "Next action:",
        "Compare origin wallet activity with holder concentration and liquidity control. No trade call.",
      ].join("\n"),
    };
  }

  if (THIS_LIQ_RE.test(prompt) && !extractAddress(prompt)) {
    const target = sessionMem.lastToken?.address ?? body.clientContext?.lastToken?.address ?? null;
    if (!target) return { feature: "clark-ai", chain, mode: "analysis", intent: "liquidity_safety", toolsUsed: [], analysis: missingAddressReply("liquidity_safety") };
    const liqRes = await callInternalApi(origin, "/api/liquidity-safety", { tokenAddress: target }, authHeader ?? undefined);
    if (liqRes.ok && liqRes.json) {
      const raw = liqRes.json as Record<string, unknown>;
      const liq = {
        ok: true,
        token: { name: sessionMem.lastToken?.name ?? "Token", symbol: sessionMem.lastToken?.symbol ?? "?", address: target },
        riskTier: typeof raw.riskTier === "string" ? raw.riskTier : "high",
        stabilityScore: typeof raw.stabilityScore === "number" ? raw.stabilityScore : null,
        primaryPool: typeof raw.primaryPool === "string" ? raw.primaryPool : null,
        liquidityUsd: typeof raw.liquidityUsd === "number" ? raw.liquidityUsd : null,
        volume24h: typeof raw.volume24hUsd === "number" ? raw.volume24hUsd : (typeof raw.volume24h === "number" ? raw.volume24h : null),
        warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((x): x is string => typeof x === "string") : [],
      };
      return { feature: "clark-ai", chain, mode: "analysis", intent: "liquidity_safety", toolsUsed: ["liquidity_analyze"], analysis: renderLiquidityFocusedRead(sessionMem.lastToken?.name ?? "Token", sessionMem.lastToken?.symbol ?? "?", target, liq) };
    }
    const summary = sessionMem.lastToken?.scanSummary ?? body.clientContext?.lastToken?.scanSummary ?? "";
    const liqRaw = summary.match(/Liquidity:\s*([^\n]+)/i)?.[1] ?? null;
    const volRaw = summary.match(/Volume:\s*([^\n]+)/i)?.[1] ?? null;
    const liqNum = parseAbbrevUsdToNumber(liqRaw);
    const volNum = parseAbbrevUsdToNumber(volRaw);
    return { feature: "clark-ai", chain, mode: "analysis", intent: "liquidity_safety", toolsUsed: [], analysis: renderLiquidityFocusedRead(sessionMem.lastToken?.name ?? "Token", sessionMem.lastToken?.symbol ?? "?", target, { ok: false, token: { name: sessionMem.lastToken?.name ?? "Token", symbol: sessionMem.lastToken?.symbol ?? "?", address: target }, riskTier: "high", stabilityScore: null, primaryPool: null, liquidityUsd: liqNum, volume24h: volNum, warnings: ["LP lock/control unverified."], errorSafeMessage: "Pool-age history unavailable in this pass." }) };
  }

  // "this" contextual resolution — liquidity check this / dev wallet this / scan this / who deployed this
  const THIS_RE = /\b(liquidity\s+check\s+this|check\s+liquidity\s+(?:for\s+)?this|lp\s+(?:check\s+)?this|who\s+deployed\s+this|dev\s+wallet\s+(?:for\s+)?this|check\s+(?:dev\s+wallet|deployer)\s+(?:for\s+)?this|scan\s+this|check\s+this)\b/i;
  if (THIS_RE.test(prompt) && !extractAddress(prompt)) {
    const histLinesForThis = getHistoryMessages(body.history);
    const lastTokenCtx = extractLastTokenContext(histLinesForThis);
    const lastScanCtx = extractLastTokenScanFromHistory(body.history);
    const memToken = sessionMem.lastToken;
    const thisAddress = (memToken && (Date.now() - memToken.ts) < SESSION_MEMORY_TTL_MS ? memToken.address : null) ?? lastTokenCtx.address ?? lastScanCtx?.contractAddress ?? null;
    const thisSymbol = (memToken && (Date.now() - memToken.ts) < SESSION_MEMORY_TTL_MS ? memToken.symbol : null) ?? lastTokenCtx.symbol ?? null;
    if (!thisAddress && !thisSymbol) {
      return { feature: "clark-ai", chain, mode: "analysis", intent: "unknown", toolsUsed: [], analysis: "Which token should I check? Send a symbol or contract." };
    }
    const thisTarget = thisAddress ?? thisSymbol ?? "";
    const isLiqThis = /liquidity|lp/i.test(prompt);
    const isDevThis = /dev\s+wallet|deployer|who\s+deployed/i.test(prompt);
    // Reroute by injecting the resolved address/symbol into the prompt
    const rerouted = isLiqThis
      ? `liquidity check ${thisTarget}`
      : isDevThis
        ? `who deployed ${thisTarget}`
        : `scan ${thisTarget}`;
    // Mutate prompt for plan execution below
    return await handleClarkAI({ ...body, prompt: rerouted }, origin, authHeader, verifiedPlan, sessionMem);
  }

  if (isFeedSafestFollowup(prompt)) {
    if (wasLastFeedEmpty(body.history)) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        intent: "market",
        toolsUsed: ["market_context"],
        analysis: "No clean candidates from the last feed yet. Open the matching scanner/refresh the feed, then ask again.",
      };
    }
    const marketItems = extractStructuredMarketItems(body);
    if (marketItems.length) {
      const ranked = [...marketItems].sort((a, b) => a.rank - b.rank);
      const pick = ranked[0];
      const second = ranked[1];
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        intent: "market",
        toolsUsed: ["market_context"],
        analysis: `Cleanest watch candidate: ${pick?.symbol ?? "No clear candidate"}.\nWhy: strongest available liquidity/volume profile in the current list.\nLimit: this is not a safety guarantee.\nIf you want higher confidence, run Token Scanner on ${pick?.symbol ?? "top candidate"}${second?.symbol ? ` and ${second.symbol}` : ""}.`,
      };
    }
  }
  const liveIntent = detectLiveIntent(prompt);
  const directIntent = detectIntent(prompt);
  const historyContext = buildHistoryContextText(body.history);

  if (directIntent.intent === "trading_boundary") {
    return { feature: "clark-ai", chain, mode: "casual_help", intent: "casual", toolsUsed: [], analysis: buildTradingBoundaryReply() };
  }
  if (directIntent.intent === "financial_advice") {
    return { feature: "clark-ai", chain, mode: "casual_help", intent: "strategy", toolsUsed: [], analysis: buildFinancialAdviceReply(prompt) };
  }
  if (directIntent.intent === "wallet_analysis" && !directIntent.address) {
    const ensName = extractEnsName(prompt)
    if (ensName) {
      const resolved = await resolveEnsOrBasename(ensName)
      if (resolved) {
        const walletRes = await callInternalApi(origin, "/api/wallet", { address: resolved }, authHeader ?? undefined)
        const w = (walletRes.json ?? {}) as Record<string, unknown>
        const resolvedNote = `Resolved wallet: ${ensName} → \`${resolved}\`\n\n`
        if (walletRes.ok && Object.keys(w).length > 0) {
          const snapshot = normalizeWalletSnapshotEvidence(w, resolved)
          return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis: resolvedNote + formatWalletBalanceSummary(snapshot) }
        }
        return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis: resolvedNote + "I couldn't pull wallet data for that address right now. Try pasting the 0x address directly or use Wallet Scanner." }
      }
      return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: [], analysis: `I couldn't resolve ${ensName} to a wallet address. Try pasting the 0x address directly, or check the name spelling.` }
    }
    // Try session memory last wallet before asking for an address
    if (sessionMem.lastWallet && (Date.now() - sessionMem.lastWallet.ts) < SESSION_MEMORY_TTL_MS) {
      const isMonitorQ = /\b(is\s+it\s+worth|worth\s+monitoring|is\s+this\s+wallet|should\s+i\s+watch|should\s+i\s+copy|what\s+are\s+its|any\s+risk|main\s+holdings?|scan\s+its|top\s+holding)\b/i.test(prompt);
      if (isMonitorQ) {
        if (/\bshould\s+i\s+copy\b/i.test(prompt)) {
          return { feature: "clark-ai", chain, mode: "casual_help", intent: "casual", toolsUsed: [], analysis: "I can't tell you to copy-trade it. I can tell you whether it is worth monitoring.\n\nSend the wallet address and I'll run a WALLET READ — holdings, activity, concentration, and what's missing. No copy-trade call." };
        }
        const walletRes = await callInternalApi(origin, "/api/wallet", { address: sessionMem.lastWallet.address }, authHeader ?? undefined);
        const w = (walletRes.json ?? {}) as Record<string, unknown>;
        if (walletRes.ok && Object.keys(w).length > 0) {
          const snapshot = normalizeWalletSnapshotEvidence(w, sessionMem.lastWallet.address);
          const analysis = buildWalletQualityVerdict(snapshot, sessionMem.lastWallet.address, prompt);
          updateMemWallet(sessionMem, sessionMem.lastWallet.address, sessionMem.lastWallet.ensName, analysis);
          updateMemIntent(sessionMem, "wallet_analysis");
          return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis };
        }
      }
    }
    return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: [], analysis: "I can run that, but I need a wallet address first. Paste a full 0x wallet (or a .base.eth / .eth name) and I'll analyze the available data." };
  }
  // Wallet analysis with address — route to wallet before plan execution
  if (directIntent.intent === "wallet_analysis" && directIntent.address) {
    const walletRes = await callInternalApi(origin, "/api/wallet", { address: directIntent.address }, authHeader ?? undefined);
    const w = (walletRes.json ?? {}) as Record<string, unknown>;
    if (walletRes.ok && Object.keys(w).length > 0) {
      const snapshot = normalizeWalletSnapshotEvidence(w, directIntent.address);
      const isBalanceQ = /\b(balance|balances|holdings?|portfolio|what(?:'s| is) in|how much|show me)\b/i.test(prompt);
      const analysis = isBalanceQ ? formatWalletBalanceSummary(snapshot) : buildWalletQualityVerdict(snapshot, directIntent.address, prompt);
      updateMemWallet(sessionMem, directIntent.address, null, analysis);
      updateMemIntent(sessionMem, "wallet_analysis");
      return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis };
    }
    return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis: "I couldn't pull wallet data for that address right now. Try pasting again or use Wallet Scanner directly." };
  }
  if (directIntent.intent === "whale_alert" && !directIntent.address) {
    return await handleWhaleAlertFeed(prompt, body, origin, authHeader);
  }

  if (isWhaleFlowPrompt(prompt)) {
    return await handleWhaleAlertFeed(prompt, body, origin, authHeader);
  }

  // Hard guard: hide/private transaction requests — specific public-ledger explanation
  if (/\bhide\b[\s\w]*transactions?|\bhide\b[\s\w]*\btx\b|private\s+transaction\s+hid|make[\s\w]*transactions?\s+private/i.test(prompt)) {
    console.log("[clark-intent] detected=unsupported_capability");
    return {
      feature: "clark-ai", chain, mode: "casual_help", intent: "casual", toolsUsed: [],
      analysis: "I can't hide on-chain transactions. Base transactions are public. I can help with private simulations/watchlists, token scans, wallet reads, Whale Alerts, Pump Alerts, Base Radar, liquidity and risk checks.",
    };
  }

  // Hard guard: bare 0x address after recent wallet-context turn → wallet analysis
  if (directIntent.address && isBareAddressPrompt(prompt) && hasRecentWalletContext(body.history)) {
    console.log("[clark-intent] detected=wallet_analysis reason=history_wallet_context");
    const walletRes = await callInternalApi(origin, "/api/wallet", { address: directIntent.address }, authHeader ?? undefined);
    const w = (walletRes.json ?? {}) as Record<string, unknown>;
    if (walletRes.ok && Object.keys(w).length > 0) {
      const snapshot = normalizeWalletSnapshotEvidence(w, directIntent.address);
      return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis: formatWalletBalanceSummary(snapshot) };
    }
    return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: ["wallet_get_snapshot"], analysis: "I couldn't pull wallet data for that address right now. Try pasting again or use Wallet Scanner directly." };
  }

  // Follow-up action — intercept before plan execution to avoid re-running the full scan
  const tokenFollowup = detectTokenFollowup(prompt, body.history);
  if (tokenFollowup) {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      intent: "token_analysis",
      toolsUsed: [],
      analysis: buildTokenFollowupReply(tokenFollowup.type, tokenFollowup.contractAddress, tokenFollowup.scanText),
    };
  }
  // Watch verdict follow-up — after a token scan, user asks whether to watch
  const WATCH_VERDICT_RE = /\b(should\s+i\s+watch\s+(?:it|this|the\s+token|that\s+token)?|is\s+it\s+worth\s+watching|worth\s+watching|final\s+verdict|what'?s\s+the\s+play|should\s+i\s+monitor\s+(?:it|this)|watch\s+verdict)\b/i;
  if (WATCH_VERDICT_RE.test(prompt) && !extractAddress(prompt) && !extractTokenLookupQuery(prompt)) {
    const lastScan = extractLastTokenScanFromHistory(body.history);
    const memTokenVerdict = sessionMem.lastToken;
    if (lastScan) {
      updateMemIntent(sessionMem, "token_analysis");
      return {
        feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: [],
        analysis: buildWatchVerdictFromScan(lastScan.scanText, lastScan.contractAddress),
      };
    }
    if (memTokenVerdict?.scanSummary && (Date.now() - memTokenVerdict.ts) < SESSION_MEMORY_TTL_MS) {
      updateMemIntent(sessionMem, "token_analysis");
      return {
        feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: [],
        analysis: buildWatchVerdictFromScan(memTokenVerdict.scanSummary, memTokenVerdict.address),
      };
    }
    return {
      feature: "clark-ai", chain, mode: "analysis", intent: "casual", toolsUsed: [],
      analysis: "I need a token first. Send a symbol/contract or say 'scan BRETT'.",
    };
  }

  if (isHolderQuestion(prompt) && !extractTokenLookupQuery(prompt) && !extractAddress(prompt)) {
    const lastScan = extractLastTokenScanFromHistory(body.history);
    if (!lastScan) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        intent: "token_analysis",
        toolsUsed: [],
        analysis: "I can check holder distribution, but I need a token symbol or contract first.",
      };
    }
  }

  // Casual chat — short-circuit before plan execution
  const CASUAL_CHAT_RE = /^(yo|hey|bro|man|dude)\b|^what do you think(\s+about this)?$|^is that bad\??$|^risky\??$|^why$|^explain this$|^can you help\??$/i;
  if (CASUAL_CHAT_RE.test(prompt.trim()) && !extractAddress(prompt)) {
    const lastScan = extractLastTokenScanFromHistory(body.history);
    return {
      feature: "clark-ai",
      chain,
      mode: "casual_help",
      intent: "casual",
      toolsUsed: [],
      analysis: buildCasualContextualReply(prompt, lastScan?.scanText ?? null, historyContext),
    };
  }

  if (liveIntent === "MARKET_OVERVIEW") {
    try {
      const data = await fetchCoinGeckoMajors();
      const eth = data.ethereum ?? {};
      const btc = data.bitcoin ?? {};
      return {
        feature: "clark-ai",
        chain,
        mode: "general_market",
        intent: "market",
        toolsUsed: ["coingecko_simple_price"],
        analysis: [
          `Ethereum is trading at ${fmtPrice(eth.usd)} (${pct(eth.usd_24h_change)} 24h).`,
          `Bitcoin is at ${fmtPrice(btc.usd)} (${pct(btc.usd_24h_change)} 24h).`,
          `Market sentiment: ${(eth.usd_24h_change ?? 0) + (btc.usd_24h_change ?? 0) >= 0 ? "mildly bullish" : "cautious"} based on 24h momentum.`,
        ].join("\n"),
      };
    } catch {
      return { feature: "clark-ai", chain, mode: "general_market", intent: "market", toolsUsed: ["coingecko_simple_price"], analysis: "No fresh signal in the checked window. Try another token or check again shortly." };
    }
  }

  if (liveIntent === "TOKEN_QUERY") {
    const query = extractTokenLookupQuery(prompt) ?? prompt.trim();
    try {
      const tokenData = await callScanToken(query, "query", origin);
      if (!tokenData) {
        return { feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: ["token_scan"], analysis: "I could not confirm a Base match from current checks. Paste the contract address for a deeper scan." };
      }
      const rec = tokenData as Record<string, unknown>;
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        intent: "token_analysis",
        toolsUsed: ["token_scan"],
        analysis: [
          `${String(rec.symbol ?? "?")} (${String(rec.name ?? "Unknown")}):`,
          `Price: ${fmtPrice(typeof rec.price === "number" ? rec.price : undefined)}`,
          `24h: ${pct(typeof rec.priceChange24h === "number" ? rec.priceChange24h : undefined)}`,
          `Liquidity: ${formatUsdShort(typeof rec.liquidity === "number" ? rec.liquidity : null)}`,
          `Volume: ${formatUsdShort(typeof rec.volume24h === "number" ? rec.volume24h : null)}`,
          `Momentum: ${typeof rec.priceChange24h === "number" && rec.priceChange24h > 0 ? "strong short-term uptrend" : "mixed / cooling"}.`,
        ].join("\n"),
      };
    } catch {
      return { feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: ["token_scan"], analysis: "No fresh signal in the checked window. Try another token or check again shortly." };
    }
  }

  if (liveIntent === "BASE_MARKET") {
    try {
      const universe = await getBaseMarketUniverse({ origin, mode: "pumping", requestedCount: 10, followup: false, excludeAddresses: [], includePoolVariants: false });
      const top = universe.candidates.slice(0, 10);
      if (!top.length) return { feature: "clark-ai", chain, mode: "general_market", intent: "market", toolsUsed: ["market_get_base_movers"], analysis: "No fresh signal in the checked window. Try another token or check again shortly." };
      updateMemMomentum(sessionMem, top.map((c, i) => ({
        rank: i + 1,
        symbol: c.symbol ?? "?",
        name: c.name ?? null,
        address: c.tokenAddress ?? c.poolAddress ?? null,
        liquidity: c.liquidityUsd ?? null,
        volume24h: c.volume24h ?? null,
        change24h: c.change24h ?? null,
        tag: c.reasonTags?.[0] ?? null,
      })));
      sessionMem.allowedRankScanUntil = Date.now() + 60_000;
      sessionMem.allowedRankScanUsed = false;
      updateMemIntent(sessionMem, "market");
      return {
        feature: "clark-ai",
        chain,
        mode: "general_market",
        intent: "market",
        toolsUsed: ["market_get_base_movers"],
        analysis: formatBaseMarketReply(top, universe.candidates.length, 0, universe.cappedMessage ?? null),
        marketContext: {
          items: top.map((c, i) => ({
            rank: i + 1,
            symbol: c.symbol ?? "?",
            name: c.name ?? null,
            tokenAddress: c.tokenAddress ?? null,
            poolAddress: c.poolAddress ?? null,
            reasonTag: c.reasonTags[0] ?? null,
            price: c.priceUsd ?? null,
            liquidity: c.liquidityUsd ?? null,
            volume24h: c.volume24h ?? null,
            change24h: c.change24h ?? null,
          })),
        },
      };
    } catch {
      return { feature: "clark-ai", chain, mode: "general_market", intent: "market", toolsUsed: ["market_get_base_movers"], analysis: "No fresh signal in the checked window. Try another token or check again shortly." };
    }
  }

  if (liveIntent === "WHALE_FEED") {
    return await handleWhaleAlertFeed(prompt, body, origin, authHeader);
  }

  const replyMode = detectReplyMode(body);
  const structuredMarketList = extractStructuredMarketItems(body);
  if (process.env.NODE_ENV === "development") {
    const followupDev = resolveMarketTokenFromFollowup(prompt.trim().toLowerCase(), structuredMarketList, body.clarkContext?.lastSelectedRank);
    console.log("[clark] movers followup", {
      incomingMessage: prompt,
      normalizedMoversCount: structuredMarketList.length,
      resolvedRank: followupDev.item?.rank ?? null,
      resolvedSymbol: followupDev.item?.symbol ?? null,
    });
  }
  const marketFollowupResolution = resolveMarketTokenFromFollowup(prompt.trim().toLowerCase(), structuredMarketList, body.clarkContext?.lastSelectedRank);
  if (marketFollowupResolution.ambiguous.length > 1) {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      intent: "token_analysis",
      toolsUsed: [],
      analysis: [
        "I found multiple matches in the recent Base movers list.",
        "Reply with a number or exact symbol:",
        ...marketFollowupResolution.ambiguous.map((m) => `- #${m.rank} ${m.symbol}${m.name ? ` (${m.name})` : ""}`),
      ].join("\n"),
    };
  }
  // Rank follow-up reads lastMomentumList directly so education/fallback turns do not break numeric scans.
  const askedRank = parseRankFollowup(prompt);
  if (askedRank && sessionMem.lastMomentumList.length === 0) {
    return { feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: [], analysis: "Ask 'what's pumping on Base?' first, or send a token symbol/contract." };
  }

  // Rank follow-up: "scan 1", "2", "full report on 3" → resolve from session memory momentum list
  // Only trigger when prompt is primarily a rank reference and the client has no structured list to use
  if (sessionMem.lastMomentumList.length > 0 && !marketFollowupResolution.item && !marketFollowupResolution.ambiguous.length) {
    const _memRank = askedRank;
    if (_memRank) {
      const memItem = sessionMem.lastMomentumList.find(m => m.rank === _memRank);
      if (memItem) {
        if (!memItem.address) {
          // Symbol known but no address — re-route as symbol scan
          return await handleClarkAI({ ...body, prompt: `scan ${memItem.symbol}` }, origin, authHeader, verifiedPlan, sessionMem);
        }
        // Has address — run token scan directly
        updateMemIntent(sessionMem, "token_analysis");
        const tokenRes = await callInternalApi(origin, "/api/token", { contract: memItem.address }, authHeader ?? undefined);
        const tokenData = tokenRes.ok ? tokenRes.json : null;
        const securitySim = await fetchHoneypotSecurity(memItem.address, "base");
        if (tokenData) {
          const td = tokenData as Record<string, unknown>;
          const reportEvidence: ClarkToolEvidence = {
            tokenScan: {
              ok: true,
              token: { name: String(td.name ?? memItem.name ?? "Token"), symbol: String(td.symbol ?? memItem.symbol ?? "?"), address: String(td.contract ?? memItem.address) },
              market: {
                price: typeof td.price === "number" ? td.price : null,
                change24h: typeof td.priceChange24h === "number" ? td.priceChange24h : null,
                volume24h: typeof td.volume24h === "number" ? td.volume24h : null,
                liquidity: typeof td.liquidity === "number" ? td.liquidity : null,
                marketCap: typeof td.marketCapUsd === "number" ? td.marketCapUsd : null,
                fdv: typeof td.fdvUsd === "number" ? td.fdvUsd : null,
                displayMarketValue: typeof td.displayMarketValue === "number" ? td.displayMarketValue : null,
                displayMarketValueLabel: typeof td.displayMarketValueLabel === "string" ? String(td.displayMarketValueLabel) : "Market Cap",
                displayMarketValueConfidence: typeof td.displayMarketValueConfidence === "string" ? String(td.displayMarketValueConfidence) : "low",
              },
              holders: {
                top1: typeof (td.holderDistribution as Record<string,unknown>|undefined)?.top1 === "number" ? (td.holderDistribution as Record<string,unknown>).top1 as number : null,
                top10: typeof (td.holderDistribution as Record<string,unknown>|undefined)?.top10 === "number" ? (td.holderDistribution as Record<string,unknown>).top10 as number : null,
                holderCount: typeof (td.holderDistribution as Record<string,unknown>|undefined)?.holderCount === "number" ? (td.holderDistribution as Record<string,unknown>).holderCount as number : null,
                status: typeof (td.holderDistributionStatus as Record<string,unknown>|undefined)?.status === "string" ? String((td.holderDistributionStatus as Record<string,unknown>).status) : "unavailable",
              },
              security: {
                honeypot: securitySim.honeypot,
                buyTax: securitySim.buyTax,
                sellTax: securitySim.sellTax,
                transferTax: securitySim.transferTax,
                simulationSuccess: securitySim.simulationSuccess,
                securityStatus: securitySim.securityStatus,
                riskLevel: securitySim.riskLevel,
                missing: securitySim.missing,
                proxy: null,
                mintable: null,
                ownerRenounced: null,
              },
              liquidity: { pools: Array.isArray(td.pools) ? (td.pools as unknown[]).length : 0, topPoolLiquidity: typeof td.liquidity === "number" ? td.liquidity : null },
              poolDetails: [],
              warnings: [...securitySim.warnings],
            },
          };
          const fullEvidence = buildFullReportEvidence(reportEvidence, memItem.address);
          const scanText = renderQuickTokenScan(fullEvidence);
          updateMemToken(sessionMem, memItem.address, String(td.symbol ?? memItem.symbol ?? "?"), String(td.name ?? memItem.name ?? "Token"), scanText);
          return { feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: ["token_scan"], analysis: scanText };
        }
        return { feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: [], analysis: `I couldn't pull live data for ${memItem.symbol ?? `token #${_memRank}`} right now. Try pasting the contract directly.` };
      }
      if (_memRank > sessionMem.lastMomentumList.length) {
        return { feature: "clark-ai", chain, mode: "analysis", intent: "token_analysis", toolsUsed: [], analysis: `I have ${sessionMem.lastMomentumList.length} movers in memory. Pick 1–${sessionMem.lastMomentumList.length}.` };
      }
    }
  }

  const plan = buildClarkToolPlan({
    message: prompt,
    mode: body.mode,
    uiModeHint: body.uiModeHint,
    context: body.context,
    history: body.history,
    structuredMarketList,
    clarkContext: body.clarkContext,
  });
  const { evidence, toolsUsed, resolvedAddress } = await executeClarkToolPlan({ plan, origin, prompt, chain, verifiedPlan: verifiedPlan ?? clarkInternalCtx.verifiedPlan ?? 'free', authHeader: authHeader ?? (clarkInternalCtx.authToken ? `Bearer ${clarkInternalCtx.authToken}` : undefined) });

  if (replyMode === "casual_help" || plan.intent === "casual" || plan.intent === "help") {
    if (/what can you do|what can u do|help|yo what can u do clark/i.test(prompt.toLowerCase())) {
      return {
        feature: "clark-ai",
        chain,
        mode: "casual_help",
        intent: "help",
        toolsUsed: [],
        analysis: [
          "I can help with:",
          "- Scan tokens and contracts",
          "- Scan wallets and summarize behavior",
          "- Read Whale Alerts (stored feed)",
          "- Read Pump Alerts",
          "- Read Base Radar / Base movers",
          "- Check liquidity, security, and holders where data exists",
          "- Explain risk signals and missing checks",
        ].join("\n"),
      };
    }
    return { feature: "clark-ai", chain, mode: "casual_help", analysis: buildCasualClarkReply(prompt), intent: plan.intent, toolsUsed };
  }
  if (directIntent.intent === "capabilities") {
    return {
      feature: "clark-ai",
      chain,
      mode: "casual_help",
      intent: plan.intent,
      toolsUsed,
      analysis: "I can scan Base tokens, analyze wallets, explain whale alerts, summarize what's moving on Base, read liquidity/holder/deployer risk, and explain crypto concepts. I can also help you build watchlists and checklists. I can't trade, custody funds, or execute transactions.",
    };
  }

  if (replyMode === "educational" || plan.intent === "educational") {
    return { feature: "clark-ai", chain, mode: "educational", analysis: buildEducationalReply(prompt), intent: plan.intent, toolsUsed };
  }

  if (replyMode === "routing_help") {
    return { feature: "clark-ai", chain, mode: "routing_help", analysis: buildRoutingHelpReply(prompt), intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "strategy" && !/pumping on base|moving on base|trending|movers|gainers|runners|more|give me|show\s+\d+|new base launches|low cap|base tokens/i.test(prompt.toLowerCase())) {
    return { feature: "clark-ai", chain, mode: "analysis", analysis: buildClarkStrategyReply(prompt), intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "wallet_compare_request") {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: "Wallet compare is planned for the next phase. For now, share one wallet and I'll score it with available evidence.",
      intent: plan.intent,
      toolsUsed,
    };
  }

  if (plan.intent === "token_full_report_request") {
    if (evidence.tokenResolve?.ok && evidence.tokenResolve.matches.length > 1 && !evidence.tokenResolve.selected) {
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
    const _reportToken = reportEvidence.token;
    if (_reportToken?.address) {
      updateMemToken(sessionMem, _reportToken.address, _reportToken.symbol ?? null, _reportToken.name ?? null, analysis);
      updateMemIntent(sessionMem, "token_analysis");
    }
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
    const req = parseMarketRequest(prompt);
    const seen = extractSeenMarketState(body);
    const seenAddressArray = [...seen.addresses];
    const extended = /\b(100|show 100|list 100|give me 100|500)\b/i.test(prompt);
    const requestedCount = /\b500\b/.test(prompt) ? 100 : req.count;
    const universe = await getBaseMarketUniverse({
      origin,
      mode: req.mode,
      requestedCount: extended ? requestedCount : Math.max(40, requestedCount),
      followup: req.wantsMore,
      excludeAddresses: req.wantsMore ? seenAddressArray : [],
      includePoolVariants: req.includePoolVariants,
    }).catch(() => ({ candidates: [] as BaseMarketCandidate[], clamped: /\b500\b/.test(prompt), cappedMessage: /\b500\b/.test(prompt) ? "I can show up to 100 usable Base candidates at a time." : null }));

    const take = extended
      ? Math.min(requestedCount, 100)
      : (requestedCount > 10 ? Math.min(requestedCount, 100) : (req.wantsMore ? Math.min(requestedCount, 20) : 10));
    const strictDifferent = req.strictDifferent;
    const cursorOffset = Math.max(0, Number(body.clarkContext?.marketCursor?.offset ?? 0) || 0);
    const startOffset = req.wantsMore ? cursorOffset : 0;
    const marketRows: BaseMarketCandidate[] = [];
    const localSymbols = new Set<string>();
    const localNames = new Set<string>();
    let consumed = startOffset;
    for (let i = startOffset; i < universe.candidates.length; i++) {
      consumed = i + 1;
      const c = universe.candidates[i];
      const token = c.tokenAddress?.toLowerCase() ?? null;
      const pool = c.poolAddress?.toLowerCase() ?? null;
      const symbol = (c.symbol ?? "").toUpperCase();
      const normalizedName = normalizeMarketName(c.name ?? c.symbol ?? "");
      if (token && seen.addresses.has(token)) continue;
      if (pool && seen.pools.has(pool)) continue;
      if (strictDifferent && symbol && seen.symbols.has(symbol)) continue;
      if (strictDifferent && normalizedName && seen.names.has(normalizedName)) continue;
      if (strictDifferent && symbol && localSymbols.has(symbol)) continue;
      if (strictDifferent && normalizedName && localNames.has(normalizedName)) continue;
      if (symbol) localSymbols.add(symbol);
      if (normalizedName) localNames.add(normalizedName);
      marketRows.push(c);
      if (marketRows.length >= take) break;
    }
    const offsetBase = req.wantsMore ? startOffset : 0;
    const cappedRemainingMessage = req.wantsMore && marketRows.length < take
      ? `I can only see ${marketRows.length} more usable Base candidates from the current feed.`
      : null;
    if (marketRows.length > 0) {
      const headerLine = strictDifferent
        ? "Clark is showing a fresh set of different Base candidates from the current pool feed."
        : `Clark is seeing ${universe.candidates.length} usable Base candidates from current pool data.`;
      const readLine = strictDifferent && req.wantsMore
        ? "These are further down the feed, so treat them as watchlist names — not stronger than the first batch."
        : "This list is led by tokens with real liquidity, but there are still noisy runners mixed in.";
      updateMemMomentum(sessionMem, marketRows.map((c, i) => ({
        rank: offsetBase + i + 1,
        symbol: c.symbol ?? "?",
        name: c.name ?? null,
        address: c.tokenAddress ?? c.poolAddress ?? null,
        liquidity: c.liquidityUsd ?? null,
        volume24h: c.volume24h ?? null,
        change24h: c.change24h ?? null,
        tag: c.reasonTags?.[0] ?? null,
      })));
      sessionMem.allowedRankScanUntil = Date.now() + 60_000;
      sessionMem.allowedRankScanUsed = false;
      updateMemIntent(sessionMem, "market");
      return {
        feature: "clark-ai",
        chain,
        mode: "general_market",
        analysis: formatBaseMarketReply(marketRows, universe.candidates.length, offsetBase, cappedRemainingMessage ?? universe.cappedMessage, extended)
          .replace(`Clark is seeing ${universe.candidates.length} usable Base candidates from current pool data.`, headerLine)
          .replace("This list is led by tokens with real liquidity, but there are still noisy runners mixed in.", readLine),
        marketContext: {
          type: "base_market_list",
          mode: req.mode,
          createdAt: new Date().toISOString(),
          cursor: {
            offset: consumed,
            returnedCount: marketRows.length,
            requestedCount: take,
            totalCandidates: universe.candidates.length,
          },
          items: marketRows.map((c, i) => ({
            rank: offsetBase + i + 1,
            symbol: c.symbol ?? "?",
            name: c.name ?? null,
            tokenAddress: c.tokenAddress ?? null,
            poolAddress: c.poolAddress ?? null,
            reasonTag: c.reasonTags[0] ?? null,
            price: c.priceUsd ?? null,
            liquidity: c.liquidityUsd ?? null,
            volume24h: c.volume24h ?? null,
            change24h: c.change24h ?? null,
          })),
        },
        intent: plan.intent,
        toolsUsed: [...new Set([...toolsUsed, "market_get_base_movers"])],
      };
    }
    if (evidence.market?.ok) {
      const list = evidence.market.candidates.slice(0, 10).map((c) => ({
        attributes: {
          name: `${c.token} / USDC`,
          reserve_in_usd: c.liquidity,
          volume_usd: { h24: c.volume24h },
          price_change_percentage: { h24: c.change24h },
        },
      }));
      return { feature: "clark-ai", chain, mode: "general_market", analysis: buildGTMarketBriefing(list), intent: plan.intent, toolsUsed };
    }
    return { feature: "clark-ai", chain, mode: "general_market", analysis: "I can't pull the full Base market feed right now, but I can still scan any token you paste and build a watchlist from partial data.", intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "wallet_balance") {
    const w = evidence.walletSnapshot;
    if (!w?.ok) {
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "I couldn't pull this wallet snapshot right now. Paste the wallet again and I'll retry.", intent: plan.intent, toolsUsed };
    }
    const summary = formatWalletBalanceSummary(w);
    if (w.address) updateMemWallet(sessionMem, String(w.address), null, summary);
    updateMemIntent(sessionMem, "wallet_balance");
    return { feature: "clark-ai", chain, mode: "analysis", analysis: summary, intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "wallet_quality") {
    if (!resolvedAddress) {
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "Share the wallet address and I'll evaluate quality with available evidence.", intent: plan.intent, toolsUsed };
    }
    if (evidence.walletSnapshot?.ok) {
      const quality = buildWalletQualityVerdict(evidence.walletSnapshot, resolvedAddress, prompt);
      updateMemWallet(sessionMem, resolvedAddress, null, quality);
      updateMemIntent(sessionMem, "wallet_analysis");
      return { feature: "clark-ai", chain, mode: "analysis", analysis: quality, intent: plan.intent, toolsUsed };
    }
    if (evidence.walletQuality?.analysis) {
      const qualityAnalysis = enforceWalletAssetLabel(evidence.walletQuality.analysis, resolvedAddress);
      updateMemWallet(sessionMem, resolvedAddress, null, qualityAnalysis);
      updateMemIntent(sessionMem, "wallet_analysis");
      return { feature: "clark-ai", chain, mode: "analysis", analysis: qualityAnalysis, intent: plan.intent, toolsUsed };
    }
    const fallback = evidence.walletSnapshot
      ? enforceWalletAssetLabel(buildWalletAnalysisFallback(evidence.walletSnapshot, resolvedAddress), resolvedAddress)
      : "I can judge this as a whale/watch wallet only. Not enough verified data to call it smart money yet.";
    return { feature: "clark-ai", chain, mode: "analysis", analysis: fallback, intent: plan.intent, toolsUsed };
  }

  if (plan.intent === "dev_wallet") {
    if (!resolvedAddress) return { feature: "clark-ai", chain, mode: "analysis", analysis: missingAddressReply("dev_wallet"), intent: plan.intent, toolsUsed };
    const resolvedSymbol = evidence.tokenResolve?.selected?.symbol ?? null;
    const aliasForSymbol = resolvedSymbol ? BASE_TOKEN_ALIAS_MAP[resolvedSymbol.toLowerCase()] : null;
    const _devScanMismatch = resolvedSymbol && evidence.tokenScan?.token?.symbol && evidence.tokenScan.token.symbol.toUpperCase() !== resolvedSymbol.toUpperCase();
    const _devLiqMismatch = resolvedSymbol && evidence.liquidity?.token?.symbol && evidence.liquidity.token.symbol.toUpperCase() !== resolvedSymbol.toUpperCase();
    const tokenName = (_devScanMismatch ? undefined : evidence.tokenScan?.token?.name) ?? (_devLiqMismatch ? undefined : evidence.liquidity?.token?.name) ?? aliasForSymbol?.name ?? resolvedSymbol ?? "Unknown token";
    const tokenSymbol = (_devScanMismatch ? undefined : evidence.tokenScan?.token?.symbol) ?? (_devLiqMismatch ? undefined : evidence.liquidity?.token?.symbol) ?? resolvedSymbol ?? "?";
    if (evidence.devWallet?.ok) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        analysis: renderDevWalletFocusedRead(tokenName, tokenSymbol, resolvedAddress, evidence.devWallet),
        intent: plan.intent,
        toolsUsed,
      };
    }
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: [
        "DEV WALLET READ",
        `- Asset: ${tokenName} (${tokenSymbol})`,
        `- Contract: ${resolvedAddress}`,
        "- Likely deployer: Unverified",
        "- Linked wallets: Unverified",
        "- Suspicious patterns: Data unavailable in this pass.",
        "- Confidence: Low",
        "- What it means: I cannot verify deployer behavior yet, so treat this as unresolved risk.",
      ].join("\n"),
      intent: plan.intent,
      toolsUsed,
    };
  }

  if (plan.intent === "liquidity_safety") {
    if (!resolvedAddress) return { feature: "clark-ai", chain, mode: "analysis", analysis: missingAddressReply("liquidity_safety"), intent: plan.intent, toolsUsed };
    const resolvedSymbolLiq = evidence.tokenResolve?.selected?.symbol ?? null;
    const aliasForSymbolLiq = resolvedSymbolLiq ? BASE_TOKEN_ALIAS_MAP[resolvedSymbolLiq.toLowerCase()] : null;
    const _liqScanMismatch = resolvedSymbolLiq && evidence.tokenScan?.token?.symbol && evidence.tokenScan.token.symbol.toUpperCase() !== resolvedSymbolLiq.toUpperCase();
    const _liqLiqMismatch = resolvedSymbolLiq && evidence.liquidity?.token?.symbol && evidence.liquidity.token.symbol.toUpperCase() !== resolvedSymbolLiq.toUpperCase();
    const tokenName = (_liqScanMismatch ? undefined : evidence.tokenScan?.token?.name) ?? (_liqLiqMismatch ? undefined : evidence.liquidity?.token?.name) ?? aliasForSymbolLiq?.name ?? resolvedSymbolLiq ?? "Unknown token";
    const tokenSymbol = (_liqScanMismatch ? undefined : evidence.tokenScan?.token?.symbol) ?? (_liqLiqMismatch ? undefined : evidence.liquidity?.token?.symbol) ?? resolvedSymbolLiq ?? "?";
    if (evidence.liquidity?.ok && evidence.liquidity.token && !_liqLiqMismatch) {
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        analysis: renderLiquidityFocusedRead(tokenName, tokenSymbol, resolvedAddress, evidence.liquidity),
        intent: plan.intent,
        toolsUsed,
      };
    }
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: [
        "LIQUIDITY READ",
        `- Asset: ${tokenName} (${tokenSymbol})`,
        `- Contract: ${resolvedAddress}`,
        "- Pool depth: Unverified — incomplete data in this pass",
        "- LP control: Unverified",
        "- Concentration: Unverified",
        "Worth monitoring once liquidity data is available.",
      ].join("\n"),
      intent: plan.intent,
      toolsUsed,
    };
  }

  if (plan.intent === "token_analysis") {
    if (evidence.tokenResolve?.ok && evidence.tokenResolve.matches.length > 1 && !evidence.tokenResolve.selected) {
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
      const tokenRes = await callInternalApi(origin, "/api/token", { contract: evidence.tokenResolve.selected.contract }, authHeader ?? undefined);
      const tokenData = tokenRes.ok ? tokenRes.json : null;
      const securitySim = await fetchHoneypotSecurity(evidence.tokenResolve.selected.contract, "base");
      if (tokenData) evidence.tokenScan = {
        ok: true,
        token: { name: String((tokenData as Record<string, unknown>).name ?? "Token"), symbol: String((tokenData as Record<string, unknown>).symbol ?? "?"), address: String((tokenData as Record<string, unknown>).contract ?? evidence.tokenResolve.selected.contract) },
        market: {
          price: typeof (tokenData as Record<string, unknown>).price === "number" ? (tokenData as Record<string, unknown>).price as number : null,
          change24h: typeof (tokenData as Record<string, unknown>).priceChange24h === "number" ? (tokenData as Record<string, unknown>).priceChange24h as number : null,
          volume24h: typeof (tokenData as Record<string, unknown>).volume24h === "number" ? (tokenData as Record<string, unknown>).volume24h as number : null,
          liquidity: typeof (tokenData as Record<string, unknown>).liquidity === "number" ? (tokenData as Record<string, unknown>).liquidity as number : null,
          marketCap: typeof (tokenData as Record<string, unknown>).marketCapUsd === "number" ? (tokenData as Record<string, unknown>).marketCapUsd as number : null,
          fdv: typeof (tokenData as Record<string, unknown>).fdvUsd === "number" ? (tokenData as Record<string, unknown>).fdvUsd as number : null,
          displayMarketValue: typeof (tokenData as Record<string, unknown>).displayMarketValue === "number" ? (tokenData as Record<string, unknown>).displayMarketValue as number : null,
          displayMarketValueLabel: typeof (tokenData as Record<string, unknown>).displayMarketValueLabel === "string" ? String((tokenData as Record<string, unknown>).displayMarketValueLabel) : "Market Cap",
          displayMarketValueConfidence: typeof (tokenData as Record<string, unknown>).displayMarketValueConfidence === "string" ? String((tokenData as Record<string, unknown>).displayMarketValueConfidence) : "low",
        },
        holders: {
          top1: typeof ((tokenData as Record<string, unknown>).holderDistribution as Record<string, unknown> | undefined)?.top1 === "number" ? (((tokenData as Record<string, unknown>).holderDistribution as Record<string, unknown>).top1 as number) : null,
          top10: typeof ((tokenData as Record<string, unknown>).holderDistribution as Record<string, unknown> | undefined)?.top10 === "number" ? (((tokenData as Record<string, unknown>).holderDistribution as Record<string, unknown>).top10 as number) : null,
          holderCount: typeof ((tokenData as Record<string, unknown>).holderDistribution as Record<string, unknown> | undefined)?.holderCount === "number" ? (((tokenData as Record<string, unknown>).holderDistribution as Record<string, unknown>).holderCount as number) : null,
          status: typeof ((tokenData as Record<string, unknown>).holderDistributionStatus as Record<string, unknown> | undefined)?.status === "string" ? String(((tokenData as Record<string, unknown>).holderDistributionStatus as Record<string, unknown>).status) : "unavailable",
        },
        security: {
          honeypot: securitySim.honeypot,
          buyTax: securitySim.buyTax,
          sellTax: securitySim.sellTax,
          transferTax: securitySim.transferTax,
          simulationSuccess: securitySim.simulationSuccess,
          securityStatus: securitySim.securityStatus,
          riskLevel: securitySim.riskLevel,
          missing: securitySim.missing,
          proxy: null,
          mintable: null,
          ownerRenounced: null,
        },
        liquidity: { pools: Array.isArray((tokenData as Record<string, unknown>).pools) ? ((tokenData as Record<string, unknown>).pools as unknown[]).length : 0, topPoolLiquidity: typeof (tokenData as Record<string, unknown>).liquidity === "number" ? (tokenData as Record<string, unknown>).liquidity as number : null },
        poolDetails: Array.isArray((tokenData as Record<string, unknown>).pools)
          ? ((tokenData as Record<string, unknown>).pools as Array<Record<string, unknown>>).map((p) => {
            const a = (p.attributes ?? p) as Record<string, unknown>;
            return {
              dex: typeof a.dex === "string" ? a.dex : (typeof a.dex_id === "string" ? a.dex_id : "DEX"),
              pair: typeof a.pair === "string" ? a.pair : (typeof a.name === "string" ? a.name : "pair"),
              liquidity: typeof a.liquidity === "number" ? a.liquidity : (typeof a.reserve_in_usd === "number" ? a.reserve_in_usd : null),
              volume24h: typeof a.volume24h === "number" ? a.volume24h : (typeof (a.volume_usd as Record<string, unknown> | undefined)?.h24 === "number" ? (a.volume_usd as Record<string, unknown>).h24 as number : null),
              change24h: typeof a.change24h === "number" ? a.change24h : (typeof (a.price_change_percentage as Record<string, unknown> | undefined)?.h24 === "number" ? (a.price_change_percentage as Record<string, unknown>).h24 as number : null),
              poolAddress: typeof a.address === "string" ? a.address : (typeof p.id === "string" ? p.id : null),
            };
          })
          : [],
        warnings: [...securitySim.warnings],
      };
    }

    const token = evidence.tokenScan?.token;
    const wantsPoolBreakdown = /\b(show all .*pools|show all pools|all pools for|pools for|token \d+ pools|pool breakdown|[A-Z0-9$._-]{2,12}\s+pools)\b/i.test(prompt);
    if (wantsPoolBreakdown && !token) {
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "I can't pull all pools right now, but I can still run a full report on the token.", intent: plan.intent, toolsUsed };
    }
    if (wantsPoolBreakdown && token) {
      const pools = [...(evidence.tokenScan?.poolDetails ?? [])].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
      if (!pools.length) {
        return { feature: "clark-ai", chain, mode: "analysis", analysis: "I can't pull all pools right now, but I can still run a full report on the token.", intent: plan.intent, toolsUsed };
      }
      const topLiq = pools[0]?.liquidity ?? 0;
      const totalLiq = pools.reduce((s, p) => s + (p.liquidity ?? 0), 0);
      const concentrated = totalLiq > 0 && topLiq / totalLiq >= 0.6;
      return {
        feature: "clark-ai",
        chain,
        mode: "analysis",
        analysis: [
          `Pool breakdown: ${token.symbol ?? "?"}`,
          `Contract: ${token.address}`,
          "",
          "Pools:",
          ...pools.slice(0, 8).map((p, i) => `${i + 1}. ${p.dex}/${p.pair} — liquidity ${formatUsdShort(p.liquidity)} — 24h vol ${formatUsdShort(p.volume24h)} — 24h move ${p.change24h != null ? `${p.change24h.toFixed(2)}%` : "Unverified"} — pool ${p.poolAddress ?? "Unverified"}`),
          "",
          "Clark's read:",
          concentrated ? "Liquidity is concentrated in one dominant pool, so execution risk is more sensitive to that venue." : "Liquidity is spread across multiple pools, which usually supports smoother execution.",
          "",
          "Next:",
          "Run full report or liquidity check before sizing.",
        ].join("\n"),
        intent: plan.intent,
        toolsUsed,
      };
    }
    if (!token) {
      // Bare address paste — token scan found nothing. Try wallet scan before giving up.
      if (isBareAddressPrompt(prompt) && resolvedAddress) {
        const walletRes = await callInternalApi(origin, "/api/wallet", { address: resolvedAddress }, authHeader ?? undefined);
        const w = (walletRes.json ?? {}) as Record<string, unknown>;
        if (walletRes.ok && Array.isArray(w.holdings) && (w.holdings as unknown[]).length > 0) {
          const snapshot = normalizeWalletSnapshotEvidence(w, resolvedAddress);
          const walletAnalysis = buildWalletQualityVerdict(snapshot, resolvedAddress, prompt);
          updateMemWallet(sessionMem, resolvedAddress, null, walletAnalysis);
          updateMemIntent(sessionMem, "wallet_analysis");
          return { feature: "clark-ai", chain, mode: "analysis", intent: "wallet_analysis", toolsUsed: [...toolsUsed, "wallet_get_snapshot"], analysis: walletAnalysis };
        }
        return {
          feature: "clark-ai", chain, mode: "analysis", intent: plan.intent, toolsUsed,
          analysis: "I could not confirm a Base match from current checks. To be explicit: 'scan token 0x...' for tokens or 'scan wallet 0x...' for wallets.",
        };
      }
      if (resolvedAddress) {
        const fallbackReport = buildFullReportEvidence(evidence, resolvedAddress);
        if (/why is it moving|why is token\s+\d+\s+moving|explain the move/i.test(prompt.toLowerCase())) {
          const pack = buildClarkEvidencePack(fallbackReport);
          return {
            feature: "clark-ai",
            chain,
            mode: "analysis",
            analysis: [
              `Move read for ${pack.asset}:`,
              `- Price action: ${pack.marketFacts[0] ?? "Unverified"}`,
              `- Volume: ${pack.marketFacts[1] ?? "Unverified"}`,
              `- Liquidity: ${pack.marketFacts[2] ?? "Unverified"}`,
              "- Trade flow: Unverified in this pass.",
              "- What it means: momentum needs volume + liquidity confirmation to stay reliable.",
              `- What could invalidate it: ${pack.riskDrivers.length ? pack.riskDrivers.join(" ") : "Loss of liquidity or failed follow-through."}`,
            ].join("\n"),
            intent: plan.intent,
            toolsUsed,
          };
        }
        const fbScanText = renderQuickTokenScan(fallbackReport);
        updateMemToken(sessionMem, resolvedAddress, fallbackReport.token.symbol ?? null, fallbackReport.token.name ?? null, fbScanText);
        updateMemIntent(sessionMem, "token_analysis");
        return {
          feature: "clark-ai",
          chain,
          mode: "analysis",
          analysis: fbScanText,
          intent: plan.intent,
          toolsUsed,
        };
      }
      if (directIntent.address && !/wallet|balance|portfolio|copy[\s-]?trade/i.test(prompt)) {
        return { feature: "clark-ai", chain, mode: "analysis", analysis: "Is this address a token contract or a wallet? Tell me which scan you want.", intent: plan.intent, toolsUsed };
      }
      return { feature: "clark-ai", chain, mode: "analysis", analysis: "Paste a Base token contract (or token name) and I'll scan it.", intent: plan.intent, toolsUsed };
    }
    const report = buildFullReportEvidence(evidence, token.address);
    const pack = buildClarkEvidencePack(report);
    const lower = prompt.toLowerCase();
    const isHolderFocusedQuery = /\b(?:holder(?:s|\s+concentration|\s+distribution|\s+count)?|top\s+holders?|supply\s+concentration)\b/i.test(lower);
    const analysis =
      isHolderFocusedQuery
        ? buildHolderFocusedReply(report)
        : /is it safe|safe\??$/.test(lower)
        ? [
            `Safety read for ${pack.asset}:`,
            `- Verified now: ${pack.confidenceDrivers.length ? pack.confidenceDrivers.join(" ") : "Only partial market/security checks."}`,
            `- Risks seen: ${pack.riskDrivers.length ? pack.riskDrivers.join(" ") : "No critical risk flag confirmed yet."}`,
            `- Not verified yet: ${pack.missing.length ? pack.missing.join(", ") : "No major missing fields."}`,
            "- Still unconfirmed: LP control and deployer behavior have not been verified."
          ].join("\n")
        : /why is it moving|why is token\s+\d+\s+moving|explain the move/.test(lower)
          ? [
              `Move explainer for ${pack.asset}:`,
              `- Market picture: ${pack.marketFacts.join(" | ")}`,
              `- Liquidity context: ${pack.liquidityFacts.join(" | ")}`,
              `- Interpretation: moves are reliable only when volume and liquidity rise together without new contract/deployer risk flags.`,
              `- Missing context: ${pack.missing.length ? pack.missing.join(", ") : "limited missing fields"}`
            ].join("\n")
          : renderQuickTokenScan(report);
    updateMemToken(sessionMem, token.address, token.symbol ?? null, token.name ?? null, analysis);
    updateMemIntent(sessionMem, "token_analysis");
    return { feature: "clark-ai", chain, mode: "analysis", analysis, intent: plan.intent, toolsUsed };
  }

  if ((replyMode === "analysis" || replyMode === "feature_context") && !resolvedAddress && !plan.followupContext.lastTokenAddress && directIntent.intent !== "token_name_lookup") {
    return {
      feature: "clark-ai",
      chain,
      mode: "analysis",
      analysis: "I can help with a token, wallet, liquidity, dev wallet, whale flow, pump alerts, or Base movers. Try 'scan BRETT' or 'what\\'s pumping on Base?'.",
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
  // Do not call Anthropic generically when nothing was resolved and intent is unknown
  if (replyMode === "unknown" && !resolvedAddress && !evidence.tokenScan && !evidence.walletSnapshot && !evidence.market?.ok) {
    return {
      feature: "clark-ai",
      chain,
      mode: "casual_help",
      intent: plan.intent,
      toolsUsed,
      analysis: "I can help with a token, wallet, liquidity, dev wallet, whale flow, pump alerts, or Base movers. Try 'scan BRETT' or 'what\\'s pumping on Base?'.",
    };
  }
  const memoryPrompt = historyContext
    ? `${prompt}\n\nRecent conversation context (use this for follow-ups like "it", "that", "why", "what about holders/liquidity"; ask one concise clarifying question only if reference is ambiguous):\n${historyContext}`
    : prompt;
  const analysis = await callAnthropic(memoryPrompt, context);
  return { feature: "clark-ai", chain, mode: replyMode, analysis, intent: plan.intent, toolsUsed };
}

// ---------- Main handler ----------

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const authHeader = auth || undefined
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const authenticated = Boolean(token)
  const rawPlan: 'free' | 'pro' | 'elite' = authenticated
    ? await getCurrentUserPlanFromBearerToken(token).then(x => x.plan).catch(() => 'free')
    : 'free'
  const betaAllElite = process.env.BETA_ALL_ELITE === 'true'
  const betaEliteActive = betaAllElite && authenticated
  const effectivePlan: 'free' | 'pro' | 'elite' = betaEliteActive ? 'elite' : rawPlan
  const actor = clarkActor(req, authenticated)
  const planKey = authenticated ? effectivePlan : 'unauth'

  // Parse body early so we can classify prompt cost for two-tier rate limiting
  let body: ClarkRequestBody
  try {
    body = (await req.json()) as ClarkRequestBody
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  if (body.message && !body.prompt) body.prompt = body.message
  const debugMemory = Boolean((body as { debugMemory?: boolean }).debugMemory) || req.nextUrl.searchParams.get('debug') === 'true'

  // Classify prompt cost for two-tier rate limiting
  const sessionKey = makeSessionKey(req, authenticated)
  const memoryKeySource = getSessionKeySource(req, authenticated)
  const sessionMem = getSessionMemory(sessionKey)
  if (sessionMem.lastMomentumList.length === 0 && Array.isArray(body.clientContext?.lastMomentumList) && body.clientContext!.lastMomentumList!.length > 0) {
    updateMemMomentum(sessionMem, body.clientContext!.lastMomentumList!.slice(0, 20));
  }
  if (typeof body.clientContext?.lastMomentumShownCount === "number" && body.clientContext.lastMomentumShownCount >= 0) {
    sessionMem.lastMomentumShownCount = Math.min(body.clientContext.lastMomentumShownCount, sessionMem.lastMomentumList.length);
  }
  if (!sessionMem.lastToken && body.clientContext?.lastToken?.address) sessionMem.lastToken = body.clientContext.lastToken;
  if (!sessionMem.lastWallet && body.clientContext?.lastWallet?.address) sessionMem.lastWallet = body.clientContext.lastWallet;
  const earlyPrompt = (body.prompt ?? '').trim()
  const isMoreFollowup = earlyPrompt ? (MORE_CONTEXT_RE.test(earlyPrompt) && (sessionMem.lastMomentumList.length > 0 || Boolean(sessionMem.lastToken))) : false
  const earlyRank = earlyPrompt ? parseRankFollowup(earlyPrompt) : null
  const rankFromMemory = Boolean(earlyRank && sessionMem.lastMomentumList.length > 0)
  const rankAllowanceActive = rankFromMemory && !sessionMem.allowedRankScanUsed && Date.now() < sessionMem.allowedRankScanUntil
  const promptIsLowCost = earlyPrompt ? (isLowCostPrompt(earlyPrompt, sessionMem) || isMoreFollowup) : false

  // Check cache before rate limiting — cached responses bypass expensive tool quota
  const earlyCacheKey = JSON.stringify({ actor, verifiedPlan: effectivePlan, feature: body.feature, mode: body.mode ?? "", prompt: earlyPrompt, chain: body.chain ?? "base", token: body.tokenAddress ?? body.addressOrToken ?? "", wallet: body.walletAddress ?? "" });
  const earlyCached = clarkCache.get(earlyCacheKey);
  if (earlyCached && earlyCached.exp > Date.now()) {
    return NextResponse.json(earlyCached.payload);
  }
  if (debugMemory || process.env.NODE_ENV !== 'production') {
    console.log('[clark-memory]', {
      key: `${sessionKey.slice(0, 8)}...`,
      source: memoryKeySource,
      hasLastMomentumList: sessionMem.lastMomentumList.length > 0,
      lastMomentumListLength: sessionMem.lastMomentumList.length,
      hasLastToken: Boolean(sessionMem.lastToken),
      lastActionableIntent: sessionMem.lastActionableIntent,
      rankParsed: earlyRank,
      prompt: earlyPrompt.slice(0, 80),
    })
  }

  // Memory-only continuation must execute before expensive rate limiting.
  if (body.feature === 'clark-ai' && isMoreFollowup) {
    const origin = req.nextUrl.origin;
    const moreResult = await handleClarkAI(body, origin, authHeader, effectivePlan, sessionMem);
    const normalized = { ok: true, feature: body.feature, data: normalizeApiReplyShape(moreResult, body) } as Record<string, unknown>
    if (debugMemory) normalized.debugMemory = {
      memoryKeySource,
      hasLastMomentumList: sessionMem.lastMomentumList.length > 0,
      lastMomentumListLength: sessionMem.lastMomentumList.length,
      hasLastToken: Boolean(sessionMem.lastToken),
      lastActionableIntent: sessionMem.lastActionableIntent,
      rankParsed: earlyRank,
      allowedRankScanActive: (!sessionMem.allowedRankScanUsed && Date.now() < sessionMem.allowedRankScanUntil),
      cooldownBucketUsed: 'lowcost',
    }
    return NextResponse.json(normalized, { status: 200 })
  }

  const rateResult = (promptIsLowCost || rankAllowanceActive)
    ? checkClarkLowCostRate(actor, planKey)
    : checkClarkRate(actor, planKey)
  if (!rateResult.allowed) {
    const errMsg = promptIsLowCost
      ? "Slow down for a moment — Clark can continue after a short pause."
      : rateResult.window === 'minute'
        ? "Clark is protecting live CORTEX reads from spam. Try a follow-up question or wait a moment."
        : "Daily Clark limit reached for your plan."
    if (rankFromMemory) {
      return NextResponse.json({ error: "I have the mover list ready. Live token scan is cooling down for a moment — try 'scan 1' again shortly, or ask what volume-led/tradable depth means." }, { status: 429 })
    }
    const debugInfo = process.env.NODE_ENV !== 'production'
      ? { effectivePlan, betaAllElite, betaEliteActive, limitWindow: rateResult.window, promptIsLowCost }
      : undefined
    return NextResponse.json({ error: errMsg, ...debugInfo }, { status: 429 })
  }
  try {
    clarkInternalCtx = { authToken: token || undefined, verifiedPlan: effectivePlan }
    // body already parsed before rate check — do NOT call req.json() again
    const cacheKey = JSON.stringify({ actor, verifiedPlan: effectivePlan, feature: body.feature, mode: body.mode ?? "", prompt: body.prompt ?? body.message ?? "", chain: body.chain ?? "base", token: body.tokenAddress ?? body.addressOrToken ?? "", wallet: body.walletAddress ?? "" })
    const cached = clarkCache.get(cacheKey)
    if (cached && cached.exp > Date.now()) return NextResponse.json(cached.payload)
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
        result = await handleWalletScanner(body, origin, authHeader);
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
        if (rankAllowanceActive) {
          sessionMem.allowedRankScanUsed = true;
        }
        result = await handleClarkAI(body, origin, authHeader, effectivePlan, sessionMem);
        break;
      default:
        return NextResponse.json(
          { error: `Unknown feature: ${body.feature}` },
          { status: 400 }
        );
    }

    const normalized = { ok: true, feature: body.feature, data: normalizeApiReplyShape(result, body) } as Record<string, unknown>
    const normData = normalized.data as Record<string, unknown>
    for (const k of ["reply", "response", "analysis", "verdict"] as const) {
      if (typeof normData[k] === "string") normData[k] = cleanClarkText(normData[k] as string)
    }
    if (debugMemory) normalized.debugMemory = {
      memoryKeySource,
      hasLastMomentumList: sessionMem.lastMomentumList.length > 0,
      lastMomentumListLength: sessionMem.lastMomentumList.length,
      hasLastToken: Boolean(sessionMem.lastToken),
      lastActionableIntent: sessionMem.lastActionableIntent,
      rankParsed: earlyRank,
      allowedRankScanActive: (!sessionMem.allowedRankScanUsed && Date.now() < sessionMem.allowedRankScanUntil),
      cooldownBucketUsed: (promptIsLowCost || rankAllowanceActive) ? 'lowcost' : 'tool',
    }
    const resultAnalysis = typeof (result as Record<string, unknown>)?.analysis === 'string' ? (result as Record<string, unknown>).analysis as string : ''
    if (!isValidationOnlyAnalysis(resultAnalysis)) rateResult.commitDaily()
    const cacheTtl = body.feature === "clark-ai" ? 90_000 : body.feature === "whale-alerts" || body.feature === "pump-alerts" || body.feature === "base-radar" ? 120_000 : 60_000
    clarkCache.set(cacheKey, { exp: Date.now() + cacheTtl, payload: normalized })
    return NextResponse.json(normalized, { status: 200 });
  } catch (err: unknown) {
    console.error("[Clark]", err instanceof Error ? err.message : err);
    const safeMsg = [
      "CORTEX could not complete that read from live data right now. The available signals are incomplete.",
      "",
      "Try:",
      "- run token scan: scan SYMBOL",
      "- run liquidity check: liquidity check SYMBOL",
      "- paste a contract address",
      "- paste a wallet address",
    ].join("\n");
    return NextResponse.json({
      ok: true,
      feature: "clark-ai",
      data: { reply: safeMsg, response: safeMsg, analysis: safeMsg, verdict: "SCAN DEEPER", source: "fallback" },
    }, { status: 200 });
  }
  finally {
    clarkInternalCtx = {}
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
