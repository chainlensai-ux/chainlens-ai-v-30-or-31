// CONCENTRATED LP POSITION INDEXING, DISCLOSED (Token Scanner LP Safety):
// V3/V4 concentrated pools have no ERC-20 LP token, so lock/burn holder proof does not apply.
// This module still attempts REAL position-ownership proof via Alchemy/RPC event logs for
// Uniswap V3, Uniswap V4, Aerodrome Slipstream, and PancakeSwap V3 on Base / Ethereum / BNB.
// Never fabricates an owner, share, lock, burn, or "verified control" result.

import { LP_LOCK_BURN_REGISTRY } from "./lpLockBurnIntel.ts";
import { logRpcCall } from "./rpcDebug.ts";
import { auditGlobalAlchemyCall } from "./globalRpcAudit.ts";

export type ConcentratedLpProtocol = "uniswap_v3" | "uniswap_v4" | "pancakeswap_v3" | "slipstream" | "unknown";

export type ConcentratedLpPositionStatus =
  | "verified_position_owner"
  | "partial_position_owner"
  | "owner_unavailable_with_reason"
  | "position_index_unavailable_with_reason"
  | "unsupported_protocol_with_reason"
  | "not_applicable_erc20_lock_burn";

export type ConcentratedOwnerClassification = "eoa" | "contract" | "known_locker" | "protocol_router" | "unknown";

export interface ConcentratedLpPositionAudit {
  chainId: number | null;
  tokenAddress: string | null;
  poolAddress: string | null;
  protocol: ConcentratedLpProtocol;
  poolType: ConcentratedLpProtocol;
  positionManagerResolved: boolean;
  positionManagerAddress: string | null;
  eventIndexingAttempted: boolean;
  alchemyRpcAttempted: boolean;
  fromBlock: string | null;
  toBlock: string | null;
  logsReturned: number | null;
  positionsFound: number | null;
  activePositionsFound: number | null;
  totalActiveLiquidity: string | null;
  topOwner: string | null;
  topOwnerLiquiditySharePct: number | null;
  ownerIsContract: boolean | null;
  ownerClassification: ConcentratedOwnerClassification | null;
  finalStatus: ConcentratedLpPositionStatus;
  failureReason: string | null;
}

export interface ConcentratedLpIndexedOwner {
  address: string;
  liquidityRaw: string;
  positionCount: number;
}

export interface ConcentratedLpPositionResult {
  owners: ConcentratedLpIndexedOwner[];
  audit: ConcentratedLpPositionAudit;
}

export interface ConcentratedLpRpc {
  call: (method: string, params: unknown[]) => Promise<{ result?: unknown; errorMessage?: string | null } | null>;
}

const LP_ZERO = "0x0000000000000000000000000000000000000000";
const LP_DEAD = "0x000000000000000000000000000000000000dead";

// Official Uniswap v4 deployments (developers.uniswap.org/deployments), cross-checked against
// the same addresses already used in lib/server/uniswapV4BaseRpc.ts for Base PoolManager.
const V4_POOL_MANAGER: Record<number, string> = {
  1: "0x000000000004444c5dc75cb358380d2e3de08a90",
  8453: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  56: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
};
const V4_POSITION_MANAGER: Record<number, string> = {
  1: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
  8453: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
  56: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
};

// Uniswap V3 NonfungiblePositionManager — ETH/Base already in lpProof.ts; BNB from Uniswap's
// official BNB v3 deployments page (developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments).
const V3_NPM: Record<number, string> = {
  1: "0xc36442b4a4522e871399cd717abdd847ab11fe88",
  8453: "0x03a520b32c04bf3beef7beb72e919cf822ed34f1",
  56: "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613",
};

// PancakeSwap V3 NPM on BNB — already independently verified in lpProof.ts.
const PANCAKE_V3_NPM: Record<number, string> = {
  56: "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364",
};

// Aerodrome Slipstream NPM on Base — from Aerodrome's own slipstream README deployments table.
const SLIPSTREAM_NPM: Record<number, string> = {
  8453: "0x827922686190790b37229fd06084350e74485b72",
};

const PROTOCOL_ADDRESSES = new Set([
  ...Object.values(V4_POOL_MANAGER),
  ...Object.values(V4_POSITION_MANAGER),
  ...Object.values(V3_NPM),
  ...Object.values(PANCAKE_V3_NPM),
  ...Object.values(SLIPSTREAM_NPM),
]);

// Uniswap V3 / Slipstream / Pancake V3: IncreaseLiquidity(uint256 indexed tokenId, uint128, uint256, uint256)
const INCREASE_LIQUIDITY_TOPIC0 = "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
// Uniswap V4 PoolManager: ModifyLiquidity(bytes32 indexed id, address indexed sender, int24, int24, int256, bytes32)
const MODIFY_LIQUIDITY_TOPIC0 = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

const OWNER_OF_SELECTOR = "0x6352211e";
const POSITIONS_SELECTOR = "0x99fbab88";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const FEE_SELECTOR = "0xddca3f43";

const LOG_QUERY_TIMEOUT_MS = 8_000;
const LOG_SAMPLE_CAP = 200;
const POSITION_CALL_CAP = 40;
const DEFAULT_WINDOW: Record<number, number> = { 1: 3_000, 8453: 20_000, 56: 15_000 };

const OWNER_UNAVAILABLE_REASON = "Owner unavailable: active positions not found in indexed window";

export function chainIdToLpSlug(chainId: number): "eth" | "base" | "bnb" | null {
  if (chainId === 1) return "eth";
  if (chainId === 8453) return "base";
  if (chainId === 56) return "bnb";
  return null;
}

export function normalizeConcentratedProtocol(protocol: string | null | undefined, poolType?: string | null): ConcentratedLpProtocol {
  const raw = `${protocol ?? ""} ${poolType ?? ""}`.toLowerCase();
  if (/slipstream/.test(raw)) return "slipstream";
  if (/pancake/.test(raw) && /v3/.test(raw)) return "pancakeswap_v3";
  if (/uniswap/.test(raw) && /v4/.test(raw)) return "uniswap_v4";
  if (/uniswap/.test(raw) && /v3/.test(raw)) return "uniswap_v3";
  if (protocol === "uniswap_v4" || poolType === "uniswap_v4") return "uniswap_v4";
  if (protocol === "uniswap_v3" || poolType === "uniswap_v3") return "uniswap_v3";
  if (protocol === "pancakeswap_v3" || poolType === "pancakeswap_v3") return "pancakeswap_v3";
  if (protocol === "slipstream" || poolType === "slipstream") return "slipstream";
  return "unknown";
}

export function resolvePositionManager(chainId: number, protocol: ConcentratedLpProtocol): string | null {
  if (protocol === "uniswap_v3") return V3_NPM[chainId] ?? null;
  if (protocol === "pancakeswap_v3") return PANCAKE_V3_NPM[chainId] ?? null;
  if (protocol === "slipstream") return SLIPSTREAM_NPM[chainId] ?? null;
  if (protocol === "uniswap_v4") return V4_POSITION_MANAGER[chainId] ?? null;
  return null;
}

export function resolveV4PoolManager(chainId: number): string | null {
  return V4_POOL_MANAGER[chainId] ?? null;
}

function getRpcUrl(chainId: number): string | null {
  if (chainId === 1) {
    const explicit = process.env.ETH_RPC_URL;
    if (explicit && /^https?:\/\//.test(explicit)) return explicit;
    const key = process.env.ALCHEMY_ETHEREUM_KEY;
    return key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : null;
  }
  if (chainId === 8453) {
    const explicitBase = process.env.BASE_RPC_URL;
    if (explicitBase && /^https?:\/\//.test(explicitBase)) return explicitBase;
    const explicit = process.env.ALCHEMY_BASE_RPC_URL;
    if (explicit && /^https?:\/\//.test(explicit)) return explicit;
    const key = process.env.ALCHEMY_BASE_KEY;
    return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : null;
  }
  if (chainId === 56) {
    const key = process.env.ALCHEMY_BNB_KEY;
    return key ? `https://bnb-mainnet.g.alchemy.com/v2/${key}` : null;
  }
  return null;
}

function slugForChainId(chainId: number): string {
  return chainId === 1 ? "eth" : chainId === 8453 ? "base" : chainId === 56 ? "bnb" : "unknown";
}

function emptyAudit(partial: Partial<ConcentratedLpPositionAudit> & Pick<ConcentratedLpPositionAudit, "finalStatus">): ConcentratedLpPositionAudit {
  return {
    chainId: null,
    tokenAddress: null,
    poolAddress: null,
    protocol: "unknown",
    poolType: "unknown",
    positionManagerResolved: false,
    positionManagerAddress: null,
    eventIndexingAttempted: false,
    alchemyRpcAttempted: false,
    fromBlock: null,
    toBlock: null,
    logsReturned: null,
    positionsFound: null,
    activePositionsFound: null,
    totalActiveLiquidity: null,
    topOwner: null,
    topOwnerLiquiditySharePct: null,
    ownerIsContract: null,
    ownerClassification: null,
    failureReason: null,
    ...partial,
  };
}

function isAddress(value: string | null | undefined): value is string {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value));
}

function isPoolId(value: string | null | undefined): value is string {
  return Boolean(value && /^0x[a-fA-F0-9]{64}$/.test(value));
}

function padTopicAddress(addr: string): string {
  return `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
}

function addrFromWord(hex: string): string | null {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 40) return null;
  const addr = `0x${h.slice(-40).toLowerCase()}`;
  return /^0x[a-f0-9]{40}$/.test(addr) ? addr : null;
}

function hexToBigInt(hex: string | null | undefined): bigint | null {
  if (!hex || hex === "0x" || hex === "0x0") return null;
  try { return BigInt(hex); } catch { return null; }
}

function decodeSigned256(word: string): bigint | null {
  if (word.length !== 64) return null;
  let value = BigInt(`0x${word}`);
  const SIGN_BIT = BigInt(1) << BigInt(255);
  const MODULUS = BigInt(1) << BigInt(256);
  if (value >= SIGN_BIT) value -= MODULUS;
  return value;
}

function tokenIdFromTopic(topic: string | undefined): string | null {
  if (!topic) return null;
  const h = topic.startsWith("0x") ? topic.slice(2) : topic;
  if (h.length !== 64) return null;
  try { return BigInt(`0x${h}`).toString(); } catch { return null; }
}

async function defaultRpc(chainId: number, method: string, params: unknown[]): Promise<{ result?: unknown; errorMessage?: string | null } | null> {
  const rpcUrl = getRpcUrl(chainId);
  if (!rpcUrl) return { errorMessage: `no Alchemy/RPC URL configured for chain ${chainId}` };
  try {
    const slug = slugForChainId(chainId);
    logRpcCall({ route: "concentratedLpPositions", chain: slug, method });
    if (rpcUrl.includes("g.alchemy.com")) {
      auditGlobalAlchemyCall(method, { chain: slug, route: "concentratedLpPositions" });
    }
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(LOG_QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return { errorMessage: `RPC HTTP ${res.status}` };
    const json = await res.json() as { result?: unknown; error?: { message?: string } };
    if (json.error) return { errorMessage: json.error.message ?? "RPC error" };
    return { result: json.result };
  } catch (err) {
    return { errorMessage: err instanceof Error ? err.message : "RPC request failed" };
  }
}

async function classifyOwner(rpc: ConcentratedLpRpc, chainId: number, address: string): Promise<ConcentratedOwnerClassification> {
  const addr = address.toLowerCase();
  if (addr === LP_ZERO || addr === LP_DEAD) return "known_locker";
  if (PROTOCOL_ADDRESSES.has(addr)) return "protocol_router";
  const slug = slugForChainId(chainId);
  const lockers = (LP_LOCK_BURN_REGISTRY.lockersByChain as Record<string, readonly string[]>)[slug] ?? [];
  if (lockers.some((l) => l.toLowerCase() === addr)) return "known_locker";
  const code = await rpc.call("eth_getCode", [addr, "latest"]);
  const hex = typeof code?.result === "string" ? code.result : null;
  if (hex && hex !== "0x" && hex.length > 2) return "contract";
  if (hex === "0x") return "eoa";
  return "unknown";
}

function sharePct(ownerLiq: bigint, total: bigint): number | null {
  if (total <= BigInt(0)) return null;
  return Math.round(Number((ownerLiq * BigInt(10000)) / total) / 100 * 100) / 100;
}

function verifiedFields(owners: ConcentratedLpIndexedOwner[], classification: ConcentratedOwnerClassification | null): Pick<ConcentratedLpPositionAudit, "topOwner" | "topOwnerLiquiditySharePct" | "ownerIsContract" | "ownerClassification" | "totalActiveLiquidity" | "positionsFound" | "activePositionsFound"> {
  const parsed = owners
    .map((o) => ({ ...o, liq: BigInt(o.liquidityRaw || "0") }))
    .filter((o) => o.liq > BigInt(0))
    .sort((a, b) => (b.liq > a.liq ? 1 : b.liq < a.liq ? -1 : 0));
  const total = parsed.reduce((sum, o) => sum + o.liq, BigInt(0));
  const top = parsed[0] ?? null;
  const cls = classification;
  return {
    positionsFound: owners.reduce((n, o) => n + (o.positionCount || 1), 0),
    activePositionsFound: owners.reduce((n, o) => n + (o.positionCount || 1), 0),
    totalActiveLiquidity: total > BigInt(0) ? total.toString() : null,
    topOwner: top ? top.address : null,
    topOwnerLiquiditySharePct: top ? sharePct(top.liq, total) : null,
    ownerClassification: cls,
    ownerIsContract: cls == null || cls === "unknown" ? null : cls !== "eoa",
  };
}

async function getLogsWindowed(
  rpc: ConcentratedLpRpc,
  chainId: number,
  filter: { address: string; topics: (string | null)[] },
  fromBlockHint: number | null,
): Promise<{ logs: Array<{ topics: string[]; data: string }>; fromBlock: string; toBlock: string } | { error: string; fromBlock: string | null; toBlock: string | null; alchemyRpcAttempted: boolean }> {
  const latestRes = await rpc.call("eth_blockNumber", []);
  const latest = hexToBigInt(typeof latestRes?.result === "string" ? latestRes.result : null);
  if (latest == null) {
    return { error: latestRes?.errorMessage ?? "eth_blockNumber unavailable", fromBlock: null, toBlock: null, alchemyRpcAttempted: true };
  }
  const toBlockNum = latest;
  const defaultWindow = DEFAULT_WINDOW[chainId] ?? 5_000;
  let windowSize = fromBlockHint != null && fromBlockHint >= 0 && fromBlockHint < Number(toBlockNum)
    ? Number(toBlockNum) - fromBlockHint
    : defaultWindow;
  let lastError = "eth_getLogs failed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fromNum = toBlockNum - BigInt(Math.max(256, windowSize));
    const fromBlock = `0x${(fromNum < BigInt(0) ? BigInt(0) : fromNum).toString(16)}`;
    const toBlock = `0x${toBlockNum.toString(16)}`;
    const res = await rpc.call("eth_getLogs", [{
      address: filter.address,
      topics: filter.topics,
      fromBlock,
      toBlock,
    }]);
    if (res?.errorMessage) {
      lastError = res.errorMessage;
      const tooWide = /range|too many|limited|response size|timeout/i.test(res.errorMessage);
      if (tooWide) { windowSize = Math.floor(windowSize / 3); continue; }
      return { error: `eth_getLogs failed: ${res.errorMessage}`, fromBlock, toBlock, alchemyRpcAttempted: true };
    }
    if (!Array.isArray(res?.result)) {
      return { error: "eth_getLogs returned no log array", fromBlock, toBlock, alchemyRpcAttempted: true };
    }
    return { logs: (res.result as Array<{ topics: string[]; data: string }>).slice(0, LOG_SAMPLE_CAP), fromBlock, toBlock };
  }
  return { error: `Position index unavailable: ${lastError}`, fromBlock: null, toBlock: `0x${toBlockNum.toString(16)}`, alchemyRpcAttempted: true };
}

async function indexV4(
  rpc: ConcentratedLpRpc,
  chainId: number,
  poolId: string,
  fromBlockHint: number | null,
): Promise<{ owners: ConcentratedLpIndexedOwner[]; logsReturned: number; fromBlock: string | null; toBlock: string | null; error?: string }> {
  const poolManager = resolveV4PoolManager(chainId);
  if (!poolManager) return { owners: [], logsReturned: 0, fromBlock: null, toBlock: null, error: "Uniswap V4 PoolManager address is not confirmed for this chain" };
  const fetched = await getLogsWindowed(rpc, chainId, {
    address: poolManager,
    topics: [MODIFY_LIQUIDITY_TOPIC0, poolId.toLowerCase()],
  }, fromBlockHint);
  if ("error" in fetched) return { owners: [], logsReturned: 0, fromBlock: fetched.fromBlock, toBlock: fetched.toBlock, error: fetched.error };
  const net = new Map<string, { amount: bigint; count: number }>();
  for (const log of fetched.logs) {
    const sender = log.topics[2] ? addrFromWord(log.topics[2]) : null;
    if (!sender) continue;
    const hex = (log.data ?? "").startsWith("0x") ? log.data.slice(2) : (log.data ?? "");
    if (hex.length < 4 * 64) continue;
    const delta = decodeSigned256(hex.slice(2 * 64, 3 * 64));
    if (delta == null) continue;
    const existing = net.get(sender) ?? { amount: BigInt(0), count: 0 };
    existing.amount += delta;
    existing.count += 1;
    net.set(sender, existing);
  }
  const owners = Array.from(net.entries())
    .filter(([, v]) => v.amount > BigInt(0))
    .map(([address, v]) => ({ address, liquidityRaw: v.amount.toString(), positionCount: v.count }))
    .sort((a, b) => (BigInt(b.liquidityRaw) > BigInt(a.liquidityRaw) ? 1 : -1));
  return { owners, logsReturned: fetched.logs.length, fromBlock: fetched.fromBlock, toBlock: fetched.toBlock };
}

async function indexV3Style(
  rpc: ConcentratedLpRpc,
  chainId: number,
  poolAddress: string,
  npm: string,
  fromBlockHint: number | null,
): Promise<{ owners: ConcentratedLpIndexedOwner[]; logsReturned: number; fromBlock: string | null; toBlock: string | null; error?: string }> {
  const [token0Res, token1Res, feeRes] = await Promise.all([
    rpc.call("eth_call", [{ to: poolAddress, data: TOKEN0_SELECTOR }, "latest"]),
    rpc.call("eth_call", [{ to: poolAddress, data: TOKEN1_SELECTOR }, "latest"]),
    rpc.call("eth_call", [{ to: poolAddress, data: FEE_SELECTOR }, "latest"]),
  ]);
  const token0 = addrFromWord(typeof token0Res?.result === "string" ? token0Res.result : "");
  const token1 = addrFromWord(typeof token1Res?.result === "string" ? token1Res.result : "");
  const fee = hexToBigInt(typeof feeRes?.result === "string" ? feeRes.result : null);
  if (!token0 || !token1) {
    return { owners: [], logsReturned: 0, fromBlock: null, toBlock: null, error: "pool token0/token1 RPC probes unresolved" };
  }

  const fetched = await getLogsWindowed(rpc, chainId, {
    address: npm,
    topics: [INCREASE_LIQUIDITY_TOPIC0],
  }, fromBlockHint);
  if ("error" in fetched) return { owners: [], logsReturned: 0, fromBlock: fetched.fromBlock, toBlock: fetched.toBlock, error: fetched.error };

  const tokenIds: string[] = [];
  const seen = new Set<string>();
  for (const log of fetched.logs) {
    const id = tokenIdFromTopic(log.topics[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tokenIds.push(id);
    if (tokenIds.length >= POSITION_CALL_CAP) break;
  }

  const byOwner = new Map<string, { amount: bigint; count: number }>();
  for (const tokenId of tokenIds) {
    const idWord = BigInt(tokenId).toString(16).padStart(64, "0");
    const posRes = await rpc.call("eth_call", [{ to: npm, data: `${POSITIONS_SELECTOR}${idWord}` }, "latest"]);
    const posHex = typeof posRes?.result === "string" ? posRes.result : null;
    if (!posHex || posHex === "0x") continue;
    const body = posHex.startsWith("0x") ? posHex.slice(2) : posHex;
    if (body.length < 64 * 8) continue;
    const posToken0 = addrFromWord(body.slice(2 * 64, 3 * 64));
    const posToken1 = addrFromWord(body.slice(3 * 64, 4 * 64));
    const posFee = hexToBigInt(`0x${body.slice(4 * 64, 5 * 64)}`);
    const liquidity = hexToBigInt(`0x${body.slice(7 * 64, 8 * 64)}`);
    const matches = (posToken0 === token0 && posToken1 === token1) || (posToken0 === token1 && posToken1 === token0);
    const feeMatches = fee == null || posFee == null || fee === posFee;
    if (!matches || !feeMatches || liquidity == null || liquidity <= BigInt(0)) continue;
    const ownerRes = await rpc.call("eth_call", [{ to: npm, data: `${OWNER_OF_SELECTOR}${idWord}` }, "latest"]);
    const owner = addrFromWord(typeof ownerRes?.result === "string" ? ownerRes.result : "");
    if (!owner) continue;
    const existing = byOwner.get(owner) ?? { amount: BigInt(0), count: 0 };
    existing.amount += liquidity;
    existing.count += 1;
    byOwner.set(owner, existing);
  }

  const owners = Array.from(byOwner.entries())
    .map(([address, v]) => ({ address, liquidityRaw: v.amount.toString(), positionCount: v.count }))
    .sort((a, b) => (BigInt(b.liquidityRaw) > BigInt(a.liquidityRaw) ? 1 : -1));
  return { owners, logsReturned: fetched.logs.length, fromBlock: fetched.fromBlock, toBlock: fetched.toBlock };
}

export async function resolveConcentratedLpPositions(input: {
  chainId: number;
  tokenAddress: string | null;
  poolAddress: string | null;
  protocol: string | null;
  poolType: string | null;
  fromBlockHint?: number | null;
}, rpcClient?: ConcentratedLpRpc): Promise<ConcentratedLpPositionResult> {
  const protocol = normalizeConcentratedProtocol(input.protocol, input.poolType);
  const poolRef = input.poolAddress;
  const baseMeta = {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    poolAddress: poolRef,
    protocol,
    poolType: protocol,
  };

  if (input.chainId !== 1 && input.chainId !== 8453 && input.chainId !== 56) {
    return {
      owners: [],
      audit: emptyAudit({
        ...baseMeta,
        finalStatus: "unsupported_protocol_with_reason",
        failureReason: "Concentrated position log indexing is implemented for Base, Ethereum, and BNB only.",
      }),
    };
  }

  if (protocol === "unknown") {
    return {
      owners: [],
      audit: emptyAudit({
        ...baseMeta,
        finalStatus: "unsupported_protocol_with_reason",
        failureReason: "Pool protocol is not a supported concentrated model (Uniswap V3/V4, Aerodrome Slipstream, Pancake V3).",
      }),
    };
  }

  const positionManager = resolvePositionManager(input.chainId, protocol);
  const rpc: ConcentratedLpRpc = rpcClient ?? { call: (method, params) => defaultRpc(input.chainId, method, params) };
  const alchemyRpcAttempted = true;

  if (!positionManager) {
    return {
      owners: [],
      audit: emptyAudit({
        ...baseMeta,
        eventIndexingAttempted: false,
        alchemyRpcAttempted: false,
        positionManagerResolved: false,
        finalStatus: "unsupported_protocol_with_reason",
        failureReason: `No verified position manager is recorded for ${protocol} on chain ${input.chainId}.`,
      }),
    };
  }

  if (!poolRef) {
    return {
      owners: [],
      audit: emptyAudit({
        ...baseMeta,
        positionManagerResolved: true,
        positionManagerAddress: positionManager,
        eventIndexingAttempted: false,
        alchemyRpcAttempted: false,
        finalStatus: "position_index_unavailable_with_reason",
        failureReason: "Position index unavailable: no pool address or pool id was supplied.",
      }),
    };
  }

  const fromHint = typeof input.fromBlockHint === "number" && Number.isFinite(input.fromBlockHint) ? input.fromBlockHint : null;
  let indexed: { owners: ConcentratedLpIndexedOwner[]; logsReturned: number; fromBlock: string | null; toBlock: string | null; error?: string };

  if (protocol === "uniswap_v4") {
    const poolId = isPoolId(poolRef) ? poolRef : null;
    if (!poolId) {
      return {
        owners: [],
        audit: emptyAudit({
          ...baseMeta,
          positionManagerResolved: true,
          positionManagerAddress: positionManager,
          eventIndexingAttempted: false,
          alchemyRpcAttempted: false,
          finalStatus: "position_index_unavailable_with_reason",
          failureReason: "Position index unavailable: Uniswap V4 pools are identified by a 32-byte pool id, which was not provided.",
        }),
      };
    }
    indexed = await indexV4(rpc, input.chainId, poolId, fromHint);
  } else {
    if (!isAddress(poolRef)) {
      return {
        owners: [],
        audit: emptyAudit({
          ...baseMeta,
          positionManagerResolved: true,
          positionManagerAddress: positionManager,
          eventIndexingAttempted: false,
          alchemyRpcAttempted: false,
          finalStatus: "position_index_unavailable_with_reason",
          failureReason: "Position index unavailable: concentrated V3-style pools require a pool contract address.",
        }),
      };
    }
    indexed = await indexV3Style(rpc, input.chainId, poolRef.toLowerCase(), positionManager, fromHint);
  }

  if (indexed.error) {
    const reason = indexed.error.startsWith("Position index unavailable:")
      ? indexed.error
      : `Position index unavailable: ${indexed.error}`;
    return {
      owners: [],
      audit: emptyAudit({
        ...baseMeta,
        positionManagerResolved: true,
        positionManagerAddress: positionManager,
        eventIndexingAttempted: true,
        alchemyRpcAttempted,
        fromBlock: indexed.fromBlock,
        toBlock: indexed.toBlock,
        logsReturned: indexed.logsReturned,
        finalStatus: "position_index_unavailable_with_reason",
        failureReason: reason,
      }),
    };
  }

  if (indexed.owners.length === 0) {
    return {
      owners: [],
      audit: emptyAudit({
        ...baseMeta,
        positionManagerResolved: true,
        positionManagerAddress: positionManager,
        eventIndexingAttempted: true,
        alchemyRpcAttempted,
        fromBlock: indexed.fromBlock,
        toBlock: indexed.toBlock,
        logsReturned: indexed.logsReturned,
        positionsFound: 0,
        activePositionsFound: 0,
        finalStatus: "owner_unavailable_with_reason",
        failureReason: OWNER_UNAVAILABLE_REASON,
      }),
    };
  }

  const top = indexed.owners[0];
  const classification = await classifyOwner(rpc, input.chainId, top.address);
  const fields = verifiedFields(indexed.owners, classification);
  const status: ConcentratedLpPositionStatus = classification === "unknown"
    ? "partial_position_owner"
    : "verified_position_owner";
  return {
    owners: indexed.owners,
    audit: emptyAudit({
      ...baseMeta,
      positionManagerResolved: true,
      positionManagerAddress: positionManager,
      eventIndexingAttempted: true,
      alchemyRpcAttempted,
      fromBlock: indexed.fromBlock,
      toBlock: indexed.toBlock,
      logsReturned: indexed.logsReturned,
      ...fields,
      topOwner: status === "verified_position_owner" ? fields.topOwner : null,
      topOwnerLiquiditySharePct: status === "verified_position_owner" ? fields.topOwnerLiquiditySharePct : null,
      finalStatus: status,
      failureReason: null,
    }),
  };
}

export const CONCENTRATED_ERC20_LOCK_BURN_LABEL = "Not applicable — concentrated LP has no ERC20 LP token.";
export const CONCENTRATED_OWNER_UNAVAILABLE_REASON = OWNER_UNAVAILABLE_REASON;
