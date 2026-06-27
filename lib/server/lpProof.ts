// Shared LP proof helpers — PinkLock lookup + minimal on-chain burn/holder scan.
// Used by both the standalone Liquidity Safety route and the Token Scanner LP tab.
// No GoPlus, no paid providers. Unknowns are reported as "unverified", never fabricated.

import { LP_LOCK_BURN_REGISTRY } from "./lpLockBurnIntel.ts";

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
  LOCK_STATUS_UNVERIFIED: { id: "LOCK_STATUS_UNVERIFIED", label: "LP lock not confirmed", explanation: "No lock-proof provider or on-chain check confirmed an active LP lock for this pool.", nextAction: "Verify the LP lock directly on-chain or via a lock-proof explorer before trusting any lock claims." },
  BURN_PROOF_UNCONFIRMED: { id: "BURN_PROOF_UNCONFIRMED", label: "LP burn proof not confirmed", explanation: "Whether LP tokens were burned to a dead address has not been confirmed by this scan.", nextAction: "Check the LP token holder list on-chain for transfers to a burn address." },
  CONTROLLER_UNKNOWN: { id: "CONTROLLER_UNKNOWN", label: "LP controller not verified", explanation: "The LP token's controlling address (wallet, contract, lock contract, or burn) has not been confirmed by this scan.", nextAction: "Inspect the LP token's holder list and the token contract's owner() / admin functions on a block explorer." },
  POOL_AGE_UNKNOWN: { id: "POOL_AGE_UNKNOWN", label: "Pool age unknown", explanation: "Pool creation date is not available from the data used in this scan.", nextAction: "Check the pool creation transaction on a block explorer to determine its age." },
  POOL_AGE_VERY_NEW: { id: "POOL_AGE_VERY_NEW", label: "Pool age very new", explanation: "Pool appears very new based on observed pool creation time.", nextAction: "Newly created pools have a limited trading history — review liquidity and trading activity over time before relying on current depth." },
  MINTABILITY_UNAVAILABLE: { id: "MINTABILITY_UNAVAILABLE", label: "Mintability not confirmed", explanation: "Whether the token contract can mint new supply has not been confirmed by this scan.", nextAction: "Review the token contract source code for mint functions." },
  HONEYPOT_CHECK_UNAVAILABLE: { id: "HONEYPOT_CHECK_UNAVAILABLE", label: "Honeypot check not available", explanation: "This scan does not include a honeypot / sell-simulation check.", nextAction: "Run a dedicated honeypot simulation before trading meaningful size." },
  TAX_CHECK_UNAVAILABLE: { id: "TAX_CHECK_UNAVAILABLE", label: "Tax check not available", explanation: "Buy/sell tax has not been verified by this scan.", nextAction: "Simulate a buy and sell to confirm actual transaction tax." },
  RENOUNCE_STATUS_UNKNOWN: { id: "RENOUNCE_STATUS_UNKNOWN", label: "Renounce status unknown", explanation: "Whether contract ownership has been renounced is not confirmed by this scan.", nextAction: "Check the contract's owner address on a block explorer for renouncement." },
  POOL_MODEL_UNCERTAIN: { id: "POOL_MODEL_UNCERTAIN", label: "Pool model uncertain", explanation: "The liquidity pool's AMM model could not be determined from available DEX metadata, so LP lock/burn proof could not be attempted.", nextAction: "Identify the DEX and pool type on a block explorer, then re-check LP lock/burn status using a method appropriate for that pool model." },
  LP_CONTROL_UNVERIFIED: { id: "LP_CONTROL_UNVERIFIED", label: "LP control not verified", explanation: "The LP control path — who can withdraw or manage this pool's liquidity — could not be verified from current evidence.", nextAction: "Confirm the pool model on-chain, then verify the LP holder distribution and control path." },
  LOCK_BURN_PROOF_NOT_ATTEMPTED_UNTIL_MODEL_CONFIRMED: { id: "LOCK_BURN_PROOF_NOT_ATTEMPTED_UNTIL_MODEL_CONFIRMED", label: "LP lock/burn proof not attempted until pool model is confirmed", explanation: "Standard ERC-20 LP lock/burn proof was not attempted because the pool model has not been confirmed.", nextAction: "Confirm the pool model on-chain, then re-run LP lock/burn verification if an ERC-20 LP token is confirmed." },
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

export type PublicLpDataMode = "resolved" | "evidence_based" | "indexed";

// Maps the internal lp_data_mode (which calls anything short of a confirmed
// lock/burn "fallback", even when a pool and LP-holder evidence were resolved)
// to a public-facing mode that never implies "no usable data" when evidence exists.
export function publicLpDataMode(
  mode: LpDataMode,
  hasUsablePoolData: boolean,
  lpOwnershipVerified: boolean
): PublicLpDataMode {
  if (mode === "strict") return "resolved";
  if (mode === "fallback" && hasUsablePoolData && lpOwnershipVerified) return "evidence_based";
  return "indexed";
}


export function formatTokenIdentity(name: string | null | undefined, symbol: string | null | undefined): string {
  const cleanName = typeof name === "string" && name.trim() ? name.trim() : "";
  const cleanSymbol = typeof symbol === "string" && symbol.trim() ? symbol.trim() : "";
  if (cleanName && cleanSymbol && cleanName !== cleanSymbol) return `${cleanName} (${cleanSymbol})`;
  if (cleanName) return cleanName;
  if (cleanSymbol) return cleanSymbol;
  return "This token";
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
  /** Liquidity-depth-only risk (deep pool vs. shallow pool), separate from LP-control risk
   *  (who can withdraw the liquidity). Keeping these distinct avoids saying "high
   *  liquidity-depth risk" when the pool is deep but LP control is the actual concern. */
  liquidityDepthRisk?: "low" | "medium" | "high" | "unknown";
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
  /** Contract-level signals (ownership, mint, simulation/tax) already verified elsewhere in the
   *  scan. When provided, the risk summary describes what was actually confirmed instead of
   *  blanket-claiming everything is unconfirmed. Wording stays provider-neutral. */
  contractSignals?: {
    ownershipStatus: "renounced" | "held" | "unknown";
    mintDetected: boolean | null;
    simulationVerified: boolean;
    buyTax: number | null;
    sellTax: number | null;
  };
}): CortexLpRead {
  const { name, symbol, totalLiq, fragments, observedPoolPresent, riskTier, liquidityDepthRisk, lpModel, migrationSummary, mode, confidence, gaps, lpLockStatus, lpLockProvider, lpUnlockTime, secondaryLpSignal, lpController, lpControllerAddress, isEstablishedToken, proofApplicability, fallbackLiquidityDetected, contractSignals } = params;
  const tokenIdentity = formatTokenIdentity(name, symbol);
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
          ? `Standard ERC-20 LP-token lock/burn proof does not apply to the primary concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.${secondaryClause}`
          : (lpController === "wallet" && isEstablishedToken)
            ? `Selected LP position appears wallet-controlled${lpControllerAddress ? ` (${lpControllerAddress})` : ""}. This is a liquidity-control signal, not proof of malicious behavior. Verify the controlling wallet and any lock/burn evidence before relying on liquidity safety.`
            : lpController === "wallet"
              // Wallet control is actually confirmed → withdrawable wording is evidence-based.
              ? "No lock or burn proof was confirmed for this LP — treat liquidity as potentially withdrawable."
              // Controller is unknown: do NOT claim liquidity is "potentially withdrawable" — that
              // implies confirmed wallet/team/contract control, which has not been established.
              : "No lock or burn proof was confirmed for the selected LP model. ChainLens could not confirm whether liquidity is controlled by a wallet, lock contract, burn address, or protocol mechanism from current evidence.";

  // Describe only what is actually unconfirmed — confirmed ownership/mint/simulation/tax
  // evidence should be reported as such instead of a blanket "unconfirmed" claim.
  const contractStatusClause = (() => {
    if (!contractSignals) {
      return "ownership, mintability, simulation and tax status remain unconfirmed";
    }
    const confirmed: string[] = [];
    const unconfirmed: string[] = [];

    if (contractSignals.ownershipStatus === "renounced") confirmed.push("ownership is verified renounced");
    else if (contractSignals.ownershipStatus === "held") confirmed.push("ownership is held by a non-renounced address");
    else unconfirmed.push("ownership");

    if (contractSignals.mintDetected === true) confirmed.push("a mint authority/function is detected");
    else if (contractSignals.mintDetected === false) confirmed.push("no mint authority was detected");
    else unconfirmed.push("mintability");

    if (contractSignals.simulationVerified) {
      const buyTaxStr = contractSignals.buyTax != null ? `${contractSignals.buyTax}%` : "unknown";
      const sellTaxStr = contractSignals.sellTax != null ? `${contractSignals.sellTax}%` : "unknown";
      confirmed.push(`a trade simulation passed (buy tax ${buyTaxStr}, sell tax ${sellTaxStr})`);
    } else {
      unconfirmed.push("simulation and tax status");
    }

    const parts: string[] = [];
    if (confirmed.length > 0) parts.push(confirmed.join(", "));
    if (unconfirmed.length > 0) parts.push(`${unconfirmed.join(", ")} remain unconfirmed`);
    return parts.join("; ");
  })();

  // Liquidity depth (how deep the pool is) and LP control (who can withdraw it) are
  // distinct risk dimensions — never describe a deep pool as carrying "high liquidity-depth
  // risk" just because the overall risk tier is high for other reasons (e.g. LP control).
  const depthClause = liquidityDepthRisk === "low"
    ? "Liquidity depth is deep relative to this token, which lowers slippage/exit-depth risk."
    : liquidityDepthRisk === "medium"
      ? "Liquidity depth is moderate for this token."
      : liquidityDepthRisk === "high"
        ? "Liquidity depth is shallow for this token, which raises slippage/exit-depth risk."
        : "Liquidity depth could not be confirmed from current evidence.";

  const lpControlRiskClause = (lpController === "wallet" && (lpLockStatus !== "locked" && lpLockStatus !== "burned"))
    ? "Separately, LP control risk is high: a dominant wallet controls the LP position and no lock or burn proof is confirmed."
    : (lpLockStatus === "locked" || lpLockStatus === "burned")
      ? "Separately, LP control risk is low: the selected LP position is locked or burned."
      : "Separately, LP control could not be confirmed from current evidence.";

  const riskSummary = contractSignals
    ? `${tokenIdentity} shows an overall "${riskTier}" risk tier based on observed pool data. ${depthClause} ${lpControlRiskClause} This also reflects available contract checks — ${contractStatusClause} (data mode: ${mode}, confidence: ${confidence}). ${lockClause}`
    : `${tokenIdentity} shows an overall "${riskTier}" risk tier based on observed pool data. ${depthClause} ${lpControlRiskClause} ${contractStatusClause} (data mode: ${mode}, confidence: ${confidence}). ${lockClause}`;

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

  // Evidence-aware contract-check actions — only ask the user to verify what is actually
  // still unconfirmed. When contractSignals is absent, preserve the old generic actions.
  const contractCheckActions: string[] = [];
  if (!contractSignals) {
    contractCheckActions.push("Verify contract ownership/renouncement and mintability via the contract source code.");
    contractCheckActions.push("Run a simulation and tax check prior to trading.");
  } else {
    if (contractSignals.ownershipStatus === "unknown") {
      contractCheckActions.push("Verify contract ownership/renouncement via the contract source code.");
    }
    if (contractSignals.mintDetected === true) {
      contractCheckActions.push("Monitor the impact of the active mint authority — confirm whether mint authority is disabled or constrained if source-level evidence is missing.");
    } else if (contractSignals.mintDetected === null) {
      contractCheckActions.push("Verify mintability via the contract source code.");
    }
    if (!contractSignals.simulationVerified) {
      contractCheckActions.push("Run a simulation and tax check prior to trading.");
    }
  }

  // LP-controller-focused actions — relevant when a wallet controls the selected LP and
  // lock/burn dominance has not been independently proven.
  const lpControllerActions: string[] = [];
  if (lpController === "wallet") {
    lpControllerActions.push("Verify LP holder distribution and confirm whether lock/burn dominance exists for the selected LP pool.");
    lpControllerActions.push("Monitor top-LP-holder wallet activity for movement of the controlling position.");
  }

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
        ? ["Position verification required: ChainLens has not confirmed a standard ERC-20 LP token for the primary pool."]
        : lpModel.standardLockApplies
          ? ["Confirm LP lock and burn status directly on-chain before trusting any safety claims."]
          : [`Standard ERC-20 LP-token lock/burn proof does not apply to the primary concentrated-liquidity pool. Liquidity control requires protocol-specific position checks.${secondaryClause}`]),
      ...lpControllerActions,
      ...contractCheckActions,
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
  /** Concrete concentrated-pool model (from attemptConcentratedPositionProof), used so the exit-risk
   * reason names the real protocol (e.g. "Uniswap V4") instead of a generic "V3/Slipstream" guess. */
  concentratedPoolModel?: ConcentratedPoolModel | null;
  /** True when a concentrated-position proof was attempted but did not resolve position ownership —
   * appended to the exit-risk reason so it never reads as a plain depth-only assessment. */
  positionOwnershipUnresolved?: boolean;
  /** Real controller-risk tier from a verified/partial concentrated position proof, used to lift
   * exit risk above a depth-only assessment when a single normal wallet controls the dominant share. */
  concentratedControllerRisk?: "low" | "watch" | "caution" | "high" | "unknown" | null;
}): LpExitRiskResult {
  const { proofApplicability, lpLockStatus, lpController, liquidityUsd, poolModel, hasPool, secondaryLpSignal, lpControllerAddress, isEstablishedToken, concentratedPoolModel, positionOwnershipUnresolved, concentratedControllerRisk } = params;

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
    const concentratedLabel = concentratedPoolModel === "uniswap_v4" ? "Uniswap V4 concentrated-liquidity"
      : concentratedPoolModel === "uniswap_v3" ? "Uniswap V3 concentrated-liquidity"
      : concentratedPoolModel === "slipstream" ? "Aerodrome Slipstream concentrated-liquidity"
      : concentratedPoolModel === "aerodrome" ? "Aerodrome concentrated-liquidity"
      : "Concentrated-liquidity (V3/Slipstream)";
    const depthClause = `Exit risk based on pool depth ($${liqStr === "unknown" ? "unknown" : liqStr.replace("$", "")})${positionOwnershipUnresolved ? " and unresolved position ownership" : ""}.`;
    // A verified/partial position proof that found a dominant normal-wallet controller is a
    // real liquidity-control signal — lift exit risk above a depth-only assessment instead of
    // silently dropping that finding.
    if (concentratedControllerRisk === "high") {
      return {
        lpExitRisk: "high",
        lpExitRiskReason: `${poolModel === "concentrated" ? concentratedLabel : "Protocol-managed"} pool — a single normal wallet controls the dominant concentrated-liquidity position. ${depthClause}${secondaryClause}`,
        liquidityDepthRisk,
      };
    }
    if (concentratedControllerRisk === "caution" || concentratedControllerRisk === "watch") {
      return {
        lpExitRisk: "watch",
        lpExitRiskReason: `${poolModel === "concentrated" ? concentratedLabel : "Protocol-managed"} pool — top concentrated-liquidity position owner is unresolved or contract-controlled. ${depthClause}${secondaryClause}`,
        liquidityDepthRisk,
      };
    }
    return {
      lpExitRisk: monitor ? "monitor" : watch ? "watch" : "open_check",
      lpExitRiskReason: `${poolModel === "concentrated" ? concentratedLabel : "Protocol-managed"} pool — standard LP lock/burn proof does not apply. ${depthClause}${secondaryClause}`,
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

  // proofApplicability === "applicable", no lock/burn proof, and the LP controller is
  // unknown. Keep the risk label and its reason internally consistent: deep liquidity →
  // "watch" with a watch-worded reason; otherwise → "open_check" with an open-check reason.
  // Never emit a "watch" label alongside an "open check" reason (or vice versa).
  if (liquidityDepthRisk === "low") {
    return {
      lpExitRisk: "watch",
      lpExitRiskReason: "Deep liquidity is present, but LP lock/burn proof and controller dominance remain unconfirmed.",
      liquidityDepthRisk,
    };
  }
  return {
    lpExitRisk: "open_check",
    lpExitRiskReason: "LP lock/burn proof applies to the selected pool, but ChainLens could not confirm lock, burn, or controller dominance from current evidence.",
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

export function deriveMigrationProof(pools: GTPool[], totalLiq: number | null, primaryPoolSelected = false): LpMigrationProof {
  const dexsUsed = Array.from(new Set(pools.map((p) => p.relationships?.dex?.data?.id).filter((d): d is string => !!d)));
  const primaryDex = pools[0]?.relationships?.dex?.data?.id ?? null;
  const liquidities = pools.map((p) => _toNum(p.attributes.reserve_in_usd as string | number | null | undefined) ?? 0);
  const topShare = totalLiq && totalLiq > 0 ? (liquidities[0] ?? 0) / totalLiq : null;

  const signals: string[] = [];
  let status: LpMigrationProof["status"] = "unknown";
  let confidence: LpMigrationProof["confidence"] = "unverified";
  let reason = "Not enough pool data to assess migration risk.";
  let liquidityDistribution = "unknown";

  // A "meaningful primary pool" exists when the top pool holds a real, non-trivial share of
  // observed liquidity. Many ecosystem pools across several DEXs is NORMAL for established
  // tokens and is not, on its own, evidence of migration.
  const hasMeaningfulPrimary = (liquidities[0] ?? 0) > 0 && topShare != null && topShare >= 0.2;
  // A primary/verification pool was actually selected by the LP pipeline — never say "no clear
  // primary pool" in that case, even if its share of TOTAL liquidity is below the 20% threshold.
  const hasSelectedPrimary = hasMeaningfulPrimary || primaryPoolSelected;

  if (pools.length > 0 && topShare != null) {
    liquidityDistribution = topShare >= 0.7 ? "concentrated in primary pool" : topShare >= 0.4 ? "moderately distributed" : "spread thinly across pools";
    if (dexsUsed.length > 1) signals.push(`Liquidity is split across ${dexsUsed.length} different DEXs.`);
    if (pools.length > 1 && topShare < 0.4) signals.push("No single pool holds a clear majority of liquidity.");
    if (pools.length === 1) signals.push("All observed liquidity sits in a single pool.");
    // Migration "watch"/"high" requires stronger evidence (recent liquidity movement, a primary-pool
    // liquidity drop, or a new pool gaining dominance). Historical movement is not available here, so
    // pool count / DEX spread alone never escalates to a migration warning — it is recorded as a gap.
    if (dexsUsed.length === 1 && topShare >= 0.7) {
      status = "low"; confidence = "medium";
      reason = "Liquidity is concentrated in a single DEX and primary pool — no migration signal observed.";
    } else if (hasSelectedPrimary) {
      status = "low"; confidence = "low";
      reason = "Liquidity is distributed across multiple pools. A primary pool is present, so pool count alone is not enough evidence of migration risk. Historical liquidity movement is unavailable.";
    } else {
      status = "unknown"; confidence = "unverified";
      reason = "Liquidity is spread across multiple pools with no clear primary pool. Historical liquidity movement is unavailable, so migration risk cannot be confirmed from current evidence.";
    }
  }

  return {
    status, confidence, reason, dexsUsed, primaryDex, liquidityDistribution, signals,
    missingEvidence: ["pool_creation_date_unavailable", "historical_liquidity_movement_unavailable"],
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

function hexToBigInt(hex: string | null): bigint | null {
  if (!hex || !/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  try { return BigInt(hex); } catch { return null; }
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

// ── Concentrated-liquidity position/controller proof ────────────────────────
// Attempts a real protocol-specific verification for V3/V4-style concentrated pools
// instead of stopping at "Position verification required". Uses only the existing
// RPC path (same as classifyPoolByRpc) — no new providers. Per-position-NFT
// ownership requires subgraph/event-indexer data this codebase does not have, so
// this never claims "verified" ownership; it reports exactly what was attempted
// and why individual position ownership could not be resolved further.
export type ConcentratedPositionProofStatus = "verified" | "partial" | "not_found" | "not_supported" | "failed" | "open_check";
export type ConcentratedPoolModel = "uniswap_v3" | "uniswap_v4" | "aerodrome" | "slipstream" | "unknown";

export type ConcentratedOwnerType = "wallet" | "contract" | "multisig" | "locker" | "burn" | "protocol" | "unknown";

/** Public ownership-proof state surfaced to Token Scanner — derived deterministically from
 * `status` + `topPositionOwnerType` (see `deriveOwnershipStatus`), never set directly. */
export type ConcentratedOwnershipStatus =
  | "ownership_verified"
  | "ownership_verified_protocol"
  | "ownership_verified_burned"
  | "ownership_verified_locked"
  | "ownership_verified_team"
  | "ownership_verified_multisig"
  | "ownership_verified_contract"
  | "ownership_open_check"
  | "ownership_unavailable_with_reason";

export interface ConcentratedOwnershipDebug {
  /** How this proof was produced. */
  source: "rpc_candidate_probe" | "external_resolver" | "rpc_liquidity_probe" | "verified_cache_restored" | "no_pool_identity";
  type: ConcentratedOwnerType | null;
  confidence: "high" | "medium" | "low";
  proofPath: string;
}

export interface ConcentratedTopOwner {
  address: string;
  ownerType: ConcentratedOwnerType;
  positionCount?: number | null;
  liquiditySharePercent?: number | null;
  liquidityRaw?: string | number | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ConcentratedPositionProof {
  status: ConcentratedPositionProofStatus;
  poolModel: ConcentratedPoolModel;
  poolAddress: string | null;
  poolId: string | null;
  poolIdentity: string | null;
  poolIdentityType: "contract" | "pool_id" | "unknown";
  positionManager: string | null;
  positionCount: number | null;
  totalPositionLiquidity: string | number | null;
  topPositionOwner: string | null;
  topPositionOwnerType: ConcentratedOwnerType | null;
  topPositionSharePercent: number | null;
  /** Up to 5 resolved owners, capped — never the full unbounded provider payload. */
  topOwners: ConcentratedTopOwner[];
  lockedOrManagedPositionFound: boolean | null;
  controllerRisk: "low" | "watch" | "caution" | "high" | "unknown";
  confidence: "high" | "medium" | "low";
  reason: string;
  evidence: string[];
  missingEvidence: string[];
  nextAction: string;
  /** Deterministic public ownership-proof state — see `ConcentratedOwnershipStatus`. */
  ownershipStatus: ConcentratedOwnershipStatus;
  ownershipDebug: ConcentratedOwnershipDebug;
}

/** Raw owner/liquidity record returned by a position-owner source (real indexer, or a test
 * fixture standing in for one). Never fabricated inside this module — only computed on real
 * data supplied by the resolver. */
export interface ConcentratedOwnerRecord {
  address: string;
  liquidityRaw: string | number;
  ownerType?: ConcentratedOwnerType;
  positionCount?: number | null;
}

/** Pluggable position-owner source. Returns null when no source is configured/available —
 * the proof then falls back to the existing RPC-only pool-confirmation path (never "verified").
 * Production has no real indexer configured today (no subgraph/Graph endpoint, no Alchemy NFT
 * API usage in this codebase) — this hook exists so a real indexer can be wired in later, and
 * so the owner/share/classification computation logic can be exercised with fixture data in tests
 * without ever causing production code to fabricate ownership. */
export type ConcentratedOwnerResolver = (input: {
  chain: LpChain;
  poolModel: ConcentratedPoolModel;
  poolAddress: string | null;
  poolId: string | null;
}) => Promise<ConcentratedOwnerRecord[] | null>;

const CONCENTRATED_PROOF_CACHE_TTL_MS = 10 * 60 * 1000;
const concentratedProofCache = new Map<string, { exp: number; data: ConcentratedPositionProof }>();

const KNOWN_PROTOCOL_MANAGERS = new Set([
  "0xc36442b4a4522e871399cd717abdd847ab11fe88", // Uniswap V3 NonfungiblePositionManager (ETH + many chains)
  "0x03a520b32c04bf3beef7beb72e919cf822ed34f1", // Uniswap V3 NonfungiblePositionManager (Base)
]);

const POSITION_MANAGER_BY_CHAIN: Record<LpChain, string> = {
  eth: "0xc36442b4a4522e871399cd717abdd847ab11fe88",
  base: "0x03a520b32c04bf3beef7beb72e919cf822ed34f1",
};

/** Stage 1 — protocol resolver. Centralizes the protocol/position-manager knowledge that was
 * previously only implicit in `_classifyConcentratedPoolModel`/`POSITION_MANAGER_BY_CHAIN`, so
 * this lookup lives in exactly one place instead of being re-derived ad hoc by callers. Only
 * returns a `positionManager` address when it is one already verified/used elsewhere in this
 * file (Uniswap V3's standard NonfungiblePositionManager) — never guesses an address for a
 * protocol/chain this codebase has not already confirmed, since an unverified address fed into
 * the on-chain candidate probe could misattribute ownership to the wrong contract. */
export interface ConcentratedProtocolInfo {
  protocol: ConcentratedPoolModel;
  positionManager: string | null;
  factory: string | null;
  router: string | null;
  nftManager: string | null;
  /** "high" only when a verified position-manager address is known for this protocol+chain;
   * "low" means the pool model was classified but no position-manager address is confirmed. */
  confidence: "high" | "low";
}

export function resolveConcentratedProtocol(
  chain: LpChain,
  dexId: string | null | undefined,
  poolAddressType: "contract" | "pool_id" | "unknown",
): ConcentratedProtocolInfo {
  const protocol = _classifyConcentratedPoolModel(dexId, poolAddressType);
  // Only Uniswap V3's NonfungiblePositionManager is a verified address in this codebase today.
  // Aerodrome Slipstream/Pancake V3/other Base concentrated forks are detected and labeled
  // correctly, but their position-manager addresses are not yet confirmed here — reporting one
  // without verification would risk probing the wrong contract, so this stays null/low-confidence
  // for them rather than guessing.
  const positionManager = protocol === "uniswap_v3" ? (POSITION_MANAGER_BY_CHAIN[chain] ?? null) : null;
  return {
    protocol,
    positionManager,
    factory: null,
    router: null,
    nftManager: positionManager,
    confidence: positionManager ? "high" : "low",
  };
}

/** Address-keyed (chain:poolIdentity) regression guard so a transient RPC hiccup on a later scan
 * can never downgrade a previously-verified ownership result back to open check/unavailable —
 * mirrors the same pattern used for wallet evidence in lib/server/walletSnapshot.ts. */
const VERIFIED_OWNERSHIP_TTL_MS = 6 * 60 * 60 * 1000;
const verifiedOwnershipCache = new Map<string, { cachedAt: number; ownershipStatus: ConcentratedOwnershipStatus; proof: ConcentratedPositionProof }>();
const _isVerifiedOwnership = (s: ConcentratedOwnershipStatus): boolean => s.startsWith("ownership_verified");

/** Gnosis Safe (and Safe-compatible) `getOwners()` selector — used only as a real on-chain probe
 * to distinguish a multisig contract from an arbitrary contract/EOA; never assumed. */
const SAFE_GET_OWNERS_SELECTOR = "0xa0e67e2b";

/** Real on-chain probe: calls `getOwners()` and only treats the address as a multisig when the
 * call resolves with a decodable non-empty array payload (offset word + length word present). */
async function _isLikelySafeMultisig(chain: LpChain, address: string): Promise<boolean> {
  try {
    const hex = await lpRpcCall(chain, "eth_call", [{ to: address, data: SAFE_GET_OWNERS_SELECTOR }, "latest"]);
    if (!_rpcResolved(hex) || hex == null) return false;
    const body = hex.slice(2);
    if (body.length < 128) return false; // offset word + length word minimum
    const lengthWord = body.slice(64, 128);
    const length = hexToBigInt("0x" + lengthWord);
    return length != null && length > BigInt(0) && length < BigInt(100);
  } catch { return false; }
}

/** Classifies an owner address using only real, already-available signals — never invents an
 * owner identity. Burn/locker registries are the same ones used for the V2 LP lock/burn proof
 * (LP_LOCK_BURN_REGISTRY); contract-vs-wallet uses a real eth_getCode RPC probe; multisig uses a
 * real getOwners() probe on top of the contract-code check. */
export async function classifyConcentratedOwnerType(chain: LpChain, address: string): Promise<ConcentratedOwnerType> {
  const addr = address.toLowerCase();
  if (addr === LP_ZERO_ADDRESS || addr === LP_DEAD_ADDRESS) return "burn";
  if (KNOWN_PROTOCOL_MANAGERS.has(addr)) return "protocol";
  const lockers = (LP_LOCK_BURN_REGISTRY.lockersByChain as Record<string, readonly string[]>)[chain] ?? [];
  if (lockers.some((l) => l.toLowerCase() === addr)) return "locker";
  try {
    const code = await lpRpcCall(chain, "eth_getCode", [addr, "latest"]);
    if (typeof code === "string" && code !== "0x" && code.length > 2) {
      if (await _isLikelySafeMultisig(chain, addr)) return "multisig";
      return "contract";
    }
    if (code === "0x") return "wallet";
  } catch { /* fall through to unknown */ }
  return "unknown";
}

/** Pure share/top-owner computation from real owner-liquidity records — no network calls,
 * fully unit-testable. Caps the returned owner list to 5. */
export function computeTopOwnerShare(owners: Array<{ address: string; liquidityRaw: string | number; ownerType: ConcentratedOwnerType; positionCount?: number | null }>): {
  total: bigint;
  topOwners: ConcentratedTopOwner[];
  topPositionOwner: string | null;
  topPositionOwnerType: ConcentratedOwnerType | null;
  topPositionSharePercent: number | null;
} {
  const parsed = owners
    .map((o) => ({ ...o, liq: typeof o.liquidityRaw === "number" ? BigInt(Math.trunc(o.liquidityRaw)) : BigInt(o.liquidityRaw || "0") }))
    .filter((o) => o.liq > BigInt(0))
    .sort((a, b) => (b.liq > a.liq ? 1 : b.liq < a.liq ? -1 : 0));
  const total = parsed.reduce((sum, o) => sum + o.liq, BigInt(0));
  const topOwners: ConcentratedTopOwner[] = parsed.slice(0, 5).map((o) => ({
    address: o.address,
    ownerType: o.ownerType,
    positionCount: o.positionCount ?? null,
    liquiditySharePercent: total > BigInt(0) ? Math.round(Number((o.liq * BigInt(10000)) / total) / 100 * 100) / 100 : null,
    liquidityRaw: o.liquidityRaw,
    confidence: "medium",
    reason: `Liquidity-weighted share computed from ${parsed.length} resolved position owner(s).`,
  }));
  const top = parsed[0] ?? null;
  return {
    total,
    topOwners,
    topPositionOwner: top ? top.address : null,
    topPositionOwnerType: top ? top.ownerType : null,
    topPositionSharePercent: top && total > BigInt(0) ? Math.round(Number((top.liq * BigInt(10000)) / total) / 100 * 100) / 100 : null,
  };
}

function _concentratedControllerRisk(ownerType: ConcentratedOwnerType | null, sharePercent: number | null): "low" | "watch" | "caution" | "high" | "unknown" {
  if (ownerType == null || sharePercent == null) return "unknown";
  if (ownerType === "burn" || ownerType === "locker") return "low";
  if (ownerType === "protocol") return sharePercent >= 80 ? "watch" : "low";
  if (ownerType === "wallet") return sharePercent >= 50 ? "high" : sharePercent >= 25 ? "caution" : "watch";
  if (ownerType === "multisig") return sharePercent >= 50 ? "caution" : "watch";
  if (ownerType === "contract") return sharePercent >= 50 ? "caution" : "watch";
  return "watch";
}

/** Maps a final proof status + the resolved top-owner type to the public ownership-proof state.
 * Never set directly anywhere else — this is the single source of truth for the taxonomy so the
 * same (status, ownerType) pair always yields the same public state. */
function deriveOwnershipStatus(status: ConcentratedPositionProofStatus, ownerType: ConcentratedOwnerType | null): ConcentratedOwnershipStatus {
  if (status === "verified") {
    switch (ownerType) {
      case "burn": return "ownership_verified_burned";
      case "locker": return "ownership_verified_locked";
      case "protocol": return "ownership_verified_protocol";
      case "multisig": return "ownership_verified_multisig";
      case "contract": return "ownership_verified_contract";
      case "wallet": return "ownership_verified_team";
      default: return "ownership_verified";
    }
  }
  // "partial" means a real attempt was made (a pool/owner source responded) but no ownership
  // evidence resulted — a genuine open check, distinct from a structural reason it couldn't be
  // attempted at all (no pool data / unsupported model / RPC failure), which is the bucket below.
  if (status === "partial") return "ownership_open_check";
  return "ownership_unavailable_with_reason";
}

function _classifyConcentratedPoolModel(dexId: string | null | undefined, poolAddressType: "contract" | "pool_id" | "unknown"): ConcentratedPoolModel {
  const d = (dexId ?? "").toLowerCase();
  if (/aerodrome|velodrome/.test(d)) return /slipstream/.test(d) ? "slipstream" : "aerodrome";
  if (/uniswap/.test(d)) {
    if (/v4/.test(d)) return "uniswap_v4";
    if (/v3/.test(d)) return "uniswap_v3";
    // No version in dex metadata — a 32-byte poolId (no per-pool contract address) is the
    // V4-singleton shape; a real pool contract address is the V3 shape.
    return poolAddressType === "pool_id" ? "uniswap_v4" : "uniswap_v3";
  }
  return poolAddressType === "pool_id" ? "uniswap_v4" : "unknown";
}

// Real position-owner resolution, applied uniformly for both V3 (contract) and V4 (pool-id)
// pools when a resolver is supplied. Returns null when the resolver itself returns null/empty
// (so the caller falls back to the existing RPC-only confirmation path) or errors/times out.
async function _resolveOwnersSafely(
  resolver: ConcentratedOwnerResolver | undefined,
  input: { chain: LpChain; poolModel: ConcentratedPoolModel; poolAddress: string | null; poolId: string | null },
): Promise<ConcentratedOwnerRecord[] | null> {
  if (!resolver) return null;
  try {
    const result = await Promise.race([
      resolver(input),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    return Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

type ConcentratedPositionProofCore = Omit<ConcentratedPositionProof, "ownershipStatus" | "ownershipDebug">;

/** Real, RPC-only ownership probe: checks whether any already-known address (burn, dead, or a
 * registered LP locker for this chain) holds a NonfungiblePositionManager NFT position matching
 * this pool's token pair. No subgraph, no new provider — same eth_call pattern used elsewhere in
 * this module. Returns null (never []) when the pool model/manager isn't a known V3-style
 * NonfungiblePositionManager, so callers fall back to the existing RPC liquidity-only probe;
 * returns [] when the manager was queried but none of the known candidates hold a matching
 * position (a genuine, attempted, negative result). Never queries arbitrary/unknown wallets —
 * only the same burn/locker addresses already trusted elsewhere in this file. */
async function _resolveKnownCandidateOwners(
  chain: LpChain,
  poolModel: ConcentratedPoolModel,
  poolAddress: string,
): Promise<ConcentratedOwnerRecord[] | null> {
  if (poolModel !== "uniswap_v3") return null;
  const manager = POSITION_MANAGER_BY_CHAIN[chain];
  if (!manager) return null;

  const call = (to: string, data: string) => lpRpcCall(chain, "eth_call", [{ to, data }, "latest"]);
  let token0Hex: string | null;
  let token1Hex: string | null;
  try {
    [token0Hex, token1Hex] = await Promise.all([call(poolAddress, "0x0dfe1681"), call(poolAddress, "0xd21220a7")]);
  } catch { return null; }
  if (!_rpcResolved(token0Hex) || !_rpcResolved(token1Hex)) return null;
  const token0 = "0x" + (token0Hex as string).slice(-40);
  const token1 = "0x" + (token1Hex as string).slice(-40);

  const lockers = (LP_LOCK_BURN_REGISTRY.lockersByChain as Record<string, readonly string[]>)[chain] ?? [];
  const candidates = [LP_ZERO_ADDRESS, LP_DEAD_ADDRESS, ...lockers].map((a) => a.toLowerCase());

  const records: ConcentratedOwnerRecord[] = [];
  for (const candidate of candidates) {
    let balanceHex: string | null;
    try {
      balanceHex = await call(manager, "0x70a08231" + padAddress(candidate));
    } catch { continue; }
    const balance = _rpcResolved(balanceHex) ? hexToBigInt(balanceHex) : null;
    if (!balance || balance <= BigInt(0)) continue;
    const enumerateCount = Number(balance > BigInt(5) ? BigInt(5) : balance);
    let matchedLiquidity = BigInt(0);
    let matchedPositions = 0;
    for (let i = 0; i < enumerateCount; i++) {
      let tokenIdHex: string | null;
      try {
        tokenIdHex = await call(manager, "0x2f745c59" + padAddress(candidate) + BigInt(i).toString(16).padStart(64, "0"));
      } catch { continue; }
      if (!_rpcResolved(tokenIdHex)) continue;
      const tokenId = hexToBigInt(tokenIdHex);
      if (tokenId == null) continue;
      let positionsHex: string | null;
      try {
        positionsHex = await call(manager, "0x99fbab88" + tokenId.toString(16).padStart(64, "0"));
      } catch { continue; }
      if (!_rpcResolved(positionsHex) || positionsHex == null) continue;
      const body = positionsHex.slice(2);
      if (body.length < 64 * 8) continue; // need at least words 0..7 (token0, token1, fee, ticks, liquidity)
      const posToken0 = "0x" + body.slice(2 * 64, 2 * 64 + 64).slice(-40);
      const posToken1 = "0x" + body.slice(3 * 64, 3 * 64 + 64).slice(-40);
      const matchesPool = (posToken0 === token0 && posToken1 === token1) || (posToken0 === token1 && posToken1 === token0);
      if (!matchesPool) continue;
      const liquidity = hexToBigInt("0x" + body.slice(7 * 64, 7 * 64 + 64));
      if (liquidity != null && liquidity > BigInt(0)) {
        matchedLiquidity += liquidity;
        matchedPositions += 1;
      }
    }
    if (matchedLiquidity > BigInt(0)) {
      records.push({ address: candidate, liquidityRaw: matchedLiquidity.toString(), positionCount: matchedPositions });
    }
  }
  return records;
}

async function _buildVerifiedOrPartialFromOwners(
  chain: LpChain,
  base: Omit<ConcentratedPositionProofCore, "status" | "reason" | "evidence" | "missingEvidence" | "nextAction" | "confidence">,
  owners: ConcentratedOwnerRecord[],
): Promise<ConcentratedPositionProofCore> {
  if (owners.length === 0) {
    return {
      ...base,
      status: "partial",
      confidence: "low",
      reason: "A position-owner source was queried but returned no resolvable position owners for this pool.",
      evidence: ["owner source queried: 0 owners returned"],
      missingEvidence: ["topPositionOwner", "positionCount", "topPositionSharePercent"],
      nextAction: "Re-check position ownership once the indexer has caught up, or verify manually via the position-manager UI.",
    };
  }
  const classified = await Promise.all(owners.map(async (o) => ({
    ...o,
    ownerType: o.ownerType ?? await classifyConcentratedOwnerType(chain, o.address),
  })));
  const { total, topOwners, topPositionOwner, topPositionOwnerType, topPositionSharePercent } = computeTopOwnerShare(classified);
  const controllerRisk = _concentratedControllerRisk(topPositionOwnerType, topPositionSharePercent);
  return {
    ...base,
    positionCount: classified.length,
    totalPositionLiquidity: total.toString(),
    topPositionOwner,
    topPositionOwnerType,
    topPositionSharePercent,
    topOwners,
    lockedOrManagedPositionFound: topPositionOwnerType === "locker" || topPositionOwnerType === "burn",
    controllerRisk,
    status: "verified",
    confidence: topPositionOwnerType && topPositionOwnerType !== "unknown" ? "high" : "medium",
    reason: `Position ownership resolved from ${classified.length} position record(s); top owner controls ${topPositionSharePercent ?? "an unknown"}% of resolved concentrated liquidity.`,
    evidence: [
      `positions resolved: ${classified.length}`,
      `top owner type: ${topPositionOwnerType ?? "unknown"}`,
      `top owner share: ${topPositionSharePercent != null ? `${topPositionSharePercent}%` : "unknown"}`,
    ],
    missingEvidence: [],
    nextAction: topPositionOwnerType === "wallet" && (topPositionSharePercent ?? 0) >= 50
      ? "Monitor the dominant position owner for liquidity withdrawal."
      : "Re-scan periodically to confirm position ownership remains stable.",
  };
}

export async function attemptConcentratedPositionProof(
  chain: LpChain,
  poolAddress: string | null | undefined,
  poolId: string | null | undefined,
  poolAddressType: "contract" | "pool_id" | "unknown",
  dexId: string | null | undefined,
  resolveOwners?: ConcentratedOwnerResolver,
): Promise<ConcentratedPositionProof> {
  const protocolInfo = resolveConcentratedProtocol(chain, dexId, poolAddressType);
  const poolModel = protocolInfo.protocol;
  const normalizedPoolAddress = poolAddressType === "contract" ? (poolAddress ?? null) : null;
  const normalizedPoolId = poolId ?? (poolAddressType === "pool_id" ? (poolAddress ?? null) : null);
  const poolIdentity = normalizedPoolId ?? normalizedPoolAddress ?? null;

  const cacheKey = poolIdentity ? `${chain}:${poolIdentity}` : null;
  if (cacheKey && !resolveOwners) {
    const cached = concentratedProofCache.get(cacheKey);
    if (cached && cached.exp > Date.now()) return cached.data;
  }

  const base: Omit<ConcentratedPositionProofCore, "status" | "reason" | "evidence" | "missingEvidence" | "nextAction" | "confidence"> = {
    poolModel,
    poolAddress: normalizedPoolAddress,
    poolId: normalizedPoolId,
    poolIdentity,
    poolIdentityType: normalizedPoolId ? "pool_id" : normalizedPoolAddress ? "contract" : "unknown",
    positionManager: protocolInfo.positionManager,
    positionCount: null,
    totalPositionLiquidity: null,
    topPositionOwner: null,
    topPositionOwnerType: null,
    topPositionSharePercent: null,
    topOwners: [],
    lockedOrManagedPositionFound: null,
    controllerRisk: "unknown",
  };

  const finish = (core: ConcentratedPositionProofCore, source: ConcentratedOwnershipDebug["source"], proofPath: string): ConcentratedPositionProof => {
    const ownershipStatus = deriveOwnershipStatus(core.status, core.topPositionOwnerType);
    let result: ConcentratedPositionProof = {
      ...core,
      ownershipStatus,
      ownershipDebug: { source, type: core.topPositionOwnerType, confidence: core.confidence, proofPath },
    };

    // Requirement 8: never downgrade verified ownership back to a weaker state when stronger
    // evidence was already verified for this exact pool — restore it instead of regressing.
    if (cacheKey) {
      const prior = verifiedOwnershipCache.get(cacheKey);
      const priorFresh = prior && (Date.now() - prior.cachedAt) <= VERIFIED_OWNERSHIP_TTL_MS;
      if (priorFresh && prior && _isVerifiedOwnership(prior.ownershipStatus) && !_isVerifiedOwnership(ownershipStatus)) {
        result = { ...prior.proof, ownershipDebug: { ...prior.proof.ownershipDebug, source: "verified_cache_restored" } };
      } else if (_isVerifiedOwnership(ownershipStatus)) {
        verifiedOwnershipCache.set(cacheKey, { cachedAt: Date.now(), ownershipStatus, proof: result });
      }
    }

    if (cacheKey && !resolveOwners) concentratedProofCache.set(cacheKey, { exp: Date.now() + CONCENTRATED_PROOF_CACHE_TTL_MS, data: result });
    return result;
  };

  if (!poolAddress && !poolId) {
    return finish({
      ...base,
      status: "open_check",
      confidence: "low",
      reason: "No pool address or pool ID is available to attempt a position-proof check.",
      evidence: [],
      missingEvidence: ["poolAddress", "poolId"],
      nextAction: "Re-scan once a pool address or pool ID is indexed for this token.",
    }, "no_pool_identity", "no_pool_address_or_id");
  }

  // Uniswap V4 (and any pool only identified by a 32-byte poolId): pools are sub-accounts of a
  // singleton PoolManager contract, not standalone contracts. Per-position ownership for V4 is
  // only resolvable through PoolManager mint/burn event indexing (a subgraph), which is not part
  // of the existing RPC/market provider path here. If a real position-owner source is plugged in
  // via `resolveOwners`, attempt it first — but never fabricate an owner when none is configured.
  if (!poolAddress || poolAddressType === "pool_id") {
    const v4Owners = await _resolveOwnersSafely(resolveOwners, { chain, poolModel, poolAddress: normalizedPoolAddress, poolId: normalizedPoolId });
    if (v4Owners != null) return finish(await _buildVerifiedOrPartialFromOwners(chain, base, v4Owners), "external_resolver", "v4_external_resolver");
    return finish({
      ...base,
      status: "not_supported",
      confidence: "low",
      reason: "The pool is confirmed active but ownership of its concentrated liquidity positions could not be fully resolved.",
      evidence: poolId ? [`poolId=${poolId}`] : [],
      missingEvidence: ["positionManager", "topPositionOwner", "positionCount", "positionLiquidityShare"],
      nextAction: "Liquidity ownership is still being verified — re-check after the next scan.",
    }, "no_pool_identity", "v4_not_supported");
  }

  // V3-style pool with a real contract address: try a real position-owner source first (if
  // one is configured via `resolveOwners`); then a real on-chain probe of known burn/locker
  // candidates against the NonfungiblePositionManager; otherwise fall back to the existing RPC
  // probe of the pool itself, which confirms liquidity but cannot attribute it to a position owner.
  const v3Owners = await _resolveOwnersSafely(resolveOwners, { chain, poolModel, poolAddress: normalizedPoolAddress, poolId: normalizedPoolId });
  if (v3Owners != null) return finish(await _buildVerifiedOrPartialFromOwners(chain, base, v3Owners), "external_resolver", "v3_external_resolver");

  const candidateOwners = await _resolveKnownCandidateOwners(chain, poolModel, poolAddress);
  if (candidateOwners != null && candidateOwners.length > 0) {
    return finish(await _buildVerifiedOrPartialFromOwners(chain, base, candidateOwners), "rpc_candidate_probe", "nft_position_manager_candidate_probe");
  }

  const call = (selector: string) => lpRpcCall(chain, "eth_call", [{ to: poolAddress.toLowerCase(), data: selector }, "latest"]);
  let liquidityHex: string | null = null;
  let slot0Hex: string | null = null;
  try {
    [liquidityHex, slot0Hex] = await Promise.all([call("0x1a686502"), call("0x3850c7bd")]);
  } catch {
    return finish({
      ...base,
      status: "failed",
      confidence: "low",
      reason: "RPC call to the pool contract failed while attempting position-proof verification.",
      evidence: [],
      missingEvidence: ["liquidity", "slot0", "topPositionOwner"],
      nextAction: "Retry the scan; if this persists the RPC provider may be unavailable for this chain.",
    }, "rpc_liquidity_probe", "pool_rpc_call_failed");
  }
  const liquidityResolved = _rpcResolved(liquidityHex);
  const slot0Resolved = _rpcResolved(slot0Hex);
  if (!liquidityResolved && !slot0Resolved) {
    return finish({
      ...base,
      status: "failed",
      confidence: "low",
      reason: "Pool contract did not respond to liquidity()/slot0() probes — position proof could not be attempted.",
      evidence: [],
      missingEvidence: ["liquidity", "slot0", "topPositionOwner"],
      nextAction: "Retry the scan; if this persists the pool may use a non-standard interface.",
    }, "rpc_liquidity_probe", "pool_rpc_probes_unresolved");
  }
  const liquidityBig = liquidityResolved ? hexToBigInt(liquidityHex) : null;
  if (liquidityResolved && liquidityBig === BigInt(0)) {
    return finish({
      ...base,
      status: "not_found",
      confidence: "medium",
      reason: "Pool contract confirmed on-chain, but reports zero active liquidity — no position to attribute ownership to.",
      evidence: [`liquidity=0`],
      missingEvidence: ["topPositionOwner", "positionCount"],
      nextAction: "Re-check if liquidity is added to this pool; no active position currently exists.",
    }, "rpc_liquidity_probe", "pool_liquidity_zero");
  }
  return finish({
    ...base,
    totalPositionLiquidity: liquidityBig != null ? liquidityBig.toString() : null,
    status: "partial",
    confidence: "low",
    reason: "The pool is confirmed active, but the largest liquidity owner could not be verified from currently available evidence.",
    evidence: [
      liquidityResolved ? `liquidity probe: resolved (${liquidityBig != null ? liquidityBig.toString() : "nonzero"})` : `liquidity probe: unresolved`,
      slot0Resolved ? `slot0 probe: resolved (pool active)` : `slot0 probe: unresolved`,
    ],
    // positionManager is already resolved here (base.positionManager comes from the verified
    // protocol registry) — only the remaining ownership evidence is actually missing.
    missingEvidence: base.positionManager
      ? ["topPositionOwner", "positionCount", "topPositionSharePercent"]
      : ["positionManager", "topPositionOwner", "positionCount", "topPositionSharePercent"],
    nextAction: "Liquidity ownership is still being verified — re-check after the next scan.",
  }, "rpc_liquidity_probe", "pool_liquidity_confirmed_no_owner");
}

// ─── Canonical pool identity — cross-scan stability for the same pool address ──────────────
// A pool's model (concentrated vs constant-product) must not flip between scans of the same
// token just because one scan only had generic/fallback market data while another had richer
// primary-market or RPC-probe evidence. mergeCanonicalPoolIdentity() never lets a less specific
// classification overwrite a more specific one for the same address; the in-memory cache below
// lets that hold across separate requests within one server process, without any new provider
// calls or persistent storage.

export type CanonicalPoolModel = "constant_product" | "concentrated" | "unknown" | "protocol_managed" | "virtual";
export type CanonicalPoolIdentitySource = "primary_market" | "fallback_market" | "rpc_probe" | "merged";

export interface CanonicalPoolIdentity {
  poolAddress: string | null;
  poolId: string | null;
  pair: string | null;
  protocol: string | null;
  protocolVariant: string | null;
  dexName: string | null;
  model: CanonicalPoolModel;
  confidence: "low" | "medium" | "high";
  source: CanonicalPoolIdentitySource;
  evidence: string[];
  canApplyErc20LpProof: boolean;
  requiresPositionProof: boolean;
  standardLockBurnApplies: boolean;
  reason: string;
}

// Higher number = more specific/trustworthy classification. unknown must never outrank a
// known model; concentrated/protocol-specific evidence outranks a generic constant-product
// guess derived only from a bare dex-name string.
const _CANONICAL_MODEL_SPECIFICITY: Record<CanonicalPoolModel, number> = {
  unknown: 0,
  constant_product: 1,
  protocol_managed: 2,
  virtual: 2,
  concentrated: 3,
};
const _CANONICAL_SOURCE_SPECIFICITY: Record<CanonicalPoolIdentitySource, number> = {
  fallback_market: 0,
  primary_market: 1,
  merged: 1,
  rpc_probe: 2,
};

/** Pure merge — given the previously known identity for a pool address (if any) and a newly
 * computed one, returns whichever is more specific, never letting a generic/lower-confidence
 * read downgrade a model that was already established with stronger evidence. */
export function mergeCanonicalPoolIdentity(
  prev: CanonicalPoolIdentity | null,
  next: CanonicalPoolIdentity,
): CanonicalPoolIdentity {
  if (!prev) return next;
  const prevRank = _CANONICAL_MODEL_SPECIFICITY[prev.model];
  const nextRank = _CANONICAL_MODEL_SPECIFICITY[next.model];
  if (nextRank > prevRank) return { ...next, source: "merged", evidence: [...next.evidence, `previous_read=${prev.model}`] };
  if (nextRank < prevRank) {
    // Generic/lower-specificity data must not erase a previously established richer model —
    // keep the prior model, but record that a weaker read was observed for this address.
    return { ...prev, source: "merged", evidence: [...prev.evidence, `weaker_read_ignored=${next.model} (source=${next.source})`] };
  }
  // Same model rank — prefer the more specific source (e.g. rpc_probe over fallback_market),
  // and on a tie keep the previous read to avoid unnecessary churn.
  const prevSourceRank = _CANONICAL_SOURCE_SPECIFICITY[prev.source];
  const nextSourceRank = _CANONICAL_SOURCE_SPECIFICITY[next.source];
  return nextSourceRank > prevSourceRank ? { ...next, source: "merged" } : { ...prev, source: "merged" };
}

// Process-lifetime cache only — no new provider calls, no persistent storage. Keyed by
// lowercased pool address. Best-effort: a cold/restarted process simply starts empty again,
// which only ever means "less stability", never a fabricated/incorrect classification.
const _canonicalPoolIdentityCache = new Map<string, CanonicalPoolIdentity>();

export function getCachedCanonicalPoolIdentity(poolAddress: string | null): CanonicalPoolIdentity | null {
  if (!poolAddress) return null;
  return _canonicalPoolIdentityCache.get(poolAddress.toLowerCase()) ?? null;
}

/** Merges `next` against any cached identity for the same address, stores the merged result,
 * and returns it. This is the single entry point route handlers should call so cross-scan
 * stability and the in-process cache stay consistent with each other. */
export function reconcileCanonicalPoolIdentity(next: CanonicalPoolIdentity): CanonicalPoolIdentity {
  if (!next.poolAddress) return next;
  const key = next.poolAddress.toLowerCase();
  const merged = mergeCanonicalPoolIdentity(_canonicalPoolIdentityCache.get(key) ?? null, next);
  _canonicalPoolIdentityCache.set(key, merged);
  return merged;
}

/** Builds a CanonicalPoolIdentity from the same dex-id classification already used elsewhere
 * (classifyPoolModel) plus the caller's confidence/source — never a separate fabricated
 * classification. A bare "aerodrome" dex id with no concentrated/v2 marker and no RPC
 * confirmation is intentionally classified "unknown", not assumed constant_product. */
export function buildCanonicalPoolIdentity(input: {
  poolAddress: string | null;
  poolId: string | null;
  pair: string | null;
  dexId: string | null;
  dexName: string | null;
  source: CanonicalPoolIdentitySource;
  rpcConfirmedModel?: "v2" | "concentrated" | "unknown" | null;
}): CanonicalPoolIdentity {
  const id = (input.dexId ?? "").toLowerCase().trim();
  const isAerodrome = id.includes("aerodrome") || id.includes("velodrome");
  const hasConcentratedMarker = /(slipstream|concentrated|algebra|\bv4\b|[-_]v4|^v4|\bcl\b|[-_]cl[-_]?|[-_]cl$)|(?:^|[-_])v3(?:[-_]|$)/.test(id);
  const hasV2Marker = /(?:^|[-_])v2(?:[-_]|$)/.test(id);
  const protocol = isAerodrome ? "Aerodrome" : (input.dexName ?? input.dexId ?? null);
  const isGenericAerodromeOnly = isAerodrome && !hasConcentratedMarker && !hasV2Marker && input.source === "fallback_market" && input.rpcConfirmedModel !== "v2";

  let model: CanonicalPoolModel;
  let protocolVariant: string | null;
  let reason: string;
  if (hasConcentratedMarker || input.rpcConfirmedModel === "concentrated") {
    model = "concentrated";
    protocolVariant = isAerodrome ? "Aerodrome Slipstream" : "concentrated";
    reason = isAerodrome
      ? "Aerodrome Slipstream (concentrated-liquidity) pool — standard ERC-20 LP lock/burn proof does not apply."
      : "Concentrated-liquidity (V3/V4) pool — standard ERC-20 LP lock/burn proof does not apply.";
  } else if (isGenericAerodromeOnly) {
    // Bare "Aerodrome" dex name from fallback market data alone, with no v2/slipstream
    // marker and no RPC confirmation — pool model is unverified, never assumed CPMM.
    model = "unknown";
    protocolVariant = null;
    reason = "Fallback market data names an Aerodrome pool, but provides no model evidence — pool model requires verification before standard ERC-20 LP proof can apply.";
  } else if (hasV2Marker || input.rpcConfirmedModel === "v2" || (isAerodrome === false && id.length > 0)) {
    model = id.length > 0 ? "constant_product" : "unknown";
    protocolVariant = isAerodrome ? "Aerodrome V2" : null;
    reason = id.length > 0
      ? "Constant-product V2-style pool — pool contract is an ERC-20 LP token."
      : "No DEX metadata available to classify pool model.";
  } else {
    model = "unknown";
    protocolVariant = null;
    reason = "Pool model could not be determined from available evidence.";
  }

  return {
    poolAddress: input.poolAddress,
    poolId: input.poolId,
    pair: input.pair,
    protocol,
    protocolVariant,
    dexName: input.dexName ?? input.dexId ?? null,
    model,
    confidence: model === "unknown" ? "low" : (input.source === "rpc_probe" ? "high" : "medium"),
    source: input.source,
    evidence: [`dexId=${input.dexId ?? "unknown"}`, `source=${input.source}`],
    canApplyErc20LpProof: model === "constant_product",
    requiresPositionProof: model === "concentrated",
    standardLockBurnApplies: model === "constant_product",
    reason,
  };
}

/** Public canonical fields layered on top of a real ConcentratedPositionProof attempt — never
 * invented separately from it. positionOwnershipStatus mirrors `status` under the public name
 * the dashboard/API contract uses; summary/evidenceGaps/nextActions restate the same
 * evidence/missingEvidence/nextAction the engine already produced, in the stable public shape. */
export interface ConcentratedPositionProofRead {
  proofType: "concentrated_position";
  protocol: string | null;
  poolPair: string | null;
  positionOwnershipStatus: ConcentratedPositionProofStatus;
  activePositionCount: number | null;
  totalLiquidityTracked: string | number | null;
  summary: string;
  evidenceGaps: string[];
  nextActions: string[];
}

/** Humanizes raw missingEvidence keys into user-facing copy. Protocol-aware: Uniswap V4 gets a
 * model-specific "position manager" label, every other pool model gets neutral wording rather than
 * guessing a protocol that wasn't actually resolved. */
function humanizeConcentratedEvidenceGap(key: string, poolModel: string | null | undefined): string {
  const isV4 = poolModel === "uniswap_v4";
  switch (key) {
    case "positionManager":
      return isV4
        ? "Uniswap V4 concentrated position manager not supported yet"
        : "Concentrated position manager not supported yet for this pool model";
    case "topPositionOwner":
      return "Top liquidity owner not verified";
    case "positionCount":
      return "Active liquidity positions not indexed";
    case "topPositionSharePercent":
      return "Position liquidity share not available";
    default:
      return "Protocol-specific position ownership not verified";
  }
}

export function buildConcentratedPositionProofRead(
  proof: ConcentratedPositionProof,
  ctx?: { protocol?: string | null; poolPair?: string | null },
): ConcentratedPositionProofRead {
  const status = proof.status === "verified" || proof.status === "partial" ? proof.status : "open_check";
  const summary = status === "verified" || status === "partial"
    ? proof.reason
    : "Concentrated pool detected; position ownership proof is not yet verified.";
  const evidenceGaps = proof.missingEvidence.length > 0
    ? proof.missingEvidence.map((key) => humanizeConcentratedEvidenceGap(key, proof.poolModel))
    : ["Protocol-specific position ownership not verified"];
  const nextActions = proof.nextAction
    ? [proof.nextAction]
    : [
        "verify protocol-specific liquidity positions",
        "monitor pool liquidity changes",
        "rescan after position proof support is available",
      ];
  return {
    proofType: "concentrated_position",
    protocol: ctx?.protocol ?? null,
    poolPair: ctx?.poolPair ?? null,
    positionOwnershipStatus: status,
    activePositionCount: proof.positionCount,
    totalLiquidityTracked: proof.totalPositionLiquidity,
    summary,
    evidenceGaps,
    nextActions,
  };
}
