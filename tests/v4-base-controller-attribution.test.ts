// Base Uniswap V4 liquidity-controller attribution for activity OUTSIDE the canonical PositionManager
// (lib/server/uniswapV4BaseControllers.ts, run from lib/server/uniswapV4BasePositions.ts). A fake Base RPC
// serves the pool's Initialize + ModifyLiquidity logs, eth_getCode and Multicall3 control reads, ABI-encoded
// as the chain returns them. Wallet / contract / pool values are fixtures; Uniswap manager / router
// addresses are the official Base deployments.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, toFunctionSelector, type Hex } from 'viem'
import {
  BASE_V4_POOL_MANAGER,
  BASE_V4_POSITION_MANAGER,
  INITIALIZE_TOPIC0,
  MODIFY_LIQUIDITY_TOPIC0,
  SEL_GET_POOL_AND_POSITION_INFO,
  SEL_GET_POSITION_LIQUIDITY,
  SEL_OWNER_OF,
  V4_INDEX_MAX_NETWORK_REQUESTS,
  V4_TOTAL_MAX_NETWORK_REQUESTS,
  hookFromInitialize,
  resetV4PositionIndexCache,
  resolveBaseV4PositionIndex,
  type V4IndexRpc,
} from '../lib/server/uniswapV4BasePositions.ts'
import {
  BASE_UNISWAP_OFFICIAL_CONTRACTS,
  SEL_ADMIN, SEL_GET_OWNER, SEL_GET_OWNERS, SEL_GET_THRESHOLD, SEL_MASTER_COPY, SEL_OWNER,
  V4_CONTROLLER_MAX_CODE_READS,
  V4_CONTROLLER_MAX_REQUESTS,
  classifyCode,
  decodeAddressArray,
  resetV4ControllerCache,
} from '../lib/server/uniswapV4BaseControllers.ts'
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from '../lib/server/multicall3.ts'
import { knownDexRouterProtocol } from '../src/lib/knownDexRouters.ts'
import { resolveUniswapV4BaseRpc } from '../lib/server/uniswapV4BaseRpc.ts'
import { attemptConcentratedPositionProof, type ConcentratedOwnerLookupResult } from '../lib/server/lpProof.ts'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const TOKEN_A = '0x1111111111111111111111111111111111111111'
const TOKEN_B = '0x2222222222222222222222222222222222222222'
const HOOK = '0x00000000000000000000000000000000000a0c00'
const keyFor = (hooks: string) => encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [TOKEN_A, TOKEN_B, 3000, 60, hooks as Hex])
const POOL_ID = keccak256(keyFor(HOOK)).toLowerCase()
const ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43' // Uniswap UniversalRouter v2.0 (deployments/8453.md)
const EOA1 = '0x000000000000000000000000000000000000e0a1'
const EOA2 = '0x000000000000000000000000000000000000e0a2'
const UNKNOWN = '0x0000000000000000000000000000000000c0de01'
const OWNED = '0x0000000000000000000000000000000000c0de02'
const SAFE = '0x0000000000000000000000000000000000005afe'
const BADOWNER = '0x0000000000000000000000000000000000c0de03'
const DELEGATED = '0x0000000000000000000000000000000000007702'
const S1 = '0x00000000000000000000000000000000000051a1'
const S2 = '0x00000000000000000000000000000000000051a2'
const S3 = '0x00000000000000000000000000000000000051a3'
const LATEST = 30_000_000
const INIT = 25_000_000
const w = (n: bigint) => (n < BigInt(0) ? (BigInt(1) << BigInt(256)) + n : n).toString(16).padStart(64, '0')
const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}`

const CODE: Record<string, string> = {
  [EOA1]: '0x', [EOA2]: '0x', [S1]: '0x', [S2]: '0x', [S3]: '0x',
  [UNKNOWN]: '0x6080604052348015600f57600080fd5b50',
  [OWNED]: `0x608060405234801561001057600080fd5b5060${'63'}${SEL_OWNER.slice(2)}14610030575b`,
  [BADOWNER]: `0x6080604052${'63'}${SEL_OWNER.slice(2)}1461`,
  [SAFE]: `0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167f${SEL_MASTER_COPY.slice(2)}${'0'.repeat(56)}600035141560`,
  [DELEGATED]: `0xef0100${'ab'.repeat(20)}`,
  [HOOK]: '0x60806040', [ROUTER]: '0x60806040',
}
const CONTROL: Record<string, Record<string, string>> = {
  [OWNED]: { [SEL_OWNER]: pad(EOA2) },
  [BADOWNER]: { [SEL_OWNER]: '0x1234' },
  [SAFE]: {
    [SEL_GET_OWNERS]: encodeAbiParameters([{ type: 'address[]' }], [[S1, S2, S3] as Hex[]]),
    [SEL_GET_THRESHOLD]: `0x${w(BigInt(2))}`,
  },
}

let txn = 0
function ml(sender: string, delta: bigint, block: number, salt = BigInt(0)) {
  txn++
  return { address: BASE_V4_POOL_MANAGER, topics: [MODIFY_LIQUIDITY_TOPIC0, POOL_ID, pad(sender)], data: `0x${w(BigInt(-60))}${w(BigInt(60))}${w(delta)}${w(salt)}`, blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${txn.toString(16).padStart(64, '0')}`, removed: false }
}
const initLog = (hooks = HOOK) => ({
  address: BASE_V4_POOL_MANAGER, topics: [INITIALIZE_TOPIC0, POOL_ID, pad(TOKEN_A), pad(TOKEN_B)],
  data: `0x${w(BigInt(3000))}${w(BigInt(60))}${pad(hooks).slice(2)}${w(BigInt(1) << BigInt(96))}${w(BigInt(0))}`,
  blockNumber: `0x${INIT.toString(16)}`, removed: false,
})

function fakeRpc(opts: { logs: ReturnType<typeof ml>[]; positions?: Record<string, { owner: string; liquidity: bigint }>; code?: Record<string, string>; multicall?: 'ok' | 'error' }) {
  const calls: Array<{ method: string; target?: string; subcalls?: number }> = []
  const code = { ...CODE, ...(opts.code ?? {}) }
  const pmSingle = (data: string): { ok: boolean; hex: string } => {
    const sel = data.slice(0, 10)
    const p = opts.positions?.[BigInt(`0x${data.slice(10)}`).toString()]
    if (sel === SEL_GET_POOL_AND_POSITION_INFO) return { ok: true, hex: p ? `${keyFor(HOOK)}${w(BigInt(1))}` : `0x${'0'.repeat(384)}` }
    if (sel === SEL_GET_POSITION_LIQUIDITY) return { ok: true, hex: `0x${w(p?.liquidity ?? BigInt(0))}` }
    if (sel === SEL_OWNER_OF) return p ? { ok: true, hex: pad(p.owner) } : { ok: false, hex: '0x' }
    return { ok: false, hex: '0x' }
  }
  const rpc: V4IndexRpc = async (method, params) => {
    if (method === 'eth_blockNumber') { calls.push({ method }); return { result: `0x${LATEST.toString(16)}`, error: null } }
    if (method === 'eth_getLogs') {
      calls.push({ method })
      const f = params[0] as { topics: string[] }
      if (f.topics[0] === INITIALIZE_TOPIC0) return { result: [initLog()], error: null }
      return { result: opts.logs, error: null }
    }
    if (method === 'eth_getCode') {
      const a = String(params[0]).toLowerCase()
      calls.push({ method, target: a })
      return { result: code[a] ?? '0x6080', error: null }
    }
    const { to, data } = params[0] as { to: string; data: string }
    assert.equal(to.toLowerCase(), MULTICALL3_ADDRESS.toLowerCase(), 'every eth_call goes through Multicall3')
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: data as Hex })
    const sub = args[0] as ReadonlyArray<{ target: string; allowFailure: boolean; callData: string }>
    calls.push({ method: 'multicall', subcalls: sub.length })
    if (opts.multicall === 'error') return { result: null, error: 'execution reverted' }
    const results = sub.map((c) => {
      const t = c.target.toLowerCase()
      if (t === BASE_V4_POSITION_MANAGER) { const r = pmSingle(c.callData); return { success: r.ok, returnData: r.hex as Hex } }
      const hex = CONTROL[t]?.[c.callData.slice(0, 10)]
      return hex ? { success: true, returnData: hex as Hex } : { success: false, returnData: '0x' as Hex }
    })
    return { result: encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: [results] as never }), error: null }
  }
  return { rpc, calls }
}
const run = (f: ReturnType<typeof fakeRpc>, now?: () => number) => resolveBaseV4PositionIndex({ poolId: POOL_ID }, { rpc: f.rpc, ...(now ? { now } : {}) })
const ctl = (r: Awaited<ReturnType<typeof run>>, a: string) => r.controllerAttribution!.controllers.find((c) => c.address === a)!
beforeEach(() => { resetV4PositionIndexCache(); resetV4ControllerCache() })

test('0. selectors are the real ABI selectors; registry entries come from the official Base deployments', () => {
  assert.deepEqual([SEL_OWNER, SEL_GET_OWNER, SEL_ADMIN, SEL_GET_OWNERS, SEL_GET_THRESHOLD, SEL_MASTER_COPY],
    ['owner()', 'getOwner()', 'admin()', 'getOwners()', 'getThreshold()', 'masterCopy()'].map((s) => toFunctionSelector(s)))
  assert.equal(BASE_UNISWAP_OFFICIAL_CONTRACTS[BASE_V4_POSITION_MANAGER]?.type, 'position_manager')
  assert.equal(BASE_UNISWAP_OFFICIAL_CONTRACTS[ROUTER]?.type, 'router')
  assert.ok(Object.keys(BASE_UNISWAP_OFFICIAL_CONTRACTS).every((a) => /^0x[0-9a-f]{40}$/.test(a)))
  // Shared router registry and the V4 controller registry agree on the canonical Permit2 (no …78ba9 typo).
  const permit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
  assert.equal(BASE_UNISWAP_OFFICIAL_CONTRACTS[permit2]?.label, 'Permit2')
  assert.equal(knownDexRouterProtocol(permit2), 'Permit2')
  assert.equal(knownDexRouterProtocol('0x000000000022d473030f116ddee9f6b43ac78ba9'), null)
  assert.equal(hookFromInitialize(initLog(), POOL_ID), HOOK, 'hook proven: Initialize PoolKey hashes to the PoolId')
  assert.equal(hookFromInitialize(initLog('0x00000000000000000000000000000000000bad00'), POOL_ID), null, 'a key that does not hash to the PoolId is rejected')
})

test('1/14. direct EOA modifier (no code) => direct controller of its activity; verified only with full coverage', async () => {
  const r = await run(fakeRpc({ logs: [ml(EOA1, BigInt(500), INIT + 1), ml(EOA1, BigInt(-100), INIT + 2)] }))
  const a = r.controllerAttribution!
  assert.deepEqual([r.status, r.reason, r.owners.length], ['unavailable_with_reason', 'activity_not_via_position_manager', 0], 'position ownership stays unavailable')
  const c = ctl(r, EOA1)
  assert.deepEqual([c.type, c.role, c.controllerAddress, c.activityCount, c.netLiquidityRaw, c.addEvents, c.removeEvents], ['eoa', 'direct_controller', EOA1, 2, '400', 1, 1])
  assert.equal(c.sampleTxs.length, 2)
  assert.equal(a.status, 'verified')
  assert.match(a.publicText, /not proof of owning all pool liquidity/)
  assert.equal(a.controllerSummary, '2 liquidity events from 1 wallet (EOA)')
})

test('2/18. canonical PositionManager sender stays on the NFT path (never a modifier row); NFT owners unchanged', async () => {
  const r = await run(fakeRpc({ logs: [ml(BASE_V4_POSITION_MANAGER, BigInt(10), INIT + 1, BigInt(7))], positions: { 7: { owner: EOA2, liquidity: BigInt(10) } } }))
  assert.equal(r.controllerAttribution, null)
  assert.deepEqual([r.status, r.owners.map((o) => o.owner)], ['verified', [EOA2]])
  assert.equal(r.requests.controllerRequests, 0)
})

test('3/8. known router => intermediary only, never a controller; all-router activity stays unavailable', async () => {
  const f = fakeRpc({ logs: [ml(ROUTER, BigInt(10), INIT + 1), ml(ROUTER, BigInt(5), INIT + 2)] })
  const r = await run(f)
  const c = ctl(r, ROUTER)
  assert.deepEqual([c.type, c.role, c.controllerAddress, c.label], ['router', 'intermediary', null, 'Uniswap UniversalRouter v2.0'])
  assert.ok(c.evidence.includes('known_protocol_registry'))
  assert.equal(r.controllerAttribution!.status, 'unavailable_with_reason')
  assert.equal(r.controllerAttribution!.publicText, 'Liquidity activity was routed through a periphery contract, but the final liquidity controller could not be verified.')
  assert.equal(f.calls.filter((x) => x.method === 'eth_getCode').length, 0, 'registry needs no RPC')
})

test('4/9. pool hook sender => hook, never owner; hook surfaced from the PoolKey', async () => {
  const r = await run(fakeRpc({ logs: [ml(HOOK, BigInt(10), INIT + 1)] }))
  const a = r.controllerAttribution!
  const c = ctl(r, HOOK)
  assert.deepEqual([c.type, c.role, c.controllerAddress], ['hook', 'hook', null])
  assert.ok(c.evidence.includes('pool_key_hook'))
  assert.deepEqual(a.hook, { address: HOOK, label: null, isModifier: true })
  assert.equal(r.hook, HOOK)
  assert.equal(a.status, 'unavailable_with_reason')
  assert.match(a.publicText, /^Hook-managed liquidity activity observed/)
})

test('5/15. unknown contract (code, no advertised control interface) => contract, controller unverified, no control reads', async () => {
  const f = fakeRpc({ logs: [ml(UNKNOWN, BigInt(10), INIT + 1)] })
  const r = await run(f)
  const c = ctl(r, UNKNOWN)
  assert.deepEqual([c.type, c.role, c.controllerAddress], ['contract', 'unverified', null])
  assert.equal(f.calls.filter((x) => x.method === 'multicall').length, 0, 'no selector spam: nothing advertised, nothing called')
  assert.equal(r.controllerAttribution!.publicText, 'Liquidity activity came from contract(s) whose controller could not be verified.')
})

test('6. contract advertising owner() -> EOA => "Contract controlled by X", never "X owns the LP"', async () => {
  const f = fakeRpc({ logs: [ml(OWNED, BigInt(10), INIT + 1)] })
  const r = await run(f)
  const c = ctl(r, OWNED)
  assert.deepEqual([c.type, c.role, c.controllerAddress, c.controllerType, c.controllerSource], ['contract', 'contract_controlled', EOA2, 'eoa', 'owner'])
  assert.ok(c.evidence.includes('verified_owner_read'))
  assert.match(c.reason, new RegExp(`^Contract controlled by ${EOA2} \\(owner\\(\\), a wallet\\) — control of the contract, not proof that this address owns the liquidity\\.$`))
  assert.doesNotMatch(JSON.stringify(r.controllerAttribution), /owns the LP|LP owner/)
  assert.deepEqual(f.calls.filter((x) => x.method === 'multicall').map((x) => x.subcalls), [1])
})

test('7. Safe-style multisig (proxy masterCopy dispatch + getOwners/getThreshold shape) => multisig, t of n signers', async () => {
  const r = await run(fakeRpc({ logs: [ml(SAFE, BigInt(10), INIT + 1)] }))
  const c = ctl(r, SAFE)
  assert.deepEqual([c.type, c.role, c.safe], ['multisig', 'contract_controlled', { owners: [S1, S2, S3], threshold: 2 }])
  assert.equal(classifyCode(CODE[UNKNOWN])!.safeLike, false)
  assert.equal(decodeAddressArray(`0x${w(BigInt(32))}${w(BigInt(0))}`), null, 'zero-owner array rejected')
})

test('10/11. multiple modifiers: activity concentration is labelled activity, never ownership', async () => {
  const logs = [...Array.from({ length: 8 }, (_, i) => ml(ROUTER, BigInt(10), INIT + 1 + i)), ml(EOA1, BigInt(1_000), INIT + 20), ml(EOA1, BigInt(-10), INIT + 21)]
  const r = await run(fakeRpc({ logs }))
  const a = r.controllerAttribution!
  assert.deepEqual([a.concentration.label, a.concentration.uniqueModifiers, a.concentration.eoaModifiers, a.concentration.intermediaryModifiers, a.concentration.topModifier, a.concentration.topModifierEventSharePct],
    ['Liquidity activity concentration', 2, 1, 1, ROUTER, 80])
  assert.equal(a.concentration.topModifierNetAddSharePct, 92.5233, 'EOA1 adds 990 of 1070 net positive')
  assert.equal(a.concentration.text, `80% of observed liquidity-change activity came from one intermediary address (0x6ff5…9b43).`)
  assert.equal(a.controllerSummary, '10 liquidity events from 1 router contract, 1 wallet (EOA)')
  assert.equal(a.status, 'partial', 'router activity stays unattributed')
  assert.equal(a.unattributedEvents, 8)
  assert.deepEqual([r.ownerCount, r.topOwnerSharePct], [0, null], 'activity share never becomes an ownership share')
})

test('12. net-negative modifier is kept as a negative net and never counted as an adder', async () => {
  const r = await run(fakeRpc({ logs: [ml(EOA1, BigInt(50), INIT + 1), ml(EOA2, BigInt(-200), INIT + 2), ml(EOA2, BigInt(20), INIT + 3)] }))
  assert.equal(ctl(r, EOA2).netLiquidityRaw, '-180')
  assert.equal(r.controllerAttribution!.concentration.topModifierNetAddSharePct, 100, 'only EOA1 has positive net')
})

test('13. malformed owner() return => controller stays unverified', async () => {
  const r = await run(fakeRpc({ logs: [ml(BADOWNER, BigInt(10), INIT + 1)] }))
  const c = ctl(r, BADOWNER)
  assert.deepEqual([c.role, c.controllerAddress], ['unverified', null])
})

test('EIP-7702 delegated wallet => smart_wallet direct controller', async () => {
  const r = await run(fakeRpc({ logs: [ml(DELEGATED, BigInt(10), INIT + 1)] }))
  assert.deepEqual([ctl(r, DELEGATED).type, ctl(r, DELEGATED).role], ['smart_wallet', 'direct_controller'])
})

test('16. call ceiling: many modifiers => <= 5 code reads, 1 multicall, <= 2 owner code reads; failed multicall never fans out', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `0x${(0xc0de10 + i).toString(16).padStart(40, '0')}`)
  const code: Record<string, string> = Object.fromEntries(many.map((a) => [a, `0x60${'63'}${SEL_OWNER.slice(2)}`]))
  for (const mode of ['ok', 'error'] as const) {
    resetV4PositionIndexCache(); resetV4ControllerCache()
    const f = fakeRpc({ logs: many.map((a, i) => ml(a, BigInt(1 + i), INIT + 1 + i)), code, multicall: mode })
    const r = await run(f)
    const req = r.controllerAttribution!.requests
    assert.ok(req.network <= V4_CONTROLLER_MAX_REQUESTS, `${mode}: ${req.network}`)
    assert.equal(req.codeReads, V4_CONTROLLER_MAX_CODE_READS)
    assert.equal(r.controllerAttribution!.coverage.unclassified, 12 - V4_CONTROLLER_MAX_CODE_READS)
    assert.ok(f.calls.length <= V4_TOTAL_MAX_NETWORK_REQUESTS)
    assert.equal(r.calls, f.calls.length)
    assert.equal(r.requests.controllerRequests, req.network)
    if (mode === 'error') assert.equal(r.controllerAttribution!.coverage.multicallFailed, true)
  }
  assert.equal(V4_CONTROLLER_MAX_REQUESTS, 8)
  assert.equal(V4_TOTAL_MAX_NETWORK_REQUESTS, V4_INDEX_MAX_NETWORK_REQUESTS + 8)
})

test('17. cache reuse: warm state 0 requests; re-index reuses code / control caches (no repeat reads)', async () => {
  let t = 1_000
  const now = () => t
  const f = fakeRpc({ logs: [ml(OWNED, BigInt(10), INIT + 1), ml(EOA1, BigInt(10), INIT + 2)] })
  const cold = await run(f, now)
  assert.equal(cold.requests.controllerRequests, 4, 'getCode x2 + multicall + owner getCode')
  const warm = await run(f, now)
  assert.equal(warm.calls, 0)
  t += 3 * 60_000 // state expired; index / code / control caches still warm
  const n = f.calls.length
  const again = await run(f, now)
  assert.deepEqual([again.calls, f.calls.length - n], [0, 0])
  assert.equal(ctl(again, OWNED).controllerAddress, EOA2)
})

test('lpProof: ownership stays unavailable (never promoted by controller attribution); attribution reaches the audit', async () => {
  const index = await run(fakeRpc({ logs: [ml(EOA1, BigInt(10), INIT + 1)] }))
  const lookup = async (): Promise<ConcentratedOwnerLookupResult> => ({ records: null, attempted: true, providerUsed: 'base_rpc_uniswap_v4_position_nft', positionsFound: 0, activePositionsFound: 0, failureReason: index.publicText, v4PositionIndex: index })
  const p = await attemptConcentratedPositionProof('base', POOL_ID, POOL_ID, 'pool_id', 'uniswap_v4', lookup)
  assert.notEqual(p.status, 'verified')
  assert.equal(p.topPositionOwner ?? null, null)
  assert.equal(p.concentratedLpPositionAudit?.v4PositionIndex?.controllerAttribution?.controllers[0].address, EOA1)
})

test('19-22. scope unchanged: only Base Uniswap V4 runs the index; V3 / Slipstream / Robinhood / ETH / BNB untouched', async () => {
  for (const [chain, poolModel] of [['base', 'uniswap_v3'], ['base', 'slipstream'], ['robinhood', 'uniswap_v4'], ['eth', 'uniswap_v4'], ['bnb', 'uniswap_v4'], ['bnb', 'pancakeswap_v3']] as const) {
    assert.equal(await resolveUniswapV4BaseRpc({ chain, poolModel, poolAddress: null, poolId: POOL_ID }), null, `${chain}/${poolModel}`)
  }
  assert.doesNotMatch(read('lib/server/uniswapV4BaseControllers.ts'), /alchemy|infura|quicknode|coingecko|geckoterminal/i, 'no provider names')
})

test('UI: Liquidity Controller / Controller Attribution / Observed Activity rows; activity labelled as activity', () => {
  const page = read('app/terminal/token-scanner/page.tsx')
  assert.match(page, /function v4ControllerRows\(/)
  assert.match(page, /label: 'Liquidity Controller'/)
  assert.match(page, /label: 'Controller Attribution'/)
  assert.match(page, /label: 'Observed Activity'/)
  assert.match(page, /Liquidity activity concentration — not LP ownership concentration\./)
  assert.match(page, /'Unavailable — no canonical V4 position NFTs were found\.'/)
  assert.match(page, /\.\.\.\(protocolPosition && clpView\?\.controllerRows\?\.length \? clpView\.controllerRows : \[\]\)/)
})
