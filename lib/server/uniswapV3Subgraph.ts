// UNISWAP-V3-SUBGRAPH-INTEGRATION, DISCLOSED: resolves real V3 (and PancakeSwap V3-schema)
// concentrated-liquidity position ownership via the official per-chain Uniswap V3 subgraph (The
// Graph network) — the same integration pattern already used for V4/Robinhood in
// lib/server/uniswapV4Subgraph.ts, extended to V3 on eth/base/bnb.
//
// Why this exists: every V3 pool on Base (and eth/bnb) previously fell straight through
// lib/server/lpProof.ts's `resolveOwners` hook (always null for V3, since only a V4/Robinhood
// resolver was wired in) to the RPC-only liquidity/slot0 probe, which can confirm a pool is active
// but can never attribute liquidity to a position owner — meaning "Position Ownership: Attempted —
// open check" on essentially every single Base V3 scan. This is a documented, intentional gap (see
// Clark/Notes/Known-Gaps-and-Stubs.md item 5: "no real production candidate-discovery source is
// wired in ... this is intentional (per explicit instruction: do not invent a candidate source),
// not a bug"). This module is that real source for V3.
//
// Unlike V4 (whose subgraph has no persistent per-position owner field, requiring event
// aggregation), the official Uniswap V3 subgraph schema maintains a `Position` entity with a live
// `owner` field and current `liquidity` directly — so this queries current top positions for a
// pool by liquidity, no event aggregation needed.
//
// Subgraph identity: per-chain subgraph IDs are NOT hardcoded here — this codebase's own rule
// (see lib/server/lpProof.ts's DEX-address disclosure comment) is to never guess a contract/
// subgraph identity it hasn't independently confirmed. Each chain's ID must be supplied via its
// own env var below; when unset for a chain, this resolver returns null for that chain exactly
// like an unconfigured V4/Robinhood setup does today — degrading to the existing RPC-only
// fallback, never fabricating a result. To configure: find the official Uniswap V3 subgraph
// deployment for the target chain in The Graph Explorer (thegraph.com/explorer, search
// "Uniswap V3 <chain>", verify it's Uniswap's own listing), copy its subgraph ID, and set the
// matching env var below alongside GRAPH_API_KEY (the same key already used for V4/Robinhood).
//
// PANCAKESWAP-V3-SPLIT, DISCLOSED (real-world testing found: "for BNB I need to do a PancakeSwap
// pool, not a Uniswap one"): on BNB Chain the dominant V3-style DEX is PancakeSwap V3, not
// Uniswap V3 — Uniswap's own BSC deployment exists but sees far less real liquidity, so a pool
// classified as `pancakeswap_v3` must query PancakeSwap's own subgraph, not Uniswap's BSC one.
// Selection is keyed by (chain, poolModel) pair, not chain alone, so eth/base (Uniswap-only in
// practice) and bnb (which needs both) are each handled correctly.

import type { ConcentratedOwnerLookupResult, ConcentratedOwnerResolver, ConcentratedOwnerRecord } from './lpProof'

const V3_SUBGRAPH_QUERY_TIMEOUT_MS = 8_000
// Bounded sample size — same "real read on a capped number of records, never full-pool coverage"
// reasoning as lpProof.ts's SAMPLE_CANDIDATE_CAP and the V4 resolver's event sample.
const V3_TOP_POSITIONS_SAMPLE = 50

const UNISWAP_V3_SUBGRAPH_ID_BY_CHAIN: Partial<Record<'eth' | 'base' | 'bnb', string | undefined>> = {
  eth: process.env.GRAPH_UNISWAP_V3_SUBGRAPH_ID_ETH,
  base: process.env.GRAPH_UNISWAP_V3_SUBGRAPH_ID_BASE,
  bnb: process.env.GRAPH_UNISWAP_V3_SUBGRAPH_ID_BNB,
}

// PancakeSwap V3 only exists on BNB Chain (and a few others ChainLens doesn't currently scan) —
// no eth/base entries needed. Same schema as Uniswap V3's Position entity (PancakeSwap V3 is a
// Uniswap V3 fork), so the same query/aggregation logic below works unchanged.
const PANCAKESWAP_V3_SUBGRAPH_ID_BY_CHAIN: Partial<Record<'bnb', string | undefined>> = {
  bnb: process.env.GRAPH_PANCAKESWAP_V3_SUBGRAPH_ID_BNB,
}

const SLIPSTREAM_SUBGRAPH_ID_BY_CHAIN: Partial<Record<'base', string | undefined>> = {
  base: process.env.GRAPH_AERODROME_SLIPSTREAM_SUBGRAPH_ID_BASE,
}

interface PositionRow {
  id: string
  owner: string | null
  liquidity: string
}

function graphSubgraphUrl(apiKey: string, subgraphId: string): string {
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`
}

async function queryTopPositions(subgraphId: string, poolAddress: string): Promise<{ rows: PositionRow[] | null; failureReason: string | null }> {
  const apiKey = process.env.GRAPH_API_KEY
  if (!apiKey) return { rows: null, failureReason: 'The Graph API key is not configured.' }

  const query = `query($pool: String!, $first: Int!) {
    positions(first: $first, orderBy: liquidity, orderDirection: desc, where: { pool: $pool, liquidity_gt: "0" }) {
      id
      owner
      liquidity
    }
  }`

  try {
    const res = await fetch(graphSubgraphUrl(apiKey, subgraphId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { pool: poolAddress.toLowerCase(), first: V3_TOP_POSITIONS_SAMPLE } }),
      cache: 'no-store',
      signal: AbortSignal.timeout(V3_SUBGRAPH_QUERY_TIMEOUT_MS),
    })
    if (!res.ok) return { rows: null, failureReason: `The Graph position lookup returned HTTP ${res.status}.` }
    const json = await res.json() as { data?: { positions?: PositionRow[] }; errors?: unknown[] }
    if (json.errors || !json.data) return { rows: null, failureReason: 'The Graph position response contained errors or no data.' }
    return { rows: json.data.positions ?? [], failureReason: null }
  } catch (error) {
    return { rows: null, failureReason: error instanceof Error && error.name === 'TimeoutError' ? 'The Graph position lookup timed out.' : 'The Graph position lookup failed.' }
  }
}

function toOwnerRecords(rows: PositionRow[]): ConcentratedOwnerRecord[] {
  // Aggregate by owner — a single owner can hold multiple position NFTs on the same pool, and
  // the caller's top-owner/share computation expects one record per distinct address.
  const byOwner = new Map<string, { amount: bigint; count: number }>()
  for (const row of rows) {
    if (!row.owner) continue
    const addr = row.owner.toLowerCase()
    let amt: bigint
    try { amt = BigInt(row.liquidity) } catch { continue }
    if (amt <= BigInt(0)) continue
    const existing = byOwner.get(addr) ?? { amount: BigInt(0), count: 0 }
    existing.amount += amt
    existing.count += 1
    byOwner.set(addr, existing)
  }
  return Array.from(byOwner.entries())
    .map(([address, v]) => ({ address, liquidityRaw: v.amount.toString(), positionCount: v.count }))
    .sort((a, b) => {
      const av = BigInt(a.liquidityRaw)
      const bv = BigInt(b.liquidityRaw)
      return av === bv ? 0 : av > bv ? -1 : 1
    })
}

// The ConcentratedOwnerResolver plugged into attemptConcentratedPositionProof for eth/base/bnb
// Uniswap V3 and PancakeSwap V3 pools — each pool model routed to its own real DEX's subgraph
// (never Uniswap's subgraph for a PancakeSwap pool or vice versa). Returns null (meaning "no real
// source available", never a fabricated empty-but-confident result) whenever the matching chain+
// pool-model combination has no subgraph ID configured, the pool model isn't V3-family, or no
// pool contract address is known — in every such case the existing RPC-based candidate-probe/
// liquidity-only path runs unchanged.
export const resolveUniswapV3PositionOwners: ConcentratedOwnerResolver = async (input) => {
  if (!input.poolAddress) return null
  const chain = input.chain as 'eth' | 'base' | 'bnb'
  const providerUsed = input.poolModel === 'pancakeswap_v3'
    ? 'the_graph_pancakeswap_v3'
    : input.poolModel === 'slipstream'
      ? 'the_graph_aerodrome_slipstream'
      : 'the_graph_uniswap_v3'
  const subgraphId = input.poolModel === 'uniswap_v3'
    ? UNISWAP_V3_SUBGRAPH_ID_BY_CHAIN[chain]
    : input.poolModel === 'pancakeswap_v3'
      ? PANCAKESWAP_V3_SUBGRAPH_ID_BY_CHAIN[chain as 'bnb']
      : input.poolModel === 'slipstream' && chain === 'base'
        ? SLIPSTREAM_SUBGRAPH_ID_BY_CHAIN.base
        : undefined
  if (!['uniswap_v3', 'pancakeswap_v3', 'slipstream'].includes(input.poolModel)) return null
  if (!subgraphId) {
    const envName = input.poolModel === 'pancakeswap_v3' ? 'GRAPH_PANCAKESWAP_V3_SUBGRAPH_ID_BNB'
      : input.poolModel === 'slipstream' ? 'GRAPH_AERODROME_SLIPSTREAM_SUBGRAPH_ID_BASE'
      : `GRAPH_UNISWAP_V3_SUBGRAPH_ID_${chain.toUpperCase()}`
    return { records: null, attempted: true, providerUsed, positionsFound: null, activePositionsFound: null, failureReason: `${envName} is not configured for this position lookup.` } satisfies ConcentratedOwnerLookupResult
  }
  const result = await queryTopPositions(subgraphId, input.poolAddress)
  if (result.rows == null) return { records: null, attempted: true, providerUsed, positionsFound: null, activePositionsFound: null, failureReason: result.failureReason }
  const records = toOwnerRecords(result.rows)
  const activePositionsFound = records.reduce((sum, row) => sum + (row.positionCount ?? 1), 0)
  return { records, attempted: true, providerUsed, positionsFound: result.rows.length, activePositionsFound, failureReason: records.length === 0 ? 'The position indexer returned no active-liquidity positions for this pool.' : null }
}
