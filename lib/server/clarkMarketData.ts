// Clark live market data — simple market questions ("What is ETH price?", "PEPE market cap?",
// "Show SOL volume", "price of this CA") answered from real live providers, never invented.
//
// PROVIDER ORDER, per spec:
//   1. ChainLens active scan/session context (whatever token the user is already looking at)
//   2. Token Scanner API, when the user gave a contract address
//   3. DexScreener/GeckoTerminal, for token/pair/address data
//   4. CoinGecko, for top-1000/common symbols
//   5. Cached market snapshot, only when every live provider above failed
//
// This module is pure orchestration — every provider is injected by the caller (see
// defaultClarkMarketProviders below for the real, network-calling implementations) so the
// resolution logic itself (provider order, caching, ambiguous-symbol handling, FDV-vs-market-cap
// separation) is unit-testable without a live network. Never fabricates a price/market cap/FDV —
// a field the provider didn't return stays `null`, which the formatter renders as "unverified",
// never "$0" (USD unavailable is not the same fact as USD = 0).

export type ClarkMarketIntent =
  | "live_price"
  | "market_cap"
  | "fdv"
  | "volume"
  | "price_change"
  | "trending_reason"
  | "token_lookup"
  | "compare_tokens";

export interface ClarkMarketQuote {
  provider: "chainlens_session" | "token_scanner_api" | "dexscreener" | "geckoterminal" | "coingecko" | "cache";
  name: string | null;
  symbol: string | null;
  address: string | null;
  chainId: number | null;
  chain: string | null;
  priceUsd: number | null;
  change24hPct: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  fetchedAt: number;
}

export interface ClarkMarketDataProviders {
  /** Whatever token the user is already scanning/viewing in this session — never a network call. */
  sessionContext?: () => ClarkMarketQuote | null;
  /** Token Scanner's own /api/token evidence — only called when a contract address is present. */
  tokenScannerApi?: (address: string, chain: string | null) => Promise<ClarkMarketQuote | null>;
  /** DexScreener — token/pair/address lookup, and a symbol search that can return multiple matches. */
  dexScreener?: (symbolOrAddress: string, chain: string | null) => Promise<{ quote: ClarkMarketQuote; matches: ClarkMarketQuote[] } | null>;
  /** GeckoTerminal — address-keyed pool/token data, used when DexScreener has nothing. */
  geckoTerminal?: (address: string, chain: string | null) => Promise<ClarkMarketQuote | null>;
  /** CoinGecko — top-1000/common-symbol lookup; can also return multiple ambiguous matches. */
  coingecko?: (symbol: string) => Promise<{ quote: ClarkMarketQuote; matches: ClarkMarketQuote[] } | null>;
}

export interface ClarkMarketDataAudit {
  prompt: string;
  intent: ClarkMarketIntent | null;
  symbolOrAddress: string | null;
  chainId: number | null;
  providersTried: string[];
  providerUsed: string | null;
  cacheHit: boolean;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  finalStatus: "resolved" | "ambiguous_symbol" | "unavailable";
  finalReason: string;
}

export interface ClarkMarketResolution {
  quote: ClarkMarketQuote | null;
  ambiguousMatches: ClarkMarketQuote[] | null;
  audit: ClarkMarketDataAudit;
}

// Module-lifetime cache only — best-effort, never a substitute for a live read. Keyed by
// provider-independent identity (chainId + tokenAddress, or bare symbol) per spec ("cache by
// provider + chainId + tokenAddress/symbol").
const MARKET_CACHE_TTL_MS = 10 * 60 * 1000;
const marketDataCache = new Map<string, { quote: ClarkMarketQuote; cachedAt: number }>();

function cacheKey(chainId: number | null, addressOrSymbol: string): string {
  return `${chainId ?? "none"}:${addressOrSymbol.toLowerCase()}`;
}

function rememberQuote(chainId: number | null, addressOrSymbol: string, quote: ClarkMarketQuote): void {
  marketDataCache.set(cacheKey(chainId, addressOrSymbol), { quote, cachedAt: Date.now() });
}

function recallFreshQuote(chainId: number | null, addressOrSymbol: string): ClarkMarketQuote | null {
  const hit = marketDataCache.get(cacheKey(chainId, addressOrSymbol));
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > MARKET_CACHE_TTL_MS) return null;
  return hit.quote;
}

// ── Intent classification ───────────────────────────────────────────────────────────────────
const MARKET_COMPARE_RE = /\bcompare\b.*\b(and|vs\.?|versus)\b|\bvs\.?\b.*\bprice\b/i;
const MARKET_FDV_RE = /\bfdv\b|fully\s+diluted/i;
const MARKET_MCAP_RE = /\bmarket\s*cap\b|marketcap|\bmcap\b/i;
const MARKET_VOLUME_RE = /\b(24h\s*)?volume\b|\btrading\s+volume\b/i;
const MARKET_CHANGE_RE = /\bdoing\s+today\b|\b24h\s*change\b|\bhow'?s?\s+it\s+doing\b|\bperformance\s+today\b|\bup\s+or\s+down\b/i;
const MARKET_PUMP_RE = /\b(pumping|mooning|dumping|crashing)\b|\bwhy\s+is\s+(?:it|this|the\s+token)\s+(?:up|down|pumping|dumping|mooning|crashing)\b/i;
const MARKET_PRICE_RE = /\bprice\b|\bhow\s+much\s+is\b|\bworth\b|\btrading\s+at\b|\bwhat'?s?\s+(?:the\s+)?price\b/i;
const MARKET_LOOKUP_RE = /\bwhat\s+is\b|\btell\s+me\s+about\b|\bwhat'?s\s+(?:up\s+with|going\s+on\s+with)\b/i;

/** Returns null when the prompt is not a simple live-market question at all — callers should
 * fall through to the existing (unrelated) routing in that case. */
export function classifyClarkMarketIntent(prompt: string): ClarkMarketIntent | null {
  const t = String(prompt ?? "");
  if (!t.trim()) return null;
  if (MARKET_COMPARE_RE.test(t)) return "compare_tokens";
  if (MARKET_MCAP_RE.test(t)) return "market_cap";
  if (MARKET_FDV_RE.test(t)) return "fdv";
  if (MARKET_VOLUME_RE.test(t)) return "volume";
  if (MARKET_PUMP_RE.test(t)) return "trending_reason";
  if (MARKET_CHANGE_RE.test(t)) return "price_change";
  if (MARKET_PRICE_RE.test(t)) return "live_price";
  if (MARKET_LOOKUP_RE.test(t)) return "token_lookup";
  return null;
}

const MARKET_SYMBOL_STOPWORDS = new Set([
  "THE", "WHAT", "WHATS", "IS", "ITS", "PRICE", "MARKET", "CAP", "MARKETCAP", "MCAP", "FDV",
  "VOLUME", "TODAY", "THIS", "FOR", "AND", "SHOW", "TELL", "ME", "ABOUT", "OF", "TOKEN", "CA",
  "COIN", "A", "AN", "WHY", "PUMPING", "MOONING", "DUMPING", "CRASHING", "UP", "DOWN", "DOING",
  "HOWS", "HOW", "IT", "ON", "IN", "TO", "VS", "VERSUS", "COMPARE", "WORTH", "TRADING", "AT",
  "GOING", "WITH", "FULLY", "DILUTED", "PERFORMANCE",
]);

/** Extracts a real ticker candidate from a market-question prompt — prefers an explicit
 * $-prefixed ticker, otherwise the first non-stopword all-caps-ish token. Never invents a
 * symbol when none is present (returns null so the caller can ask for clarification instead). */
export function extractClarkMarketSymbol(prompt: string): string | null {
  const t = String(prompt ?? "");
  const dollarMatch = t.match(/\$([A-Za-z]{2,10})\b/);
  if (dollarMatch) return dollarMatch[1].toUpperCase();
  const words = t.match(/\b[A-Za-z]{2,10}\b/g) ?? [];
  for (const w of words) {
    const upper = w.toUpperCase();
    if (MARKET_SYMBOL_STOPWORDS.has(upper)) continue;
    return upper;
  }
  return null;
}

const CA_PRONOUN_RE = /\bthis\s+(?:ca|contract|token|coin)\b/i;

/** True when the prompt refers to "this CA"/"this token" rather than naming a symbol/address —
 * the caller should resolve the subject from session/scan context, not from prompt text. */
export function isClarkMarketPronounReference(prompt: string): boolean {
  return CA_PRONOUN_RE.test(String(prompt ?? ""));
}

// ── Resolution ───────────────────────────────────────────────────────────────────────────────
export interface ClarkMarketResolveInput {
  prompt: string;
  intent: ClarkMarketIntent | null;
  /** Set when the prompt (or session memory, for a "this CA" pronoun) names a contract address. */
  address: string | null;
  /** Set when the prompt names a symbol and no address is present. */
  symbol: string | null;
  chainId: number | null;
  chain: string | null;
}

function emptyAudit(input: ClarkMarketResolveInput, finalStatus: ClarkMarketDataAudit["finalStatus"], finalReason: string, providersTried: string[] = [], providerUsed: string | null = null, cacheHit = false): ClarkMarketDataAudit {
  return {
    prompt: input.prompt,
    intent: input.intent,
    symbolOrAddress: input.address ?? input.symbol,
    chainId: input.chainId,
    providersTried,
    providerUsed,
    cacheHit,
    priceUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    volume24hUsd: null,
    liquidityUsd: null,
    finalStatus,
    finalReason,
  };
}

function auditFromQuote(input: ClarkMarketResolveInput, quote: ClarkMarketQuote, providersTried: string[], cacheHit: boolean): ClarkMarketDataAudit {
  return {
    prompt: input.prompt,
    intent: input.intent,
    symbolOrAddress: input.address ?? input.symbol,
    chainId: quote.chainId ?? input.chainId,
    providersTried,
    providerUsed: quote.provider,
    cacheHit,
    priceUsd: quote.priceUsd,
    marketCapUsd: quote.marketCapUsd,
    fdvUsd: quote.fdvUsd,
    volume24hUsd: quote.volume24hUsd,
    liquidityUsd: quote.liquidityUsd,
    finalStatus: "resolved",
    finalReason: `Resolved from ${quote.provider}.`,
  };
}

/** Single entry point: tries every provider in the required order, caches a resolved quote, and
 * always returns a fully-populated audit object — never a bare "unavailable" with no reason. */
export async function resolveClarkMarketData(
  input: ClarkMarketResolveInput,
  providers: ClarkMarketDataProviders,
): Promise<ClarkMarketResolution> {
  const providersTried: string[] = [];
  const subject = input.address ?? input.symbol;
  if (!subject) {
    return { quote: null, ambiguousMatches: null, audit: emptyAudit(input, "unavailable", "No token symbol or contract address was found in the question.") };
  }

  // 1. ChainLens active scan/session context — never a network call, so it's tried first and
  // doesn't count against "providers tried" in the network sense, but is still recorded.
  if (providers.sessionContext) {
    providersTried.push("chainlens_session");
    const sessionQuote = providers.sessionContext();
    if (sessionQuote) {
      rememberQuote(sessionQuote.chainId ?? input.chainId, subject, sessionQuote);
      return { quote: sessionQuote, ambiguousMatches: null, audit: auditFromQuote(input, sessionQuote, providersTried, false) };
    }
  }

  // 2. Token Scanner API — only meaningful when a contract address is present.
  if (input.address && providers.tokenScannerApi) {
    providersTried.push("token_scanner_api");
    const quote = await providers.tokenScannerApi(input.address, input.chain).catch(() => null);
    if (quote) {
      rememberQuote(quote.chainId ?? input.chainId, subject, quote);
      return { quote, ambiguousMatches: null, audit: auditFromQuote(input, quote, providersTried, false) };
    }
  }

  // 3. DexScreener / GeckoTerminal — token/pair/address data, and a symbol search that may be
  // ambiguous (multiple real projects share a ticker) rather than a single confident match.
  if (providers.dexScreener) {
    providersTried.push("dexscreener");
    const result = await providers.dexScreener(subject, input.chain).catch(() => null);
    if (result && result.matches.length > 1) {
      return { quote: null, ambiguousMatches: result.matches, audit: emptyAudit(input, "ambiguous_symbol", `Multiple tokens match "${subject}" — ask which one, or show the top matches.`, providersTried) };
    }
    if (result) {
      rememberQuote(result.quote.chainId ?? input.chainId, subject, result.quote);
      return { quote: result.quote, ambiguousMatches: null, audit: auditFromQuote(input, result.quote, providersTried, false) };
    }
  }
  if (input.address && providers.geckoTerminal) {
    providersTried.push("geckoterminal");
    const quote = await providers.geckoTerminal(input.address, input.chain).catch(() => null);
    if (quote) {
      rememberQuote(quote.chainId ?? input.chainId, subject, quote);
      return { quote, ambiguousMatches: null, audit: auditFromQuote(input, quote, providersTried, false) };
    }
  }

  // 4. CoinGecko — top-1000/common-symbol lookup; can also come back ambiguous.
  if (input.symbol && providers.coingecko) {
    providersTried.push("coingecko");
    const result = await providers.coingecko(input.symbol).catch(() => null);
    if (result && result.matches.length > 1) {
      return { quote: null, ambiguousMatches: result.matches, audit: emptyAudit(input, "ambiguous_symbol", `Multiple tokens match "${input.symbol}" — ask which one, or show the top matches.`, providersTried) };
    }
    if (result) {
      rememberQuote(result.quote.chainId ?? input.chainId, subject, result.quote);
      return { quote: result.quote, ambiguousMatches: null, audit: auditFromQuote(input, result.quote, providersTried, false) };
    }
  }

  // 5. Cached market snapshot — only after every live provider above returned nothing.
  const cached = recallFreshQuote(input.chainId, subject);
  if (cached) {
    return { quote: cached, ambiguousMatches: null, audit: { ...auditFromQuote(input, cached, providersTried, true), finalReason: `No live provider responded; used a cached snapshot from ${cached.provider} (still fresh).` } };
  }

  return { quote: null, ambiguousMatches: null, audit: emptyAudit(input, "unavailable", `No live provider (Token Scanner, DexScreener, GeckoTerminal, CoinGecko) returned market data for "${subject}", and no fresh cached snapshot is available.`, providersTried) };
}

// ── Answer formatting ───────────────────────────────────────────────────────────────────────
function fmtUsdOrUnverified(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "unverified";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(8)}`;
  return `$${n.toFixed(abs < 1 ? 6 : 2)}`;
}

function fmtPctOrUnverified(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "unverified";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** Price is never abbreviated to K/M/B like market cap/volume/liquidity — a $3,200 asset price
 * should read as $3,200.50, not the misleading "$3.20K". */
function fmtPriceOrUnverified(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "unverified";
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(8)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: abs < 1 ? 6 : 2 })}`;
}

/** Required answer format: name/symbol, price, 24h%, market cap, FDV (if available), volume,
 * liquidity (if token/pair data exists), source + timestamp, and the financial-advice disclaimer.
 * Never confuses market cap with FDV — they are always rendered as two separate lines. */
export function formatClarkMarketAnswer(quote: ClarkMarketQuote): string {
  const label = quote.name && quote.symbol ? `${quote.name} (${quote.symbol})` : (quote.symbol ?? quote.name ?? quote.address ?? "This token");
  const lines = [
    `${label}`,
    `Price: ${fmtPriceOrUnverified(quote.priceUsd)}`,
    `24h change: ${fmtPctOrUnverified(quote.change24hPct)}`,
    `Market cap: ${fmtUsdOrUnverified(quote.marketCapUsd)}`,
  ];
  if (quote.fdvUsd != null) lines.push(`FDV: ${fmtUsdOrUnverified(quote.fdvUsd)}`);
  lines.push(`24h volume: ${fmtUsdOrUnverified(quote.volume24hUsd)}`);
  if (quote.liquidityUsd != null) lines.push(`Liquidity: ${fmtUsdOrUnverified(quote.liquidityUsd)}`);
  lines.push(`Source: ${quote.provider} · ${new Date(quote.fetchedAt).toISOString()}`);
  lines.push("Not financial advice.");
  return lines.join("\n");
}

export function formatClarkMarketAmbiguousAnswer(symbolOrAddress: string, matches: ClarkMarketQuote[]): string {
  const top = matches.slice(0, 5).map((m) => `- ${m.name ?? m.symbol ?? "Unknown"} (${m.symbol ?? "?"})${m.chain ? ` on ${m.chain}` : ""}${m.address ? ` — ${m.address}` : ""}`);
  return [`Multiple tokens match "${symbolOrAddress}". Which one did you mean?`, ...top].join("\n");
}
