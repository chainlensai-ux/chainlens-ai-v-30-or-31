// AERODROME-SLIPSTREAM-POOL-RPC, DISCLOSED (Concentrated LP ownership proof — Slipstream gap):
// resolves real Aerodrome Slipstream concentrated-liquidity position ownership on Base directly
// via RPC event logs read from the POOL CONTRACT ITSELF — never from a guessed/hardcoded
// "position manager" address. Slipstream (like Uniswap V3, which it forks) does not require
// trusting any periphery contract address at all for this: every V3-style pool emits its own
// `Mint`/`Burn` events (with `owner` as an indexed topic) directly on the pool contract, and the
// pool's own address is already the one this codebase's real, provider-sourced pool selection
// resolved and validated — no new address to verify, no factory/registry lookup needed.
//
// Event-signature verification, disclosed: NOT guessed from training data or memory. topic0 for
// both events was computed in this session via keccak256 of the exact, publicly-documented
// Uniswap V3 IUniswapV3PoolEvents interface signatures (Solidity event ABI is a deterministic
// hash of the declared signature, not an address that could be wrong/unverified):
//   Mint(address,address,int24,int24,uint128,uint256,uint256) -> topic0 below
//   Burn(address,int24,int24,uint128,uint256,uint256)         -> topic0 below
// Aerodrome Slipstream's CLPool contract is an open-source fork of Uniswap V3's pool contract
// (per Aerodrome's own public documentation) and keeps this exact same event ABI — same owner
// (indexed) position confirmed by Aerodrome's own verified Slipstream pool source on BaseScan.
const MINT_TOPIC0 = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
const BURN_TOPIC0 = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'

const SLIPSTREAM_LOG_QUERY_TIMEOUT_MS = 8_000
// Bounded sample size — same "real read, capped, never a full-pool coverage claim" language used
// throughout this codebase's concentrated-liquidity proof code (see uniswapV4BaseRpc.ts).
const SLIPSTREAM_LOG_SAMPLE_CAP = 500

import type { ConcentratedOwnerResolver, ConcentratedOwnerRecord } from './lpProof'
import { RPC } from '../rpc'
import { logRpcCall } from './rpcDebug'
import { auditGlobalAlchemyCall } from './globalRpcAudit'

interface RawLog {
  topics: string[]
  data: string
}

function ownerFromTopic(topic: string): string | null {
  const hex = topic.startsWith('0x') ? topic.slice(2) : topic
  if (hex.length !== 64) return null
  const addr = hex.slice(-40)
  return /^[a-f0-9]{40}$/i.test(addr) ? `0x${addr}`.toLowerCase() : null
}

// Mint's non-indexed data = sender(32B) + amount(32B, uint128) + amount0(32B) + amount1(32B) ->
// amount is the 2nd word. Burn's non-indexed data = amount(32B) + amount0(32B) + amount1(32B) ->
// amount is the 1st word. Both are unsigned uint128 — never negative on their own; Burn amounts
// are treated as a liquidity-removed (negative) delta by the caller, matching the same signed-net
// aggregation pattern already used for V4 in uniswapV4BaseRpc.ts.
function decodeAmount(data: string, wordIndex: number): bigint | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const start = wordIndex * 64
  if (hex.length < start + 64) return null
  const word = hex.slice(start, start + 64)
  try { return BigInt(`0x${word}`) } catch { return null }
}

async function fetchPoolLogs(poolAddress: string, topic0: string): Promise<RawLog[] | null> {
  const rpcUrl = RPC.base
  if (!rpcUrl) return null
  try {
    logRpcCall({ route: 'aerodromeSlipstreamPoolRpc', chain: 'base', method: 'eth_getLogs' })
    if (rpcUrl.includes('g.alchemy.com')) {
      auditGlobalAlchemyCall('eth_getLogs', { chain: 'base', route: 'aerodromeSlipstreamPoolRpc' })
    }
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{ address: poolAddress, topics: [topic0], fromBlock: '0x0', toBlock: 'latest' }],
      }),
      signal: AbortSignal.timeout(SLIPSTREAM_LOG_QUERY_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const json = await res.json() as { result?: RawLog[]; error?: unknown }
    // A too-wide block range/log count commonly comes back as a JSON-RPC error rather than a
    // truncated result — treat any error the same as "no real source available" (null), never a
    // fabricated empty-but-confident [] result. A genuine zero-position pool still returns [].
    if (json.error || !Array.isArray(json.result)) return null
    return json.result
  } catch {
    return null
  }
}

function aggregateOwnersFromLogs(mintLogs: RawLog[], burnLogs: RawLog[]): ConcentratedOwnerRecord[] {
  const netBySender = new Map<string, { amount: bigint; count: number }>()
  for (const log of mintLogs.slice(0, SLIPSTREAM_LOG_SAMPLE_CAP)) {
    const owner = log.topics[1] ? ownerFromTopic(log.topics[1]) : null
    const amount = decodeAmount(log.data, 1)
    if (!owner || amount == null) continue
    const existing = netBySender.get(owner) ?? { amount: BigInt(0), count: 0 }
    existing.amount += amount
    existing.count += 1
    netBySender.set(owner, existing)
  }
  for (const log of burnLogs.slice(0, SLIPSTREAM_LOG_SAMPLE_CAP)) {
    const owner = log.topics[1] ? ownerFromTopic(log.topics[1]) : null
    const amount = decodeAmount(log.data, 0)
    if (!owner || amount == null) continue
    const existing = netBySender.get(owner) ?? { amount: BigInt(0), count: 0 }
    existing.amount -= amount
    existing.count += 1
    netBySender.set(owner, existing)
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

// The ConcentratedOwnerResolver plugged into attemptConcentratedPositionProof for Slipstream.
// Only applies when chain === 'base' && poolModel === 'slipstream' && a real pool CONTRACT
// address is present — returns null (meaning "no real source available", never a fabricated
// empty-but-confident result) for every other chain/model, matching the same contract every other
// resolver in this file follows.
export const resolveAerodromeSlipstreamPoolRpc: ConcentratedOwnerResolver = async (input) => {
  if (input.chain !== 'base' || input.poolModel !== 'slipstream' || !input.poolAddress) return null
  const [mintLogs, burnLogs] = await Promise.all([
    fetchPoolLogs(input.poolAddress, MINT_TOPIC0),
    fetchPoolLogs(input.poolAddress, BURN_TOPIC0),
  ])
  if (mintLogs == null || burnLogs == null) return null
  if (mintLogs.length === 0 && burnLogs.length === 0) return []
  return aggregateOwnersFromLogs(mintLogs, burnLogs)
}
