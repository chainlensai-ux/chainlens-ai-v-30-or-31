import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionResult, toEventSelector } from 'viem'
import { getTokenCache, setTokenCache } from '../lib/server/cache/tokenCache'
import { createAlchemyCallBudget } from '../lib/server/alchemyCallBudget'
import { LP_LOCK_BURN_REGISTRY } from '../lib/server/lpLockBurnIntel'
import { classifyEarlyBuyers, deriveBuyFacts, PUBLIC_CALL_TARGETS } from '../lib/server/earlyBuyers/classify'
import { earlyWindowEnd, readEarlyWindow } from '../lib/server/earlyBuyers/window'
import { canPersistFinalizedEvidence, EARLY_BUYER_VERSION, readEarlyBuyerEvidence, validEarlyBuyerCacheEnvelope, windowIsFinalized, writeEarlyBuyerEvidence } from '../lib/server/earlyBuyers/store'
import { discoverLaunch, discoverLaunches } from '../lib/server/earlyBuyers/launch'
import { calculateCortexScoreV2 } from '../lib/token/scoring'
import { hydrateHoldings, analyzeEarlyBuyers } from '../lib/server/earlyBuyers/analyze'
import { earlyBuyerQuotaPolicy, reserveEarlyBuyerAnalysis } from '../lib/server/earlyBuyers/limits'
import { createEarlyBuyerRpc, EarlyBuyerRpcError } from '../lib/server/earlyBuyers/rpc'
import { EARLY_BUYER_WINDOW_SCOPE, earlyBuyerDisplayStatus, heldRawLabel, type BuyFact, type EarlyBuyerIntel, type Transfer } from '../lib/server/earlyBuyers/types'
import type { EarlyBuyerRpc } from '../lib/server/earlyBuyers/rpc'

const TOKEN = '0x' + '1'.repeat(40)
const POOL = '0x' + '2'.repeat(40)
const ROUTER = '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc'
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const C = '0x' + 'c'.repeat(40)
const TX1 = '0x' + '1'.repeat(64)
const TX2 = '0x' + '2'.repeat(64)
const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
const transfer = (from: string, to: string, rawAmount: bigint, txHash = TX1, block = 100): Transfer => ({ from, to, rawAmount, txHash, block })
const fact = (wallet: string, txHash: string, signer = wallet, called: string | null = null, block = 100): BuyFact => ({ wallet, rawAmount: BigInt(10), txHash, signer, called, block, transactionIndex: 0 })

test('unrelated same-block buyers never become a group; T3 is a count only', () => {
  const result = classifyEarlyBuyers([fact(A, TX1), fact(B, TX2)], true)
  assert.equal(result.sameBlockCount, 2)
  assert.equal(result.groups.length, 0)
})

test('pool → router → end wallet identifies the recipient, not the router', () => {
  const facts = deriveBuyFacts({ transfers: [transfer(POOL, ROUTER, BigInt(100)), transfer(ROUTER, A, BigInt(100))], poolSources: new Set([POOL]), infrastructure: new Set([POOL, ROUTER, TOKEN]), signer: A, called: ROUTER, txHash: TX1, block: 100, transactionIndex: 0 })
  assert.deepEqual(facts.map((f) => f.wallet), [A])
  assert.equal(facts[0].rawAmount.toString(), '100')
})

test('a router cannot pass off its unrelated balance as pool-sourced launch buying', () => {
  const facts = deriveBuyFacts({ transfers: [transfer(POOL, ROUTER, BigInt(10)), transfer(ROUTER, A, BigInt(100))], poolSources: new Set([POOL]), infrastructure: new Set([POOL, ROUTER, TOKEN]), signer: A, called: ROUTER, txHash: TX1, block: 100, transactionIndex: 0 })
  assert.equal(facts[0].rawAmount.toString(), '10')
})

test('public router, aggregator, and EntryPoint calls do not create T2 or signer links', () => {
  assert.ok(PUBLIC_CALL_TARGETS.has(ROUTER))
  const routed = classifyEarlyBuyers([fact(A, TX1, A, ROUTER), fact(B, TX2, B, ROUTER)], true)
  assert.equal(routed.groups.length, 0)
  const entryPoint = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789'
  const bundled = classifyEarlyBuyers([fact(A, TX1, C, entryPoint), fact(B, TX2, C, entryPoint)], true)
  assert.equal(bundled.groups.length, 0)
})

test('deployer airdrop and pool/manager/locker/burn recipients are not buys', () => {
  const locker = LP_LOCK_BURN_REGISTRY.lockersByChain.eth[0]
  const facts = deriveBuyFacts({ transfers: [transfer(C, A, BigInt(10)), transfer(POOL, POOL, BigInt(10)), transfer(POOL, locker, BigInt(10)), transfer(POOL, '0x000000000000000000000000000000000000dead', BigInt(10))], poolSources: new Set([POOL]), infrastructure: new Set([POOL, locker, TOKEN]), signer: C, called: null, txHash: TX1, block: 100, transactionIndex: 0 })
  assert.equal(facts.length, 0)
})

test('one transaction splitting pool-sourced tokens to three wallets is T1 with tx proof', () => {
  const facts = deriveBuyFacts({ transfers: [transfer(POOL, ROUTER, BigInt(30)), transfer(ROUTER, A, BigInt(10)), transfer(ROUTER, B, BigInt(10)), transfer(ROUTER, C, BigInt(10))], poolSources: new Set([POOL]), infrastructure: new Set([POOL, ROUTER, TOKEN]), signer: A, called: ROUTER, txHash: TX1, block: 100, transactionIndex: 0, pool: POOL, timestampSec: 1000 })
  const result = classifyEarlyBuyers(facts, true)
  assert.equal(result.groups.filter((g) => g.tier === 'T1').length, 1)
  assert.deepEqual(result.groups[0].wallets, [A, B, C])
  assert.deepEqual(result.groups[0].transactions, [TX1])
  assert.equal(result.groups[0].boughtWithinEarlySetPct, 100)
  assert.equal(result.groups[0].associationType, 'shared_transaction_delivery')
  assert.match(result.groups[0].reason, /payment.*not proven/i)
  assert.equal(result.buyers.length, 3)
  assert.ok(result.buyers.every((buyer) => buyer.evidence?.[0]?.reason === 'pool_sourced_token_delivery_in_swap_transaction'))
  assert.ok(result.buyers.every((buyer) => buyer.purchaseProven === false))
})

test('same signer across separate transactions is association, not T1 coordination proof', () => {
  const result = classifyEarlyBuyers([fact(A, TX1, C, ROUTER), fact(B, TX2, C, ROUTER)], true)
  assert.equal(result.groups.filter((g) => g.tier === 'T1').length, 0)
  assert.equal(result.groups[0]?.tier, 'T2')
})

test('estimated launch has raw buyers but no T1 claims', () => {
  const result = classifyEarlyBuyers([fact(A, TX1, C), fact(B, TX1, C)], false)
  assert.equal(result.buyers.length, 2)
  assert.equal(result.groups.length, 0)
})

test('non-public shared target is only a T2 association', () => {
  const target = '0x' + '9'.repeat(40)
  const result = classifyEarlyBuyers([fact(A, TX1, A, target), fact(B, TX2, B, target)], true)
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].tier, 'T2')
  assert.match(result.groups[0].reason, /association, not proof/)
})

test('Base and Ethereum windows are bounded independently', () => {
  assert.equal(earlyWindowEnd('base', 100), 119)
  assert.equal(earlyWindowEnd('eth', 100), 104)
})

test('Ethereum window stops when real block timestamps reach about sixty seconds', async () => {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const queried: number[] = []
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const block = Number(BigInt(String(params[0]))); queried.push(block)
      return { timestamp: `0x${({ 100: 1000, 101: 1012, 102: 1024, 103: 1061 } as Record<number, number>)[block].toString(16)}` } as T
    }
    return [] as T
  } }
  const result = await readEarlyWindow({ rpc, chain: 'eth', token: TOKEN, launches: [{ status: 'verified', block: 100, pool: POOL, protocol: 'v2', creationTx: TX1, liquidityTx: TX1 }] })
  assert.equal(result.endBlock, 103)
  assert.deepEqual(queried, [100, 101, 102, 103])
})

test('Uniswap V2 factory creation plus first Mint verifies the launch block', async () => {
  const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
  const mint = toEventSelector('Mint(address,uint256,uint256)')
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const requested = params[0] === 'latest' ? 200 : Number(BigInt(String(params[0])))
      return { number: `0x${requested.toString(16)}`, timestamp: `0x${(requested * 2).toString(16)}` } as T
    }
    const filter = params[0] as { address: string }
    if (filter.address.toLowerCase() === POOL) return [{ address: POOL, topics: [mint], blockNumber: '0x65', transactionHash: TX2 }] as T
    return [{ address: filter.address, topics: [pairCreated, topic(TOKEN), topic('0x' + '3'.repeat(40))], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: '0x64', transactionHash: TX1 }] as T
  } }
  const launch = await discoverLaunch(rpc, 'base', TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: 200_000 }])
  assert.equal(launch.status, 'verified')
  assert.equal(launch.block, 101)
  assert.equal(launch.creationTx, TX1)
  assert.equal(launch.liquidityTx, TX2)
})

test('factory event absent leaves timestamp-derived launch estimated, not verified', async () => {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const requested = params[0] === 'latest' ? 200 : Number(BigInt(String(params[0])))
      return { number: `0x${requested.toString(16)}`, timestamp: `0x${(requested * 2).toString(16)}` } as T
    }
    return [] as T
  } }
  const launch = await discoverLaunch(rpc, 'base', TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: 200_000 }])
  assert.equal(launch.status, 'estimated')
  assert.equal(launch.creationTx, null)
})

test('earlier unresolved pool prevents a later verified pool from certifying complete launch coverage', async () => {
  const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
  const mint = toEventSelector('Mint(address,uint256,uint256)')
  const older = '0x' + '4'.repeat(40)
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 200 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
    }
    const filter = params[0] as { address: string; topics?: string[] }
    if (filter.address.toLowerCase() === POOL) return [{ address: POOL, topics: [mint], blockNumber: '0x65', transactionHash: TX2 }] as T
    if (filter.topics?.[1]?.toLowerCase() === topic(TOKEN).toLowerCase()) return [{ address: filter.address, topics: [pairCreated, topic(TOKEN), topic(C)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: '0x64', transactionHash: TX1 }] as T
    return [] as T
  } }
  const result = await discoverLaunches(rpc, 'base', TOKEN, [{ address: older, dex: 'uniswap v2', createdAt: 180_000 }, { address: POOL, dex: 'uniswap v2', createdAt: 200_000 }])
  assert.equal(result.primary.pool, POOL)
  assert.equal(result.earliestDiscoveredPool, older)
  assert.equal(result.earliestVerifiedPool, POOL)
  assert.equal(result.complete, false)
  assert.equal(result.candidates[0].outcome, 'estimated')
})

test('pool candidate cap explicitly records skipped migrated pools', async () => {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> {
    budget.record(method)
    if (method === 'eth_getBlockByNumber') return { number: '0xc8', timestamp: '0x190' } as T
    return [] as T
  } }
  const rows = Array.from({ length: 4 }, (_, i) => ({ address: `0x${String(i + 2).repeat(40)}`, dex: 'uniswap v2', createdAt: 100_000 + i }))
  const result = await discoverLaunches(rpc, 'base', TOKEN, rows)
  assert.equal(result.complete, false)
  assert.equal(result.candidates[3].outcome, 'skipped')
  assert.equal(result.candidates[3].reason, 'pool_candidate_cap_3')
})

test('window caps pools at three and receipts at fifty, fetching a shared block once', async () => {
  const swapTopic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  let poolCalls = 0, blockReceiptCalls = 0, txReceiptCalls = 0
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method === 'eth_getLogs') {
      poolCalls++
      const filter = params[0] as { address: string }
      return Array.from({ length: 60 }, (_, i) => ({ address: filter.address, topics: [swapTopic], data: '0x', blockNumber: '0x64', transactionHash: `0x${i.toString(16).padStart(64, '0')}`, logIndex: `0x${i.toString(16)}` })) as T
    }
    if (method === 'eth_getBlockReceipts') {
      blockReceiptCalls++
      return Array.from({ length: 60 }, (_, i) => ({ transactionHash: `0x${i.toString(16).padStart(64, '0')}`, status: '0x0', blockNumber: '0x64', transactionIndex: '0x0', logs: [] })) as T
    }
    txReceiptCalls++
    return { status: '0x0', logs: [] } as T
  } }
  const launches = Array.from({ length: 5 }, (_, i) => ({ status: 'verified' as const, block: 100, pool: `0x${String(i + 2).repeat(40)}`, creationTx: TX1, liquidityTx: TX1, protocol: 'v2' as const }))
  const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches })
  assert.equal(poolCalls, 3)
  assert.equal(blockReceiptCalls, 1)
  assert.equal(txReceiptCalls, 0)
  assert.equal(result.pools.length, 3)
  assert.ok(result.reasons.includes('receipt_cap_50'))
})

test('mid-window budget exhaustion stays partial and preserves already observed facts', async () => {
  const swapTopic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
  const transferTopic = toEventSelector('Transfer(address,address,uint256)')
  const budget = createAlchemyCallBudget({ maxCalls: 2, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    if (method === 'eth_getLogs') return [TX1, TX2].map((hash, i) => ({ address: POOL, topics: [swapTopic], blockNumber: '0x64', transactionHash: hash, logIndex: `0x${i}` })) as T
    return { transactionHash: TX1, from: A, to: ROUTER, status: '0x1', blockNumber: '0x64', transactionIndex: '0x0', logs: [{ address: POOL, topics: [swapTopic], transactionHash: TX1, logIndex: '0x0' }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(A)], data: `0x${'0'.repeat(63)}a` }] } as T
  } }
  const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches: [{ status: 'verified', block: 100, pool: POOL, protocol: 'v2', creationTx: TX1, liquidityTx: TX1 }] })
  assert.equal(result.facts.length, 1)
  assert.equal(result.capped, true)
  assert.ok(result.reasons.length >= 1)
})

test('provisional result cannot be permanently stored', async () => {
  assert.equal(windowIsFinalized(119, 119), false)
  assert.equal(windowIsFinalized(119, 120), true)
  assert.equal(windowIsFinalized(119, null), false)
  const intel: EarlyBuyerIntel = { status: 'estimated', launch: { status: 'estimated', block: 100, pool: POOL, creationTx: null, liquidityTx: null }, window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 0 }, buyers: [], groups: [], sameBlockCount: 0, launchDistributions: [], coverage: { capped: false, reasons: [], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 0, cu: 0 } }
  assert.equal(canPersistFinalizedEvidence(intel, false), false)
  assert.equal(canPersistFinalizedEvidence({ ...intel, status: 'partial', coverage: { capped: true, reasons: ['receipt_cap_50'], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE } }, true), false)
  assert.equal(canPersistFinalizedEvidence({ ...intel, status: 'partial', coverage: { capped: true, reasons: ['rpc_transport_failed'], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE } }, true), false)
  assert.equal(await writeEarlyBuyerEvidence('base', TOKEN, intel, false), false)
  assert.equal(validEarlyBuyerCacheEnvelope({ version: EARLY_BUYER_VERSION - 1, chain: 'base', token: TOKEN, intel }, 'base', TOKEN, false), false)
  assert.equal(validEarlyBuyerCacheEnvelope({ version: EARLY_BUYER_VERSION, chain: 'eth', token: TOKEN, intel }, 'base', TOKEN, false), false)
  assert.equal(validEarlyBuyerCacheEnvelope({ version: EARLY_BUYER_VERSION, chain: 'base', token: TOKEN, intel }, 'base', TOKEN, true), false)
  assert.equal(validEarlyBuyerCacheEnvelope({ version: EARLY_BUYER_VERSION, chain: 'base', token: TOKEN, intel: { ...intel, launch: { ...intel.launch, pool: 'bad' } } }, 'base', TOKEN, false), false)
})

test('a strictly later pool does not block verified persistence; earlier, equal, and unknown times still do', async () => {
  const later = '0x' + '3'.repeat(40)
  const intel: EarlyBuyerIntel = {
    status: 'verified',
    launch: { status: 'verified', block: 100, pool: POOL, creationTx: TX1, liquidityTx: TX2 },
    window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 1 },
    buyers: [{ wallet: A, purchaseProven: false, boughtRaw: '10', heldRaw: null, transactions: [TX1], blocks: [100], evidence: [{ txHash: TX1, pool: POOL, block: 100, timestampSec: 1_700_000_000, reason: 'pool_sourced_token_delivery_in_swap_transaction' }] }],
    groups: [], sameBlockCount: 0, launchDistributions: [],
    coverage: { capped: false, reasons: [], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE },
    budget: { calls: 1, cu: 16 },
    discovery: { earliestDiscoveredPool: POOL, earliestVerifiedPool: POOL, complete: true, candidates: [
      { pool: POOL, createdAt: 1_000, outcome: 'verified', reason: 'factory_creation_and_first_liquidity_events_verified' },
      { pool: later, createdAt: 2_000, outcome: 'estimated', reason: 'later_pool' },
    ] },
  }
  assert.equal(canPersistFinalizedEvidence(intel, true), true)
  assert.equal(validEarlyBuyerCacheEnvelope({ version: EARLY_BUYER_VERSION, chain: 'base', token: TOKEN, intel }, 'base', TOKEN, true), true)
  const equalTime = { ...intel, discovery: { ...intel.discovery!, candidates: [intel.discovery!.candidates[0]!, { pool: later, createdAt: 1_000, outcome: 'estimated' as const, reason: 'equal_time' }] } }
  const unknownTime = { ...intel, discovery: { ...intel.discovery!, candidates: [intel.discovery!.candidates[0]!, { pool: later, createdAt: null, outcome: 'unresolved' as const, reason: 'unknown_time' }] } }
  const earlier = { ...intel, discovery: { ...intel.discovery!, earliestDiscoveredPool: later, candidates: [{ pool: later, createdAt: 500, outcome: 'estimated' as const, reason: 'earlier_pool' }, intel.discovery!.candidates[0]!] } }
  assert.equal(canPersistFinalizedEvidence(equalTime, true), false)
  assert.equal(canPersistFinalizedEvidence(unknownTime, true), false)
  assert.equal(canPersistFinalizedEvidence(earlier, true), false)
  assert.equal(validEarlyBuyerCacheEnvelope({ version: EARLY_BUYER_VERSION, chain: 'base', token: TOKEN, intel: earlier }, 'base', TOKEN, false), false)
  const untimedLater = { ...intel, discovery: { ...intel.discovery!, candidates: [intel.discovery!.candidates[0]!, { pool: later, createdAt: null, outcome: 'skipped' as const, reason: 'created_after_verified_launch' }] } }
  assert.equal(canPersistFinalizedEvidence(untimedLater, true), true)
  assert.equal(await writeEarlyBuyerEvidence('base', TOKEN, earlier, true), false)
})

test('current holdings are read in one bounded Multicall3 eth_call and retain exact raw balances', async () => {
  const abi = [{ type: 'function', name: 'aggregate3', stateMutability: 'view', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const
  const results = [{ success: true, returnData: `0x${BigInt(7).toString(16).padStart(64, '0')}` }, { success: true, returnData: `0x${BigInt(3).toString(16).padStart(64, '0')}` }]
  // viem 2.7's type for a single tuple[] output is flatter than its runtime encoder input.
  const raw = encodeFunctionResult({ abi, functionName: 'aggregate3', result: [results] as unknown as Array<{ success: boolean; returnData: `0x${string}` }> })
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  let calls = 0
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> { assert.equal(method, 'eth_call'); calls++; budget.record(method); return raw as T } }
  const intel: EarlyBuyerIntel = { status: 'verified', launch: { status: 'verified', block: 100, pool: POOL, creationTx: TX1, liquidityTx: TX2 }, window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 2 }, buyers: [{ wallet: A, boughtRaw: '10', heldRaw: null, transactions: [TX1], blocks: [100] }, { wallet: B, boughtRaw: '10', heldRaw: null, transactions: [TX1], blocks: [100] }], groups: [{ tier: 'T1', wallets: [A, B], transactions: [TX1], reason: 'same transaction', boughtWithinEarlySetPct: 100, heldWithinEarlySetPct: null }], sameBlockCount: 2, launchDistributions: [], coverage: { capped: false, reasons: [], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE }, budget: { calls: 0, cu: 0 } }
  const result = await hydrateHoldings(rpc, TOKEN, intel)
  assert.equal(calls, 1)
  assert.deepEqual(result.buyers.map((b) => b.heldRaw), ['7', '3'])
  assert.equal(result.groups[0].heldWithinEarlySetPct, 100)
})

test('free is cached-only and paid analysis fails closed without quota KV', async () => {
  assert.deepEqual(await reserveEarlyBuyerAnalysis('user', 'free', 'base', TOKEN), { allowed: false, reason: 'free_cached_only' })
  const names = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const
  const previous = names.map((name) => process.env[name])
  try {
    names.forEach((name) => { delete process.env[name] })
    assert.deepEqual(await reserveEarlyBuyerAnalysis('user', 'pro', 'base', TOKEN), { allowed: false, reason: 'quota_store_unavailable' })
  } finally { names.forEach((name, i) => { if (previous[i] == null) delete process.env[name]; else process.env[name] = previous[i] }) }
})

test('different users share one cold-token reservation; failed worker lock expires and permits recovery', async () => {
  const locks = new Map<string, string>()
  let globalCu = 0
  const evalScript = async (_script: string, keys: string[], args: Array<string | number>): Promise<unknown> => {
    if (keys.length === 4) {
      const [, , userLock, tokenLock] = keys
      if (locks.has(userLock)) return 'locked'
      if (locks.has(tokenLock)) return 'token_in_progress'
      if (globalCu + Number(args[1]) > Number(args[2])) return 'global_cu_cap'
      locks.set(userLock, String(args[3])); locks.set(tokenLock, String(args[3])); globalCu += Number(args[1])
      return 'ok'
    }
    const [, userLock, tokenLock] = keys
    if (locks.get(userLock) !== args[0]) return 0
    locks.delete(userLock)
    if (locks.get(tokenLock) === args[0]) locks.delete(tokenLock)
    globalCu -= Number(args[1])
    return 1
  }
  const first = await reserveEarlyBuyerAnalysis('user-a', 'pro', 'base', TOKEN, { evalScript })
  const second = await reserveEarlyBuyerAnalysis('user-b', 'pro', 'base', TOKEN, { evalScript })
  assert.equal(first.allowed, true)
  assert.deepEqual(second, { allowed: false, reason: 'token_in_progress' })
  assert.equal(globalCu, 2_000)
  if (first.allowed) await first.settle(700)
  assert.equal(globalCu, 700)
  const next = await reserveEarlyBuyerAnalysis('user-b', 'pro', 'base', TOKEN, { evalScript })
  assert.equal(next.allowed, true)
  // Simulate Redis TTL after a worker dies before settlement.
  locks.clear()
  const afterExpiry = await reserveEarlyBuyerAnalysis('user-c', 'pro', 'base', TOKEN, { evalScript })
  assert.equal(afterExpiry.allowed, true)
})

test('quota policy is free cached-only, Pro 20, Elite 60, with a hard global CU ceiling', () => {
  assert.deepEqual(earlyBuyerQuotaPolicy('free'), { userDailyAnalyses: 0, globalDailyCu: 200000, reservedCuPerAnalysis: 2000 })
  assert.equal(earlyBuyerQuotaPolicy('pro').userDailyAnalyses, 20)
  assert.equal(earlyBuyerQuotaPolicy('elite').userDailyAnalyses, 60)
})

test('standalone RPC meter enforces 2,000 CU and never calls the provider past the cap', async () => {
  const previous = process.env.ALCHEMY_BASE_KEY
  process.env.ALCHEMY_BASE_KEY = 'mock-only'
  let fetches = 0
  const mockFetch: typeof fetch = async () => { fetches++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), { status: 200 }) }
  try {
    const rpc = createEarlyBuyerRpc('base', mockFetch)
    for (let i = 0; i < 26; i++) await rpc.call('eth_getLogs', [])
    await assert.rejects(() => rpc.call('eth_getLogs', []), (error: unknown) => error instanceof EarlyBuyerRpcError && error.reason === 'estimated_cu_budget_exceeded')
    assert.equal(fetches, 26)
    assert.equal(rpc.budget.estimatedCuUsed(), 1950)
  } finally { if (previous == null) delete process.env.ALCHEMY_BASE_KEY; else process.env.ALCHEMY_BASE_KEY = previous }
})

test('risk output is unchanged by extra early-buyer data and restricted modules do not import it', () => {
  const raw = { chain: 'base', liquidity: 100000, holderDistribution: { top10: 30 }, honeypot: { isHoneypot: false } }
  assert.deepEqual(calculateCortexScoreV2(raw), calculateCortexScoreV2({ ...raw, earlyBuyerIntel: { status: 'verified', groups: [{ tier: 'T1' }] } }))
  for (const file of ['lib/devClusterDiagnosis.ts', 'lib/server/devClusterDiagnosis.ts', 'lib/clusterMap.ts', 'lib/liquidityCustody.ts', 'lib/devControlCustodyPolicy.ts', 'lib/holderFallbackPolicy.ts', 'lib/server/solana/riskEngine.ts', 'lib/token/scoring.ts']) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), file), 'utf8'), /(?:from|require\()\s*['"][^'"]*earlyBuyers/)
  }
})

test('a later estimated pool does not block an earlier verified launch', async () => {
  const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
  const mint = toEventSelector('Mint(address,uint256,uint256)')
  const later = '0x' + '5'.repeat(40)
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 200 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
    }
    const filter = params[0] as { address: string; topics?: string[] }
    if (filter.address.toLowerCase() === POOL) return [{ address: POOL, topics: [mint], blockNumber: '0x5b', transactionHash: TX2 }] as T
    if (filter.topics?.[1]?.toLowerCase() === topic(TOKEN).toLowerCase() && filter.address.toLowerCase() !== later) {
      return [{ address: filter.address, topics: [pairCreated, topic(TOKEN), topic(C)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: '0x5a', transactionHash: TX1 }] as T
    }
    return [] as T
  } }
  const result = await discoverLaunches(rpc, 'base', TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: 180_000 }, { address: later, dex: 'uniswap v2', createdAt: 220_000 }])
  assert.equal(result.primary.pool, POOL)
  assert.equal(result.primary.status, 'verified')
  assert.equal(result.earliestVerifiedPool, POOL)
  assert.equal(result.complete, true)
  assert.equal(result.incompleteReason, null)
  assert.equal(result.candidates[1].outcome, 'estimated')
})

test('historical lookup returns the exact block on a tall chain without exhausting the call budget', async () => {
  const latest = 21_000_000
  const target = 12_345_678
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  let headerCalls = 0
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    assert.equal(method, 'eth_getBlockByNumber')
    const check = budget.check(method)
    assert.equal(check.allowed, true)
    budget.record(method)
    headerCalls++
    const n = params[0] === 'latest' ? latest : Number(BigInt(String(params[0])))
    assert.ok(n >= 0 && n <= latest)
    return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
  } }
  const launch = await discoverLaunch(rpc, 'base', TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: target * 2_000 }])
  assert.equal(launch.status, 'estimated')
  assert.equal(launch.block, target)
  assert.equal(launch.creationTx, null)
  assert.ok(headerCalls <= 8, `header calls ${headerCalls}`)
  assert.ok(budget.callsUsed() <= 60)
  assert.ok(budget.estimatedCuUsed() <= 2000)
})

test('a wrong nominal block time still resolves only from real headers or fails closed', async () => {
  const latest = 21_000_000
  const target = 12_345_678
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  let headerCalls = 0
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    headerCalls++
    const n = params[0] === 'latest' ? latest : Number(BigInt(String(params[0])))
    return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
  } }
  const launch = await discoverLaunch(rpc, 'eth', TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: target * 2_000 }])
  assert.equal(launch.creationTx, null)
  if (launch.status === 'estimated') assert.equal(launch.block, target)
  else assert.equal(launch.block, null)
  assert.ok(headerCalls <= 16, `header calls ${headerCalls}`)
  assert.ok(budget.estimatedCuUsed() <= 2000)
})

test('discovery plus the early window finishes inside 60 calls and 2,000 estimated CU', async () => {
  const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
  const mint = toEventSelector('Mint(address,uint256,uint256)')
  const swapTopic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
  const transferTopic = toEventSelector('Transfer(address,address,uint256)')
  const later = '0x' + '5'.repeat(40)
  const latest = 21_000_000
  const launchBlock = 12_345_678
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const methods: string[] = []
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    methods.push(method)
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? latest : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address?: string; topics?: Array<string | null> }
      const address = filter.address?.toLowerCase()
      if (address === POOL && filter.topics?.[0] === mint) return [{ address: POOL, topics: [mint], blockNumber: `0x${launchBlock.toString(16)}`, transactionHash: TX2 }] as T
      if (address === POOL && filter.topics?.[0] === swapTopic) {
        return Array.from({ length: 40 }, (_, i) => ({ address: POOL, topics: [swapTopic], blockNumber: `0x${(launchBlock + (i % 4)).toString(16)}`, transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`, logIndex: `0x${i.toString(16)}` })) as T
      }
      if (filter.topics?.[0] === pairCreated && filter.topics?.[1]?.toLowerCase() === topic(TOKEN).toLowerCase() && address !== later) {
        return [{ address, topics: [pairCreated, topic(TOKEN), topic(C)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: `0x${(launchBlock - 1).toString(16)}`, transactionHash: TX1 }] as T
      }
      return [] as T
    }
    if (method === 'eth_getBlockReceipts') {
      const block = Number(BigInt(String(params[0])))
      return Array.from({ length: 40 }, (_, i) => launchBlock + (i % 4)).flatMap((candidate, i) => candidate === block ? [{
        transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`, from: A, to: ROUTER, status: '0x1', blockNumber: `0x${block.toString(16)}`, transactionIndex: `0x${i.toString(16)}`,
        logs: [{ address: POOL, topics: [swapTopic], logIndex: `0x${i.toString(16)}` }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(A)], data: `0x${'0'.repeat(63)}a` }],
      }] : []) as T
    }
    throw new Error(`unexpected ${method}`)
  } }
  const discovered = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: launchBlock * 2_000 },
    { address: later, dex: 'uniswap v2', createdAt: (launchBlock + 5_000) * 2_000 },
  ])
  assert.equal(discovered.complete, true)
  assert.equal(discovered.primary.block, launchBlock)
  const window = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches: discovered.pools })
  assert.equal(window.facts.length, 40)
  assert.equal(methods.filter((method) => method === 'eth_getTransactionReceipt').length, 0)
  assert.ok(budget.callsUsed() <= 60, `calls ${budget.callsUsed()}`)
  assert.ok(budget.estimatedCuUsed() <= 2000, `cu ${budget.estimatedCuUsed()}`)
})

test('a Uniswap V3 swap 33 blocks after liquidity attributes the transfer recipient, not the indexed router', async () => {
  const v3Swap = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)')
  const transferTopic = toEventSelector('Transfer(address,address,uint256)')
  const other = '0x' + '9'.repeat(40)
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[] }
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock))
      if (filter.address.toLowerCase() !== POOL || filter.topics[0] !== v3Swap || from > 133 || to < 133) return [] as T
      return [
        { address: POOL, topics: [v3Swap, topic(ROUTER), topic(B)], blockNumber: '0x85', transactionHash: TX1, logIndex: '0x0' },
        { address: other, topics: [v3Swap, topic(ROUTER), topic(B)], blockNumber: '0x85', transactionHash: TX2, logIndex: '0x1' },
      ] as T
    }
    return { transactionHash: TX1, from: B, to: ROUTER, status: '0x1', blockNumber: '0x85', transactionIndex: '0x1', logs: [
      { address: POOL, topics: [v3Swap, topic(ROUTER), topic(B)], transactionHash: TX1, logIndex: '0x0' },
      { address: TOKEN, topics: [transferTopic, topic(POOL), topic(A)], data: `0x${'0'.repeat(63)}a`, transactionHash: TX1, logIndex: '0x2' },
    ] } as T
  } }
  const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches: [{ status: 'verified', block: 100, pool: POOL, protocol: 'v3', creationTx: TX1, liquidityTx: TX1 }] })
  assert.equal(result.startBlock, 133)
  assert.deepEqual(result.facts.map((fact) => fact.wallet), [A])
  assert.equal(result.facts.some((fact) => fact.wallet === ROUTER || fact.wallet === B), false)
  assert.ok(budget.callsUsed() <= 60)
  assert.ok(budget.estimatedCuUsed() <= 2000)
})

test('a Uniswap V2 swap 67 blocks after liquidity is found, and a swap past the lookahead is not', async () => {
  const v2Swap = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
  const transferTopic = toEventSelector('Transfer(address,address,uint256)')
  const run = async (tradeBlock: number) => {
    const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
    const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
      const check = budget.check(method)
      if (!check.allowed) throw new Error(check.reason)
      budget.record(method)
      if (method === 'eth_getLogs') {
        const filter = params[0] as { fromBlock: string; toBlock: string; topics: string[] }
        const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock))
        if (filter.topics[0] !== v2Swap || from > tradeBlock || to < tradeBlock) return [] as T
        return [{ address: POOL, topics: [v2Swap, topic(B), topic(ROUTER)], blockNumber: `0x${tradeBlock.toString(16)}`, transactionHash: TX1, logIndex: '0x0' }] as T
      }
      return { transactionHash: TX1, from: B, to: ROUTER, status: '0x1', blockNumber: `0x${tradeBlock.toString(16)}`, transactionIndex: '0x0', logs: [
        { address: POOL, topics: [v2Swap, topic(B), topic(ROUTER)], transactionHash: TX1, logIndex: '0x0' },
        { address: TOKEN, topics: [transferTopic, topic(POOL), topic(A)], data: `0x${'0'.repeat(63)}a`, transactionHash: TX1 },
      ] } as T
    } }
    const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches: [{ status: 'verified', block: 100, pool: POOL, protocol: 'v2', creationTx: TX1, liquidityTx: TX1 }] })
    return { result, calls: budget.callsUsed(), cu: budget.estimatedCuUsed() }
  }
  const found = await run(167)
  assert.equal(found.result.startBlock, 167)
  assert.deepEqual(found.result.facts.map((fact) => fact.wallet), [A])
  assert.ok(found.calls <= 60)
  assert.ok(found.cu <= 2000)
  const missed = await run(191)
  assert.equal(missed.result.facts.length, 0)
  assert.ok(missed.result.reasons.includes('no_swap_within_bounded_lookahead'))
})

test('Aerodrome classic ignores a Uniswap V2 swap and keeps the Solidly swap recipient path', async () => {
  const aeroSwap = toEventSelector('Swap(address,address,uint256,uint256,uint256,uint256)')
  const v2Swap = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
  const transferTopic = toEventSelector('Transfer(address,address,uint256)')
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    budget.record(method)
    if (method !== 'eth_getLogs') return { transactionHash: TX1, from: B, to: ROUTER, status: '0x1', blockNumber: '0x64', transactionIndex: '0x0', logs: [
      { address: POOL, topics: [aeroSwap, topic(B), topic(ROUTER)], transactionHash: TX1, logIndex: '0x0' },
      { address: TOKEN, topics: [transferTopic, topic(POOL), topic(A)], data: `0x${'0'.repeat(63)}a`, transactionHash: TX1 },
    ] } as T
    const filter = params[0] as { topics: string[] }
    if (filter.topics[0] !== aeroSwap) return [] as T
    return [
      { address: POOL, topics: [aeroSwap, topic(B), topic(ROUTER)], blockNumber: '0x64', transactionHash: TX1, logIndex: '0x0' },
      { address: POOL, topics: [v2Swap, topic(B), topic(ROUTER)], blockNumber: '0x64', transactionHash: TX2, logIndex: '0x1' },
    ] as T
  } }
  const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches: [{ status: 'verified', block: 100, pool: POOL, protocol: 'aerodrome_v2', creationTx: TX1, liquidityTx: TX1 }] })
  assert.deepEqual(result.facts.map((fact) => fact.wallet), [A])
  assert.equal(result.facts.some((fact) => fact.txHash === TX2), false)
})

test('untimed later pools with no code do not block, and code already present at launch still does', async () => {
  const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
  const mint = toEventSelector('Mint(address,uint256,uint256)')
  const earlier = '0x' + '4'.repeat(40)
  const laterPools = Array.from({ length: 6 }, (_, i) => `0x${String(i + 5).repeat(40)}`)
  const codeAt = new Map<string, string>([[earlier, '0x60016000']])
  const checked: string[] = []
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    if (method === 'eth_getCode') {
      const address = String(params[0]).toLowerCase()
      checked.push(address)
      return (codeAt.get(address) ?? '0x') as T
    }
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 200 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
    }
    const filter = params[0] as { address: string; topics?: string[] }
    if (filter.address.toLowerCase() === POOL) return [{ address: POOL, topics: [mint], blockNumber: '0x65', transactionHash: TX2 }] as T
    if (filter.topics?.[1]?.toLowerCase() === topic(TOKEN).toLowerCase()) return [{ address: filter.address, topics: [pairCreated, topic(TOKEN), topic(C)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: '0x64', transactionHash: TX1 }] as T
    return [] as T
  } }
  const blocked = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: 200_000 },
    { address: earlier, dex: 'uniswap v2', createdAt: null },
    ...laterPools.map((address) => ({ address, dex: 'uniswap v2', createdAt: null })),
  ])
  assert.equal(blocked.primary.pool, POOL)
  assert.equal(blocked.complete, false)
  assert.equal(blocked.candidates.find((candidate) => candidate.pool === earlier)?.reason, 'pool_creation_timestamp_unavailable')
  assert.equal(blocked.candidates.filter((candidate) => candidate.reason === 'created_after_verified_launch').length, laterPools.length)
  assert.equal(checked.includes(POOL), false)
  const open = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: 200_000 },
    ...laterPools.map((address) => ({ address, dex: 'uniswap v2', createdAt: null })),
  ])
  assert.equal(open.complete, true)
  assert.equal(open.incompleteReason, null)
  assert.ok(budget.callsUsed() <= 60)
  assert.ok(budget.estimatedCuUsed() <= 2000)
})

test('verified persistence is the bounded first-trade window and keeps its evidence in cache', async () => {
  const later = '0x' + '3'.repeat(40)
  const intel: EarlyBuyerIntel = {
    status: 'verified',
    launch: { status: 'verified', block: 100, pool: POOL, creationTx: TX1, liquidityTx: TX2 },
    window: { startBlock: 133, endBlock: 152, pools: [POOL], buysObserved: 1 },
    buyers: [{ wallet: A, purchaseProven: false, boughtRaw: '10', heldRaw: '4', transactions: [TX1], blocks: [133], evidence: [{ txHash: TX1, pool: POOL, block: 133, timestampSec: 1_704_655_911, reason: 'pool_sourced_token_delivery_in_swap_transaction' }] }],
    groups: [], sameBlockCount: 0, launchDistributions: [],
    coverage: { capped: false, reasons: [], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE },
    budget: { calls: 4, cu: 80 },
    discovery: { earliestDiscoveredPool: POOL, earliestVerifiedPool: POOL, complete: true, candidates: [
      { pool: POOL, createdAt: 1_000, outcome: 'verified', reason: 'factory_creation_and_first_liquidity_events_verified' },
      { pool: later, createdAt: null, outcome: 'skipped', reason: 'created_after_verified_launch' },
    ] },
  }
  assert.equal(intel.coverage.scope, 'bounded_first_trade_window')
  assert.equal(canPersistFinalizedEvidence(intel, true), true)
  assert.equal(canPersistFinalizedEvidence({ ...intel, coverage: { ...intel.coverage, scope: 'all_launch_buyers' as typeof EARLY_BUYER_WINDOW_SCOPE } }, true), false)
  assert.equal(canPersistFinalizedEvidence({ ...intel, buyers: [{ ...intel.buyers[0]!, evidence: [] }] }, true), false)
  assert.equal(canPersistFinalizedEvidence({ ...intel, buyers: [{ ...intel.buyers[0]!, evidence: [{ ...intel.buyers[0]!.evidence![0]!, timestampSec: null }] }] }, true), false)
  assert.equal(canPersistFinalizedEvidence({ ...intel, discovery: { ...intel.discovery!, complete: false } }, true), false)
  assert.equal(canPersistFinalizedEvidence({ ...intel, coverage: { ...intel.coverage, reasons: ['receipt_cap_50'] } }, true), false)
  const earlier = { ...intel, discovery: { ...intel.discovery!, candidates: [{ pool: later, createdAt: null, outcome: 'unresolved' as const, reason: 'pool_creation_timestamp_unavailable' }, intel.discovery!.candidates[0]!] } }
  assert.equal(canPersistFinalizedEvidence(earlier, true), false)
  assert.equal(await writeEarlyBuyerEvidence('base', TOKEN, intel, true), false)
  const cached = await readEarlyBuyerEvidence('base', TOKEN)
  assert.equal(cached?.launch.pool, POOL)
  assert.equal(cached?.window.startBlock, 133)
  assert.equal(cached?.buyers[0]?.evidence?.[0]?.txHash, TX1)
  assert.equal(cached?.coverage.scope, EARLY_BUYER_WINDOW_SCOPE)
  assert.equal(cached?.coverage.reasons.length, 0)
  const envelope = await getTokenCache<{ version: number; intel: EarlyBuyerIntel }>(`early-buyers:provisional:v${EARLY_BUYER_VERSION}:base:${TOKEN}`)
  assert.equal(envelope?.version, EARLY_BUYER_VERSION)
  assert.equal(validEarlyBuyerCacheEnvelope(envelope, 'base', TOKEN, false), true)
  assert.equal(validEarlyBuyerCacheEnvelope(envelope, 'base', TOKEN, true), true)
  const sql = readFileSync(join(process.cwd(), 'supabase/token-launch-buyers.sql'), 'utf8')
  assert.match(sql, /bounded_first_trade_window/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /version = 2/)
  assert.match(sql, /status = 'verified'/)
  assert.doesNotMatch(sql, /create policy/i)
  assert.match(sql, /grant select, insert, update, delete on table public\.token_launch_buyers to service_role/)
  assert.match(sql, /revoke all privileges on table public\.token_launch_buyers from anon, authenticated/)
  assert.doesNotMatch(sql, /grant .+ to anon/i)
  assert.doesNotMatch(sql, /grant .+ to authenticated/i)
  assert.match(sql, /evidence->'window'->>'endBlock'/)
  assert.match(sql, /evidence->'launch'->>'pool' = pool/)
})

test('the analysis pipeline persists the complete evidence object, and a missing proof does not', async () => {
  const token = '0x' + '7'.repeat(40)
  const pool = '0x' + '8'.repeat(40)
  const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
  const mint = toEventSelector('Mint(address,uint256,uint256)')
  const swapTopic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
  const transferTopic = toEventSelector('Transfer(address,address,uint256)')
  const abi = [{ type: 'function', name: 'aggregate3', stateMutability: 'view', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const
  const balance = encodeFunctionResult({ abi, functionName: 'aggregate3', result: [[{ success: true, returnData: `0x${BigInt(9).toString(16).padStart(64, '0')}` }]] as unknown as Array<{ success: boolean; returnData: `0x${string}` }> })
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new Error(check.reason)
    budget.record(method)
    if (method === 'eth_getBlockByNumber') {
      const spec = params[0]
      const n = spec === 'latest' || spec === 'finalized' ? 250 : Number(BigInt(String(spec)))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` } as T
    }
    if (method === 'eth_call') return balance as T
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
  const returned = await analyzeEarlyBuyers('base', token, { rpc, fetchImpl })
  const envelope = await getTokenCache<{ version: number; chain: string; token: string; intel: EarlyBuyerIntel }>(`early-buyers:provisional:v${EARLY_BUYER_VERSION}:base:${token}`)
  const stored = envelope?.intel
  assert.ok(stored)
  assert.equal(envelope?.version, EARLY_BUYER_VERSION)
  assert.equal(stored.launch.status, 'verified')
  assert.equal(stored.launch.pool, pool)
  assert.equal(stored.launch.block, 101)
  assert.equal(stored.window.startBlock, 133)
  assert.ok((stored.window.endBlock ?? 0) >= 133)
  assert.equal(stored.coverage.scope, 'bounded_first_trade_window')
  assert.deepEqual(stored.coverage.reasons, [])
  assert.equal(stored.coverage.capped, false)
  assert.equal(stored.coverage.provisional, false)
  assert.equal(stored.discovery?.complete, true)
  assert.equal(stored.discovery?.earliestVerifiedPool, pool)
  assert.equal(stored.buyers[0]?.wallet, A)
  assert.equal(stored.buyers[0]?.heldRaw, null)
  assert.equal(stored.buyers[0]?.transactions[0], TX1)
  assert.equal(stored.buyers[0]?.evidence?.[0]?.reason, 'pool_sourced_token_delivery_in_swap_transaction')
  assert.equal(stored.buyers[0]?.evidence?.[0]?.pool, pool)
  assert.equal(stored.buyers[0]?.evidence?.[0]?.block, 133)
  assert.equal(stored.buyers[0]?.evidence?.[0]?.timestampSec, 266)
  assert.equal(canPersistFinalizedEvidence(stored, true, 'base', token), true)
  assert.equal(canPersistFinalizedEvidence({ ...stored, buyers: [{ ...stored.buyers[0]!, evidence: [] }] }, true, 'base', token), false)
  assert.equal(returned.buyers[0]?.heldRaw, '9')
  assert.notEqual(returned, stored)
  assert.ok(budget.callsUsed() <= 60)
  assert.ok(budget.estimatedCuUsed() <= 2000)
})

test('captured live summaries cannot be promoted without their missing buyer proofs', { skip: existsSync('/tmp/eb-live-retest.json') ? false : 'captured live summaries are not in this checkout' }, () => {
  const captured = JSON.parse(readFileSync('/tmp/eb-live-retest.json', 'utf8')) as { degen: CapturedScan; pepe: CapturedScan }
  for (const name of ['degen', 'pepe'] as const) {
    const scan = captured[name]
    const replay: EarlyBuyerIntel = {
      status: 'verified',
      launch: scan.launch,
      window: scan.window,
      buyers: scan.sampleWallets.map((buyer) => ({ wallet: buyer.wallet, purchaseProven: false as const, boughtRaw: buyer.boughtRaw, heldRaw: null, transactions: buyer.transactions, blocks: [], evidence: [] })),
      groups: [], sameBlockCount: scan.sameBlockCount, launchDistributions: [],
      coverage: { ...scan.coverage, scope: EARLY_BUYER_WINDOW_SCOPE },
      budget: { calls: scan.reportedBudget.calls, cu: scan.reportedBudget.cu },
      discovery: scan.discovery,
    }
    assert.equal(replay.coverage.scope, 'bounded_first_trade_window')
    assert.equal(canPersistFinalizedEvidence(replay, scan.coverage.provisional === false, scan.chain, scan.token), false)
    assert.equal(scan.buyersWithAcquisitionEvidence > 0, true)
    assert.equal(scan.sampleWallets[0]?.evidenceCount, 1)
  }
})

test('cached launch evidence stays verified when holdings are available, failed, or unavailable', async () => {
  assert.equal(heldRawLabel(null), 'UNAVAILABLE')
  assert.equal(heldRawLabel('0'), '0 raw')
  const verified = (token: string): EarlyBuyerIntel => ({
    status: 'verified', evidenceStatus: 'verified',
    launch: { status: 'verified', block: 101, pool: POOL, creationTx: TX2, liquidityTx: TX2 },
    window: { startBlock: 133, endBlock: 152, pools: [POOL], buysObserved: 2 },
    buyers: [
      { wallet: A, purchaseProven: false, boughtRaw: '10', heldRaw: null, transactions: [TX1], blocks: [133], evidence: [{ txHash: TX1, pool: POOL, block: 133, timestampSec: 1_700_000_000, reason: 'pool_sourced_token_delivery_in_swap_transaction' }] },
      { wallet: B, purchaseProven: false, boughtRaw: '4', heldRaw: null, transactions: [TX1], blocks: [133], evidence: [{ txHash: TX1, pool: POOL, block: 133, timestampSec: 1_700_000_000, reason: 'pool_sourced_token_delivery_in_swap_transaction' }] },
    ],
    groups: [], sameBlockCount: 0, launchDistributions: [],
    coverage: { capped: false, reasons: [], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE },
    budget: { calls: 4, cu: 80 },
    discovery: { earliestDiscoveredPool: POOL, earliestVerifiedPool: POOL, complete: true, candidates: [{ pool: POOL, createdAt: 1_000, outcome: 'verified', reason: 'factory_creation_and_first_liquidity_events_verified' }] },
  })
  const unavailableToken = '0x' + 'e'.repeat(40)
  assert.equal(await writeEarlyBuyerEvidence('base', unavailableToken, verified(unavailableToken), true), false)
  const unavailable = await analyzeEarlyBuyers('base', unavailableToken)
  assert.equal(unavailable.status, 'partial')
  assert.equal(unavailable.evidenceStatus, 'verified')
  assert.equal(unavailable.holdingsStatus, 'unavailable')
  assert.equal(unavailable.buyers[0]?.heldRaw, null)
  assert.deepEqual(earlyBuyerDisplayStatus(unavailable), { launch: 'VERIFIED', holdings: 'UNAVAILABLE' })
  assert.equal((await readEarlyBuyerEvidence('base', unavailableToken))?.status, 'verified')

  const failedToken = '0x' + 'd'.repeat(40)
  assert.equal(await writeEarlyBuyerEvidence('base', failedToken, verified(failedToken), true), false)
  const failed = await analyzeEarlyBuyers('base', failedToken, { refreshHoldings: true })
  assert.equal(failed.status, 'partial')
  assert.equal(failed.evidenceStatus, 'verified')
  assert.equal(failed.holdingsStatus, 'failed')
  assert.equal(failed.buyers.every((buyer) => buyer.heldRaw == null), true)
  assert.equal(failed.coverage.reasons.includes('holdings_quota_store_unavailable'), true)
  assert.equal(failed.budget.calls, 0)
  assert.deepEqual(earlyBuyerDisplayStatus(failed), { launch: 'VERIFIED', holdings: 'FAILED' })

  const readyToken = '0x' + 'c'.repeat(40)
  const ready = verified(readyToken)
  assert.equal(await writeEarlyBuyerEvidence('base', readyToken, ready, true), false)
  const measured = { ...ready, buyers: [{ ...ready.buyers[0]!, heldRaw: '0' }, { ...ready.buyers[1]!, heldRaw: '8' }], holdingsStatus: 'available' as const }
  await setTokenCache(`early-buyers:holdings:v2:base:${readyToken}`, measured, 300)
  const success = await analyzeEarlyBuyers('base', readyToken)
  assert.equal(success.status, 'verified')
  assert.equal(success.evidenceStatus, 'verified')
  assert.equal(success.holdingsStatus, 'available')
  assert.deepEqual(success.buyers.map((buyer) => buyer.heldRaw), ['0', '8'])
  assert.equal(success.budget.calls, 0)
  assert.deepEqual(earlyBuyerDisplayStatus(success), { launch: 'VERIFIED', holdings: 'AVAILABLE' })

  const abi = [{ type: 'function', name: 'aggregate3', stateMutability: 'view', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }] as const
  const partialRaw = encodeFunctionResult({ abi, functionName: 'aggregate3', result: [[{ success: true, returnData: `0x${'0'.repeat(64)}` }, { success: false, returnData: '0x' }]] as unknown as Array<{ success: boolean; returnData: `0x${string}` }> })
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2000 })
  const rpc: EarlyBuyerRpc = { budget, async call<T>(): Promise<T> { budget.record('eth_call'); return partialRaw as T } }
  const partial = await hydrateHoldings(rpc, readyToken, verified(readyToken))
  assert.deepEqual(partial.buyers.map((buyer) => buyer.heldRaw), ['0', null])
  assert.equal(partial.holdingsStatus, 'partial')
  assert.equal(partial.evidenceStatus, 'verified')
  assert.equal(heldRawLabel(partial.buyers[1]?.heldRaw), 'UNAVAILABLE')
})

type CapturedScan = {
  chain: 'base' | 'eth'
  token: string
  launch: EarlyBuyerIntel['launch']
  window: EarlyBuyerIntel['window']
  coverage: { capped: boolean; reasons: string[]; provisional: boolean }
  sampleWallets: Array<{ wallet: string; boughtRaw: string; heldRaw: string | null; transactions: string[]; evidenceCount: number }>
  sameBlockCount: number
  buyersWithAcquisitionEvidence: number
  reportedBudget: { calls: number; cu: number }
  discovery: NonNullable<EarlyBuyerIntel['discovery']>
}

