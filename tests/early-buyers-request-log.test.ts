// Early Buyers API: one structured log line and diagnostic headers per request, with no secrets,
// user identifiers, wallet lists, balances or evidence in either.
import assert from 'node:assert/strict'
import test from 'node:test'
import { handleEarlyBuyersRequest, type EarlyBuyersHandlerDeps } from '../lib/server/earlyBuyers/handler'
import { earlyBuyerLogRecord, logEarlyBuyerRequest, withEarlyBuyerDiagnostics } from '../lib/server/earlyBuyers/requestLog'
import { analyzeEarlyBuyers } from '../lib/server/earlyBuyers/analyze'
import { readEarlyBuyerEvidenceWithSource, writeEarlyBuyerEvidence } from '../lib/server/earlyBuyers/store'
import { EarlyBuyerRpcError } from '../lib/server/earlyBuyers/rpc'
import { setTokenCache } from '../lib/server/cache/tokenCache'
import { EARLY_BUYER_WINDOW_SCOPE, type EarlyBuyerIntel } from '../lib/server/earlyBuyers/types'

const TOKEN = '0x' + 'a'.repeat(40)
const POOL = '0x' + '2'.repeat(40)
const WALLET_A = '0x' + 'b'.repeat(40), WALLET_B = '0x' + 'c'.repeat(40)
const TX = '0x' + '9'.repeat(64)
const BEARER = 'sk-live-SECRET-session-token-123'
const USER_ID = 'user-7f3a-private', EMAIL = 'private.person@example.com'
const RPC_KEY_URL = 'https://base-mainnet.g.alchemy.com/v2/ALCHEMY-SECRET-KEY'
const HELD = '987654321987654321'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function intel(over: Partial<EarlyBuyerIntel> = {}): EarlyBuyerIntel {
  return {
    status: 'partial', evidenceStatus: 'partial', holdingsStatus: 'available',
    launch: { status: 'verified', block: 100, pool: POOL, creationTx: TX, liquidityTx: TX },
    window: { startBlock: 100, endBlock: 119, pools: [POOL], buysObserved: 2, examined: { startBlock: 100, endBlock: 112, receipts: 50, swapTransactions: 80 } },
    buyers: [WALLET_A, WALLET_B].map((wallet) => ({ wallet, purchaseProven: false as const, boughtRaw: '1000', heldRaw: HELD, transactions: [TX], blocks: [101], evidence: [{ txHash: TX, pool: POOL, block: 101, timestampSec: 1, reason: 'pool_sourced_token_delivery_in_swap_transaction' as const }] })),
    groups: [{ tier: 'T1', wallets: [WALLET_A, WALLET_B], transactions: [TX], reason: 'r', boughtWithinEarlySetPct: 100, heldWithinEarlySetPct: 100 }],
    sameBlockCount: 2, launchDistributions: [],
    coverage: { capped: true, reasons: ['receipt_cap_50', 'window_not_finalized'], provisional: true, scope: EARLY_BUYER_WINDOW_SCOPE },
    budget: { calls: 41, cu: 734, externalRequests: 1, actualProviderCu: null, blockReceiptCalls: 8, blockReceiptThroughputCu: 4000 },
    ...over,
  }
}

function req(body: unknown, auth = true): Request {
  return new Request('http://localhost/api/token/early-buyers', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${BEARER}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

type Harness = { lines: string[]; settled: number[]; deps: Partial<EarlyBuyersHandlerDeps> }
function harness(over: Partial<EarlyBuyersHandlerDeps> = {}, plan: 'free' | 'pro' | 'elite' = 'pro'): Harness {
  const lines: string[] = [], settled: number[] = []
  let t = 1_000
  return { lines, settled, deps: {
    authenticate: async (r: Request) => (r.headers.get('authorization') ? { userId: USER_ID, email: EMAIL, plan } : null),
    readEvidence: async () => null,
    reserve: async () => ({ allowed: true as const, settle: async (cu: number) => { settled.push(cu) } }),
    analyze: async (_c, _t, options) => { if (options?.diagnostics) { options.diagnostics.evidenceSource = 'cold_scan'; options.diagnostics.holdingsSource = 'live' } return intel() },
    log: (line) => lines.push(line),
    now: () => (t += 7),
    sharedWaitMs: 50, sharedPollMs: 1,
    ...over,
  } }
}

const only = (h: Harness) => { assert.equal(h.lines.length, 1, 'exactly one log line per request'); return JSON.parse(h.lines[0]) as Record<string, unknown> }

/** Nothing private may appear in the log line or any response header. */
function assertNoLeak(h: Harness, res: Response) {
  const surfaces = [h.lines.join('\n'), JSON.stringify([...res.headers])]
  for (const s of surfaces) for (const secret of [BEARER, USER_ID, EMAIL, WALLET_A, WALLET_B, TX, HELD, 'ALCHEMY-SECRET-KEY', 'alchemy.com', '"pro"', '"elite"']) {
    assert.equal(s.includes(secret), false, `leaked ${secret}`)
  }
}

function assertHeaders(res: Response, source: string) {
  assert.match(res.headers.get('x-early-buyers-request-id') ?? '', UUID)
  assert.equal(res.headers.get('x-early-buyers-source'), source)
  assert.match(res.headers.get('server-timing') ?? '', /^eb;dur=\d+;desc="[a-z_]+"$/)
}

test('cold scan: 200, headers, one complete log line, quota settled with actual CU', async () => {
  const h = harness()
  const res = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN.toUpperCase().replace('0X', '0x') }), h.deps)
  assert.equal(res.status, 200)
  assertHeaders(res, 'cold_scan; holdings=live')
  assert.deepEqual(h.settled, [734])
  const log = only(h)
  assert.deepEqual(log, {
    evt: 'early_buyers_request', requestId: res.headers.get('x-early-buyers-request-id'), status: 200, source: 'cold_scan', durationMs: log.durationMs,
    chain: 'base', token: TOKEN, access: 'paid', holdingsSource: 'live', rejection: null, errorCode: null,
    evidenceStatus: 'partial', holdingsStatus: 'available', rpcCalls: 41, estimatedCu: 734, blockReceiptCalls: 8,
    receiptsInspected: 50, swapTransactions: 80, recipients: 2, capped: true, coverageReasons: ['receipt_cap_50', 'window_not_finalized'],
  })
  assert.ok((log.durationMs as number) > 0)
  assert.equal((await res.json() as { earlyBuyerIntel: EarlyBuyerIntel }).earlyBuyerIntel.buyers.length, 2, 'the response body itself is unchanged')
  assertNoLeak(h, res)
})

test('cached: stored provisional evidence and the holdings cache are reported as such (real store and analyzer)', async () => {
  const token = '0x' + 'd'.repeat(40)
  const evidence = intel({ holdingsStatus: undefined, buyers: intel().buyers.map((b) => ({ ...b, heldRaw: null })), budget: { calls: 30, cu: 900 } })
  await writeEarlyBuyerEvidence('base', token, evidence, false)
  await setTokenCache(`early-buyers:holdings:v3:base:${token}`, { ...evidence, holdingsStatus: 'available', buyers: evidence.buyers.map((b) => ({ ...b, heldRaw: HELD })), currentHoldings: { blockNumber: 1, blockTimestampSec: 1, readAtMs: Date.now(), source: 'live', cacheAgeSec: 0, walletsRead: 2, walletsObserved: 2 } }, 300)
  const h = harness({ readEvidence: readEarlyBuyerEvidenceWithSource, analyze: analyzeEarlyBuyers, reserve: async () => { throw new Error('a stored result must not reserve quota') } })
  const res = await handleEarlyBuyersRequest(req({ chain: 'base', contract: token }), h.deps)
  assert.equal(res.status, 200)
  assertHeaders(res, 'provisional_kv; holdings=cache')
  const log = only(h)
  assert.equal(log.source, 'provisional_kv')
  assert.equal(log.rpcCalls, 0)
  assert.equal(log.estimatedCu, 0)
  assert.deepEqual(h.settled, [])
  assertNoLeak(h, res)

  const free = harness({ readEvidence: readEarlyBuyerEvidenceWithSource, analyze: analyzeEarlyBuyers }, 'free')
  const freeRes = await handleEarlyBuyersRequest(req({ chain: 'base', contract: token }), free.deps)
  assertHeaders(freeRes, 'provisional_kv; holdings=cache')
  assert.equal(only(free).access, 'free')
})

test('free user without stored evidence: cached-only "none", no quota reserved', async () => {
  const h = harness({ analyze: analyzeEarlyBuyers, reserve: async () => { throw new Error('free must not reserve') } }, 'free')
  const res = await handleEarlyBuyersRequest(req({ chain: 'eth', contract: '0x' + 'e'.repeat(40) }), h.deps)
  assert.equal(res.status, 200)
  assertHeaders(res, 'none')
  const log = only(h)
  assert.equal(log.evidenceStatus, 'unavailable')
  assert.deepEqual(log.coverageReasons, ['paid_analysis_required'])
})

test('quota rejection: 429 with the reason code, nothing analyzed', async () => {
  let analyzed = 0
  const h = harness({ reserve: async () => ({ allowed: false as const, reason: 'user_daily_limit' }), analyze: async () => { analyzed++; return intel() } })
  const res = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), h.deps)
  assert.equal(res.status, 429)
  assert.deepEqual(await res.json(), { error: 'user_daily_limit' })
  assertHeaders(res, 'quota_rejected')
  assert.equal(analyzed, 0)
  const log = only(h)
  assert.equal(log.rejection, 'user_daily_limit')
  assert.equal(log.rpcCalls, null)
  assertNoLeak(h, res)
})

test('token in progress: a result written by the other worker is returned as a shared wait', async () => {
  let reads = 0
  const h = harness({
    reserve: async () => ({ allowed: false as const, reason: 'token_in_progress' }),
    readEvidence: async () => (++reads >= 3 ? { intel: intel(), source: 'durable_kv' as const } : null),
  })
  const res = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), h.deps)
  assert.equal(res.status, 200)
  assertHeaders(res, 'shared_wait_durable_kv')
  assert.equal(only(h).rejection, 'token_in_progress')
  const timedOut = harness({ reserve: async () => ({ allowed: false as const, reason: 'token_in_progress' }) })
  const late = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), timedOut.deps)
  assert.equal(late.status, 429)
  assertHeaders(late, 'quota_rejected')
})

test('authentication failure and bad input are logged and carry headers', async () => {
  const anon = harness()
  const r401 = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }, false), anon.deps)
  assert.equal(r401.status, 401)
  assertHeaders(r401, 'unauthorized')
  assert.deepEqual([only(anon).access, only(anon).token, only(anon).chain], ['anonymous', null, null])

  const badJson = harness()
  const r400 = await handleEarlyBuyersRequest(req('{not json'), badJson.deps)
  assert.equal(r400.status, 400)
  assertHeaders(r400, 'invalid_request')

  const badContract = harness()
  const rBad = await handleEarlyBuyersRequest(req({ chain: 'base', contract: `${BEARER}` }), badContract.deps)
  assert.equal(rBad.status, 400)
  assert.equal(only(badContract).token, null, 'a non-address contract value is never logged')
  assertNoLeak(badContract, rBad)

  const other = harness()
  const rChain = await handleEarlyBuyersRequest(req({ chain: 'solana', contract: TOKEN }), other.deps)
  assert.equal(rChain.status, 200)
  assertHeaders(rChain, 'unsupported_chain')
  assert.equal(only(other).chain, 'other')
})

test('errors: 500 JSON with only a code logged; quota still settled; provider URLs never logged', async () => {
  const h = harness({ analyze: async () => { throw new Error(`fetch failed: ${RPC_KEY_URL} ${WALLET_A} ${BEARER}`) } })
  const res = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), h.deps)
  assert.equal(res.status, 500)
  assert.deepEqual(await res.json(), { error: 'early_buyers_failed' })
  assertHeaders(res, 'error')
  assert.deepEqual(h.settled, [2_000], 'reserved CU is settled at the reserved amount, as before')
  assert.equal(only(h).errorCode, 'unexpected_error')
  assertNoLeak(h, res)

  const rpc = harness({ analyze: async () => { throw new EarlyBuyerRpcError('rpc_http_429') } })
  await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), rpc.deps)
  assert.equal(only(rpc).errorCode, 'rpc_http_429')

  const auth = harness({ authenticate: async () => { throw new Error(`verifier down ${BEARER}`) } })
  const rAuth = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), auth.deps)
  assert.equal(rAuth.status, 500)
  assertNoLeak(auth, rAuth)
})

test('a failing log sink or unusual values never break the response', async () => {
  const h = harness({ log: () => { throw new Error('stdout closed') } })
  const res = await handleEarlyBuyersRequest(req({ chain: 'base', contract: TOKEN }), h.deps)
  assert.equal(res.status, 200)
  assertHeaders(res, 'cold_scan; holdings=live')
  // Values outside the allowlisted shapes are dropped, not logged.
  const record = earlyBuyerLogRecord({ requestId: 'r', status: 200, source: 'cold_scan', durationMs: 5, token: 'not-an-address', holdingsSource: 'x y', rejection: `limit ${BEARER}`, intel: intel({ coverage: { capped: true, reasons: ['ok_code', `bad ${RPC_KEY_URL}`, 'a,b'], provisional: false, scope: EARLY_BUYER_WINDOW_SCOPE } }) })
  assert.equal(record.token, null)
  assert.equal(record.holdingsSource, null)
  assert.equal(record.rejection, null)
  assert.deepEqual(record.coverageReasons, ['ok_code', 'a', 'b'])
  let wrote = ''
  logEarlyBuyerRequest({ requestId: 'r', status: 200, source: 'none', durationMs: 1, intel: { ...intel(), coverage: null } as unknown as EarlyBuyerIntel }, (l) => { wrote = l })
  const fallback = JSON.parse(wrote) as Record<string, unknown>
  assert.equal(fallback.status, 200, 'a malformed result still produces the request line')
  assert.equal(fallback.rpcCalls, null)
  const frozen = new Response('x')
  Object.defineProperty(frozen, 'headers', { value: { set() { throw new TypeError('immutable') } } })
  assert.equal(withEarlyBuyerDiagnostics(frozen, { requestId: 'r', source: 'none', durationMs: 1 }), frozen)
})
