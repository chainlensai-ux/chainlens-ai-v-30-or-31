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

const TOKEN_SCAN_RE = /\b(scan\s+this\s+(?:(?:eth|ethereum|base|bnb|bsc|polygon)\s+)?token|token\s+scan|scan\s+token|what\s+is\s+this\s+token|tell\s+me\s+about\s+(?:this\s+)?token|check\s+this\s+token|analyze\s+(?:this\s+)?token|token\s+check|run\s+token\s+scan)\b/i;
const TOKEN_SCAN_ON_CHAIN_RE = /\bscan\b.{0,80}\bon\s+(?:base|eth|ethereum|bnb|bsc|polygon)\b|\bon\s+(?:base|eth|ethereum|bnb|bsc|polygon)\b.{0,80}\bscan\b/i;

// Chain keywords explicitly named in a Clark prompt. Order doesn't matter — the
// keyword sets are disjoint. Returns the app's canonical SupportedChain value, or
// null when no chain is explicitly named (caller falls back to UI/memory/default).
export type ClarkPromptChain = "base" | "ethereum" | "polygon" | "bnb";
const ETH_CHAIN_WORD_RE = /\b(eth|ethereum|erc-?20|mainnet)\b/i;
const BNB_CHAIN_WORD_RE = /\b(bnb|bsc|binance(?:[-\s]smart(?:[-\s]chain)?)?)\b/i;
const POLYGON_CHAIN_WORD_RE = /\b(polygon|matic)\b/i;
const BASE_CHAIN_WORD_RE = /\bbase\b/i;

export function extractRequestedChainFromPrompt(prompt: string): ClarkPromptChain | null {
  const t = String(prompt ?? "");
  if (ETH_CHAIN_WORD_RE.test(t)) return "ethereum";
  if (BNB_CHAIN_WORD_RE.test(t)) return "bnb";
  if (POLYGON_CHAIN_WORD_RE.test(t)) return "polygon";
  if (BASE_CHAIN_WORD_RE.test(t)) return "base";
  return null;
}
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

export type WalletFollowupKind =
  | "wallet_quality"
  | "wallet_profitability"
  | "wallet_pnl_explanation"
  | "wallet_holdings"
  | "wallet_chains"
  | "wallet_deep_scan_advice"
  | "wallet_evidence_gaps"
  | "wallet_risk"
  | "wallet_profile"
  | "wallet_summary";

// Only genuine imperative re-scan commands skip the followup-memory path — questions about
// deep scan ("should I deep scan", "deep scan?") are handled below as advice from memory, not
// as a trigger to actually re-run the wallet scanner.
const WALLET_REFRESH_RE = /\b(refresh|rescan|run\s+full\s+scan|scan\s+again|run\s+deep\s+scan(?:\s+now)?|do\s+a\s+deep\s+scan(?:\s+now)?)\b/i;
const WALLET_FOLLOWUP_CORE_RE = /\b(is\s+this\s+wallet\s+good|is\s+this\s+wallet\s+profitable|why\s+no\s+pnl|why\s+is\s+pnl\s+missing|explain\s+pnl|top\s+holdings?|what\s+are\s+the\s+top\s+holdings?|what\s+chains\s+is\s+it\s+active\s+on|active\s+chains?|should\s+i\s+deep\s+scan|what\s+evidence\s+is\s+missing|what\s+is\s+missing|is\s+this\s+wallet\s+risky|summarize\s+this\s+wallet|wallet\s+summary|wallet\s+risk|wallet\s+quality|wallet\s+profitability|what\s+type\s+of\s+trader|wallet\s+profile|should\s+i\s+follow|why\s+this\s+score|why\s+smart\s+money|why\s+not\s+smart\s+money|smart\s+money)\b/i;
// A bare "deep scan" / "deep scan?" with nothing else (no address, no "this wallet ...") is a
// question asking for advice, not a command — must not be confused with "deep scan this wallet 0x...".
const WALLET_DEEP_SCAN_QUESTION_RE = /^deep\s+scan\??$/i;

export function isWalletFollowupPrompt(prompt: string): boolean {
  const t = String(prompt ?? "").trim();
  if (!t) return false;
  if (WALLET_DEEP_SCAN_QUESTION_RE.test(t)) return true;
  if (WALLET_REFRESH_RE.test(t)) return false;
  if (/\b(token|coin|contract|ticker|\bca\b|lp|liquidity|dev\s+(?:rug|wallet)|honeypot|buy\s+tax|sell\s+tax)\b/i.test(t)) return false;
  return WALLET_FOLLOWUP_CORE_RE.test(t) || WALLET_FOLLOWUP_RE.test(t);
}

export function classifyWalletFollowupKind(prompt: string): WalletFollowupKind {
  const t = String(prompt ?? "").toLowerCase();
  if (/why\s+no\s+pnl|why\s+is\s+pnl\s+missing|explain\s+pnl|pnl\s+(?:missing|coverage|reason)/.test(t)) return "wallet_pnl_explanation";
  if (/profitable|profitability|profit\b/.test(t)) return "wallet_profitability";
  if (/top\s+holdings?|holdings?/.test(t)) return "wallet_holdings";
  if (/chains?.*active|active\s+on|active\s+chains?/.test(t)) return "wallet_chains";
  if (/deep\s+scan|full\s+scan/.test(t)) return "wallet_deep_scan_advice";
  if (/evidence.*missing|missing.*evidence|gaps?|what\s+is\s+missing/.test(t)) return "wallet_evidence_gaps";
  if (/risky|risk/.test(t)) return "wallet_risk";
  if (/what\s+type\s+of\s+trader|wallet\s+profile|should\s+i\s+follow|why\s+this\s+score|why\s+smart\s+money|why\s+not\s+smart\s+money|smart\s+money/.test(t)) return "wallet_profile";
  if (/good|quality|worth\s+monitoring/.test(t)) return "wallet_quality";
  return "wallet_summary";
}

export function isWalletComparePrompt(text: string): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!WALLET_COMPARE_RE.test(t)) return false;
  // "compare" with at least one wallet address is enough
  return /\b0x[a-f0-9]{40}\b/i.test(t);
}

// Task 1 (Pack 1 hard fix): token follow-up prompts that must always resolve against
// the last scanned token in memory, never fall through to a wallet branch.
const TOKEN_FOLLOWUP_RE = /\b(is\s+it\s+safe|safe\?|is\s+this\s+safe|is\s+this\s+token\s+safe|should\s+i\s+buy|is\s+it\s+legit|is\s+it\s+a\s+rug|is\s+it\s+risky|can\s+(?:the\s+)?dev\s+rug|can\s+liquidity\s+be\s+pulled|is\s+lp\s+locked|is\s+liquidity\s+locked|explain\s+lp|explain\s+holders|explain\s+dev(?:\s+control)?|why\s+high\s+risk|why\s+is\s+it\s+risky|why\s+caution|why\s+open\s+check|what\s+are\s+red\s+flags|explain\s+risk|explain\s+verdict|bull\s+case|bear\s+case|biggest\s+risk|what\s+am\s+i\s+missing|what\s+is\s+missing|run\s+lp\s+check|lp\s+check|check\s+lp|liquidity\s+safety|check\s+liquidity(?:\s+safety)?|run\s+liquidity\s+check)\b/i;

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

export type TokenFollowupKind = "safety" | "dev_rug" | "lp_lock" | "risk" | "analyst";

/** Maps a token follow-up prompt to the formatter/intent it should use. */
export function classifyTokenFollowupKind(prompt: string): TokenFollowupKind {
  const t = String(prompt ?? "").toLowerCase();
  if (/\b(can\s+(?:the\s+)?dev\s+rug|explain\s+dev(?:\s+control)?)\b/.test(t)) return "dev_rug";
  if (/\b(is\s+lp\s+locked|explain\s+lp|can\s+liquidity\s+be\s+pulled|run\s+lp\s+check|lp\s+check|check\s+lp|liquidity\s+safety|check\s+liquidity(?:\s+safety)?|run\s+liquidity\s+check)\b/.test(t)) return "lp_lock";
  if (/\b(bull\s+case|bear\s+case|biggest\s+risk|what\s+am\s+i\s+missing|what\s+is\s+missing|should\s+i\s+buy)\b/.test(t)) return "analyst";
  if (/\b(why\s+high\s+risk|why\s+is\s+it\s+risky|why\s+caution|what\s+are\s+red\s+flags|explain\s+risk|explain\s+verdict|explain\s+holders)\b/.test(t)) return "risk";
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
  if (isWalletFollowupPrompt(t)) {
    return { intent: "wallet_pnl_followup", address, addresses, deep: false, symbol: null };
  }

  // ---- LP / liquidity check (classify by phrase; contract-vs-EOA decided by caller via eth_getCode) ----
  if (/\b(lp\s+check|liquidity\s+check)\b/i.test(t) && address) {
    return { intent: "liquidity_scan", address, addresses, deep: false, symbol: null };
  }

  // ---- Wallet scan ----
  const walletScanRe = /\b(scan\s+(?:this\s+)?wallet|scan\s+wallet|analyze\s+(?:this\s+)?wallet|wallet\s+pnl|wallet\s+(?:scan|check|report|analysis))\b/i;
  // token keywords prevent wallet routing even if WALLET_DEEP_RE fires
  const hasExplicitTokenKeyword = /\b(token|coin|contract|ticker|\bca\b|scan\s+this\s+token|token\s+scan|on\s+base|on\s+eth|on\s+ethereum|on\s+bnb|on\s+bsc|on\s+polygon)\b/i.test(t);
  if (address && !hasExplicitTokenKeyword && (walletScanRe.test(t) || WALLET_DEEP_RE.test(t))) {
    return { intent: "wallet_scan", address, addresses, deep, symbol: null };
  }
  // Plain EOA address alone (no other strong intent keywords) → wallet scan
  if (address) {
    const hasOtherStrongIntent =
      /\b(lp\s+check|liquidity\s+check|liquidity|radar|pumping|trending|movers|whale|smart\s+money|token\s+scan|scan\s+this\s+token|token\s+check|is\s+(?:this\s+)?token|this\s+token|can\s+(?:the\s+)?dev|is\s+lp|explain\s+lp|high\s+risk|red\s+flags|on\s+base|on\s+eth|on\s+ethereum|on\s+bnb|on\s+bsc|on\s+polygon|base\s+token|eth\s+token|ethereum\s+token|bnb\s+token|bsc\s+token|polygon\s+token|\btoken\b|\bcoin\b|\bca\b|\bticker\b|contract\s+address)\b/i.test(t);
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
    /(?:who'?s\s+pumping\s+on\s+base|whos\s+pumping\s+on\s+base|what\s+is\s+pumping\s+on\s+base|what'?s\s+pumping\s+on\s+base|base\s+pairs?\s+(?:are\s+)?pumping|(?:show\s+me\s+)?trending\s+base\s+tokens?|hot\s+base\s+tokens?|base\s+gainers|base\s+pumps|trending\s+base|base\s+(?:movers|trending)|new\s+base\s+pools|what'?s\s+(?:moving|hot|running|happening)\s+on\s+base|base\s+market|top\s+base\s+tokens|base\s+momentum|top\s+gainers\s+on\s+base|highest\s+volume\s+base\s+tokens|what\s+(?:tokens|coins)\s+are\s+moving|what\s+should\s+i\s+scan\s+on\s+base)/i;
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
  if (TOKEN_SCAN_RE.test(t) || (address && TOKEN_SCAN_ON_CHAIN_RE.test(t))) {
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
const PUMPING_EXCLUDED_SYMBOLS = new Set(["USDC", "USDBC", "USDT", "DAI", "WETH", "ETH", "CBETH", "CBBTC", "WBTC", "BTC"]);

export function formatBaseMarketReadFromRows(rows: MarketLikeRow[] | undefined | null): string | null {
  if (!rows || rows.length === 0) return null;
  const valid = rows.filter((r) => r && r.symbol && !PUMPING_EXCLUDED_SYMBOLS.has(String(r.symbol).toUpperCase()));
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

/** Clean display label for an active-chain code — display-only, never changes the
 * underlying chain value used for routing/links. */
export function chainDisplayName(chain: string): string {
  const c = chain.toLowerCase();
  if (c === "base") return "Base";
  if (c === "eth" || c === "ethereum") return "Ethereum";
  if (c === "bnb" || c === "bsc") return "BNB";
  if (c === "polygon" || c === "matic") return "Polygon";
  return chain.length > 0 ? chain.charAt(0).toUpperCase() + chain.slice(1).toLowerCase() : chain;
}

/** Maps the internal PnL quality label to the public "PnL status: <X>" wording. Never
 * implies profitable/unprofitable — only reports whether PnL evidence was resolved. */
function pnlStatusLabel(label: string): "Verified" | "Partial" | "Unavailable" | "Open Check" {
  if (label === "ok") return "Verified";
  if (label === "unavailable") return "Unavailable";
  if (label === "open_check") return "Open Check";
  return "Partial";
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
    ? result.chainsActive.map(chainDisplayName).join(", ")
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
        const chain = h.chain ? ` [${chainDisplayName(h.chain)}]` : "";
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
  lines.push(`- PnL status: ${pnlStatusLabel(pnlQ.label)}`);
  lines.push(`- Reason: ${pnlQ.reason}`);
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

// ─────────────────────────────────────────────────────────────────────────
// Clark-facing wallet PnL lane read — public-safe, derived only from existing
// /api/wallet response fields. Never unlocks official PnL/win rate/profit
// skill/wallet score on its own; never exposes provider names or raw debug
// fields.
// ─────────────────────────────────────────────────────────────────────────

export const REQUIRED_PUBLIC_GRADE_LOTS = 10;

export type ClarkWalletPnlRead = {
  officialStatus: 'unlocked' | 'locked';
  officialLabel: string;
  officialReason: string | null;
  officialRealizedPnlUsd: number | null;
  officialWinRatePercent: number | null;
  officialClosedLots: number;
  publicGradeLots: number;
  requiredPublicGradeLots: number;
  profitSkillStatus: string;
  walletScoreStatus: 'locked' | 'unlocked';
  pnlIntegrityStatus: string;
  estimatedPerformanceRead: {
    status: 'available';
    realizedPnlUsd: number | null;
    confidence: string | null;
    sourceLots: number | null;
    excludedFrom: string[];
  } | null;
  publicSamplePerformanceRead: {
    status: 'available';
    closedLots: number;
    realizedPnlUsd: number | null;
    winRatePercent: number | null;
    excludedFrom: string[];
  } | null;
  displayMode: 'verified_public' | 'limited_sample' | 'estimated_only' | 'locked';
  displayWarning: string | null;
  excludedFrom: string[];
};

/**
 * Derive a public-safe wallet performance read for Clark from the raw
 * /api/wallet response. Returns null when the response carries no PnL-lane
 * fields at all (a holdings/activity-only read) — callers must say this read
 * only includes holdings/activity, not performance, in that case.
 */
export function buildWalletPnlRead(raw: Record<string, unknown> | null | undefined): ClarkWalletPnlRead | null {
  if (!raw || typeof raw !== 'object') return null;
  const ts = (raw.walletTradeStatsSummary && typeof raw.walletTradeStatsSummary === 'object') ? raw.walletTradeStatsSummary as Record<string, unknown> : {};
  const tradeIntelligence = (raw.tradeIntelligence && typeof raw.tradeIntelligence === 'object') ? raw.tradeIntelligence as Record<string, unknown> : {};
  const rawEstimated = raw.estimatedPerformanceRead && typeof raw.estimatedPerformanceRead === 'object' ? raw.estimatedPerformanceRead as Record<string, unknown> : null;
  const rawSample = raw.publicSamplePerformanceRead && typeof raw.publicSamplePerformanceRead === 'object' ? raw.publicSamplePerformanceRead as Record<string, unknown> : null;

  const hasPnlFields = raw.publicPnlStatus != null || ts.publicPnlStatus != null || rawEstimated != null || rawSample != null;
  if (!hasPnlFields) return null;

  const publicPnlStatus = String(raw.publicPnlStatus ?? ts.publicPnlStatus ?? 'open_check');
  const publicClosedLots = Number(raw.publicPerformanceClosedLots ?? ts.publicPerformanceClosedLots ?? 0);
  const publicRealizedPnlUsd = (raw.publicRealizedPnlUsd ?? raw.publicPerformanceRealizedPnlUsd ?? ts.publicRealizedPnlUsd ?? null) as number | null;
  const publicWinRatePercent = (raw.publicWinRatePercent ?? ts.publicWinRatePercent ?? null) as number | null;
  const pnlIntegrityStatus = String(ts.pnlIntegrityStatus ?? raw.pnlIntegrityStatus ?? 'ok');
  const profitSkillStatus = String(tradeIntelligence.profitSkillStatus ?? ts.profitSkillStatus ?? 'locked_small_sample');
  const walletScoreStatus: 'locked' | 'unlocked' = ts.scoreUnlocked === true ? 'unlocked' : 'locked';

  const officialUnlocked = publicPnlStatus === 'ok' && pnlIntegrityStatus !== 'invalid' && publicClosedLots >= REQUIRED_PUBLIC_GRADE_LOTS;
  const officialStatus: 'unlocked' | 'locked' = officialUnlocked ? 'unlocked' : 'locked';
  const officialReason = officialUnlocked ? null : String(raw.publicPnlStatusReason ?? ts.publicPnlStatusReason ?? 'Official PnL is locked.');
  const officialLabel = officialUnlocked ? 'Verified public PnL' : 'Locked';

  const estimatedPerformanceRead = rawEstimated && rawEstimated.status === 'available' ? {
    status: 'available' as const,
    realizedPnlUsd: (rawEstimated.realizedPnlUsd ?? null) as number | null,
    confidence: (rawEstimated.confidence ?? null) as string | null,
    sourceLots: (rawEstimated.sourceLots ?? null) as number | null,
    excludedFrom: Array.isArray(rawEstimated.excludedFrom) ? rawEstimated.excludedFrom as string[] : ['win_rate', 'profit_skill', 'wallet_score', 'verified_pnl'],
  } : null;

  const publicSamplePerformanceRead = rawSample && rawSample.status === 'available' ? {
    status: 'available' as const,
    closedLots: Number(rawSample.closedLots ?? publicClosedLots),
    realizedPnlUsd: (rawSample.realizedPnlUsd ?? null) as number | null,
    winRatePercent: (rawSample.winRatePercent ?? null) as number | null,
    excludedFrom: Array.isArray(rawSample.excludedFrom) ? rawSample.excludedFrom as string[] : ['profit_skill', 'wallet_score', 'official_win_rate'],
  } : null;

  const displayMode: ClarkWalletPnlRead['displayMode'] = officialUnlocked
    ? 'verified_public'
    : estimatedPerformanceRead
      ? 'estimated_only'
      : publicSamplePerformanceRead
        ? 'limited_sample'
        : 'locked';

  const excludedFrom = displayMode === 'estimated_only'
    ? (estimatedPerformanceRead?.excludedFrom ?? [])
    : displayMode === 'limited_sample'
      ? (publicSamplePerformanceRead?.excludedFrom ?? [])
      : [];

  const displayWarning = displayMode === 'estimated_only'
    ? 'Estimated PnL exists, but it is not verified and is excluded from win rate, profit skill, wallet score, and verified PnL.'
    : displayMode === 'limited_sample'
      ? `Limited sample exists, but it is below the required ${REQUIRED_PUBLIC_GRADE_LOTS} public-grade lots.`
      : displayMode === 'locked'
        ? officialReason
        : null;

  return {
    officialStatus,
    officialLabel,
    officialReason,
    officialRealizedPnlUsd: officialUnlocked ? publicRealizedPnlUsd : null,
    officialWinRatePercent: officialUnlocked ? publicWinRatePercent : null,
    officialClosedLots: publicClosedLots,
    publicGradeLots: publicClosedLots,
    requiredPublicGradeLots: REQUIRED_PUBLIC_GRADE_LOTS,
    profitSkillStatus,
    walletScoreStatus,
    pnlIntegrityStatus,
    estimatedPerformanceRead,
    publicSamplePerformanceRead,
    displayMode,
    displayWarning,
    excludedFrom,
  };
}

/**
 * Render Clark's wallet-performance answer from a ClarkWalletPnlRead. When
 * read is null, the wallet context only had holdings/activity evidence, not
 * a performance read.
 */
export function formatWalletPnlRead(read: ClarkWalletPnlRead | null): string {
  if (!read) return "This read only includes holdings/activity, not performance.";

  if (read.displayMode === 'verified_public') {
    return [
      "WALLET PNL",
      "Status: Verified public PnL",
      `Realized PnL: ${read.officialRealizedPnlUsd != null ? fmtUsdShort(read.officialRealizedPnlUsd) : "unavailable"}`,
      `Win rate: ${read.officialWinRatePercent != null ? `${read.officialWinRatePercent.toFixed(1)}%` : "unavailable"}`,
      `Closed lots: ${read.officialClosedLots}`,
    ].join("\n");
  }

  if (read.displayMode === 'estimated_only') {
    const e = read.estimatedPerformanceRead;
    return [
      "WALLET PNL",
      "Status: Estimated only — not verified",
      `Estimated realized PnL: ${e?.realizedPnlUsd != null ? fmtUsdShort(e.realizedPnlUsd) : "unavailable"}`,
      `Source lots: ${e?.sourceLots ?? "unknown"} / Confidence: ${e?.confidence ?? "unknown"}`,
      "Estimated PnL exists, but it is not verified and is excluded from win rate, profit skill, wallet score, and verified PnL.",
      "Profit skill remains locked.",
      "Wallet score remains locked.",
      "Official win rate remains locked.",
    ].join("\n");
  }

  if (read.displayMode === 'limited_sample') {
    const s = read.publicSamplePerformanceRead;
    return [
      "WALLET PNL",
      "Status: Limited sample",
      `Limited sample PnL: ${s?.realizedPnlUsd != null ? fmtUsdShort(s.realizedPnlUsd) : "unavailable"}`,
      `Public-grade lots: ${s?.closedLots ?? read.publicGradeLots} of required ${read.requiredPublicGradeLots}`,
      `Limited sample exists, but it is below the required ${read.requiredPublicGradeLots} public-grade lots.`,
      "Profit skill remains locked.",
      "Wallet score remains locked.",
      "Official win rate remains locked.",
    ].join("\n");
  }

  return [
    "WALLET PNL",
    "Status: Locked",
    "Official PnL is locked.",
    `Reason: ${read.officialReason ?? "Official PnL is locked."}`,
    "Profit skill remains locked.",
    "Wallet score remains locked.",
    "Official win rate remains locked.",
  ].join("\n");
}

/**
 * Build an honest "unsupported compare" reply that names both wallet addresses
 * (or the last wallet + the typed one) and never silently scans only one.
 */
function walletEvidenceValue(src: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const parts = key.split('.');
    let cur: any = src;
    for (const part of parts) cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    if (cur != null) return cur;
  }
  return null;
}

function walletEvidenceReasons(result: WalletApiResult): string[] {
  const reasons: string[] = [];
  const coverage = result.walletModuleCoverage ?? {};
  const pnl = result.walletTokenPnlSummary ?? {};
  const hist = result.walletHistoricalCoverageSummary ?? null;
  const add = (label: string, yes: boolean) => { if (yes && !reasons.includes(label)) reasons.push(label); };
  add("Cost basis incomplete", /cost basis|basis|fifo|open_check|partial|incomplete|limited|locked/i.test(JSON.stringify([coverage?.fifoPnL, pnl, result.pnlCoverage])));
  add("Closed lots not verified", /closed|lot|locked_no_closed_lots|insufficient|unverified|partial/i.test(JSON.stringify([coverage?.fifoPnL, coverage?.tradeStats, result.closedLots])));
  add("Historical recovery partial", /partial|limited|open|unavailable|cached|preview/i.test(JSON.stringify([hist, result.historicalRecoveryStatus])));
  add("Activity preview only", /preview|open_check|provider_unavailable|unavailable|cached/i.test(JSON.stringify([coverage?.activity, result.dataFreshness, result.cacheAgeSeconds])));
  add("Chain coverage limited", /limited|partial|single|auto|open_check/i.test(JSON.stringify([coverage?.chains, (result as any).chainCoverage])));
  add("Price coverage partial", /partial|open_check|unavailable|limited/i.test(JSON.stringify([coverage?.priceEvidence, (result as any).pricingCoverage])));
  if (Array.isArray((result as any).evidenceGaps)) for (const g of (result as any).evidenceGaps) add(String(g), true);
  if (reasons.length === 0) reasons.push(describePnlQuality(result).reason);
  return reasons.filter(Boolean);
}

/** Structured, evidence-backed gap flags shared by the deep-scan-advice and evidence-gaps
 * follow-up formatters — only ever derived from cached wallet evidence, never invented. */
function walletEvidenceGapFlags(result: WalletApiResult): {
  pnlStatus: "Verified" | "Partial" | "Open Check" | "Unavailable";
  pnlGap: boolean;
  lotsGap: boolean;
  histGap: boolean;
  histPreview: boolean;
  activityGap: boolean;
} {
  const coverage = result.walletModuleCoverage ?? {};
  const fifoStatus = coverage?.fifoPnL?.status;
  const histStatus = result.walletHistoricalCoverageSummary?.status ?? result.historicalRecoveryStatus ?? null;
  const activityStatus = coverage?.activity?.status ?? null;
  const fresh = String(result.dataFreshness ?? "").toLowerCase();
  const cacheAge = typeof result.cacheAgeSeconds === "number" ? result.cacheAgeSeconds : null;
  const isPreview = fresh === "cached" || (cacheAge != null && cacheAge > 0);
  const pnlStatus = walletPnlStatus(result);
  return {
    pnlStatus,
    pnlGap: pnlStatus !== "Verified",
    lotsGap: fifoStatus === "locked_no_closed_lots" || fifoStatus === "locked_insufficient_trades" || result.closedLots == null || result.openLots == null,
    histGap: (!!histStatus && String(histStatus) !== "ok") || isPreview,
    histPreview: isPreview,
    activityGap: activityStatus === "open_check" || activityStatus === "provider_unavailable" || isPreview,
  };
}

function walletPnlStatus(result: WalletApiResult): "Verified" | "Partial" | "Open Check" | "Unavailable" {
  const q = describePnlQuality(result);
  if (q.label === "ok") return "Verified";
  const text = JSON.stringify([q, result.walletModuleCoverage, result.walletTokenPnlSummary]).toLowerCase();
  if (/unavailable|provider_unavailable|not available/.test(text)) return "Unavailable";
  if (/partial|limited|incomplete|locked|attempted/.test(text)) return "Partial";
  return "Open Check";
}

export function formatWalletFollowupFromMemory(address: string, result: WalletApiResult, kind: WalletFollowupKind): string {
  const holdings = result.holdings ?? [];
  const top = pickTopHoldingsByValue(holdings, 5);
  const chains = result.chainsActive?.length ? result.chainsActive.map(chainDisplayName).join(", ") : "unverified";
  const total = result.totalValue != null ? fmtUsdShort(result.totalValue) : "unverified";
  const pnlStatus = walletPnlStatus(result);
  const q = describePnlQuality(result);
  const reasons = walletEvidenceReasons(result);
  const closed = result.closedLots ?? result.walletLotSummary?.closedLots ?? "unverified";
  const open = result.openLots ?? result.walletLotSummary?.openLots ?? "unverified";
  const topLines = top.length ? top.map((h, i) => `${i + 1}. ${String(h.symbol ?? "?").toUpperCase()}${h.chain ? ` [${chainDisplayName(h.chain)}]` : ""} — ${fmtUsdShort(h.value)}`) : ["none returned with value"];
  const canProfit = pnlStatus === "Verified";
  if (kind === "wallet_profitability") return [
    "WALLET PROFITABILITY", `Status: ${pnlStatus === "Verified" ? "Verified" : pnlStatus === "Partial" ? "Partial" : "Open Check"}`,
    `Realized PnL: ${walletEvidenceValue(result as any, ["realizedPnlUsd", "walletTokenPnlSummary.realizedPnlUsd", "walletTradeStatsSummary.realizedPnlUsd"]) ?? "unavailable"}`,
    `Unrealized/Open PnL: ${walletEvidenceValue(result as any, ["unrealizedPnlUsd", "walletTokenPnlSummary.unrealizedPnlUsd", "walletTradeStatsSummary.unrealizedPnlUsd"]) ?? "unavailable"}`,
    `Closed lots: ${closed}`, `Open lots: ${open}`, `PnL confidence: ${pnlStatus}`, "Read:", canProfit ? "Clark can judge profitability because verified PnL evidence is present." : (pnlStatus === "Partial" ? "Profitability is partial — cost basis / closed lots are incomplete." : "Clark can assess portfolio exposure, but not profitability yet."),
    ...(canProfit ? [] : [`Reason: ${q.reason}`])
  ].join("\n");
  if (kind === "wallet_pnl_explanation") return ["PNL EXPLANATION", `PnL status: ${pnlStatus}`, "Why:", ...reasons.map(r => `- ${r}`)].join("\n");
  if (kind === "wallet_deep_scan_advice") {
    const f = walletEvidenceGapFlags(result);
    const whyLines: string[] = [];
    if (f.pnlGap) whyLines.push(`PnL is ${f.pnlStatus.toLowerCase()}`);
    if (f.lotsGap) whyLines.push("Closed/open lot attribution is unverified");
    if (f.histGap) whyLines.push(`Historical recovery is ${f.histPreview ? "portfolio preview only" : "partial"}`);
    if (f.activityGap) whyLines.push("Activity status is portfolio preview");
    // No gaps detected at all: with holdings present, PnL/trade recovery are verified by
    // construction (pnlGap/lotsGap would otherwise have fired) — so "No" is the honest answer.
    // With no holdings either, there isn't enough evidence either way, so "Maybe".
    const hasHoldings = holdings.length > 0;
    const recommend = whyLines.length > 0 ? "Yes" : (hasHoldings ? "No" : "Maybe");
    return [
      "DEEP SCAN ADVICE", `Recommended: ${recommend}`, "",
      "Why:", ...(whyLines.length ? whyLines : ["Cached evidence does not show major gaps beyond normal open checks"]).map(r => `- ${r}`), "",
      "Cost note:", "Deep scan may use more provider credits. Use it when PnL/trade history matters.",
    ].join("\n");
  }
  if (kind === "wallet_evidence_gaps") {
    const f = walletEvidenceGapFlags(result);
    const gapLines: string[] = [];
    if (f.lotsGap) gapLines.push("Closed/open lot attribution: partial/unverified");
    if (f.histGap) gapLines.push(`Historical recovery: ${f.histPreview ? "portfolio preview" : "partial"}`);
    if (f.activityGap) gapLines.push("Activity status: portfolio preview");
    if (f.pnlGap) gapLines.push(`PnL confidence: ${f.pnlStatus.toLowerCase()}`);
    return [
      "WALLET EVIDENCE GAPS",
      ...(gapLines.length ? gapLines.map(l => `- ${l}`) : ["- No major evidence gaps found in cached scan"]), "",
      "Read:", "These gaps explain why Clark will not call the wallet profitable or unprofitable yet.",
    ].join("\n");
  }
  if (kind === "wallet_holdings") {
    if (top.length === 0) {
      return ["WALLET HOLDINGS", "Clark has the last wallet address, but top holdings were not available in the cached scan. Run a fresh wallet scan."].join("\n");
    }
    return [
      "WALLET HOLDINGS",
      `- Address: ${address}`,
      `- Total value: ${total}`,
      `- Holdings count: ${holdings.length}`, "",
      "Top holdings:", ...topLines, "",
      "Read:", "Clark is using the last wallet scan evidence. This is portfolio exposure, not confirmed profitability.",
    ].join("\n");
  }
  if (kind === "wallet_chains") {
    if (!result.chainsActive?.length) {
      return ["WALLET CHAINS", `- Address: ${address}`, "Clark has the last wallet address, but active chain data was not available in the cached scan. Run a fresh wallet scan."].join("\n");
    }
    return [
      "WALLET CHAINS",
      `- Address: ${address}`,
      `- Active chains: ${chains}`, "",
      "Read:", "This came from the last wallet scan evidence. Use deep scan if you want wider historical chain activity.",
    ].join("\n");
  }
  if (kind === "wallet_risk" || kind === "wallet_quality") return [kind === "wallet_risk" ? "WALLET RISK" : "WALLET QUALITY", `Address: ${address}`, `Total value: ${total}`, `Active chains: ${chains}`, `PnL status: ${pnlStatus}`, "Read:", canProfit ? "Profitability evidence is verified, but wallet quality still depends on concentration, activity, and risk." : "Clark can assess portfolio exposure, but not profitability yet.", ...(reasons.length ? ["Evidence limits:", ...reasons.map(r => `- ${r}`)] : []), "CTA: Open Wallet Scanner / Deep Scan Wallet"].join("\n");
  if (kind === "wallet_profile") {
    const profile = (result as any).walletProfile && typeof (result as any).walletProfile === "object" ? (result as any).walletProfile as Record<string, unknown> : null;
    const category = typeof profile?.walletCategory === "string" ? profile.walletCategory : "Not Yet Classified";
    const portfolioBehavior = typeof profile?.portfolioBehavior === "string" ? profile.portfolioBehavior : "Not Yet Classified";
    const tradingBehavior = typeof profile?.tradingBehavior === "string" ? profile.tradingBehavior : "Insufficient Evidence";
    const portfolioConfidence = typeof profile?.portfolioConfidence === "string" ? profile.portfolioConfidence : "low";
    const tradingConfidence = typeof profile?.tradingConfidence === "string" ? profile.tradingConfidence : "low";
    const followability = typeof profile?.followability === "string" ? profile.followability : "Low";
    const why = Array.isArray(profile?.signals) ? (profile?.signals as unknown[]).map(String) : [
      `${holdings.length} priced holdings in cached scan`,
      `Active chains: ${chains}`,
      `PnL status: ${pnlStatus}`,
    ];
    const strengths = Array.isArray(profile?.strengths) ? (profile?.strengths as unknown[]).map(String) : [];
    const weaknesses = Array.isArray(profile?.weaknesses) ? (profile?.weaknesses as unknown[]).map(String) : (reasons.length ? reasons : ["No explicit weakness returned in cached evidence."]);
    const next = typeof profile?.nextAction === "string" ? profile.nextAction : (pnlStatus === "Verified" ? "Monitor with the wallet scanner before copying trades." : "Run a deep scan if followability depends on trade history or PnL.");
    return [
      "WALLET PROFILE",
      `Category: ${category}`,
      `Portfolio Behavior: ${portfolioBehavior}`,
      `Trading Behavior: ${tradingBehavior}`,
      `Portfolio Confidence: ${portfolioConfidence}`,
      `Trading Confidence: ${tradingConfidence}`,
      "Why:",
      ...why.slice(0, 4).map(r => `• ${r}`),
      "Strengths:",
      ...(strengths.length ? strengths.slice(0, 3).map(r => `• ${r}`) : ["• No clear strengths detected from available evidence."]),
      "Weaknesses:",
      ...weaknesses.slice(0, 3).map(r => `• ${r}`),
      `Followability: ${followability}`,
      `Next Action: ${next}`,
    ].join("\n");
  }
  return ["WALLET SUMMARY", `Address: ${address}`, `Total value: ${total}`, `Active chains: ${chains}`, `Holdings: ${holdings.length} tokens`, "Top holdings:", ...topLines, "PnL read:", `- Status: ${pnlStatus.toLowerCase()}`, `- Reason: ${q.reason}`, "Read:", canProfit ? "Clark can judge profitability because verified PnL evidence is present." : "Clark can assess portfolio exposure, but not profitability yet.", "CTA: Open Wallet Scanner / Deep Scan Wallet"].join("\n");
}

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

// Maps the fixed CLARK_ACTIONS vocabulary to the app routes the frontend actually
// navigates to, so routed (string-only) action lists can be rendered as clickable
// CTAs by the Clark UI, which only reads { label, href } pairs from ui.actions.
const CLARK_ACTION_HREF: Record<ClarkAction, string> = {
  "Open Base Radar": "/terminal/base-radar",
  "Open Token Scanner": "/terminal/token-scanner",
  "Scan Wallet": "/terminal/wallet-scanner",
  "Deep Scan Wallet": "/terminal/wallet-scanner",
  "Run LP Check": "/terminal/token-scanner",
  "Open Whale Alerts": "/terminal/whale-alerts",
  "Refresh Market Data": "/terminal?refresh=market",
};

export function toClarkUiActions(actions: ClarkAction[]): Array<{ label: string; href: string }> {
  return actions.map((a) => ({ label: a, href: CLARK_ACTION_HREF[a] }));
}

/** Graceful, non-scary reply for "no fresh Base market rows available right now". */
export function formatNoFreshMarketData(): string {
  return [
    "Base market data is incomplete right now.",
    "I can't see fresh Base market rows in this pass — market data may be cooling down or temporarily unavailable.",
    "",
    "CTA: Refresh Market Data",
  ].join("\n");
}

/** Used when the canonical market source returned rows, but every row was a
 * stablecoin/major filtered out of "pumping" rankings — distinct from having
 * no rows at all, so Clark never reports no_rows when the dashboard has data. */
export function formatNoPumpCandidates(): string {
  return [
    "BASE MARKET READ",
    "",
    "Market data is available, but no clear pump candidates match your filters right now.",
    "",
    "CTA: Refresh Market Data",
  ].join("\n");
}

// Symbol groups used when a prompt says "without stables" / "exclude majors".
const EXCLUSION_STABLE_SYMS = ["USDC", "USDT", "DAI", "USDBC", "EURC", "BUSD", "FRAX", "USD+", "AXLUSDC"];
const EXCLUSION_MAJOR_SYMS = ["WETH", "ETH", "CBBTC", "BTC", "WBTC", "CBETH", "STETH", "WSTETH", "BSDETH"];
const EXCLUSION_STOPWORDS = new Set([
  "stable", "stables", "stablecoin", "stablecoins", "major", "majors", "and", "the",
  "tokens", "token", "coins", "coin", "on", "base", "please", "right", "now", "only", "just",
]);

/**
 * Parse explicit token exclusions from a market prompt, e.g.
 *   "excluding cbBTC WETH USDC"  -> ["CBBTC","WETH","USDC"]
 *   "exclude cbBTC, WETH, USDC"  -> ["CBBTC","WETH","USDC"]
 *   "without stables/majors"      -> stable + major symbol groups
 * Returns an empty array when no exclusion clause is present.
 */
export function parseExplicitExclusions(prompt: string): string[] {
  const m = prompt.match(/\b(?:excluding|exclude|without|except(?:\s+for)?|other than|besides|minus|no)\s+(.+)$/i);
  if (!m) return [];
  const tail = m[1].toLowerCase();
  const out = new Set<string>();
  if (/\bstable(?:coin)?s?\b/.test(tail)) EXCLUSION_STABLE_SYMS.forEach((s) => out.add(s));
  if (/\bmajors?\b/.test(tail)) EXCLUSION_MAJOR_SYMS.forEach((s) => out.add(s));
  const tokens = tail.replace(/[,/&]|\band\b/g, " ").split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    if (EXCLUSION_STOPWORDS.has(raw)) continue;
    const sym = raw.toUpperCase().replace(/[^A-Z0-9+]/g, "");
    if (sym.length < 2 || sym.length > 12) continue;
    out.add(sym);
  }
  return [...out];
}

/**
 * Accepts any trending response shape the app has used and returns the row array:
 * a bare array, or an object keyed by data/items/tokens/results (including nested
 * {data:{items|tokens:[]}}). Lets Clark read the dashboard's market rows regardless
 * of which serialization the source returns.
 */
export function parseTrendingRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const direct = p.data ?? p.items ?? p.tokens ?? p.results;
  if (Array.isArray(direct)) return direct as Array<Record<string, unknown>>;
  if (direct && typeof direct === "object") {
    const d = direct as Record<string, unknown>;
    const nested = d.items ?? d.tokens ?? d.data;
    if (Array.isArray(nested)) return nested as Array<Record<string, unknown>>;
  }
  return [];
}

const ONCHAIN_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Pulls usable scan identifiers out of a raw market row, regardless of which field
 * the upstream source used (tokenAddress/address/contract/contractAddress for the
 * token; poolAddress/pairAddress for the pool). Only real on-chain 0x addresses are
 * accepted — CoinGecko-style slug ids (e.g. "pepe") are rejected so they never become
 * a bogus scan target. scanTarget is the token address only, because Token Scanner
 * scans token contracts (not pools); pool-only rows get scanTarget=null so Clark never
 * claims a scan is runnable when it isn't.
 */
export function pickScanIdentifiers(row: Record<string, unknown>): {
  tokenAddress: string | null;
  poolAddress: string | null;
  scanTarget: string | null;
  scanTargetType: "token" | "pool" | null;
} {
  const firstAddr = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && ONCHAIN_ADDR_RE.test(v)) return v;
    }
    return null;
  };
  const tokenAddress = firstAddr(["tokenAddress", "address", "contract", "contractAddress"]);
  const poolAddress = firstAddr(["poolAddress", "pairAddress"]);
  return {
    tokenAddress,
    poolAddress,
    scanTarget: tokenAddress,
    scanTargetType: tokenAddress ? "token" : null,
  };
}

/** Token Scanner deep-link that the scanner page auto-runs (it reads ?contract= + ?chain=). */
export function tokenScannerHref(tokenAddress: string, chain = "base"): string {
  return `/terminal/token-scanner?chain=${chain}&contract=${tokenAddress}`;
}

/** Human-readable tag for which trending response shape was received (debug only). */
export function describeTrendingShape(payload: unknown): string {
  if (Array.isArray(payload)) return "array";
  if (!payload || typeof payload !== "object") return "none";
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.data)) return "{data:[]}";
  if (Array.isArray(p.items)) return "{items:[]}";
  if (Array.isArray(p.tokens)) return "{tokens:[]}";
  if (Array.isArray(p.results)) return "{results:[]}";
  if (p.data && typeof p.data === "object") {
    const d = p.data as Record<string, unknown>;
    if (Array.isArray(d.items)) return "{data:{items:[]}}";
    if (Array.isArray(d.tokens)) return "{data:{tokens:[]}}";
  }
  return "unknown_object";
}

// ─────────────────────────────────────────────────────────────────────────
// App-context follow-ups — let Clark answer "explain this / why is pnl locked /
// what should I do next / what are the risks" from the current page's scan summary
// instead of asking the user to paste JSON. All copy is provider-name-free.
// ─────────────────────────────────────────────────────────────────────────

export type ClarkWalletContextSummary = {
  address?: string | null;
  totalValue?: number | null;
  holdingsCount?: number | null;
  publicPnlStatus?: string | null;
  publicPnlDisplayLabel?: string | null;
  publicPnlDisplayReason?: string | null;
  walletPnlRead?: { mode?: string | null; label?: string | null; reason?: string | null } | null;
  walletModuleCoverage?: Record<string, string | null> | null;
  walletOpenPositionSummary?: { summary?: string | null } | null;
};

export type ClarkTokenContextSummary = {
  chain?: string | null;
  address?: string | null;
  symbol?: string | null;
  name?: string | null;
  score?: number | null;
  verdict?: string | null;
  topRisks?: string[] | null;
  sectionStatus?: Record<string, string | null> | null;
};

export type ClarkAppFollowupKind =
  | "explain"
  | "pnl_locked"
  | "next_step"
  | "wallet_quality"
  | "scan_token"
  | "token_explain"
  | "token_risks";

/** Classify a context-dependent follow-up ("explain this", "why is pnl locked", …). */
export function classifyAppContextFollowup(prompt: string): ClarkAppFollowupKind | null {
  const t = prompt.toLowerCase().trim();
  if (/\bpnl\s+(?:is\s+)?locked\b/.test(t) || /\bwhy\s+(?:is\s+|are\s+)?(?:the\s+|my\s+)?(?:pnl|win\s*rate|profit)\b[^.?!]*\b(lock|locked|hidden|missing|unavailable|not\s+show)/.test(t)) return "pnl_locked";
  if (/\bscan\s+(?:this|the|that)\s+token\b/.test(t)) return "scan_token";
  if (/\b(?:explain|what'?s|what\s+is)\s+(?:this\s+)?token\b/.test(t)) return "token_explain";
  if (/\bwhat\s+are\s+(?:the\s+)?risks?\b|\brisk\s+breakdown\b|\bwhat'?s\s+risky\b|\bhow\s+risky\b/.test(t)) return "token_risks";
  if (/\bwhat\s+(?:should|do|can)\s+i\s+do\s+next\b|\bwhat'?s\s+next\b|\bnext\s+steps?\b/.test(t)) return "next_step";
  if (/\bis\s+(?:this|the)\s+wallet\s+(?:good|worth|safe|legit|solid|ok|clean)\b/.test(t)) return "wallet_quality";
  if (/\bexplain\s+(?:this|the|it)(?:\s+wallet|\s+result|\s+scan)?\b|\bwhat\s+does\s+this\s+mean\b|\bbreak\s+(?:this|it)\s+down\b/.test(t)) return "explain";
  return null;
}

function fmtUsdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function shortenAddr(a: string | null | undefined): string {
  if (!a || a.length < 12) return a ?? "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Explains why wallet PnL/win-rate is locked, strictly from the provided summary. */
export function formatWalletPnlLockedExplanation(s: ClarkWalletContextSummary): string {
  const reason = s.walletPnlRead?.reason || s.publicPnlDisplayReason
    || "the verified, integrity-valid trade sample is too small to prove realized PnL and win rate.";
  const label = s.walletPnlRead?.label || s.publicPnlDisplayLabel || "PnL locked";
  return [
    "WALLET PnL — WHY IT'S LOCKED",
    "",
    `Status: ${label}`,
    `Reason: ${reason}`,
    "",
    "What this means: behavior-only reads (rotation speed, holdings, activity) can still be shown, but realized PnL and win rate stay hidden until there's a large enough verified, integrity-valid trade sample.",
    "",
    "Next: run a deep scan to try to recover more closed-lot history, or open Wallet Scanner for the full breakdown.",
  ].join("\n");
}

function walletPnlIsLocked(s: ClarkWalletContextSummary): boolean {
  const status = (s.publicPnlStatus ?? "").toLowerCase();
  const mode = (s.walletPnlRead?.mode ?? "").toLowerCase();
  return /lock|integrity_invalid|open_check|flat_estimate|near_flat/.test(status) || /lock|hidden/.test(mode);
}

/** Wallet read built from the current scan summary (never a generic fallback). */
export function formatWalletContextRead(s: ClarkWalletContextSummary): string {
  const lines: string[] = ["WALLET READ (from your current scan)", ""];
  if (s.address) lines.push(`Address: ${shortenAddr(s.address)}`);
  if (s.totalValue != null) lines.push(`Portfolio value: ${fmtUsdCompact(s.totalValue)}`);
  if (s.holdingsCount != null) lines.push(`Holdings tracked: ${s.holdingsCount}`);
  const pnlReason = s.walletPnlRead?.reason || s.publicPnlDisplayReason;
  if (s.publicPnlDisplayLabel || s.walletPnlRead?.label) {
    lines.push(`PnL: ${s.walletPnlRead?.label ?? s.publicPnlDisplayLabel}${pnlReason ? ` — ${pnlReason}` : ""}`);
  }
  if (s.walletOpenPositionSummary?.summary) lines.push(`Open positions: ${s.walletOpenPositionSummary.summary}`);
  const coverage = s.walletModuleCoverage ? Object.entries(s.walletModuleCoverage).filter(([, v]) => v) : [];
  if (coverage.length) lines.push(`Module coverage: ${coverage.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("", 'Ask "what should I do next" for a recommended action, or "why is pnl locked" if PnL is hidden.');
  return lines.join("\n");
}

/** Wallet quality read — behavior-only when PnL is locked, never invents performance. */
export function formatWalletQualityRead(s: ClarkWalletContextSummary): string {
  const locked = walletPnlIsLocked(s);
  const lines: string[] = ["IS THIS WALLET WORTH WATCHING?", ""];
  if (s.totalValue != null) lines.push(`- Portfolio value: ${fmtUsdCompact(s.totalValue)}`);
  if (s.holdingsCount != null) lines.push(`- Holdings tracked: ${s.holdingsCount}`);
  lines.push(locked
    ? "- Realized PnL/win rate are locked, so I can't grade profitability yet — only behavior."
    : `- Public PnL read: ${s.walletPnlRead?.label ?? s.publicPnlDisplayLabel ?? "available"}.`);
  if (s.walletOpenPositionSummary?.summary) lines.push(`- Open positions: ${s.walletOpenPositionSummary.summary}`);
  lines.push("",
    "I won't tell you to copy-trade it. Monitoring is fine; conviction needs verified PnL plus a clean holdings/concentration read.",
    "",
    "Next: run a deep scan for more history, or check the top holdings for concentration risk.");
  return lines.join("\n");
}

/** Recommended next action from wallet context. */
export function formatWalletNextSteps(s: ClarkWalletContextSummary): string {
  const steps: string[] = [];
  if (walletPnlIsLocked(s)) steps.push("Run a deep scan to recover more closed-lot history and try to unlock PnL/win rate.");
  steps.push("Check the top holdings for concentration risk before any conviction.");
  steps.push("Open Wallet Scanner for the full module breakdown.");
  return ["WHAT TO DO NEXT", "", ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n");
}

/** Token read built from the current scan summary's section statuses. */
export function formatTokenContextRead(s: ClarkTokenContextSummary): string {
  const sym = s.symbol ?? "this token";
  const label = s.name && s.symbol && s.name.toUpperCase() !== s.symbol.toUpperCase() ? `${s.symbol} (${s.name})` : sym;
  const lines: string[] = [`TOKEN READ — ${label}`, ""];
  if (s.verdict) lines.push(`Verdict: ${s.verdict}`);
  if (s.score != null) lines.push(`Score: ${s.score}`);
  if (s.chain) lines.push(`Chain: ${s.chain}`);
  if (s.address) lines.push(`Contract: ${shortenAddr(s.address)}`);
  const statuses = s.sectionStatus ? Object.entries(s.sectionStatus).filter(([, v]) => v) : [];
  if (statuses.length) {
    lines.push("", "Section status:");
    for (const [k, v] of statuses) lines.push(`- ${k}: ${v}`);
  }
  if (s.topRisks && s.topRisks.length) {
    lines.push("", "Top risks:");
    for (const r of s.topRisks.slice(0, 5)) lines.push(`- ${r}`);
  }
  lines.push("", 'Ask "what are the risks" for the risk breakdown, or paste a new contract to scan another token.');
  return lines.join("\n");
}

/** Token risk breakdown that cites the section statuses from context. */
export function formatTokenRiskRead(s: ClarkTokenContextSummary): string {
  const sym = s.symbol ?? "this token";
  const lines: string[] = [`RISK READ — ${sym}`, ""];
  if (s.topRisks && s.topRisks.length) {
    for (const r of s.topRisks.slice(0, 6)) lines.push(`- ${r}`);
  } else {
    lines.push("- No critical risk flag confirmed yet in the current scan.");
  }
  const statuses = s.sectionStatus ? Object.entries(s.sectionStatus).filter(([, v]) => v) : [];
  if (statuses.length) {
    lines.push("", "Coverage (what's verified vs pending):");
    for (const [k, v] of statuses) lines.push(`- ${k}: ${v}`);
  }
  lines.push("", "Anything marked partial/unavailable isn't a clean bill of health — it's unverified. Re-scan or open Token Scanner to fill the gaps.");
  return lines.join("\n");
}

/** Short, friendly ask when the follow-up needs context Clark doesn't have yet. */
export function formatAppContextMissingAsk(kind: ClarkAppFollowupKind): string {
  switch (kind) {
    case "pnl_locked":
      return "I don't have a wallet scan in view yet. Open Wallet Scanner and run a scan, then ask me why PnL is locked.";
    case "next_step":
    case "wallet_quality":
    case "explain":
      return "I don't have a scan in view yet. Run a Wallet or Token scan (or ask \"what's pumping on Base?\"), then I can break it down.";
    case "scan_token":
    case "token_explain":
    case "token_risks":
      return "I don't have a token in view yet. Paste a contract or open Token Scanner, then ask me to explain it.";
    default:
      return "I need a bit more context. Run a scan or paste an address and I'll take it from there.";
  }
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
    simulationStatus?: string | null;
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
    rawLpState?: string | null;
    lpController?: string | null;
    lpControllerType?: string | null;
    positionProofStatus?: string | null;
    positionProofReason?: string | null;
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

function isConcentratedLp(lp: TokenScanEvidence["lpControl"]): boolean {
  if (!lp) return false;
  const haystack = [lp.status, lp.poolType, lp.proofApplicability, lp.displayLpModel, lp.proofStatus]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes("concentrated") || haystack.includes("clmm") || haystack.includes("infinity") || haystack.includes("uniswap v3") || haystack.includes("uniswap v4") || lp.proofApplicability === "not_applicable" || lp.displayLpModel === "concentrated_liquidity" || lp.proofStatus === "not_applicable";
}

function concentratedLpPrimary(lp: TokenScanEvidence["lpControl"]): string {
  const label = lp?.poolType || lp?.displayLpModel || lp?.reason || "concentrated liquidity";
  if (/uniswap\s*v4/i.test(label)) return "Uniswap V4 concentrated";
  if (/uniswap\s*v3/i.test(label)) return "Uniswap V3 concentrated";
  return label.replace(/_/g, " ");
}

function publicSafeEvidenceReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  let out = String(reason)
    .replace(/not supported by current provider path/gi, "unavailable in this read")
    .replace(/current provider path/gi, "this read")
    .replace(/provider path/gi, "this read")
    .replace(/API path|route path/gi, "read");
  out = out.replace(/Position proof attempted\s*[—-]\s*unavailable in this read/gi, "Position/controller proof is unavailable in this read");
  return out;
}

function concentratedControllerProofStatus(lp: TokenScanEvidence["lpControl"]): { hasProof: boolean; state: string } {
  const status = String(lp?.positionProofStatus ?? lp?.proofStatus ?? lp?.status ?? "open_check").toLowerCase();
  const reason = publicSafeEvidenceReason(lp?.positionProofReason ?? lp?.reason) ?? "";
  const hasController = Boolean(lp?.lpController && /^0x[a-f0-9]{40}$/i.test(lp.lpController));
  const unavailable = /not_supported|not supported|unavailable|open_check|unverified|required|no controller|not confirmed/i.test(`${status} ${reason}`);
  if (hasController && !unavailable) return { hasProof: true, state: `${lp?.lpControllerType ?? "controller"} ${lp?.lpController}` };
  if (!unavailable && status && !["concentrated_liquidity", "open_check", "unverified", "not_applicable"].includes(status)) return { hasProof: true, state: publicSafeEvidenceReason(lp?.positionProofReason ?? lp?.reason) ?? status };
  return { hasProof: false, state: "Open Check" };
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
  // Concentrated/v3/v4 pools don't mint ERC-20 LP tokens, so the standard lock/burn-proof
  // check genuinely does not apply — this is not the same as "proof should exist but
  // couldn't be confirmed" (that case stays Open Check below).
  if (concentrated) {
    const proof = concentratedControllerProofStatus(lp);
    if (proof.hasProof) return `LP proof: Open Check — Concentrated liquidity detected. Controller/position evidence: ${proof.state}.`;
    return "LP proof: Open Check — Concentrated liquidity detected. Standard LP-token lock/burn proof does not apply. Position/controller proof is still Open Check.";
  }
  if (status === "locked" || lp.lockStatus === "locked") return `LP proof: Locked/Burned — confirmed by LP proof${reason ? ` (${reason})` : ""}`;
  if (status === "burned" || lp.burnStatus === "burned") return `LP proof: Locked/Burned — confirmed by LP proof${reason ? ` (${reason})` : ""}`;
  if (status === "team_controlled" || status === "wallet_controlled") return `LP proof: Team Controlled — LP tokens appear wallet-controlled${reason ? ` (${reason})` : ""}`;
  if (status === "partial") return `LP proof: Partial — ${reason ?? "secondary LP exposure found but primary LP proof not fully confirmed."}`;
  if (status === "open_check" || status === "unverified") return `LP proof: Open Check — ${reason ?? "not confirmed"}`;
  return `LP proof: ${status}${reason ? ` — ${reason}` : ""}`;
}

// Canonical verdict values — Clark must never emit any other string (and never a
// combined phrase like "Open Check / Caution based on available evidence").
export type ClarkVerdict = "Avoid" | "Caution" | "Open Check" | "Cleaner";

function verdictLabel(ev: TokenScanEvidence): ClarkVerdict {
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;
  if (sec?.honeypot === true) return "Avoid";
  if (sec?.riskLevel === "high") return "Caution";
  if (isConcentratedLp(lp) && !concentratedControllerProofStatus(lp).hasProof) return "Open Check";
  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") return "Caution";
  if (sec?.mintable === true && sec?.ownerRenounced === false) return "Caution";
  // Active (non-renounced) owner is a confirmed risk signal on its own, even without a
  // confirmed mint flag — the owner can still change behavior the token can't undo.
  if (sec?.ownerRenounced === false) return "Caution";
  if (h?.top10 != null && h.top10 > 80) return "Caution";
  if (sec?.honeypot === false && sec?.ownerRenounced === true && (lp?.status === "locked" || lp?.status === "burned")) return "Cleaner";
  return "Open Check";
}

// Public, structured verdict for the JSON response (data.verdict/data.confidence/data.source).
// Must stay in sync with the human-readable "Verdict:" line produced by verdictLabel() above —
// both read the same TokenScanEvidence fields, so they can never disagree. Always one of the
// four canonical ClarkVerdict values — never a combined phrase.
export function tokenScanVerdictMeta(ev: TokenScanEvidence, usableEvidence: boolean): {
  verdict: ClarkVerdict;
  confidence: "full" | "partial" | "none";
  source: "token_core" | "fallback";
} {
  const label = verdictLabel(ev);
  const confidence: "full" | "partial" | "none" = ev.ok ? "full" : usableEvidence ? "partial" : "none";
  const verdict: ClarkVerdict = !usableEvidence ? "Open Check" : label;
  return {
    verdict,
    confidence,
    source: usableEvidence ? "token_core" : "fallback",
  };
}

// Distinguishes "honeypot specifically wasn't returned" from "the whole security check
// failed" — tax data alone never implies a honeypot result, and a missing honeypot result
// never implies tax data is also missing. Never fakes a honeypot verdict from tax data alone.
export function formatTokenSecurityStatus(sec: NonNullable<TokenScanEvidence["security"]>): string {
  if (sec.honeypot === false) return "Honeypot not detected";
  if (sec.honeypot === true) return "Honeypot detected";
  if (sec.buyTax != null || sec.sellTax != null) return "Tax data returned, honeypot simulation unavailable";
  // simulationStatus explains why no honeypot verdict exists — prefer it over
  // the generic securityStatus field.
  if (sec.simulationStatus === "not_supported") return "Open Check — Security simulation unavailable.";
  if (sec.simulationStatus === "timeout" || sec.simulationStatus === "timed_out") return "Open Check — Simulation timed out.";
  if (sec.simulationStatus === "failed" || sec.simulationStatus === "unavailable") return "Open Check — Security simulation unavailable.";
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
    lines.push(`- Security: ${formatTokenSecurityStatus(sec)}`);
    if (sec.buyTax != null || sec.sellTax != null) lines.push(`- Buy tax: ${fmtTaxPct(sec.buyTax)} / Sell tax: ${fmtTaxPct(sec.sellTax)}`);
    if (sec.mintable != null) lines.push(`- Mintable: ${sec.mintable ? "YES" : "no"}`);
    if (sec.ownerRenounced != null) lines.push(`- Ownership: ${sec.ownerRenounced ? "renounced" : "active owner"}`);
    if (sec.proxy != null) lines.push(`- Proxy: ${sec.proxy ? "YES" : "no"}`);
  }

  const { verdict } = tokenScanVerdictMeta(ev, hasUsableTokenEvidence(ev));
  lines.push(`- Verdict: ${verdict}`);
  if (verdict === "Open Check") {
    const reasons: string[] = [];
    if (!sec || sec.honeypot == null) reasons.push("Security simulation unavailable");
    if (isConcentratedLp(ev.lpControl) && !concentratedControllerProofStatus(ev.lpControl).hasProof) reasons.push("Concentrated LP position/controller proof unavailable");
    if (h?.top1 != null && h.top1 >= 40) reasons.push(`Major single-wallet dominance: top-1 holder ${h.top1.toFixed(1)}%`);
    if (h?.top10 != null && h.top10 >= 40) reasons.push(`Elevated holder concentration: top-10 ${h.top10.toFixed(1)}%`);
    if (reasons.length) lines.push(`- Reasons: ${reasons.join("; ")}`);
  }

  // Filter raw field-name tokens (e.g. "honeypot", "buyTax") out of the warnings dump —
  // only surface real sentences, since those tokens are already covered by the
  // precise Security/Open-Check lines above.
  const sentenceWarnings = (ev.warnings ?? []).filter(w => /\s/.test(w));
  if (sentenceWarnings.length > 0) lines.push(`- Note: ${sentenceWarnings.join("; ")}`);

  lines.push("");
  lines.push(`Next: Ask "is it safe", "can dev rug", "explain LP", or "why high risk"`);
  lines.push("CTA: Open Token Scanner");
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
  lines.push("CTA: Open Token Scanner");
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
    openChecks.push(`Honeypot/security: ${sec ? formatTokenSecurityStatus(sec).replace(/^Open Check — /, "") : "Security simulation unavailable."}`);
    openTopics.push("honeypot/security");
  }

  const lpConcentrated = isConcentratedLp(lp);
  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") {
    risks.push("LP wallet/team controlled — liquidity can be pulled.");
  } else if (lpConcentrated) {
    visible.push("LP: concentrated pool; standard LP-token lock/burn proof does not apply.");
    const proof = concentratedControllerProofStatus(lp);
    if (proof.hasProof) visible.push(`LP controller/position evidence: ${proof.state}.`);
    else openChecks.push("LP proof is open check — position/controller proof is unavailable in this read.");
  } else if (lp && lp.status && lp.status !== "open_check" && lp.status !== "unverified") {
    visible.push(`${lpStatusLine(ev)}.`);
  } else {
    openChecks.push("LP proof: not confirmed.");
    openTopics.push("LP control");
  }

  if (h?.top1 != null) {
    if (h.top1 >= 40) risks.push(`Major single-wallet dominance: top-1 holder controls ${h.top1.toFixed(1)}% of supply.`);
    else if (h.top1 >= 20) risks.push(`Top-1 holder controls ${h.top1.toFixed(1)}% of supply — concentration risk.`);
  }
  if (h?.top10 != null) {
    if (h.top10 >= 40) risks.push(`Elevated holder concentration: top-10 holders control ${h.top10.toFixed(1)}% of supply.`);
    else visible.push(`Holders: top-10 at ${h.top10.toFixed(1)}%.`);
  } else {
    openChecks.push("Holders: holder concentration not confirmed.");
    openTopics.push("holder concentration");
  }

  if (sec?.ownerRenounced === false) {
    risks.push(sec?.mintable === true ? "Owner can mint new tokens — supply risk." : "Ownership: active owner — privileged functions may still be callable.");
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

  if (sec?.mintable === false) visible.push("Mintable: no.");
  if (sec?.proxy === false) visible.push("Proxy: no.");

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
    if (risks.length > 0) lines.push(`Clark marks this ${verdict} because ${risks.map(r => r.split(" — ")[0].toLowerCase()).join(" and ")} still needs verification.`);
    else lines.push(`Clark can't mark this as safe until ${openTopics.join(", ")} ${openTopics.length > 1 ? "are" : "is"} confirmed.`);
  } else if (risks.length > 0) {
    lines.push("Confirmed risk signals are present — this is not a safe call.");
  } else {
    lines.push("No confirmed red flags from available checks. This is evidence-based routing, not financial advice.");
  }

  lines.push("", "CTA: Open Token Scanner");
  return lines.join("\n");
}

export function formatTokenAnalystFollowup(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;
  const mkt = ev.market;
  const meta = tokenScanVerdictMeta(ev, hasUsableTokenEvidence(ev));
  const bull: string[] = [];
  const bear: string[] = [];
  const gaps: string[] = [];

  if (mkt?.liquidity != null) bull.push(`Liquidity visible: ${fmtUsdShort(mkt.liquidity)}.`);
  else gaps.push("Liquidity depth not confirmed.");
  if (mkt?.volume24h != null) bull.push(`24h volume visible: ${fmtUsdShort(mkt.volume24h)}.`);
  if (sec?.honeypot === false) bull.push("Honeypot simulation did not flag a honeypot.");
  if (sec?.ownerRenounced === true) bull.push("Ownership is renounced.");
  if (lp?.status === "locked" || lp?.status === "burned") bull.push(`LP status: ${lp.status}.`);

  if (sec?.honeypot === true) bear.push("Honeypot flag detected.");
  if (sec?.ownerRenounced === false) bear.push("Ownership is active.");
  if (sec?.mintable === true) bear.push("Mint authority is present.");
  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") bear.push("LP is wallet/team controlled.");
  if (h?.top1 != null && h.top1 >= 40) bear.push(`Major single-wallet dominance: top-1 holder controls ${h.top1.toFixed(1)}% of supply.`);
  else if (h?.top1 != null && h.top1 >= 20) bear.push(`Top-1 holder controls ${h.top1.toFixed(1)}% of supply.`);
  if (h?.top10 != null && h.top10 >= 40) bear.push(`Elevated holder concentration: top-10 holders control ${h.top10.toFixed(1)}% of supply.`);
  if (!h || h.top10 == null) gaps.push("Holder concentration not confirmed.");
  if (!lp || !lp.status || lp.status === "open_check" || lp.status === "unverified") gaps.push("LP control/lock proof not confirmed.");
  if (!sec || sec.honeypot == null) gaps.push("Honeypot/security simulation not confirmed.");

  const biggestRisk = bear[0] ?? gaps[0] ?? "No single confirmed red flag in cached evidence.";
  const quickTake = meta.verdict === "Avoid" ? "Avoid until the confirmed risk is resolved."
    : bear.length > 0 ? "Caution — confirmed risk signals exist."
    : gaps.length > 0 ? "Open check — do not treat it as safe yet."
    : "No confirmed red flags in cached evidence.";

  return [
    `QUICK TAKE — ${sym} (${chain})`,
    quickTake,
    "",
    "WHY",
    `- Verdict: ${meta.verdict}`,
    `- Confidence: ${meta.confidence}`,
    "",
    "BULL CASE",
    ...(bull.length ? bull.map(x => `- ${x}`) : ["- No strong bull case was proven by cached evidence."]),
    "",
    "BEAR CASE",
    ...(bear.length ? bear.map(x => `- ${x}`) : ["- No confirmed bear-case red flag in cached evidence."]),
    "",
    "BIGGEST RISK",
    `- ${biggestRisk}`,
    "",
    "NEXT ACTION",
    `- ${gaps.length ? `Resolve open checks: ${gaps.slice(0, 3).join("; ")}` : "Use Token Scanner / LP Check before making any trade decision."}`,
  ].join("\n");
}


export function formatDevRugCheck(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;

  const conclusion = sec?.ownerRenounced === true && sec?.mintable === false && sec?.proxy === false
    ? "Conclusion: Contract-level rug powers look reduced because ownership is renounced, minting is disabled, and no proxy is detected. But that does not clear liquidity or holder-distribution risk."
    : sec?.honeypot === true || sec?.mintable === true || sec?.ownerRenounced === false || sec?.proxy === true
    ? "Conclusion: Dev/rug risk is not cleared — contract-control risk signals are present in this read."
    : "Conclusion: Dev/rug risk is Open Check — available evidence is not enough to clear contract control, LP control, and holder-distribution risk.";

  const lines = [`DEV/RUG CHECK — ${sym} (${chain})`, "", conclusion, ""];

  if (sec?.ownerRenounced != null) lines.push(`- Ownership: ${sec.ownerRenounced ? "renounced — owner cannot call privileged functions" : "NOT renounced — active owner present"}`);
  else lines.push("- Ownership: open check — renounce status not confirmed");

  if (sec?.mintable != null) lines.push(`- Mint authority: ${sec.mintable ? "YES — new tokens can be minted" : "no mint authority detected"}`);
  else lines.push("- Mint authority: open check");

  if (sec?.proxy != null) lines.push(`- Proxy/upgradeable: ${sec.proxy ? "YES — contract logic can be replaced" : "no proxy detected"}`);
  else lines.push("- Proxy/upgradeable: open check");

  if (lp) {
    const controlled = lp.status === "wallet_controlled" || lp.status === "team_controlled";
    lines.push(`- LP control: ${controlled ? "wallet/team controlled — dev can pull liquidity" : isConcentratedLp(lp) ? "concentrated liquidity — standard LP lock/burn proof does not apply; position/controller proof required." : (lp.status === "locked" || lp.status === "burned" ? "locked/burned — pull risk reduced" : `open check (${lp.status ?? "unverified"})`)}`);
  } else {
    lines.push("- LP control: open check — not verified");
  }

  if (h?.top1 != null) lines.push(`- Top-1 holder: ${h.top1.toFixed(1)}% of supply`);
  else lines.push("- Top-1 holder: open check");

  if (h?.top10 != null) lines.push(`- Top-10 holders: ${h.top10.toFixed(1)}% of supply${h.top10 >= 40 ? " — elevated concentration" : ""}`);

  const missingChecks: string[] = [];
  if (sec?.ownerRenounced == null) missingChecks.push("ownership status");
  if (sec?.mintable == null) missingChecks.push("mint authority");
  if (!lp) missingChecks.push("LP controller identity");
  if (missingChecks.length > 0) lines.push("", `- Missing evidence: ${missingChecks.join(", ")}`);

  lines.push("", "CTA: Review Dev Control / Open Token Scanner");
  return lines.join("\n");
}

export function formatLpLockCheck(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const lp = ev.lpControl;
  const mkt = ev.market;

  const lead = (() => {
    if (!lp) return "LP proof not confirmed";
    if (isConcentratedLp(lp)) return "Concentrated liquidity / protocol-specific proof required";
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

  if (isConcentratedLp(lp)) {
    lines.push(`- Primary liquidity: ${concentratedLpPrimary(lp)}`);
    lines.push("- Lock/burn proof: Not Applicable — standard ERC-20 LP-token lock/burn proof does not apply.");
    {
      const proof = concentratedControllerProofStatus(lp);
      lines.push(`- Control proof: ${proof.hasProof ? `Controller/position evidence: ${proof.state}` : "Position/controller proof is still Open Check."}`);
    }
    lines.push("- Exit risk: Monitor / Watch based on current LP evidence.");
    if (mkt?.liquidity != null) lines.push(`- Liquidity depth: ${fmtUsdShort(mkt.liquidity)}`);
    else lines.push("- Liquidity depth: open check");
    const hasControllerProof = concentratedControllerProofStatus(lp).hasProof;
    lines.push(`- Confidence: ${hasControllerProof ? (lp?.confidence ?? "partial") : "open_check"}`);
    lines.push("", "CTA: Run LP Check");
    return lines.join("\n");
  }

  if (mkt?.liquidity != null) lines.push(`- Liquidity depth: ${fmtUsdShort(mkt.liquidity)} (not the same as lock safety)`);
  else lines.push("- Liquidity depth: open check");

  if (lp?.reason) lines.push(`- Lock/burn detail: ${lp.reason}`);
  if (lp?.confidence) lines.push(`- Confidence: ${lp.confidence}`);

  const missing: string[] = [];
  if (!lp || lp.status === "unverified") missing.push("LP lock/burn proof");
  if (!lp?.reason) missing.push("controller/holder identity");
  if (missing.length > 0) lines.push(`- Missing: ${missing.join(", ")}`);

  lines.push("", "CTA: Run LP Check")
  return lines.join("\n");
}

export function formatRiskExplanation(ev: TokenScanEvidence, chain = "Base"): string {
  const sym = String(ev.token?.symbol ?? "?").toUpperCase();
  const sec = ev.security;
  const h = ev.holders;
  const lp = ev.lpControl;

  const verdict = tokenScanVerdictMeta(ev, hasUsableTokenEvidence(ev)).verdict;

  // Main risk signals: the confirmed evidence that actually drives the verdict —
  // never inferred, never present unless the underlying field has a real value.
  const mainSignals: string[] = [];
  if (lp?.status === "wallet_controlled" || lp?.status === "team_controlled") {
    const label = lp.status === "team_controlled" ? "Team Controlled" : "Wallet Controlled";
    mainSignals.push(`LP control: ${label}${lp.reason ? ` — ${lp.reason}` : ""}`);
  } else if (isConcentratedLp(lp)) {
    mainSignals.push("LP control: concentrated liquidity — position/controller proof is Open Check.");
  } else if (lp?.status === "open_check" || lp?.status === "unverified") {
    mainSignals.push(`LP control: Open Check${lp.reason ? ` — ${lp.reason}` : ""}`);
  }
  if (sec?.honeypot === true) mainSignals.push("Honeypot: detected — buy/sell simulation flagged a trap.");
  if (sec?.mintable === true) mainSignals.push(`Mint authority: YES — new tokens can be minted${sec?.ownerRenounced === false ? " and the owner is still active." : "."}`);
  if (sec?.proxy === true) mainSignals.push("Proxy/upgradeable: YES — contract logic can be replaced by the deployer.");
  if (sec?.ownerRenounced === false) mainSignals.push("Ownership: NOT renounced — an active owner can still call privileged functions.");
  if (h?.top1 != null && h.top1 >= 40) mainSignals.push(`Major single-wallet dominance: top-1 holder controls ${h.top1.toFixed(1)}% of supply.`);
  else if (h?.top1 != null && h.top1 >= 20) mainSignals.push(`Single-wallet dominance: top-1 holder controls ${h.top1.toFixed(1)}% of supply.`);
  if (h?.top10 != null && h.top10 >= 40) mainSignals.push(`Elevated holder concentration: top-10 holders control ${h.top10.toFixed(1)}% of supply.`);
  if (sec?.buyTax != null && sec.buyTax > 10) mainSignals.push(`High buy tax: ${fmtTaxPct(sec.buyTax)}.`);
  if (sec?.sellTax != null && sec.sellTax > 10) mainSignals.push(`High sell tax: ${fmtTaxPct(sec.sellTax)}.`);

  // Positive / lower-risk signals: confirmed evidence that reduces risk, shown so the
  // verdict reads as a balance of evidence rather than a single flag.
  const positiveSignals: string[] = [];
  if (sec?.honeypot === false) positiveSignals.push("Honeypot: not detected.");
  if (sec?.buyTax != null || sec?.sellTax != null) positiveSignals.push(`Taxes: buy ${fmtTaxPct(sec?.buyTax)} / sell ${fmtTaxPct(sec?.sellTax)}.`);
  if (sec?.ownerRenounced === true) positiveSignals.push("Ownership: renounced.");
  if (sec?.proxy === false) positiveSignals.push("Proxy: no proxy detected.");
  if (lp?.status === "locked" || lp?.status === "burned") positiveSignals.push(`LP control: ${lp.status === "burned" ? "burned" : "locked"}${lp.reason ? ` — ${lp.reason}` : ""}.`);
  if (sec?.mintable === false) positiveSignals.push("Mint authority: no mint authority detected.");
  if (h?.holderCount != null && !(h?.top1 != null && h.top1 >= 20) && !(h?.top10 != null && h.top10 >= 40)) positiveSignals.push(`Holder base: ${h.holderCount.toLocaleString()} holders.`);

  // Open checks: real fields that are simply missing — never claimed as risk or safety.
  const openChecks: string[] = [];
  if (!lp) openChecks.push("LP lock/burn proof — not yet checked.");
  if (!sec || sec.honeypot == null) openChecks.push(sec ? `Security: ${formatTokenSecurityStatus(sec)}` : "Security: Open Check — Security simulation unavailable.");
  if (sec?.mintable == null) openChecks.push("Mint authority — not verified.");
  if (sec?.proxy == null) openChecks.push("Proxy/upgradeable status — not verified.");
  if (sec?.ownerRenounced == null) openChecks.push("Ownership status — not verified.");
  if (h?.top10 == null) openChecks.push("Holder concentration — not indexed for this chain.");

  const lines = [
    `RISK EXPLANATION — ${sym} (${chain})`,
    "",
    `Verdict: ${verdict}`,
    "",
  ];

  if (mainSignals.length > 0) {
    lines.push("Main risk signals:");
    mainSignals.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }

  if (positiveSignals.length > 0) {
    lines.push("Positive / lower-risk signals:");
    positiveSignals.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }

  if (openChecks.length > 0) {
    lines.push("Open checks:");
    openChecks.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }

  // Read: a plain-language summary of why the verdict landed where it did, built only
  // from the signals already listed above — never a fixed disclaimer.
  const readParts: string[] = [];
  if (mainSignals.length > 0) {
    readParts.push(`Clark marks this ${verdict} mainly because ${mainSignals.map((s) => s.split(":")[0].toLowerCase()).join(" and ")} ${mainSignals.length > 1 ? "are" : "is"} the key risk driver${mainSignals.length > 1 ? "s" : ""}.`);
  } else if (verdict === "Cleaner") {
    readParts.push("Clark marks this Cleaner because the confirmed evidence above came back clean — no honeypot, an active lock/burn or renounced ownership, and no severe flags.");
  } else {
    readParts.push("Clark has not confirmed a specific risk driver from the evidence collected so far.");
  }
  if (positiveSignals.length > 0) readParts.push(`${positiveSignals.length > 1 ? "Some checks" : "One check"} look${positiveSignals.length > 1 ? "" : "s"} cleaner, but that does not offset the open risk above.`);
  if (openChecks.length > 0) readParts.push("Some evidence is still an open check rather than confirmed safe.");
  lines.push("Read:", readParts.join(" "), "");

  lines.push("CTA: Open Token Scanner / Run LP Check");
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
