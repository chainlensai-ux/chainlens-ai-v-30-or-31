// Pure, server-side routing/classification/formatting helpers for the Clark chat handler.
// No Next.js / Anthropic SDK dependencies — importable directly by unit test scripts (node + .ts via tsx/ts-node-less import).

export type DashboardMarketRow = {
  symbol: string;
  name?: string;
  chain?: string;
  priceUsd?: number;
  change24h?: number;
  volume24hUsd?: number;
  marketCapUsd?: number;
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
  | "liquidity_scan"
  | "whale_alert"
  | "none";

const EOA_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/;

export function extractAddressForRouting(text: string): string | null {
  const m = text.match(EOA_ADDRESS_RE);
  return m ? m[0] : null;
}

/**
 * Classify a free-form Clark prompt into one of the new routed intents.
 * Returns "none" when the prompt does not match any of the new routing rules
 * (callers should fall back to the existing detectIntent()/detectLiveIntent()).
 */
export function classifyClarkPrompt(prompt: string): {
  intent: ClarkRoutedIntent;
  address: string | null;
  deep: boolean;
} {
  const raw = prompt ?? "";
  const t = raw.trim().toLowerCase().replace(/[‘’ʼ´`]/g, "'");
  const address = extractAddressForRouting(raw);

  // ---- LP / liquidity check (classify by phrase; contract-vs-EOA decided by caller via eth_getCode) ----
  if (/\b(lp\s+check|liquidity\s+check)\b/i.test(t) && address) {
    return { intent: "liquidity_scan", address, deep: false };
  }

  // ---- Wallet scan ----
  const deepWalletRe = /\b(deep\s+scan|full\s+scan|pnl|trades?|historical)\b/i;
  const walletScanRe = /\b(scan\s+(?:this\s+)?wallet|scan\s+wallet)\b/i;
  if (address && (walletScanRe.test(t) || deepWalletRe.test(t))) {
    return { intent: "wallet_scan", address, deep: deepWalletRe.test(t) };
  }
  // Plain EOA address alone (no other strong intent keywords) → wallet scan
  if (address) {
    const hasOtherStrongIntent =
      /\b(lp\s+check|liquidity\s+check|liquidity|radar|pumping|trending|movers|whale|smart\s+money)\b/i.test(t);
    if (!hasOtherStrongIntent) {
      return { intent: "wallet_scan", address, deep: deepWalletRe.test(t) };
    }
  }

  // ---- Base Radar (anything containing "radar") ----
  if (/\bradar\b/i.test(t)) {
    return { intent: "base_radar", address: null, deep: false };
  }

  // ---- Base market discovery (generic "pumping/trending on base", no "radar") ----
  const BASE_MARKET_DISCOVERY_RE =
    /(what'?s\s+pumping\s+on\s+base|base\s+pumps|trending\s+base|base\s+(?:movers|trending)|new\s+base\s+pools|what'?s\s+(?:moving|hot|running|happening)\s+on\s+base|base\s+market|top\s+base\s+tokens|base\s+momentum)/i;
  if (BASE_MARKET_DISCOVERY_RE.test(t)) {
    return { intent: "base_market_discovery", address: null, deep: false };
  }

  // ---- Whale / smart money ----
  if (/\b(whale|whales|big\s+wallet|smart\s+money)\b/i.test(t)) {
    return { intent: "whale_alert", address: null, deep: false };
  }

  return { intent: "none", address, deep: false };
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

  const topMover = [...valid].sort((a, b) => (b.change24h ?? -Infinity) - (a.change24h ?? -Infinity))[0];
  const highestVolume = [...valid].sort((a, b) => (b.volume24hUsd ?? -Infinity) - (a.volume24hUsd ?? -Infinity))[0];
  const majors = valid.filter((r) => MAJOR_BASE_SYMBOLS.has(String(r.symbol ?? "").toUpperCase()));
  const majorsLine = majors.length > 0
    ? majors.slice(0, 4).map((r) => `${String(r.symbol).toUpperCase()} ${fmtPct(r.change24h)}`).join(", ")
    : "No major Base assets reported in current dashboard rows.";

  return [
    "BASE MARKET READ",
    `- Top mover by 24h %: ${String(topMover.symbol).toUpperCase()} (${fmtPct(topMover.change24h)})`,
    `- Highest volume: ${String(highestVolume.symbol).toUpperCase()} (${fmtUsdShort(highestVolume.volume24hUsd)})`,
    `- Major Base assets moving: ${majorsLine}`,
    `- Quick note: Based on the dashboard market view currently open — refresh for the latest pull.`,
    "",
    "CTA: Open Base Radar / Open Token Scanner / Refresh Market Data",
  ].join("\n");
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
};

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
  const chains = result.chainsActive && result.chainsActive.length > 0
    ? result.chainsActive.join(", ")
    : "Base";
  const totalValue = result.totalValue != null ? fmtUsdShort(result.totalValue) : "unverified";

  const lines = [
    "WALLET READ",
    `- Address: ${address}`,
    `- Active chains: ${chains}`,
    `- Holdings count: ${holdings.length}`,
    `- Total value: ${totalValue}`,
  ];
  if (deep) {
    lines.push(`- Activity/PnL status: ${result.txCount != null ? `${result.txCount} transactions in scanned window` : "activity history not available in this pass"}`);
  } else {
    lines.push(`- Activity/PnL status: not requested (use deep scan for activity history)`);
  }
  lines.push(`- Evidence gaps: ${holdings.length === 0 ? "no priced holdings returned" : "holder-level behavior verification not run"}`);
  lines.push("");
  lines.push(`CTA: Open Wallet Scanner${deep ? "" : " / Deep Scan Wallet"}`);
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
  lockBurnProof?: string | null;
  controllerVerification?: string | null;
  liquidityDepth?: string | null;
  exitRisk?: string | null;
  missingEvidence?: string[] | null;
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
    `- Pool model: ${result.poolModel ?? "not verified"}`,
    `- Lock/burn proof: ${result.lockBurnProof ?? "not verified"}`,
    `- Controller/position verification: ${result.controllerVerification ?? "not verified"}`,
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
