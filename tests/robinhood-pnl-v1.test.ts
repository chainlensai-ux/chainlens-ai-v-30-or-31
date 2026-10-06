// Robinhood PnL V1 (lib/server/robinhoodPnlV1.ts): tx-level V4 route proof, historical both-leg pricing,
// Robinhood-only FIFO. Fixtures are synthetic receipts served by a fake JSON-RPC; the PoolManager, WETH and
// PositionManager addresses are the real Robinhood ones the module checks against.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, __resetRobinhoodPnlV1CachesForTest, RH_NATIVE, RH_V4_POSITION_MANAGER,
  V4_SWAP_TOPIC0, V4_MODIFY_LIQUIDITY_TOPIC0, ERC20_TRANSFER_TOPIC0, ROBINHOOD_PNL_V1_LIMITS,
  selectRobinhoodPnlV1Candidates, type RhRpc, type RobinhoodPnlV1Deps,
} from '../lib/server/robinhoodPnlV1.ts'
import { robinhoodPnlCardView } from '../lib/walletScan/canonicalWalletSelectors.ts'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const TOKEN_A = '0xaaaa000000000000000000000000000000000001'
const TOKEN_B = '0xbbbb000000000000000000000000000000000002'
const TOKEN_C = '0xcccc000000000000000000000000000000000003'
const E18 = BigInt(10) ** BigInt(18)
const DAY1 = 1_760_000_000 // seconds
const ETH_USD = 2000
const GAS_USED = BigInt(100_000)
const GAS_PRICE = BigInt(1_000_000_000)
const FEE = GAS_USED * GAS_PRICE

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const topicAddr = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const txHash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

type Pool = { poolId: string; c0: string; c1: string; encoded: string }
function pool(x: string, y: string): Pool {
  const [c0, c1] = [x, y].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  return { poolId: keccak256(encodeAbiParameters(types, args)).toLowerCase(), c0, c1, encoded: encodeAbiParameters(types, args) }
}
// Swapper perspective (v4-core BalanceDelta): negative = the swapper paid this currency in.
function swapLog(p: Pool, delta: Record<string, bigint>, logIndex: number) {
  const a0 = delta[p.c0] ?? BigInt(0)
  const a1 = delta[p.c1] ?? BigInt(0)
  return { address: PM, topics: [V4_SWAP_TOPIC0, p.poolId, topicAddr(ROUTER)], data: `0x${int256(a0)}${int256(a1)}${'0'.repeat(64 * 4)}`, logIndex: hex(logIndex) }
}
const transferLog = (token: string, from: string, to: string, amount: bigint, logIndex: number) =>
  ({ address: token, topics: [ERC20_TRANSFER_TOPIC0, topicAddr(from), topicAddr(to)], data: `0x${pad(amount.toString(16))}`, logIndex: hex(logIndex) })

type Chain = {
  receipts: Map<string, unknown>
  blockTs: Map<number, number>
  balances: Map<number, bigint>
  nonces: Map<number, number>
  pools: Map<string, Pool>
  calls: string[]
  /** Target-tx evidence: top-level tx.value and the tx's own internal native transfers (its trace). */
  txValues: Map<string, bigint>
  traces: Map<string, Array<{ from: string; to: string; value: bigint; success: boolean }>>
}
function chain(): Chain {
  return { receipts: new Map(), blockTs: new Map(), balances: new Map(), nonces: new Map(), pools: new Map(), calls: [], txValues: new Map(), traces: new Map() }
}
function addTx(c: Chain, p: { n: number; block: number; ts: number; logs: unknown[]; from?: string; status?: number; nativeDelta?: bigint }) {
  c.receipts.set(txHash(p.n), { status: hex(p.status ?? 1), from: p.from ?? WALLET, blockNumber: hex(p.block), gasUsed: hex(GAS_USED), effectiveGasPrice: hex(GAS_PRICE), logs: p.logs })
  c.blockTs.set(p.block, p.ts)
  const before = BigInt(10) * E18
  c.balances.set(p.block - 1, before)
  c.balances.set(p.block, before + (p.nativeDelta ?? BigInt(0)) - FEE)
  c.nonces.set(p.block - 1, p.block)
  c.nonces.set(p.block, p.block + 1)
  // A buy pays ETH as the tx's top-level value; a sell is paid out by an internal transfer in this tx's trace.
  const d = p.nativeDelta ?? BigInt(0)
  c.txValues.set(txHash(p.n), d < BigInt(0) ? -d : BigInt(0))
  c.traces.set(txHash(p.n), d > BigInt(0) ? [{ from: ROUTER, to: WALLET, value: d, success: true }] : [])
}
function fakeRpc(c: Chain): RhRpc {
  return async (calls) => calls.map(({ method, params }) => {
    c.calls.push(method)
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') return c.receipts.get(p[0]) ?? null
    if (method === 'eth_getBlockByNumber') { const ts = c.blockTs.get(Number(p[0])); return ts == null ? null : { timestamp: hex(ts) } }
    if (method === 'eth_getBalance') { const b = c.balances.get(Number(p[1])); return b == null ? null : hex(b) }
    if (method === 'eth_getTransactionCount') { const n = c.nonces.get(Number(p[1])); return n == null ? null : hex(n) }
    if (method === 'eth_getTransactionByHash') { const v = c.txValues.get(p[0]); return v == null ? null : { value: hex(v) } }
    if (method === 'eth_call') {
      const { to, data } = p[0]
      if (to === RH_V4_POSITION_MANAGER) {
        const prefix = (data as string).slice(10, 60)
        const hit = [...c.pools.values()].find((pl) => pl.poolId.slice(2, 52) === prefix)
        return hit ? hit.encoded : `0x${'0'.repeat(320)}`
      }
      if (data === '0x313ce567') return hex(18)
    }
    if (method === 'eth_getLogs') return []
    return null
  })
}
const series = (fromSec: number, toSec: number, usd = ETH_USD): Array<[number, number]> => {
  const pts: Array<[number, number]> = []
  for (let t = Math.floor(fromSec / 3600) * 3600; t <= toSec + 3600; t += 3600) pts.push([t * 1000, usd])
  return pts
}
function deps(c: Chain, over: Partial<RobinhoodPnlV1Deps> = {}): RobinhoodPnlV1Deps {
  return { rpc: fakeRpc(c), ethUsdRange: async (f, t) => series(f, t), tokenHistoricalUsd: async () => null, now: Date.now, nativeTransfersForTx: async (h) => c.traces.get(h) ?? null, ...over }
}
const run = (c: Chain, ns: number[], over: Partial<RobinhoodPnlV1Deps> = {}) => computeRobinhoodPnlV1({
  wallet: WALLET,
  candidates: ns.map((n) => ({ txHash: txHash(n), timestampMs: null, hasSwapLog: true })),
  transactionCount: ns.length, transferCount: ns.length, activityUnavailableReason: null, deps: deps(c, over),
})

const P_ETH_A = pool(RH_NATIVE, TOKEN_A)
const P_ETH_B = pool(RH_NATIVE, TOKEN_B)
const P_A_B = pool(TOKEN_A, TOKEN_B)
function register(c: Chain, ...ps: Pool[]) { for (const p of ps) c.pools.set(p.poolId, p) }

// ETH -> TOKEN_A buy: wallet pays `eth` native, receives `tokens` A.
function buy(c: Chain, n: number, block: number, ts: number, eth: bigint, tokens: bigint) {
  register(c, P_ETH_A)
  addTx(c, { n, block, ts, nativeDelta: -eth, logs: [swapLog(P_ETH_A, { [RH_NATIVE]: -eth, [TOKEN_A]: tokens }, 1), transferLog(TOKEN_A, PM, WALLET, tokens, 2)] })
}
// TOKEN_A -> ETH sell.
function sell(c: Chain, n: number, block: number, ts: number, tokens: bigint, eth: bigint) {
  register(c, P_ETH_A)
  addTx(c, { n, block, ts, nativeDelta: eth, logs: [transferLog(TOKEN_A, WALLET, PM, tokens, 1), swapLog(P_ETH_A, { [RH_NATIVE]: eth, [TOKEN_A]: -tokens }, 2)] })
}

beforeEach(() => { __resetRobinhoodPnlV1CachesForTest() })

test('1. verified V4 buy: ETH -> token proven from the receipt, native leg from the target tx\'s trace + tx.value', async () => {
  const c = chain()
  buy(c, 1, 100, DAY1, E18, BigInt(1000) * E18)
  const r = await run(c, [1])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 0)
  const e = r.priceEvidence[0]
  assert.equal(e.inputToken, RH_NATIVE)
  assert.equal(e.outputToken, TOKEN_A)
  assert.equal(e.inputAmount, 1)
  assert.equal(e.outputAmount, 1000)
  assert.equal(e.inputSource, 'native_historical_eth_usd')
  assert.equal(e.outputSource, 'v4_exact_swap_execution')
  assert.equal(e.bothLegsVerified, true)
  assert.equal(r.realizedPnlUsd, null) // nothing closed yet: null, never $0
  assert.equal(r.status, 'not_verified')
})

test('2. verified V4 sell: token -> ETH, the output read from the target tx\'s trace', async () => {
  const c = chain()
  sell(c, 2, 200, DAY1, BigInt(500) * E18, BigInt(3) * E18 / BigInt(2))
  const r = await run(c, [2])
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.priceEvidence[0].inputToken, TOKEN_A)
  assert.equal(r.priceEvidence[0].outputAmount, 1.5)
  assert.equal(r.priceEvidence[0].outputPriceUsd, ETH_USD)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
})

test('3. multi-hop A -> ETH -> B: one connected route, both legs priced by the exact ETH intermediary', async () => {
  const c = chain()
  register(c, P_ETH_A, P_ETH_B)
  const a = BigInt(100) * E18
  const eth = E18 / BigInt(2)
  const b = BigInt(7) * E18
  addTx(c, { n: 3, block: 300, ts: DAY1, nativeDelta: BigInt(0), logs: [
    transferLog(TOKEN_A, WALLET, PM, a, 1),
    swapLog(P_ETH_A, { [TOKEN_A]: -a, [RH_NATIVE]: eth }, 2),
    swapLog(P_ETH_B, { [RH_NATIVE]: -eth, [TOKEN_B]: b }, 3),
    transferLog(TOKEN_B, PM, WALLET, b, 4),
  ] })
  const r = await run(c, [3])
  assert.equal(r.swapsVerified, 1, JSON.stringify(r.ingestionAudit.rejectionReasons))
  const e = r.priceEvidence[0]
  assert.equal(e.inputToken, TOKEN_A)
  assert.equal(e.outputToken, TOKEN_B)
  assert.equal(e.bothLegsVerified, true)
  assert.match(e.inputSource!, /^v4_exact_route_quote_via_native/)
  assert.ok(Math.abs(e.inputPriceUsd! * e.inputAmount - 1000) < 1e-9)
  assert.equal(r.ingestionAudit.normalizedBuyCount, 1)
  assert.equal(r.ingestionAudit.normalizedSellCount, 1)
})

test('4. a liquidity event in the tx is rejected, never read as a swap', async () => {
  const c = chain()
  buy(c, 4, 400, DAY1, E18, BigInt(1000) * E18)
  ;(c.receipts.get(txHash(4)) as any).logs.push({ address: PM, topics: [V4_MODIFY_LIQUIDITY_TOPIC0, P_ETH_A.poolId, topicAddr(ROUTER)], data: '0x', logIndex: hex(9) })
  const r = await run(c, [4])
  assert.equal(r.swapsVerified, 0)
  assert.equal(r.ingestionAudit.rejectionReasons.liquidity_event_in_tx, 1)
})

test('5. an unrelated second action (an extra token moving, or an off-route V4 swap) is rejected', async () => {
  const c = chain()
  buy(c, 5, 500, DAY1, E18, BigInt(1000) * E18)
  ;(c.receipts.get(txHash(5)) as any).logs.push(transferLog(TOKEN_C, WALLET, ROUTER, E18, 9))
  register(c, P_A_B)
  buy(c, 6, 600, DAY1, E18, BigInt(1000) * E18)
  ;(c.receipts.get(txHash(6)) as any).logs.push(swapLog(P_A_B, { [TOKEN_A]: -E18, [TOKEN_B]: E18 }, 9))
  const r = await run(c, [5, 6])
  assert.equal(r.swapsVerified, 0)
  assert.equal(r.ingestionAudit.rejectionReasons.unrelated_second_action, 2)
})

test('route guards: wrong PoolManager, a tx the wallet did not sign, and "sent A / received B" with no Swap all fail closed', async () => {
  const c = chain()
  buy(c, 7, 700, DAY1, E18, BigInt(1000) * E18)
  ;(c.receipts.get(txHash(7)) as any).logs[0].address = '0x000000000000000000000000000000000000dead'
  buy(c, 8, 800, DAY1, E18, BigInt(1000) * E18)
  ;(c.receipts.get(txHash(8)) as any).from = ROUTER
  addTx(c, { n: 9, block: 900, ts: DAY1, logs: [transferLog(TOKEN_A, WALLET, ROUTER, E18, 1), transferLog(TOKEN_B, ROUTER, WALLET, E18, 2)] })
  const r = await run(c, [7, 8, 9])
  assert.equal(r.swapsVerified, 0)
  assert.deepEqual(r.ingestionAudit.rejectionReasons, { wrong_pool_manager: 1, wallet_not_tx_sender: 1, no_v4_swap_in_tx: 1 })
})

function tokenToToken(c: Chain, n: number) {
  register(c, P_A_B)
  const a = BigInt(10) * E18
  const b = BigInt(20) * E18
  addTx(c, { n, block: 1000 + n, ts: DAY1, logs: [
    transferLog(TOKEN_A, WALLET, PM, a, 1),
    swapLog(P_A_B, { [TOKEN_A]: -a, [TOKEN_B]: b }, 2),
    transferLog(TOKEN_B, PM, WALLET, b, 3),
  ] })
}

test('6. one leg priced -> not verified (no lot is valued from half the evidence)', async () => {
  const c = chain()
  tokenToToken(c, 10)
  const r = await run(c, [10], { tokenHistoricalUsd: async (t) => (t === TOKEN_A ? { priceUsd: 3, source: 'goldrush_historical_exact_token_day' } : null) })
  assert.equal(r.swapsVerified, 1)
  assert.equal(r.swapsBothLegsPriced, 0)
  assert.equal(r.priceEvidence[0].bothLegsVerified, false)
  assert.equal(r.priceEvidence[0].outputPriceUsd, null)
  assert.match(r.priceEvidence[0].rejectionReason!, /output leg/)
  assert.equal(r.exactReason, '1 swap found / 0 had both-leg historical price proof.')
})

test('7. both legs priced by the trusted historical provider -> eligible', async () => {
  const c = chain()
  tokenToToken(c, 11)
  const r = await run(c, [11], { tokenHistoricalUsd: async (t) => ({ priceUsd: t === TOKEN_A ? 3 : 1.4, source: 'goldrush_historical_exact_token_day' }) })
  assert.equal(r.swapsBothLegsPriced, 1)
  const e = r.priceEvidence[0]
  assert.equal(e.bothLegsVerified, true)
  assert.equal(e.inputPriceUsd, 3)
  assert.equal(e.outputPriceUsd, 1.4)
})

test('8. FIFO buy -> sell gives the exact realized PnL and ROI as a verified bounded sample', async () => {
  const c = chain()
  buy(c, 20, 2000, DAY1, E18, BigInt(1000) * E18) // $2,000 cost
  sell(c, 21, 2100, DAY1 + 7200, BigInt(1000) * E18, BigInt(3) * E18 / BigInt(2)) // $3,000 proceeds
  const r = await run(c, [20, 21])
  assert.equal(r.status, 'verified_bounded_sample')
  assert.equal(r.structuralClosedLots, 1)
  assert.equal(r.verifiedClosedLots, 1)
  assert.equal(r.pricingCoverage, 100)
  assert.equal(r.realizedPnlUsd, 1000)
  assert.equal(r.realizedRoiPct, 50)
  assert.equal(r.unmatchedSellCount, 0)
  const card = robinhoodPnlCardView(r)
  assert.deepEqual(card, { kind: 'sample', title: 'ROBINHOOD PNL', statusLabel: 'VERIFIED BOUNDED SAMPLE', realized: '+$1,000.00', roi: '+50.0% ROI', lotsLine: '1/1 closed lots verified', coverageLine: '100.0% coverage' })
})

test('9. a sell with no proven buy is excluded: unmatched, no lot, no PnL', async () => {
  const c = chain()
  sell(c, 30, 3000, DAY1, BigInt(1000) * E18, E18)
  const r = await run(c, [30])
  assert.equal(r.structuralClosedLots, 0)
  assert.equal(r.unmatchedSellCount, 1)
  assert.equal(r.realizedPnlUsd, null)
  assert.equal(r.status, 'not_verified')
  assert.equal(robinhoodPnlCardView(r)?.kind, 'blocker')
})

test('10. repeated scans are deterministic (second scan served from immutable caches)', async () => {
  const c = chain()
  buy(c, 40, 4000, DAY1, E18, BigInt(1000) * E18)
  sell(c, 41, 4100, DAY1 + 3600, BigInt(400) * E18, E18)
  sell(c, 42, 4200, DAY1 + 7200, BigInt(600) * E18, E18 / BigInt(2))
  const strip = (r: Awaited<ReturnType<typeof run>>) => ({ ...r, metrics: null, ingestionAudit: { ...r.ingestionAudit } })
  const first = await run(c, [42, 40, 41])
  const callsAfterFirst = c.calls.filter((m) => m === 'eth_getTransactionReceipt').length
  const second = await run(c, [41, 42, 40])
  assert.deepEqual(strip(second), strip(first))
  assert.equal(c.calls.filter((m) => m === 'eth_getTransactionReceipt').length, callsAfterFirst, 'receipts are not refetched')
  assert.ok(second.metrics.cacheHits > 0)
  assert.equal(first.structuralClosedLots, 2)
  assert.equal(first.realizedPnlUsd, Math.round(((2000 - 800) + (1000 - 1200)) * 100) / 100)
})

test('11. a price provider timeout never fabricates a price', async () => {
  const c = chain()
  buy(c, 50, 5000, DAY1, E18, BigInt(1000) * E18)
  sell(c, 51, 5100, DAY1 + 3600, BigInt(1000) * E18, E18)
  const r = await run(c, [50, 51], { ethUsdRange: async () => { throw new Error('timeout') } })
  assert.equal(r.swapsVerified, 2)
  assert.equal(r.swapsBothLegsPriced, 0)
  assert.equal(r.structuralClosedLots, 1)
  assert.equal(r.verifiedClosedLots, 0)
  assert.equal(r.realizedPnlUsd, null)
  assert.equal(r.status, 'not_verified')
  assert.equal(r.exactReason, '2 swaps found / 0 had both-leg historical price proof.')
  for (const e of r.priceEvidence) { assert.equal(e.inputPriceUsd, null); assert.equal(e.outputPriceUsd, null) }
})

test('limits: at most 20 candidate receipts, swap-log txs first, then most recent', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ txHash: txHash(i + 1), timestampMs: i * 1000, hasSwapLog: i === 0 }))
  const { selected, dropped } = selectRobinhoodPnlV1Candidates(many)
  assert.equal(selected.length, ROBINHOOD_PNL_V1_LIMITS.maxCandidateReceipts)
  assert.equal(dropped, 10)
  assert.equal(selected[0].txHash, txHash(1))
  assert.equal(selected[1].txHash, txHash(30))
})

test('no RPC -> unavailable with the exact reason; the card shows the blocker, not $0', async () => {
  const r = await computeRobinhoodPnlV1({ wallet: WALLET, candidates: [], transactionCount: 0, transferCount: 0, activityUnavailableReason: null, deps: { ...deps(chain()), rpc: null } })
  assert.equal(r.status, 'unavailable')
  assert.equal(r.realizedPnlUsd, null)
  assert.deepEqual(robinhoodPnlCardView(r), { kind: 'blocker', title: 'ROBINHOOD PNL', statusLabel: 'UNAVAILABLE', blocker: 'Robinhood RPC is not configured — swap receipts cannot be read.' })
})

test('12. Base/ETH unchanged: nothing on the Base/ETH path imports the Robinhood lane, and the lane shares no Base pricing state', () => {
  const root = new URL('../', import.meta.url).pathname
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []
  })
  for (const f of walk(join(root, 'src'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /robinhoodPnlV1/, f)
  const lane = readFileSync(join(root, 'lib/server/robinhoodPnlV1.ts'), 'utf8')
  // The shared Base/ETH native resolver keeps per-scan budgets/failure sets; the sidecar runs concurrently, so it must not touch them.
  assert.doesNotMatch(lane, /nativePriceResolver|resolveHistoricalNativeUsdPrice|acceptedEvidenceStore|priceLotsForWallet/)
  assert.match(lane, /'robinhood' as unknown as SupportedChain/)
  // The scanner no longer gates PnL on current (spot) prices.
  const scanner = readFileSync(join(root, 'lib/server/robinhoodWalletScanner.ts'), 'utf8')
  const scan = scanner.slice(scanner.indexOf('export async function scanRobinhoodWallet('))
  assert.doesNotMatch(scan.slice(0, scan.indexOf('// ── PnL V1 bridges')), /buildRobinhoodPriceUsdLookup|resolveRobinhoodWalletPnl\(/)
})
