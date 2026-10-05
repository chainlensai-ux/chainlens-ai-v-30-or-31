// Robinhood mixed-route native attribution: only the TARGET tx's own trace may prove a native payout. A whole-
// block balance delta (even with the wallet's nonce advancing by exactly one) is a diagnostic bound only.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import { analyzeRobinhoodMixedRoute, deriveRhNativeEvidence, V3_SWAP_TOPIC0, WETH_WITHDRAWAL_TOPIC0 } from '../lib/server/robinhoodMixedRouteForensics.ts'
import { blockscoutNativeTransfersForTx } from '../lib/server/robinhoodNativeTrace.ts'
import { computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_V4_POSITION_MANAGER, RH_WETH, type RhPoolKey, type RhReceipt, type RhRpc } from '../lib/server/robinhoodPnlV1.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x3333333333333333333333333333333333333333'
const STRANGER = '0x7777777777777777777777777777777777777777'
const NATIVE = '0x0000000000000000000000000000000000000000'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const C = '0xcccc000000000000000000000000000000000003'
const P3 = '0x3000000000000000000000000000000000000003'
const SWAP4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(x) * E18
const GAS = BigInt(100_000) * BigInt(1_000_000_000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))

const key = (() => {
  const [c0, c1] = [A, B].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, NATIVE as Hex] as const
  return { id: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
})()
const KEYS = new Map<string, RhPoolKey>([[key.id, { currency0: key.c0, currency1: key.c1 }]])

/** token A → V4 → B → V3(WETH) → unwrap → native ETH (the production 53353/8980 shape). With an ERC-20 variant ending in C. */
function receipt(opts: { ethOut?: bigint; erc20Out?: boolean } = {}): RhReceipt {
  const ethOut = opts.ethOut ?? n(2)
  let i = 0
  const L = (address: string, topics: string[], data: string) => ({ address, topics, data, logIndex: i++, blockTimestamp: 1_760_000_000 })
  const d: Record<string, bigint> = { [A]: -n(100), [B]: n(50) }
  const logs = [
    L(A, [TRANSFER, t(WALLET), t(PM)], `0x${pad(n(100).toString(16))}`),
    L(PM, [SWAP4, key.id, t(ROUTER)], `0x${int256(d[key.c0])}${int256(d[key.c1])}${'0'.repeat(256)}`),
    L(B, [TRANSFER, t(PM), t(ROUTER)], `0x${pad(n(50).toString(16))}`),
    L(B, [TRANSFER, t(ROUTER), t(P3)], `0x${pad(n(50).toString(16))}`),
    L(P3, [V3_SWAP_TOPIC0, t(ROUTER), t(ROUTER)], `0x${int256(n(50))}${int256(-(opts.erc20Out ? n(7) : ethOut))}${'0'.repeat(192)}`),
  ]
  if (opts.erc20Out) logs.push(L(C, [TRANSFER, t(P3), t(WALLET)], `0x${pad(n(7).toString(16))}`))
  else logs.push(L(RH_WETH, [TRANSFER, t(P3), t(ROUTER)], `0x${pad(ethOut.toString(16))}`), L(RH_WETH, [WETH_WITHDRAWAL_TOPIC0, t(ROUTER)], `0x${pad(ethOut.toString(16))}`))
  return { status: 1, from: WALLET, to: ROUTER, blockNumber: 500, gasUsed: BigInt(100_000), effectiveGasPrice: BigInt(1_000_000_000), logs }
}
const analyze = (rcpt: RhReceipt, native: ReturnType<typeof deriveRhNativeEvidence>) =>
  analyzeRobinhoodMixedRoute({ wallet: WALLET, txHash: '0x01', receipt: rcpt, poolManager: PM, v4PoolKeys: KEYS, native })
const evidence = (o: { trace: Array<{ from: string; to: string; value: bigint; success: boolean }> | null; before?: bigint; after?: bigint; nonceDelta?: number; txValue?: bigint }) => deriveRhNativeEvidence({
  wallet: WALLET, isSender: true, gasPaid: GAS, txValue: o.txValue ?? BigInt(0),
  balanceBefore: o.before ?? n(5), balanceAfter: o.after ?? n(5) + n(2) - GAS,
  nonceBefore: 7, nonceAfter: 7 + (o.nonceDelta ?? 1), trace: o.trace,
})

test('1. target tx trace pays the wallet -> proven_target_tx_native_transfer, route proven', () => {
  const ev = evidence({ trace: [{ from: ROUTER, to: WALLET, value: n(2), success: true }] })
  assert.equal(ev.status, 'proven_target_tx_native_transfer')
  assert.equal(ev.nativeNetExGas, n(2))
  const r = analyze(receipt(), ev)
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.equal(r.walletNativeOutputRaw, n(2).toString())
})

test('2. WETH unwrap in the receipt + the trace paying the wallet -> proven; the unwrap alone is not', () => {
  const rcpt = receipt()
  assert.ok(rcpt.logs.some((l) => l.topics[0] === WETH_WITHDRAWAL_TOPIC0))
  assert.equal(analyze(rcpt, evidence({ trace: [{ from: ROUTER, to: WALLET, value: n(2), success: true }, { from: RH_WETH, to: ROUTER, value: n(2), success: true }] })).finalClassification, 'direct_mixed_route_proven')
  // Same receipt, trace shows the ETH went to someone else: never the wallet's output.
  const elsewhere = analyze(rcpt, evidence({ trace: [{ from: ROUTER, to: STRANGER, value: n(2), success: true }] }))
  assert.equal(elsewhere.finalClassification, 'ambiguous')
  // A reverted internal transfer to the wallet does not count.
  assert.equal(evidence({ trace: [{ from: ROUTER, to: WALLET, value: n(2), success: false }] }).nativeNetExGas, BigInt(0))
})

test('3. nonce +1 and a positive block balance delta, but an unrelated tx paid the wallet -> NOT proven', () => {
  // The wallet's balance rose by 2 ETH in the block, but the target tx's own trace paid it nothing:
  // the 2 ETH came from another tx in the same block.
  const ev = evidence({ trace: [{ from: ROUTER, to: STRANGER, value: n(2), success: true }], after: n(5) + n(2) - GAS })
  assert.equal(ev.blockBalanceDeltaExGas, n(2).toString(), 'the block delta is still recorded as a diagnostic bound')
  assert.equal(ev.traceNativeToWallet, '0')
  const r = analyze(receipt(), ev)
  assert.notEqual(r.finalClassification, 'direct_mixed_route_proven')
  assert.equal(r.walletNativeOutputRaw, null)
})

test('4. balance delta only (no trace) -> block_balance_delta_only -> ambiguous', () => {
  const ev = evidence({ trace: null })
  assert.equal(ev.status, 'block_balance_delta_only')
  assert.equal(ev.nativeNetExGas, null)
  const r = analyze(receipt(), ev)
  assert.equal(r.finalClassification, 'ambiguous')
  assert.match(r.reason, /block_balance_delta_only/)
  // and the other non-proof states
  assert.equal(evidence({ trace: null, nonceDelta: 2 }).status, 'unavailable_multiple_wallet_txs_in_block')
  assert.equal(deriveRhNativeEvidence({ wallet: WALLET, isSender: true, gasPaid: GAS, txValue: BigInt(0), balanceBefore: null, balanceAfter: null, nonceBefore: null, nonceAfter: null, trace: null }).status, 'unavailable_no_trace')
})

test('5. an ERC-20-output mixed route is unaffected (no native evidence needed)', () => {
  const r = analyze(receipt({ erc20Out: true }), evidence({ trace: null, after: n(5) - GAS }))
  assert.equal(r.finalClassification, 'direct_mixed_route_proven', r.reason)
  assert.deepEqual([r.walletOutputToken, r.walletOutputRaw], [C, n(7).toString()])
})

test('Blockscout trace parser: incomplete (paginated) or malformed traces are not proof', async () => {
  const fetchOf = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const ok = await blockscoutNativeTransfersForTx(fetchOf({ items: [{ from: { hash: ROUTER }, to: { hash: WALLET }, value: '2000', success: true }], next_page_params: null }))(`0x${'a1'.repeat(32)}`)
  assert.deepEqual(ok, [{ from: ROUTER, to: WALLET, value: BigInt(2000), success: true }])
  assert.equal(await blockscoutNativeTransfersForTx(fetchOf({ items: [], next_page_params: { index: 1 } }))(`0x${'a2'.repeat(32)}`), null)
  assert.equal(await blockscoutNativeTransfersForTx(fetchOf({ items: [{ from: { hash: ROUTER }, to: { hash: WALLET }, value: 'not-a-number' }] }))(`0x${'a3'.repeat(32)}`), null)
})

// ── 6. Acceptance unchanged ─────────────────────────────────────────────────────────────────────
beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

async function runE2E(trace: Array<{ from: string; to: string; value: bigint; success: boolean }> | null) {
  const rcpt = receipt()
  const hash = `0x${'53'.repeat(32)}`
  const raw = { status: '0x1', from: WALLET, to: ROUTER, blockNumber: '0x1f4', gasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', logs: rcpt.logs.map((l) => ({ ...l, logIndex: `0x${l.logIndex.toString(16)}`, blockTimestamp: '0x68e7c000' })) }
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return p[0] === hash ? raw : null
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return key.encoded
    if (method === 'eth_getBalance') return `0x${(Number(p[1]) === 499 ? n(5) : n(5) + n(2) - GAS).toString(16)}`
    if (method === 'eth_getTransactionCount') return Number(p[1]) === 499 ? '0x7' : '0x8'
    if (method === 'eth_getTransactionByHash') return { value: '0x0' }
    return null
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({ wallet: WALLET, candidates: [{ txHash: hash, timestampMs: null, hasSwapLog: true }], transactionCount: 1, transferCount: 1, activityUnavailableReason: null, deps: { rpc, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now, nativeTransfersForTx: async () => trace } })
    return { r, row: lines.find(([tag]) => tag === '[robinhood-mixed-route-forensics]')?.[1] }
  } finally { console.warn = w }
}

test('6. acceptance unchanged: mixed receipts are still rejected, with or without a trace proof', async () => {
  const proven = await runE2E([{ from: ROUTER, to: WALLET, value: n(2), success: true }])
  assert.equal(proven.r.swapsVerified, 0)
  assert.deepEqual(proven.r.ingestionAudit.rejectionReasons, { other_venue_swap_in_tx: 1 })
  assert.equal(proven.row?.finalClassification, 'direct_mixed_route_proven')
  assert.equal(proven.row?.nativeAttributionStatus, 'proven_target_tx_native_transfer')

  const deltaOnly = await runE2E(null)
  assert.equal(deltaOnly.r.swapsVerified, 0)
  assert.equal(deltaOnly.row?.nativeAttributionStatus, 'block_balance_delta_only')
  assert.equal(deltaOnly.row?.nativeEvidence.blockBalanceDeltaExGas, n(2).toString())
  assert.equal(deltaOnly.row?.finalClassification, 'ambiguous')
})
