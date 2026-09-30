// lib/server/uniswapV4BasePositions.ts — REAL current Uniswap V4 position ownership on Base, from the
// verified V4 PositionManager's position NFTs. Never from ModifyLiquidity.sender.
//
// EVIDENCE (official sources, fetched during implementation — not memory):
//  - Base PoolManager 0x498581ff…2b2b and PositionManager 0x7c5f5a4b…9bdc: Uniswap's own deployments
//    file github.com/Uniswap/contracts deployments/8453.md (PositionManager deployed 2025-01-21,
//    Uniswap/contracts commit a60641e; also the `v4PositionManager` of the UniversalRouter config there),
//    the same addresses already recorded in lib/server/concentratedLpPositions.ts / lpProof.ts.
//  - Uniswap/v4-periphery src/PositionManager.sol:
//      * every liquidity change of position NFT `tokenId` calls poolManager.modifyLiquidity with
//        `salt: bytes32(tokenId)` ("The tokenId is used as the salt for this position");
//      * getPoolAndPositionInfo(uint256 tokenId) returns (PoolKey, PositionInfo) — the pool it belongs to;
//      * getPositionLiquidity(uint256 tokenId) returns (uint128) — its CURRENT liquidity;
//      * ownerOf(uint256) — ERC721 owner (reverts for a burned/unminted id); burning clears positionInfo.
//  - Uniswap/v4-core IPoolManager: ModifyLiquidity(PoolId indexed id, address indexed sender, int24
//    tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt); PoolId = keccak256(abi.encode(poolKey)).
//
// METHOD: PoolManager ModifyLiquidity logs for EXACTLY this PoolId (topic1) -> entries whose sender is
// the verified PositionManager give candidate tokenIds (salt); every other sender is liquidity ACTIVITY
// only (a router / hook / custom manager — never an owner). For each candidate: getPoolAndPositionInfo
// must hash back to this exact PoolId, getPositionLiquidity must be > 0, and ownerOf must resolve;
// liquidity is then aggregated per NFT owner.
//
// BOUNDS: pages are walked newest-first from `latest` down to the pool's own Initialize block (never a
// single 0x0..latest scan of everything); a range/size/timeout error shrinks the window; <= 6 log pages,
// <= 25 candidate tokenIds (<= 75 logical position reads), a 4.5s deadline (inside lpProof's 6s race).
// REQUEST COST: all position reads (getPoolAndPositionInfo + getPositionLiquidity + ownerOf per
// candidate) go out as ONE Multicall3 aggregate3 eth_call (lib/server/multicall3.ts — the address/ABI
// basedex.ts already uses), allowFailure per sub-call, each candidate decoded independently. Normal
// cold scan = eth_blockNumber + Initialize + 1 log page + 1 multicall = 4 network requests. If the
// multicall itself fails, a bounded fallback reads at most V4_FALLBACK_MAX_CANDIDATES candidates with
// plain eth_calls (<= V4_FALLBACK_MAX_REQUESTS) and coverage is partial — never a 75-call fan-out.
// Hard ceiling: V4_INDEX_MAX_NETWORK_REQUESTS per cold resolve; 0 when the state cache is warm.
// COVERAGE: 'verified' only when the pages reached the pool's creation, no candidate was cut by the cap,
// every candidate was read in the batch and decoded cleanly, and no liquidity was added outside
// PositionManager NFTs; otherwise 'partial' (real owners, incomplete coverage) or 'unavailable_with_reason'.

import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { RPC } from '../rpc.ts'
import { logRpcCall } from './rpcDebug.ts'
import { auditGlobalAlchemyCall } from './globalRpcAudit.ts'
import type { ConcentratedOwnerRecord } from './lpProof.ts'
import { MULTICALL3_ADDRESS, decodeAggregate3, encodeAggregate3, type Multicall3SubCall } from './multicall3.ts'
import { V4_CONTROLLER_MAX_REQUESTS, resolveV4ControllerAttribution, type SenderStats, type V4ControllerAttribution } from './uniswapV4BaseControllers.ts'

export const BASE_V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
export const BASE_V4_POSITION_MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc'
export const BASE_V4_DEPLOYMENT_EVIDENCE = 'github.com/Uniswap/contracts deployments/8453.md (PoolManager + PositionManager, commit a60641e)'

export const MODIFY_LIQUIDITY_TOPIC0 = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'
export const INITIALIZE_TOPIC0 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
export const SEL_GET_POOL_AND_POSITION_INFO = '0x7ba03aad' // getPoolAndPositionInfo(uint256)
export const SEL_GET_POSITION_LIQUIDITY = '0x1efeed33' // getPositionLiquidity(uint256)
export const SEL_OWNER_OF = '0x6352211e' // ownerOf(uint256)

export const V4_INDEX_MAX_LOG_PAGES = 6
export const V4_INDEX_MAX_CANDIDATES = 25
/** Logical PositionManager reads (Multicall3 sub-calls), never separate network requests. */
export const V4_INDEX_MAX_POSITION_READS = V4_INDEX_MAX_CANDIDATES * 3
/** Sub-calls per aggregate3 request (~17KB calldata at 75); 25 candidates always fit in one batch. */
export const V4_MULTICALL_MAX_SUBCALLS = V4_INDEX_MAX_POSITION_READS
/** When the Multicall3 request itself fails: at most this many candidates are read individually. */
export const V4_FALLBACK_MAX_CANDIDATES = 2
export const V4_FALLBACK_MAX_REQUESTS = V4_FALLBACK_MAX_CANDIDATES * 3
/** Absolute per-resolve network ceiling: head + Initialize + log pages + one multicall + fallback. */
export const V4_INDEX_MAX_NETWORK_REQUESTS = 2 + V4_INDEX_MAX_LOG_PAGES + 1 + V4_FALLBACK_MAX_REQUESTS
/** Non-PositionManager controller attribution runs after the position reads, on its own small budget. */
export const V4_CONTROLLER_DEADLINE_MS = 5_200
export const V4_TOTAL_MAX_NETWORK_REQUESTS = V4_INDEX_MAX_NETWORK_REQUESTS + V4_CONTROLLER_MAX_REQUESTS
export const V4_INDEX_DEADLINE_MS = 4_500
export const V4_INDEX_MIN_WINDOW = 2_000
/** Window used when the pool's Initialize block could not be read (coverage is then never 'verified'). */
export const V4_INDEX_FALLBACK_WINDOW = 1_000_000
const INDEX_TTL_MS = 10 * 60_000
const STATE_TTL_MS = 2 * 60_000
const TOKEN_POOL_TTL_MS = 24 * 3_600_000
const CACHE_MAX = 500

export type V4IndexStatus = 'verified' | 'partial' | 'unavailable_with_reason'
export type V4IndexReason =
  | 'resolved'
  | 'rpc_unavailable'
  | 'log_query_failed'
  | 'deadline_exceeded'
  | 'no_position_nfts_found'
  | 'no_active_position_nfts'
  | 'activity_not_via_position_manager'
  | 'owner_reads_failed'

export type V4OwnerRow = { owner: string; activePositions: number; liquidityRaw: string; sharePct: number | null }
export type V4PositionIndexResult = {
  status: V4IndexStatus
  reason: V4IndexReason
  /** Public copy for the Position Ownership row. */
  publicText: string
  /** Human LP-control summary derived from real current owners (null when none resolved). */
  controlSummary: string | null
  poolId: string
  positionManager: string
  poolManager: string
  deploymentEvidence: string
  owners: V4OwnerRow[]
  ownerCount: number
  activePositions: number
  totalActiveLiquidity: string | null
  topOwnerSharePct: number | null
  top3SharePct: number | null
  top5SharePct: number | null
  coverage: {
    fromBlock: number | null
    toBlock: number | null
    initializeBlock: number | null
    pages: number
    eventsScanned: number
    candidateTokenIds: number
    candidatesRead: number
    activeTokenIds: number
    ownersResolved: number
    rejected: { otherPool: number; burned: number; zeroLiquidity: number; ownerUnresolved: number; readFailed: number; malformed: number }
    otherSenderActivity: { senders: number; netPositiveLiquidity: boolean }
    truncated: boolean
    reachedPoolCreation: boolean
    deadlineHit: boolean
    /** Multicall3 batch outcome; `fallbackCandidates` were read individually after a batch failure. */
    multicall: { batches: number; failed: boolean; fallbackCandidates: number; unreadCandidates: number }
  }
  /** Actual network (JSON-RPC HTTP) requests — the number Token Scanner's budget cares about. */
  calls: number
  requests: V4IndexRequests
  /** Who directly modified liquidity outside the canonical PositionManager (activity / control evidence,
   *  never beneficial ownership). null when every observed event went through the PositionManager. */
  controllerAttribution: V4ControllerAttribution | null
  /** PoolKey.hooks proven from the pool's Initialize event (null when not proven / no hook). */
  hook: string | null
  cache: { index: boolean; state: boolean }
}

export type V4IndexRequests = {
  /** Actual network requests (== calls). */
  network: number
  /** Log-side requests: eth_blockNumber + Initialize + ModifyLiquidity pages. */
  logRequests: number
  logPages: number
  multicallBatches: number
  /** PositionManager reads carried inside Multicall3 batches (not network requests). */
  multicallSubcalls: number
  /** Individual eth_calls made by the bounded fallback. */
  fallbackCalls: number
  /** Every logical read: non-multicall requests + multicall sub-calls. */
  rpcLogicalReads: number
  /** Network requests spent on non-PositionManager controller attribution (included in `network`). */
  controllerRequests: number
}

export type V4IndexRpc = (method: string, params: unknown[], timeoutMs: number) => Promise<{ result: unknown; error: string | null }>

type RawLog = { address?: string; topics?: string[]; data?: string; blockNumber?: string; transactionHash?: string; removed?: boolean }
type IndexScan = {
  latest: number
  initBlock: number | null
  fromBlock: number | null
  pages: number
  events: number
  reachedCreation: boolean
  candidates: Map<string, { lastBlock: number; net: bigint }>
  otherSenders: Map<string, SenderStats>
  positionManagerEvents: number
  /** PoolKey.hooks, only when the Initialize log's key hashes back to this exact PoolId. */
  hook: string | null
  error: 'log_query_failed' | 'deadline_exceeded' | null
}

const indexCache = new Map<string, { expiresAt: number; scan: IndexScan }>()
const stateCache = new Map<string, { expiresAt: number; value: V4PositionIndexResult }>()
const tokenPoolCache = new Map<string, { expiresAt: number; poolId: string }>()
const inFlight = new Map<string, Promise<V4PositionIndexResult>>()
// Cache keys carry chain + PositionManager (+ PoolId / tokenId): tokenId -> PoolId is immutable per manager.
const poolKey = (poolId: string) => `base:${BASE_V4_POSITION_MANAGER}:${poolId}`
const tokenKey = (tokenId: bigint) => `base:${BASE_V4_POSITION_MANAGER}:${tokenId.toString()}`
export function resetV4PositionIndexCache() { indexCache.clear(); stateCache.clear(); tokenPoolCache.clear(); inFlight.clear() }
const bounded = <K, V>(m: Map<K, V>) => { if (m.size >= CACHE_MAX) m.delete(m.keys().next().value!) }

const toHex = (n: number) => `0x${Math.max(0, Math.floor(n)).toString(16)}`
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const addrFromTopic = (t: string | undefined): string | null => {
  const h = (t ?? '').toLowerCase().replace(/^0x/, '')
  return /^[0-9a-f]{64}$/.test(h) && /^0{24}/.test(h) ? `0x${h.slice(24)}` : null
}
const signed256 = (w: string): bigint => { const v = BigInt(`0x${w}`); return v >= (BigInt(1) << BigInt(255)) ? v - (BigInt(1) << BigInt(256)) : v }
const TOO_WIDE = /range|too many|limit|exceed|response size|10000|timeout|timed out|query returned more/i

export function defaultBaseRpc(): V4IndexRpc | null {
  const url = RPC.base
  if (!url) return null
  return async (method, params, timeoutMs) => {
    logRpcCall({ route: 'uniswapV4BasePositions', chain: 'base', method })
    if (url.includes('g.alchemy.com')) auditGlobalAlchemyCall(method, { chain: 'base', route: 'uniswapV4BasePositions' })
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.max(1, timeoutMs)) })
      if (!res.ok) return { result: null, error: `http_${res.status}` }
      const json = await res.json() as { result?: unknown; error?: { message?: string } }
      if (json.error) return { result: null, error: json.error.message ?? 'rpc_error' }
      return { result: json.result ?? null, error: null }
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : 'rpc_error' }
    }
  }
}

/** Decodes one PoolManager ModifyLiquidity log for exactly this PoolId (null when it is not one). */
export function decodeModifyLiquidity(log: RawLog, poolId: string): { sender: string; liquidityDelta: bigint; salt: bigint; block: number; txHash: string | null } | null {
  if (log.removed === true) return null
  if ((log.address ?? '').toLowerCase() !== BASE_V4_POOL_MANAGER) return null
  const t = log.topics ?? []
  if ((t[0] ?? '').toLowerCase() !== MODIFY_LIQUIDITY_TOPIC0 || (t[1] ?? '').toLowerCase() !== poolId) return null
  const sender = addrFromTopic(t[2])
  const data = (log.data ?? '').replace(/^0x/, '')
  if (!sender || data.length < 4 * 64) return null
  const block = log.blockNumber ? Number(BigInt(log.blockNumber)) : NaN
  const tx = /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash ?? '') ? log.transactionHash!.toLowerCase() : null
  return { sender, liquidityDelta: signed256(data.slice(128, 192)), salt: BigInt(`0x${data.slice(192, 256)}`), block: Number.isFinite(block) ? block : 0, txHash: tx }
}

/** PoolId of the PoolKey returned by getPoolAndPositionInfo (its first 5 ABI words), or null. */
export function poolIdFromPositionInfo(resultHex: unknown): string | null {
  if (typeof resultHex !== 'string') return null
  const body = resultHex.replace(/^0x/, '')
  if (body.length < 6 * 64 || !/^[0-9a-fA-F]+$/.test(body)) return null
  const keyWords = body.slice(0, 5 * 64)
  if (/^0+$/.test(keyWords)) return null // cleared (burned) position: empty PoolKey
  return keccak256(`0x${keyWords}` as Hex).toLowerCase()
}

/** PoolKey.hooks from an Initialize log — only when abi.encode(currency0, currency1, fee, tickSpacing, hooks)
 *  hashes back to this exact PoolId (Initialize(id, currency0, currency1, fee, tickSpacing, hooks, sqrtPriceX96, tick)). */
export function hookFromInitialize(log: RawLog, poolId: string): string | null {
  const t = log.topics ?? []
  const data = (log.data ?? '').replace(/^0x/, '')
  const c0 = addrFromTopic(t[2])
  const c1 = addrFromTopic(t[3])
  if (!c0 || !c1 || data.length < 5 * 64 || !/^[0-9a-fA-F]+$/.test(data)) return null
  const hooksWord = data.slice(128, 192)
  if (!/^0{24}/.test(hooksWord)) return null
  const hooks = `0x${hooksWord.slice(24).toLowerCase()}`
  try {
    const fee = Number(BigInt(`0x${data.slice(0, 64)}`))
    const spacing = Number(signed256(data.slice(64, 128)))
    const encoded = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [c0 as Hex, c1 as Hex, fee, spacing, hooks as Hex])
    return keccak256(encoded).toLowerCase() === poolId ? hooks : null
  } catch {
    return null
  }
}

async function scanPoolLogs(poolId: string, rpc: V4IndexRpc, deadline: number, now: () => number, calls: { n: number }): Promise<IndexScan> {
  const scan: IndexScan = { latest: 0, initBlock: null, fromBlock: null, pages: 0, events: 0, reachedCreation: false, candidates: new Map(), otherSenders: new Map(), positionManagerEvents: 0, hook: null, error: null }
  const left = () => Math.max(1, deadline - now())
  calls.n++
  const head = await rpc('eth_blockNumber', [], left())
  if (head.error || typeof head.result !== 'string') { scan.error = 'log_query_failed'; return scan }
  scan.latest = Number(BigInt(head.result))
  // The pool's own Initialize block bounds the history (one exact-PoolId query; tiny result).
  calls.n++
  const init = await rpc('eth_getLogs', [{ address: BASE_V4_POOL_MANAGER, topics: [INITIALIZE_TOPIC0, poolId], fromBlock: '0x0', toBlock: toHex(scan.latest) }], left())
  if (!init.error && Array.isArray(init.result)) {
    const hit = (init.result as RawLog[]).find((l) => l.removed !== true && (l.address ?? '').toLowerCase() === BASE_V4_POOL_MANAGER && (l.topics?.[1] ?? '').toLowerCase() === poolId && l.blockNumber)
    if (hit?.blockNumber) scan.initBlock = Number(BigInt(hit.blockNumber))
    if (hit) scan.hook = hookFromInitialize(hit, poolId)
  }
  const floor = scan.initBlock ?? Math.max(0, scan.latest - V4_INDEX_FALLBACK_WINDOW + 1)
  let toBlock = scan.latest
  let window = scan.latest - floor + 1
  while (toBlock >= floor && scan.pages < V4_INDEX_MAX_LOG_PAGES) {
    if (now() >= deadline) { scan.error = 'deadline_exceeded'; break }
    const fromBlock = Math.max(floor, toBlock - window + 1)
    calls.n++
    scan.pages++
    const page = await rpc('eth_getLogs', [{ address: BASE_V4_POOL_MANAGER, topics: [MODIFY_LIQUIDITY_TOPIC0, poolId], fromBlock: toHex(fromBlock), toBlock: toHex(toBlock) }], left())
    if (page.error || !Array.isArray(page.result)) {
      // Too wide for the node (range / result size / timeout): retry the same end with a smaller window.
      if (page.error && TOO_WIDE.test(page.error) && window > V4_INDEX_MIN_WINDOW) { window = Math.max(V4_INDEX_MIN_WINDOW, Math.floor(window / 8)); continue }
      scan.error = 'log_query_failed'
      break
    }
    for (const raw of page.result as RawLog[]) {
      const ev = decodeModifyLiquidity(raw, poolId)
      if (!ev) continue
      scan.events++
      if (ev.sender === BASE_V4_POSITION_MANAGER) {
        scan.positionManagerEvents++
        const id = ev.salt.toString()
        const c = scan.candidates.get(id) ?? { lastBlock: 0, net: BigInt(0) }
        c.lastBlock = Math.max(c.lastBlock, ev.block)
        c.net += ev.liquidityDelta
        scan.candidates.set(id, c)
      } else {
        const o = scan.otherSenders.get(ev.sender) ?? { events: 0, net: BigInt(0), adds: 0, removes: 0, lastBlock: 0, txs: [] }
        o.events++
        o.net += ev.liquidityDelta
        if (ev.liquidityDelta > BigInt(0)) o.adds++
        else if (ev.liquidityDelta < BigInt(0)) o.removes++
        o.lastBlock = Math.max(o.lastBlock, ev.block)
        if (ev.txHash && o.txs.length < 3 && !o.txs.includes(ev.txHash)) o.txs.push(ev.txHash)
        scan.otherSenders.set(ev.sender, o)
      }
    }
    scan.fromBlock = fromBlock
    if (fromBlock <= floor) { scan.reachedCreation = scan.initBlock != null; break }
    toBlock = fromBlock - 1
  }
  return scan
}

// Per-candidate decoding — identical evidence rules whether the bytes came from a Multicall3 sub-call or
// a fallback eth_call. `null` means the read did not succeed (revert / RPC error).
type Read = { ok: true; hex: string } | { ok: false }
type Verdict =
  | { kind: 'active'; owner: string; liquidity: bigint }
  | { kind: 'other_pool' | 'burned' | 'zero' | 'owner_unresolved' | 'read_failed' | 'malformed' }
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const body = (hex: string) => hex.replace(/^0x/, '')
/** getPoolAndPositionInfo return: 'burned' (cleared PoolKey), 'malformed', or the PoolId it hashes to. */
export function classifyPositionInfo(hex: string): { poolId: string } | 'burned' | 'malformed' {
  const b = body(hex)
  if (b.length < 6 * 64 || b.length % 64 !== 0 || !/^[0-9a-fA-F]+$/.test(b)) return 'malformed'
  const pid = poolIdFromPositionInfo(hex)
  return pid ? { poolId: pid } : 'burned'
}
/** getPositionLiquidity return: exactly one uint128 word, else null (malformed). */
export function decodeLiquidityWord(hex: string): bigint | null {
  const b = body(hex)
  if (b.length !== 64 || !/^0{32}[0-9a-fA-F]{32}$/.test(b)) return null
  return BigInt(`0x${b}`)
}
/** ownerOf return: exactly one address word, else null (malformed). */
export function decodeOwnerWord(hex: string): string | null {
  const b = body(hex)
  if (b.length !== 64 || !/^0{24}[0-9a-fA-F]{40}$/.test(b)) return null
  return `0x${b.slice(24).toLowerCase()}`
}
type PoolProof = { poolId: string } | 'burned' | 'malformed' | null
function verdict(poolId: string, pid: PoolProof, liq: Read, own: Read): Verdict {
  if (pid === null) return { kind: 'read_failed' }
  if (pid === 'burned') return { kind: 'burned' }
  if (pid === 'malformed') return { kind: 'malformed' }
  if (pid.poolId !== poolId) return { kind: 'other_pool' }
  if (!liq.ok) return { kind: 'read_failed' }
  const liquidity = decodeLiquidityWord(liq.hex)
  if (liquidity == null) return { kind: 'malformed' }
  if (liquidity <= BigInt(0)) return { kind: 'zero' }
  if (!own.ok) return { kind: 'owner_unresolved' }
  const owner = decodeOwnerWord(own.hex)
  if (owner == null) return { kind: 'malformed' }
  if (owner === ZERO_ADDRESS) return { kind: 'owner_unresolved' }
  return { kind: 'active', owner, liquidity }
}

const pct = (part: bigint, total: bigint): number | null => (total > BigInt(0) ? Math.round(Number((part * BigInt(1_000_000)) / total)) / 10_000 : null)

export async function resolveBaseV4PositionIndex(
  input: { poolId: string },
  deps: { rpc?: V4IndexRpc | null; now?: () => number } = {},
): Promise<V4PositionIndexResult> {
  const now = deps.now ?? Date.now
  const poolId = input.poolId.toLowerCase()
  const rpc = deps.rpc === undefined ? defaultBaseRpc() : deps.rpc
  const empty = (status: V4IndexStatus, reason: V4IndexReason, publicText: string, scan: IndexScan | null, calls: number, extra: Partial<V4PositionIndexResult['coverage']> = {}): V4PositionIndexResult => ({
    status, reason, publicText, controlSummary: null, poolId, positionManager: BASE_V4_POSITION_MANAGER, poolManager: BASE_V4_POOL_MANAGER, deploymentEvidence: BASE_V4_DEPLOYMENT_EVIDENCE,
    owners: [], ownerCount: 0, activePositions: 0, totalActiveLiquidity: null, topOwnerSharePct: null, top3SharePct: null, top5SharePct: null,
    coverage: {
      fromBlock: scan?.fromBlock ?? null, toBlock: scan?.latest || null, initializeBlock: scan?.initBlock ?? null, pages: scan?.pages ?? 0, eventsScanned: scan?.events ?? 0,
      candidateTokenIds: scan?.candidates.size ?? 0, candidatesRead: 0, activeTokenIds: 0, ownersResolved: 0,
      rejected: { otherPool: 0, burned: 0, zeroLiquidity: 0, ownerUnresolved: 0, readFailed: 0, malformed: 0 },
      otherSenderActivity: { senders: scan?.otherSenders.size ?? 0, netPositiveLiquidity: [...(scan?.otherSenders.values() ?? [])].some((v) => v.net > BigInt(0)) },
      truncated: false, reachedPoolCreation: scan?.reachedCreation ?? false, deadlineHit: scan?.error === 'deadline_exceeded',
      multicall: { batches: 0, failed: false, fallbackCandidates: 0, unreadCandidates: 0 }, ...extra,
    },
    calls, requests: { network: calls, logRequests: calls, logPages: scan?.pages ?? 0, multicallBatches: 0, multicallSubcalls: 0, fallbackCalls: 0, rpcLogicalReads: calls, controllerRequests: 0 },
    controllerAttribution: null, hook: scan?.hook ?? null,
    cache: { index: false, state: false },
  })
  if (!/^0x[0-9a-f]{64}$/.test(poolId)) return empty('unavailable_with_reason', 'log_query_failed', 'Position ownership unavailable — the Uniswap V4 pool id is not a valid 32-byte id.', null, 0)
  if (!rpc) return empty('unavailable_with_reason', 'rpc_unavailable', 'Position ownership unavailable — Base RPC is not configured for the Uniswap V4 position index.', null, 0)

  const key = poolKey(poolId)
  const st = stateCache.get(key)
  if (st && st.expiresAt > now()) return { ...st.value, calls: 0, requests: { network: 0, logRequests: 0, logPages: 0, multicallBatches: 0, multicallSubcalls: 0, fallbackCalls: 0, rpcLogicalReads: 0, controllerRequests: 0 }, cache: { index: true, state: true } }
  const running = inFlight.get(key)
  if (running) return running
  const work = (async (): Promise<V4PositionIndexResult> => {
    const started = now()
    const deadline = started + V4_INDEX_DEADLINE_MS
    const calls = { n: 0 }
    let indexHit = false
    let scan: IndexScan
    const ic = indexCache.get(key)
    if (ic && ic.expiresAt > now()) { scan = ic.scan; indexHit = true }
    else {
      scan = await scanPoolLogs(poolId, rpc, deadline, now, calls)
      if (!scan.error) { bounded(indexCache); indexCache.set(key, { expiresAt: now() + INDEX_TTL_MS, scan }) }
    }
    if (scan.error && scan.fromBlock == null) {
      return empty('unavailable_with_reason', scan.error, 'Position ownership unavailable — beneficial V4 position owners could not be verified from the indexed range (the RPC did not return this pool\'s position history).', scan, calls.n)
    }

    // Candidates: provably-closed positions (net <= 0 over history that reached creation) are skipped;
    // the rest newest-activity first, capped.
    const all = [...scan.candidates.entries()]
      .filter(([, c]) => !(scan.reachedCreation && c.net <= BigInt(0)))
      .sort((a, b) => (b[1].net > BigInt(0) ? 1 : 0) - (a[1].net > BigInt(0) ? 1 : 0) || b[1].lastBlock - a[1].lastBlock)
    const truncated = all.length > V4_INDEX_MAX_CANDIDATES
    const chosen = all.slice(0, V4_INDEX_MAX_CANDIDATES).map(([id]) => BigInt(id))
    const rejected = { otherPool: 0, burned: 0, zeroLiquidity: 0, ownerUnresolved: 0, readFailed: 0, malformed: 0 }
    let deadlineHit = scan.error === 'deadline_exceeded'
    const logRequests = calls.n
    // One network request, refused past the deadline or the absolute ceiling (never a fan-out).
    const ethCall = async (to: string, data: string): Promise<Read | null> => {
      if (now() >= deadline) { deadlineHit = true; return null }
      if (calls.n >= V4_INDEX_MAX_NETWORK_REQUESTS) return null
      calls.n++
      const res = await rpc('eth_call', [{ to, data }, 'latest'], Math.max(1, deadline - now()))
      return !res.error && typeof res.result === 'string' ? { ok: true, hex: res.result } : { ok: false }
    }

    // Immutable tokenId -> PoolId cache: a cached other-pool id needs no read at all; a cached same-pool
    // id skips its getPoolAndPositionInfo sub-call.
    const plan = chosen.map((id) => {
      const c = tokenPoolCache.get(tokenKey(id))
      return { id, idWord: word(id), cachedPid: c && c.expiresAt > now() ? c.poolId : null }
    })
    const verdicts: Verdict[] = []
    const toRead: typeof plan = []
    for (const p of plan) {
      if (p.cachedPid && p.cachedPid !== poolId) verdicts.push({ kind: 'other_pool' })
      else toRead.push(p)
    }
    const remember = (id: bigint, info: ReturnType<typeof classifyPositionInfo>) => {
      if (typeof info === 'object') { bounded(tokenPoolCache); tokenPoolCache.set(tokenKey(id), { expiresAt: now() + TOKEN_POOL_TTL_MS, poolId: info.poolId }) }
    }

    let batches = 0
    let subcalls = 0
    let multicallFailed = false
    let fallbackCandidates = 0
    let fallbackCalls = 0
    let unread = 0
    if (toRead.length > 0) {
      const sub: Multicall3SubCall[] = []
      const slots = toRead.map((p) => {
        const info = p.cachedPid ? -1 : sub.push({ target: BASE_V4_POSITION_MANAGER, callData: `${SEL_GET_POOL_AND_POSITION_INFO}${p.idWord}` }) - 1
        const liq = sub.push({ target: BASE_V4_POSITION_MANAGER, callData: `${SEL_GET_POSITION_LIQUIDITY}${p.idWord}` }) - 1
        const own = sub.push({ target: BASE_V4_POSITION_MANAGER, callData: `${SEL_OWNER_OF}${p.idWord}` }) - 1
        return { info, liq, own }
      })
      // <= 25 candidates x 3 = V4_MULTICALL_MAX_SUBCALLS: always a single aggregate3 request.
      const batch = sub.slice(0, V4_MULTICALL_MAX_SUBCALLS)
      const res = await ethCall(MULTICALL3_ADDRESS, encodeAggregate3(batch))
      if (res) { batches = 1; subcalls = batch.length }
      const decoded = res?.ok ? decodeAggregate3(res.hex, batch.length) : null
      if (decoded) {
        const at = (i: number): Read => (i >= 0 && i < decoded.length && decoded[i].success ? { ok: true, hex: decoded[i].returnData } : { ok: false })
        toRead.forEach((p, k) => {
          const s = slots[k]
          let pid: PoolProof = p.cachedPid ? { poolId: p.cachedPid } : null
          if (!pid) {
            const r = at(s.info)
            pid = r.ok ? classifyPositionInfo(r.hex) : null
            if (pid) remember(p.id, pid)
          }
          verdicts.push(verdict(poolId, pid, at(s.liq), at(s.own)))
        })
      } else if (res === null) {
        // Deadline / ceiling before the batch could be sent: nothing was read.
        for (let i = 0; i < toRead.length; i++) verdicts.push({ kind: 'read_failed' })
      } else {
        // Multicall3 itself failed (RPC error or undecodable): bounded sequential fallback only.
        multicallFailed = true
        for (const p of toRead) {
          if (fallbackCandidates >= V4_FALLBACK_MAX_CANDIDATES) { unread++; continue }
          fallbackCandidates++
          const before = calls.n
          let pid: PoolProof = p.cachedPid ? { poolId: p.cachedPid } : null
          if (!pid) {
            const r = await ethCall(BASE_V4_POSITION_MANAGER, `${SEL_GET_POOL_AND_POSITION_INFO}${p.idWord}`)
            pid = r?.ok ? classifyPositionInfo(r.hex) : null
            if (pid) remember(p.id, pid)
          }
          let v: Verdict
          if (pid === null || typeof pid === 'string' || pid.poolId !== poolId) {
            v = verdict(poolId, pid, { ok: false }, { ok: false })
          } else {
            const liq = await ethCall(BASE_V4_POSITION_MANAGER, `${SEL_GET_POSITION_LIQUIDITY}${p.idWord}`)
            const liqV = decodeLiquidityWord(liq?.ok ? liq.hex : '')
            const own = liq?.ok && liqV != null && liqV > BigInt(0) ? await ethCall(BASE_V4_POSITION_MANAGER, `${SEL_OWNER_OF}${p.idWord}`) : null
            v = verdict(poolId, pid, liq ?? { ok: false }, own ?? { ok: false })
          }
          fallbackCalls += calls.n - before
          verdicts.push(v)
        }
      }
    }
    const reads = verdicts
    // Non-PositionManager liquidity modifiers: classify from the already-indexed events (no second scan).
    let controllerAttribution: V4ControllerAttribution | null = null
    let controllerRequests = 0
    if (scan.otherSenders.size > 0) {
      controllerAttribution = await resolveV4ControllerAttribution(
        { senders: scan.otherSenders, positionManagerEvents: scan.positionManagerEvents, hook: scan.hook, reachedPoolCreation: scan.reachedCreation },
        { rpc, deadline: started + V4_CONTROLLER_DEADLINE_MS, now },
      )
      controllerRequests = controllerAttribution.requests.network
      calls.n += controllerRequests
    }
    const requests = (): V4IndexRequests => ({
      network: calls.n, logRequests, logPages: indexHit ? 0 : scan.pages, multicallBatches: batches, multicallSubcalls: subcalls, fallbackCalls,
      rpcLogicalReads: calls.n - batches + subcalls - (controllerAttribution?.requests.multicallBatches ?? 0) + (controllerAttribution?.requests.multicallSubcalls ?? 0),
      controllerRequests,
    })

    const byOwner = new Map<string, { positions: number; liquidity: bigint }>()
    for (const r of reads) {
      if (r.kind === 'active') {
        const o = byOwner.get(r.owner) ?? { positions: 0, liquidity: BigInt(0) }
        o.positions++
        o.liquidity += r.liquidity
        byOwner.set(r.owner, o)
      } else if (r.kind === 'other_pool') rejected.otherPool++
      else if (r.kind === 'burned') rejected.burned++
      else if (r.kind === 'zero') rejected.zeroLiquidity++
      else if (r.kind === 'owner_unresolved') rejected.ownerUnresolved++
      else if (r.kind === 'malformed') rejected.malformed++
      else rejected.readFailed++
    }
    const owners = [...byOwner.entries()].sort((a, b) => (b[1].liquidity > a[1].liquidity ? 1 : b[1].liquidity < a[1].liquidity ? -1 : a[0] < b[0] ? -1 : 1))
    const total = owners.reduce((s, [, o]) => s + o.liquidity, BigInt(0))
    const activePositions = owners.reduce((s, [, o]) => s + o.positions, 0)
    const topN = (n: number) => pct(owners.slice(0, n).reduce((s, [, o]) => s + o.liquidity, BigInt(0)), total)
    const otherPositive = [...scan.otherSenders.values()].some((v) => v.net > BigInt(0))
    const coverage: V4PositionIndexResult['coverage'] = {
      fromBlock: scan.fromBlock, toBlock: scan.latest, initializeBlock: scan.initBlock, pages: scan.pages, eventsScanned: scan.events,
      candidateTokenIds: scan.candidates.size, candidatesRead: chosen.length - unread, activeTokenIds: activePositions, ownersResolved: owners.length, rejected,
      otherSenderActivity: { senders: scan.otherSenders.size, netPositiveLiquidity: otherPositive },
      truncated, reachedPoolCreation: scan.reachedCreation, deadlineHit,
      multicall: { batches, failed: multicallFailed, fallbackCandidates, unreadCandidates: unread },
    }
    const base = { poolId, positionManager: BASE_V4_POSITION_MANAGER, poolManager: BASE_V4_POOL_MANAGER, deploymentEvidence: BASE_V4_DEPLOYMENT_EVIDENCE, coverage, calls: calls.n, requests: requests(), controllerAttribution, hook: scan.hook, cache: { index: indexHit, state: false } }

    if (owners.length === 0) {
      const reason: V4IndexReason = rejected.readFailed + rejected.ownerUnresolved + rejected.malformed + unread > 0 ? (deadlineHit ? 'deadline_exceeded' : 'owner_reads_failed')
        : scan.candidates.size === 0 ? (scan.otherSenders.size > 0 ? 'activity_not_via_position_manager' : 'no_position_nfts_found')
          : 'no_active_position_nfts'
      const text: Record<V4IndexReason, string> = {
        resolved: '',
        rpc_unavailable: '',
        log_query_failed: 'Position ownership unavailable — beneficial V4 position owners could not be verified from the indexed range.',
        deadline_exceeded: 'Position ownership unavailable — the V4 position index ran out of time before any active position owner was read.',
        owner_reads_failed: 'Position ownership unavailable — V4 position NFTs were found, but their current owners/liquidity could not be read.',
        activity_not_via_position_manager: 'Position ownership unavailable — no canonical Uniswap V4 position NFTs were found; liquidity activity was found, but not through the Uniswap V4 PositionManager, so beneficial owners cannot be attributed.',
        no_position_nfts_found: scan.reachedCreation
          ? 'Position ownership unavailable — no Uniswap V4 position NFTs were found for this pool since its creation.'
          : 'Position ownership unavailable — no Uniswap V4 position NFTs were found in the indexed range; older history was not fully indexed.',
        no_active_position_nfts: `Position ownership unavailable — ${scan.candidates.size} V4 position NFT(s) were found, but none currently holds liquidity${scan.reachedCreation ? '' : ' in the indexed range'}.`,
      }
      return { ...base, status: 'unavailable_with_reason', reason, publicText: text[reason], controlSummary: null, owners: [], ownerCount: 0, activePositions: 0, totalActiveLiquidity: null, topOwnerSharePct: null, top3SharePct: null, top5SharePct: null }
    }

    const rows: V4OwnerRow[] = owners.map(([owner, o]) => ({ owner, activePositions: o.positions, liquidityRaw: o.liquidity.toString(), sharePct: pct(o.liquidity, total) }))
    const complete = scan.reachedCreation && !truncated && !deadlineHit && !multicallFailed && unread === 0
      && rejected.readFailed === 0 && rejected.ownerUnresolved === 0 && rejected.malformed === 0 && !otherPositive && !scan.error
    const top1 = rows[0].sharePct
    const top3 = topN(3)
    const top5 = topN(5)
    const controlSummary = rows.length === 1
      ? `One wallet controls 100% of active V4 position liquidity (${activePositions} position${activePositions === 1 ? '' : 's'})`
      : top1 != null && top1 >= 50
        ? `One wallet controls ${top1}% of active V4 position liquidity`
        : rows.length >= 10 && top1 != null && top1 < 20
          ? `Distributed across ${rows.length} owners (top owner ${top1}%)`
          : `Top ${Math.min(3, rows.length)} owners control ${top3 ?? '—'}% of active V4 position liquidity`
    const gaps: string[] = []
    if (!scan.reachedCreation) gaps.push('older position history was not fully indexed')
    if (truncated) gaps.push(`only the ${V4_INDEX_MAX_CANDIDATES} most recent candidate positions were read`)
    if (rejected.readFailed + rejected.ownerUnresolved + rejected.malformed > 0) gaps.push(`${rejected.readFailed + rejected.ownerUnresolved + rejected.malformed} position read(s) failed`)
    if (multicallFailed) gaps.push(`the batched position read failed, so only ${fallbackCandidates} of ${toRead.length} candidate positions were read individually`)
    if (otherPositive) gaps.push('some liquidity was added outside PositionManager NFTs and has no attributable owner')
    if (deadlineHit) gaps.push('the index stopped at its time limit')
    const publicText = complete
      ? `Position ownership verified — ${activePositions} active V4 position NFT${activePositions === 1 ? '' : 's'} across ${rows.length} owner${rows.length === 1 ? '' : 's'}, indexed from pool creation.`
      : `Position ownership partial — ${activePositions} active V4 position NFT${activePositions === 1 ? '' : 's'} resolved across ${rows.length} owner${rows.length === 1 ? '' : 's'}; ${gaps.join('; ')}.`
    return {
      ...base, status: complete ? 'verified' : 'partial', reason: 'resolved', publicText, controlSummary,
      owners: rows.slice(0, 20), ownerCount: rows.length, activePositions, totalActiveLiquidity: total.toString(), topOwnerSharePct: top1, top3SharePct: top3, top5SharePct: top5,
    }
  })()
  inFlight.set(key, work)
  try {
    const out = await work
    if (out.status !== 'unavailable_with_reason' || out.reason === 'no_position_nfts_found' || out.reason === 'no_active_position_nfts') {
      bounded(stateCache)
      stateCache.set(key, { expiresAt: now() + STATE_TTL_MS, value: out })
    }
    return out
  } finally {
    inFlight.delete(key)
  }
}

/** Owner records for lpProof's share/classification pipeline (liquidity per beneficial NFT owner). */
export function v4IndexOwnerRecords(result: V4PositionIndexResult): ConcentratedOwnerRecord[] {
  return result.owners.map((o) => ({ address: o.owner, liquidityRaw: o.liquidityRaw, positionCount: o.activePositions }))
}
