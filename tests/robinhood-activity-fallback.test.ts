// Robinhood activity: a failed GoldRush primary (429 / timeout) must fall back to Blockscout, keep its
// provenance, never be replayed from cache, and still feed candidates into the PnL V1 receipt lane.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRobinhoodWalletActivity, getCachedRobinhoodWalletActivity, robinhoodPnlV1CandidatesFromActivity, scanRobinhoodWallet } from '../lib/server/robinhoodWalletScanner.ts'
import * as blockscout from '../lib/server/robinhoodBlockscoutEvidence.ts'
import * as v1 from '../lib/server/robinhoodPnlV1.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-blockscout-key'
process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'
delete process.env.ALCHEMY_ROBINHOOD_RPC_URL
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN


const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const TOKEN = '0xaaaa000000000000000000000000000000000001'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const H1 = `0x${'1'.repeat(64)}`
const H2 = `0x${'2'.repeat(64)}`
let walletSeq = 0
const nextWallet = () => `0x${(0x343f00 + ++walletSeq).toString(16).padStart(40, '0')}`

type Primary = 'ok' | 429 | 'timeout'
type Fallback = 'ok' | 500 | 429
function fakeFetch(wallet: string, opts: { primary: Primary; fallback: Fallback }) {
  const calls: string[] = []
  const fn = async (url: string): Promise<Response> => {
    calls.push(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('api.covalenthq.com')) {
      if (url.includes('/balances_v2/')) return json({}, 429)
      if (opts.primary === 429) return json({ error: true }, 429)
      if (opts.primary === 'timeout') { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }
      return json({ data: { items: [{
        tx_hash: H1, block_signed_at: '2026-10-01T10:00:00Z', from_address: wallet, to_address: ROUTER, value: '0',
        log_events: [{ decoded: { name: 'Transfer', params: [{ name: 'from', value: PM }, { name: 'to', value: wallet }, { name: 'value', value: '5' }] }, sender_address: TOKEN, sender_contract_ticker_symbol: 'AAA' }],
      }] } })
    }
    if (url.includes('blockscout.com')) {
      if (opts.fallback !== 'ok') return json({ message: 'error' }, opts.fallback)
      if (url.includes('/logs')) return json({ items: [] })
      if (url.includes('/token-transfers')) return json({ items: [
        { transaction_hash: H1, timestamp: '2026-10-01T10:00:00Z', from: { hash: PM }, to: { hash: wallet }, total: { value: '5000' }, token: { address: TOKEN, symbol: 'AAA' } },
        { transaction_hash: H2, timestamp: '2026-10-02T10:00:00Z', from: { hash: wallet }, to: { hash: PM }, total: { value: '5000' }, token: { address: TOKEN, symbol: 'AAA' } },
      ] })
      if (url.includes('/transactions')) return json({ items: [
        { hash: H1, timestamp: '2026-10-01T10:00:00Z', from: { hash: wallet }, to: { hash: ROUTER }, value: '1000000000000000000' },
        { hash: H2, timestamp: '2026-10-02T10:00:00Z', from: { hash: wallet }, to: { hash: ROUTER }, value: '0' },
      ] })
    }
    return json({}, 404)
  }
  return { fn, calls }
}

beforeEach(() => { blockscout.__resetRobinhoodBlockscoutRateLimitForTest(); v1.__resetRobinhoodPnlV1CachesForTest() })

test('1. GoldRush success -> Blockscout skipped', async () => {
  const wallet = nextWallet()
  const f = fakeFetch(wallet, { primary: 'ok', fallback: 'ok' })
  const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: f.fn })
  assert.equal(a.status, 'ok')
  assert.equal(a.blockscoutSkippedReason, 'Blockscout skipped — primary succeeded.')
  assert.equal(f.calls.filter((u) => u.includes('blockscout')).length, 0)
  assert.equal(a.activityProvenance?.structuralActivitySource, 'goldrush')
  assert.equal(a.activityProvenance?.fallbackStatus, 'not_needed')
})

for (const primary of [429, 'timeout'] as const) {
  const n = primary === 429 ? '2' : '3'
  test(`${n}. GoldRush ${primary} + Blockscout success -> activity partial with provenance, candidates preserved`, async () => {
    const wallet = nextWallet()
    const f = fakeFetch(wallet, { primary, fallback: 'ok' })
    const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: f.fn })
    const primaryReason = primary === 429 ? 'rate_limited' : 'timeout'
    assert.equal(a.status, 'partial', 'a fallback never upgrades the scan to ok')
    assert.equal(a.reason, `${primaryReason} (GoldRush primary); activity from Blockscout fallback`)
    assert.deepEqual(
      { primaryStatus: a.activityProvenance?.primaryStatus, fallbackStatus: a.activityProvenance?.fallbackStatus, source: a.activityProvenance?.structuralActivitySource },
      { primaryStatus: primaryReason, fallbackStatus: 'succeeded', source: 'blockscout' },
    )
    assert.ok(f.calls.some((u) => u.includes('/api/v2/addresses/') && u.includes('/transactions')))
    assert.ok(f.calls.some((u) => u.includes('/token-transfers')))
    assert.ok(a.blockscoutEvidence.blockscoutFallbackUsed)
    const c = robinhoodPnlV1CandidatesFromActivity(a)
    assert.ok(c.transactionCount > 0 && c.transferCount > 0 && c.candidates.length > 0)
    assert.deepEqual([...new Set(c.candidates.map((x) => x.txHash))].sort(), [H1, H2])
  })
}

test('4. GoldRush 429 + Blockscout failure -> unavailable with the exact blocker', async () => {
  const wallet = nextWallet()
  const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: fakeFetch(wallet, { primary: 429, fallback: 429 }).fn })
  assert.equal(a.status, 'unavailable')
  assert.equal(a.reason, 'rate_limited; Blockscout fallback failed: rate_limited_by_blockscout')
  assert.equal(a.activityProvenance?.fallbackStatus, 'failed')
  assert.equal(a.activityProvenance?.blockscoutConfigured, true)
})

test('5. a cached transient failure never suppresses a fresh fallback attempt, and is never cached', async () => {
  const wallet = nextWallet()
  const failed = await getCachedRobinhoodWalletActivity(wallet, fakeFetch(wallet, { primary: 429, fallback: 500 }).fn)
  assert.equal(failed.status, 'unavailable')
  assert.match(failed.reason!, /^rate_limited; Blockscout fallback failed: http_500$/)
  // Next scan: Blockscout recovered. The failure was not stored, so a fresh fallback runs.
  const f = fakeFetch(wallet, { primary: 429, fallback: 'ok' })
  const fresh = await getCachedRobinhoodWalletActivity(wallet, f.fn)
  assert.equal(fresh.fromCache, false)
  assert.equal(fresh.status, 'partial')
  assert.equal(fresh.items.length > 0, true)
  // Even a transient result handed in as `cached` (an old snapshot in KV) is retried, not replayed.
  const replay = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: fakeFetch(wallet, { primary: 429, fallback: 'ok' }).fn, cached: { ...failed, chainSlug: 'robinhood', wallet } })
  assert.equal(replay.fromCache, false)
  assert.equal(replay.status, 'partial')
  // Positive activity IS reused.
  const reused = await getCachedRobinhoodWalletActivity(wallet, fakeFetch(wallet, { primary: 429, fallback: 500 }).fn)
  assert.equal(reused.fromCache, true)
  assert.equal(reused.status, 'partial')
})

test('5b. concurrent scans of one wallet share one primary + fallback attempt (singleflight)', async () => {
  const wallet = nextWallet()
  const f = fakeFetch(wallet, { primary: 429, fallback: 'ok' })
  const [x, y, z] = await Promise.all([1, 2, 3].map(() => getCachedRobinhoodWalletActivity(wallet, f.fn)))
  assert.equal(f.calls.filter((u) => u.includes('transactions_v3')).length, 1)
  assert.deepEqual([x.status, y.status, z.status], ['partial', 'partial', 'partial'])
})

test('6. fallback transfer rows (token-transfers) create candidates even with no native tx row', async () => {
  const wallet = nextWallet()
  const base = fakeFetch(wallet, { primary: 429, fallback: 'ok' })
  const fn = async (url: string) => url.includes('/api/v2/addresses/') && url.includes('/transactions') && !url.includes('token-transfers')
    ? new Response(JSON.stringify({ items: [] }), { status: 200 })
    : base.fn(url)
  const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: fn })
  assert.equal(a.activityProvenance?.blockscoutTransactionRows, 0)
  assert.equal(a.activityProvenance?.blockscoutTransferRows, 2)
  const c = robinhoodPnlV1CandidatesFromActivity(a)
  assert.equal(c.transferCount, 2)
  assert.deepEqual([...new Set(c.candidates.map((x) => x.txHash))].sort(), [H1, H2])
})

test('7. candidates from a Blockscout fallback proceed into the V1 receipt verifier; audits log via console.warn', async () => {
  const wallet = nextWallet()
  const f = fakeFetch(wallet, { primary: 429, fallback: 'ok' })
  const receiptsAsked: string[] = []
  const rpc: v1.RhRpc = async (calls) => calls.map((c) => {
    if (c.method !== 'eth_getTransactionReceipt') return null
    receiptsAsked.push(String(c.params[0]))
    return { status: '0x1', from: wallet, blockNumber: '0x10', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [] }
  })
  const warned: string[] = []
  const origWarn = console.warn
  console.warn = (tag: unknown) => { warned.push(String(tag)) }
  try {
    const r = await scanRobinhoodWallet(wallet, f.fn, { rpc, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now })
    assert.equal(r.activity.status, 'partial')
    assert.deepEqual(receiptsAsked.sort(), [H1, H2])
    assert.equal(r.robinhoodPnl.ingestionAudit.candidateSwapTxCount, 2)
    assert.equal(r.robinhoodPnl.ingestionAudit.receiptsFetched, 2)
    assert.equal(r.robinhoodPnl.ingestionAudit.rejectionReasons.no_v4_swap_in_tx, 2)
    assert.doesNotMatch(r.robinhoodPnl.exactReason, /activity unavailable/)
  } finally {
    console.warn = origWarn
  }
  for (const tag of ['[robinhood-activity-fallback-audit]', '[robinhood-pnl-ingestion-audit]', '[robinhoodPnlVerificationAudit]', '[blockscoutFallbackDecisionAudit]']) {
    assert.ok(warned.includes(tag), `${tag} must be console.warn (production strips console.log)`)
  }
})

test('7b. the ingestion audit is emitted on early exits too (no RPC / no activity)', async () => {
  const warned: string[] = []
  const origWarn = console.warn
  console.warn = (tag: unknown) => { warned.push(String(tag)) }
  try {
    await v1.computeRobinhoodPnlV1({ wallet: nextWallet(), candidates: [], transactionCount: 0, transferCount: 0, activityUnavailableReason: 'rate_limited', deps: { rpc: null, ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now } })
    await v1.computeRobinhoodPnlV1({ wallet: nextWallet(), candidates: [], transactionCount: 0, transferCount: 0, activityUnavailableReason: 'rate_limited', deps: { rpc: async (c) => c.map(() => null), ethUsdRange: async () => null, tokenHistoricalUsd: async () => null, now: Date.now } })
  } finally {
    console.warn = origWarn
  }
  assert.equal(warned.filter((t) => t === '[robinhood-pnl-ingestion-audit]').length, 2)
  const lane = readFileSync(new URL('../lib/server/robinhoodPnlV1.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(lane, /console\.log\(/)
})

test('Blockscout budget: per-tx evidence lookups cannot use up the activity fallback lane', async () => {
  for (let i = 0; i < 6; i++) await blockscout.getBlockscoutTransactionLogs(`0x${String(i).repeat(64)}`, async () => new Response(JSON.stringify({ items: [] }), { status: 200 }))
  const wallet = nextWallet()
  const a = await resolveRobinhoodWalletActivity(wallet, { fetchImpl: fakeFetch(wallet, { primary: 429, fallback: 'ok' }).fn })
  assert.equal(a.activityProvenance?.fallbackStatus, 'succeeded')
})

test('8. Base/ETH unchanged: no Base/ETH pipeline module imports the Robinhood activity/Blockscout code', () => {
  const root = new URL('../', import.meta.url).pathname
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []
  })
  // The Base/ETH pipeline and its modules (src/lib/walletScannerPipelineAudit.ts only names the sidecar in prose).
  for (const f of [...walk(join(root, 'src/pipeline')), ...walk(join(root, 'src/modules'))]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /robinhoodWalletScanner|robinhoodBlockscoutEvidence|robinhoodPnlV1/, f)
  }
})
