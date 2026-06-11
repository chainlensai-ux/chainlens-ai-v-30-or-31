// Shared LP proof helpers — PinkLock lookup + minimal on-chain burn/holder scan.
// Used by both the standalone Liquidity Safety route and the Token Scanner LP tab.
// No GoPlus, no paid providers. Unknowns are reported as "unverified", never fabricated.

export type LpChain = "eth" | "base";

export interface GTPool {
  id: string;
  attributes: { reserve_in_usd?: string | number | null; [key: string]: unknown };
  relationships?: {
    base_token?: { data?: { id: string } };
    network?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
}

export type LpLockStatus = "locked" | "burned" | "unlocked" | "unverified";
export type LpController = "wallet" | "contract" | "burn" | "lockContract" | "unknown";
export type LpDataMode = "strict" | "minimal" | "fallback" | "insufficient";
export type LpDataConfidence = "high" | "medium" | "low" | "unverified";

export interface LpEvidenceGap {
  id: string;
  label: string;
  explanation: string;
  nextAction: string;
}

function getLpRpcUrl(chain: LpChain): string | null {
  if (chain === "eth") {
    const explicitEth = process.env.ETH_RPC_URL
    if (explicitEth && /^https?:\/\//.test(explicitEth)) return explicitEth
    const key = process.env.ALCHEMY_ETHEREUM_KEY
    if (key) return `https://eth-mainnet.g.alchemy.com/v2/${key}`
    return null
  }
  const explicitBase = process.env.BASE_RPC_URL
  if (explicitBase && /^https?:\/\//.test(explicitBase)) return explicitBase
  const explicit = process.env.ALCHEMY_BASE_RPC_URL
  if (explicit && /^https?:\/\//.test(explicit)) return explicit
  const key = process.env.ALCHEMY_BASE_KEY
  if (key) return `https://base-mainnet.g.alchemy.com/v2/${key}`
  return "https://mainnet.base.org"
}

async function lpRpcCall(chain: LpChain, method: string, params: unknown[]): Promise<string | null> {
  try {
    const rpcUrl = getLpRpcUrl(chain);
    if (!rpcUrl) return null;
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.result === "string" ? json.result : null;
  } catch { return null; }
}

const LP_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LP_DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

function padAddress(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? null : n;
}

export function idToAddress(id: string): string {
  const idx = id.indexOf("_");
  return idx === -1 ? id : id.slice(idx + 1);
}

export interface PinkLockResult {
  lpLockStatus: "locked" | "unverified";
  lpLockAmount: number | null;
  lpUnlockTime: number | null;
  lpLockProvider: "PinkLock" | null;
}

const PINKLOCK_CACHE_TTL_MS = 5 * 60 * 1000;
const pinkLockCache = new Map<string, { exp: number; data: PinkLockResult }>();

export async function fetchPinkLockData(lpTokenAddress: string): Promise<PinkLockResult> {
  const key = lpTokenAddress.toLowerCase();
  const cached = pinkLockCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.data;

  let result: PinkLockResult;
  try {
    const res = await fetch(`https://api.pinksale.finance/api/v1/lock/pair/${lpTokenAddress}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      result = { lpLockStatus: "unverified", lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null };
    } else {
      const json = await res.json();
      const entries: Array<Record<string, unknown>> = Array.isArray(json?.data) ? json.data : [];
      if (entries.length === 0) {
        result = { lpLockStatus: "unverified", lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null };
      } else {
        let amountSum = 0;
        let earliestUnlock: number | null = null;
        for (const entry of entries) {
          const amount = toNum(entry.amount as string | number | null | undefined);
          if (amount != null) amountSum += amount;
          const unlock = toNum(entry.unlockTime as string | number | null | undefined);
          if (unlock != null && (earliestUnlock == null || unlock < earliestUnlock)) earliestUnlock = unlock;
        }
        result = {
          lpLockStatus: "locked",
          lpLockAmount: amountSum > 0 ? amountSum : null,
          lpUnlockTime: earliestUnlock,
          lpLockProvider: "PinkLock",
        };
      }
    }
  } catch {
    result = { lpLockStatus: "unverified", lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null };
  }

  pinkLockCache.set(key, { exp: Date.now() + PINKLOCK_CACHE_TTL_MS, data: result });
  return result;
}

export type LpProofReasonCode =
  | "totalSupplyUnavailable"
  | "nonErc20Pool"
  | "lockProviderNoRecord"
  | "burnScanSkipped"
  | "proofNotApplicable"
  | "rpcEmptyResult";

export interface OnchainLpScanResult {
  lpLockStatus: "burned" | "unlocked" | "unverified";
  lpController: LpController;
  reasonCode?: LpProofReasonCode;
}

export async function scanLpHoldersOnChain(chain: LpChain, lpTokenAddress: string): Promise<OnchainLpScanResult> {
  try {
    const totalSupplyHex = await lpRpcCall(chain, "eth_call", [{ to: lpTokenAddress, data: "0x18160ddd" }, "latest"]);
    if (totalSupplyHex == null) {
      return { lpLockStatus: "unverified", lpController: "unknown", reasonCode: "rpcEmptyResult" };
    }
    if (totalSupplyHex === "0x") {
      return { lpLockStatus: "unverified", lpController: "unknown", reasonCode: "totalSupplyUnavailable" };
    }

    const [zeroBalHex, deadBalHex] = await Promise.all([
      lpRpcCall(chain, "eth_call", [{ to: lpTokenAddress, data: "0x70a08231" + padAddress(LP_ZERO_ADDRESS) }, "latest"]),
      lpRpcCall(chain, "eth_call", [{ to: lpTokenAddress, data: "0x70a08231" + padAddress(LP_DEAD_ADDRESS) }, "latest"]),
    ]);

    const parseBig = (hex: string | null): bigint | null => {
      if (!hex || hex === "0x" || hex === "0x0") return null;
      try { return BigInt(hex); } catch { return null; }
    };

    const totalSupply = parseBig(totalSupplyHex);
    const zeroBal = parseBig(zeroBalHex) ?? BigInt(0);
    const deadBal = parseBig(deadBalHex) ?? BigInt(0);

    if (totalSupply != null && totalSupply > BigInt(0)) {
      const burned = zeroBal + deadBal;
      if (burned * BigInt(2) >= totalSupply) {
        return { lpLockStatus: "burned", lpController: "burn" };
      }
    }

    return { lpLockStatus: "unverified", lpController: "unknown", reasonCode: "burnScanSkipped" };
  } catch {
    return { lpLockStatus: "unverified", lpController: "unknown", reasonCode: "rpcEmptyResult" };
  }
}

const EVIDENCE_GAP_DEFS: Record<string, LpEvidenceGap> = {
  LOCK_STATUS_UNVERIFIED: { id: "LOCK_STATUS_UNVERIFIED", label: "LOCK STATUS UNVERIFIED", explanation: "No lock-proof provider or on-chain check confirmed an active LP lock for this pool.", nextAction: "Verify the LP lock directly on-chain or via a lock-proof explorer before trusting any lock claims." },
  BURN_PROOF_UNCONFIRMED: { id: "BURN_PROOF_UNCONFIRMED", label: "BURN PROOF UNCONFIRMED", explanation: "Whether LP tokens were burned to a dead address has not been confirmed by this scan.", nextAction: "Check the LP token holder list on-chain for transfers to a burn address." },
  CONTROLLER_UNKNOWN: { id: "CONTROLLER_UNKNOWN", label: "CONTROLLER UNKNOWN", explanation: "The LP token's controlling address (wallet, contract, lock contract, or burn) has not been confirmed by this scan.", nextAction: "Inspect the LP token's holder list and the token contract's owner() / admin functions on a block explorer." },
  POOL_AGE_UNKNOWN: { id: "POOL_AGE_UNKNOWN", label: "POOL AGE UNKNOWN", explanation: "Pool creation date is not available from the data used in this scan.", nextAction: "Check the pool creation transaction on a block explorer to determine its age." },
  MINTABILITY_UNAVAILABLE: { id: "MINTABILITY_UNAVAILABLE", label: "MINTABILITY UNAVAILABLE", explanation: "Whether the token contract can mint new supply has not been confirmed by this scan.", nextAction: "Review the token contract source code for mint functions." },
  HONEYPOT_CHECK_UNAVAILABLE: { id: "HONEYPOT_CHECK_UNAVAILABLE", label: "HONEYPOT CHECK UNAVAILABLE", explanation: "This scan does not include a honeypot / sell-simulation check.", nextAction: "Run a dedicated honeypot simulation before trading meaningful size." },
  TAX_CHECK_UNAVAILABLE: { id: "TAX_CHECK_UNAVAILABLE", label: "TAX CHECK UNAVAILABLE", explanation: "Buy/sell tax has not been verified by this scan.", nextAction: "Simulate a buy and sell to confirm actual transaction tax." },
  RENOUNCE_STATUS_UNKNOWN: { id: "RENOUNCE_STATUS_UNKNOWN", label: "RENOUNCE STATUS UNKNOWN", explanation: "Whether contract ownership has been renounced is not confirmed by this scan.", nextAction: "Check the contract's owner address on a block explorer for renouncement." },
  POOL_MODEL_UNCERTAIN: { id: "POOL_MODEL_UNCERTAIN", label: "POOL MODEL UNCERTAIN", explanation: "The liquidity pool's AMM model could not be determined from available DEX metadata, so LP lock/burn proof could not be attempted.", nextAction: "Identify the DEX and pool type on a block explorer, then re-check LP lock/burn status using a method appropriate for that pool model." },
};

export function buildEvidenceGaps(params: {
  lpLockStatus: LpLockStatus;
  lpController: LpController;
  /**
   * "applicable": standard ERC-20 LP lock/burn proof applies — emit lock/burn gaps when unverified.
   * "not_applicable": pool model has no ERC-20 LP token (concentrated/protocol) — never emit lock/burn/controller gaps.
   * "unknown": pool model could not be determined — emit a model-uncertainty gap, not fake lock/burn gaps.
   * "not_available": no pool at all — same as not_applicable for gap purposes.
   * Default "applicable" for backward compatibility.
   */
  proofApplicability?: ProofApplicability;
  /** When false, the controller-unknown gap is suppressed even if applicable (controller proof was never attempted). Default true. */
  controllerProofAttempted?: boolean;
  /** When false, token-level gaps (mintability/honeypot/tax/renounce) are omitted. Default true. */
  includeTokenGaps?: boolean;
}): LpEvidenceGap[] {
  const applicability = params.proofApplicability ?? "applicable";
  const controllerProofAttempted = params.controllerProofAttempted !== false;
  const tokenGaps = params.includeTokenGaps !== false;
  const ids: string[] = [];
  if (applicability === "applicable") {
    // Only show lock-status unverified when LP is neither locked nor burned.
    if (params.lpLockStatus !== "locked" && params.lpLockStatus !== "burned") ids.push("LOCK_STATUS_UNVERIFIED");
    // Only show burn-proof unconfirmed when LP is neither burned nor locked.
    if (params.lpLockStatus !== "burned" && params.lpLockStatus !== "locked") ids.push("BURN_PROOF_UNCONFIRMED");
    if (controllerProofAttempted && params.lpController === "unknown") ids.push("CONTROLLER_UNKNOWN");
  } else if (applicability === "unknown") {
    ids.push("POOL_MODEL_UNCERTAIN");
  }
  // "not_applicable" / "not_available": no lock/burn/controller gaps — proof genuinely doesn't apply.
  ids.push("POOL_AGE_UNKNOWN");
  if (tokenGaps) {
    ids.push(
      "MINTABILITY_UNAVAILABLE",
      "HONEYPOT_CHECK_UNAVAILABLE",
      "TAX_CHECK_UNAVAILABLE",
      "RENOUNCE_STATUS_UNKNOWN",
    );
  }
  return ids.map((id) => EVIDENCE_GAP_DEFS[id]);
}

export function deriveDataModeAndConfidence(
  hasUsablePoolData: boolean,
  lpLockStatus: LpLockStatus
): { lp_data_mode: LpDataMode; lp_data_confidence: LpDataConfidence } {
  if (lpLockStatus === "locked" || lpLockStatus === "burned") {
    return { lp_data_mode: "strict", lp_data_confidence: "high" };
  }
  if (lpLockStatus === "unlocked") {
    return { lp_data_mode: "minimal", lp_data_confidence: "medium" };
  }
  if (!hasUsablePoolData) {
    return { lp_data_mode: "insufficient", lp_data_confidence: "unverified" };
  }
  return { lp_data_mode: "fallback", lp_data_confidence: "low" };
}

export interface CortexLpRead {
  mode: string;
  confidence: string;
  riskSummary: string;
  liquidityAnalysis: string;
  poolStructureAnalysis: string;
  migrationAnalysis: string;
  evidenceGaps: string[];
  nextActions: string[];
}

export function buildCortexLpRead(params: {
  name: string;
  symbol: string;
  totalLiq: number | null;
  fragments: number;
  observedPoolPresent?: boolean;
  riskTier: string;
  lpModel: { model: "constant_product" | "concentrated" | "stableswap" | "unknown"; dexName: string | null; standardLockApplies: boolean };
  migrationSummary: string;
  mode: string;
  confidence: string;
  gaps: LpEvidenceGap[];
  lpLockStatus: LpLockStatus;
  lpLockProvider: "PinkLock" | null;
  lpUnlockTime: number | null;
}): CortexLpRead {
  const { name, symbol, totalLiq, fragments, observedPoolPresent, riskTier, lpModel, migrationSummary, mode, confidence, gaps, lpLockStatus, lpLockProvider, lpUnlockTime } = params;
  const liqStr = totalLiq != null ? `$${totalLiq.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "an unknown amount";

  const lockClause = lpLockStatus === "locked"
    ? `An active LP lock was found${lpLockProvider ? ` via ${lpLockProvider}` : ""}${lpUnlockTime ? `, unlocking at ${new Date(lpUnlockTime * 1000).toISOString()}` : ""}.`
    : lpLockStatus === "burned"
      ? "On-chain data shows the dominant share of LP tokens sent to a burn address."
      : !lpModel.standardLockApplies
        ? "Standard ERC-20 LP lock/burn proof does not apply to this concentrated-liquidity pool. Use protocol-specific position checks to assess liquidity control."
        : "No lock or burn proof was confirmed for this LP — treat liquidity as potentially withdrawable.";

  const riskSummary = `${name} (${symbol}) shows a "${riskTier}" liquidity-depth risk tier based on observed pool data. This reflects liquidity depth and pool structure only — ownership, mintability, honeypot and tax status remain unconfirmed (data mode: ${mode}, confidence: ${confidence}). ${lockClause}`;

  const poolDetected = observedPoolPresent ?? fragments > 0;
  const liquidityAnalysis = poolDetected
    ? totalLiq != null
      ? `Observed liquidity is approximately ${liqStr} in the detected primary pool.`
      : "A primary liquidity pool was detected, but full pool distribution is not fully indexed."
    : "No active liquidity pool was confirmed from current evidence.";

  const poolStructureAnalysis = lpModel.model === "unknown"
    ? "The AMM model could not be determined from the available DEX data."
    : `The primary pool runs on a ${lpModel.model.replace("_", "-")} model${lpModel.dexName ? ` (DEX: ${lpModel.dexName})` : ""}.${lpModel.standardLockApplies ? "" : " Standard LP lock proofs may not apply to concentrated-liquidity positions — lock verification methods differ for this model."}`;

  return {
    mode,
    confidence,
    riskSummary,
    liquidityAnalysis,
    poolStructureAnalysis,
    migrationAnalysis: migrationSummary,
    evidenceGaps: gaps.map((g) => g.label),
    nextActions: [
      ...(lpModel.standardLockApplies
        ? ["Confirm LP lock and burn status directly on-chain before trusting any safety claims."]
        : ["Standard ERC-20 LP lock/burn proof does not apply to this concentrated-liquidity pool. Use protocol-specific position checks to assess liquidity control."]),
      "Verify contract ownership/renouncement and mintability via the contract source code.",
      "Run a honeypot and tax simulation prior to trading.",
    ],
  };
}

function _toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return isNaN(n) ? null : n;
}

export interface LpModelProof {
  model: "constant_product" | "concentrated" | "stableswap" | "unknown";
  dexName: string | null;
  standardLockApplies: boolean;
}

// ─── Shared pool-model / proof-applicability classification ───────────────────
// Single source of truth used by both Token Scanner and Liquidity Safety so the
// two routes never disagree on whether LP lock/burn proof applies to a pool.

export type PoolModel = "constant_product" | "aerodrome_v2" | "concentrated" | "stableswap" | "unknown";
export type ProofApplicability = "applicable" | "not_applicable" | "unknown" | "not_available";
export type ProofAddressType = "erc20_lp_token" | "nft_position" | "unknown";

export interface PoolModelClassification {
  poolModel: PoolModel;
  proofApplicability: ProofApplicability;
  proofAddressType: ProofAddressType;
  standardLockApplies: boolean;
  reason: string;
}

// Classifies a pool purely from its DEX id string. Aerodrome/Velodrome Slipstream
// (concentrated-liquidity) pools are distinguished from Aerodrome V2 (volatile/stable)
// pools — only the latter expose an ERC-20 LP token that standard lock/burn proof applies to.
export function classifyPoolModel(dexId: string | null | undefined): PoolModelClassification {
  const id = (dexId ?? "").toLowerCase().trim();
  if (!id) {
    return {
      poolModel: "unknown",
      proofApplicability: "unknown",
      proofAddressType: "unknown",
      standardLockApplies: false,
      reason: "No DEX metadata available to classify pool model.",
    };
  }
  const isAerodrome = id.includes("aerodrome") || id.includes("velodrome");
  const isConcentratedMarker = /(slipstream|concentrated|algebra|\bv4\b|[-_]v4|^v4|\bcl\b|[-_]cl[-_]?|[-_]cl$)|(?:^|[-_])v3(?:[-_]|$)/.test(id);

  if (isAerodrome && isConcentratedMarker) {
    return {
      poolModel: "concentrated",
      proofApplicability: "not_applicable",
      proofAddressType: "nft_position",
      standardLockApplies: false,
      reason: "Aerodrome Slipstream (concentrated-liquidity) pool — LP positions are NFTs, not ERC-20 LP tokens.",
    };
  }
  if (isAerodrome) {
    return {
      poolModel: "aerodrome_v2",
      proofApplicability: "applicable",
      proofAddressType: "erc20_lp_token",
      standardLockApplies: true,
      reason: "Aerodrome V2 (volatile/stable) pool — pool contract is an ERC-20 LP token.",
    };
  }
  if (id.includes("curve")) {
    return {
      poolModel: "stableswap",
      proofApplicability: "unknown",
      proofAddressType: "unknown",
      standardLockApplies: false,
      reason: "Stableswap (Curve-style) pool — standard ERC-20 LP lock proof model not yet verified for this DEX.",
    };
  }
  if (isConcentratedMarker) {
    return {
      poolModel: "concentrated",
      proofApplicability: "not_applicable",
      proofAddressType: "nft_position",
      standardLockApplies: false,
      reason: "Concentrated-liquidity (V3/V4/Slipstream) pool — LP positions are NFTs, not ERC-20 LP tokens.",
    };
  }
  if (/uniswap|sushiswap|pancakeswap|baseswap|alienbase|swapbased|shibaswap|(?:^|[-_])v2(?:[-_]|$)/.test(id)) {
    return {
      poolModel: "constant_product",
      proofApplicability: "applicable",
      proofAddressType: "erc20_lp_token",
      standardLockApplies: true,
      reason: "Constant-product V2-style pool — pool contract is an ERC-20 LP token.",
    };
  }
  return {
    poolModel: "unknown",
    proofApplicability: "unknown",
    proofAddressType: "unknown",
    standardLockApplies: false,
    reason: "Pool model could not be determined from available DEX metadata.",
  };
}

export interface LpProofApplicabilityResult extends PoolModelClassification {
  dexName: string | null;
  proofAddress: string | null;
}

// Pools-array variant of classifyPoolModel — used by routes that work directly with
// GeckoTerminal pool objects (e.g. Liquidity Safety).
export function getLpProofApplicability(pools: GTPool[]): LpProofApplicabilityResult {
  const primary = pools[0];
  if (!primary) {
    return {
      poolModel: "unknown",
      proofApplicability: "not_available",
      proofAddressType: "unknown",
      standardLockApplies: false,
      reason: "No pool data available for this token.",
      dexName: null,
      proofAddress: null,
    };
  }
  const dexId = primary.relationships?.dex?.data?.id ?? null;
  const cls = classifyPoolModel(dexId);
  const poolAddress = idToAddress(primary.id);
  return {
    ...cls,
    dexName: dexId,
    proofAddress: cls.proofAddressType === "erc20_lp_token" ? poolAddress : null,
  };
}

export function deriveLpModelProof(pools: GTPool[]): LpModelProof {
  const primary = pools[0];
  const dexId = primary?.relationships?.dex?.data?.id ?? null;
  const cls = classifyPoolModel(dexId);
  // aerodrome_v2 is a constant-product AMM under the hood — surface it as such for
  // narrative text while proofApplicability/poolModel elsewhere remain distinct fields.
  const model: LpModelProof["model"] = cls.poolModel === "aerodrome_v2" ? "constant_product" : cls.poolModel;
  return {
    model,
    dexName: dexId,
    standardLockApplies: cls.standardLockApplies,
  };
}

// ─── Shared exit-risk classification ───────────────────────────────────────────
export type LpExitRisk = "low" | "monitor" | "watch" | "medium" | "high" | "open_check";

export interface LpExitRiskResult {
  lpExitRisk: LpExitRisk;
  lpExitRiskReason: string;
  liquidityDepthRisk: "low" | "medium" | "high" | "unknown";
}

export function computeLpExitRisk(params: {
  proofApplicability: ProofApplicability;
  lpLockStatus: LpLockStatus;
  lpController: LpController;
  liquidityUsd: number | null;
  poolModel: PoolModel;
  hasPool: boolean;
}): LpExitRiskResult {
  const { proofApplicability, lpLockStatus, lpController, liquidityUsd, poolModel, hasPool } = params;

  const liquidityDepthRisk: LpExitRiskResult["liquidityDepthRisk"] =
    liquidityUsd == null ? "unknown" :
    liquidityUsd >= 100_000 ? "low" :
    liquidityUsd >= 20_000 ? "medium" : "high";

  const liqStr = liquidityUsd != null ? `$${liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "unknown";

  if (!hasPool) {
    return { lpExitRisk: "open_check", lpExitRiskReason: "No active liquidity pool was found — exit risk cannot be assessed.", liquidityDepthRisk };
  }

  if (proofApplicability === "not_applicable") {
    const monitor = liquidityUsd != null && liquidityUsd > 50_000;
    const watch = liquidityUsd != null && liquidityUsd > 0;
    return {
      lpExitRisk: monitor ? "monitor" : watch ? "watch" : "open_check",
      lpExitRiskReason: `${poolModel === "concentrated" ? "Concentrated-liquidity (V3/Slipstream)" : "Protocol-managed"} pool — standard LP lock/burn proof does not apply. Exit risk based on pool depth ($${liqStr === "unknown" ? "unknown" : liqStr.replace("$", "")}).`,
      liquidityDepthRisk,
    };
  }

  if (lpLockStatus === "burned" || lpLockStatus === "locked") {
    return {
      lpExitRisk: liquidityDepthRisk === "high" ? "medium" : "low",
      lpExitRiskReason: lpLockStatus === "burned"
        ? "LP tokens sent to a burn address — exit liquidity permanently locked."
        : "Active LP lock proof found — protected for the lock duration.",
      liquidityDepthRisk,
    };
  }

  if (proofApplicability === "unknown") {
    return {
      lpExitRisk: "open_check",
      lpExitRiskReason: "Pool model could not be confirmed — LP lock/burn proof could not be attempted.",
      liquidityDepthRisk,
    };
  }

  // proofApplicability === "applicable" but no lock/burn proof found
  if (lpController === "wallet") {
    return {
      lpExitRisk: liquidityDepthRisk === "low" ? "watch" : "high",
      lpExitRiskReason: `A wallet controls the LP with no lock or burn proof — liquidity can be withdrawn at any time. Pool depth ${liqStr}.`,
      liquidityDepthRisk,
    };
  }

  return {
    lpExitRisk: liquidityDepthRisk === "low" ? "watch" : "open_check",
    lpExitRiskReason: "LP lock/burn proof not confirmed and LP controller is unknown — exit risk is an open check.",
    liquidityDepthRisk,
  };
}

export interface LpMigrationProof {
  status: "low" | "watch" | "flagged" | "unknown";
  confidence: "high" | "medium" | "low" | "unverified";
  reason: string;
  dexsUsed: string[];
  primaryDex: string | null;
  liquidityDistribution: string;
  signals: string[];
  missingEvidence: string[];
  nextAction: string;
}

export function deriveMigrationProof(pools: GTPool[], totalLiq: number | null): LpMigrationProof {
  const dexsUsed = Array.from(new Set(pools.map((p) => p.relationships?.dex?.data?.id).filter((d): d is string => !!d)));
  const primaryDex = pools[0]?.relationships?.dex?.data?.id ?? null;
  const liquidities = pools.map((p) => _toNum(p.attributes.reserve_in_usd as string | number | null | undefined) ?? 0);
  const topShare = totalLiq && totalLiq > 0 ? (liquidities[0] ?? 0) / totalLiq : null;

  const signals: string[] = [];
  let status: LpMigrationProof["status"] = "unknown";
  let confidence: LpMigrationProof["confidence"] = "unverified";
  let reason = "Not enough pool data to assess migration risk.";
  let liquidityDistribution = "unknown";

  if (pools.length > 0 && topShare != null) {
    liquidityDistribution = topShare >= 0.7 ? "concentrated in primary pool" : topShare >= 0.4 ? "moderately distributed" : "spread thinly across pools";
    if (dexsUsed.length > 1) signals.push(`Liquidity is split across ${dexsUsed.length} different DEXs.`);
    if (pools.length > 1 && topShare < 0.4) signals.push("No single pool holds a clear majority of liquidity.");
    if (pools.length === 1) signals.push("All observed liquidity sits in a single pool.");
    if (dexsUsed.length > 1 && topShare < 0.4) {
      status = "watch"; confidence = "low";
      reason = "Liquidity is fragmented across multiple DEXs with no dominant pool — could indicate an in-progress or past migration.";
    } else if (dexsUsed.length === 1 && topShare >= 0.7) {
      status = "low"; confidence = "medium";
      reason = "Liquidity is concentrated in a single DEX and primary pool — no migration signal observed.";
    } else {
      status = "watch"; confidence = "low";
      reason = "Pool distribution shows mixed signals — insufficient evidence to rule out migration activity.";
    }
  }

  return {
    status, confidence, reason, dexsUsed, primaryDex, liquidityDistribution, signals,
    missingEvidence: ["pool_creation_date_unavailable"],
    nextAction: "Confirm pool creation dates and historical liquidity moves on a block explorer before drawing migration conclusions.",
  };
}

export interface LpProof {
  lpLockStatus: LpLockStatus;
  lpLockAmount: number | null;
  lpUnlockTime: number | null;
  lpLockProvider: "PinkLock" | null;
  lpController: LpController;
  /** Set when lpLockStatus is "unverified"/"unlocked" — explains why no lock/burn proof was found. */
  reasonCode?: LpProofReasonCode;
}

const LP_PROOF_CACHE_TTL_MS = 5 * 60 * 1000;
const lpProofCache = new Map<string, { exp: number; data: LpProof }>();

// Resolves real lock/burn proof for an LP token: PinkLock first, on-chain burn scan as fallback.
// Never throws on empty/missing RPC values — unknowns are reported via reasonCode, not fabricated.
export async function resolveLpProof(chain: LpChain, lpTokenAddress: string | null | undefined): Promise<LpProof> {
  const empty: LpProof = { lpLockStatus: "unverified", lpLockAmount: null, lpUnlockTime: null, lpLockProvider: null, lpController: "unknown", reasonCode: "nonErc20Pool" };
  if (!lpTokenAddress || !lpTokenAddress.startsWith("0x")) return empty;

  const cacheKey = `${chain}:${lpTokenAddress.toLowerCase()}`;
  const cached = lpProofCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data;

  let result: LpProof = empty;
  const pinkLock = await fetchPinkLockData(lpTokenAddress);
  if (pinkLock.lpLockStatus === "locked") {
    result = {
      lpLockStatus: "locked",
      lpLockAmount: pinkLock.lpLockAmount,
      lpUnlockTime: pinkLock.lpUnlockTime,
      lpLockProvider: pinkLock.lpLockProvider,
      lpController: "lockContract",
    };
  } else {
    const onchain = await scanLpHoldersOnChain(chain, lpTokenAddress);
    result = {
      lpLockStatus: onchain.lpLockStatus,
      lpLockAmount: null,
      lpUnlockTime: null,
      lpLockProvider: null,
      lpController: onchain.lpController,
      reasonCode: onchain.lpLockStatus === "burned" ? undefined : (onchain.reasonCode ?? "lockProviderNoRecord"),
    };
  }

  lpProofCache.set(cacheKey, { exp: Date.now() + LP_PROOF_CACHE_TTL_MS, data: result });
  return result;
}
