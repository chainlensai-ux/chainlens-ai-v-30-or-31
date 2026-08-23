export type ClarkAnalystDomain = "wallet" | "token" | "pump" | "radar" | "whale" | "general" | "unknown";

export type ClarkAnalystRoute =
  | "wallet_scan"
  | "wallet_followup"
  | "token_scan"
  | "token_followup"
  | "pump_feed"
  | "pump_analysis"
  | "base_market"
  | "base_radar"
  | "whale_feed"
  | "whale_explain"
  | "education"
  | "unknown";

export type ClarkAnalystIntent = {
  domain: ClarkAnalystDomain;
  route: ClarkAnalystRoute;
  address: string | null;
  contextDependent: boolean;
  evidenceSource: string | null;
};

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

const GENERAL_RE = /\b(?:explain|what\s+(?:is|are|does))\s+(?:verified\s+pnl|partial\s+pnl|liquidity\s+risk|holder\s+concentration|cortex\s+confidence|wallet\s+scanner|token\s+scanner|base\s+radar|pump\s+alerts?|whale\s+alerts?)\b/i;
const RADAR_RE = /\b(?:base\s+radar|what(?:'s|\s+is)\s+pumping\s+on\s+base|new\s+base\s+tokens?|tokens?\s+(?:with|have|show)\s+strong\s+momentum|strong\s+momentum\s+(?:tokens?|on\s+base)|why\s+is\s+(?:rank\s*)?#?\s*\d+\s+trending|why\s+is\s+(?:token\s+)?number\s+\d+\s+trending|(?:scan|open)\s+(?:token\s+)?(?:number\s+)?\d+)\b/i;
const WHALE_RE = /\b(?:latest\s+whale\s+alerts?|whale\s+alerts?|what\s+did\s+whales?\s+(?:buy|sell)|what\s+are\s+whales?\s+(?:buying|selling)|wallets?\s+(?:are\s+)?accumulating|accumulating\s+wallets?|explain\s+(?:this\s+|that\s+)?whale\s+alert|which\s+(?:whale\s+)?alerts?\s+matter\s+most)\b/i;
const PUMP_RE = /\[mode:\s*pump-alerts\]|\b(?:why\s+is\s+(?:this\s+)?token\s+pumping|pump\s+likely\s+to\s+continue|will\s+(?:this\s+)?pump\s+continue|what\s+could\s+kill\s+(?:this\s+)?pump|buy\/?sell\s+pressure|buy\s+and\s+sell\s+pressure|liquidity\s+change|volume\s+acceleration|top\s+buyers?\/?sellers?|top\s+buyers?\s+and\s+sellers?|pump\s+(?:organic|fake)|organic\s+or\s+fake|what\s+should\s+i\s+watch\s+next)\b/i;
const PUMP_FEED_RE = /\b(?:latest\s+pump\s+alerts?|show\s+pump\s+alerts?|pump\s+alert\s+feed|which\s+pump\s+alerts?\s+matter)\b/i;
const WALLET_RE = /\b(?:wallet|realized\s+pnl|partial\s+pnl|pnl\s+(?:is\s+)?partial|excluded\s+lots?|cost\s+basis|best\/?worst\s+trade|best\s+or\s+worst\s+trade|biggest\s+buys?\/?sells?|biggest\s+buys?\s+and\s+sells?)\b/i;
const WALLET_SCAN_RE = /\b(?:scan|analy[sz]e|check)\s+(?:this\s+)?wallet\b/i;
const TOKEN_RE = /\b(?:token|contract\s+risk|risk\s+score|rug\s+risk|safe\s+to\s+ape|controls?\s+(?:the\s+)?supply|liquidity\s+locked|dev\s+dump|holders?\s+concentrated|lp\s+risk|holder\s+risk)\b/i;
const TOKEN_SCAN_RE = /\b(?:scan|analy[sz]e|check)\s+(?:this\s+)?token\b/i;

/**
 * High-level, unit-testable Clark route audit. It does not execute tools; it identifies the
 * ChainLens surface that owns a question so early chat shortcuts cannot swallow analyst work.
 */
export function classifyClarkAnalystIntent(prompt: string): ClarkAnalystIntent {
  const text = String(prompt ?? "").trim();
  const address = text.match(ADDRESS_RE)?.[0] ?? null;
  const result = (domain: ClarkAnalystDomain, route: ClarkAnalystRoute, contextDependent: boolean, evidenceSource: string | null): ClarkAnalystIntent => ({
    domain, route, address, contextDependent, evidenceSource,
  });

  if (!text) return result("unknown", "unknown", false, null);
  if (GENERAL_RE.test(text)) return result("general", "education", false, "ChainLens glossary");
  if (RADAR_RE.test(text)) return result("radar", /\bradar\b/i.test(text) ? "base_radar" : "base_market", /\b(?:why|scan|open)\b/i.test(text), "Base market/Radar feed");
  if (WHALE_RE.test(text)) return result("whale", /\bexplain\b/i.test(text) ? "whale_explain" : "whale_feed", /\bexplain\b/i.test(text), "Whale Alerts feed");
  if (PUMP_FEED_RE.test(text)) return result("pump", "pump_feed", false, "Pump Alerts feed");
  if (PUMP_RE.test(text)) return result("pump", "pump_analysis", !address, "Pump Intelligence report");
  if (WALLET_RE.test(text)) return result("wallet", WALLET_SCAN_RE.test(text) ? "wallet_scan" : "wallet_followup", !address && !WALLET_SCAN_RE.test(text), "Wallet Scanner");
  if (TOKEN_RE.test(text)) return result("token", TOKEN_SCAN_RE.test(text) ? "token_scan" : "token_followup", !address && !TOKEN_SCAN_RE.test(text), "Token Scanner");
  return result("unknown", "unknown", false, null);
}

export function isChainLensAnalystPrompt(prompt: string): boolean {
  const intent = classifyClarkAnalystIntent(prompt);
  return intent.domain !== "unknown" && intent.route !== "education";
}
