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
  assert.equal(result.audit.lookbackBlocks, 2_000_000)
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
  assert.equal(audit.stopReason, 'sell_covered')
})

test('provider range-limit errors shrink same newest chunk, then continue with returned range only', async () => {
  const queries: RhRpcLogQuery[] = []
  const result = await base(async (query) => {
    queries.push(query)
    return queries.length === 1 ? { status: 'range_limit', logs: null } : { status: 'ok', logs: [] }
  }, { onCandidates: async () => 'sell_covered' })
  assert.equal(result.audit.rangeShrinks, 1)
  assert.equal(Number.parseInt(queries[1].toBlock, 16), Number.parseInt(queries[0].toBlock, 16))
  assert.equal(Number.parseInt(queries[1].fromBlock, 16), Number.parseInt(queries[0].toBlock, 16) - ROBINHOOD_RPC_ACQUISITION_LIMITS.initialChunkBlocks / 2 + 1)
  assert.equal(result.audit.chunksSucceeded, 8)
  assert.equal(result.audit.stopReason, 'chunk_cap')
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

test('eight successful chunks and twenty unique candidates are hard ceilings', async () => {
  const empty = await base(async () => ({ status: 'ok', logs: [] }))
  assert.equal(empty.audit.chunksSucceeded, 8)
  const full = await base(async () => ({ status: 'ok', logs: Array.from({ length: 30 }, (_, i) => log(i + 1)) }))
  assert.equal(full.audit.uniqueTxCandidates, 20)
  assert.equal(full.audit.newCandidatesFound, 20)
  assert.equal(full.audit.stopReason, 'candidate_cap')
  assert.equal(full.audit.chunksSucceeded, 1)
})
