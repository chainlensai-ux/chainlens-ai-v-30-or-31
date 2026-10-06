import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverRobinhoodRpcAcquisitionHistory, robinhoodRpcInboundLogsFromUrl, ERC20_TRANSFER_TOPIC0, ROBINHOOD_RPC_ACQUISITION_LIMITS, type RhRpc, type RhRpcLogQuery, type RhRpcLogResult } from '../lib/server/robinhoodPnlV1.ts'

const wallet = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const other = '0x1111111111111111111111111111111111111111'
const token = '0x12f190a9f9d7d37a250758b26824b97ce941bf54'
const wrongToken = '0x2222222222222222222222222222222222222222'
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const log = (id: number, overrides: Record<string, unknown> = {}) => ({
  address: token, topics: [ERC20_TRANSFER_TOPIC0, topic(other), topic(wallet)],
  transactionHash: hash(id), blockNumber: hex(1_900_000), logIndex: hex(id),
  data: `0x${BigInt(id).toString(16).padStart(64, '0')}`, removed: false, ...overrides,
})
const blockRpc: RhRpc = async (calls) => calls.map((call) => call.method === 'eth_getBlockByNumber' ? { timestamp: hex(1_790_000_000) } : null)
const base = (rpcLogs: (query: RhRpcLogQuery, deadlineAt: number) => Promise<RhRpcLogResult>, extra: Partial<Parameters<typeof discoverRobinhoodRpcAcquisitionHistory>[0]> = {}) =>
  discoverRobinhoodRpcAcquisitionHistory({
    sellTxHash: hash(999), sellBlock: 2_000_000, token, wallet, deadlineAt: Date.now() + 6_000,
    rpcLogs, rpc: blockRpc, knownHashes: new Set<string>(), ...extra,
  })

test('RPC history keeps the expanded ceiling bounded without changing proof limits', () => {
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.maxAbsoluteLookbackBlocks, 16_000_000)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.maxSuccessfulChunks, 64)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.maxAttempts, 96)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.budgetMs, 12_000)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.maxLogsPerChunk, 1_000)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.historicalMarginBlocks, 1_000_000)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.initialChunkBlocks, 250_000)
  assert.equal(ROBINHOOD_RPC_ACQUISITION_LIMITS.maxCandidates, 20)
})

test('exact token/topic2 query discovers known wallet inbound without treating it as a new acquisition', async () => {
  const known = [1, 2, 3, 4].map(hash)
  const queries: RhRpcLogQuery[] = []
  const result = await base(async (query) => { queries.push(query); return { status: 'ok', logs: known.map((_, i) => log(i + 1)) } }, {
    knownHashes: new Set(known), onCandidates: async () => { throw new Error('known rows must not be re-proved') },
  })
  assert.deepEqual(queries[0].topics, [ERC20_TRANSFER_TOPIC0, null, topic(wallet)])
  assert.equal(queries[0].address, token)
  assert.equal(Number.parseInt(queries[0].toBlock, 16), 1_999_999)
  assert.equal(result.audit.historyCoverage, 'bounded_block_lookback')
  assert.equal(result.audit.coverageTarget, 'fixed_fallback')
  assert.equal(result.audit.lookbackBlocks, 1_999_999)
  assert.equal(result.audit.exactInboundLogs, 4)
  assert.deepEqual(result.audit.knownCurrentSampleTxsFound, known)
  assert.equal(result.audit.newCandidatesFound, 0)
})

test('local validation rejects wrong recipient/token, removed, zero, post-sell and malformed logs', async () => {
  let calls = 0
  const { rows, audit } = await base(async () => ({ status: 'ok', logs: ++calls === 1 ? [
    log(1), log(2, { topics: [ERC20_TRANSFER_TOPIC0, topic(other), topic(other)] }),
    log(3, { address: wrongToken }), log(4, { removed: true }),
    log(5, { data: `0x${'0'.repeat(64)}` }), log(6, { blockNumber: hex(2_000_000) }),
    log(7, { transactionHash: '0x123' }), log(8, { data: '0x123' }),
  ] : [] }))
  assert.deepEqual(rows.map((r) => r.txHash), [hash(1)])
  assert.equal(audit.logsReturned, 8)
  assert.equal(audit.exactInboundLogs, 1)
})

test('multiple inbound logs in one tx group deterministically before receipt classification', async () => {
  const seen: Array<{ txHash: string; rawAmount: string | null }[]> = []
  const { rows, audit } = await base(async () => ({ status: 'ok', logs: [log(2, { transactionHash: hash(10) }), log(3, { transactionHash: hash(10) })] }), {
    onCandidates: async (chunk) => { seen.push(chunk.map((r) => ({ txHash: r.txHash, rawAmount: r.rawAmount }))); return 'sell_covered' },
  })
  assert.equal(audit.exactInboundLogs, 2)
  assert.equal(audit.uniqueTxCandidates, 1)
  assert.deepEqual(rows.map((r) => r.rawAmount), ['5'])
  assert.deepEqual(seen[0], [{ txHash: hash(10), rawAmount: '5' }])
  assert.equal(audit.stopReason, 'bounded_target_reached')
})

test('provider range-limit errors shrink same newest chunk, then continue with returned range only', async () => {
  const queries: RhRpcLogQuery[] = []
  const result = await base(async (query) => {
    queries.push(query)
    return queries.length === 1 ? { status: 'range_limit', logs: null } : { status: 'ok', logs: [] }
  }, { onCandidates: async () => 'sell_covered' })
  assert.equal(result.audit.rangeShrinks, 1)
  assert.equal(result.audit.targetFromBlock, 1)
  assert.equal(Number.parseInt(queries[1].toBlock, 16), Number.parseInt(queries[0].toBlock, 16))
  assert.equal(Number.parseInt(queries[1].fromBlock, 16), Number.parseInt(queries[0].toBlock, 16) - ROBINHOOD_RPC_ACQUISITION_LIMITS.initialChunkBlocks / 2 + 1)
  assert.equal(result.audit.chunksSucceeded, 16)
  assert.equal(result.audit.stopReason, 'bounded_target_reached')
  assert.equal(result.audit.boundedLookbackComplete, true)
})

test('real RPC adapter sends eth_getLogs and preserves provider range-limit classification', async () => {
  const queries: unknown[] = []
  const adapter = robinhoodRpcInboundLogsFromUrl('https://rpc.example', async (_url, init) => {
    queries.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'query returned more than limit' } }), { status: 200 })
  })!
  const query: RhRpcLogQuery = { address: token, topics: [ERC20_TRANSFER_TOPIC0, null, topic(wallet)], fromBlock: '0x1', toBlock: '0x2' }
  assert.deepEqual(await adapter(query, Date.now() + 1000), { status: 'range_limit', logs: null })
  assert.deepEqual(queries[0], { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [query] })
})

test('bounded target and twenty unique candidates are hard ceilings', async () => {
  const empty = await base(async () => ({ status: 'ok', logs: [] }))
  assert.equal(empty.audit.chunksSucceeded, 8)
  assert.equal(empty.audit.stopReason, 'bounded_target_reached')
  assert.equal(empty.audit.boundedLookbackComplete, true)
  const full = await base(async () => ({ status: 'ok', logs: Array.from({ length: 30 }, (_, i) => log(i + 1)) }))
  assert.equal(full.audit.uniqueTxCandidates, 20)
  assert.equal(full.audit.newCandidatesFound, 20)
  assert.equal(full.audit.stopReason, 'candidate_cap')
  assert.equal(full.audit.chunksSucceeded, 1)
})

test('production-shaped anchors reach all four distinct known blocks and one million blocks below the earliest', async () => {
  const sellBlock = 70_400_844
  const known = [
    ['455896', 69_950_000], ['68a04c', 68_050_000],
    ['48ed6d', 64_000_000], ['cc37ff', 62_309_618],
  ] as const
  const knownHashes = known.map(([prefix]) => `0x${prefix}${'0'.repeat(58)}`)
  const blocks = new Map(known.map(([prefix, block]) => [`0x${prefix}${'0'.repeat(58)}`, block]))
  const queries: RhRpcLogQuery[] = []
  const result = await base(async (query) => {
    queries.push(query)
    const from = Number.parseInt(query.fromBlock, 16)
    const to = Number.parseInt(query.toBlock, 16)
    return { status: 'ok', logs: known.flatMap(([prefix, block], i) => block >= from && block <= to
      ? [log(i + 1, { transactionHash: `0x${prefix}${'0'.repeat(58)}`, blockNumber: hex(block) })] : []) }
  }, { sellBlock, knownHashes: new Set(knownHashes), knownInboundHashesExpected: knownHashes, knownInboundBlocks: blocks })
  assert.equal(result.audit.coverageTarget, 'earliest_known_inbound_plus_margin')
  assert.equal(result.audit.earliestKnownInboundBlock, 62_309_618)
  assert.equal(result.audit.targetFromBlock, 61_309_618)
  assert.equal(result.audit.stopReason, 'bounded_target_reached')
  assert.equal(result.audit.boundedLookbackComplete, true)
  assert.equal(result.audit.reachedEarliestKnownInbound, true)
  assert.equal(result.audit.reachedHistoricalMargin, true)
  assert.deepEqual(result.audit.knownInboundHashesFound, knownHashes.slice().sort())
  assert.equal(result.audit.knownInboundCoverageComplete, true)
  assert.equal(result.audit.newCandidatesFound, 0)
  assert.equal(result.audit.absoluteLookbackCapHit, false)
  assert.ok(queries.length > 32)
  assert.ok(result.audit.lowestScannedBlock! <= 61_309_618)
})

test('absolute 16M cap is explicit when an anchor lies beyond it', async () => {
  const knownHash = hash(100)
  const result = await base(async () => ({ status: 'ok', logs: [] }), {
    sellBlock: 70_400_844, knownHashes: new Set([knownHash]), knownInboundHashesExpected: [knownHash],
    knownInboundBlocks: new Map([[knownHash, 53_000_000]]),
  })
  assert.equal(result.audit.desiredFromBlock, 52_000_000)
  assert.equal(result.audit.absoluteFloor, 54_400_844)
  assert.equal(result.audit.targetFromBlock, 54_400_844)
  assert.equal(result.audit.requestedLookbackBlocks, 16_000_000)
  assert.equal(result.audit.actualLookbackBlocks, 16_000_000)
  assert.equal(result.audit.absoluteLookbackCapHit, true)
  assert.equal(result.audit.boundedLookbackComplete, true)
  assert.equal(result.audit.reachedEarliestKnownInbound, false)
  assert.equal(result.audit.reachedHistoricalMargin, false)
  assert.equal(result.audit.knownInboundCoverageComplete, false)
  assert.equal(result.audit.chunksSucceeded, 64)
  assert.equal(result.audit.stopReason, 'bounded_target_reached')
})

test('chunk cap and deadline report incomplete bounded coverage', async () => {
  const anchored = { sellBlock: 70_400_844, knownInboundBlocks: new Map([[hash(1), 55_400_844]]),
    knownInboundHashesExpected: [hash(1)] }
  let attempts = 0
  const capped = await base(async () => ({ status: ++attempts === 1 ? 'range_limit' : 'ok', logs: attempts === 1 ? null : [] } as RhRpcLogResult), anchored)
  assert.equal(capped.audit.targetFromBlock, 54_400_844)
  assert.equal(capped.audit.rangeShrinks, 1)
  assert.equal(capped.audit.chunksSucceeded, 64)
  assert.equal(capped.audit.stopReason, 'chunk_cap')
  assert.equal(capped.audit.boundedLookbackComplete, false)
  const expired = await base(async () => ({ status: 'ok', logs: [] }), { ...anchored, deadlineAt: Date.now() - 1 })
  assert.equal(expired.audit.stopReason, 'deadline')
  assert.equal(expired.audit.boundedLookbackComplete, false)
})

test('production 0xf5f7… shape: evidence-anchored target 69,483,888 is reached inside the global bounded policy', async () => {
  const sellBlock = 81_106_866
  const earliest = hash(0xf5f7)
  const later = hash(0xf5f8)
  const blocks = new Map([[earliest, 70_483_888], [later, 78_000_000]])
  const result = await base(async (query) => {
    const from = Number.parseInt(query.fromBlock, 16)
    const to = Number.parseInt(query.toBlock, 16)
    return { status: 'ok', logs: [...blocks].flatMap(([h, b], i) => b >= from && b <= to ? [log(i + 1, { transactionHash: h, blockNumber: hex(b) })] : []) }
  }, { sellBlock, knownHashes: new Set(blocks.keys()), knownInboundHashesExpected: [...blocks.keys()], knownInboundBlocks: blocks, deadlineAt: Date.now() + 12_000 })
  const a = result.audit
  assert.equal(a.earliestKnownInboundBlock, 70_483_888)
  assert.equal(a.desiredFromBlock, 69_483_888)
  assert.equal(a.absoluteFloor, 65_106_866)
  assert.equal(a.targetFromBlock, 69_483_888)
  assert.equal(a.requestedLookbackBlocks, 11_622_978)
  assert.equal(a.absoluteLookbackCapHit, false)
  assert.equal(a.reachedEarliestKnownInbound, true)
  assert.equal(a.reachedHistoricalMargin, true)
  assert.equal(a.boundedLookbackComplete, true)
  assert.equal(a.stopReason, 'bounded_target_reached')
  assert.equal(a.lowestScannedBlock, 69_483_888)
  assert.equal(a.actualLookbackBlocks, 11_622_978)
  assert.ok(a.chunksSucceeded <= ROBINHOOD_RPC_ACQUISITION_LIMITS.maxSuccessfulChunks)
  assert.equal(a.knownInboundCoverageComplete, true)
  assert.equal(a.newCandidatesFound, 0) // known inbounds are found, never re-proved, never buys by themselves
  assert.equal(a.historyCoverage, 'bounded_block_lookback') // never claims complete wallet history
})

test('the bounded policy never scans to genesis, even for a near-genesis anchor', async () => {
  const anchor = hash(7)
  const result = await base(async () => ({ status: 'ok', logs: [] }), {
    sellBlock: 81_106_866, knownInboundHashesExpected: [anchor], knownInboundBlocks: new Map([[anchor, 500_000]]), deadlineAt: Date.now() + 12_000,
  })
  assert.equal(result.audit.desiredFromBlock, 1)
  assert.equal(result.audit.targetFromBlock, 65_106_866)
  assert.equal(result.audit.absoluteLookbackCapHit, true)
  assert.equal(result.audit.reachedEarliestKnownInbound, false)
  assert.ok(result.audit.lowestScannedBlock! >= 65_106_866)
})
