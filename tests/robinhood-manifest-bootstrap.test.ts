// Robinhood verified-swap manifest bootstrap: an empty manifest starts a bounded, resumable discovery pass over the
// wallet's paginated Blockscout ERC-20 transfers. Rows are hints only — they take the manifest's reserved slots and
// pass the unchanged verifier; only current-scan acceptances are written. The marker keeps the cursor so each scan
// continues where the last stopped, and a started bootstrap keeps resuming after the manifest gains entries.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, selectRobinhoodPnlV1CandidatesWithManifest, __resetRobinhoodPnlV1CachesForTest,
  RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, ROBINHOOD_PNL_V1_LIMITS,
  type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1Deps, type RobinhoodPnlV1Candidate,
} from '../lib/server/robinhoodPnlV1.ts'
import {
  readRobinhoodVerifiedSwapManifest, recordRobinhoodVerifiedSwaps, robinhoodVerifiedSwapManifestKey, __setRobinhoodVerifiedSwapManifestKvForTest,
  readRobinhoodManifestBootstrapMarker, writeRobinhoodManifestBootstrapMarker, robinhoodManifestBootstrapKey, __setRobinhoodManifestBootstrapKvForTest,
  advanceRobinhoodManifestBootstrapMarker, newRobinhoodManifestBootstrapMarker, rankRobinhoodBootstrapPending, settleRobinhoodManifestBootstrapMarker,
  ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS, ROBINHOOD_MANIFEST_BOOTSTRAP_CAS_SCRIPT, mergeRobinhoodManifestBootstrapMarkers, type RobinhoodManifestBootstrapMarker,
} from '../lib/server/robinhoodVerifiedSwapManifest.ts'
import { getBlockscoutWalletTokenTransferPages, __resetRobinhoodBlockscoutRateLimitForTest } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.BLOCKSCOUT_API_KEY = 'test-key'
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

const TS = 1790155166
const WALLET = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const ROUTER = '0x248a454a0000000000000000000000000000beef'
const RELAYER = '0x7777777777777777777777777777777777777777'
const SPAMMER = '0x5555555555555555555555555555555555555555'
const A = '0xaaaa000000000000000000000000000000000001'
const B = '0xbbbb000000000000000000000000000000000002'
const E18 = BigInt(10) ** BigInt(18)
const n = (x: number) => BigInt(Math.round(x * 1000)) * E18 / BigInt(1000)
const pad = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
const t = (a: string) => `0x${pad(a)}`
const int256 = (v: bigint) => pad((v < BigInt(0) ? (BigInt(1) << BigInt(256)) + v : v).toString(16))
const uint = (v: bigint) => pad(v.toString(16))
const hex = (v: number | bigint) => `0x${BigInt(v).toString(16)}`
const H = (name: string) => keccak256(toHex(`bootstrap-test:${name}`)).toLowerCase()

const POOLS = new Map<string, string>()
function poolId(x: string, y: string) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}
type Log = { address: string; topics: string[]; data: string; logIndex: string; blockTimestamp: string }
class Tx {
  logs: Log[] = []
  txValue = BigInt(0)
  trace: RhNativeTransfer[] | null = []
  sender = WALLET
  to: string = ROUTER
  constructor(public ts: number) {}
  private i = 0
  private push(address: string, topics: string[], data: string) { this.logs.push({ address, topics, data, logIndex: hex(this.i++), blockTimestamp: hex(this.ts) }); return this }
  xfer(token: string, from: string, to: string, amt: bigint) { return this.push(token, [ERC20_TRANSFER_TOPIC0, t(from), t(to)], `0x${uint(amt)}`) }
  v4(inTok: string, outTok: string, inAmt: bigint, outAmt: bigint) {
    const p = poolId(inTok, outTok)
    const d: Record<string, bigint> = { [inTok]: -inAmt, [outTok]: outAmt }
    return this.push(PM, [V4_SWAP_TOPIC0, p.id, t(ROUTER)], `0x${int256(d[p.c0])}${int256(d[p.c1])}${'0'.repeat(256)}`)
  }
}
const pay = (from: string, to: string, value: bigint): RhNativeTransfer => ({ from, to, value, success: true })
function directBuy(eth: bigint, amount: bigint, ts: number) { const tx = new Tx(ts).v4(RH_NATIVE, A, eth, amount).xfer(A, PM, WALLET, amount); tx.txValue = eth; return tx }
function relayedBuy(eth: bigint, amount: bigint, ts: number) {
  const tx = new Tx(ts).v4(RH_NATIVE, A, eth, amount).xfer(A, PM, WALLET, amount)
  tx.sender = RELAYER
  tx.trace = [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)]
  return tx
}
// Router-settled: the PoolManager pays the router, which forwards to the wallet (no PoolManager counterparty row).
function routerSettledBuy(eth: bigint, amount: bigint, ts: number) {
  const tx = new Tx(ts).v4(RH_NATIVE, A, eth, amount).xfer(A, PM, ROUTER, amount).xfer(A, ROUTER, WALLET, amount)
  tx.txValue = eth
  return tx
}
const airdrop = (ts: number) => { const tx = new Tx(ts).xfer(B, SPAMMER, WALLET, n(1)); tx.sender = SPAMMER; tx.to = B; return tx }
// A token transfer FROM the PoolManager that is not a swap (no V4 Swap log): a PoolManager-ranked hint that must fail.
const pmDust = (ts: number) => { const tx = new Tx(ts).xfer(A, PM, WALLET, n(5)); tx.sender = SPAMMER; tx.to = PM; return tx }

// ── Fake KV (hash + string) ──────────────────────────────────────────────────────────────────────────────────
class FakeKv {
  hashes = new Map<string, Map<string, unknown>>()
  strings = new Map<string, unknown>()
  failGet = false
  async hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    const h = this.hashes.get(key)
    if (!h || h.size === 0) return null
    return Object.fromEntries([...h].map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v])) as T
  }
  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    const h = this.hashes.get(key) ?? new Map<string, unknown>()
    for (const [k, v] of Object.entries(fields)) h.set(k, v)
    this.hashes.set(key, h)
    return 1
  }
  async get<T>(key: string): Promise<T | null> {
    if (this.failGet) throw new Error('kv down')
    const v = this.strings.get(key) // read now, return later: a genuinely stale read under concurrency
    if (this.getDelayMs) await new Promise((r) => setTimeout(r, this.getDelayMs))
    return (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v) as T | null
  }
  async set(key: string, value: unknown): Promise<'OK'> { this.strings.set(key, value); return 'OK' }
  getDelayMs = 0
  casCalls = 0
  casConflicts = 0
  // Faithful emulation of ROBINHOOD_MANIFEST_BOOTSTRAP_CAS_SCRIPT (atomic: no await between check and set).
  async eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData> {
    assert.equal(script, ROBINHOOD_MANIFEST_BOOTSTRAP_CAS_SCRIPT)
    this.casCalls += 1
    const cur = this.strings.get(keys[0])
    let v = 0
    if (cur != null) { try { const d = JSON.parse(String(cur)); if (d && typeof d === 'object' && typeof d.version === 'number') v = d.version } catch { /* not json */ } }
    if (v !== Number(args[0])) { this.casConflicts += 1; return 0 as TData }
    this.strings.set(keys[0], args[1])
    return 1 as TData
  }
  manifest() { return [...(this.hashes.get(robinhoodVerifiedSwapManifestKey(WALLET))?.keys() ?? [])].sort() }
  marker(): RobinhoodManifestBootstrapMarker | null { const v = this.strings.get(robinhoodManifestBootstrapKey(WALLET)); return v ? JSON.parse(String(v)) : null }
}
let kv: FakeKv

// ── Fake paginated Blockscout wallet token-transfers ─────────────────────────────────────────────────────────
type Chain = Map<string, { name: string; tx: Tx; block: number }>
function chainOf(specs: Array<[string, Tx]>): Chain { return new Map(specs.map(([name, tx]) => [H(name), { name, tx, block: 1000 + (tx.ts - TS) }])) }
function rowsFor(chain: Chain, name: string) {
  const e = chain.get(H(name))!
  return e.tx.logs.filter((l) => l.topics[0] === ERC20_TRANSFER_TOPIC0)
    .map((l) => ({ from: `0x${l.topics[1].slice(-40)}`, to: `0x${l.topics[2].slice(-40)}`, l }))
    .filter((x) => x.from === WALLET || x.to === WALLET)
    .map((x) => ({
      transaction_hash: H(name), block_number: e.block, timestamp: new Date(e.tx.ts * 1000).toISOString(),
      from: { hash: x.from }, to: { hash: x.to }, total: { value: BigInt(x.l.data).toString(), decimals: '18' }, token: { address_hash: x.l.address },
    }))
}
type PageSpec = { names: string[]; status?: number; malformed?: boolean; repeatCursor?: boolean }
function blockscout(chain: Chain, pages: PageSpec[]) {
  const requested: number[] = []
  const cursorFor = (i: number) => ({ block_number: 10_000 - i, index: 0, items_count: 50 * i })
  const fetchImpl = async (url: string) => {
    const u = new URL(url)
    assert.ok(u.pathname.endsWith(`/addresses/${WALLET}/token-transfers`) && u.searchParams.get('type') === 'ERC-20', url)
    const bn = u.searchParams.get('block_number')
    const i = bn == null ? 0 : 10_000 - Number(bn)
    requested.push(i)
    const p = pages[i]
    if (!p) return new Response('{}', { status: 404 })
    if (p.status) return new Response('upstream error', { status: p.status })
    const items = p.names.flatMap((name) => rowsFor(chain, name))
    if (p.malformed) return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
    const next = p.repeatCursor ? cursorFor(i) : i + 1 < pages.length ? cursorFor(i + 1) : null
    return new Response(JSON.stringify({ items, next_page_params: next }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, requested }
}

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

type ScanOpts = { activity?: string[]; pages: PageSpec[]; stored?: Set<string>; receiptDown?: Set<string>; bootstrap?: boolean; configured?: boolean; deps?: Partial<RobinhoodPnlV1Deps> }
async function scan(chain: Chain, opts: ScanOpts) {
  __resetRobinhoodPnlV1CachesForTest()
  __resetRobinhoodBlockscoutRateLimitForTest()
  const byBlock = new Map([...chain.values()].map((v) => [v.block, v]))
  const receiptCalls: string[] = []
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') {
      const e = chain.get(p[0])
      receiptCalls.push(e?.name ?? p[0])
      if (e && opts.receiptDown?.has(e.name)) return null
      return e ? { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs } : null
    }
    if (method === 'eth_getTransactionByHash') { const e = chain.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.get(Number(p[1]))?.tx.sender === WALLET ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const liveTraces: string[] = []
  const bs = blockscout(chain, opts.pages)
  const candidates: RobinhoodPnlV1Candidate[] = (opts.activity ?? []).map((name) => {
    const e = chain.get(H(name))!
    return { txHash: H(name), timestampMs: e.tx.ts * 1000, hasSwapLog: e.tx.logs.some((l) => l.topics[0] === V4_SWAP_TOPIC0) }
  })
  const w = console.warn
  console.warn = () => {}
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates, transactionCount: candidates.length, transferCount: candidates.length, activityUnavailableReason: null,
      deps: {
        rpc, now: () => 1_800_000_000_000, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null,
        nativeTransfersForTx: async (h) => { const e = chain.get(h)!; liveTraces.push(e.name); return e.tx.trace },
        nativeTraceCached: async (h) => { const e = chain.get(h); return e && opts.stored?.has(e.name) && e.tx.trace ? { transfers: e.tx.trace, audit: null } : null },
        verifiedSwapManifest: { read: readRobinhoodVerifiedSwapManifest, record: recordRobinhoodVerifiedSwaps },
        ...(opts.bootstrap === false ? {} : {
          manifestBootstrap: {
            configured: () => opts.configured ?? true,
            readMarker: readRobinhoodManifestBootstrapMarker, writeMarker: writeRobinhoodManifestBootstrapMarker,
            discover: (wallet, cursor, caps) => getBlockscoutWalletTokenTransferPages(wallet, cursor, bs.fetchImpl, caps),
          },
        }),
        ...opts.deps,
      },
    })
    const name = (h: string) => chain.get(h)?.name ?? h
    return { r, a: r.ingestionAudit, boot: r.ingestionAudit.manifestBootstrap, receiptCalls, liveTraces, requested: bs.requested, name }
  } finally { console.warn = w }
}

beforeEach(() => {
  __resetRobinhoodPnlV1CachesForTest()
  __resetRobinhoodBlockscoutRateLimitForTest()
  kv = new FakeKv()
  __setRobinhoodVerifiedSwapManifestKvForTest(kv)
  __setRobinhoodManifestBootstrapKvForTest(kv)
})

const noise = (prefix: string, count: number, ts: number): Array<[string, Tx]> => Array.from({ length: count }, (_, i) => [`${prefix}${i}`, airdrop(ts - i)])

test('multi-scan: bootstrap proves X on page 1, then resumes page 2 (Y) and page 3 (Z) although the manifest is non-empty', async () => {
  // Newest-first history: page 1 = X + 7 airdrops, page 2 = Y + 7, page 3 = Z (router-settled) + 7, then exhausted.
  const p1 = noise('a', 7, TS + 900), p2 = noise('b', 7, TS + 600), p3 = noise('c', 7, TS + 300)
  const chain = chainOf([['X', relayedBuy(n(0.01), n(1000), TS + 950)], ['Y', directBuy(n(0.02), n(1500), TS + 650)], ['Z', routerSettledBuy(n(0.03), n(2000), TS + 350)], ...p1, ...p2, ...p3])
  const pages: PageSpec[] = [
    { names: ['X', ...p1.map(([k]) => k)] }, { names: ['Y', ...p2.map(([k]) => k)] }, { names: ['Z', ...p3.map(([k]) => k)] },
  ]

  const A1 = await scan(chain, { pages })
  assert.deepEqual(A1.requested, [0], 'page 1 only — 8 hints fill the reserve')
  assert.deepEqual([A1.boot!.attempted, A1.boot!.resumed, A1.boot!.pagesThisScan, A1.boot!.pagesTotal, A1.boot!.rowsThisScan, A1.boot!.poolManagerCounterpartyRows], [true, false, 1, 1, 8, 1])
  assert.equal(A1.boot!.selectedCandidates[0].txHash, H('X'), 'PoolManager counterparty ranks first')
  assert.equal(A1.boot!.selectedCandidates.find((c) => c.txHash === H('X'))?.result, 'verified')
  assert.equal(A1.boot!.selectedCandidates.filter((c) => c.result === 'rejected').length, 7)
  assert.deepEqual([A1.boot!.verifiedCount, A1.boot!.writtenCount, A1.boot!.cursorAdvanced, A1.boot!.completed], [1, 1, true, false])
  assert.equal(A1.a.verifiedSwapTxCount, 1)
  assert.deepEqual(kv.manifest(), [H('X')])
  assert.deepEqual([kv.marker()!.pagesScanned, kv.marker()!.completed, kv.marker()!.pending.length], [1, false, 0])

  // Scan B: the manifest now holds X — bootstrap still resumes from page 2 (never page 1 again).
  const B1 = await scan(chain, { pages, stored: new Set(['X']) })
  assert.deepEqual(B1.requested, [1])
  assert.deepEqual([B1.boot!.resumed, B1.boot!.pagesThisScan, B1.boot!.pagesTotal], [true, 1, 2])
  const injectedB = B1.a.candidateSelection!.selectedCandidates
  assert.equal(injectedB.filter((c) => c.source === 'verified_manifest').length, 1)
  assert.equal(injectedB.filter((c) => c.source === 'manifest_bootstrap').length, 7, 'bootstrap uses what manifest replay left of the 8 reserved slots')
  assert.equal(B1.boot!.selectedCandidates[0].txHash, H('Y'))
  assert.equal(B1.a.verifiedSwapTxCount, 2, 'X re-verified + Y proven')
  assert.deepEqual(kv.manifest(), [H('X'), H('Y')].sort())
  assert.equal(kv.marker()!.pending.length, 1, 'one page-2 hint waits for a free slot')

  // Scan C: resumes page 3; Z is router-settled (no PoolManager counterparty) and still eligible.
  const C1 = await scan(chain, { pages, stored: new Set(['X']) })
  assert.deepEqual(C1.requested, [2])
  assert.equal(C1.boot!.pagesTotal, 3)
  const z = C1.boot!.selectedCandidates.find((c) => c.txHash === H('Z'))!
  assert.deepEqual([z.poolManagerCounterparty, z.result], [false, 'verified'])
  assert.equal(C1.a.verifiedSwapTxCount, 3)
  assert.deepEqual(kv.manifest(), [H('X'), H('Y'), H('Z')].sort())
  assert.equal(C1.boot!.stopReason, 'history_exhausted')

  // Scan D: discovery done; the remaining hint drains, then the marker completes. Everything re-verifies from the manifest.
  let D1 = await scan(chain, { pages, stored: new Set(['X']) })
  while (!kv.marker()!.completed) D1 = await scan(chain, { pages, stored: new Set(['X']) })
  assert.ok(kv.marker()!.completedAt)
  const E1 = await scan(chain, { pages, stored: new Set(['X']) })
  assert.deepEqual(E1.requested, [], 'a completed marker never pages again')
  assert.deepEqual([E1.boot!.attempted, E1.boot!.reason, E1.boot!.completed], [false, 'marker_completed', true])
  assert.equal(E1.a.verifiedSwapTxCount, 3)
  assert.deepEqual(E1.a.verifiedSwapManifest!.replayResults.manifest_reverified, 3)
  assert.ok(D1)
})

test('history exhausted on the first page marks the marker complete', async () => {
  const chain = chainOf([['Y', directBuy(n(0.02), n(1500), TS + 10)]])
  const s = await scan(chain, { pages: [{ names: ['Y'] }] })
  assert.deepEqual([s.boot!.stopReason, s.boot!.completed, kv.marker()!.completed, kv.marker()!.discoveryDone], ['history_exhausted', true, true, true])
  assert.deepEqual(kv.manifest(), [H('Y')])
})

test('lifetime cap: never more than 12 pages per wallet, then discovery is done', async () => {
  const L = ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS
  const prev = { ...newRobinhoodManifestBootstrapMarker(WALLET, 1), pagesScanned: 10, cursor: 'block_number=1&index=0' }
  const next = advanceRobinhoodManifestBootstrapMarker(prev, { rows: [], pagesRequested: 2, pagesSucceeded: 2, rowsScanned: 100, nextCursor: 'block_number=0&index=0', exhausted: false, stopReason: 'page_cap' }, new Set(), 2)
  assert.deepEqual([next.pagesScanned, next.discoveryDone, next.stopReason], [12, true, 'lifetime_page_cap'])
  assert.equal(settleRobinhoodManifestBootstrapMarker(next, new Map(), 3).completed, true)
  // end to end: a marker at 11 pages only gets one more page this scan
  const chain = chainOf(noise('q', 40, TS + 500))
  const pages: PageSpec[] = Array.from({ length: 13 }, (_, i) => ({ names: [`q${i}`] }))
  await writeRobinhoodManifestBootstrapMarker(WALLET, { ...newRobinhoodManifestBootstrapMarker(WALLET, 1), pagesScanned: 11, cursor: 'block_number=9989&index=0&items_count=550' })
  const s = await scan(chain, { pages })
  assert.deepEqual(s.requested, [11])
  assert.deepEqual([s.boot!.pagesTotal, kv.marker()!.discoveryDone, kv.marker()!.stopReason], [L.maxPagesLifetime, true, 'lifetime_page_cap'])
})

test('a transient provider failure keeps the last good cursor; the next scan resumes there', async () => {
  const p1 = noise('a', 3, TS + 900), p2 = noise('b', 3, TS + 600)
  const chain = chainOf([...p1, ...p2, ['Y', directBuy(n(0.02), n(1500), TS + 100)]])
  // page 1 ok (3 hints, below the 8-hint stop) → page 2 fails with 503
  const s1 = await scan(chain, { pages: [{ names: p1.map(([k]) => k) }, { names: [], status: 503 }] })
  assert.deepEqual(s1.requested, [0, 1])
  const m1 = kv.marker()!
  assert.deepEqual([m1.pagesScanned, m1.discoveryDone, m1.cursor], [1, false, 'block_number=9999&index=0&items_count=50'])
  // next scan: the first request is page 2 again (cursor preserved), which now succeeds
  const s2 = await scan(chain, { pages: [{ names: p1.map(([k]) => k) }, { names: ['Y', ...p2.map(([k]) => k)] }] })
  assert.deepEqual(s2.requested, [1])
  assert.deepEqual(kv.manifest(), [H('Y')])
  // a failure before any page leaves the cursor untouched and counts one consecutive failure
  const before = kv.marker()!
  // (a completed marker is never regressed by a normal write — seed the incomplete state directly)
  assert.equal((await writeRobinhoodManifestBootstrapMarker(WALLET, { ...before, completed: false, completedAt: null })).reason, 'merged_with_stored')
  assert.equal(kv.marker()!.completed, true, 'completion is sticky under merge')
  kv.strings.set(robinhoodManifestBootstrapKey(WALLET), JSON.stringify({ ...before, discoveryDone: false, completed: false, completedAt: null, cursor: 'block_number=9998&index=0&items_count=100', pending: [] }))
  const s3 = await scan(chain, { pages: [{ names: [] }, { names: [] }, { names: [], status: 500 }] })
  assert.deepEqual(s3.requested, [2])
  assert.deepEqual([kv.marker()!.cursor, kv.marker()!.consecutiveFailures, kv.marker()!.discoveryDone], ['block_number=9998&index=0&items_count=100', 1, false])
})

test('a repeated cursor stops safely: the page is not counted and discovery is done', async () => {
  const chain = chainOf(noise('a', 2, TS + 900))
  const s = await scan(chain, { pages: [{ names: ['a0', 'a1'], repeatCursor: true }] })
  assert.ok(s)
  const pager = await getBlockscoutWalletTokenTransferPages(WALLET, 'block_number=10000&index=0&items_count=0', blockscout(chain, [{ names: ['a0'], repeatCursor: true }]).fetchImpl, { maxPages: 4, deadlineAt: Date.now() + 4000 })
  assert.deepEqual([pager.stopReason, pager.pagesSucceeded, pager.rows.length, pager.nextCursor], ['repeated_cursor', 0, 0, 'block_number=10000&index=0&items_count=0'])
  // page 1 (no cursor) whose next cursor points back at itself is caught on the second request
  const m = kv.marker()!
  assert.equal(m.discoveryDone, true)
  assert.equal(m.stopReason, 'repeated_cursor')
})

test('a malformed page fails safely: no rows, cursor unchanged, retried later', async () => {
  const chain = chainOf(noise('a', 2, TS + 900))
  const s = await scan(chain, { pages: [{ names: ['a0', 'a1'], malformed: true }] })
  assert.deepEqual([s.boot!.pagesThisScan, s.boot!.stopReason, s.boot!.selectedCandidates.length], [0, 'malformed_page', 0])
  assert.deepEqual([kv.marker()!.cursor, kv.marker()!.pagesScanned, kv.marker()!.discoveryDone, kv.marker()!.consecutiveFailures], [null, 0, false, 1])
  // a stored cursor that is not a canonical query string is never sent
  const bad = await getBlockscoutWalletTokenTransferPages(WALLET, 'x=1&<script>', blockscout(chain, []).fetchImpl, { maxPages: 4, deadlineAt: Date.now() + 4000 })
  assert.equal(bad.stopReason, 'invalid_cursor')
})

test('ranking: PoolManager counterparty first, then blockNumber DESC, then txHash ASC; router rows stay eligible', () => {
  const ranked = rankRobinhoodBootstrapPending([
    { txHash: H('r-new'), blockNumber: 900, poolManagerCounterparty: false, attempts: 0 },
    { txHash: H('pm-old'), blockNumber: 100, poolManagerCounterparty: true, attempts: 0 },
    { txHash: H('pm-new'), blockNumber: 500, poolManagerCounterparty: true, attempts: 0 },
    { txHash: H('r-unknown'), blockNumber: null, poolManagerCounterparty: false, attempts: 0 },
  ])
  assert.deepEqual(ranked.map((p) => p.txHash), [H('pm-new'), H('pm-old'), H('r-new'), H('r-unknown')])
  const { selected } = selectRobinhoodPnlV1CandidatesWithManifest([], [], ranked)
  assert.deepEqual(selected.map((c) => [c.txHash, c.source, c.selectionReason]), ranked.map((p) => [p.txHash, 'manifest_bootstrap', 'bootstrap_reserved_slot']))
})

test('receipts stay <= 20 and live native traces <= 3 with manifest + bootstrap + busy current activity', async () => {
  const relayed: Array<[string, Tx]> = Array.from({ length: 10 }, (_, i) => [`R${i}`, relayedBuy(n(0.01 + i / 1000), n(1000 + i), TS + 500 + i)])
  const current = noise('cur', 30, TS + 5000)
  const chain = chainOf([...relayed, ...current])
  await recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('R9'), blockNumber: 1509, timestampMs: null }, { txHash: H('R8'), blockNumber: 1508, timestampMs: null }], [], 1)
  await writeRobinhoodManifestBootstrapMarker(WALLET, newRobinhoodManifestBootstrapMarker(WALLET, 1))
  const s = await scan(chain, { activity: current.map(([k]) => k), pages: [{ names: relayed.map(([k]) => k) }] })
  const sel = s.a.candidateSelection!.selectedCandidates
  assert.equal(sel.length, ROBINHOOD_PNL_V1_LIMITS.maxCandidateReceipts)
  assert.ok(s.receiptCalls.length <= 20, String(s.receiptCalls.length))
  assert.deepEqual([sel.filter((c) => c.source === 'verified_manifest').length, sel.filter((c) => c.source === 'manifest_bootstrap').length, sel.filter((c) => c.source === 'current_activity').length], [2, 6, 12])
  assert.ok(s.liveTraces.length <= 3, s.liveTraces.join(','))
  assert.equal(s.a.nativeTraceGlobalBudget!.totalLiveUsed <= 3, true)
  // relayed hints that could not get a trace are trace_unavailable — retried later, never accepted
  assert.ok(s.boot!.selectedCandidates.some((c) => c.result === 'trace_unavailable'))
  assert.ok(kv.marker()!.pending.some((p) => p.attempts === 1))
})

test('no Blockscout / KV config, or a failed lookup: bootstrap never runs and selection is unchanged', async () => {
  const chain = chainOf([['Y', directBuy(n(0.02), n(1500), TS + 10)], ...noise('a', 5, TS + 900)])
  const activity = noise('a', 5, TS + 900).map(([k]) => k)
  const off = await scan(chain, { activity, pages: [{ names: ['Y'] }], bootstrap: false })
  const unconfigured = await scan(chain, { activity, pages: [{ names: ['Y'] }], configured: false })
  assert.equal(unconfigured.boot, undefined)
  assert.deepEqual(unconfigured.requested, [])
  assert.deepEqual(unconfigured.a.candidateSelection!.selectedCandidates.map((c) => c.txHash), off.a.candidateSelection!.selectedCandidates.map((c) => c.txHash))
  __setRobinhoodManifestBootstrapKvForTest(null)
  const noKv = await scan(chain, { activity, pages: [{ names: ['Y'] }] })
  assert.deepEqual([noKv.boot!.attempted, noKv.boot!.reason, noKv.requested.length], [false, 'kv_not_configured', 0])
  assert.deepEqual(noKv.a.candidateSelection!.selectedCandidates.map((c) => c.txHash), off.a.candidateSelection!.selectedCandidates.map((c) => c.txHash))
  __setRobinhoodManifestBootstrapKvForTest(kv)
  kv.failGet = true
  const failed = await scan(chain, { activity, pages: [{ names: ['Y'] }] })
  assert.deepEqual([failed.boot!.attempted, failed.boot!.reason, failed.requested.length], [false, 'marker_lookup_failed', 0])
  kv.failGet = false
  // a non-empty manifest with no marker never starts a bootstrap
  await recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('Y'), blockNumber: 1010, timestampMs: null }], [], 1)
  const nonEmpty = await scan(chain, { activity, pages: [{ names: ['Y'] }] })
  assert.deepEqual([nonEmpty.boot!.attempted, nonEmpty.boot!.reason, nonEmpty.requested.length], [false, 'manifest_not_empty', 0])
})

test('discovery evidence never reaches PnL: a PoolManager-ranked non-swap hint is rejected, not recorded, not in FIFO', async () => {
  const chain = chainOf([['dust', pmDust(TS + 50)]])
  const s = await scan(chain, { pages: [{ names: ['dust'] }] })
  const d = s.boot!.selectedCandidates[0]
  assert.deepEqual([d.txHash, d.poolManagerCounterparty, d.result], [H('dust'), true, 'rejected'])
  assert.deepEqual([s.a.verifiedSwapTxCount, s.r.swapsVerified, s.a.normalizedBuyCount, s.a.normalizedSellCount], [0, 0, 0, 0])
  assert.equal(s.r.realizedPnlUsd, null)
  assert.deepEqual(kv.manifest(), [])
  assert.equal(s.boot!.writtenCount, 0)
})

test('overlap: a hint also selected by current activity keeps pending on receipt_unavailable, then verifies and enters the manifest', async () => {
  const chain = chainOf([['H', directBuy(n(0.02), n(1500), TS + 10)]])
  const s1 = await scan(chain, { activity: ['H'], pages: [{ names: ['H'] }], receiptDown: new Set(['H']) })
  const h1 = s1.a.candidateSelection!.selectedCandidates.find((c) => c.txHash === H('H'))!
  assert.equal(h1.source, 'current_activity', 'selected by the normal lane, not bootstrap')
  assert.equal(s1.a.verifiedSwapTxCount, 0)
  assert.deepEqual(kv.marker()!.pending.map((p) => [p.txHash, p.attempts]), [[H('H'), 1]], 'transient → stays pending, attempts+1')
  assert.deepEqual([kv.marker()!.completed, kv.marker()!.retired], [false, []])
  assert.deepEqual(kv.manifest(), [])
  const s2 = await scan(chain, { activity: ['H'], pages: [{ names: ['H'] }] })
  assert.deepEqual(s2.requested, [], 'discovery already done; only the pending hint settles')
  assert.equal(s2.a.verifiedSwapTxCount, 1)
  assert.deepEqual(kv.manifest(), [H('H')])
  assert.deepEqual([kv.marker()!.pending, kv.marker()!.retired, kv.marker()!.completed], [[], [H('H')], true])
})

test('overlap: native trace unavailable on the normal lane keeps the hint pending; a later scan with budget proves it', async () => {
  const chain = chainOf([['R', relayedBuy(n(0.01), n(1000), TS + 10)]])
  const s1 = await scan(chain, { activity: ['R'], pages: [{ names: ['R'] }], deps: { nativeTraceLiveCap: 0 } })
  assert.equal(s1.a.candidateSelection!.selectedCandidates[0].source, 'current_activity')
  assert.equal(s1.a.verifiedSwapTxCount, 0)
  assert.deepEqual(kv.marker()!.pending.map((p) => [p.txHash, p.attempts]), [[H('R'), 1]])
  const s2 = await scan(chain, { activity: ['R'], pages: [{ names: ['R'] }] })
  assert.equal(s2.a.relayedWalletVerifiedSwapCount, 1)
  assert.deepEqual(kv.manifest(), [H('R')])
  assert.deepEqual([kv.marker()!.pending, kv.marker()!.completed], [[], true])
})

test('overlap: a deterministic rejection by the normal lane retires the hint; repeated transient failures retire after max attempts', async () => {
  const chain = chainOf([['junk', airdrop(TS + 10)], ['H', directBuy(n(0.02), n(1500), TS + 5)]])
  await scan(chain, { activity: ['junk'], pages: [{ names: ['junk'] }] })
  assert.deepEqual([kv.marker()!.pending, kv.marker()!.retired, kv.marker()!.completed], [[], [H('junk')], true])
  kv.strings.clear()
  for (let i = 0; i < ROBINHOOD_MANIFEST_BOOTSTRAP_LIMITS.maxAttempts; i++) await scan(chain, { activity: ['H'], pages: [{ names: ['H'] }], receiptDown: new Set(['H']) })
  assert.deepEqual([kv.marker()!.pending, kv.marker()!.retired, kv.marker()!.completed], [[], [H('H')], true], 'bounded: retired after maxAttempts')
})

test('concurrent same-page marker writes keep both writers\' pending hints, max attempts and furthest progress', async () => {
  const base = { ...newRobinhoodManifestBootstrapMarker(WALLET, 1), pagesScanned: 1, rowsScanned: 50, cursor: 'block_number=9999&index=0&items_count=50' }
  await writeRobinhoodManifestBootstrapMarker(WALLET, base)
  const p = (name: string, attempts: number, pm: boolean, block: number | null) => ({ txHash: H(name), attempts, poolManagerCounterparty: pm, blockNumber: block })
  const one: RobinhoodManifestBootstrapMarker = { ...base, updatedAt: 2, pending: [p('P1', 0, false, null), p('shared', 2, false, 700)] }
  const two: RobinhoodManifestBootstrapMarker = { ...base, updatedAt: 3, rowsScanned: 60, pending: [p('P2', 1, true, 800), p('shared', 0, true, null)] }
  kv.getDelayMs = 2 // both writers read the same stored version before either sets
  const results = await Promise.all([writeRobinhoodManifestBootstrapMarker(WALLET, one), writeRobinhoodManifestBootstrapMarker(WALLET, two)])
  kv.getDelayMs = 0
  assert.ok(results.every((r) => r.written), JSON.stringify(results))
  assert.ok(kv.casConflicts >= 1, 'the race really happened and was retried')
  const m = kv.marker()!
  assert.deepEqual(m.pending.map((x) => x.txHash).sort(), [H('P1'), H('P2'), H('shared')].sort())
  const shared = m.pending.find((x) => x.txHash === H('shared'))!
  assert.deepEqual([shared.attempts, shared.poolManagerCounterparty, shared.blockNumber], [2, true, 700])
  assert.deepEqual([m.pagesScanned, m.rowsScanned, m.cursor, m.version], [1, 60, base.cursor, 3])
  // a stale writer at the same page count can't drop pending added by another scan or un-retire a decided hint
  await writeRobinhoodManifestBootstrapMarker(WALLET, { ...base, pending: [], retired: [H('P1')] })
  await writeRobinhoodManifestBootstrapMarker(WALLET, { ...base, pending: [p('P1', 0, false, null)] })
  assert.deepEqual(kv.marker()!.pending.map((x) => x.txHash).sort(), [H('P2'), H('shared')].sort())
  assert.deepEqual(kv.marker()!.retired, [H('P1')])
})

test('merge: furthest progress wins the cursor; done/completed are sticky; counters take the max', () => {
  const a = { ...newRobinhoodManifestBootstrapMarker(WALLET, 1), pagesScanned: 3, rowsScanned: 150, cursor: 'block_number=3&index=0', version: 4 }
  const b = { ...newRobinhoodManifestBootstrapMarker(WALLET, 2), pagesScanned: 2, rowsScanned: 160, cursor: 'block_number=2&index=0', discoveryDone: false, version: 2 }
  const m = mergeRobinhoodManifestBootstrapMarkers(b, a)
  assert.deepEqual([m.pagesScanned, m.rowsScanned, m.cursor], [3, 160, a.cursor])
  const done = { ...a, discoveryDone: true, cursor: null, stopReason: 'history_exhausted' }
  const tie = mergeRobinhoodManifestBootstrapMarkers(done, { ...a, updatedAt: 9 })
  assert.deepEqual([tie.discoveryDone, tie.cursor, tie.stopReason], [true, null, 'history_exhausted'])
  const completed = mergeRobinhoodManifestBootstrapMarkers({ ...done, completed: true, completedAt: 5 }, { ...a })
  assert.deepEqual([completed.completed, completed.completedAt], [true, 5])
})

test('markers written before retired/version existed still read (as none / version 0) and upgrade on write', async () => {
  const legacy = { ...newRobinhoodManifestBootstrapMarker(WALLET, 1), pagesScanned: 1, cursor: 'block_number=9999&index=0&items_count=50' } as Record<string, unknown>
  delete legacy.retired
  delete legacy.version
  kv.strings.set(robinhoodManifestBootstrapKey(WALLET), JSON.stringify(legacy))
  const read = await readRobinhoodManifestBootstrapMarker(WALLET)
  assert.deepEqual([read.marker?.retired, read.marker?.version], [[], 0])
  assert.equal((await writeRobinhoodManifestBootstrapMarker(WALLET, { ...read.marker!, rowsScanned: 5 })).written, true)
  assert.deepEqual([kv.marker()!.version, kv.marker()!.rowsScanned], [1, 5])
})
