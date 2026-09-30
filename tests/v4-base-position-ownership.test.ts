// Base Uniswap V4 LP ownership from PositionManager position NFTs (lib/server/uniswapV4BasePositions.ts,
// wired through lib/server/uniswapV4BaseRpc.ts -> lib/server/lpProof.ts attemptConcentratedPositionProof).
// A fake Base RPC serves PoolManager logs and PositionManager eth_calls ABI-encoded exactly as the
// contracts return them. Wallet / token-id / pool-key values are fixtures; manager addresses are real.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, type Hex } from 'viem'
import {
  BASE_V4_POOL_MANAGER,
  BASE_V4_POSITION_MANAGER,
  INITIALIZE_TOPIC0,
  MODIFY_LIQUIDITY_TOPIC0,
  SEL_GET_POOL_AND_POSITION_INFO,
  SEL_GET_POSITION_LIQUIDITY,
  SEL_OWNER_OF,
  V4_INDEX_DEADLINE_MS,
  V4_INDEX_MAX_CANDIDATES,
  V4_INDEX_MAX_LOG_PAGES,
  V4_INDEX_MAX_POSITION_READS,
  V4_INDEX_MAX_NETWORK_REQUESTS,
  V4_FALLBACK_MAX_CANDIDATES,
  V4_FALLBACK_MAX_REQUESTS,
  poolIdFromPositionInfo,
  resetV4PositionIndexCache,
  resolveBaseV4PositionIndex,
  type V4IndexRpc,
} from '../lib/server/uniswapV4BasePositions.ts'
import { resolveUniswapV4BaseRpc } from '../lib/server/uniswapV4BaseRpc.ts'
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from '../lib/server/multicall3.ts'
import { attemptConcentratedPositionProof, type ConcentratedOwnerLookupResult } from '../lib/server/lpProof.ts'
import { resolveConcentratedLpPositions, V4_SENDER_NOT_OWNER_REASON } from '../lib/server/concentratedLpPositions.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'
const HOOKS = '0x0000000000000000000000000000000000000000'
const poolKeyWords = (fee: number) => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [TOKEN_A, TOKEN_B, fee, 60, HOOKS])
const POOL_KEY = poolKeyWords(3000)
const POOL_ID = keccak256(POOL_KEY).toLowerCase()
const OTHER_KEY = poolKeyWords(500)
const ALICE = '0x00000000000000000000000000000000000a11ce'
const BOB = '0x0000000000000000000000000000000000000b0b'
const CAROL = '0x00000000000000000000000000000000000ca401'
const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43'
const LATEST = 30_000_000
const INIT = 25_000_000

type Pos = { owner: string | null; liquidity: bigint; key?: Hex | 'burned' }
const w = (n: bigint) => n.toString(16).padStart(64, '0')
const pad = (addr: string) => `0x${addr.slice(2).padStart(64, '0')}`
function mlLog(sender: string, tokenIdOrSalt: bigint, delta: bigint, block: number, poolId = POOL_ID) {
  const signed = delta < BigInt(0) ? (BigInt(1) << BigInt(256)) + delta : delta
  return { address: BASE_V4_POOL_MANAGER, topics: [MODIFY_LIQUIDITY_TOPIC0, poolId, pad(sender)], data: `0x${w(BigInt(0))}${w(BigInt(60))}${w(signed)}${w(tokenIdOrSalt)}`, blockNumber: `0x${block.toString(16)}`, removed: false }
}

function fakeRpc(opts: {
  positions: Record<string, Pos>
  logs: ReturnType<typeof mlLog>[]
  initFound?: boolean
  maxRange?: number | null
  failLogs?: string | null
  /** Multicall3 behaviour: 'ok' (default) decodes and serves every sub-call; 'error' = RPC error; 'garbage' = undecodable bytes. */
  multicall?: 'ok' | 'error' | 'garbage'
  /** Sub-call index -> forced raw return (malformed-result tests). */
  malformedOwnerFor?: string[]
}) {
  const calls: Array<{ method: string; data?: string; to?: number; from?: number; target?: string; subcalls?: number }> = []
  const single = (data: string): { result: string | null; error: string | null } => {
    const sel = data.slice(0, 10)
    const id = BigInt(`0x${data.slice(10)}`).toString()
    const p = opts.positions[id]
    if (sel === SEL_GET_POOL_AND_POSITION_INFO) {
      if (!p || p.key === 'burned') return { result: `0x${'0'.repeat(64 * 6)}`, error: null }
      return { result: `${p.key ?? POOL_KEY}${w(BigInt(1))}`, error: null }
    }
    if (sel === SEL_GET_POSITION_LIQUIDITY) return { result: `0x${w(p && p.key !== 'burned' ? p.liquidity : BigInt(0))}`, error: null }
    if (sel === SEL_OWNER_OF) {
      if (opts.malformedOwnerFor?.includes(id)) return { result: '0xdeadbeef', error: null }
      return p?.owner ? { result: pad(p.owner), error: null } : { result: null, error: 'execution reverted: NOT_MINTED' }
    }
    return { result: null, error: 'unknown selector' }
  }
  const rpc: V4IndexRpc = async (method, params) => {
    if (method === 'eth_blockNumber') { calls.push({ method }); return { result: `0x${LATEST.toString(16)}`, error: null } }
    if (method === 'eth_getLogs') {
      const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string; address: string }
      const from = Number(BigInt(f.fromBlock))
      const to = Number(BigInt(f.toBlock))
      calls.push({ method, from, to })
      if (f.topics[0] === INITIALIZE_TOPIC0) {
        return { result: opts.initFound === false ? [] : [{ address: BASE_V4_POOL_MANAGER, topics: [INITIALIZE_TOPIC0, POOL_ID], data: '0x', blockNumber: `0x${INIT.toString(16)}` }], error: null }
      }
      if (opts.failLogs) return { result: null, error: opts.failLogs }
      if (opts.maxRange != null && to - from + 1 > opts.maxRange) return { result: null, error: 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range' }
      return { result: opts.logs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to && l.topics[1] === f.topics[1] }), error: null }
    }
    const { to, data } = params[0] as { to: string; data: string }
    if (to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: data as Hex })
      const sub = args[0] as ReadonlyArray<{ target: string; allowFailure: boolean; callData: string }>
      calls.push({ method: 'multicall', subcalls: sub.length })
      assert.ok(sub.every((c) => c.allowFailure === true && c.target.toLowerCase() === BASE_V4_POSITION_MANAGER), 'every sub-call targets PositionManager with allowFailure')
      if (opts.multicall === 'error') return { result: null, error: 'execution reverted' }
      if (opts.multicall === 'garbage') return { result: '0x1234', error: null }
      const results = sub.map((c) => { const r = single(c.callData); return r.error ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: r.result as Hex } })
      return { result: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as never }), error: null }
    }
    calls.push({ method, data, target: to })
    return single(data)
  }
  return { rpc, calls }
}
const run = (f: ReturnType<typeof fakeRpc>, now?: () => number) => resolveBaseV4PositionIndex({ poolId: POOL_ID }, { rpc: f.rpc, ...(now ? { now } : {}) })
beforeEach(() => resetV4PositionIndexCache())

test('1. exact Base V4 PositionManager / PoolManager, matching the repo and Uniswap deployments/8453.md', () => {
  assert.equal(BASE_V4_POSITION_MANAGER, '0x7c5f5a4bbd8fd63184577525326123b519429bdc')
  assert.equal(BASE_V4_POOL_MANAGER, '0x498581ff718922c3f8e6a244956af099b2652b2b')
  assert.match(read('lib/server/lpProof.ts'), /base: "0x7c5f5a4bbd8fd63184577525326123b519429bdc"/)
  assert.match(read('lib/server/concentratedLpPositions.ts'), /8453: "0x7c5f5a4bbd8fd63184577525326123b519429bdc"/)
  assert.equal(poolIdFromPositionInfo(`${POOL_KEY}${w(BigInt(1))}`), POOL_ID, 'PoolId = keccak256(abi.encode(poolKey))')
})

test('2/4/7/12. tokenIds from PoolId-exact logs, PoolId proven, ownerOf owners aggregated; creation reached => verified', async () => {
  const f = fakeRpc({
    positions: { 11: { owner: ALICE, liquidity: BigInt(600) }, 12: { owner: ALICE, liquidity: BigInt(200) }, 13: { owner: BOB, liquidity: BigInt(200) } },
    logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(11), BigInt(600), INIT + 10), mlLog(BASE_V4_POSITION_MANAGER, BigInt(12), BigInt(200), INIT + 20), mlLog(BASE_V4_POSITION_MANAGER, BigInt(13), BigInt(200), LATEST - 5)],
  })
  const r = await run(f)
  assert.equal(r.status, 'verified', r.publicText)
  assert.deepEqual(r.owners.map((o) => [o.owner, o.activePositions, o.liquidityRaw, o.sharePct]), [[ALICE, 2, '800', 80], [BOB, 1, '200', 20]])
  assert.deepEqual([r.ownerCount, r.activePositions, r.totalActiveLiquidity, r.topOwnerSharePct], [2, 3, '1000', 80])
  assert.equal(r.controlSummary, 'One wallet controls 80% of active V4 position liquidity')
  assert.deepEqual([r.coverage.reachedPoolCreation, r.coverage.initializeBlock, r.coverage.truncated, r.coverage.pages], [true, INIT, false, 1])
  assert.match(r.publicText, /^Position ownership verified — 3 active V4 position NFTs across 2 owners, indexed from pool creation\.$/)
})

test('3/5/6. other-pool, burned and zero-liquidity positions are rejected; never owners', async () => {
  const f = fakeRpc({
    positions: { 21: { owner: CAROL, liquidity: BigInt(500), key: OTHER_KEY }, 22: { owner: null, liquidity: BigInt(0), key: 'burned' }, 23: { owner: BOB, liquidity: BigInt(0) }, 24: { owner: ALICE, liquidity: BigInt(100) } },
    logs: [21, 22, 23, 24].map((id, i) => mlLog(BASE_V4_POSITION_MANAGER, BigInt(id), BigInt(100), INIT + i + 1)),
  })
  const r = await run(f)
  assert.deepEqual(r.owners.map((o) => o.owner), [ALICE])
  assert.deepEqual(r.coverage.rejected, { otherPool: 1, burned: 1, zeroLiquidity: 1, ownerUnresolved: 0, readFailed: 0, malformed: 0 })
  assert.equal(r.status, 'verified')
  // Zero-liquidity BOB still has an ownerOf result in the batch — it is never promoted to an owner.
  assert.ok(!r.owners.some((o) => o.owner === BOB || o.owner === CAROL))
  assert.deepEqual(f.calls.filter((c) => c.method === 'multicall').map((c) => c.subcalls), [12], 'one batch: 4 candidates x 3 reads')
})

test('8. multiple owners: concentration top 1 / top 3 / top 5 from real current liquidity', async () => {
  const owners = ['a', 'b', 'c', 'd', 'e', 'f'].map((ch) => `0x${ch.repeat(40)}`)
  const liq = [40, 20, 15, 10, 10, 5]
  const positions: Record<string, Pos> = {}
  const logs = owners.map((o, i) => { positions[String(100 + i)] = { owner: o, liquidity: BigInt(liq[i]) }; return mlLog(BASE_V4_POSITION_MANAGER, BigInt(100 + i), BigInt(liq[i]), INIT + i + 1) })
  const r = await run(fakeRpc({ positions, logs }))
  assert.deepEqual([r.ownerCount, r.topOwnerSharePct, r.top3SharePct, r.top5SharePct], [6, 40, 75, 95])
  assert.equal(r.controlSummary, 'Top 3 owners control 75% of active V4 position liquidity')
})

test('9/10. router and PositionManager senders are never owners; router liquidity keeps coverage partial', async () => {
  const f = fakeRpc({
    positions: { 31: { owner: ALICE, liquidity: BigInt(100) } },
    logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(31), BigInt(100), INIT + 1), mlLog(ROUTER, BigInt(0), BigInt(9_999), INIT + 2)],
  })
  const r = await run(f)
  const owners = r.owners.map((o) => o.owner)
  assert.ok(!owners.includes(ROUTER) && !owners.includes(BASE_V4_POSITION_MANAGER))
  assert.deepEqual(owners, [ALICE])
  assert.equal(r.status, 'partial')
  assert.match(r.publicText, /some liquidity was added outside PositionManager NFTs and has no attributable owner/)
  assert.deepEqual(r.coverage.otherSenderActivity, { senders: 1, netPositiveLiquidity: true })
  // Only router activity, no NFTs: activity is reported, owner stays unresolved.
  resetV4PositionIndexCache()
  const onlyRouter = await run(fakeRpc({ positions: {}, logs: [mlLog(ROUTER, BigInt(0), BigInt(10), INIT + 2)] }))
  assert.deepEqual([onlyRouter.status, onlyRouter.reason, onlyRouter.owners.length], ['unavailable_with_reason', 'activity_not_via_position_manager', 0])
  assert.match(onlyRouter.publicText, /liquidity activity was found, but not through the Uniswap V4 PositionManager/)
})

test('11. Initialize not found => pool creation not proven => partial, never verified', async () => {
  const r = await run(fakeRpc({ initFound: false, positions: { 41: { owner: ALICE, liquidity: BigInt(1) } }, logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(41), BigInt(1), LATEST - 100)] }))
  assert.equal(r.status, 'partial')
  assert.equal(r.coverage.reachedPoolCreation, false)
  assert.match(r.publicText, /^Position ownership partial — 1 active V4 position NFT resolved across 1 owner; older position history was not fully indexed\.$/)
})

test('13. "range too large" responses page with smaller windows back to creation (<= 6 pages)', async () => {
  const f = fakeRpc({ maxRange: 1_000_000, positions: { 51: { owner: BOB, liquidity: BigInt(7) } }, logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(51), BigInt(7), LATEST - 5)] })
  const r = await run(f)
  const pages = f.calls.filter((c) => c.method === 'eth_getLogs' && c.from != null && c.from > 0)
  assert.ok(pages.length <= V4_INDEX_MAX_LOG_PAGES)
  assert.ok(pages.slice(1).every((c) => c.to! - c.from! + 1 <= 1_000_000), 'windows shrank after the range error')
  // 5M-block history in <= 1M windows needs more than the page cap: honest partial, still real owners.
  assert.equal(r.status, 'partial')
  assert.equal(r.coverage.reachedPoolCreation, false)
})

test('14. RPC failure / timeout => unavailable_with_reason with the exact reason', async () => {
  const r = await run(fakeRpc({ failLogs: 'upstream connect error', positions: {}, logs: [] }))
  assert.deepEqual([r.status, r.reason], ['unavailable_with_reason', 'log_query_failed'])
  assert.match(r.publicText, /beneficial V4 position owners could not be verified from the indexed range/)
  resetV4PositionIndexCache()
  let t = 0
  const f = fakeRpc({ positions: {}, logs: [] })
  const slow: V4IndexRpc = async (m, p, ms) => { if (m === 'eth_getLogs') t += V4_INDEX_DEADLINE_MS + 1; return f.rpc(m, p, ms) }
  const d = await resolveBaseV4PositionIndex({ poolId: POOL_ID }, { rpc: slow, now: () => t })
  assert.deepEqual([d.status, d.reason], ['unavailable_with_reason', 'deadline_exceeded'])
})

test('15. no active NFTs => honest no-active-position result (not "not found in indexed window")', async () => {
  const r = await run(fakeRpc({ positions: { 61: { owner: ALICE, liquidity: BigInt(0) } }, logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(61), BigInt(5), LATEST - 1)] }))
  assert.deepEqual([r.status, r.reason], ['unavailable_with_reason', 'no_active_position_nfts'])
  assert.match(r.publicText, /1 V4 position NFT\(s\) were found, but none currently holds liquidity/)
  resetV4PositionIndexCache()
  const none = await run(fakeRpc({ positions: {}, logs: [] }))
  assert.deepEqual([none.reason, none.publicText], ['no_position_nfts_found', 'Position ownership unavailable — no Uniswap V4 position NFTs were found for this pool since its creation.'])
  // A position closed within fully indexed history is never read at all.
  resetV4PositionIndexCache()
  const f = fakeRpc({ positions: { 62: { owner: ALICE, liquidity: BigInt(0) } }, logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(62), BigInt(5), INIT + 1), mlLog(BASE_V4_POSITION_MANAGER, BigInt(62), BigInt(-5), INIT + 2)] })
  await run(f)
  assert.equal(f.calls.filter((c) => c.method === 'eth_call').length, 0)
})

test('16/17. cache reuse (0 calls) and hard caps: <= 25 candidates, <= 75 reads, truncation => partial', async () => {
  const positions: Record<string, Pos> = {}
  const logs = []
  for (let i = 0; i < 40; i++) { positions[String(1000 + i)] = { owner: i % 2 ? ALICE : BOB, liquidity: BigInt(10 + i) }; logs.push(mlLog(BASE_V4_POSITION_MANAGER, BigInt(1000 + i), BigInt(10 + i), INIT + i + 1)) }
  const f = fakeRpc({ positions, logs })
  const cold = await run(f)
  assert.equal(cold.coverage.candidatesRead, V4_INDEX_MAX_CANDIDATES)
  assert.equal(f.calls.filter((c) => c.method === 'eth_call').length, 0, 'no individual eth_calls on the batched path')
  assert.deepEqual([cold.status, cold.coverage.truncated], ['partial', true])
  assert.match(cold.publicText, /only the 25 most recent candidate positions were read/)
  // cold = blockNumber + Initialize + 1 page + ONE Multicall3 (25 x info + liquidity + ownerOf inside)
  assert.equal(cold.calls, 4)
  assert.equal(f.calls.length, 4)
  assert.deepEqual(cold.requests, { network: 4, logRequests: 3, logPages: 1, multicallBatches: 1, multicallSubcalls: V4_INDEX_MAX_POSITION_READS, fallbackCalls: 0, rpcLogicalReads: 3 + V4_INDEX_MAX_POSITION_READS, controllerRequests: 0 })
  const warm = await run(f)
  assert.deepEqual([warm.calls, warm.requests.network, warm.cache.state], [0, 0, true])
  assert.equal(f.calls.length, 4, 'warm: zero new requests')
})

test('lpProof: partial index => partial (never verified); verified index => verified; exact reasons reach the audit', async () => {
  const mk = (index: Awaited<ReturnType<typeof run>>) => async (): Promise<ConcentratedOwnerLookupResult> => ({
    records: index.owners.length ? index.owners.map((o) => ({ address: o.owner, liquidityRaw: o.liquidityRaw, positionCount: o.activePositions, ownerType: 'wallet' as const })) : null,
    attempted: true, providerUsed: 'base_rpc_uniswap_v4_position_nft', positionsFound: index.coverage.candidateTokenIds, activePositionsFound: index.activePositions, failureReason: index.owners.length ? null : index.publicText, v4PositionIndex: index,
  })
  const partialIndex = await run(fakeRpc({ initFound: false, positions: { 71: { owner: ALICE, liquidity: BigInt(9) } }, logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(71), BigInt(9), LATEST - 3)] }))
  const p = await attemptConcentratedPositionProof('base', POOL_ID, POOL_ID, 'pool_id', 'uniswap_v4', mk(partialIndex))
  assert.equal(p.status, 'partial')
  assert.equal(p.concentratedLpPositionAudit?.finalStatus, 'partial_position_owner')
  assert.match(String(p.concentratedLpPositionAudit?.failureReason), /^Position ownership partial —/)
  resetV4PositionIndexCache()
  const verifiedIndex = await run(fakeRpc({ positions: { 72: { owner: BOB, liquidity: BigInt(9) } }, logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(72), BigInt(9), INIT + 3)] }))
  const v = await attemptConcentratedPositionProof('base', POOL_ID, POOL_ID, 'pool_id', 'uniswap_v4', mk(verifiedIndex))
  assert.deepEqual([v.status, v.topPositionOwner, v.topPositionSharePercent, v.concentratedLpPositionAudit?.finalStatus], ['verified', BOB, 100, 'verified_position_owner'])
  resetV4PositionIndexCache()
  const failedIndex = await run(fakeRpc({ failLogs: 'boom', positions: {}, logs: [] }))
  // A different pool: lpProof deliberately restores a fresh VERIFIED result for the same pool on a later failure.
  const OTHER_POOL = `0x${'ab'.repeat(32)}`
  const x = await attemptConcentratedPositionProof('base', OTHER_POOL, OTHER_POOL, 'pool_id', 'uniswap_v4', mk(failedIndex))
  assert.deepEqual([x.status, x.concentratedLpPositionAudit?.finalStatus], ['failed', 'position_index_unavailable_with_reason'])
  assert.doesNotMatch(x.reason, /indexed window/)
})

test('stage-1 log index: Uniswap V4 never turns ModifyLiquidity senders into owners, and makes no RPC call', async () => {
  for (const chainId of [8453, 1, 56]) {
    let rpcCalls = 0
    const r = await resolveConcentratedLpPositions({ chainId, tokenAddress: null, poolAddress: POOL_ID, protocol: 'uniswap_v4', poolType: 'uniswap_v4' }, { call: async () => { rpcCalls++; return { result: [] } } })
    assert.deepEqual([r.owners.length, rpcCalls, r.audit.finalStatus, r.audit.failureReason], [0, 0, 'position_index_unavailable_with_reason', V4_SENDER_NOT_OWNER_REASON])
  }
})

test('18-21. resolver scope: only Base Uniswap V4; V3 / Slipstream / Robinhood / BNB untouched', async () => {
  for (const [chain, poolModel] of [['base', 'uniswap_v3'], ['base', 'slipstream'], ['robinhood', 'uniswap_v4'], ['bnb', 'uniswap_v4'], ['bnb', 'pancakeswap_v3'], ['eth', 'uniswap_v4']] as const) {
    assert.equal(await resolveUniswapV4BaseRpc({ chain, poolModel, poolAddress: null, poolId: POOL_ID }), null, `${chain}/${poolModel}`)
  }
  const route = read('app/api/token/route.ts')
  assert.match(route, /const v4Rpc = await resolveUniswapV4RobinhoodRpc\(input\)[\s\S]*const v4BaseRpc = await resolveUniswapV4BaseRpc\(input\)[\s\S]*const slipstreamRpc = await resolveAerodromeSlipstreamPoolRpc\(input\)[\s\S]*return resolveUniswapV3PositionOwners\(input\)/)
  assert.doesNotMatch(read('lib/server/uniswapV4BaseRpc.ts'), /fromBlock: '0x0',\s*toBlock: 'latest'/, 'no single unbounded 0x0..latest ownership scan')
})

test('UI copy: V4 index text drives Position Ownership / LP Control; no "indexed window" for V4; lock/burn unchanged', () => {
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /function v4PositionIndexView\(/)
  assert.match(page, /const v4 = audit\?\.v4PositionIndex/)
  assert.match(page, /lpControlValue: v4\.controlSummary \? `\$\{verified \? '' : 'Partial — '\}\$\{v4\.controlSummary\}`/)
  assert.match(page, /Owner unavailable — beneficial V4 position owners unresolved/)
  assert.match(read('lib/server/concentratedLpPositions.ts'), /CONCENTRATED_ERC20_LOCK_BURN_LABEL = "Not applicable — concentrated LP has no ERC20 LP token\."/)
})

// ---- Multicall3 request-cost tests -------------------------------------------------------------------

const manyPositions = (n: number, owner: (i: number) => string | null = (i) => (i % 2 ? ALICE : BOB), start = 2000) => {
  const positions: Record<string, Pos> = {}
  const logs: ReturnType<typeof mlLog>[] = []
  for (let i = 0; i < n; i++) { positions[String(start + i)] = { owner: owner(i), liquidity: BigInt(10 + i) }; logs.push(mlLog(BASE_V4_POSITION_MANAGER, BigInt(start + i), BigInt(10 + i), INIT + i + 1)) }
  return { positions, logs }
}

test('MC-0. Multicall3 address/ABI are the ones basedex.ts already uses (no new contract address)', () => {
  const basedex = read('src/modules/pricingAtTimeEngine/sources/basedex.ts')
  assert.match(basedex, new RegExp(`const MULTICALL3_ADDRESS = '${MULTICALL3_ADDRESS}' as const`))
  assert.match(basedex, /name: 'aggregate3',[\s\S]*name: 'allowFailure', type: 'bool'/)
  assert.equal(MULTICALL3_ADDRESS, '0xcA11bde05977b3631167028862bE2a173976CA11')
})

test('MC-1. 25 candidates => ONE aggregate3 with 75 sub-calls; 4 network requests, 78 logical reads; exactly 25 => verified', async () => {
  const f = fakeRpc(manyPositions(V4_INDEX_MAX_CANDIDATES))
  const r = await run(f)
  assert.deepEqual(f.calls.map((c) => c.method), ['eth_blockNumber', 'eth_getLogs', 'eth_getLogs', 'multicall'])
  assert.deepEqual(f.calls.filter((c) => c.method === 'multicall').map((c) => c.subcalls), [75])
  assert.deepEqual([r.requests.network, r.requests.multicallSubcalls, r.requests.rpcLogicalReads, r.calls], [4, 75, 78, 4])
  assert.deepEqual([r.status, r.activePositions, r.ownerCount, r.coverage.truncated], ['verified', 25, 2, false])
})

test('MC-2. one reverting ownerOf / one malformed result never fails the other candidates; coverage becomes partial', async () => {
  const { positions, logs } = manyPositions(5, (i) => (i === 2 ? null : ALICE))
  const r = await run(fakeRpc({ positions, logs }))
  assert.deepEqual([r.activePositions, r.coverage.rejected.ownerUnresolved, r.status], [4, 1, 'partial'])
  assert.match(r.publicText, /1 position read\(s\) failed/)
  resetV4PositionIndexCache()
  const m = await run(fakeRpc({ ...manyPositions(3, () => BOB), malformedOwnerFor: ['2001'] }))
  assert.deepEqual([m.activePositions, m.coverage.rejected.malformed, m.status], [2, 1, 'partial'])
  assert.ok(!m.owners.some((o) => !/^0x[0-9a-f]{40}$/.test(o.owner)))
})

test('MC-3. aggregation: many positions of one owner collapse; multiple owners keep concentration', async () => {
  const r = await run(fakeRpc(manyPositions(6, (i) => (i < 4 ? CAROL : ALICE))))
  // CAROL: 10+11+12+13 = 46; ALICE: 14+15 = 29
  assert.deepEqual(r.owners.map((o) => [o.owner, o.activePositions, o.liquidityRaw]), [[CAROL, 4, '46'], [ALICE, 2, '29']])
  assert.equal(r.topOwnerSharePct, 61.3333)
})

test('MC-4. Multicall3 failure => bounded fallback (<= 2 candidates, <= 6 eth_calls), coverage partial, never a fan-out', async () => {
  for (const mode of ['error', 'garbage'] as const) {
    resetV4PositionIndexCache()
    const f = fakeRpc({ ...manyPositions(V4_INDEX_MAX_CANDIDATES), multicall: mode })
    const r = await run(f)
    const individual = f.calls.filter((c) => c.method === 'eth_call')
    assert.ok(individual.length <= V4_FALLBACK_MAX_REQUESTS, `${mode}: ${individual.length} fallback calls`)
    assert.equal(individual.length, V4_FALLBACK_MAX_CANDIDATES * 3)
    assert.ok(individual.every((c) => c.target === BASE_V4_POSITION_MANAGER))
    assert.deepEqual([r.coverage.multicall.failed, r.coverage.multicall.fallbackCandidates, r.coverage.multicall.unreadCandidates], [true, 2, 23])
    assert.deepEqual([r.status, r.activePositions, r.coverage.candidatesRead], ['partial', 2, 2])
    assert.match(r.publicText, /the batched position read failed, so only 2 of 25 candidate positions were read individually/)
    assert.equal(r.calls, 3 + 1 + 6)
    assert.ok(r.calls <= V4_INDEX_MAX_NETWORK_REQUESTS)
    assert.equal(r.requests.fallbackCalls, 6)
  }
  // Even when the fallback read EVERY candidate, a failed batch is never promoted to verified.
  resetV4PositionIndexCache()
  const one = await run(fakeRpc({ ...manyPositions(1), multicall: 'error' }))
  assert.deepEqual([one.status, one.activePositions], ['partial', 1])
})

test('MC-5. absolute ceiling: shrinking log pages + failed multicall stay <= V4_INDEX_MAX_NETWORK_REQUESTS', async () => {
  const { positions } = manyPositions(25)
  const logs = Object.keys(positions).map((id, i) => mlLog(BASE_V4_POSITION_MANAGER, BigInt(id), BigInt(5), LATEST - 10 - i))
  const f = fakeRpc({ positions, logs, maxRange: 1_000_000, multicall: 'error' })
  const r = await run(f)
  assert.ok(f.calls.length <= V4_INDEX_MAX_NETWORK_REQUESTS, `${f.calls.length} requests`)
  assert.equal(r.calls, f.calls.length)
  assert.equal(V4_INDEX_MAX_NETWORK_REQUESTS, 15)
  assert.equal(r.status, 'partial')
})

test('MC-6. index cache hit => only the multicall; tokenId->PoolId cache drops the info sub-calls and skips other-pool ids', async () => {
  let t = 1_000
  const now = () => t
  const f = fakeRpc({
    positions: { 81: { owner: ALICE, liquidity: BigInt(5) }, 82: { owner: BOB, liquidity: BigInt(5), key: OTHER_KEY } },
    logs: [mlLog(BASE_V4_POSITION_MANAGER, BigInt(81), BigInt(5), INIT + 1), mlLog(BASE_V4_POSITION_MANAGER, BigInt(82), BigInt(5), INIT + 2)],
  })
  const cold = await run(f, now)
  assert.equal(cold.calls, 4)
  t += 3 * 60_000 // state (2 min) expired; index (10 min) and tokenId->PoolId (24h) still warm
  const n = f.calls.length
  const warmish = await run(f, now)
  assert.deepEqual(f.calls.slice(n).map((c) => [c.method, c.subcalls]), [['multicall', 2]], 'one batch: liquidity + ownerOf for 81 only')
  assert.deepEqual([warmish.calls, warmish.cache.index, warmish.status, warmish.coverage.rejected.otherPool], [1, true, 'verified', 1])
})

test('MC-7. cache keys carry chain + PositionManager + PoolId / tokenId', () => {
  const src = read('lib/server/uniswapV4BasePositions.ts')
  assert.match(src, /const poolKey = \(poolId: string\) => `base:\$\{BASE_V4_POSITION_MANAGER\}:\$\{poolId\}`/)
  assert.match(src, /const tokenKey = \(tokenId: bigint\) => `base:\$\{BASE_V4_POSITION_MANAGER\}:\$\{tokenId\.toString\(\)\}`/)
  assert.doesNotMatch(src, /mapLimit|READ_CONCURRENCY/, 'no per-candidate eth_call fan-out remains')
})
