// Early Buyers first-trade window on a real Base launch (DGUY): the launch transaction both adds the first liquidity
// and swaps, so it is mixed and can never be a verified buy. It must not anchor the window: the first market trades
// start 22 blocks later. Replayed from real receipts (tests/fixtures/early-buyers-dguy-base-launch.json).
//   npx tsx --test tests/early-buyers-launch-liquidity-anchor.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAlchemyCallBudget } from '../lib/server/alchemyCallBudget'
import { readEarlyWindow } from '../lib/server/earlyBuyers/window'
import type { EarlyBuyerRpc } from '../lib/server/earlyBuyers/rpc'

type Log = { address: string; topics: string[]; data: string; logIndex: string; blockNumber: string; transactionHash: string; removed: boolean }
type Receipt = { transactionHash: string; blockNumber: string; transactionIndex: string; from: string; to: string | null; status: string; logs: Log[] }
const F = JSON.parse(readFileSync(new URL('./fixtures/early-buyers-dguy-base-launch.json', import.meta.url), 'utf8')) as { token: string; pool: string; launchBlock: number; liquidityTx: string; timestamps: Record<string, string>; receipts: Receipt[] }
const V3_SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const LAUNCH_SWAPPER = '0x404a2e936be3c9faccb4a59c764c1d14f6add1af'

function replayRpc(receipts: Receipt[] = F.receipts) {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2_000 })
  const methods: string[] = []
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    methods.push(method)
    if (method === 'eth_getLogs') {
      const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[] }
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock))
      return receipts.flatMap((r) => r.logs).filter((l) => l.address === f.address.toLowerCase() && l.topics[0] === f.topics[0] && Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to) as T
    }
    if (method === 'eth_getBlockReceipts') return receipts.filter((r) => r.blockNumber === params[0]) as T
    if (method === 'eth_getTransactionReceipt') return receipts.find((r) => r.transactionHash === params[0]) as T
    if (method === 'eth_getBlockByNumber') return { timestamp: F.timestamps[String(Number(BigInt(params[0] as string)))] } as T
    throw new Error(`unexpected ${method}`)
  } }
  return { rpc, budget, methods }
}

const verified = { status: 'verified' as const, block: F.launchBlock, pool: F.pool, protocol: 'v3' as const, creationTx: F.liquidityTx, liquidityTx: F.liquidityTx }

test('fixture: the launch transaction is the only launch-pool swap in the launch block window', () => {
  const swaps = F.receipts.filter((r) => r.logs.some((l) => l.address === F.pool && l.topics[0] === V3_SWAP))
  const offsets = swaps.map((r) => Number(BigInt(r.blockNumber)) - F.launchBlock)
  assert.deepEqual(offsets, [0, 22, 26, 26, 26, 26, 26, 31])
  assert.equal(swaps[0].transactionHash, F.liquidityTx)
})

test('DGUY: a swap inside the proven first-liquidity transaction does not anchor the window', async () => {
  const { rpc, budget } = replayRpc()
  const result = await readEarlyWindow({ rpc, chain: 'base', token: F.token, launches: [verified] })
  assert.equal(result.startBlock, F.launchBlock + 22)
  assert.equal(result.endBlock, F.launchBlock + 22 + 19)
  assert.ok(result.reasons.includes('launch_liquidity_transaction_swap_unattributed'))
  // The 7 market swaps in blocks +22..+41 are each one pool-sourced delivery to the swapping wallet.
  assert.equal(result.examined.receipts, 7)
  assert.equal(result.facts.length, 7)
  assert.equal(new Set(result.facts.map((f) => f.txHash)).size, 7)
  for (const fact of result.facts) {
    const receipt = F.receipts.find((r) => r.transactionHash === fact.txHash)!
    assert.equal(fact.wallet, receipt.from.toLowerCase(), 'delivered to the transaction signer')
    assert.ok(receipt.logs.some((l) => l.address === F.token && l.topics[1] === `0x${'0'.repeat(24)}${F.pool.slice(2)}` && BigInt(l.data) === fact.rawAmount), 'amount matches a pool-sourced Transfer')
  }
  // The launch transaction's own swap is never turned into a buy.
  assert.ok(!result.facts.some((f) => f.txHash === F.liquidityTx || f.wallet === LAUNCH_SWAPPER))
  assert.ok(budget.callsUsed() <= 60 && budget.estimatedCuUsed() <= 2_000)
})

test('estimated launch (no proven liquidity transaction): window behaviour is unchanged', async () => {
  const { rpc } = replayRpc()
  const result = await readEarlyWindow({ rpc, chain: 'base', token: F.token, launches: [{ ...verified, status: 'estimated', creationTx: null, liquidityTx: null }] })
  assert.equal(result.startBlock, F.launchBlock)
  assert.equal(result.facts.length, 0)
  assert.ok(result.reasons.includes('swap_liquidity_mixed_transaction_unattributed'))
  assert.ok(!result.reasons.includes('launch_liquidity_transaction_swap_unattributed'))
})

test('a window swap outside the proven liquidity transaction keeps the anchor; the mixed swap stays unattributed', async () => {
  const { rpc } = replayRpc()
  // If the proven liquidity transaction were a different one, the launch-block swap would anchor the window as before.
  const other = F.receipts[1].transactionHash
  const result = await readEarlyWindow({ rpc, chain: 'base', token: F.token, launches: [{ ...verified, liquidityTx: other }] })
  assert.equal(result.startBlock, F.launchBlock)
  assert.ok(!result.reasons.includes('launch_liquidity_transaction_swap_unattributed'))
  assert.ok(result.reasons.includes('swap_liquidity_mixed_transaction_unattributed'))
})

test('the anchor is kept unless the receipt proves a liquidity event on the launch pool', async () => {
  const V3_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
  const launch = F.receipts[0]
  assert.ok(launch.logs.some((l) => l.address === F.pool && l.topics[0] === V3_MINT), 'real launch receipt has the pool Mint')
  const withoutMint = [{ ...launch, logs: launch.logs.filter((l) => l.topics[0] !== V3_MINT) }, ...F.receipts.slice(1)]
  const { rpc } = replayRpc(withoutMint)
  const result = await readEarlyWindow({ rpc, chain: 'base', token: F.token, launches: [verified] })
  assert.equal(result.startBlock, F.launchBlock)
  assert.ok(!result.reasons.includes('launch_liquidity_transaction_swap_unattributed'))
})
