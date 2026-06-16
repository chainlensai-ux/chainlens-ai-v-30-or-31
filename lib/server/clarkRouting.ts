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
  | "none";

const WALLET_DEEP_RE = /\b(deep\s+scan|deep|full\s+scan|full\s+wallet\s+scan|scan\s+all\s+chains|pnl|p&l|trades?|historical|dig\s+deeper|recover\s+(?:more\s+)?history|history\s+recovery|why\s+(?:is|are|no|the)\s+pnl|why\s+is\s+pnl\s+(?:missing|zero|wrong)|why\s+no\s+pnl|cost\s+basis|analyze\s+(?:this\s+)?wallet)\b/i;
const WALLET_FOLLOWUP_RE = /\b(dig\s+deeper|why\s+is\s+pnl\s+(?:missing|zero|wrong)|why\s+is\s+the\s+pnl|why\s+no\s+pnl|recover\s+(?:more\s+)?history|what\s+about\s+this\s+wallet|why\s+is\s+history\s+missing|pnl\s+missing|pnl\s+coverage)\b/i;
const WALLET_COMPARE_RE = /\b(compare\s+(?:this\s+)?wallet(?:\s+with|\s+vs|\s+to|\s+and)|compare\s+wallets|wallet\s+comparison|wallet\s+a\s+vs|wallet\s+compare)\b/i;

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
} {
  const raw = prompt ?? "";
  const t = raw.trim().toLowerCase().replace(/[‘’ʼ´`]/g, "'");
  const address = extractAddressForRouting(raw);
  const addresses = extractAllAddressesForRouting(raw);
  const deep = WALLET_DEEP_RE.test(t);

  // ---- Wallet compare (must run before generic wallet_scan) ----
  if (WALLET_COMPARE_RE.test(t)) {
    // Compare needs at least one address (this wallet from memory + the typed one, or two typed)
    if (addresses.length >= 1) {
      return { intent: "wallet_compare", address: addresses[0], addresses, deep };
    }
  }

  // ---- Wallet PnL / history follow-up ("why is pnl missing", "dig deeper", "recover more history") ----
  // These rely on session memory (lastWallet). We still classify them so the caller
  // can resolve the address from memory instead of asking again.
  if (WALLET_FOLLOWUP_RE.test(t)) {
    return { intent: "wallet_pnl_followup", address, addresses, deep: true };
  }

  // ---- LP / liquidity check (classify by phrase; contract-vs-EOA decided by caller via eth_getCode) ----
  if (/\b(lp\s+check|liquidity\s+check)\b/i.test(t) && address) {
    return { intent: "liquidity_scan", address, addresses, deep: false };
  }

  // ---- Wallet scan ----
  const walletScanRe = /\b(scan\s+(?:this\s+)?wallet|scan\s+wallet|analyze\s+(?:this\s+)?wallet|wallet\s+pnl|wallet\s+(?:scan|check|report|analysis))\b/i;
  if (address && (walletScanRe.test(t) || WALLET_DEEP_RE.test(t))) {
    return { intent: "wallet_scan", address, addresses, deep };
  }
  // Plain EOA address alone (no other strong intent keywords) → wallet scan
  if (address) {
    const hasOtherStrongIntent =
      /\b(lp\s+check|liquidity\s+check|liquidity|radar|pumping|trending|movers|whale|smart\s+money)\b/i.test(t);
    if (!hasOtherStrongIntent) {
      return { intent: "wallet_scan", address, addresses, deep };
    }
  }

  // ---- Base Radar (anything containing "radar") ----
  if (/\bradar\b/i.test(t)) {
    return { intent: "base_radar", address: null, addresses, deep: false };
  }

  // ---- Base market discovery (generic "pumping/trending on base", no "radar") ----
  const BASE_MARKET_DISCOVERY_RE =
    /(?:who'?s\s+pumping\s+on\s+base|whos\s+pumping\s+on\s+base|what\s+is\s+pumping\s+on\s+base|what'?s\s+pumping\s+on\s+base|base\s+pairs?\s+(?:are\s+)?pumping|(?:show\s+me\s+)?trending\s+base\s+tokens?|hot\s+base\s+tokens?|base\s+gainers|base\s+pumps|trending\s+base|base\s+(?:movers|trending)|new\s+base\s+pools|what'?s\s+(?:moving|hot|running|happening)\s+on\s+base|base\s+market|top\s+base\s+tokens|base\s+momentum)/i;
  if (BASE_MARKET_DISCOVERY_RE.test(t)) {
    return { intent: "base_market_discovery", address: null, addresses, deep: false };
  }

  // ---- Whale / smart money ----
  if (/\b(whale|whales|big\s+wallet|smart\s+money)\b/i.test(t)) {
    return { intent: "whale_alert", address: null, addresses, deep: false };
  }

  return { intent: "none", address, addresses, deep: false };
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
