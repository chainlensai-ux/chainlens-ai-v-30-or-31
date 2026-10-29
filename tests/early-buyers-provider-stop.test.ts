// Early Buyers window reads stop on a provider refusal instead of splitting the block range: a live Base public-RPC
// run answered every eth_getLogs with HTTP 429 and the range splitter spent the whole 2,000 CU estimate on refused
// calls. A JSON-RPC error (e.g. range too large) still splits the range. A failed pool lookup keeps its reason.
//   npx tsx --test tests/early-buyers-provider-stop.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAlchemyCallBudget } from '../lib/server/alchemyCallBudget'
import { readEarlyWindow } from '../lib/server/earlyBuyers/window'
import { analyzeEarlyBuyers } from '../lib/server/earlyBuyers/analyze'
import { EarlyBuyerRpcError, type EarlyBuyerRpc } from '../lib/server/earlyBuyers/rpc'

const TOKEN = '0x' + '1'.repeat(40)
const POOL = '0x' + '2'.repeat(40)
const TX1 = '0x' + '1'.repeat(64)

function failingRpc(reason: string) {
  const budget = createAlchemyCallBudget({ maxCalls: 60, maxEstimatedCu: 2_000 })
  let logCalls = 0
  const rpc: EarlyBuyerRpc = { budget, async call<T>(method: string): Promise<T> {
    const check = budget.check(method)
    if (!check.allowed) throw new EarlyBuyerRpcError(check.reason)
    budget.record(method)
    if (method === 'eth_getLogs') { logCalls += 1; throw new EarlyBuyerRpcError(reason) }
    return { number: '0x64', timestamp: '0x1' } as T
  } }
  return { rpc, budget, logCalls: () => logCalls }
}

const launches = [{ status: 'verified' as const, block: 100, pool: POOL, protocol: 'v2' as const, creationTx: TX1, liquidityTx: TX1 }]

for (const reason of ['rpc_http_429', 'rpc_http_503', 'rpc_transport_failed']) {
  test(`${reason}: one refused eth_getLogs stops the window instead of splitting`, async () => {
    const { rpc, budget, logCalls } = failingRpc(reason)
    const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches })
    assert.equal(logCalls(), 1)
    assert.ok(result.reasons.includes(reason))
    assert.ok(!result.reasons.includes('estimated_cu_budget_exceeded'))
    assert.ok(budget.estimatedCuUsed() < 2_000)
    assert.equal(result.facts.length, 0)
  })
}

test('a JSON-RPC error (range or result too large) still splits the range', async () => {
  const { rpc, logCalls } = failingRpc('rpc_error')
  const result = await readEarlyWindow({ rpc, chain: 'base', token: TOKEN, launches })
  assert.ok(logCalls() > 1)
  assert.ok(result.reasons.includes('rpc_error'))
})

test('a failed DexScreener pool lookup is reported, not only "no supported pool"', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).startsWith('https://api.dexscreener.com/')) throw new Error('network down')
    throw new Error(`unexpected ${String(input)}`)
  }) as typeof fetch
  const intel = await analyzeEarlyBuyers('base', TOKEN, { fetchImpl })
  assert.equal(intel.status, 'unavailable')
  assert.deepEqual(intel.coverage.reasons, ['no_supported_pool_creation_evidence', 'dex_pool_lookup_unavailable'])
})
