import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { toEventSelector } from 'viem'
import { createAlchemyCallBudget, estimatedCuForMethod } from '../lib/server/alchemyCallBudget'
import { discoverLaunches } from '../lib/server/earlyBuyers/launch'
import { classifyEarlyBuyers } from '../lib/server/earlyBuyers/classify'
import { readEarlyWindow } from '../lib/server/earlyBuyers/window'
import { EarlyBuyerRpcError, type EarlyBuyerRpc } from '../lib/server/earlyBuyers/rpc'
import { windowIsFinalized } from '../lib/server/earlyBuyers/store'
import type { EarlyBuyerChain } from '../lib/server/earlyBuyers/types'

const TOKEN = '0x' + '1'.repeat(40)
const POOL = '0x' + '2'.repeat(40)
const ROUTER = '0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc'
const A = '0x' + 'a'.repeat(40)
const TX1 = '0x' + '1'.repeat(64)
const TX2 = '0x' + '2'.repeat(64)
const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`
const pairCreated = toEventSelector('PairCreated(address,address,address,uint256)')
const mint = toEventSelector('Mint(address,uint256,uint256)')
const swapTopic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)')
const transferTopic = toEventSelector('Transfer(address,address,uint256)')
const wallet = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`
const hashOf = (i: number) => `0x${(i + 1).toString(16).padStart(64, '0')}`
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/

function budgeted(handler: (method: string, params: unknown[]) => unknown): { rpc: EarlyBuyerRpc; violations: string[] } {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2_000 })
  const violations: string[] = []
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string, params: unknown[]): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) {
      violations.push(`refused ${method}`)
      throw new EarlyBuyerRpcError(check.reason)
    }
    budget.record(method)
    if (budget.estimatedCuUsed() > 2_000 || budget.callsUsed() > 60) violations.push(`over cap after ${method}`)
    return handler(method, params) as T
  } }
  return { rpc, violations }
}

function firstAt(latest: number, seconds: (n: number) => number, targetMs: number): number | null {
  if (targetMs > seconds(latest) * 1000) return null
  for (let n = 0; n <= latest; n++) if (seconds(n) * 1000 >= targetMs) return n
  return null
}

async function lookup(chain: EarlyBuyerChain, latest: number, seconds: (n: number) => number | null, targetMs: number) {
  let headers = 0
  let latestReads = 0
  const { rpc, violations } = budgeted((method, params) => {
    if (method !== 'eth_getBlockByNumber') return []
    headers++
    if (params[0] === 'latest') latestReads++
    const requested = params[0] === 'latest' ? latest : Number(BigInt(String(params[0])))
    const sec = seconds(requested)
    if (sec == null || !Number.isSafeInteger(requested) || requested < 0 || requested > latest) return { number: `0x${Math.max(0, requested).toString(16)}` }
    return { number: `0x${requested.toString(16)}`, timestamp: `0x${sec.toString(16)}` }
  })
  const result = await discoverLaunches(rpc, chain, TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: targetMs }])
  return { block: result.primary.block, status: result.primary.status, reason: result.candidates[0]?.reason ?? null, headers, latestReads, violations, cu: rpc.budget.estimatedCuUsed() }
}

test('historical brackets stay exact or fail closed across irregular clocks, ties, hints, and height', async () => {
  const assertExactOrClosed = async (chain: EarlyBuyerChain, latest: number, seconds: (n: number) => number, targets: number[]) => {
    for (const target of targets) {
      const truth = firstAt(latest, seconds, target)
      const got = await lookup(chain, latest, seconds, target)
      assert.equal(got.violations.length, 0)
      assert.ok(got.headers <= 13, `headers ${got.headers} for ${chain} target ${target}`)
      assert.ok(got.cu <= 2_000)
      if (got.block != null) assert.equal(got.block, truth, `${chain} returned ${got.block}, truth ${truth}, target ${target}`)
      else assert.fail(`${chain} failed closed for monotonic target ${target}, truth ${truth}, headers ${got.headers}`)
    }
  }
  const uniform = (step: number) => (n: number) => 1_600_000_000 + n * step
  await assertExactOrClosed('base', 21_000_000, uniform(2), [12_345_678, 12_345_678, 1, 21_000_000].map((block) => uniform(2)(block) * 1000))
  await assertExactOrClosed('eth', 21_000_000, uniform(2), [12_345_678, 100, 20_999_999].map((block) => uniform(2)(block) * 1000))
  await assertExactOrClosed('base', 2_000_000_000, uniform(2), [1, 123_456_789, 1_999_999_999].map((block) => uniform(2)(block) * 1000))
  await assertExactOrClosed('base', 2_000_000_000, uniform(12), [987_654_321].map((block) => uniform(12)(block) * 1000))
  const irregular: number[] = []
  let clock = 1_700_000_000
  for (let n = 0; n <= 4_000; n++) {
    irregular.push(clock)
    if (n % 17 !== 0) clock += [1, 2, 2, 3, 5, 12, 30, 1, 2, 1][n % 10]
  }
  const series = (n: number) => irregular[n]
  const targets: number[] = []
  for (let n = 0; n <= 4_000; n += 137) {
    targets.push(series(n) * 1000, series(n) * 1000 + 1, series(n) * 1000 - 1)
  }
  targets.push(0, series(4_000) * 1000)
  await assertExactOrClosed('base', 4_000, series, targets)
  await assertExactOrClosed('eth', 4_000, series, targets.filter((_, i) => i % 5 === 0))
  const plateau = (n: number) => 5_000 + (n < 800 ? n : n < 860 ? 800 : n - 60)
  for (const target of [plateau(800) * 1000, plateau(830) * 1000, plateau(859) * 1000, plateau(860) * 1000]) {
    const truth = firstAt(1_200, plateau, target)
    const got = await lookup('eth', 1_200, plateau, target)
    assert.equal(got.violations.length, 0)
    if (got.block != null) assert.equal(got.block, truth)
    else assert.equal(got.reason, 'historical_block_unavailable')
  }
  const tipTie = (n: number) => 9_000 + Math.min(n, 90)
  const tip = await lookup('base', 100, tipTie, tipTie(100) * 1000)
  assert.equal(tip.block, 90)
  const genesis = await lookup('base', 500, (n) => 10_000 + n * 2, 0)
  assert.equal(genesis.block, 0)
  const future = await lookup('base', 500, (n) => n * 2, 500 * 2 * 1000 + 1)
  assert.equal(future.block, null)
  assert.equal(future.reason, 'historical_block_unavailable')
  const missing = await lookup('base', 800, (n) => n === 400 ? null : n * 2, 400 * 2 * 1000)
  assert.equal(missing.block, null)
  assert.notEqual(missing.block, 399)
  assert.notEqual(missing.block, 401)
})

test('a non-monotonic clock never returns a later crossing', async () => {
  let wrong = 0
  let closed = 0
  let exact = 0
  for (let dipAt = 20; dipAt <= 400; dipAt += 20) {
    const seconds = (n: number) => n === dipAt ? 1 : 1_000 + n * 3
    const target = seconds(dipAt - 5) * 1000
    const truth = firstAt(600, seconds, target)
    const got = await lookup('base', 600, seconds, target)
    if (got.block == null) closed++
    else if (got.block === truth) exact++
    else wrong++
  }
  assert.equal(wrong, 0, `non-monotonic wrong crossings: ${wrong}`)
  assert.ok(exact + closed === 20)
})

test('reused latest header is not fetched once per pool', async () => {
  let latestReads = 0
  const { rpc } = budgeted((method, params) => {
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'latest') latestReads++
      const n = params[0] === 'latest' ? 2_000 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` }
    }
    return []
  })
  await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: 100 * 2_000 },
    { address: '0x' + '3'.repeat(40), dex: 'uniswap v2', createdAt: 400 * 2_000 },
  ])
  assert.equal(latestReads, 1)
})

test('equal or unknown pool timestamps still block, and only a strictly later pool does not', async () => {
  const older = '0x' + '1'.repeat(40)
  const same = '0x' + '3'.repeat(40)
  const later = '0x' + '4'.repeat(40)
  const newest = '0x' + '5'.repeat(40)
  const unknown = '0x' + '6'.repeat(40)
  const { rpc } = budgeted((method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 500 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` }
    }
    const filter = params[0] as { address?: string; topics?: Array<string | null> }
    if (filter.address?.toLowerCase() === POOL && filter.topics?.[0] === mint) return [{ address: POOL, topics: [mint], blockNumber: '0x65', transactionHash: TX2 }]
    if (filter.topics?.[0] === pairCreated && filter.topics[1]?.toLowerCase() === topic(TOKEN).toLowerCase()) {
      return [{ address: filter.address, topics: [pairCreated, topic(TOKEN), topic(A)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: '0x64', transactionHash: TX1 }]
    }
    return []
  })
  const sameTime = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: 200_000 },
    { address: same, dex: 'uniswap v2', createdAt: 200_000 },
  ])
  assert.equal(sameTime.candidates.some((candidate) => candidate.pool === same && candidate.outcome !== 'verified'), true)
  assert.equal(sameTime.complete, false)
  const unknownTime = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: 200_000 },
    { address: unknown, dex: 'uniswap v2', createdAt: null },
  ])
  assert.equal(unknownTime.candidates.map((candidate) => candidate.pool).includes(unknown), true)
  assert.equal(unknownTime.complete, false)
  assert.notEqual(unknownTime.incompleteReason, null)
  const excluded = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: older, dex: 'unknown venue', createdAt: 100_000 },
    { address: POOL, dex: 'uniswap v2', createdAt: 200_000 },
  ])
  assert.deepEqual(excluded.candidates[0], { pool: older, createdAt: 100_000, outcome: 'excluded', reason: 'launch_venue_not_supported_by_v1' })
  assert.equal(excluded.complete, false)
  assert.equal(excluded.primary.pool, POOL)
  const cappedLater = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: POOL, dex: 'uniswap v2', createdAt: 200_000 },
    { address: later, dex: 'uniswap v2', createdAt: 220_000 },
    { address: newest, dex: 'uniswap v2', createdAt: 240_000 },
    { address: '0x' + '7'.repeat(40), dex: 'uniswap v2', createdAt: 260_000 },
  ])
  assert.equal(cappedLater.candidates[0].pool, POOL)
  assert.equal(cappedLater.candidates[3].reason, 'pool_candidate_cap_3')
  assert.equal(cappedLater.complete, true)
  assert.equal(cappedLater.incompleteReason, null)
  assert.equal(cappedLater.primary.pool, POOL)
})

test('a chain-earlier verified pool is not dropped when the indexer listed it later', async () => {
  const indexedFirst = '0x' + '8'.repeat(40)
  const { rpc } = budgeted((method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 5_000 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` }
    }
    const filter = params[0] as { address?: string; topics?: Array<string | null> }
    const pool = filter.address?.toLowerCase()
    if (pool === indexedFirst && filter.topics?.[0] === mint) return [{ address: indexedFirst, topics: [mint], blockNumber: '0x3e8', transactionHash: TX1 }]
    if (pool === POOL && filter.topics?.[0] === mint) return [{ address: POOL, topics: [mint], blockNumber: '0x3ca', transactionHash: TX2 }]
    if (filter.topics?.[0] === pairCreated && filter.topics[1]?.toLowerCase() === topic(TOKEN).toLowerCase()) {
      return [
        { address: filter.address, topics: [pairCreated, topic(TOKEN), topic(A)], data: `${topic(indexedFirst)}${'0'.repeat(64)}`, blockNumber: '0x3e7', transactionHash: TX1 },
        { address: filter.address, topics: [pairCreated, topic(TOKEN), topic(A)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: '0x3c9', transactionHash: TX2 },
      ]
    }
    return []
  })
  const result = await discoverLaunches(rpc, 'base', TOKEN, [
    { address: indexedFirst, dex: 'uniswap v2', createdAt: 1_000 * 2_000 },
    { address: POOL, dex: 'uniswap v2', createdAt: 1_030 * 2_000 },
  ])
  assert.equal(result.candidates.every((candidate) => candidate.outcome === 'verified'), true)
  assert.equal(result.complete, true)
  assert.equal(result.primary.pool, POOL)
  assert.equal(result.primary.block, 0x3ca)
  assert.equal(result.pools.map((pool) => pool.pool).includes(POOL), true)
})

test('block receipts use a hex quantity, ignore holes, and fall back without a false gap or a CU overrun', async () => {
  assert.equal(estimatedCuForMethod('eth_getBlockReceipts'), 20)
  const cases = ['throw', 'empty', 'holes'] as const
  for (const mode of cases) {
    const seen: string[] = []
    let individuals = 0
    const { rpc, violations } = budgeted((method, params) => {
      if (method === 'eth_getBlockReceipts') {
        const param = String(params[0])
        seen.push(param)
        assert.match(param, QUANTITY)
        if (mode === 'throw') throw new EarlyBuyerRpcError('rpc_error')
        if (mode === 'empty') return []
        return [null, { transactionHash: hashOf(0), status: '0x1', transactionIndex: '0x0', logs: [] }, ...[1, 2, 3].map((i) => ({
          transactionHash: hashOf(i), from: wallet(i), to: ROUTER, status: '0x1', blockNumber: '0x64', transactionIndex: `0x${i.toString(16)}`,
          logs: [{ address: POOL, topics: [swapTopic], logIndex: `0x${i.toString(16)}` }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(wallet(i))], data: `0x${'0'.repeat(63)}a` }],
        }))].reverse()
      }
      if (method === 'eth_getTransactionReceipt') {
        individuals++
        const id = Number(BigInt(String(params[0]))) - 1
        return { transactionHash: hashOf(id), from: wallet(id), to: ROUTER, status: '0x1', blockNumber: '0x64', transactionIndex: `0x${id.toString(16)}`, logs: [{ address: POOL, topics: [swapTopic], logIndex: `0x${id.toString(16)}` }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(wallet(id))], data: `0x${'0'.repeat(63)}a` }] }
      }
      return []
    })
    const swaps = [0, 1, 2, 3].map((i) => ({ address: POOL, topics: [swapTopic], blockNumber: '0x64', transactionHash: hashOf(i), logIndex: `0x${i.toString(16)}` }))
    const windowRpc: EarlyBuyerRpc = { budget: rpc.budget, async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'eth_getLogs') return swaps as T
      return rpc.call(method, params)
    } }
    const result = await readEarlyWindow({ rpc: windowRpc, chain: 'base', token: TOKEN, launches: [{ status: 'verified', block: 100, pool: POOL, protocol: 'v2', creationTx: TX1, liquidityTx: TX2 }] })
    assert.equal(violations.length, 0)
    assert.equal(result.facts.length, 4)
    assert.deepEqual(result.facts.map((fact) => fact.txHash), [0, 1, 2, 3].map(hashOf))
    assert.equal(result.reasons.includes('rpc_error'), false)
    assert.equal(result.reasons.includes('block_receipts_unavailable'), false)
    if (mode === 'holes') assert.equal(individuals, 1)
    if (mode === 'throw' || mode === 'empty') assert.equal(individuals, 4)
    assert.ok(rpc.budget.estimatedCuUsed() <= 2_000)
  }
})

test('swap windows of 20, 40, 50, and 80 stay inside the RPC cap and do not hide the 50-swap cutoff', async () => {
  const report: unknown[] = []
  const run = async (label: string, count: number, perBlock: number, chain: EarlyBuyerChain, batch: 'ok' | 'unsupported') => {
    const launchBlock = 12_345_678
    const step = chain === 'base' ? 2 : 12
    const latest = 21_000_000
    const later = '0x' + '5'.repeat(40)
    const methods: string[] = []
    const { rpc, violations } = budgeted((method, params) => {
      methods.push(method)
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'latest' || params[0] === 'finalized' ? latest : Number(BigInt(String(params[0])))
        return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * step).toString(16)}` }
      }
      if (method === 'eth_getLogs') {
        const filter = params[0] as { address?: string; topics?: Array<string | null> }
        const address = filter.address?.toLowerCase()
        if (address === POOL && filter.topics?.[0] === mint) return [{ address: POOL, topics: [mint], blockNumber: `0x${launchBlock.toString(16)}`, transactionHash: TX2 }]
        if (address === POOL && filter.topics?.[0] === swapTopic) {
          return Array.from({ length: count }, (_, i) => ({ address: POOL, topics: [swapTopic], blockNumber: `0x${(launchBlock + Math.floor(i / perBlock)).toString(16)}`, transactionHash: hashOf(i), logIndex: `0x${(i % perBlock).toString(16)}` }))
        }
        if (filter.topics?.[0] === pairCreated && filter.topics?.[1]?.toLowerCase() === topic(TOKEN).toLowerCase() && address !== later) {
          return [{ address, topics: [pairCreated, topic(TOKEN), topic(A)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: `0x${(launchBlock - 1).toString(16)}`, transactionHash: TX1 }]
        }
        return []
      }
      if (method === 'eth_getBlockReceipts') {
        assert.match(String(params[0]), QUANTITY)
        if (batch === 'unsupported') throw new EarlyBuyerRpcError('rpc_error')
        const block = Number(BigInt(String(params[0])))
        return Array.from({ length: count }, (_, i) => ({ i, block: launchBlock + Math.floor(i / perBlock) })).filter((row) => row.block === block).map((row) => ({
          transactionHash: hashOf(row.i), from: wallet(row.i), to: ROUTER, status: '0x1', blockNumber: `0x${block.toString(16)}`, transactionIndex: `0x${(row.i % perBlock).toString(16)}`,
          logs: [{ address: POOL, topics: [swapTopic], logIndex: `0x${(row.i % perBlock).toString(16)}` }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(wallet(row.i))], data: `0x${'0'.repeat(63)}a` }],
        }))
      }
      if (method === 'eth_getTransactionReceipt') {
        const i = Number(BigInt(String(params[0]))) - 1
        const block = launchBlock + Math.floor(i / perBlock)
        return { transactionHash: hashOf(i), from: wallet(i), to: ROUTER, status: '0x1', blockNumber: `0x${block.toString(16)}`, transactionIndex: `0x${(i % perBlock).toString(16)}`, logs: [{ address: POOL, topics: [swapTopic], logIndex: `0x${(i % perBlock).toString(16)}` }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(wallet(i))], data: `0x${'0'.repeat(63)}a` }] }
      }
      throw new Error(`unexpected ${method}`)
    })
    const discovered = await discoverLaunches(rpc, chain, TOKEN, [
      { address: POOL, dex: 'uniswap v2', createdAt: launchBlock * step * 1_000 },
      { address: later, dex: 'uniswap v2', createdAt: (launchBlock + 50_000) * step * 1_000 },
    ])
    const window = await readEarlyWindow({ rpc, chain, token: TOKEN, launches: discovered.pools })
    const classified = classifyEarlyBuyers(window.facts, discovered.primary.status === 'verified' && !discovered.incompleteReason)
    const finalized = latest
    const provisional = !windowIsFinalized(window.endBlock, finalized)
    const partial = provisional || window.capped || !discovered.complete
    const status = partial ? 'partial' : discovered.primary.status
    const row = {
      label, chain, batch, swaps: count, calls: rpc.budget.callsUsed(), cu: rpc.budget.estimatedCuUsed(),
      publishedBatchCu: methods.filter((method) => method === 'eth_getBlockReceipts').length * 20,
      blockReceipts: methods.filter((method) => method === 'eth_getBlockReceipts').length,
      individualReceipts: methods.filter((method) => method === 'eth_getTransactionReceipt').length,
      facts: window.facts.length, buyers: classified.buyers.length, groups: classified.groups.length,
      complete: discovered.complete, reasons: [...window.reasons, ...(discovered.incompleteReason ? [discovered.incompleteReason] : [])],
      status, violations: violations.length,
    }
    report.push(row)
    assert.equal(violations.filter((item) => item.startsWith('over cap')).length, 0)
    assert.ok(row.calls <= 60, `${label} calls ${row.calls}`)
    assert.ok(row.cu <= 2_000, `${label} cu ${row.cu}`)
    assert.equal(discovered.complete, true)
    assert.equal(discovered.primary.pool, POOL)
    const budgetStopped = row.reasons.some((reason) => reason === 'estimated_cu_budget_exceeded' || reason === 'call_count_budget_exceeded')
    if (count > 50) {
      assert.ok(window.reasons.includes('receipt_cap_50'))
      assert.equal(status, 'partial')
      assert.ok(window.facts.length <= 50)
      assert.notEqual(window.facts.length, count)
      if (batch === 'unsupported') assert.equal(budgetStopped, true)
      else assert.equal(budgetStopped, false)
    } else {
      assert.equal(window.reasons.includes('receipt_cap_50'), false)
      assert.equal(budgetStopped, false)
      assert.equal(violations.length, 0)
      assert.equal(window.facts.length, count)
      assert.equal(status, 'verified')
    }
  }
  await run('20-base', 20, 20, 'base', 'ok')
  await run('40-base', 40, 10, 'base', 'ok')
  await run('50-base', 50, 5, 'base', 'ok')
  await run('80-base', 80, 4, 'base', 'ok')
  await run('40-eth', 40, 10, 'eth', 'ok')
  await run('40-base-unsupported-batch', 40, 10, 'base', 'unsupported')
  await run('80-base-unsupported-batch', 80, 4, 'base', 'unsupported')
  const hostileBlocks = 25
  const hostileSwaps = 50
  const launchBlock = 1_000
  const { rpc, violations } = budgeted((method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'latest' ? 5_000 : Number(BigInt(String(params[0])))
      return { number: `0x${n.toString(16)}`, timestamp: `0x${(n * 2).toString(16)}` }
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address?: string; topics?: Array<string | null> }
      if (filter.topics?.[0] === mint) return [{ address: POOL, topics: [mint], blockNumber: `0x${launchBlock.toString(16)}`, transactionHash: TX2 }]
      if (filter.topics?.[0] === swapTopic) return Array.from({ length: hostileSwaps }, (_, i) => ({ address: POOL, topics: [swapTopic], blockNumber: `0x${(launchBlock + Math.floor(i / 2)).toString(16)}`, transactionHash: hashOf(i), logIndex: `0x${(i % 2).toString(16)}` }))
      if (filter.topics?.[0] === pairCreated) return [{ address: POOL, topics: [pairCreated, topic(TOKEN), topic(A)], data: `${topic(POOL)}${'0'.repeat(64)}`, blockNumber: `0x${(launchBlock - 1).toString(16)}`, transactionHash: TX1 }]
      return []
    }
    if (method === 'eth_getBlockReceipts') return []
    if (method === 'eth_getTransactionReceipt') {
      const i = Number(BigInt(String(params[0]))) - 1
      const block = launchBlock + Math.floor(i / 2)
      return { transactionHash: hashOf(i), from: wallet(i), to: ROUTER, status: '0x1', blockNumber: `0x${block.toString(16)}`, transactionIndex: `0x${(i % 2).toString(16)}`, logs: [{ address: POOL, topics: [swapTopic], logIndex: `0x${(i % 2).toString(16)}` }, { address: TOKEN, topics: [transferTopic, topic(POOL), topic(wallet(i))], data: `0x${'0'.repeat(63)}a` }] }
    }
    throw new Error(`unexpected ${method}`)
  })
  const discovered = await discoverLaunches(rpc, 'base', TOKEN, [{ address: POOL, dex: 'uniswap v2', createdAt: launchBlock * 2_000 }])
  let windowError: unknown = null
  let facts = 0
  let reasons: string[] = []
  try {
    const window = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches: discovered.pools })
    facts = window.facts.length
    reasons = window.reasons
  } catch (error) { windowError = error }
  assert.equal(windowError, null)
  assert.equal(violations.filter((item) => item.startsWith('over cap')).length, 0)
  assert.ok(rpc.budget.estimatedCuUsed() <= 2_000)
  assert.ok(rpc.budget.callsUsed() <= 60)
  assert.ok(facts < hostileSwaps)
  assert.ok(reasons.some((reason) => reason === 'estimated_cu_budget_exceeded' || reason === 'call_count_budget_exceeded'))
  report.push({ label: '50-double-billed-empty-batches', blocks: hostileBlocks, calls: rpc.budget.callsUsed(), cu: rpc.budget.estimatedCuUsed(), facts, reasons, status: 'partial' })
  writeFileSync('/tmp/early-buyers-safety-report.json', JSON.stringify(report, null, 2))
})
