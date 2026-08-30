// UNISWAP-V4-ROBINHOOD-RPC-FALLBACK, DISCLOSED: resolves real V4 concentrated-liquidity position
// ownership for Robinhood Chain directly via RPC event logs, instead of the subgraph integration
// in lib/server/uniswapV4Subgraph.ts.
//
// Why this exists: that subgraph module's env var (GRAPH_UNISWAP_V4_SUBGRAPH_ID_ROBINHOOD) was
// confirmed (by the user, live) to actually point at a generic/mainnet Uniswap V4 subgraph, not
// one indexing Robinhood Chain — every query for a real Robinhood pool ID structurally can never
// match, silently returning an empty-but-successful result forever. Rather than wait on a subgraph
// that may never get indexed for a chain this new, this reads the same ModifyLiquidity event
// history directly from the chain itself via the already-configured, already-working Robinhood
// RPC (ALCHEMY_ROBINHOOD_RPC_URL) — no new provider, no new credential.
//
// PoolManager address verification, disclosed: NOT guessed. Located and verified live on
// Robinhood Chain's own Blockscout explorer (robinhoodchain.blockscout.com) by the user during
// this session: contract name "PoolManager", source code verified (partial match, compiler
// v0.8.26, EVM cancun), contract file path `src/pkgs/v4-core/src/PoolManager.sol`, and the pasted
// source's full import list (Hooks, Pool, PoolKey, TickMath, IPoolManager, IUnlockCallback,
// ProtocolFees, ERC6909Claims, PoolId, BalanceDelta, ...) and its own `modifyLiquidity()` function
// body — including the exact `emit ModifyLiquidity(id, msg.sender, params.tickLower,
// params.tickUpper, params.liquidityDelta, params.salt);` statement the event topic below is
// derived from — match Uniswap's real, public v4-core repository exactly, not a same-named clone.
// 14,921 real transactions and a $12M+ live balance at verification time confirm this is the
// actively-used deployment, not a dormant/test one.
// EXPORTED, DISCLOSED (Robinhood Wallet Scanner Phase 3 follow-up): re-used by
// lib/server/robinhoodSwapDecoder.ts as the one verified V4 singleton contract every real
// Robinhood swap log must originate from — the same address, the same verification, no second
// source of truth introduced.
export const ROBINHOOD_V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'

// Event-topic derivation, disclosed: computed (via viem's toEventSelector, not hand-rolled crypto)
// from the exact canonical signature `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)`
// — PoolId ABI-encodes as bytes32; the `indexed` keyword doesn't change the topic0 hash itself, only
// which params end up in `topics` vs `data`. Cross-checked against this same verified contract's own
// pasted source, not taken from memory alone.
const MODIFY_LIQUIDITY_TOPIC0 = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'

const ROBINHOOD_V4_LOG_QUERY_TIMEOUT_MS = 8_000
// Bounded sample size — same "real read, capped, never a full-pool coverage claim" language
// already used throughout this codebase's concentrated-liquidity proof code.
const ROBINHOOD_V4_LOG_SAMPLE_CAP = 500

import type { ConcentratedOwnerResolver, ConcentratedOwnerRecord } from './lpProof'
import { getRobinhoodRpcUrl } from './robinhoodChainConfig'
import { logRpcCall } from './rpcDebug'
import { auditGlobalAlchemyCall } from './globalRpcAudit'

interface RawLog {
  topics: string[]
  data: string
}

function poolIdTopic(poolId: string): string {
  // poolId is already validated upstream as /^0x[a-f0-9]{64}$/ (see extractPoolAddressOrId in
  // app/api/token/route.ts) — a full 32-byte value, directly usable as an indexed topic filter.
  return poolId.toLowerCase()
}

// Non-indexed params (tickLower, tickUpper, liquidityDelta, salt) are ABI-encoded as four
// consecutive 32-byte words in `data`, in declaration order — only liquidityDelta (the 3rd word)
// is needed here. Decoded as a proper two's-complement signed 256-bit integer, not naive hex
// parsing, since a real liquidity removal is a real negative delta.
function decodeLiquidityDelta(data: string): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  if (hex.length < 4 * 64) return null
  const word = hex.slice(2 * 64, 3 * 64)
  let value = BigInt(`0x${word}`)
  const SIGN_BIT = BigInt(1) << BigInt(255)
  const MODULUS = BigInt(1) << BigInt(256)
  if (value >= SIGN_BIT) value -= MODULUS
  return value
}

function senderFromTopic(topic: string): string | null {
  const hex = topic.startsWith('0x') ? topic.slice(2) : topic
  if (hex.length !== 64) return null
  const addr = hex.slice(-40)
  return /^[a-f0-9]{40}$/i.test(addr) ? `0x${addr}`.toLowerCase() : null
}

async function fetchModifyLiquidityLogs(poolId: string): Promise<RawLog[] | null> {
  const rpcUrl = getRobinhoodRpcUrl()
  if (!rpcUrl) return null
  try {
    logRpcCall({ route: 'uniswapV4RobinhoodRpc', chain: 'robinhood', method: 'eth_getLogs' })
    if (rpcUrl.includes('g.alchemy.com')) {
      auditGlobalAlchemyCall('eth_getLogs', { chain: 'robinhood', route: 'uniswapV4RobinhoodRpc' })
    }
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{
          address: ROBINHOOD_V4_POOL_MANAGER,
          topics: [MODIFY_LIQUIDITY_TOPIC0, poolIdTopic(poolId)],
          fromBlock: '0x0',
          toBlock: 'latest',
        }],
      }),
      signal: AbortSignal.timeout(ROBINHOOD_V4_LOG_QUERY_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json() as { result?: RawLog[]; error?: unknown }
    // A too-wide block range/log count commonly comes back as a JSON-RPC error rather than a
    // truncated result — treat any error the same as "no real source available" (null), never a
    // fabricated empty-but-confident [] result. A genuine zero-owner pool still returns [].
    if (json.error || !Array.isArray(json.result)) return null
    return json.result
  } catch {
    return null
  }
}

// Same aggregation shape/logic as lib/server/uniswapV4Subgraph.ts's aggregateOwnersFromEvents —
// only positive net holders are real current position-owner candidates; a sender whose sampled
// window shows net-negative liquidity (removed more than added within this bounded sample) isn't
// shown as a nonsensical negative "liquidity" figure.
function aggregateOwnersFromLogs(logs: RawLog[]): ConcentratedOwnerRecord[] {
  const netBySender = new Map<string, { amount: bigint; count: number }>()
  for (const log of logs.slice(0, ROBINHOOD_V4_LOG_SAMPLE_CAP)) {
    const sender = log.topics[2] ? senderFromTopic(log.topics[2]) : null
    if (!sender) continue
    const delta = decodeLiquidityDelta(log.data)
    if (delta == null) continue
    const existing = netBySender.get(sender) ?? { amount: BigInt(0), count: 0 }
    existing.amount += delta
    existing.count += 1
    netBySender.set(sender, existing)
  }
  return Array.from(netBySender.entries())
    .filter(([, v]) => v.amount > BigInt(0))
    .map(([address, v]) => ({ address, liquidityRaw: v.amount.toString(), positionCount: v.count }))
    .sort((a, b) => {
      const av = BigInt(a.liquidityRaw)
      const bv = BigInt(b.liquidityRaw)
      return av === bv ? 0 : av > bv ? -1 : 1
    })
}

// The ConcentratedOwnerResolver plugged into attemptConcentratedPositionProof for Robinhood
// Chain. Only applies when chain === 'robinhood' && poolModel === 'uniswap_v4' && a real poolId is
// present — returns null (meaning "no real source available", never a fabricated empty-but-
// confident result) for every other chain/model, exactly mirroring resolveUniswapV4PositionOwners
// so the two can be composed safely (see app/api/token/route.ts's resolveConcentratedPositionOwners).
export const resolveUniswapV4RobinhoodRpc: ConcentratedOwnerResolver = async (input) => {
  if (input.chain !== 'robinhood' || input.poolModel !== 'uniswap_v4' || !input.poolId) return null
  const logs = await fetchModifyLiquidityLogs(input.poolId)
  if (logs == null) return null
  if (logs.length === 0) return []
  return aggregateOwnersFromLogs(logs)
}
