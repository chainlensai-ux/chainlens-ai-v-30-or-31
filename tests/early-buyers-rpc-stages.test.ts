// Early Buyers RPC budget: per-stage accounting (which stage consumed the call budget) and the current-balance
// read, which used to fail by construction whenever launch discovery and the window had spent the analysis budget.
//   npx tsx --test tests/early-buyers-rpc-stages.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionResult, toEventSelector } from 'viem'
import { createAlchemyCallBudget } from '../lib/server/alchemyCallBudget'
import { analyzeEarlyBuyers, EARLY_BUYER_HOLDINGS_READ_LIMITS, hydrateHoldings, meterEarlyBuyerStages, type EarlyBuyerDiagnostics } from '../lib/server/earlyBuyers/analyze'
import { EarlyBuyerRpcError, type EarlyBuyerRpc } from '../lib/server/earlyBuyers/rpc'
import { earlyBuyerLogRecord, earlyBuyerStageRecord, withEarlyBuyerDiagnostics, EARLY_BUYERS_RPC_HEADER } from '../lib/server/earlyBuyers/requestLog'

const ROUTER = '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc'
const A = '0x' + 'a'.repeat(40)
const C = '0x' + 'c'.repeat(40)
const TX1 = '0x' + '1'.repeat(64)
const TX2 = '0x' + '2'.repeat(64)
const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
const mint = toEventSelector('Mint(address,uint256,uint256)')
const swapTopic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
const transferTopic = toEventSelector('Transfer(address,address,uint256)')
const abi = [{ type: 'function', name: 'aggregate3', stateMutability: 'view', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const
const word = (n: number) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as `0x${string}`
// One buyer's balance, then Multicall3 block number, block timestamp and the token's totalSupply.
const balances = encodeFunctionResult({ abi, functionName: 'aggregate3', result: [[{ success: true, returnData: word(9) }, { success: true, returnData: word(5000) }, { success: true, returnData: word(1700000000) }, { success: true, returnData: word(1000) }]] as unknown as Array<{ success: boolean; returnData: `0x${string}` }> })

/** A deterministic Base chain (2s blocks) with one verified v2 launch and one swap buyer — same shape as tests/early-buyers.test.ts. */
function chain(token: string, pool: string, maxCalls: number) {
  const budget = createAlchemyCallBudget({ maxCalls, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    // Same pre-flight behaviour as lib/server/earlyBuyers/rpc.ts: nothing is sent once the budget is spent.
    if (!check.allowed) throw new EarlyBuyerRpcError(check.reason)
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const spec = params[0]
      const n = spec === 'latest' || spec === 'finalized' ? 250 : Number(BigInt(String(spec)))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
    }
    if (method === 'eth_call') return balances as T
    if (method === 'eth_getTransactionReceipt') return { transactionHash: TX1, from: A, to: ROUTER, status: '0x1', blockNumber: '0x85', transactionIndex: '0x0', logs: [
      { address: pool, topics: [swapTopic, topic(A), topic(ROUTER)], transactionHash: TX1, logIndex: '0x0' },
      { address: token, topics: [transferTopic, topic(pool), topic(A)], data: `0x${'0'.repeat(63)}a`, transactionHash: TX1, logIndex: '0x1' },
    ] } as T
    if (method !== 'eth_getLogs') return '0x' as T
    const filter = params[0] as { address?: string; fromBlock?: string; toBlock?: string; topics?: Array<string | null> }
    const from = filter.fromBlock ? Number(BigInt(filter.fromBlock)) : 0
    const to = filter.toBlock ? Number(BigInt(filter.toBlock)) : 0
    if (filter.topics?.[0] === pairCreated) return [{ address: filter.address, topics: [pairCreated, topic(token), topic(C)], data: `${topic(pool)}${'0'.repeat(64)}`, blockNumber: '0x64', transactionHash: TX2 }] as T
    if (filter.address?.toLowerCase() === pool && filter.topics?.[0] === mint) return [{ address: pool, topics: [mint], blockNumber: '0x65', transactionHash: TX2 }] as T
    if (filter.topics?.[0] === swapTopic && from <= 133 && to >= 133) return [{ address: pool, topics: [swapTopic, topic(A), topic(ROUTER)], blockNumber: '0x85', transactionHash: TX1, logIndex: '0x0' }] as T
    return [] as T
  } }
  const fetchImpl = (async (url: string | URL | Request) => {
    if (!String(url).includes('dexscreener.com')) throw new Error('unexpected_fetch')
    return new Response(JSON.stringify({ pairs: [{ chainId: 'base', pairAddress: pool, dexId: 'uniswap', labels: ['v2'], pairCreatedAt: 200 }] }), { status: 200 })
  }) as typeof fetch
  return { rpc, budget, fetchImpl }
}
function holdingsOnly() {
  const budget = createAlchemyCallBudget(EARLY_BUYER_HOLDINGS_READ_LIMITS)
  const calls: string[] = []
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new EarlyBuyerRpcError(check.reason)
    budget.record(method)
    calls.push(method)
    return balances as T
  } }
  return { rpc, calls }
}

test('per-stage accounting attributes every call of a full analysis to its stage', async () => {
  const token = '0x' + '3'.repeat(40), pool = '0x' + '4'.repeat(40)
  const { rpc, budget, fetchImpl } = chain(token, pool, 60)
  const diagnostics: EarlyBuyerDiagnostics = {}
  const intel = await analyzeEarlyBuyers('base', token, { rpc, fetchImpl, diagnostics })
  const s = diagnostics.rpcStages!
  assert.ok(s.launch && s.window && s.finality && s.holdings)
  const total = s.launch.calls + s.window.calls + s.finality.calls + s.holdings.calls
  assert.equal(total, budget.callsUsed(), 'every provider call is attributed to exactly one stage')
  assert.equal(intel.budget.calls, budget.callsUsed())
  assert.deepEqual(s.holdings.methods, { eth_call: 1 })
  assert.deepEqual(s.finality.methods, { eth_getBlockByNumber: 1 })
  assert.ok((s.launch.methods.eth_getLogs ?? 0) >= 2, 'factory creation + first liquidity logs')
  assert.equal(diagnostics.holdingsMeter, 'analysis', 'with budget left, balances are read on the analysis budget')
  assert.equal(intel.holdingsStatus, 'available')
})

test('ROOT CAUSE: a spent analysis budget made the balance read fail although the buyer was proven', async () => {
  const token = '0x' + '5'.repeat(40), pool = '0x' + '6'.repeat(40)
  // Calls this scenario spends before the balance read.
  const probe = chain(token, pool, 60)
  const probeDiag: EarlyBuyerDiagnostics = {}
  await analyzeEarlyBuyers('base', token, { rpc: probe.rpc, fetchImpl: probe.fetchImpl, diagnostics: probeDiag })
  const beforeHoldings = probe.budget.callsUsed() - 1
  // Old behaviour, reproduced directly: the same proven intel, balance read on a budget with no calls left.
  const spent = chain(token, pool, beforeHoldings)
  for (let i = 0; i < beforeHoldings; i++) spent.budget.record('eth_getBlockByNumber')
  const proven = { buyers: [{ wallet: A, boughtRaw: '10' }], groups: [], coverage: { capped: false, reasons: [] as string[], provisional: false, scope: 'bounded_first_trade_window' } }
  const old = await hydrateHoldings(spent.rpc, token, proven as never)
  assert.equal(old.holdingsStatus, 'failed')
  assert.ok(old.coverage.reasons.includes('holdings_unavailable'))
})

test('FIX: with the analysis budget spent, balances are read on a dedicated one-call meter and charged to the total', async () => {
  const token = '0x' + '7'.repeat(40), pool = '0x' + '8'.repeat(40)
  const probe = chain('0x' + '9'.repeat(40), '0x' + 'e'.repeat(40), 60)
  await analyzeEarlyBuyers('base', '0x' + '9'.repeat(40), { rpc: probe.rpc, fetchImpl: probe.fetchImpl })
  const beforeHoldings = probe.budget.callsUsed() - 1
  const tight = chain(token, pool, beforeHoldings)
  const dedicated = holdingsOnly()
  const diagnostics: EarlyBuyerDiagnostics = {}
  const intel = await analyzeEarlyBuyers('base', token, { rpc: tight.rpc, holdingsRpc: dedicated.rpc, fetchImpl: tight.fetchImpl, diagnostics })
  assert.equal(tight.budget.callsUsed(), beforeHoldings, 'the analysis budget itself is never exceeded')
  assert.equal(intel.buyers.length, 1)
  assert.equal(intel.holdingsStatus, 'available')
  assert.equal(intel.buyers[0].heldRaw, '9', 'the balance comes from the real read, not an estimate')
  assert.deepEqual(dedicated.calls, ['eth_call'], 'exactly one Multicall3 read, nothing else')
  assert.equal(diagnostics.holdingsMeter, 'dedicated')
  assert.equal(intel.budget.calls, beforeHoldings + 1, 'the extra call is reported')
  assert.equal(intel.budget.cu, tight.budget.estimatedCuUsed() + 26, 'and charged to the CU the quota settles')
  assert.equal(diagnostics.rpcStages?.holdings?.calls, 1)
})

test('the dedicated meter can never send more than the one balance read', async () => {
  const dedicated = holdingsOnly()
  await dedicated.rpc.call('eth_call', [])
  await assert.rejects(() => dedicated.rpc.call('eth_call', []), (e: unknown) => e instanceof EarlyBuyerRpcError && e.reason === 'call_count_budget_exceeded')
  assert.deepEqual(EARLY_BUYER_HOLDINGS_READ_LIMITS, { maxCalls: 1, maxEstimatedCu: 26 })
})

test('meter: a pre-flight budget stop is recorded as the stage stop and is not counted as a call', async () => {
  const budget = createAlchemyCallBudget({ maxCalls: 1, maxEstimatedCu: 2000 })
  let sent = 0
  const base: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new EarlyBuyerRpcError(check.reason)
    budget.record(method); sent++
    if (method === 'eth_getLogs') throw new EarlyBuyerRpcError('rpc_http_429')
    return [] as T
  } }
  const diag: EarlyBuyerDiagnostics = {}
  const meter = meterEarlyBuyerStages(base, diag)
  meter.enter('window')
  await assert.rejects(() => meter.rpc.call('eth_getLogs', []))
  await assert.rejects(() => meter.rpc.call('eth_getLogs', []))
  assert.equal(sent, 1)
  assert.deepEqual(diag.rpcStages?.window?.methods, { eth_getLogs: 1 }, 'a failed call that reached the provider counts')
  assert.equal(diag.rpcStages?.window?.calls, 1)
  assert.equal(diag.rpcStages?.window?.stoppedBy, 'call_count_budget_exceeded')
})

test('log record and header carry only allowlisted stage data', () => {
  const rpcStages = {
    launch: { calls: 9, ms: 812.4, methods: { eth_getBlockByNumber: 5, eth_getLogs: 4, 'https://rpc/KEY': 3 }, stoppedBy: null },
    window: { calls: 51, ms: 4100, methods: { eth_getLogs: 3, eth_getTransactionReceipt: 48 }, stoppedBy: 'call_count_budget_exceeded' },
    holdings: { calls: 1, ms: 90, methods: { eth_call: 1 }, stoppedBy: null },
  }
  const record = earlyBuyerStageRecord(rpcStages)!
  assert.deepEqual(record.launch.methods, { eth_getBlockByNumber: 5, eth_getLogs: 4 }, 'non-code method keys are dropped')
  assert.equal(record.launch.ms, 812)
  assert.equal(record.window.stoppedBy, 'call_count_budget_exceeded')
  const line = earlyBuyerLogRecord({ requestId: 'r', status: 200, source: 'cold_scan', durationMs: 5000, rpcStages, holdingsMeter: 'dedicated' })
  assert.deepEqual(line.rpcStages, record)
  assert.equal(line.holdingsMeter, 'dedicated')
  const res = withEarlyBuyerDiagnostics(new Response('{}'), { requestId: 'r', source: 'cold_scan', durationMs: 5000, holdingsSource: 'live', rpcStages, holdingsMeter: 'dedicated' })
  assert.equal(res.headers.get(EARLY_BUYERS_RPC_HEADER), 'launch=9;window=51:call_count_budget_exceeded;holdings=1*')
  assert.doesNotMatch(JSON.stringify(line), /KEY/)
})
