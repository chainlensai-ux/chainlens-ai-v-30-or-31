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
  | "token_analysis"
  | "wallet_analysis"
  | "dev_wallet"
  | "liquidity_safety"
  | "base_radar"
  | "whale_alert"
  | "feature_context"
  | "unknown";

type ClarkSource = "casual" | "feature_context" | "tool_call" | "fallback";

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

function gtNetwork(chain: SupportedChain): "base" | "eth" {
  return chain === "ethereum" ? "eth" : "base";
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
  if (/what'?s moving on base|new base tokens|base radar|what should i watch|trending/i.test(t)) {
    return { intent: "base_radar", address };
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
    return { intent: "token_analysis", address };
  }
  return { intent: "unknown", address };
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
  action: string
): string {
  return (
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
    35
  );
  const ctxSignals = deriveContextSignals(input.userContent, input.isDevWalletMode ? buildDevWalletSignals(input.ctx) : []);
  const ctxRisks = deriveContextRisks(input.userContent, input.isDevWalletMode ? buildDevWalletRisks(input.ctx) : []);
  const proseSignals = pickBullets(normalizedText, ["key signals", "signals", "strengths"], 3, []);
  const proseRisks = pickBullets(normalizedText, ["risks", "risk flags", "concerns"], 3, []);
  const inferred = inferBulletsFromProse(normalizedText);

  const keySignals = uniqueBullets([...ctxSignals, ...proseSignals, ...inferred.signals]).slice(0, 3);
  const risks = uniqueBullets([...ctxRisks, ...proseRisks, ...inferred.risks]).slice(0, 3);
  const nextAction = capWords(cleanLine(pickNextAction(normalizedText, input.verdict)), 25);
  const confidence = normalizeConfidence(input.confidence, normalizedText);

  const safeSignals = keySignals.length > 0 ? keySignals : ["Verified data shows mixed but usable token signals."];
  const safeRisks = risks.length > 0 ? risks : ["Some important risk fields are still unverified."];

  return (
    `Verdict: ${input.verdict}\n` +
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
  if (verdict === "TRUSTWORTHY") return "Watch execution quality and liquidity before entering."
  if (verdict === "SCAN DEEPER") return "Scan deeper before touching it."
  if (verdict === "WATCH") return "Watch only; verify holder distribution and linked-wallet behavior before trusting it."
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

  if (t.includes("base radar") || t.includes("trending") || t.includes("what's hot")) {
    return scanBaseRadarData(origin);
  }
  if ((t.includes("scan wallet") || t.includes("wallet scan")) && address) {
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
    walletScan: { covalentBalances, zerionPositions },
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

  return {
    feature: "dev-wallet-detector",
    chain,
    tokenAddress,
    tokenData: { holders },
  };
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

  const txs = await callCovalent(
    `${chainName}/address/${walletAddress}/transactions_v3/`,
    { "page-size": "50" }
  );

  return {
    feature: "whale-alerts",
    chain,
    walletAddress,
    walletScan: { transactions: txs },
  };
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
  const network = gtNetwork(chain);
  const prompt = body.prompt ?? "Give me a clear on-chain summary.";
  const { intent, address } = detectIntent(prompt);

  if (intent === "casual_help") {
    return { feature: "clark-ai", chain, analysis: buildCasualClarkReply(prompt) };
  }

  if ((intent === "token_analysis" || intent === "wallet_analysis" || intent === "dev_wallet" || intent === "liquidity_safety" || intent === "whale_alert") && !address) {
    return { feature: "clark-ai", chain, analysis: missingAddressReply(intent) };
  }

  if (intent === "dev_wallet" && address) {
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

  if (intent === "token_analysis" && address) {
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

  if (intent === "wallet_analysis" && address) {
    const walletRes = await callInternalApi(origin, "/api/wallet", { address });
    if (!walletRes.ok) {
      return {
        feature: "clark-ai",
        chain,
        analysis: "I can do that once this feature backend is wired. For now, open Wallet Scanner and paste the wallet.",
      };
    }
    const context: ClarkContext = { walletScan: walletRes.json ?? {} };
    const analysis = await callAnthropic(prompt, context);
    return { feature: "clark-ai", chain, analysis };
  }

  if (intent === "liquidity_safety" && address) {
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

  if (intent === "base_radar") {
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

  // Always fetch baseline sources in parallel — never rely on routeCommand alone
  const [trendingResult, gtRawResult] = await Promise.allSettled([
    callTrending(origin),
    callGeckoTerminal(network, origin),
  ]);

  let trending: unknown[] = trendingResult.status === "fulfilled" && Array.isArray(trendingResult.value)
    ? trendingResult.value
    : [];

  let gtPools: unknown[] = gtRawResult.status === "fulfilled"
    ? (Array.isArray((gtRawResult.value as { data?: unknown[] })?.data)
        ? (gtRawResult.value as { data: unknown[] }).data
        : [])
    : [];

  // Route-specific context — non-fatal if unavailable; enriches all context fields
  let tokenData: unknown = {};
  let walletScan: unknown = {};
  let contractAnalysis: unknown = {};

  try {
    const routeCtx = await routeCommand(prompt, chain, origin);
    if (routeCtx?.tokenData  != null) tokenData        = routeCtx.tokenData;
    if (routeCtx?.walletScan != null) walletScan        = routeCtx.walletScan;
    if (routeCtx?.analysis   != null) contractAnalysis  = routeCtx.analysis;
    if (Array.isArray(routeCtx?.trending)  && (routeCtx.trending  as unknown[]).length > 0)
      trending = routeCtx.trending  as unknown[];
    if (Array.isArray(routeCtx?.gtPools)   && (routeCtx.gtPools   as unknown[]).length > 0)
      gtPools  = routeCtx.gtPools   as unknown[];
  } catch (err) {
    console.error("[Clark router]", err instanceof Error ? err.message : err);
  }

  const context: ClarkContext = {
    trending,
    gtPools,
    tokenData:  tokenData        ?? {},
    walletScan: walletScan        ?? {},
    analysis:   contractAnalysis  ?? {},
  };

  const analysis = await callAnthropic(prompt, context);

  return { feature: "clark-ai", chain, analysis };
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
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[Clark]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
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
    mode: body.mode ?? body.feature,
    source,
  };
}
