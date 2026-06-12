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
  POOL_AGE_VERY_NEW: { id: "POOL_AGE_VERY_NEW", label: "POOL AGE VERY NEW", explanation: "Pool appears very new based on observed pool creation time.", nextAction: "Newly created pools have a limited trading history — review liquidity and trading activity over time before relying on current depth." },
  MINTABILITY_UNAVAILABLE: { id: "MINTABILITY_UNAVAILABLE", label: "MINTABILITY UNAVAILABLE", explanation: "Whether the token contract can mint new supply has not been confirmed by this scan.", nextAction: "Review the token contract source code for mint functions." },
  HONEYPOT_CHECK_UNAVAILABLE: { id: "HONEYPOT_CHECK_UNAVAILABLE", label: "HONEYPOT CHECK UNAVAILABLE", explanation: "This scan does not include a honeypot / sell-simulation check.", nextAction: "Run a dedicated honeypot simulation before trading meaningful size." },
  TAX_CHECK_UNAVAILABLE: { id: "TAX_CHECK_UNAVAILABLE", label: "TAX CHECK UNAVAILABLE", explanation: "Buy/sell tax has not been verified by this scan.", nextAction: "Simulate a buy and sell to confirm actual transaction tax." },
  RENOUNCE_STATUS_UNKNOWN: { id: "RENOUNCE_STATUS_UNKNOWN", label: "RENOUNCE STATUS UNKNOWN", explanation: "Whether contract ownership has been renounced is not confirmed by this scan.", nextAction: "Check the contract's owner address on a block explorer for renouncement." },
  POOL_MODEL_UNCERTAIN: { id: "POOL_MODEL_UNCERTAIN", label: "POOL MODEL UNCERTAIN", explanation: "The liquidity pool's AMM model could not be determined from available DEX metadata, so LP lock/burn proof could not be attempted.", nextAction: "Identify the DEX and pool type on a block explorer, then re-check LP lock/burn status using a method appropriate for that pool model." },
  LP_CONTROL_UNVERIFIED: { id: "LP_CONTROL_UNVERIFIED", label: "LP CONTROL UNVERIFIED", explanation: "The LP control path — who can withdraw or manage this pool's liquidity — could not be verified from current evidence.", nextAction: "Confirm the pool model on-chain, then verify the LP holder distribution and control path." },
  LOCK_BURN_PROOF_NOT_ATTEMPTED_UNTIL_MODEL_CONFIRMED: { id: "LOCK_BURN_PROOF_NOT_ATTEMPTED_UNTIL_MODEL_CONFIRMED", label: "LOCK/BURN PROOF NOT ATTEMPTED UNTIL MODEL CONFIRMED", explanation: "Standard ERC-20 LP lock/burn proof was not attempted because the pool model has not been confirmed.", nextAction: "Confirm the pool model on-chain, then re-run LP lock/burn verification if an ERC-20 LP token is confirmed." },
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
  /**
   * Pool creation time in milliseconds since epoch, when known (e.g. GeckoTerminal
   * pool_created_at). When set, POOL_AGE_UNKNOWN is never emitted — a POOL_AGE_VERY_NEW
   * watch item is emitted instead if the pool is less than 24h old.
   */
  poolAgeMs?: number | null;
}): LpEvidenceGap[] {
  const applicability = params.proofApplicability ?? "applicable";
  const controllerProofAttempted = params.controllerProofAttempted !== false;
  const tokenGaps = params.includeTokenGaps !== false;
  const poolAgeKnown = params.poolAgeMs != null && Number.isFinite(params.poolAgeMs);
  const ids: string[] = [];
  if (applicability === "applicable") {
    // Only show lock-status unverified when LP is neither locked nor burned.
    if (params.lpLockStatus !== "locked" && params.lpLockStatus !== "burned") ids.push("LOCK_STATUS_UNVERIFIED");
    // Only show burn-proof unconfirmed when LP is neither burned nor locked.
    if (params.lpLockStatus !== "burned" && params.lpLockStatus !== "locked") ids.push("BURN_PROOF_UNCONFIRMED");
    if (controllerProofAttempted && params.lpController === "unknown") ids.push("CONTROLLER_UNKNOWN");
  } else if (applicability === "unknown") {
    ids.push("POOL_MODEL_UNCERTAIN", "LP_CONTROL_UNVERIFIED", "LOCK_BURN_PROOF_NOT_ATTEMPTED_UNTIL_MODEL_CONFIRMED");
  }
  // "not_applicable" / "not_available": no lock/burn/controller gaps — proof genuinely doesn't apply.
  if (!poolAgeKnown) {
    ids.push("POOL_AGE_UNKNOWN");
  } else if ((params.poolAgeMs as number) < 24 * 60 * 60 * 1000) {
    ids.push("POOL_AGE_VERY_NEW");
  }
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
  secondaryLpSignal?: { status: string; poolDex: string | null } | null;
  lpController?: LpController;
  lpControllerAddress?: string | null;
  isEstablishedToken?: boolean;
  /** Pool model could not be confirmed (lpProofApplicability === "unknown") — market liquidity
   *  may exist, but neither "concentrated" nor "standard LP proof does not apply" wording applies. */
  proofApplicability?: ProofApplicability;
  /** True when market-fallback evidence (e.g. DexScreener pair) proved liquidity exists even
   *  though no canonical on-chain pool was confirmed/indexed. */
  fallbackLiquidityDetected?: boolean;
}): CortexLpRead {
  const { name, symbol, totalLiq, fragments, observedPoolPresent, riskTier, lpModel, migrationSummary, mode, confidence, gaps, lpLockStatus, lpLockProvider, lpUnlockTime, secondaryLpSignal, lpController, lpControllerAddress, isEstablishedToken, proofApplicability, fallbackLiquidityDetected } = params;
  const liqStr = totalLiq != null ? `$${totalLiq.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "an unknown amount";
  const modelUnknown = proofApplicability === "unknown";

  // Secondary signal wording (selection rule 4): only describes a SECONDARY V2/Aerodrome ERC-20 LP
  // pool, and never overrides the primary pool's concentrated/protocol classification.
  const secondaryClause = secondaryLpSignal
    ? secondaryLpSignal.status === "team_controlled"
      ? " Primary liquidity uses concentrated/protocol liquidity. A secondary ERC-20 LP pool shows wallet-controlled LP exposure."
      : secondaryLpSignal.status === "burned"
        ? " A secondary ERC-20 LP pool shows its LP tokens sent to a burn address."
        : secondaryLpSignal.status === "locked"
          ? " A secondary ERC-20 LP pool shows its LP tokens in a known lock contract."
          : ""
    : "";

  const lockClause = lpLockStatus === "locked"
    ? `An active LP lock was found${lpLockProvider ? ` via ${lpLockProvider}` : ""}${lpUnlockTime ? `, unlocking at ${new Date(lpUnlockTime * 1000).toISOString()}` : ""}.`
    : lpLockStatus === "burned"
      ? "On-chain data shows the dominant share of LP tokens sent to a burn address."
      : modelUnknown
        ? `Market liquidity was detected, but the pool model and LP control path could not be verified from current evidence.${secondaryClause}`
        : !lpModel.standardLockApplies
          ? `Standard ERC-20 LP lock/burn proof does not apply to this concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.${secondaryClause}`
          : (lpController === "wallet" && isEstablishedToken)
            ? `Selected LP position appears wallet-controlled${lpControllerAddress ? ` (${lpControllerAddress})` : ""}. This is a liquidity-control signal, not proof of malicious behavior. Verify the controlling wallet and any lock/burn evidence before relying on liquidity safety.`
            : "No lock or burn proof was confirmed for this LP — treat liquidity as potentially withdrawable.";

  const riskSummary = `${name} (${symbol}) shows a "${riskTier}" liquidity-depth risk tier based on observed pool data. This reflects liquidity depth and pool structure only — ownership, mintability, simulation and tax status remain unconfirmed (data mode: ${mode}, confidence: ${confidence}). ${lockClause}`;

  const poolDetected = observedPoolPresent ?? fragments > 0;
  const liquidityAnalysis = poolDetected
    ? totalLiq != null
      ? `Observed liquidity is approximately ${liqStr} in the detected primary pool.`
      : "A primary liquidity pool was detected, but full pool distribution is not fully indexed."
    : fallbackLiquidityDetected
      ? "Market liquidity was detected from fallback evidence, but the pool address/model was not confirmed from current pool discovery."
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
      ...(modelUnknown
        ? ["Standard lock/burn proof was not attempted because ChainLens has not confirmed an ERC-20 LP token."]
        : lpModel.standardLockApplies
          ? ["Confirm LP lock and burn status directly on-chain before trusting any safety claims."]
          : [`Standard ERC-20 LP lock/burn proof does not apply to this concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.${secondaryClause}`]),
      "Verify contract ownership/renouncement and mintability via the contract source code.",
      "Run a simulation and tax check prior to trading.",
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
  secondaryLpSignal?: { status: string; poolDex: string | null } | null;
  lpControllerAddress?: string | null;
  isEstablishedToken?: boolean;
}): LpExitRiskResult {
  const { proofApplicability, lpLockStatus, lpController, liquidityUsd, poolModel, hasPool, secondaryLpSignal, lpControllerAddress, isEstablishedToken } = params;

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
    const secondaryClause = secondaryLpSignal?.status === "team_controlled"
      ? " A secondary ERC-20 LP pool shows wallet-controlled LP exposure — monitor that pool separately."
      : "";
    return {
      lpExitRisk: monitor ? "monitor" : watch ? "watch" : "open_check",
      lpExitRiskReason: `${poolModel === "concentrated" ? "Concentrated-liquidity (V3/Slipstream)" : "Protocol-managed"} pool — standard LP lock/burn proof does not apply. Exit risk based on pool depth ($${liqStr === "unknown" ? "unknown" : liqStr.replace("$", "")}).${secondaryClause}`,
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
    const reason = isEstablishedToken
      ? `Selected LP position appears wallet-controlled${lpControllerAddress ? ` (${lpControllerAddress})` : ""}. This is a liquidity-control signal, not proof of malicious behavior. Verify the controlling wallet and any lock/burn evidence before relying on liquidity safety. Pool depth ${liqStr}.`
      : `A wallet controls the LP with no lock or burn proof — liquidity can be withdrawn at any time. Pool depth ${liqStr}.`;
    return {
      lpExitRisk: liquidityDepthRisk === "low" ? "watch" : "high",
      lpExitRiskReason: reason,
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

// ── RPC pool-model classifier ────────────────────────────────────────────────
// Classifies an on-chain pool/pair address by probing well-known selectors using
// the existing Base/ETH RPC path (no new providers). Used to confirm the model of
// a pool that was only discovered via market-fallback data (e.g. a DexScreener
// pair address with no GeckoTerminal pool record), so a pool detected from
// fallback liquidity is never mislabeled "no_pool".
//
//   V2 / ERC-20 LP token : token0() + token1() + getReserves() + totalSupply() all resolve
//                          → lock/burn proof applies (constant_product LP token).
//   Concentrated (V3/CL) : token0() + token1() + (slot0() or liquidity()) resolve, but it is
//                          not a constant_product ERC-20 LP token → proof does not apply.
//   Unknown              : an address exists but probes are inconclusive → pool detected,
//                          model is an open check (proof not attempted until confirmed).
export type RpcPoolModel = "v2_erc20_lp" | "concentrated" | "unknown";

export interface RpcPoolClassification {
  model: RpcPoolModel;
  poolType: "v2" | "concentrated" | "unknown";
  hasLpToken: boolean | null;
  proofApplicable: boolean;
  probed: {
    token0: boolean;
    token1: boolean;
    getReserves: boolean;
    totalSupply: boolean;
    slot0: boolean;
    liquidity: boolean;
  };
}

const rpcPoolClassCache = new Map<string, { exp: number; data: RpcPoolClassification }>();

function _rpcResolved(hex: string | null): boolean {
  return typeof hex === "string" && hex !== "0x" && hex.length > 2;
}

export async function classifyPoolByRpc(chain: LpChain, poolAddress: string | null | undefined): Promise<RpcPoolClassification> {
  const unknown: RpcPoolClassification = {
    model: "unknown", poolType: "unknown", hasLpToken: null, proofApplicable: false,
    probed: { token0: false, token1: false, getReserves: false, totalSupply: false, slot0: false, liquidity: false },
  };
  if (!poolAddress || !/^0x[a-fA-F0-9]{40}$/.test(poolAddress)) return unknown;

  const addr = poolAddress.toLowerCase();
  const cacheKey = `${chain}:${addr}`;
  const cached = rpcPoolClassCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data;

  const call = (selector: string) => lpRpcCall(chain, "eth_call", [{ to: addr, data: selector }, "latest"]);
  // token0()=0x0dfe1681 token1()=0xd21220a7 getReserves()=0x0902f1ac
  // totalSupply()=0x18160ddd slot0()=0x3850c7bd liquidity()=0x1a686502
  const [token0Hex, token1Hex, reservesHex, supplyHex, slot0Hex, liquidityHex] = await Promise.all([
    call("0x0dfe1681"), call("0xd21220a7"), call("0x0902f1ac"),
    call("0x18160ddd"), call("0x3850c7bd"), call("0x1a686502"),
  ]);

  const probed = {
    token0: _rpcResolved(token0Hex),
    token1: _rpcResolved(token1Hex),
    getReserves: _rpcResolved(reservesHex),
    totalSupply: _rpcResolved(supplyHex),
    slot0: _rpcResolved(slot0Hex),
    liquidity: _rpcResolved(liquidityHex),
  };

  let result: RpcPoolClassification;
  if (probed.token0 && probed.token1 && probed.getReserves && probed.totalSupply) {
    // Pair exposes reserves AND an ERC-20 total supply → standard V2 LP token.
    result = { model: "v2_erc20_lp", poolType: "v2", hasLpToken: true, proofApplicable: true, probed };
  } else if (probed.token0 && probed.token1 && (probed.slot0 || probed.liquidity)) {
    // Pair exposes a concentrated-liquidity interface (slot0/liquidity) and is not a
    // constant-product ERC-20 LP token → standard lock/burn proof does not apply.
    result = { model: "concentrated", poolType: "concentrated", hasLpToken: false, proofApplicable: false, probed };
  } else {
    // An address exists but the probe could not confirm the model (RPC unavailable,
    // proxy, or non-standard pool) → pool detected, model is an open check.
    result = { model: "unknown", poolType: "unknown", hasLpToken: null, proofApplicable: false, probed };
  }

  rpcPoolClassCache.set(cacheKey, { exp: Date.now() + LP_PROOF_CACHE_TTL_MS, data: result });
  return result;
}
