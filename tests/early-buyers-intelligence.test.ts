// Early Buyers P0/P1/P2: shared-recipient T1 graph, receipt coverage, holdings freshness, receipt
// CU accounting, observed supply exposure, and current-vs-received balance comparison.
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionResult, toEventSelector } from 'viem'
import { estimatedCuForMethod, createAlchemyCallBudget } from '../lib/server/alchemyCallBudget'
import { buildSharedDeliveryGraph, classifyEarlyBuyers, deriveBuyFacts, upgradeLegacyDeliveryGraph } from '../lib/server/earlyBuyers/classify'
import { planBlockReceipts, readEarlyWindow, BLOCK_RECEIPTS_THROUGHPUT_CAP, BLOCK_RECEIPTS_THROUGHPUT_CU } from '../lib/server/earlyBuyers/window'
import { analyzeEarlyBuyers, hydrateHoldings } from '../lib/server/earlyBuyers/analyze'
import { canPersistFinalizedEvidence, readEarlyBuyerEvidence, writeEarlyBuyerEvidence } from '../lib/server/earlyBuyers/store'
import { createEarlyBuyerRpc, EarlyBuyerRpcError, type EarlyBuyerRpc } from '../lib/server/earlyBuyers/rpc'
import { setTokenCache, getTokenCache } from '../lib/server/cache/tokenCache'
import { compareBalanceToObservedReceipts, EARLY_BUYER_WINDOW_SCOPE, type BuyFact, type EarlyBuyerIntel } from '../lib/server/earlyBuyers/types'

const POOL = '0x' + '2'.repeat(40), TOKEN = '0x' + '1'.repeat(40), ROUTER = '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc'
const FEE = '0x' + 'f'.repeat(40)
const w = (i: number) => '0x' + (i + 1).toString(16).padStart(40, 'a')
const h = (i: number) => '0x' + (i + 1).toString(16).padStart(64, '0')
const infrastructure = new Set([POOL, ROUTER, TOKEN])

/** One router swap: pool → router → buyer, plus optional extra pool-sourced recipients (fee wallets, co-recipients). */
function buy(i: number, opts: { buyer?: string; amount?: number; extra?: Array<{ to: string; amount: number }>; signer?: string; block?: number; extraViaRouter?: Array<{ to: string; amount: number }> } = {}): BuyFact[] {
  const buyer = opts.buyer ?? w(i), amount = opts.amount ?? 95, block = opts.block ?? 100 + (i % 20)
  const routed = [{ to: buyer, amount }, ...(opts.extraViaRouter ?? [])]
  const total = routed.reduce((s, r) => s + r.amount, 0)
  return deriveBuyFacts({ transfers: [
    { from: POOL, to: ROUTER, rawAmount: BigInt(total), txHash: h(i), block },
    ...routed.map((r) => ({ from: ROUTER, to: r.to, rawAmount: BigInt(r.amount), txHash: h(i), block })),
    ...(opts.extra ?? []).map((e) => ({ from: POOL, to: e.to, rawAmount: BigInt(e.amount), txHash: h(i), block })),
  ], poolSources: new Set([POOL]), infrastructure, signer: opts.signer ?? buyer, called: ROUTER, txHash: h(i), block, transactionIndex: i, pool: POOL, timestampSec: 1000 + i })
}

const t1 = (r: ReturnType<typeof classifyEarlyBuyers>) => r.groups.filter((g) => g.tier === 'T1')

// ── P0: T1 false linking ─────────────────────────────────────────────────────────────────────────
test('Probe A: 30 independent purchases sharing a 5% fee recipient form no T1 group', () => {
  const facts = Array.from({ length: 30 }, (_, i) => buy(i, { extra: [{ to: FEE, amount: 5 }] })).flat()
  const r = classifyEarlyBuyers(facts, true)
  assert.equal(r.buyers.length, 31, 'the fee recipient is still an observed recipient')
  assert.equal(t1(r).length, 0)
  assert.equal(r.groups.length, 0, 'no T2 either: each buy has its own signer')
  const g = r.deliveryGraph!
  assert.equal(g.multiRecipientTransactions, 30)
  assert.equal(g.linkingTransactions, 0)
  assert.equal(g.sharedRecipients.length, 1)
  const fee = g.sharedRecipients[0]
  assert.equal(fee.wallet, FEE)
  assert.equal(fee.classification, 'fee_or_distribution_pattern')
  assert.equal(fee.transactions.length, 30, 'every delivery to it stays cited')
  assert.equal(fee.partnerClusters, 30)
  assert.equal(fee.signers, 30)
  assert.deepEqual(fee.shareBps, { min: 500, max: 500 })
  assert.match(fee.reason, /not proven/)
  assert.equal(g.unlinkedRecipients, 30)
  assert.deepEqual(g.denominators, { observedRecipients: 31, observedDeliveredRaw: String(30 * 100), ordinaryRecipients: 30, ordinaryDeliveredRaw: String(30 * 95) })
})

test('the same purchases without a fee form no groups and no shared recipients', () => {
  const r = classifyEarlyBuyers(Array.from({ length: 30 }, (_, i) => buy(i, { amount: 100 })).flat(), true)
  assert.equal(r.buyers.length, 30)
  assert.equal(r.groups.length, 0)
  assert.equal(r.deliveryGraph!.multiRecipientTransactions, 0)
  assert.equal(r.deliveryGraph!.sharedRecipients.length, 0)
  assert.equal(r.deliveryGraph!.denominators.ordinaryDeliveredRaw, r.deliveryGraph!.denominators.observedDeliveredRaw)
})

test('a genuine multi-recipient transaction is still T1 with both denominators equal', () => {
  const facts = [...buy(0, { buyer: w(0), amount: 40, extraViaRouter: [{ to: w(1), amount: 30 }, { to: w(2), amount: 30 }] }), ...buy(3, { amount: 100 })]
  const r = classifyEarlyBuyers(facts, true)
  assert.deepEqual(t1(r).map((g) => g.wallets), [[w(0), w(1), w(2)].sort()])
  assert.deepEqual(t1(r)[0].transactions, [h(0)])
  assert.equal(t1(r)[0].boughtWithinEarlySetPct, 50)
  assert.equal(t1(r)[0].boughtWithinOrdinaryRecipientsPct, 50)
  assert.equal(r.deliveryGraph!.unlinkedRecipients, 1)
})

test('genuine repeat recipients: a bot repeatedly delivering to the same wallets keeps one T1 group', () => {
  // Same signer delivers to A, B, C in three transactions: each wallet is in 3 multi-recipient
  // transactions but its partners form one cluster, so nobody is set aside.
  const facts = [0, 1, 2].flatMap((i) => buy(i, { buyer: w(0), amount: 10, signer: w(50), extraViaRouter: [{ to: w(1), amount: 10 }, { to: w(2), amount: 10 }] }))
  const r = classifyEarlyBuyers(facts, true)
  assert.equal(r.deliveryGraph!.sharedRecipients.length, 0)
  assert.deepEqual(t1(r).map((g) => [g.wallets, g.transactions]), [[[w(0), w(1), w(2)].sort(), [h(0), h(1), h(2)]]])
  // A wallet buying alone five times is a repeat recipient with no relationship to anyone.
  const solo = classifyEarlyBuyers([0, 1, 2, 3, 4].flatMap((i) => buy(i, { buyer: w(9) })), true)
  assert.equal(solo.buyers.length, 1)
  assert.equal(solo.groups.length, 0)
  assert.equal(solo.deliveryGraph!.sharedRecipients.length, 0)
  // Two partner clusters stay below the threshold: R links S and T (direct evidence in both transactions).
  const pair = classifyEarlyBuyers([...buy(0, { buyer: w(20), extraViaRouter: [{ to: w(21), amount: 5 }] }), ...buy(1, { buyer: w(20), extraViaRouter: [{ to: w(22), amount: 5 }] })], true)
  assert.deepEqual(t1(pair).map((g) => g.wallets), [[w(20), w(21), w(22)].sort()])
})

test('mixed: direct associations survive while a high-frequency shared recipient bridges nothing', () => {
  const facts = [
    ...buy(0, { buyer: w(0), extraViaRouter: [{ to: w(1), amount: 50 }], extra: [{ to: FEE, amount: 5 }] }), // A,B + fee
    ...buy(1, { buyer: w(2), extraViaRouter: [{ to: w(3), amount: 50 }], extra: [{ to: FEE, amount: 5 }] }), // C,D + fee
    ...Array.from({ length: 10 }, (_, i) => buy(10 + i, { extra: [{ to: FEE, amount: 5 }] })).flat(),
  ]
  const r = classifyEarlyBuyers(facts, true)
  assert.deepEqual(t1(r).map((g) => g.wallets), [[w(0), w(1)].sort(), [w(2), w(3)].sort()])
  assert.deepEqual(t1(r).map((g) => g.transactions), [[h(0)], [h(1)]])
  const fee = r.deliveryGraph!.sharedRecipients[0]
  assert.equal(fee.wallet, FEE)
  assert.equal(fee.transactions.length, 12)
  // Fee share differs between the 3-recipient and 2-recipient transactions, so it is only a candidate.
  assert.equal(fee.classification, 'high_frequency_shared_recipient')
  assert.equal(r.groups.some((g) => g.wallets.includes(FEE)), false, 'no T1 or T2 group contains the shared recipient')
  const d = r.deliveryGraph!.denominators
  assert.equal(d.observedRecipients - d.ordinaryRecipients, 1)
  const g = t1(r)[0]
  assert.ok(g.boughtWithinOrdinaryRecipientsPct! > g.boughtWithinEarlySetPct!, 'excluding the shared recipient shrinks the denominator only')
})

test('fee/distribution pattern needs a near-constant minority share across 3+ signers', () => {
  const irregular = classifyEarlyBuyers(Array.from({ length: 6 }, (_, i) => buy(i, { extra: [{ to: FEE, amount: 5 + i * 3 }] })).flat(), true)
  assert.equal(irregular.deliveryGraph!.sharedRecipients[0].classification, 'high_frequency_shared_recipient')
  const oneSigner = classifyEarlyBuyers(Array.from({ length: 6 }, (_, i) => buy(i, { signer: w(77), extra: [{ to: FEE, amount: 5 }] })).flat(), true)
  assert.equal(oneSigner.deliveryGraph!.sharedRecipients[0].classification, 'high_frequency_shared_recipient')
  assert.equal(oneSigner.deliveryGraph!.sharedRecipients[0].signers, 1)
  const majority = classifyEarlyBuyers(Array.from({ length: 6 }, (_, i) => buy(i, { amount: 10, extra: [{ to: FEE, amount: 90 }] })).flat(), true)
  assert.equal(majority.deliveryGraph!.sharedRecipients[0].classification, 'high_frequency_shared_recipient')
})

test('the graph is deterministic and independent of fact order', () => {
  const facts = [
    ...buy(0, { buyer: w(0), extraViaRouter: [{ to: w(1), amount: 50 }], extra: [{ to: FEE, amount: 5 }] }),
    ...Array.from({ length: 8 }, (_, i) => buy(10 + i, { extra: [{ to: FEE, amount: 5 }] })).flat(),
  ]
  const a = classifyEarlyBuyers(facts, true), b = classifyEarlyBuyers([...facts].reverse(), true)
  assert.deepEqual(a.groups, b.groups)
  assert.deepEqual(a.deliveryGraph, b.deliveryGraph)
})

test('T1/T2 stay off for an unverified launch; ERC-4337 bundles never form shared deliveries', () => {
  const facts = Array.from({ length: 5 }, (_, i) => buy(i, { extra: [{ to: FEE, amount: 5 }] })).flat()
  const r = classifyEarlyBuyers(facts, false)
  assert.equal(r.groups.length, 0)
  assert.equal(r.deliveryGraph, undefined)
  const entry = facts.map((f) => ({ ...f, called: '0x0000000071727de22e5e9d8baf0edac6f37da032' }))
  assert.equal(classifyEarlyBuyers(entry, true).deliveryGraph!.multiRecipientTransactions, 0)
})

test('legacy stored rows are rebuilt from cited transactions; candidates only, idempotent', () => {
  const facts = Array.from({ length: 30 }, (_, i) => buy(i, { extra: [{ to: FEE, amount: 5 }] })).flat()
  const fresh = classifyEarlyBuyers(facts, true)
  // What the old transitive merge stored: one 31-wallet T1 group citing all 30 transactions.
  const legacy: EarlyBuyerIntel = { status: 'partial', launch: { status: 'verified', block: 100, pool: POOL, creationTx: h(900), liquidityTx: h(901) }, window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: facts.length }, buyers: fresh.buyers, groups: [{ tier: 'T1', associationType: 'shared_transaction_delivery', wallets: fresh.buyers.map((b) => b.wallet), transactions: Array.from({ length: 30 }, (_, i) => h(i)), reason: 'x', boughtWithinEarlySetPct: 100, heldWithinEarlySetPct: null }], sameBlockCount: 31, launchDistributions: [], coverage: { capped: true, reasons: ['window_not_finalized'], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 30, cu: 900 } }
  const up = upgradeLegacyDeliveryGraph(legacy)
  assert.equal(up.groups.filter((g) => g.tier === 'T1').length, 0)
  assert.equal(up.deliveryGraph!.source, 'legacy_rebuild')
  assert.equal(up.deliveryGraph!.sharedRecipients[0].wallet, FEE)
  assert.equal(up.deliveryGraph!.sharedRecipients[0].classification, 'high_frequency_shared_recipient', 'no amounts or signers stored, so no fee claim')
  assert.equal(up.deliveryGraph!.sharedRecipients[0].shareBps, null)
  assert.equal(up.deliveryGraph!.sharedRecipients[0].signers, null)
  assert.equal(upgradeLegacyDeliveryGraph(up), up, 'already-upgraded rows are returned unchanged')
  const noT1 = { ...legacy, groups: [] }
  assert.equal(upgradeLegacyDeliveryGraph(noT1), noT1, 'rows without T1 (for example unverified launches) are left alone')
})

test('a legacy provisional row is served upgraded through the store', async () => {
  const token = '0x' + '5'.repeat(40)
  const facts = Array.from({ length: 4 }, (_, i) => buy(i, { extra: [{ to: FEE, amount: 5 }] })).flat()
  const buyers = classifyEarlyBuyers(facts, true).buyers
  const legacy: EarlyBuyerIntel = { status: 'partial', launch: { status: 'verified', block: 100, pool: POOL, creationTx: h(900), liquidityTx: h(901) }, window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: facts.length }, buyers, groups: [{ tier: 'T1', wallets: buyers.map((b) => b.wallet), transactions: [h(0), h(1), h(2), h(3)], reason: 'x', boughtWithinEarlySetPct: 100, heldWithinEarlySetPct: null }], sameBlockCount: 0, launchDistributions: [], coverage: { capped: true, reasons: ['window_not_finalized'], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 30, cu: 900 } }
  await setTokenCache(`early-buyers:provisional:v2:base:${token}`, { version: 2, chain: 'base', token, intel: legacy }, 120)
  const read = await readEarlyBuyerEvidence('base', token)
  assert.ok(read)
  assert.equal(read!.groups.length, 0)
  assert.equal(read!.deliveryGraph?.sharedRecipients[0]?.wallet, FEE)
})

test('the pure graph builder sets aside only bridges, never wallets with one partner cluster', () => {
  const tx = (hash: string, wallets: string[]) => ({ txHash: hash, signer: null, amounts: new Map(wallets.map((x) => [x, null] as [string, bigint | null])) })
  const { groups, graph } = buildSharedDeliveryGraph([tx(h(1), [w(0), w(1)]), tx(h(2), [w(0), w(1), w(2)]), tx(h(3), [w(0), w(2)])], [0, 1, 2].map((i) => ({ wallet: w(i), boughtRaw: '1' })), 'legacy_rebuild')
  assert.equal(graph.sharedRecipients.length, 0)
  assert.deepEqual(groups.map((g) => g.wallets), [[w(0), w(1), w(2)]])
})

// ── P0: receipt coverage, CU accounting and throughput guard ─────────────────────────────────────
const swap = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
const transferTopic = toEventSelector('Transfer(address,address,uint256)')
const topic = (a: string) => '0x' + '0'.repeat(24) + a.slice(2)

function windowRpc(perBlock: number, blocks: number, opts: { oversize?: boolean } = {}) {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const calls: Record<string, number> = {}
  const txs = Array.from({ length: perBlock * blocks }, (_, i) => ({ hash: h(i), block: 100 + Math.floor(i / perBlock), idx: i % perBlock, buyer: w(i) }))
  const receipt = (t: typeof txs[number]) => ({ transactionHash: t.hash, from: t.buyer, to: ROUTER, status: '0x1', blockNumber: '0x' + t.block.toString(16), transactionIndex: '0x' + t.idx.toString(16), logs: [
    { address: POOL, topics: [swap], transactionHash: t.hash, logIndex: '0x' + t.idx.toString(16) },
    { address: TOKEN, topics: [transferTopic, topic(POOL), topic(t.buyer)], data: '0x' + (100).toString(16).padStart(64, '0') },
  ] })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const ok = budget.check(method); if (!ok.allowed) throw new EarlyBuyerRpcError(ok.reason)
    budget.record(method); calls[method] = (calls[method] ?? 0) + 1
    if (method === 'eth_getLogs') { const f = params[0] as { fromBlock: string; toBlock: string }; const a = Number(BigInt(f.fromBlock)), b = Number(BigInt(f.toBlock)); return txs.filter((t) => t.block >= a && t.block <= b).map((t) => ({ address: POOL, topics: [swap], blockNumber: '0x' + t.block.toString(16), transactionHash: t.hash, logIndex: '0x' + t.idx.toString(16) })) as T }
    if (method === 'eth_getBlockReceipts') { if (opts.oversize) throw new EarlyBuyerRpcError('response_size_cap'); const b = Number(BigInt(String(params[0]))); return txs.filter((t) => t.block === b).map(receipt) as T }
    if (method === 'eth_getTransactionReceipt') return receipt(txs.find((t) => t.hash === params[0])!) as T
    if (method === 'eth_getBlockByNumber') return { number: params[0], timestamp: '0x' + (5000 + Number(BigInt(String(params[0]))) * 2).toString(16) } as T
    return [] as T
  } }
  return { rpc, budget, calls }
}
const launches = [{ status: 'verified' as const, block: 100, pool: POOL, protocol: 'v2' as const, creationTx: h(900), liquidityTx: h(901) }]

test('Probe B: a capped window reports the nominal range and the receipts actually inspected', async () => {
  const { rpc, budget, calls } = windowRpc(4, 20)
  const r = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches })
  assert.deepEqual([r.startBlock, r.endBlock], [100, 119], 'nominal window unchanged')
  assert.deepEqual(r.examined, { startBlock: 100, endBlock: 112, receipts: 50, swapTransactions: 80, attributedTransactions: 50, rejectedTransactions: 0, unresolvedTransactions: 0 })
  assert.equal(r.capped, true)
  assert.deepEqual(r.reasons, ['receipt_cap_50'])
  assert.equal(r.facts.length, 50)
  // 8 block-receipt calls fit the throughput cap; the remaining 5 blocks fall back to single receipts.
  assert.equal(r.blockReceiptCalls, BLOCK_RECEIPTS_THROUGHPUT_CAP / BLOCK_RECEIPTS_THROUGHPUT_CU)
  assert.equal(r.blockReceiptThroughputCu, BLOCK_RECEIPTS_THROUGHPUT_CAP)
  assert.deepEqual(calls, { eth_getLogs: 1, eth_getBlockReceipts: 8, eth_getTransactionReceipt: 18, eth_getBlockByNumber: 13 })
  assert.ok(budget.callsUsed() <= 60 && budget.estimatedCuUsed() <= 2000)
  assert.equal(budget.estimatedCuUsed(), 75 + 8 * 20 + 18 * 15 + 13 * 16)
})

test('block-receipt plan: busiest blocks first within the throughput cap, never at the cost of the call budget', () => {
  // 10 blocks with 3 swaps and 10 with 2 (50 receipts) — the shape that maximises single-receipt calls.
  const groups: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [100 + i, i % 2 === 0 ? 3 : 2])
  const roomy = planBlockReceipts(groups, 59)
  assert.equal(roomy.size, 8, 'throughput cap holds when the call budget has room')
  assert.deepEqual([...roomy].sort((a, b) => a - b), [100, 102, 104, 106, 108, 110, 112, 114], '3-swap blocks first')
  const calls = (plan: Set<number>) => groups.reduce((sum, [b, n]) => sum + (plan.has(b) ? 1 : n), 0) + groups.length + 3
  assert.equal(calls(roomy), 8 + 26 + 23, "8 block receipts + 26 single receipts + 20 headers + 3 reserved")
  // After a discovery phase that used 15 calls, the same window must still fit: more block receipts are used instead.
  const tight = planBlockReceipts(groups, 45)
  assert.ok(tight.size > 8)
  assert.ok(calls(tight) <= 45)
  // The previous behaviour (block receipts for every multi-swap block) is the floor it never goes below.
  assert.equal(calls(planBlockReceipts(groups, 0)), 20 + 20 + 3)
  assert.equal(planBlockReceipts([[100, 1], [101, 1]], 59).size, 0, 'single-swap blocks always use one receipt call')
})

test('an uncapped window reports complete receipt coverage', async () => {
  const { rpc } = windowRpc(2, 5)
  const r = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches })
  assert.deepEqual(r.examined, { startBlock: 100, endBlock: 104, receipts: 10, swapTransactions: 10, attributedTransactions: 10, rejectedTransactions: 0, unresolvedTransactions: 0 })
  assert.equal(r.capped, false)
})

test('an oversized block-receipts response falls back to single receipts without a coverage gap', async () => {
  const { rpc, calls } = windowRpc(3, 4, { oversize: true })
  const r = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches })
  assert.equal(r.capped, false)
  assert.deepEqual(r.reasons, [])
  assert.equal(r.examined.receipts, 12)
  assert.equal(calls.eth_getTransactionReceipt, 12)
})

test('eth_getBlockReceipts is accounted at its published 20 CU', () => {
  assert.equal(estimatedCuForMethod('eth_getBlockReceipts'), 20)
})

test('the RPC client rejects a response over the byte cap, by header or by decoded size', async () => {
  const prior = process.env.ALCHEMY_BASE_KEY
  process.env.ALCHEMY_BASE_KEY = 'test-key'
  try {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(2_000) })
    const byLength = createEarlyBuyerRpc('base', (async () => new Response(big, { headers: { 'content-length': String(big.length) } })) as typeof fetch)
    await assert.rejects(byLength.call('eth_getBlockReceipts', ['0x1'], { maxResponseBytes: 1_000 }), (e: unknown) => e instanceof EarlyBuyerRpcError && e.reason === 'response_size_cap')
    const chunked = createEarlyBuyerRpc('base', (async () => new Response(big)) as typeof fetch)
    await assert.rejects(chunked.call('eth_getBlockReceipts', ['0x1'], { maxResponseBytes: 1_000 }), (e: unknown) => e instanceof EarlyBuyerRpcError && e.reason === 'response_size_cap')
    assert.equal(chunked.budget.callsUsed(), 1, 'a rejected oversized call still counts against the budget')
    const ok = createEarlyBuyerRpc('base', (async () => new Response(big)) as typeof fetch)
    assert.equal((await ok.call<string>('eth_call', [])).length, 2_000, 'calls without a cap are unaffected')
  } finally { if (prior == null) delete process.env.ALCHEMY_BASE_KEY; else process.env.ALCHEMY_BASE_KEY = prior }
})

function verifiedIntel(over: Partial<EarlyBuyerIntel> = {}): EarlyBuyerIntel {
  return { status: 'verified', launch: { status: 'verified', block: 100, pool: POOL, creationTx: h(900), liquidityTx: h(901) }, window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 1, examined: { startBlock: 101, endBlock: 101, receipts: 1, swapTransactions: 1 } }, buyers: [{ wallet: w(0), purchaseProven: false, boughtRaw: '10', heldRaw: null, transactions: [h(0)], blocks: [101], evidence: [{ txHash: h(0), pool: POOL, block: 101, timestampSec: 1000, reason: 'pool_sourced_token_delivery_in_swap_transaction' }] }], groups: [], sameBlockCount: 0, launchDistributions: [], coverage: { capped: false, reasons: [], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 10, cu: 300 }, discovery: { earliestDiscoveredPool: POOL, earliestVerifiedPool: POOL, candidates: [{ pool: POOL, createdAt: 1, outcome: 'verified', reason: 'ok' }], complete: true }, ...over }
}

test('persistence rules: verified rows must have inspected every swap transaction; examined must sit inside the window', () => {
  assert.equal(canPersistFinalizedEvidence(verifiedIntel(), true), true)
  const { examined: _e, ...legacyWindow } = verifiedIntel().window; void _e
  assert.equal(canPersistFinalizedEvidence(verifiedIntel({ window: legacyWindow }), true), true, 'older rows without examined still validate')
  assert.equal(canPersistFinalizedEvidence(verifiedIntel({ window: { ...verifiedIntel().window, examined: { startBlock: 101, endBlock: 101, receipts: 1, swapTransactions: 2 } } }), true), false)
  assert.equal(canPersistFinalizedEvidence(verifiedIntel({ window: { ...verifiedIntel().window, examined: { startBlock: 101, endBlock: 130, receipts: 1, swapTransactions: 1 } } }), true), false)
})

// ── P0: holdings freshness; P1 supply exposure; P2 balance comparison ───────────────────────────
const MC_ABI = [{ type: 'function', name: 'aggregate3', stateMutability: 'view', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const
const word = (n: bigint | number) => ({ success: true, returnData: `0x${BigInt(n).toString(16).padStart(64, '0')}` })
const fail = { success: false, returnData: '0x' }
function multicallRpc(rows: Array<{ success: boolean; returnData: string }>) {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const seen: string[] = []
  const raw = encodeFunctionResult({ abi: MC_ABI, functionName: 'aggregate3', result: [rows] as unknown as Array<{ success: boolean; returnData: `0x${string}` }> })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> { seen.push(method); budget.record(method); return raw as T } }
  return { rpc, budget, seen }
}
const holders = (balances: Array<string>, over: Partial<EarlyBuyerIntel> = {}): EarlyBuyerIntel => verifiedIntel({ buyers: balances.map((_, i) => ({ wallet: w(i), purchaseProven: false, boughtRaw: '100', heldRaw: null, transactions: [h(i)], blocks: [101] })), ...over })

test('holdings carry the read block, block time and read time from the same single eth_call', async () => {
  const { rpc, budget, seen } = multicallRpc([word(250), word(0), word(77_000), word(1_760_000_000), word(10_000)])
  const r = await hydrateHoldings(rpc, TOKEN, holders(['', '']), () => 1_760_000_123_000)
  assert.deepEqual(seen, ['eth_call'])
  assert.equal(budget.estimatedCuUsed(), 26, 'no extra RPC call for block, time or supply')
  assert.deepEqual(r.currentHoldings, { blockNumber: 77_000, blockTimestampSec: 1_760_000_000, readAtMs: 1_760_000_123_000, source: 'live', cacheAgeSec: 0, walletsRead: 2, walletsObserved: 2 })
})

test('observed supply exposure uses totalSupply at the same block, with shared recipients reported separately', async () => {
  const { rpc } = multicallRpc([word(250), word(150), word(100), word(77_000), word(1), word(10_000)])
  const graph = { source: 'transaction_facts' as const, multiRecipientTransactions: 3, linkingTransactions: 0, sharedRecipients: [{ wallet: w(2), classification: 'fee_or_distribution_pattern' as const, transactions: [h(0)], partnerClusters: 3, signers: 3, shareBps: { min: 500, max: 500 }, reason: 'r' }], unlinkedRecipients: 2, denominators: { observedRecipients: 3, observedDeliveredRaw: '300', ordinaryRecipients: 2, ordinaryDeliveredRaw: '200' } }
  const r = await hydrateHoldings(rpc, TOKEN, holders(['', '', ''], { deliveryGraph: graph }))
  assert.deepEqual(r.supplyExposure, { status: 'available', reason: null, blockNumber: 77_000, totalSupplyRaw: '10000', observedHeldRaw: '500', observedPct: 5, ordinaryHeldRaw: '400', ordinaryPct: 4, walletsIncluded: 3, excludedSharedRecipients: [w(2)] })
})

test('supply exposure fails closed instead of showing a misleading percentage', async () => {
  const cases: Array<[Array<{ success: boolean; returnData: string }>, number, string]> = [
    [[word(1), fail, word(1), word(1), word(1000)], 2, 'holdings_incomplete'],
    [[word(1), word(1), word(1), word(1), fail], 2, 'total_supply_unavailable'],
    [[word(1), word(1), word(1), word(1), word(0)], 2, 'total_supply_zero'],
    [[word(600), word(600), word(1), word(1), word(1000)], 2, 'balances_exceed_total_supply'],
  ]
  for (const [rows, n, reason] of cases) {
    const r = await hydrateHoldings(multicallRpc(rows).rpc, TOKEN, holders(Array(n).fill('')))
    assert.equal(r.supplyExposure?.status, 'unavailable', reason)
    assert.equal(r.supplyExposure?.reason, reason)
    assert.equal(r.supplyExposure?.observedPct, null)
  }
  // More than 50 recipients: holdings are capped, so exposure is unavailable.
  const many = await hydrateHoldings(multicallRpc([...Array(50).fill(word(1)), word(1), word(1), word(1_000_000)]).rpc, TOKEN, holders(Array(60).fill('')))
  assert.equal(many.holdingsStatus, 'partial')
  assert.equal(many.supplyExposure?.reason, 'holdings_incomplete')
  // A failed read gives neither a snapshot nor an exposure figure.
  const broken: EarlyBuyerRpc = { budget: createAlchemyCallBudget(), async call<T>(): Promise<T> { throw new EarlyBuyerRpcError('rpc_error') } }
  const failed = await hydrateHoldings(broken, TOKEN, holders(['']))
  assert.equal(failed.holdingsStatus, 'failed')
  assert.equal(failed.currentHoldings, undefined)
  assert.equal(failed.supplyExposure, undefined)
})

test('current balance vs observed launch receipts never implies a trade', () => {
  assert.deepEqual(compareBalanceToObservedReceipts('100', '250'), { relation: 'exceeds_observed_receipts', ratioPct: 250 })
  assert.deepEqual(compareBalanceToObservedReceipts('100', '100'), { relation: 'equal_to_observed_receipts', ratioPct: 100 })
  assert.deepEqual(compareBalanceToObservedReceipts('300', '100'), { relation: 'below_observed_receipts', ratioPct: 33.33 })
  assert.deepEqual(compareBalanceToObservedReceipts('100', '0'), { relation: 'zero_balance', ratioPct: 0 })
  assert.deepEqual(compareBalanceToObservedReceipts('100', null), { relation: 'unavailable', ratioPct: null })
  assert.deepEqual(compareBalanceToObservedReceipts('0', '5'), { relation: 'no_observed_receipt', ratioPct: null })
})

test('hydrated buyers carry the comparison; persisted evidence drops every current-state field', async () => {
  const { rpc } = multicallRpc([word(250), word(1), word(1), word(1000)])
  const hydrated = await hydrateHoldings(rpc, TOKEN, holders(['']))
  assert.equal(hydrated.buyers[0].balanceComparison?.relation, 'exceeds_observed_receipts')
  const token = '0x' + '6'.repeat(40)
  const partial = { ...hydrated, status: 'partial' as const, coverage: { ...hydrated.coverage, capped: true, reasons: ['window_not_finalized'], provisional: true } }
  await writeEarlyBuyerEvidence('base', token, partial, false)
  const stored = await getTokenCache<{ intel: EarlyBuyerIntel }>(`early-buyers:provisional:v2:base:${token}`)
  assert.ok(stored)
  assert.equal(stored!.intel.currentHoldings, undefined)
  assert.equal(stored!.intel.supplyExposure, undefined)
  assert.equal(stored!.intel.buyers[0].heldRaw, null)
  assert.equal(stored!.intel.buyers[0].balanceComparison, undefined)
})

test('a cached holdings read reports its original block and its age', async () => {
  const token = '0x' + '4'.repeat(40)
  const evidence = { ...holders(['']), status: 'partial' as const, coverage: { capped: true, reasons: ['window_not_finalized'], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE } }
  await writeEarlyBuyerEvidence('base', token, evidence, false)
  const readAtMs = Date.now() - 90_000
  await setTokenCache(`early-buyers:holdings:v3:base:${token}`, { ...evidence, holdingsStatus: 'available', buyers: [{ ...evidence.buyers[0], heldRaw: '5' }], currentHoldings: { blockNumber: 77_000, blockTimestampSec: 1, readAtMs, source: 'live', cacheAgeSec: 0, walletsRead: 1, walletsObserved: 1 } }, 300)
  const r = await analyzeEarlyBuyers('base', token)
  assert.equal(r.currentHoldings?.source, 'cache')
  assert.equal(r.currentHoldings?.blockNumber, 77_000)
  assert.ok(r.currentHoldings!.cacheAgeSec >= 89 && r.currentHoldings!.cacheAgeSec <= 95, String(r.currentHoldings!.cacheAgeSec))
  assert.equal(r.budget.calls, 0)
})
