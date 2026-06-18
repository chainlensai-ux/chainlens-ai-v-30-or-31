// Pure, server-side routing/classification/formatting helpers for the Clark chat handler.
// No Next.js / Anthropic SDK dependencies — importable directly by unit test scripts (node + .ts via tsx/ts-node-less import).

export { resolveClarkIntent, type ClarkIntentContext, type ClarkResolvedIntent } from "../clarkIntent.ts";

export type DashboardMarketRow = {
  symbol: string;
  name?: string;
  chain?: string;
  priceUsd?: number;
  change24h?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  contract?: string | null;
  poolAddress?: string | null;
  updatedAt?: string | null;
};

// Fixed list of allowed CTA/action strings surfaced to the client.
export const CLARK_ACTIONS = [
  "Open Base Radar",
  "Open Token Scanner",
  "Scan Wallet",
  "Deep Scan Wallet",
  "Run LP Check",
  "Open Whale Alerts",
  "Refresh Market Data",
] as const;

export type ClarkAction = (typeof CLARK_ACTIONS)[number];

export type ClarkRoutedIntent =
  | "base_market_discovery"
  | "base_radar"
  | "wallet_scan"
  | "wallet_pnl_followup"
  | "wallet_dig_deeper"
  | "wallet_compare"
  | "liquidity_scan"
  | "whale_alert"
  | "token_scan"
  | "token_safety"
  | "dev_rug_check"
  | "lp_lock_check"
  | "risk_explanation"
  | "none";

const WALLET_DEEP_RE = /\b(deep\s+scan|deep|full\s+scan|full\s+wallet\s+scan|scan\s+all\s+chains|pnl|p&l|trades?|historical|dig\s+deeper|recover\s+(?:more\s+)?history|history\s+recovery|why\s+(?:is|are|no|the)\s+pnl|why\s+is\s+pnl\s+(?:missing|zero|wrong)|why\s+no\s+pnl|cost\s+basis|analyze\s+(?:this\s+)?wallet)\b/i;
const WALLET_FOLLOWUP_RE = /\b(dig\s+deeper|why\s+is\s+pnl\s+(?:missing|zero|wrong)|why\s+is\s+the\s+pnl|why\s+no\s+pnl|recover\s+(?:more\s+)?history|what\s+about\s+this\s+wallet|why\s+is\s+history\s+missing|pnl\s+missing|pnl\s+coverage)\b/i;
const WALLET_COMPARE_RE = /\b(compare\s+(?:this\s+)?wallet(?:\s+with|\s+vs|\s+to|\s+and)|compare\s+wallets|wallet\s+comparison|wallet\s+a\s+vs|wallet\s+compare)\b/i;

const TOKEN_SCAN_RE = /\b(scan\s+this\s+token|token\s+scan|scan\s+token|what\s+is\s+this\s+token|tell\s+me\s+about\s+(?:this\s+)?token|check\s+this\s+token|analyze\s+(?:this\s+)?token|token\s+check|run\s+token\s+scan)\b/i;
const TOKEN_SCAN_ON_BASE_RE = /\bscan\b.{0,30}\bon\s+base\b|\bon\s+base\b.{0,30}\bscan\b/i;
const TOKEN_SAFETY_RE = /\b(is\s+this\s+(?:token\s+)?safe|is\s+it\s+safe|should\s+i\s+buy(?:\s+this(?:\s+token)?)?|is\s+this\s+(?:a\s+)?rug(?:\s+pull)?|is\s+this\s+token\s+risky|is\s+(?:it|this)\s+risky|safe\s+to\s+buy|rug\s+check|is\s+it\s+legit)\b/i;
const DEV_RUG_RE = /\b(can\s+(?:the\s+)?dev(?:s?|eloper)?\s+rug|can\s+deployer\s+rug|does\s+dev\s+control|dev\s+control(?:s?|led)?|is\s+ownership\s+renounced|ownership\s+renounced|can\s+they\s+mint|dev\s+(?:wallet\s+)?risk|deployer\s+risk|mint\s+risk|blacklist\s+risk|proxy\s+risk|is\s+owner\s+renounced|who\s+controls\s+(?:the\s+)?supply|supply\s+control)\b/i;
const LP_LOCK_RE = /\b(is\s+lp\s+locked|lp\s+locked|can\s+liquidity\s+be\s+pulled|is\s+liquidity\s+safe|who\s+controls\s+(?:the\s+)?lp|lp\s+(?:burned|burn)|burned\s+lp|explain\s+(?:the\s+)?lp|lp\s+(?:lock|control|safety)|liquidity\s+(?:lock|locked|safety|control|pulled))\b/i;
const RISK_EXPL_RE = /\b(why\s+(?:is\s+(?:this|it)\s+)?(?:high|low)\s+risk|why\s+did\s+it\s+score\s+low|explain\s+(?:the\s+)?risk|what\s+are\s+the\s+red\s+flags|red\s+flags|why\s+(?:the\s+)?caution|why\s+risky|explain\s+(?:the\s+)?score|what\s+makes\s+(?:it|this)\s+risky|what\s+are\s+the\s+risks|explain\s+(?:the\s+)?verdict)\b/i;
const TOKEN_NAME_RE = /\b(scan|check|analyze|tell\s+me\s+about|token\s+scan|is|look\s+up)\s+([A-Z][A-Z0-9]{1,10})\b/;

/**
 * Single source of truth for address routing hint.
 * Returns "token" when explicit token keywords are present, "wallet" when
 * explicit wallet keywords are present, "ambiguous" when both, "none" otherwise.
 * All wallet execution points in route.ts must check routeHint !== "token".
 */
export function getClarkAddressRouteHint(prompt: string): "token" | "wallet" | "ambiguous" | "none" {
  const t = (prompt ?? "").trim().toLowerCase();
  const tokenSignals = /\b(token|coin|contract|\bca\b|ticker|scan\s+this\s+token|token\s+scan|is\s+this\s+token|base\s+token|eth\s+token|on\s+base|on\s+eth|rug|dev\s+rug|lp\s+locked|liquidity\s+locked|base\s+contract|ethereum\s+token|honeypot|buy\s+tax|sell\s+tax)\b/i.test(t);
  const walletSignals = /\b(wallet|portfolio|holdings?|pnl|profit|trades?|scan\s+this\s+wallet|analyze\s+wallet|deep\s+scan\s+wallet|wallet\s+pnl|wallet\s+scan|wallet\s+check|wallet\s+report)\b/i.test(t);
  if (tokenSignals && !walletSignals) return "token";
  if (walletSignals && !tokenSignals) return "wallet";
  if (tokenSignals && walletSignals) return "ambiguous";
  return "none";
}

/** True for prompts that are PnL/history follow-ups about the last scanned wallet. */
export function isWalletPnlFollowupPrompt(text: string): boolean {
  return WALLET_FOLLOWUP_RE.test(String(text ?? ""));
}

/** True for prompts that compare two wallets / "compare this wallet with X". */
export function isWalletComparePrompt(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!WALLET_COMPARE_RE.test(t)) return false;
  // "compare" with at least one wallet address is enough
  return /\b0x[a-f0-9]{40}\b/i.test(t);
}

// Task 1 (Pack 1 hard fix): token follow-up prompts that must always resolve against
// the last scanned token in memory, never fall through to a wallet branch.
const TOKEN_FOLLOWUP_RE = /\b(is\s+it\s+safe|safe\?|is\s+this\s+safe|is\s+this\s+token\s+safe|should\s+i\s+buy|is\s+it\s+legit|is\s+it\s+a\s+rug|is\s+it\s+risky|can\s+(?:the\s+)?dev\s+rug|can\s+liquidity\s+be\s+pulled|is\s+lp\s+locked|is\s+liquidity\s+locked|explain\s+lp|explain\s+holders|explain\s+dev(?:\s+control)?|why\s+high\s+risk|why\s+is\s+it\s+risky|why\s+caution|why\s+open\s+check|what\s+are\s+red\s+flags|explain\s+risk|explain\s+verdict|run\s+lp\s+check|lp\s+check|check\s+lp|liquidity\s+safety|check\s+liquidity(?:\s+safety)?|run\s+liquidity\s+check)\b/i;

// Task 3: explicit wallet language must override token-memory follow-up routing — a user
// who says "wallet pnl", "scan wallet <address>", "portfolio", or "holdings" clearly wants
// the wallet path even right after a token scan, so the token follow-up guard must not
// hijack those prompts.
const EXPLICIT_WALLET_OVERRIDE_RE = /\b(wallet|wallet\s+pnl|portfolio|holdings?|scan\s+wallet|deep\s+scan\s+wallet)\b/i;

/** True for short token follow-up prompts ("is it safe", "explain LP", "can dev rug"...)
 *  that must always be answered from the last scanned token in memory and must never
 *  execute a wallet scan — unless the prompt explicitly names a wallet/portfolio/holdings,
 *  in which case the explicit wallet language wins. */
export function isTokenFollowupPrompt(prompt: string): boolean {
  const t = String(prompt ?? "").trim();
  if (EXPLICIT_WALLET_OVERRIDE_RE.test(t)) return false;
  if (/^safe\??$/i.test(t)) return true;
  return TOKEN_FOLLOWUP_RE.test(t);
}

export type TokenFollowupKind = "safety" | "dev_rug" | "lp_lock" | "risk";

/** Maps a token follow-up prompt to the formatter/intent it should use. */
export function classifyTokenFollowupKind(prompt: string): TokenFollowupKind {
  const t = String(prompt ?? "").toLowerCase();
  if (/\b(can\s+(?:the\s+)?dev\s+rug|explain\s+dev(?:\s+control)?)\b/.test(t)) return "dev_rug";
  if (/\b(is\s+lp\s+locked|explain\s+lp|can\s+liquidity\s+be\s+pulled|run\s+lp\s+check|lp\s+check|check\s+lp|liquidity\s+safety|check\s+liquidity(?:\s+safety)?|run\s+liquidity\s+check)\b/.test(t)) return "lp_lock";
  if (/\b(why\s+high\s+risk|why\s+is\s+it\s+risky|what\s+are\s+red\s+flags|explain\s+risk|explain\s+verdict|explain\s+holders)\b/.test(t)) return "risk";
  return "safety";
}

const EOA_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;

export function extractAddressForRouting(text: string): string | null {
  const m = text.match(/\b0x[a-fA-F0-9]{40}\b/);
  return m ? m[0] : null;
}

/** Return every distinct 0x...40 address found in the prompt, in order of appearance. */
export function extractAllAddressesForRouting(text: string): string[] {
  const raw = typeof text === "string" ? text.match(EOA_ADDRESS_RE) : null;
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw) {
    const lower = a.toLowerCase();
    if (!seen.has(lower)) { seen.add(lower); out.push(a); }
  }
  return out;
}

/**
 * Classify a free-form Clark prompt into one of the new routed intents.
 * Returns "none" when the prompt does not match any of the new routing rules
 * (callers should fall back to the existing detectIntent()/detectLiveIntent()).
 */
export function classifyClarkPrompt(prompt: string): {
  intent: ClarkRoutedIntent;
  address: string | null;
  addresses: string[];
  deep: boolean;
  symbol: string | null;
} {
  const raw = prompt ?? "";
  const t = raw.trim().toLowerCase().replace(/[‘’ʼ´`]/g, "'");
  const address = extractAddressForRouting(raw);
  const addresses = extractAllAddressesForRouting(raw);
  const deep = WALLET_DEEP_RE.test(t);
  const symbolMatch = raw.match(TOKEN_NAME_RE);
  const symbol = symbolMatch ? symbolMatch[2].toUpperCase() : null;

  // ---- Wallet compare (must run before generic wallet_scan) ----
  if (WALLET_COMPARE_RE.test(t)) {
    // Compare needs at least one address (this wallet from memory + the typed one, or two typed)
    if (addresses.length >= 1) {
      return { intent: "wallet_compare", address: addresses[0], addresses, deep, symbol: null };
    }
  }

  // ---- Wallet PnL / history follow-up ("why is pnl missing", "dig deeper", "recover more history") ----
  // These rely on session memory (lastWallet). We still classify them so the caller
  // can resolve the address from memory instead of asking again.
  if (WALLET_FOLLOWUP_RE.test(t)) {
    return { intent: "wallet_pnl_followup", address, addresses, deep: true, symbol: null };
  }

  // ---- LP / liquidity check (classify by phrase; contract-vs-EOA decided by caller via eth_getCode) ----
  if (/\b(lp\s+check|liquidity\s+check)\b/i.test(t) && address) {
    return { intent: "liquidity_scan", address, addresses, deep: false, symbol: null };
  }

  // ---- Wallet scan ----
  const walletScanRe = /\b(scan\s+(?:this\s+)?wallet|scan\s+wallet|analyze\s+(?:this\s+)?wallet|wallet\s+pnl|wallet\s+(?:scan|check|report|analysis))\b/i;
  // token keywords prevent wallet routing even if WALLET_DEEP_RE fires
  const hasExplicitTokenKeyword = /\b(token|coin|contract|ticker|\bca\b|scan\s+this\s+token|token\s+scan|on\s+base|on\s+eth)\b/i.test(t);
  if (address && !hasExplicitTokenKeyword && (walletScanRe.test(t) || WALLET_DEEP_RE.test(t))) {
    return { intent: "wallet_scan", address, addresses, deep, symbol: null };
  }
  // Plain EOA address alone (no other strong intent keywords) → wallet scan
  if (address) {
    const hasOtherStrongIntent =
      /\b(lp\s+check|liquidity\s+check|liquidity|radar|pumping|trending|movers|whale|smart\s+money|token\s+scan|scan\s+this\s+token|token\s+check|is\s+(?:this\s+)?token|this\s+token|can\s+(?:the\s+)?dev|is\s+lp|explain\s+lp|high\s+risk|red\s+flags|on\s+base|on\s+eth|base\s+token|eth\s+token|\btoken\b|\bcoin\b|\bca\b|\bticker\b|contract\s+address)\b/i.test(t);
    if (!hasOtherStrongIntent) {
      return { intent: "wallet_scan", address, addresses, deep, symbol: null };
    }
  }

  // ---- Base Radar (anything containing "radar") ----
  if (/\bradar\b/i.test(t)) {
    return { intent: "base_radar", address: null, addresses, deep: false, symbol: null };
  }

  // ---- Base market discovery (generic "pumping/trending on base", no "radar") ----
  const BASE_MARKET_DISCOVERY_RE =
    /(?:who'?s\s+pumping\s+on\s+base|whos\s+pumping\s+on\s+base|what\s+is\s+pumping\s+on\s+base|what'?s\s+pumping\s+on\s+base|base\s+pairs?\s+(?:are\s+)?pumping|(?:show\s+me\s+)?trending\s+base\s+tokens?|hot\s+base\s+tokens?|base\s+gainers|base\s+pumps|trending\s+base|base\s+(?:movers|trending)|new\s+base\s+pools|what'?s\s+(?:moving|hot|running|happening)\s+on\s+base|base\s+market|top\s+base\s+tokens|base\s+momentum)/i;
  if (BASE_MARKET_DISCOVERY_RE.test(t)) {
    return { intent: "base_market_discovery", address: null, addresses, deep: false, symbol: null };
  }

  // ---- Whale / smart money ----
  if (/\b(whale|whales|big\s+wallet|smart\s+money)\b/i.test(t)) {
    return { intent: "whale_alert", address: null, addresses, deep: false, symbol: null };
  }

  // ---- Token safety ("is this token safe", "is it a rug") ----
  if (TOKEN_SAFETY_RE.test(t)) {
    return { intent: "token_safety", address, addresses, deep: false, symbol };
  }

  // ---- Dev/rug check ----
  if (DEV_RUG_RE.test(t)) {
    return { intent: "dev_rug_check", address, addresses, deep: false, symbol };
  }

  // ---- LP lock check ----
  if (LP_LOCK_RE.test(t)) {
    return { intent: "lp_lock_check", address, addresses, deep: false, symbol };
  }

  // ---- Risk explanation ----
  if (RISK_EXPL_RE.test(t)) {
    return { intent: "risk_explanation", address, addresses, deep: false, symbol };
  }

  // ---- Token scan (explicit "token scan" keyword, or address + "on base", or named token) ----
  if (TOKEN_SCAN_RE.test(t) || (address && TOKEN_SCAN_ON_BASE_RE.test(t))) {
    return { intent: "token_scan", address, addresses, deep: false, symbol };
  }
  // Named token scan without address ("scan VIRTUAL", "check AERO")
  if (symbol && TOKEN_SCAN_RE.test(t)) {
    return { intent: "token_scan", address: null, addresses, deep: false, symbol };
  }

  return { intent: "none", address, addresses, deep: false, symbol: null };
}

// ─────────────────────────────────────────────────────────────────────────
// Wallet scan request body builder
// ─────────────────────────────────────────────────────────────────────────

export type WalletApiRequestBody = {
  address: string;
  walletAddress: string;
  chain: "auto";
  deepScan: boolean;
  debug: boolean;
  source: "clark";
  chainMode?: "all_supported";
};

export function buildWalletApiRequestBody(address: string, deep: boolean): WalletApiRequestBody {
  if (deep) {
    return {
      address,
      walletAddress: address,
      chain: "auto",
      chainMode: "all_supported",
      deepScan: true,
      debug: false,
      source: "clark",
    };
  }
  return {
    address,
    walletAddress: address,
    chain: "auto",
    deepScan: false,
    debug: false,
    source: "clark",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Base market discovery — formatting from dashboardMarketRows or live universe
// ─────────────────────────────────────────────────────────────────────────

export type MarketLikeRow = {
  symbol?: string | null;
  name?: string | null;
  change24h?: number | null;
  volume24hUsd?: number | null;
  priceUsd?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  tokenAddress?: string | null;
  poolAddress?: string | null;
  contract?: string | null;
  pairAddress?: string | null;
  reasonTags?: string[] | null;
};

const MAJOR_BASE_SYMBOLS = new Set([
  "ETH", "WETH", "CBETH", "CBBTC", "BTC", "WBTC", "USDC", "USDBC", "USDT", "DAI",
  "AERO", "VIRTUAL", "VELVET", "WSTETH", "RETH",
]);

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "unverified";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtUsdShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "unverified";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Build the "BASE MARKET READ" reply from dashboard-supplied market rows.
 * Returns null if rows is empty/missing — caller should fall through to the live endpoint.
 */
export function formatBaseMarketReadFromRows(rows: MarketLikeRow[] | undefined | null): string | null {
  if (!rows || rows.length === 0) return null;
  const valid = rows.filter((r) => r && r.symbol);
  if (valid.length === 0) return null;

  const ranked = [...valid]
    .sort((a, b) => {
      const aScore = Math.max(0, a.change24h ?? 0) * 1.5 + Math.log10((a.volume24hUsd ?? 0) + 1) * 3 + Math.log10((a.liquidityUsd ?? 0) + 1) * 2;
      const bScore = Math.max(0, b.change24h ?? 0) * 1.5 + Math.log10((b.volume24hUsd ?? 0) + 1) * 3 + Math.log10((b.liquidityUsd ?? 0) + 1) * 2;
      return bScore - aScore;
    })
    .slice(0, 5);

  const lines = ["Here are the strongest Base movers I found right now:"];
  ranked.forEach((r, i) => {
    const sym = String(r.symbol ?? "?").toUpperCase();
    const label = r.name && r.name !== r.symbol ? `${sym} (${r.name})` : sym;
    const pair = r.pairAddress ?? r.poolAddress ?? r.contract ?? r.tokenAddress ?? null;
    const reasons = Array.isArray(r.reasonTags) && r.reasonTags.length > 0
      ? r.reasonTags.join(" + ")
      : [
          (r.volume24hUsd ?? 0) > 0 ? "volume spike" : null,
          r.change24h != null ? "price move" : null,
          pair ? "active pair" : null,
        ].filter(Boolean).join(" + ") || "live Base market momentum";
    lines.push(`${i + 1}. ${label} — ${fmtPct(r.change24h)} / volume ${fmtUsdShort(r.volume24hUsd)} / liquidity ${fmtUsdShort(r.liquidityUsd)}${r.marketCapUsd != null ? ` / market cap ${fmtUsdShort(r.marketCapUsd)}` : ""}`);
    if (pair) lines.push(`   Pair/contract: ${pair}`);
    lines.push(`   Why: ${reasons}.`);
    lines.push("   Risk: liquidity, holder concentration, LP control, and contract safety still need scanner verification.");
  });
  lines.push("");
  lines.push("Want me to scan the top one in Token Scanner?");
  lines.push("CTA: Open Base Radar / Open Token Scanner / Refresh Market Data");
  return lines.join("\n");
}

/**
 * Build the "BASE MARKET READ" reply from live BaseMarketCandidate-shaped rows
 * (e.g. from getBaseMarketUniverse mode "pumping").
 */
export function formatBaseMarketReadFromCandidates(candidates: MarketLikeRow[] | undefined | null): string | null {
  if (!candidates || candidates.length === 0) return null;
  return formatBaseMarketReadFromRows(candidates);
}

// ─────────────────────────────────────────────────────────────────────────
// Base Radar read formatting
// ─────────────────────────────────────────────────────────────────────────

export type RadarLikeItem = {
  symbol?: string | null;
  name?: string | null;
  radarScore?: number | null;
  volume24h?: number | null;
  liquidity?: number | null;
  poolAgeHours?: number | null;
  address?: string | null;
};

export function formatBaseRadarRead(items: RadarLikeItem[] | undefined | null, evidenceGaps?: string[] | null): string | null {
  if (!items || items.length === 0) return null;
  const strongestRadar = [...items].sort((a, b) => (b.radarScore ?? -Infinity) - (a.radarScore ?? -Infinity))[0];
  const highestVolume = [...items].sort((a, b) => (b.volume24h ?? -Infinity) - (a.volume24h ?? -Infinity))[0];
  const newest = [...items]
    .filter((i) => i.poolAgeHours != null)
    .sort((a, b) => (a.poolAgeHours ?? Infinity) - (b.poolAgeHours ?? Infinity))[0];
  const liquidityLeader = [...items].sort((a, b) => (b.liquidity ?? -Infinity) - (a.liquidity ?? -Infinity))[0];
  const gaps = evidenceGaps && evidenceGaps.length > 0
    ? evidenceGaps.join("; ")
    : "LP lock/control, holder concentration, and deployer history are not yet verified for these tokens.";

  return [
    "BASE RADAR READ",
    `- Strongest radar score: ${String(strongestRadar.symbol ?? "?").toUpperCase()}${strongestRadar.radarScore != null ? ` (score ${strongestRadar.radarScore})` : ""}`,
    `- Highest volume radar token: ${String(highestVolume.symbol ?? "?").toUpperCase()} (${fmtUsdShort(highestVolume.volume24h)})`,
    `- Newest pool: ${newest ? `${String(newest.symbol ?? "?").toUpperCase()} (${newest.poolAgeHours?.toFixed(1)}h old)` : "not available in current evidence"}`,
    `- Liquidity leader: ${String(liquidityLeader.symbol ?? "?").toUpperCase()} (${fmtUsdShort(liquidityLeader.liquidity)})`,
    `- Evidence gaps: ${gaps}`,
    "",
    "CTA: Open Base Radar / Scan top token",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Wallet scan result formatting
// ─────────────────────────────────────────────────────────────────────────

export type WalletApiResult = {
  ok: boolean;
  address?: string;
  totalValue?: number | null;
  holdings?: Array<{ symbol?: string; value?: number; chain?: string | null }>;
  chainsActive?: string[] | null;
  txCount?: number | null;
  error?: string | null;
  pnlCoverage?: unknown;
  historicalRecoveryStatus?: unknown;
  openLots?: unknown;
  closedLots?: unknown;
  walletScanHealth?: any;
  walletModuleCoverage?: any;
  walletTokenPnlSummary?: any;
  walletTokenPnlRead?: Array<any>;
  walletTradeStatsSummary?: any;
  walletHistoricalCoverageSummary?: any;
  walletRecoveryRecommendation?: any;
  walletLotSummary?: any;
  dataFreshness?: string | null;
  cacheAgeSeconds?: number | null;
  warnings?: unknown;
};

/**
 * Pick the meaningful top holdings (by USD value, descending), filtering out $0 dust
 * so Clark never lists "mUSDC ($0), APE ($0)..." for a high-value wallet.
 */
export function pickTopHoldingsByValue(
  holdings: Array<{ symbol?: string; value?: number; chain?: string | null }> | undefined | null,
  limit = 5,
): Array<{ symbol?: string; value?: number; chain?: string | null }> {
  const arr = Array.isArray(holdings) ? holdings : [];
  const withValue = arr
    .map((h) => ({ symbol: h.symbol, value: typeof h.value === "number" ? h.value : 0, chain: h.chain ?? null }))
    .filter((h) => Number.isFinite(h.value) && h.value > 0.01)
    .sort((a, b) => b.value - a.value);
  return withValue.slice(0, limit);
}

function describePnlQuality(result: WalletApiResult): { label: string; reason: string } {
  const health = result.walletScanHealth;
  const coverage = result.walletModuleCoverage;
  const tokenPnl = result.walletTokenPnlSummary;
  const histStatus = result.walletHistoricalCoverageSummary?.status
    ?? result.historicalRecoveryStatus
    ?? null;
  const fifoStatus = coverage?.fifoPnL?.status;
  const tradeStatus = coverage?.tradeStats?.status;

  // Provider / cache preview labelling (API/debug truth — task 8)
  const fresh = String(result.dataFreshness ?? "").toLowerCase();
  const cacheAge = typeof result.cacheAgeSeconds === "number" ? result.cacheAgeSeconds : null;
  const isCachedPreview = fresh === "cached" || (cacheAge != null && cacheAge > 0) || health?.status === "cached";

  // Activity module genuinely unavailable?
  const activityStatus = coverage?.activity?.status;

  // PnL attempted but limited — give the honest reason, never "not requested".
  if (fifoStatus === "ok" && (health?.status === "ok" || tradeStatus === "ok")) {
    return { label: "ok", reason: "closed lots / cost basis recovered" };
  }
  if (fifoStatus === "locked_no_closed_lots" || health?.status === "limited_pnl") {
    const reasons: string[] = [];
    if (fifoStatus === "locked_no_closed_lots") reasons.push("no closed lots");
    if (coverage?.fifoPnL?.reason) reasons.push(String(coverage.fifoPnL.reason));
    if (tokenPnl?.reason) reasons.push(String(tokenPnl.reason));
    const why = reasons.length > 0 ? [...new Set(reasons)].join(" / ") : "missing cost basis / no closed lots";
    return { label: "attempted: limited", reason: why };
  }
  if (fifoStatus === "locked_insufficient_trades") {
    return { label: "attempted: limited", reason: "insufficient closed trades for win-rate stats" };
  }
  if (histStatus && String(histStatus) !== "ok") {
    return { label: "attempted: limited", reason: `historical recovery ${String(histStatus)}` };
  }
  if (activityStatus === "open_check" || activityStatus === "provider_unavailable") {
    return { label: "attempted: limited", reason: "activity unavailable" };
  }
  if (isCachedPreview) {
    return { label: "attempted: limited", reason: "cached portfolio preview — not live recovery" };
  }
  // Fallback — still never "not requested" once Clark has actually run a scan
  return { label: "attempted: limited", reason: tokenPnl?.reason ? String(tokenPnl.reason) : "cost basis / closed lots incomplete" };
}

export function formatWalletScanResult(address: string, result: WalletApiResult | null, deep: boolean): string {
  if (!result || !result.ok) {
    const reason = result?.error ? result.error : "the wallet data provider did not return a usable result for this address";
    return [
      "WALLET SCAN — could not complete",
      `- Address: ${address}`,
      `- Reason: ${reason}`,
      "",
      `CTA: ${deep ? "Deep Scan Wallet" : "Scan Wallet"}`,
    ].join("\n");
  }

  const holdings = result.holdings ?? [];
  const topHoldings = pickTopHoldingsByValue(holdings, 5);
  const chains = result.chainsActive && result.chainsActive.length > 0
    ? result.chainsActive.join(", ")
    : "Base";
  const totalValue = result.totalValue != null ? fmtUsdShort(result.totalValue) : "unverified";

  const health = result.walletScanHealth;
  const coverage = result.walletModuleCoverage;
  const tokenReads = Array.isArray(result.walletTokenPnlRead) ? result.walletTokenPnlRead.slice(0, 5) : [];
  const hasHoldingsButLimitedPnl = holdings.length > 0 && health?.status === "limited_pnl";

  const fresh = String(result.dataFreshness ?? "").toLowerCase();
  const cacheAge = typeof result.cacheAgeSeconds === "number" ? result.cacheAgeSeconds : null;
  const isCachedPreview = fresh === "cached" || (cacheAge != null && cacheAge > 0) || health?.status === "cached";

  const lines: string[] = [
    hasHoldingsButLimitedPnl ? "Portfolio found. PnL is limited because closed lots/cost basis are incomplete." : "WALLET READ",
    `- Address: ${address}`,
    `- Active chains: ${chains}`,
    `- Holdings count: ${holdings.length}`,
    `- Total value: ${totalValue}`,
  ];

  // Task 7: top holdings by currentValueUsd descending — never list $0 dust.
  const topHoldingsLabel = topHoldings.length > 0
    ? topHoldings.map((h) => {
        const sym = String(h.symbol ?? "?").toUpperCase();
        const val = fmtUsdShort(h.value);
        const chain = h.chain ? ` [${h.chain}]` : "";
        return `${sym}${chain} (${val})`;
      }).join(", ")
    : "none returned with value";
  lines.push(`- Top holdings (by value): ${topHoldingsLabel}`);

  if (isCachedPreview) {
    lines.push("- Data freshness: cached portfolio preview — not deep scan, not live recovery");
  } else {
    lines.push(`- Data freshness: ${fresh === "live" ? "live" : "live"}`);
  }
  if (health) lines.push(`- walletScanHealth: ${health.status ?? "unknown"}${health.summary ? ` — ${health.summary}` : ""}`);
  if (coverage) lines.push(`- walletModuleCoverage: portfolio=${coverage.portfolio?.status ?? "unknown"}; activity=${coverage.activity?.status ?? "unknown"}; pnl=${coverage.fifoPnL?.status ?? "unknown"}; tradeStats=${coverage.tradeStats?.status ?? "unknown"}`);
  lines.push(`- Open lots / closed lots: ${String(result.openLots ?? "unverified")} / ${String(result.closedLots ?? "unverified")}`);

  // Task 2: never show "PnL coverage: not requested" after a wallet scan involving PnL/deep scan.
  const pnlQ = describePnlQuality(result);
  lines.push(`- PnL ${pnlQ.label}`);
  lines.push(`- PnL reason: ${pnlQ.reason}`);
  lines.push(`- Historical recovery status: ${String(result.walletHistoricalCoverageSummary?.status ?? result.historicalRecoveryStatus ?? (deep ? "open check" : "portfolio preview"))}`);
  if (result.walletTokenPnlSummary) lines.push(`- walletTokenPnlSummary: ${String(result.walletTokenPnlSummary.status ?? result.walletTokenPnlSummary.reason ?? JSON.stringify(result.walletTokenPnlSummary))}`);
  if (result.walletTradeStatsSummary) lines.push(`- walletTradeStatsSummary: ${String(result.walletTradeStatsSummary.status ?? JSON.stringify(result.walletTradeStatsSummary))}`);
  if (tokenReads.length > 0) lines.push(`- Token-level read: ${tokenReads.map((t) => `${t.symbol ?? "?"}:${t.status ?? t.pnlStatus ?? "read"}`).join(", ")}`);

  // Task 8: surface provider unavailability honestly instead of generic "locked modules".
  if (health?.lockedModules?.length) {
    const activityDown = coverage?.activity?.status === "open_check" || coverage?.activity?.status === "provider_unavailable";
    const swapDown = coverage?.swapDetection?.status === "open_check";
    const priceDown = coverage?.priceEvidence?.status === "open_check";
    const labels: string[] = [];
    for (const m of health.lockedModules) {
      if (m === "activity" && activityDown) labels.push("activity unavailable");
      else if (m === "swapDetection" && swapDown) labels.push("swap detection unavailable");
      else if (m === "priceEvidence" && priceDown) labels.push("price evidence unavailable");
      else if (m === "fifoPnL") labels.push("fifoPnL: no closed lots yet");
      else if (m === "tradeStats") labels.push("tradeStats: needs more closed trades");
      else labels.push(`${m} pending`);
    }
    lines.push(`- Module status: ${labels.join(" / ")}`);
  }
  if (deep) {
    lines.push(`- Activity status: ${result.txCount != null ? `${result.txCount} transactions in scanned window` : "activity history not available in this pass"}`);
  } else {
    lines.push(`- Activity status: portfolio preview (use deep scan for full activity history)`);
  }
  if (result.warnings) lines.push(`- Warnings/limits: ${String(result.warnings)}`);
  lines.push(`- Evidence gaps: ${holdings.length === 0 ? "no priced holdings returned" : "closed/open lot attribution and historical recovery may be partial"}`);
  lines.push("");
  lines.push(`CTA: Open Wallet Scanner${deep ? "" : " / Deep Scan Wallet"}`);
  return lines.join("\n");
}

/**
 * Build an honest "unsupported compare" reply that names both wallet addresses
 * (or the last wallet + the typed one) and never silently scans only one.
 */
export function formatWalletCompareUnsupported(opts: {
  addressA: string | null;
  addressB: string | null;
  walletScannerDeepLink: (address: string, deep: boolean) => string;
}): string {
  const a = opts.addressA?.toLowerCase() ?? null;
  const b = opts.addressB?.toLowerCase() ?? null;
  const both = [a, b].filter((x): x is string => !!x);
  const uniq = Array.from(new Set(both));
  const lines = ["WALLET COMPARE — not fully wired yet"];
  if (uniq.length >= 2) {
    lines.push(`- Wallet A: ${uniq[0]}`);
    lines.push(`- Wallet B: ${uniq[1]}`);
  } else if (uniq.length === 1) {
    lines.push(`- Wallet found: ${uniq[0]}`);
    lines.push("- I need a second wallet address to compare against.");
  } else {
    lines.push("- I need two wallet addresses to compare.");
  }
  lines.push("- Side-by-side comparison is not fully wired yet. I scanned neither wallet so I don't present a one-sided answer as a comparison.");
  const links = uniq.map((x) => `Open Wallet Scanner for ${x}: ${opts.walletScannerDeepLink(x, true)}`);
  lines.push(...links);
  lines.push("");
  lines.push("CTA: Scan Wallet (each address separately) / Deep Scan Wallet");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// LP / liquidity check
// ─────────────────────────────────────────────────────────────────────────

export function formatEoaLpCheckReply(): string {
  return [
    "That address looks like a wallet, not a token contract. LP checks need a token contract.",
    "",
    "CTA: Scan Wallet / Deep Scan Wallet",
  ].join("\n");
}

export type LpCheckResult = {
  token?: { name?: string | null; symbol?: string | null } | null;
  primaryPool?: string | null;
  poolModel?: string | null;
  poolType?: string | null;
  lpProofStatus?: string | null;
  lpProofApplicability?: string | null;
  lockStatus?: string | null;
  burnStatus?: string | null;
  controllerStatus?: string | null;
  positionVerificationStatus?: string | null;
  secondaryLpExposure?: unknown;
  lockBurnProof?: string | null;
  controllerVerification?: string | null;
  liquidityDepth?: string | null;
  exitRisk?: string | null;
  missingEvidence?: string[] | null;
  nextAction?: string | null;
};

export function formatLpReadResult(result: LpCheckResult | null): string {
  if (!result) {
    return [
      "LP READ — could not complete",
      "- Reason: liquidity pipeline did not return a usable result for this contract.",
      "",
      "CTA: Open Liquidity Safety / Open Token Scanner",
    ].join("\n");
  }
  const name = result.token?.name ?? "Unknown";
  const symbol = result.token?.symbol ?? "?";
  return [
    "LP READ",
    `- Token: ${name} (${symbol})`,
    `- Primary pool / pool id: ${result.primaryPool ?? "not available"}`,
    `- Pool model: ${result.poolType ?? "unknown"} / ${result.poolModel ?? "not verified"}`,
    `- Lock/burn proof: ${result.lpProofStatus ?? result.lockBurnProof ?? "not verified"} / applicability: ${result.lpProofApplicability ?? "unknown"}`,
    `- Locked/burned/controller status: ${result.lockStatus ?? "not verified"} / ${result.burnStatus ?? "not verified"} / ${result.controllerStatus ?? "not verified"}`,
    `- Controller/position verification: ${result.positionVerificationStatus ?? result.controllerVerification ?? "not verified"}`,
    `- Secondary LP exposure: ${String(result.secondaryLpExposure ?? "unverified")}`,
    `- Liquidity depth: ${result.liquidityDepth ?? "unverified"}`,
    `- Exit risk: ${result.exitRisk ?? "unverified"}`,
    `- Missing evidence: ${result.missingEvidence && result.missingEvidence.length > 0 ? result.missingEvidence.join("; ") : "none flagged"}`,
    "",
    "CTA: Open Liquidity Safety / Open Token Scanner",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Structured "could not complete" response — replaces CLARK_EMPTY_FALLBACK
// ─────────────────────────────────────────────────────────────────────────

export type CouldNotCompleteInput = {
  intentBadge: string;
  attempted: string[];
  reason: string;
  actions: ClarkAction[];
};

export function formatCouldNotComplete(input: CouldNotCompleteInput): string {
  return [
    "COULD NOT COMPLETE",
    `- Interpreted as: ${input.intentBadge}`,
    `- Data sources attempted: ${input.attempted.length > 0 ? input.attempted.join(", ") : "none"}`,
    `- Reason: ${input.reason}`,
    "",
    `CTA: ${input.actions.join(" / ")}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Response shape helper — intentBadge + actions
// ─────────────────────────────────────────────────────────────────────────

export function buildRoutedActions(actions: ClarkAction[]): ClarkAction[] {
  const seen = new Set<string>();
  const out: ClarkAction[] = [];
  for (const a of actions) {
    if (CLARK_ACTIONS.includes(a) && !seen.has(a)) {
      seen.add(a);
      out.push(a);
    }
  }
  return out.length > 0 ? out : ["Refresh Market Data"];
}

// ─────────────────────────────────────────────────────────────────────────
// Pack 1: Token Core Pipeline formatting helpers
// ─────────────────────────────────────────────────────────────────────────

export type TokenScanEvidence = {
  token?: { name?: string | null; symbol?: string | null; address?: string | null } | null;
  chain?: string | null;
  market?: {
    price?: number | null;
    change24h?: number | null;
    volume24h?: number | null;
    liquidity?: number | null;
    marketCap?: number | null;
  } | null;
  holders?: {
    top1?: number | null;
    top10?: number | null;
    holderCount?: number | null;
    status?: string | null;
  } | null;
  security?: {
    honeypot?: boolean | null;
    buyTax?: number | null;
    sellTax?: number | null;
    ownerRenounced?: boolean | null;
    mintable?: boolean | null;
    proxy?: boolean | null;
    securityStatus?: string | null;
    riskLevel?: string | null;
    missing?: string[] | null;
  } | null;
  lpControl?: {
    status?: string | null;
    reason?: string | null;
    confidence?: string | null;
    poolType?: string | null;
    proofApplicability?: string | null;
    displayLpModel?: string | null;
    lockStatus?: string | null;
    burnStatus?: string | null;
    proofStatus?: string | null;
  } | null;
  liquidity?: { pools?: number; topPoolLiquidity?: number | null } | null;
  warnings?: string[];
  ok?: boolean;
};

// Returns true only if at least one useful evidence section is present —
// token identity, market data, holders, LP control, security/honeypot, or
// contract flags. False when every major section is missing (e.g. all
// branches timed out / were unavailable), so callers can avoid charging
// quota for a read that gave the user nothing usable.
export function hasUsableTokenEvidence(ev: TokenScanEvidence | null | undefined): boolean {
  if (!ev) return false;
  const hasTokenIdentity = Boolean(ev.token?.symbol && ev.token.symbol !== "?") || Boolean(ev.token?.name && ev.token.name !== "Unknown");
  const hasMarket = ev.market != null && (ev.market.price != null || ev.market.liquidity != null || ev.market.volume24h != null || ev.market.marketCap != null);
  const hasHolders = ev.holders != null && (ev.holders.top1 != null || ev.holders.top10 != null || ev.holders.holderCount != null);
  const hasLp = ev.lpControl != null && typeof ev.lpControl.status === "string" && ev.lpControl.status !== "open_check" && ev.lpControl.status !== "unverified";
  const hasSecurity = ev.security != null && (ev.security.honeypot != null || ev.security.buyTax != null || ev.security.sellTax != null);
  const hasContractFlags = ev.security != null && (ev.security.ownerRenounced != null || ev.security.mintable != null || ev.security.proxy != null);
  return hasTokenIdentity || hasMarket || hasHolders || hasLp || hasSecurity || hasContractFlags;
}

// True only when at least one *safety-relevant* section is actually confirmed
// (honeypot, taxes, LP status, holder concentration, ownership, or contract flags) —
// market/liquidity/volume alone is not enough to call evidence "safety evidence".
// NOTE: kept for backward compatibility with other callers; safety-escalation decisions
// must use hasNonTaxCoreSafetyEvidence/needsSafetyEscalation below instead, since tax
// data alone is not sufficient to answer a safety follow-up.
export function hasCoreSafetyEvidence(ev: TokenScanEvidence | null | undefined): boolean {
  return hasTaxEvidence(ev) || hasNonTaxCoreSafetyEvidence(ev);
}

// True only when buy/sell tax is confirmed. Tax data alone is never enough to answer
// "is it safe" — it says nothing about honeypot, LP control, holders, or ownership.
export function hasTaxEvidence(ev: TokenScanEvidence | null | undefined): boolean {
  if (!ev) return false;
  const sec = ev.security;
  return sec?.buyTax != null || sec?.sellTax != null;
}

// True only when a real (non-tax) safety section is confirmed: honeypot, a meaningful LP
// status (not fast-mode's hardcoded open_check/unverified), holder concentration, ownership
// renouncement, or mint/proxy contract flags.
export function hasNonTaxCoreSafetyEvidence(ev: TokenScanEvidence | null | undefined): boolean {
  if (!ev) return false;
  const sec = ev.security;
  const lp = ev.lpControl;
  const h = ev.holders;
  const hasHoneypotConfirmed = sec?.honeypot != null;
  const hasLpConfirmed = lp != null && typeof lp.status === "string" && lp.status.length > 0 && lp.status !== "open_check" && lp.status !== "unverified";
  const hasHolderConfirmed = h?.top1 != null || h?.top10 != null || h?.holderCount != null;
  const hasOwnershipConfirmed = sec?.ownerRenounced != null;
  const hasFlagsConfirmed = sec?.mintable != null || sec?.proxy != null;
  return hasHoneypotConfirmed || hasLpConfirmed || hasHolderConfirmed || hasOwnershipConfirmed || hasFlagsConfirmed;
}

// A safety-relevant follow-up (is it safe / can dev rug / is LP locked / why high risk) needs
// a deeper fetch whenever the cached evidence has no real safety section yet — even if it has
// market data and confirmed tax, since tax alone cannot answer any of those questions.
export function needsSafetyEscalation(ev: TokenScanEvidence | null | undefined): boolean {
  return !hasNonTaxCoreSafetyEvidence(ev);
}

function fmtTaxPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "open check";
  return `${n.toFixed(1)}%`;
}

function holderLine(h: TokenScanEvidence["holders"]): string {
  if (!h) return "holder data: open check";
  const parts: string[] = [];
  if (h.holderCount != null) parts.push(`${h.holderCount.toLocaleString()} holders`);
  if (h.top1 != null) parts.push(`top-1 holds ${h.top1.toFixed(1)}%`);
  if (h.top10 != null) parts.push(`top-10 holds ${h.top10.toFixed(1)}%`);
  return parts.length > 0 ? parts.join(" / ") : "holder data: open check";
}

function lpStatusLine(ev: TokenScanEvidence): string {
  const lp = ev.lpControl;
  if (!lp) return "LP proof: Open Check — no LP control data returned";
  const poolType = lp.poolType ?? lp.displayLpModel ?? "";
  const concentrated =
    poolType.includes("concentrated") || poolType.includes("clmm") || poolType.includes("infinity") ||
    lp.proofApplicability === "not_applicable" || lp.displayLpModel === "concentrated_liquidity" || lp.displayLpModel === "no_pool";
  const status = lp.status ?? "unverified";
  const reason = lp.reason ?? null;
  if (concentrated) return `LP proof: Open Check — concentrated pool LP proof not applicable${reason ? ` (${reason})` : ""}`;
  if (status === "locked" || lp.lockStatus === "locked") return `LP proof: Locked/Burned — confirmed by LP proof${reason ? ` (${reason})` : ""}`;
  if (status === "burned" || lp.burnStatus === "burned") return `LP proof: Locked/Burned — confirmed by LP proof${reason ? ` (${reason})` : ""}`;
  if (status === "team_controlled" || status === "wallet_controlled") return `LP proof: Team Controlled — LP tokens appear wallet-controlled${reason ? ` (${reason})` : ""}`;
  if (status === "partial") return `LP proof: Partial — ${reason ?? "secondary LP exposure found but primary LP proof not fully confirmed."}`;
  if (status === "open_check" || status === "unverified") return `LP proof: Open Check — ${reason ?? "not confirmed"}`;
  return `LP proof: ${status}${reason ? ` — ${reason}` : ""}`;
}

function verdictLabel(ev: TokenScanEvidence): string {
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;
  if (sec?.honeypot === true) return "Avoid";
  if (sec?.riskLevel === "high") return "High Risk";
  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") return "Caution";
  if (sec?.mintable === true && sec?.ownerRenounced === false) return "Caution";
  if (h?.top10 != null && h.top10 > 80) return "Caution";
  if (sec?.honeypot === false && sec?.ownerRenounced === true && (lp?.status === "locked" || lp?.status === "burned")) return "Cleaner";
  return "Open Check";
}

// Public, structured verdict for the JSON response (data.verdict/data.confidence/data.source).
// Must stay in sync with the human-readable "Verdict:" line produced by verdictLabel() above —
// both read the same TokenScanEvidence fields, so they can never disagree.
export function tokenScanVerdictMeta(ev: TokenScanEvidence, usableEvidence: boolean): {
  verdict: string;
  confidence: "full" | "partial" | "none";
  source: "token_core" | "fallback";
} {
  const label = verdictLabel(ev);
  const confidence: "full" | "partial" | "none" = ev.ok ? "full" : usableEvidence ? "partial" : "none";
  const verdict = !usableEvidence
    ? "Open Check"
    : label === "Open Check"
      ? "Open Check / Caution based on available evidence"
      : label;
  return {
    verdict,
    confidence,
    source: usableEvidence ? "token_core" : "fallback",
  };
}

// Distinguishes "honeypot specifically wasn't returned" from "the whole security check
// failed" — tax data alone never implies a honeypot result, and a missing honeypot result
// never implies tax data is also missing. Never fakes a honeypot verdict from tax data alone.
function securityStatusLine(sec: NonNullable<TokenScanEvidence["security"]>): string {
  if (sec.honeypot === false) return "Honeypot not detected";
  if (sec.honeypot === true) return "Honeypot detected";
  if (sec.buyTax != null || sec.sellTax != null) return "Tax data returned, honeypot simulation unavailable";
  const reason = sec.securityStatus && sec.securityStatus !== "unverified" && sec.securityStatus !== "unknown"
    ? sec.securityStatus
    : "security simulation not returned";
  return `Open Check — ${reason}`;
}

export function formatTokenScanResult(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const name = ev.token?.name ?? sym;
  const addr = ev.token?.address ?? null;
  const sec = ev.security;
  const h = ev.holders;
  const mkt = ev.market;

  const lines: string[] = [
    `TOKEN READ — ${sym}`,
    `- Chain: ${chain}`,
  ];
  if (addr) lines.push(`- Address: ${addr}`);
  if (name !== sym) lines.push(`- Name: ${name}`);
  if (mkt?.liquidity != null) lines.push(`- Liquidity: ${fmtUsdShort(mkt.liquidity)}`);
  if (mkt?.volume24h != null) lines.push(`- 24h volume: ${fmtUsdShort(mkt.volume24h)}`);
  if (mkt?.change24h != null) lines.push(`- 24h change: ${fmtPct(mkt.change24h)}`);

  // LP status
  lines.push(`- ${lpStatusLine(ev)}`);

  // Holders
  lines.push(`- Holders: ${holderLine(h)}`);

  // Security
  if (sec) {
    lines.push(`- Security: ${securityStatusLine(sec)}`);
    if (sec.buyTax != null || sec.sellTax != null) lines.push(`- Buy tax: ${fmtTaxPct(sec.buyTax)} / Sell tax: ${fmtTaxPct(sec.sellTax)}`);
    if (sec.mintable != null) lines.push(`- Mintable: ${sec.mintable ? "YES" : "no"}`);
    if (sec.ownerRenounced != null) lines.push(`- Ownership: ${sec.ownerRenounced ? "renounced" : "active owner"}`);
    if (sec.proxy != null) lines.push(`- Proxy: ${sec.proxy ? "YES" : "no"}`);
  }

  const { verdict } = tokenScanVerdictMeta(ev, hasUsableTokenEvidence(ev));
  lines.push(`- Verdict: ${verdict}`);

  // Filter raw field-name tokens (e.g. "honeypot", "buyTax") out of the warnings dump —
  // only surface real sentences, since those tokens are already covered by the
  // precise Security/Open-Check lines above.
  const sentenceWarnings = (ev.warnings ?? []).filter(w => /\s/.test(w));
  if (sentenceWarnings.length > 0) lines.push(`- Note: ${sentenceWarnings.join("; ")}`);

  lines.push("");
  lines.push(`Next: Ask "is it safe", "can dev rug", "explain LP", or "why high risk"`);
  lines.push("CTA: Open Token Scanner / Run LP Check");
  return lines.join("\n");
}

// Clark fast-mode reply: used when /api/token was called with mode "clark_fast"
// and returned market/pool identity but skipped the slow holders/deep-LP/dev
// enrichment sections. Those sections are reported as Open Check, never as fake
// safe/verified values.
export function formatFastTokenRead(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const name = ev.token?.name ?? null;
  const mkt = ev.market;
  const sec = ev.security;
  const hasMarket = mkt != null && (mkt.price != null || mkt.liquidity != null || mkt.volume24h != null);
  const hasFastSecurity = sec != null && (sec.honeypot != null || sec.buyTax != null || sec.sellTax != null);

  const lines: string[] = [`TOKEN READ — fast evidence`];
  lines.push(`- Token: ${name && name !== sym ? `${name} / ${sym}` : sym}`);
  lines.push(`- Chain: ${chain}`);

  if (hasMarket) {
    const parts: string[] = [];
    if (mkt?.price != null) parts.push(`price ${fmtUsdShort(mkt.price)}`);
    if (mkt?.liquidity != null) parts.push(`liquidity ${fmtUsdShort(mkt.liquidity)}`);
    if (mkt?.volume24h != null) parts.push(`24h volume ${fmtUsdShort(mkt.volume24h)}`);
    lines.push(`- Market: ${parts.join(", ")}`);
  } else {
    lines.push(`- Market: unavailable / Open Check`);
  }

  lines.push(`- LP: Open Check — full LP proof not run in Clark fast read`);
  lines.push(`- Holders: Open Check — holder scan not run in Clark fast read`);

  if (hasFastSecurity) {
    lines.push(`- Security: ${sec?.honeypot === true ? "HONEYPOT flagged" : sec?.honeypot === false ? "no honeypot signal" : "available fast flags"}${sec?.buyTax != null ? ` (buy tax ${fmtTaxPct(sec.buyTax)}, sell tax ${fmtTaxPct(sec.sellTax)})` : ""}`);
  } else {
    lines.push(`- Security: Open Check / available fast flags`);
  }

  const verdictKnown = sec?.honeypot === true;
  lines.push(`- Verdict: ${verdictKnown ? "Avoid — honeypot detected" : "Open Check unless enough evidence exists"}`);

  lines.push(`- Missing evidence: holders, LP proof, dev-risk require full Token Scanner scan`);
  lines.push("CTA: Open Token Scanner / Run LP Check");
  return lines.join("\n");
}

export function formatTokenSafetyAnswer(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;
  const mkt = ev.market;
  const verdict = tokenScanVerdictMeta(ev, hasUsableTokenEvidence(ev)).verdict;

  // Confirmed facts (good or neutral) vs. confirmed bad evidence vs. evidence that
  // simply was not returned. Missing evidence is never listed as a "signal" — it
  // belongs under Open checks, not under anything that reads as reassuring.
  const visible: string[] = [];
  const risks: string[] = [];
  const openChecks: string[] = [];
  const openTopics: string[] = [];

  if (mkt?.liquidity != null || mkt?.volume24h != null) {
    const parts: string[] = [];
    if (mkt.liquidity != null) parts.push(`liquidity ${fmtUsdShort(mkt.liquidity)}`);
    if (mkt.volume24h != null) parts.push(`volume ${fmtUsdShort(mkt.volume24h)}`);
    visible.push(`Market: ${parts.join(" and ")} available.`);
  }
  if (sec?.buyTax != null || sec?.sellTax != null) {
    visible.push(`Taxes: buy tax ${fmtTaxPct(sec?.buyTax)} / sell tax ${fmtTaxPct(sec?.sellTax)}.`);
  }

  if (sec?.honeypot === true) {
    risks.push("Honeypot flag detected — buy/sell simulation failed.");
  } else if (sec?.honeypot === false) {
    visible.push("Honeypot: no signal found from available checks.");
  } else if (sec?.buyTax != null || sec?.sellTax != null) {
    openChecks.push("Honeypot: tax data returned, honeypot simulation unavailable.");
    openTopics.push("honeypot");
  } else {
    openChecks.push("Honeypot/security: simulation not returned.");
    openTopics.push("honeypot/security");
  }

  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") {
    risks.push("LP wallet/team controlled — liquidity can be pulled.");
  } else if (lp && lp.status && lp.status !== "open_check" && lp.status !== "unverified") {
    visible.push(`${lpStatusLine(ev)}.`);
  } else {
    openChecks.push("LP proof: not confirmed.");
    openTopics.push("LP control");
  }

  if (h?.top10 != null) {
    if (h.top10 > 80) risks.push(`Top-10 holders control ${h.top10.toFixed(1)}% of supply — high concentration.`);
    else visible.push(`Holders: top-10 at ${h.top10.toFixed(1)}%.`);
  } else {
    openChecks.push("Holders: holder concentration not confirmed.");
    openTopics.push("holder concentration");
  }

  if (sec?.mintable === true && sec?.ownerRenounced === false) {
    risks.push("Owner can mint new tokens — supply risk.");
  } else if (sec?.ownerRenounced === true) {
    visible.push("Ownership: renounced.");
  } else {
    openChecks.push("Ownership/dev control: status not confirmed.");
    openTopics.push("dev control");
  }

  const safeLine =
    sec?.honeypot === true ? "Safe? No — honeypot detected."
    : risks.length > 0 ? "Safe? Not safe to assume — risk signals present."
    : openChecks.length > 0 ? "Safe? Not enough confirmed evidence to call it safe."
    : "Safe? No confirmed red flags from available checks — always verify before buying.";

  const lines = [`TOKEN SAFETY — ${sym} (${chain})`, "", `Verdict: ${verdict}`, safeLine];

  if (visible.length > 0) {
    lines.push("", "Visible evidence:");
    visible.forEach(v => lines.push(`- ${v}`));
  }
  if (risks.length > 0) {
    lines.push("", "Risk signals:");
    risks.forEach(r => lines.push(`- ${r}`));
  }
  if (openChecks.length > 0) {
    lines.push("", "Open checks:");
    openChecks.forEach(o => lines.push(`- ${o}`));
  }

  lines.push("", "Read:");
  if (openTopics.length > 0) {
    lines.push(`Clark can't mark this as safe until ${openTopics.join(", ")} ${openTopics.length > 1 ? "are" : "is"} confirmed.`);
  } else if (risks.length > 0) {
    lines.push("Confirmed risk signals are present — this is not a safe call.");
  } else {
    lines.push("No confirmed red flags from available checks. This is evidence-based routing, not financial advice.");
  }

  lines.push("", "CTA: Open Token Scanner / Run LP Check");
  return lines.join("\n");
}


export function formatDevRugCheck(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;

  const lines = [`DEV/RUG CHECK — ${sym} (${chain})`, ""];

  if (sec?.ownerRenounced != null) lines.push(`- Ownership: ${sec.ownerRenounced ? "renounced — owner cannot call privileged functions" : "NOT renounced — active owner present"}`);
  else lines.push("- Ownership: open check — renounce status not confirmed");

  if (sec?.mintable != null) lines.push(`- Mint authority: ${sec.mintable ? "YES — new tokens can be minted" : "no mint authority detected"}`);
  else lines.push("- Mint authority: open check");

  if (sec?.proxy != null) lines.push(`- Proxy/upgradeable: ${sec.proxy ? "YES — contract logic can be replaced" : "no proxy detected"}`);
  else lines.push("- Proxy/upgradeable: open check");

  if (lp) {
    const controlled = lp.status === "wallet_controlled" || lp.status === "team_controlled";
    lines.push(`- LP control: ${controlled ? "wallet/team controlled — dev can pull liquidity" : (lp.status === "locked" || lp.status === "burned" ? "locked/burned — pull risk reduced" : `open check (${lp.status ?? "unverified"})`)}`);
  } else {
    lines.push("- LP control: open check — not verified");
  }

  if (h?.top1 != null) lines.push(`- Top-1 holder: ${h.top1.toFixed(1)}% of supply`);
  else lines.push("- Top-1 holder: open check");

  if (h?.top10 != null) lines.push(`- Top-10 holders: ${h.top10.toFixed(1)}% of supply${h.top10 > 50 ? " — high concentration" : ""}`);

  const missingChecks: string[] = [];
  if (sec?.ownerRenounced == null) missingChecks.push("ownership status");
  if (sec?.mintable == null) missingChecks.push("mint authority");
  if (!lp) missingChecks.push("LP controller identity");
  if (missingChecks.length > 0) lines.push("", `- Missing evidence: ${missingChecks.join(", ")}`);

  lines.push("", "CTA: Open Token Scanner / Run LP Check");
  return lines.join("\n");
}

export function formatLpLockCheck(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const lp = ev.lpControl;
  const mkt = ev.market;

  const lead = (() => {
    if (!lp) return "LP proof not confirmed";
    const pt = lp.poolType ?? "";
    const concentrated = pt.includes("concentrated") || pt.includes("clmm") || pt.includes("infinity");
    if (concentrated) return "Concentrated liquidity / protocol pool — ERC-20 LP lock may not apply";
    const s = lp.status ?? "unverified";
    if (s === "locked") return "LP lock/burn proof confirmed";
    if (s === "burned") return "LP lock/burn proof confirmed — burned";
    if (s === "wallet_controlled" || s === "team_controlled") return "LP appears wallet/team controlled";
    return "LP proof not confirmed";
  })();

  const lines = [
    `LP CHECK — ${sym} (${chain})`,
    `Status: ${lead}`,
    "",
  ];

  if (mkt?.liquidity != null) lines.push(`- Liquidity depth: ${fmtUsdShort(mkt.liquidity)} (not the same as lock safety)`);
  else lines.push("- Liquidity depth: open check");

  if (lp?.reason) lines.push(`- Lock/burn detail: ${lp.reason}`);
  if (lp?.confidence) lines.push(`- Confidence: ${lp.confidence}`);

  const missing: string[] = [];
  if (!lp || lp.status === "unverified") missing.push("LP lock/burn proof");
  if (!lp?.reason) missing.push("controller/holder identity");
  if (missing.length > 0) lines.push(`- Missing: ${missing.join(", ")}`);

  lines.push("", "CTA: Run LP Check / Open Token Scanner");
  return lines.join("\n");
}

export function formatRiskExplanation(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;
  const mkt = ev.market;

  const signals: string[] = [];
  const missing: string[] = [];

  if (sec?.honeypot === true) signals.push("Honeypot flag: buy/sell simulation detected a trap");
  if (sec?.mintable === true && sec?.ownerRenounced === false) signals.push("Mint risk: owner can issue new tokens");
  if (sec?.proxy === true) signals.push("Proxy contract: logic can be upgraded by deployer");
  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") signals.push("LP wallet-controlled: liquidity can be pulled");
  if (h?.top10 != null && h.top10 > 70) signals.push(`Concentration risk: top-10 hold ${h.top10.toFixed(1)}% of supply`);
  if (h?.top1 != null && h.top1 > 20) signals.push(`Single-wallet dominance: top-1 holds ${h.top1.toFixed(1)}%`);
  if (mkt?.liquidity != null && mkt.liquidity < 10_000) signals.push(`Thin liquidity: ${fmtUsdShort(mkt.liquidity)} — price impact is high`);
  if (sec?.buyTax != null && sec.buyTax > 10) signals.push(`High buy tax: ${sec.buyTax.toFixed(1)}%`);
  if (sec?.sellTax != null && sec.sellTax > 10) signals.push(`High sell tax: ${sec.sellTax.toFixed(1)}%`);

  if (!sec || sec.honeypot == null) missing.push("honeypot simulation");
  if (!lp) missing.push("LP lock/burn proof");
  if (!h?.top10) missing.push("holder concentration");
  if (sec?.ownerRenounced == null) missing.push("ownership/mint status");

  const lines = [
    `RISK SIGNALS — ${sym} (${chain})`,
    "",
    signals.length > 0 ? "Risk signals found:" : "No deterministic risk signals confirmed from available data.",
    ...signals.map((s, i) => `${i + 1}. ${s}`),
  ];
  if (missing.length > 0) {
    lines.push("", "Evidence not yet checked:");
    missing.forEach(m => lines.push(`- ${m}`));
  }
  lines.push("", "Note: These are risk signals, not a precise score. Missing evidence means open check, not safe.");
  lines.push("", "CTA: Open Token Scanner / Run LP Check");
  return lines.join("\n");
}

export function formatNoTokenInMemory(): string {
  return [
    "I need a token to check.",
    "Paste the contract address, or tell me the token name/symbol and chain.",
    "",
    "CTA: Open Token Scanner",
  ].join("\n");
}
