// MODULE — clarkPipelineAudit (Clark/CORTEX audit, Item 20).
//
// GOAL, DISCLOSED: one compact funnel object on every Clark response so an operator can see
// which stage a request was lost at (routing, ticker pick, scanner, wallet snapshot) without
// cross-referencing clarkAudit / clarkWalletReadAudit / tickerSelectionAudit / entityAudit.
//
// HARD SCOPE, DISCLOSED. PURE and READ-ONLY: zero provider calls, zero PnL, zero risk
// rescoring. Every field is re-read from already-produced pipeline objects (or a cheap
// derivation of those objects, the same way walletScannerPipelineAudit derives
// firstFailureStage). Unknown → null, never fabricated. Clark still does not compute a risk
// score; canonicalRiskScore is copied from the Token Scanner receipt when present.

import { parseClarkTokenCommand } from "../clark/commandFormats.ts";
import { TOKEN_SCANNER_RISK_SCORE_SOURCE } from "../tokenScannerPipelineAudit.ts";

const EVM_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/;

export type ClarkPipelineFailureStage =
  | "timeout"
  | "ticker_resolution"
  | "scanner_not_called"
  | "scanner_evidence"
  | "wallet_stub"
  | "wallet_snapshot"
  | "routing"
  | null;

export type ClarkPipelineAudit = {
  prompt: string;
  parsedIntent: string | null;
  resolvedIntent: string | null;
  requiredContextType: "token" | "wallet" | "market" | "whale" | null;
  explicitTokenAddress: string | null;
  explicitWalletAddress: string | null;
  requestedTicker: string | null;
  requestedChain: string | null;
  tickerSearchId: string | null;
  tickerCandidates: Array<{ address: string; chain: string | null }>;
  selectedTickerAddress: string | null;
  selectedTickerChain: string | number | null;
  tokenRequestId: string | null;
  walletRequestId: string | null;
  activeTokenBefore: string | null;
  activeTokenAfter: string | null;
  activeWalletBefore: string | null;
  activeWalletAfter: string | null;
  scannerCalled: boolean;
  scannerType: "token" | "wallet" | "liquidity" | "deployer" | "market" | null;
  scannerAddress: string | null;
  scannerChain: string | null;
  scannerEvidenceStatus: "ok" | "partial" | "unavailable" | "not_called" | null;
  canonicalRiskScore: number | null;
  riskScoreSource: string | null;
  momentumListId: string | null;
  selectedRank: number | null;
  staleResponseIgnored: boolean;
  memorySourceUsed: string | null;
  cortexTokenAddress: string | null;
  cortexChainId: number | null;
  finalResponseStatus: "ok" | "partial" | "unavailable" | "timeout";
  firstFailureStage: ClarkPipelineFailureStage;
  exactFailureReason: string | null;
  walletReadPath: string | null;
  walletStubHit: boolean;
  walletSnapshotStatus: string | null;
};

const TOKEN_INTENTS = new Set([
  "token_scan", "token_safety", "dev_rug_check", "risk_explanation",
  "deployer_check", "holders_check", "liquidity_scan", "lp_lock_check",
]);
const WALLET_INTENTS = new Set(["wallet_scan", "wallet_pnl", "wallet_profile"]);
const MARKET_INTENTS = new Set(["live_market", "pump_analysis", "base_radar", "base_market"]);
const WHALE_INTENTS = new Set(["whale_alerts", "whale_alerts_feed", "whale_alerts_explain"]);

const TOKEN_TOOLS = new Set(["token_scan", "token_resolve", "scan-token", "token-scanner"]);
const WALLET_TOOLS = new Set(["wallet_get_snapshot", "wallet_analyze_quality", "wallet_scan_orchestrator", "wallet-scanner"]);
const LP_TOOLS = new Set(["liquidity_analyze", "liquidity-safety"]);
const DEPLOYER_TOOLS = new Set(["dev_wallet_analyze", "dev-wallet-detector"]);
const MARKET_TOOLS = new Set(["market_get_base_movers", "base-radar", "pump-alerts"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredContextTypeFor(intent: string | null, command: string | null): ClarkPipelineAudit["requiredContextType"] {
  const i = String(intent ?? "").toLowerCase();
  const c = String(command ?? "").toLowerCase();
  if (TOKEN_INTENTS.has(i) || c === "token" || c === "deployer" || c === "holders" || c === "lp" || c === "explain") return "token";
  if (WALLET_INTENTS.has(i) || c === "wallet") return "wallet";
  if (MARKET_INTENTS.has(i) || c === "base") return "market";
  if (WHALE_INTENTS.has(i) || i.startsWith("whale_alerts")) return "whale";
  return null;
}

function scannerTypeFor(toolsUsed: string[], routeSelected: string | null, intent: string | null): ClarkPipelineAudit["scannerType"] {
  if (toolsUsed.some((t) => TOKEN_TOOLS.has(t))) return "token";
  if (toolsUsed.some((t) => WALLET_TOOLS.has(t))) return "wallet";
  if (toolsUsed.some((t) => LP_TOOLS.has(t))) return "liquidity";
  if (toolsUsed.some((t) => DEPLOYER_TOOLS.has(t))) return "deployer";
  if (toolsUsed.some((t) => MARKET_TOOLS.has(t))) return "market";
  const route = String(routeSelected ?? intent ?? "").toLowerCase();
  if (route.includes("wallet")) return "wallet";
  if (route.includes("liquidity") || route === "lp") return "liquidity";
  if (route.includes("deployer")) return "deployer";
  if (route.includes("token")) return "token";
  if (route.includes("market") || route.includes("radar") || route.includes("pump")) return "market";
  return null;
}

function compactTickerCandidates(raw: unknown): Array<{ address: string; chain: string | null }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ address: string; chain: string | null }> = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const address = asString(row.tokenAddress) ?? asString(row.address);
    if (!address) continue;
    out.push({ address, chain: asString(row.chainSlug) ?? asString(row.chain) });
    if (out.length >= 20) break;
  }
  return out;
}

function firstFailureStageFor(params: {
  timedOut: boolean;
  walletStubHit: boolean;
  tickerStatus: string | null;
  requiredContextType: ClarkPipelineAudit["requiredContextType"];
  scannerCalled: boolean;
  scannerEvidenceStatus: ClarkPipelineAudit["scannerEvidenceStatus"];
  walletSnapshotStatus: string | null;
  finalResponseStatus: ClarkPipelineAudit["finalResponseStatus"];
}): ClarkPipelineFailureStage {
  if (params.finalResponseStatus === "ok") return null;
  if (params.walletStubHit) return "wallet_stub";
  if (params.timedOut || params.finalResponseStatus === "timeout") return "timeout";
  if (params.tickerStatus === "stale_search" || params.tickerStatus === "no_active_search" || params.tickerStatus === "mismatch" || params.tickerStatus === "invalid_index") {
    return "ticker_resolution";
  }
  if ((params.requiredContextType === "token" || params.requiredContextType === "wallet") && !params.scannerCalled) {
    return "scanner_not_called";
  }
  if (params.requiredContextType === "wallet" && params.walletSnapshotStatus && /unavail|fail|missing|stub/i.test(params.walletSnapshotStatus)) {
    return "wallet_snapshot";
  }
  if (params.scannerCalled && params.scannerEvidenceStatus === "unavailable") return "scanner_evidence";
  if (params.finalResponseStatus === "unavailable" || params.finalResponseStatus === "partial") return "routing";
  return null;
}

export type ClarkPipelineAuditInput = {
  prompt: string;
  identity: {
    command: string | null;
    intent: string;
    address: string | null;
    chain: string | null;
    routeSelected: string;
  };
  body: Record<string, unknown>;
  result: Record<string, unknown>;
  requestId: string;
  activeTokenBefore: string | null;
  activeTokenAfter: string | null;
  activeWalletBefore: string | null;
  activeWalletAfter: string | null;
  tickerSearchId: string | null;
  tickerCandidates: unknown;
  momentumListId: string | null;
  selectedRank: number | null;
  entityAudit: Record<string, unknown> | null;
  clarkAudit: Record<string, unknown> | null;
  timedOut: boolean;
  staleResponseIgnored: boolean;
  memorySourceUsed?: string | null;
};

export function buildClarkPipelineAudit(input: ClarkPipelineAuditInput): ClarkPipelineAudit {
  const prompt = String(input.prompt ?? "");
  const tokenCmd = parseClarkTokenCommand(prompt);
  const parsedIntent = asString(input.identity.intent) ?? asString(input.entityAudit?.parsedIntent);
  const resolvedIntent = asString(input.result.intent) ?? asString(input.clarkAudit?.intent) ?? parsedIntent;
  const requiredContextType = requiredContextTypeFor(resolvedIntent, input.identity.command);

  const selection = asRecord(input.body.tickerSelection);
  const selectedTickerAddress = asString(selection?.tokenAddress);
  const selectedTickerChain = asNumber(selection?.chainId) ?? asString(selection?.chain) ?? asString(selection?.chainSlug);
  const tickerSearchId = asString(selection?.tickerSearchId) ?? asString(input.tickerSearchId);

  const walletCmd = /^\s*\/wallet\b/i.test(prompt);
  const explicitFromIdentity = asString(input.identity.address);
  const bodyTokenAddress = asString(input.body.tokenAddress)
    ?? (asString(input.body.addressOrToken)?.match(EVM_ADDRESS_RE)?.[0] ?? null);
  const tokenLikeCommand = input.identity.command === "token"
    || input.identity.command === "deployer"
    || input.identity.command === "holders"
    || input.identity.command === "lp";
  const explicitTokenAddress =
    asString(tokenCmd?.address)
    ?? bodyTokenAddress
    ?? (!walletCmd && tokenLikeCommand ? explicitFromIdentity : null);
  const explicitWalletAddress =
    asString(input.body.walletAddress)
    ?? (walletCmd || input.identity.command === "wallet" ? explicitFromIdentity : null);

  const requestedTicker = asString(tokenCmd?.ticker);
  const requestedChain = asString(input.identity.chain) ?? asString(input.body.chain) ?? asString(input.entityAudit?.requestedChain);

  const toolsUsed = Array.isArray(input.result.toolsUsed) ? input.result.toolsUsed.map(String) : [];
  const scannerType = scannerTypeFor(toolsUsed, input.identity.routeSelected, resolvedIntent);
  const scannerCalled = toolsUsed.length > 0
    || input.clarkAudit?.scannerDataUsed === true
    || Boolean(asString(input.entityAudit?.apiCalled));

  const walletRead = asRecord(input.result.clarkWalletReadAudit);
  const tokenPipeline = asRecord(input.result.tokenScannerPipelineAudit);
  const tickerSelectionAudit = asRecord(input.result.tickerSelectionAudit);
  const tickerStatus = asString(tickerSelectionAudit?.status);

  const walletStubHit = input.result.walletStubHit === true;
  const walletReadPath = asString(walletRead?.sourceRoute);
  const walletSnapshotStatus = asString(walletRead?.scanDepth) ?? asString(walletRead?.jobStatus) ?? asString(input.result.jobStatus);

  const unavailableReason = asString(input.clarkAudit?.unavailableReason);
  const fallbackUsed = input.clarkAudit?.fallbackUsed === true;
  const missingFields = Array.isArray(input.clarkAudit?.missingFields) ? input.clarkAudit.missingFields : [];

  let scannerEvidenceStatus: ClarkPipelineAudit["scannerEvidenceStatus"] = null;
  if (!scannerCalled) scannerEvidenceStatus = requiredContextType === "token" || requiredContextType === "wallet" ? "not_called" : null;
  else if (unavailableReason) scannerEvidenceStatus = "unavailable";
  else if (fallbackUsed || missingFields.length > 0) scannerEvidenceStatus = "partial";
  else scannerEvidenceStatus = "ok";

  const finalResponseStatus: ClarkPipelineAudit["finalResponseStatus"] = input.timedOut
    ? "timeout"
    : unavailableReason && scannerEvidenceStatus === "unavailable"
      ? "unavailable"
      : fallbackUsed || scannerEvidenceStatus === "partial" || input.timedOut
        ? "partial"
        : "ok";

  const resultRisk = asNumber(input.result.riskScore) ?? asNumber(asRecord(input.result.canonicalRisk)?.score);
  const resultRiskSource = asString(input.result.riskScoreSource) ?? asString(asRecord(input.result.canonicalRisk)?.source);
  const canonicalRiskScore = resultRisk;
  const riskScoreSource = canonicalRiskScore != null
    ? (resultRiskSource ?? TOKEN_SCANNER_RISK_SCORE_SOURCE)
    : null;

  const scannerAddress =
    asString(input.result.address)
    ?? asString(input.result.tokenAddress)
    ?? asString(input.result.walletAddress)
    ?? selectedTickerAddress
    ?? explicitTokenAddress
    ?? explicitWalletAddress
    ?? asString(input.entityAudit?.address)
    ?? explicitFromIdentity;
  const scannerChain = requestedChain ?? asString(input.result.chain);

  const cortexTokenAddress = asString(tokenPipeline?.cortexTokenAddress)
    ?? (scannerType === "token" ? scannerAddress : null);
  const cortexChainId = asNumber(tokenPipeline?.cortexChainId);

  const memorySourceUsed = asString(input.memorySourceUsed)
    ?? (explicitTokenAddress || explicitWalletAddress ? "explicit_prompt"
      : asRecord(input.body.clientContext) ? "client_context"
      : (input.activeTokenBefore || input.activeWalletBefore) ? "session_memory"
      : "none");

  const firstFailureStage = firstFailureStageFor({
    timedOut: input.timedOut,
    walletStubHit,
    tickerStatus,
    requiredContextType,
    scannerCalled,
    scannerEvidenceStatus,
    walletSnapshotStatus,
    finalResponseStatus,
  });

  const exactFailureReason = unavailableReason
    ?? (firstFailureStage === "ticker_resolution" ? `ticker_selection: ${tickerStatus}` : null)
    ?? (firstFailureStage === "wallet_stub" ? "wallet_analyze_quality stub" : null)
    ?? (firstFailureStage === "timeout" ? "timeout" : null);

  const tokenRequestId = requiredContextType === "token" || scannerType === "token" ? input.requestId : null;
  const walletRequestId = requiredContextType === "wallet" || scannerType === "wallet" ? input.requestId : null;

  return {
    prompt,
    parsedIntent,
    resolvedIntent,
    requiredContextType,
    explicitTokenAddress,
    explicitWalletAddress,
    requestedTicker,
    requestedChain,
    tickerSearchId,
    tickerCandidates: compactTickerCandidates(input.tickerCandidates),
    selectedTickerAddress,
    selectedTickerChain,
    tokenRequestId,
    walletRequestId,
    activeTokenBefore: input.activeTokenBefore,
    activeTokenAfter: input.activeTokenAfter,
    activeWalletBefore: input.activeWalletBefore,
    activeWalletAfter: input.activeWalletAfter,
    scannerCalled,
    scannerType,
    scannerAddress,
    scannerChain,
    scannerEvidenceStatus,
    canonicalRiskScore,
    riskScoreSource,
    momentumListId: asString(input.momentumListId),
    selectedRank: input.selectedRank,
    staleResponseIgnored: Boolean(input.staleResponseIgnored) || walletRead?.staleResultRejected === true,
    memorySourceUsed,
    cortexTokenAddress,
    cortexChainId,
    finalResponseStatus,
    firstFailureStage,
    exactFailureReason,
    walletReadPath,
    walletStubHit,
    walletSnapshotStatus,
  };
}
