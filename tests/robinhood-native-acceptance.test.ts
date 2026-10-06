// Robinhood PnL V1 accepted lane: a V4 swap's native ETH endpoint is accepted only from the TARGET tx's own
// trace (internal native transfers) plus its top-level tx.value. The whole-block balance delta is diagnostic.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, type RhRpc, type RobinhoodPnlV1Deps } from '../lib/server/robinhoodPnlV1.ts'
import { blockscoutNativeTransfersForTx } from '../lib/server/robinhoodNativeTrace.ts'
import { __resetRobinhoodBlockscoutRateLimitForTest } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const STRANGER = '0x7777777777777777777777777777777777777777'
const TOKEN_A = '0xaaaa000000000000000000000000000000000001'
const TOKEN_B = '0xbbbb000000000000000000000000000000000002'
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const E18 = BigInt(10) ** BigInt(18)
const GAS = BigInt(100_000) * BigInt(1_000_000_000)
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

function pool(x: string, y: string) {
  const [c0, c1] = [x, y].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  return { id: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
}
const P_ETH_A = pool(RH_NATIVE, TOKEN_A)
const P_A_B = pool(TOKEN_A, TOKEN_B)
const POOLS = [P_ETH_A, P_A_B]
const swap = (p: ReturnType<typeof pool>, d: Record<string, bigint>, i: number) => ({ address: PM, topics: [V4_SWAP_TOPIC0, p.id, t(ROUTER)], data: `0x${int256(d[p.c0] ?? BigInt(0))}${int256(d[p.c1] ?? BigInt(0))}${'0'.repeat(256)}`, logIndex: hex(i) })
const xfer = (token: string, from: string, to: string, amt: bigint, i: number) => ({ address: token, topics: [ERC20_TRANSFER_TOPIC0, t(from), t(to)], data: `0x${pad(amt.toString(16))}`, logIndex: hex(i) })

type Tx = { logs: unknown[]; txValue: bigint; balanceDelta: bigint }
function rpcFor(txs: Map<string, Tx>, calls: string[] = []): RhRpc {
  const byBlock = new Map<number, Tx>()
  let block = 100
  const blockOf = new Map<string, number>()
  for (const [h, tx] of txs) { blockOf.set(h, block); byBlock.set(block, tx); block += 10 }
  return async (cs) => cs.map(({ method, params }) => {
    calls.push(method)
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') {
      const tx = txs.get(p[0])
      return tx ? { status: '0x1', from: WALLET, to: ROUTER, blockNumber: hex(blockOf.get(p[0])!), gasUsed: hex(100_000), effectiveGasPrice: hex(1_000_000_000), logs: tx.logs } : null
    }
    if (method === 'eth_getBlockByNumber') return { timestamp: hex(1_760_000_000 + Number(p[0])) }
    if (method === 'eth_getTransactionByHash') { const tx = txs.get(p[0]); return tx ? { value: hex(tx.txValue) } : null }
    if (method === 'eth_getBalance') {
      const n = Number(p[1])
      const tx = byBlock.get(n)
      return hex(BigInt(10) * E18 + (tx ? tx.balanceDelta - GAS : BigInt(0)))
    }
    if (method === 'eth_getTransactionCount') return byBlock.has(Number(p[1])) ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return POOLS.find((x) => x.id.slice(2, 52) === String(p[0].data).slice(10, 60))?.encoded ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
}
async function run(txs: Map<string, Tx>, trace: RobinhoodPnlV1Deps['nativeTransfersForTx'], calls: string[] = []) {
  const w = console.warn
  console.warn = () => {}
  try {
    return await computeRobinhoodPnlV1({
      wallet: WALLET, candidates: [...txs.keys()].map((h) => ({ txHash: h, timestampMs: null, hasSwapLog: true })),
      transactionCount: txs.size, transferCount: txs.size, activityUnavailableReason: null,
      deps: { rpc: rpcFor(txs, calls), ethUsdRange: async (f, to) => [[f * 1000, 2000], [to * 1000, 2000]], tokenHistoricalUsd: async () => null, now: Date.now, nativeTransfersForTx: trace },
    })
  } finally { console.warn = w }
}
/** TOKEN_A → native ETH sell paying `eth` out; `balanceDelta` is what the wallet's whole-block balance shows. */
const sellTx = (eth: bigint, balanceDelta = eth): Tx => ({
  logs: [xfer(TOKEN_A, WALLET, PM, BigInt(1000) * E18, 1), swap(P_ETH_A, { [RH_NATIVE]: eth, [TOKEN_A]: -(BigInt(1000) * E18) }, 2)],
  txValue: BigInt(0), balanceDelta,
})
const payout = (eth: bigint, to = WALLET, success = true): RhNativeTransfer[] => [{ from: ROUTER, to, value: eth, success }]

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('1. direct V4 token -> native with the exact target-tx trace payout -> accepted as before', async () => {
  const eth = BigInt(3) * E18 / BigInt(2)
  const r = await run(new Map([[H(1), sellTx(eth)]]), async () => payout(eth))
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.priceEvidence[0].outputAmount, 1.5)
})

test('2. the same receipt with only the block balance delta -> rejected (native proof unavailable)', async () => {
  const r = await run(new Map([[H(2), sellTx(E18)]]), async () => null)
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { native_flow_unprovable: 1 })
})

test('3. unrelated inbound ETH in the same block cannot contaminate the accepted amount', async () => {
  // The swap paid 1.5 ETH; a stranger's tx in the same block sent the wallet another 1.5 (block delta = 3).
  const eth = BigInt(3) * E18 / BigInt(2)
  const contaminated = sellTx(eth, eth * BigInt(2))
  const ok = await run(new Map([[H(3), contaminated]]), async () => payout(eth))
  assert.equal(ok.swapsVerified, 1)
  assert.equal(ok.priceEvidence[0].outputAmount, 1.5, 'the amount comes from the target tx trace, never the block delta')
  // Without a trace the contaminated block delta is never used.
  const none = await run(new Map([[H(4), contaminated]]), async () => null)
  assert.equal(none.swapsVerified, 0)
  // A trace that pays the stranger (not the wallet) proves no wallet output.
  const elsewhere = await run(new Map([[H(5), sellTx(eth)]]), async () => payout(eth, STRANGER))
  assert.equal(elsewhere.swapsVerified, 0)
})

test('4. an internal transfer with success:false is ignored -> no proven payout -> rejected', async () => {
  const r = await run(new Map([[H(6), sellTx(E18)]]), async () => payout(E18, WALLET, false))
  assert.equal(r.swapsVerified, 0)
})

test('5. a trace entry with missing/null success is not silently accepted (adapter fails closed)', async () => {
  const body = (success: unknown) => async () => new Response(JSON.stringify({ items: [{ from: { hash: ROUTER }, to: { hash: WALLET }, value: String(E18), ...(success === undefined ? {} : { success }) }], next_page_params: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  __resetRobinhoodBlockscoutRateLimitForTest()
  const missing = await blockscoutNativeTransfersForTx(body(undefined))(`0x${'b1'.repeat(32)}`)
  assert.deepEqual([missing.transfers, missing.audit?.result, missing.audit?.missingSuccessStatus], [null, 'unknown_execution_status', true])
  const nul = await blockscoutNativeTransfersForTx(body(null))(`0x${'b2'.repeat(32)}`)
  assert.deepEqual([nul.transfers, nul.audit?.result], [null, 'unknown_execution_status'])
  const ok = await blockscoutNativeTransfersForTx(body(true))(`0x${'b3'.repeat(32)}`)
  assert.deepEqual(ok.transfers, [{ from: ROUTER, to: WALLET, value: E18, success: true }])
  assert.equal(ok.audit?.result, 'proven')
  __resetRobinhoodBlockscoutRateLimitForTest()
  // and through PnL V1: the adapter's null means no proof -> rejected
  const r = await run(new Map([[H(7), sellTx(E18)]]), blockscoutNativeTransfersForTx(body(null) as never))
  assert.equal(r.swapsVerified, 0)
})

test('6. ERC-20 <-> ERC-20 direct V4 swaps are unchanged (no native evidence fetched)', async () => {
  const calls: string[] = []
  let traceCalls = 0
  const tx: Tx = { logs: [xfer(TOKEN_A, WALLET, PM, BigInt(10) * E18, 1), swap(P_A_B, { [TOKEN_A]: -(BigInt(10) * E18), [TOKEN_B]: BigInt(20) * E18 }, 2), xfer(TOKEN_B, PM, WALLET, BigInt(20) * E18, 3)], txValue: BigInt(0), balanceDelta: BigInt(0) }
  const r = await run(new Map([[H(8), tx]]), async () => { traceCalls += 1; return [] }, calls)
  assert.equal(r.swapsVerified, 1)
  assert.equal(traceCalls, 0)
  assert.ok(!calls.includes('eth_getBalance'))
})

test('7. a mixed receipt whose route is not proven stays rejected even with a proven trace payout', async () => {
  const eth = E18
  const mixed = sellTx(eth)
  mixed.logs.push({ address: '0x4444444444444444444444444444444444444444', topics: [V3_SWAP, t(ROUTER), t(ROUTER)], data: `0x${int256(E18)}${int256(-E18)}${'0'.repeat(192)}`, logIndex: hex(9) })
  const r = await run(new Map([[H(9), mixed]]), async () => payout(eth))
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { other_venue_swap_in_tx: 1 })
})
