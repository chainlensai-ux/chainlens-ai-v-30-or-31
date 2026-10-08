// Robinhood verified-swap candidate manifest: a previously proven swap is re-injected into the bounded receipt sample
// (<= 8 of the 20 slots) and re-verified from its current receipt + exact proof by the unchanged verifier. The manifest
// is a candidate hint only — never acceptance — and is written additively (field-level) so concurrent scans can't drop
// entries. Plus the candidate-selection audit that tells "missing from current activity" from "present but dropped".
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem'
import {
  computeRobinhoodPnlV1, selectRobinhoodPnlV1Candidates, selectRobinhoodPnlV1CandidatesWithManifest, __resetRobinhoodPnlV1CachesForTest,
  RH_NATIVE, RH_V4_POSITION_MANAGER, V4_SWAP_TOPIC0, ERC20_TRANSFER_TOPIC0, ROBINHOOD_PNL_V1_LIMITS,
  type RhRpc, type RhEthUsdPoint, type RobinhoodPnlV1Deps, type RobinhoodPnlV1Candidate,
} from '../lib/server/robinhoodPnlV1.ts'
import {
  readRobinhoodVerifiedSwapManifest, recordRobinhoodVerifiedSwaps, robinhoodVerifiedSwapManifestKey, __setRobinhoodVerifiedSwapManifestKvForTest,
  type RobinhoodVerifiedSwapManifestEntry,
} from '../lib/server/robinhoodVerifiedSwapManifest.ts'
import type { RhNativeTransfer } from '../lib/server/robinhoodMixedRouteForensics.ts'

const TS = 1790155166
delete process.env.KV_REST_API_URL
delete process.env.KV_REST_API_TOKEN

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
const H = (name: string) => keccak256(toHex(`manifest-test:${name}`)).toLowerCase()

const POOLS = new Map<string, string>()
function poolId(x: string, y: string) {
  const [c0, c1] = [x, y].sort((p, q) => (BigInt(p) < BigInt(q) ? -1 : 1))
  const types = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] as const
  const args = [c0 as Hex, c1 as Hex, 3000, 60, RH_NATIVE as Hex] as const
  const id = keccak256(encodeAbiParameters(types, args)).toLowerCase()
  POOLS.set(id, encodeAbiParameters(types, args))
  return { id, c0, c1 }
}

class Tx {
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string; blockTimestamp: string }> = []
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
// Wallet-sent native → V4 → token buy (tx.value proves the native input).
function directBuy(token: string, eth: bigint, amount: bigint, ts: number) {
  const tx = new Tx(ts).v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount)
  tx.txValue = eth
  return tx
}
// Relayer-sent V4 buy where the exact trace shows the wallet alone paying the route input (the d861… shape).
function relayedBuy(token: string, eth: bigint, amount: bigint, ts: number) {
  const tx = new Tx(ts).v4(RH_NATIVE, token, eth, amount).xfer(token, PM, WALLET, amount)
  tx.sender = RELAYER
  tx.trace = [pay(WALLET, ROUTER, eth), pay(ROUTER, PM, eth)]
  return tx
}
// Irrelevant newer activity: an inbound token airdrop (no V4 swap) — the receipts that displaced the proven swaps.
const airdrop = (ts: number) => { const tx = new Tx(ts).xfer(B, SPAMMER, WALLET, n(1)); tx.sender = SPAMMER; tx.to = B; return tx }

// ── Fake KV: a Redis hash per key, field-level HSET (like Upstash), optional failures ──────────────────────────
class FakeKv {
  store = new Map<string, Map<string, unknown>>()
  failReads = false
  failWrites = false
  hsetCalls = 0
  async hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    if (this.failReads) throw new Error('kv down')
    const h = this.store.get(key)
    if (!h || h.size === 0) return null
    // Upstash auto-deserializes JSON strings; mimic it so the validator sees objects.
    return Object.fromEntries([...h].map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v])) as T
  }
  async hset(key: string, fields: Record<string, unknown>): Promise<number> {
    this.hsetCalls += 1
    await new Promise((r) => setTimeout(r, 1))
    if (this.failWrites) throw new Error('kv down')
    const h = this.store.get(key) ?? new Map<string, unknown>()
    let added = 0
    for (const [k, v] of Object.entries(fields)) { if (!h.has(k)) added += 1; h.set(k, v) }
    this.store.set(key, h)
    return added
  }
  fields(wallet = WALLET) { return [...(this.store.get(robinhoodVerifiedSwapManifestKey(wallet))?.keys() ?? [])].sort() }
}
let kv: FakeKv
const MANIFEST = { read: readRobinhoodVerifiedSwapManifest, record: recordRobinhoodVerifiedSwaps }

const ethAt = async (ts: number): Promise<RhEthUsdPoint | null> => ({ priceUsd: 2600, provider: 'x', endpoint: null, pointMs: Math.floor(ts / 86_400) * 86_400_000, gapMs: (ts % 86_400) * 1000, maxAllowedGapMs: 86_400_000 })

type Chain = Map<string, { name: string; tx: Tx; block: number }>
function chainOf(specs: Array<[string, Tx]>): Chain {
  return new Map(specs.map(([name, tx]) => [H(name), { name, tx, block: 1000 + (tx.ts - TS) }]))
}
type ScanOpts = { activity: string[]; stored?: Set<string>; receiptDown?: Set<string>; deps?: Partial<RobinhoodPnlV1Deps>; manifest?: boolean }
async function scan(chain: Chain, opts: ScanOpts) {
  __resetRobinhoodPnlV1CachesForTest()
  const byBlock = new Map([...chain.values()].map((v) => [v.block, v]))
  const receiptCalls: string[] = []
  const rpc: RhRpc = async (calls) => calls.map(({ method, params }) => {
    const p = params as any[]
    if (method === 'eth_getTransactionReceipt') {
      const e = chain.get(p[0])
      receiptCalls.push(e?.name ?? p[0])
      if (!e || opts.receiptDown?.has(e.name)) return null
      return { status: '0x1', from: e.tx.sender, to: e.tx.to, blockNumber: hex(e.block), gasUsed: '0x1', effectiveGasPrice: '0x1', logs: e.tx.logs }
    }
    if (method === 'eth_getTransactionByHash') { const e = chain.get(p[0]); return e ? { value: hex(e.tx.txValue) } : null }
    if (method === 'eth_getBalance') return hex(BigInt(10) * E18)
    if (method === 'eth_getTransactionCount') return byBlock.get(Number(p[1]))?.tx.sender === WALLET ? '0x2' : '0x1'
    if (method === 'eth_call' && p[0].to === RH_V4_POSITION_MANAGER) return [...POOLS.entries()].find(([id]) => id.slice(2, 52) === String(p[0].data).slice(10, 60))?.[1] ?? null
    if (method === 'eth_call' && p[0].data === '0x313ce567') return hex(18)
    return null
  })
  const liveTraces: string[] = []
  const candidates: RobinhoodPnlV1Candidate[] = opts.activity.map((name) => {
    const e = chain.get(H(name))!
    return { txHash: H(name), timestampMs: e.tx.ts * 1000, hasSwapLog: e.tx.logs.some((l) => l.topics[0] === V4_SWAP_TOPIC0) }
  })
  const lines: Array<[string, any]> = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { lines.push([String(tag), body]) }
  try {
    const r = await computeRobinhoodPnlV1({
      wallet: WALLET, candidates, transactionCount: candidates.length, transferCount: candidates.length, activityUnavailableReason: null,
      deps: {
        rpc, now: () => 1_800_000_000_000, tokenHistoricalUsd: async () => null, ethUsdAt: ethAt, ethUsdRange: async () => null,
        nativeTransfersForTx: async (h) => { const e = chain.get(h)!; liveTraces.push(e.name); return e.tx.trace },
        nativeTraceCached: async (h) => { const e = chain.get(h); return e && opts.stored?.has(e.name) && e.tx.trace ? { transfers: e.tx.trace, audit: null } : null },
        ...(opts.manifest === false ? {} : { verifiedSwapManifest: MANIFEST }),
        ...opts.deps,
      },
    })
    const names = (hs: readonly string[]) => hs.map((h) => chain.get(h)?.name ?? h)
    const sel = lines.filter(([tag]) => tag === '[robinhood-candidate-selection-audit]').map(([, b]) => b)[0]
    return { r, a: r.ingestionAudit, receiptCalls, liveTraces, names, sel }
  } finally { console.warn = w }
}

beforeEach(() => {
  __resetRobinhoodPnlV1CachesForTest()
  kv = new FakeKv()
  __setRobinhoodVerifiedSwapManifestKvForTest(kv)
})

// The production shape: 3 proven swaps (2 relayed, 1 direct), then a later scan whose 75-row window no longer has them.
const proven: Array<[string, Tx]> = [
  ['relayedD861', relayedBuy(A, n(0.01), n(1000), TS + 100)],
  ['relayed8364', relayedBuy(A, n(0.02), n(1500), TS + 200)],
  ['direct', directBuy(A, n(0.03), n(2000), TS + 300)],
]
const noise = (count: number, from = TS + 10_000): Array<[string, Tx]> => Array.from({ length: count }, (_, i) => [`noise${i}`, airdrop(from + i)])

test('repeated scans: Scan A proves 3 and records them; Scan B (75 newer rows, the 3 absent) re-injects and re-verifies all 3', async () => {
  const chain = chainOf([...proven, ...noise(75)])
  // Scan A: the 3 swaps are in current activity and all verify.
  const scanA = await scan(chain, { activity: proven.map(([name]) => name) })
  assert.equal(scanA.a.verifiedSwapTxCount, 3)
  assert.equal(scanA.a.relayedWalletVerifiedSwapCount, 2)
  assert.deepEqual(kv.fields(), proven.map(([name]) => H(name)).sort())
  assert.equal(scanA.a.verifiedSwapManifest?.written, 3)
  const stored = (await readRobinhoodVerifiedSwapManifest(WALLET)).entries
  assert.deepEqual(stored.map((e) => [e.blockNumber, e.proofVersion]), [[1300, 1], [1200, 1], [1100, 1]])
  assert.ok(stored.every((e) => !('swap' in e) && !('verified' in e) && !('realizedPnlUsd' in e) && !('inputRaw' in e)), 'identity metadata only')

  // Scan B: 75 newer irrelevant rows (all claiming a swap log would be worse; these are plain airdrops), the 3 absent.
  // Their exact traces are persisted from Scan A (zero live budget).
  const scanB = await scan(chain, { activity: noise(75).map(([name]) => name), stored: new Set(['relayedD861', 'relayed8364', 'direct']) })
  assert.equal(scanB.a.candidateSelection!.candidatePoolCount, 78)
  assert.equal(scanB.a.candidateSwapTxCount, 20)
  assert.ok(scanB.receiptCalls.length <= ROBINHOOD_PNL_V1_LIMITS.maxCandidateReceipts + ROBINHOOD_PNL_V1_LIMITS.maxStagedReceipts)
  const injected = scanB.a.candidateSelection!.selectedCandidates.filter((c) => c.source === 'verified_manifest')
  assert.deepEqual(scanB.names(injected.map((c) => c.txHash)), ['direct', 'relayed8364', 'relayedD861'])
  assert.ok(injected.every((c) => c.manifestHit && !c.inCurrentActivity && c.selectionReason === 'manifest_reserved_slot'))
  assert.deepEqual(injected.map((c) => c.selectionRank), [1, 2, 3])
  // each was fetched again from its current receipt
  for (const name of ['direct', 'relayed8364', 'relayedD861']) assert.ok(scanB.receiptCalls.includes(name), name)
  assert.equal(scanB.a.verifiedSwapTxCount, 3)
  assert.equal(scanB.r.swapsVerified, 3)
  assert.equal(scanB.a.relayedWalletVerifiedSwapCount, 2)
  assert.deepEqual(scanB.liveTraces, [], 'persisted exact traces replayed, no live budget')
  assert.deepEqual(scanB.a.verifiedSwapManifest?.replayResults, { manifest_reverified: 3, manifest_rejected: 0, manifest_receipt_unavailable: 0, manifest_trace_unavailable: 0 })
  assert.equal(scanB.a.verifiedSwapManifest?.injectedMissingFromCurrentActivity, 3)
  // remaining 17 slots = newest current activity; the other 58 are dropped (bounded list in the ingestion audit)
  assert.equal(scanB.a.candidateSelection!.droppedCandidateCount, 58)
  assert.equal(scanB.a.candidateSelection!.droppedCandidateHashes.length, 25)
  assert.equal(scanB.a.candidateSelection!.droppedCandidateHashesTruncated, true)
  assert.equal(scanB.sel.droppedCandidateHashes.length, 58, 'debug line carries the full bounded dropped list')
  // re-verification refreshes lastVerifiedAt but never firstVerifiedAt or the entry count
  assert.equal(kv.fields().length, 3)
})

test('without the manifest, the same Scan B loses all 3 (the production regression)', async () => {
  const chain = chainOf([...proven, ...noise(75)])
  const b = await scan(chain, { activity: noise(75).map(([name]) => name), manifest: false })
  assert.equal(b.a.verifiedSwapTxCount, 0)
  assert.equal(b.a.verifiedSwapManifest, undefined)
  // the audit shows they were not dropped — they were never in the candidate pool
  assert.equal(b.a.candidateSelection!.candidatePoolCount, 75)
  assert.ok(!b.sel.droppedCandidateHashes.includes(H('direct')))
})

test('audit: present-but-dropped vs missing-from-current-activity are distinguishable', async () => {
  const chain = chainOf([...proven, ['oldDrop', airdrop(TS + 1)], ...noise(30)])
  // `oldDrop` is in current activity but older than 30 newer rows → dropped by cap; the relayed swaps are absent.
  const r = await scan(chain, { activity: ['oldDrop', ...noise(30).map(([name]) => name)], manifest: false })
  const sel = r.a.candidateSelection!
  assert.equal(sel.candidatePoolCount, 31)
  assert.equal(sel.selectedCandidates.length + sel.droppedCandidateCount, sel.candidatePoolCount)
  assert.ok(!sel.selectedCandidates.some((c) => c.txHash === H('oldDrop')))
  assert.ok(r.sel.droppedCandidateHashes.includes(H('oldDrop')), 'present but dropped by cap')
  assert.ok(!r.sel.droppedCandidateHashes.includes(H('relayedD861')) && !sel.selectedCandidates.some((c) => c.txHash === H('relayedD861')), 'missing: in neither list')
  assert.equal(r.sel.droppedCandidateHashesTruncated, false)
})

test('manifest/current duplicate occupies one slot (manifest lane, marked inCurrentActivity)', () => {
  const entry = (name: string, block: number): RobinhoodVerifiedSwapManifestEntry => ({ txHash: H(name), blockNumber: block, timestampMs: null, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 1 })
  const current = Array.from({ length: 30 }, (_, i): RobinhoodPnlV1Candidate => ({ txHash: H(`c${i}`), timestampMs: (TS + i) * 1000, hasSwapLog: false }))
  const { selected, audit } = selectRobinhoodPnlV1CandidatesWithManifest(current, [entry('c0', 5)])
  assert.equal(selected.length, 20)
  assert.equal(selected.filter((c) => c.txHash === H('c0')).length, 1)
  assert.deepEqual([selected[0].txHash, selected[0].source, selected[0].inCurrentActivity, selected[0].manifestHit], [H('c0'), 'verified_manifest', true, true])
  assert.equal(audit.candidatePoolCount, 30)
  assert.equal(audit.droppedCandidateCount, 10)
  assert.equal(new Set(selected.map((c) => c.txHash)).size, 20)
})

test('more than 8 manifest entries: newest 8 by blockNumber DESC, timestampMs DESC, txHash ASC; the rest wait', () => {
  const entries: RobinhoodVerifiedSwapManifestEntry[] = Array.from({ length: 10 }, (_, i) => ({ txHash: H(`m${i}`), blockNumber: 100 + i, timestampMs: null, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 1 }))
  entries.push({ txHash: H('noBlockNewer'), blockNumber: null, timestampMs: 9e12, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 1 })
  const current = Array.from({ length: 40 }, (_, i): RobinhoodPnlV1Candidate => ({ txHash: H(`c${i}`), timestampMs: (TS + i) * 1000, hasSwapLog: i % 2 === 0 }))
  const one = selectRobinhoodPnlV1CandidatesWithManifest(current, entries)
  const two = selectRobinhoodPnlV1CandidatesWithManifest([...current].reverse(), [...entries].reverse())
  const manifestPicked = one.selected.filter((c) => c.source === 'verified_manifest').map((c) => c.txHash)
  assert.deepEqual(manifestPicked, [109, 108, 107, 106, 105, 104, 103, 102].map((b) => H(`m${b - 100}`)))
  assert.equal(one.selected.length, 20)
  assert.deepEqual(one.selected.map((c) => c.txHash), two.selected.map((c) => c.txHash), 'input order never changes the selection')
  assert.ok(one.dropped.includes(H('m0')) && one.dropped.includes(H('m1')) && one.dropped.includes(H('noBlockNewer')))
})

test('fewer than 8 manifest entries return the spare slots to current activity (unchanged order)', () => {
  const entries: RobinhoodVerifiedSwapManifestEntry[] = [0, 1].map((i) => ({ txHash: H(`m${i}`), blockNumber: 50 + i, timestampMs: null, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 1 }))
  const current = Array.from({ length: 30 }, (_, i): RobinhoodPnlV1Candidate => ({ txHash: H(`c${i}`), timestampMs: (TS + i) * 1000, hasSwapLog: i < 3 }))
  const { selected } = selectRobinhoodPnlV1CandidatesWithManifest(current, entries)
  assert.equal(selected.length, 20)
  assert.equal(selected.filter((c) => c.source === 'verified_manifest').length, 2)
  const legacy = selectRobinhoodPnlV1Candidates(current).selected.slice(0, 18).map((c) => c.txHash)
  assert.deepEqual(selected.filter((c) => c.source === 'current_activity').map((c) => c.txHash), legacy)
  assert.deepEqual(selected.slice(2, 5).map((c) => c.selectionReason), ['current_activity_swap_log', 'current_activity_swap_log', 'current_activity_swap_log'])
  assert.equal(selected[5].selectionReason, 'current_activity_recent')
})

test('a stale / bad manifest entry fails closed: rejected, never in FIFO, and not deleted', async () => {
  const chain = chainOf([['fake', airdrop(TS + 50)], ...proven])
  await recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('fake'), blockNumber: 1050, timestampMs: null }], [], 1)
  const r = await scan(chain, { activity: ['direct'] })
  assert.equal(r.a.verifiedSwapTxCount, 1)
  assert.equal(r.r.swapsVerified, 1)
  const fake = r.a.verifiedSwapManifest?.replays.find((x) => x.txHash === H('fake'))
  assert.equal(fake?.result, 'manifest_rejected')
  assert.ok(fake?.rejection, 'rejected by the unchanged verifier')
  assert.equal(r.a.normalizedBuyCount, 1, 'only the real swap reaches FIFO')
  assert.ok(kv.fields().includes(H('fake')), 'never pruned on a failed replay')
})

test('a relayed manifest entry without a persisted trace and no live budget is not accepted (manifest_trace_unavailable)', async () => {
  const chain = chainOf([...proven])
  await recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('relayedD861'), blockNumber: 1100, timestampMs: null }], [], 1)
  const r = await scan(chain, { activity: [], deps: { nativeTraceLiveCap: 0 } })
  assert.equal(r.a.verifiedSwapTxCount, 0)
  assert.equal(r.r.swapsVerified, 0)
  assert.deepEqual(r.a.verifiedSwapManifest?.replayResults, { manifest_reverified: 0, manifest_rejected: 0, manifest_receipt_unavailable: 0, manifest_trace_unavailable: 1 })
  assert.ok(kv.fields().includes(H('relayedD861')))
  // with the same live allocator capacity as any candidate, the exact trace proves it again
  const live = await scan(chain, { activity: [] })
  assert.equal(live.a.relayedWalletVerifiedSwapCount, 1)
  assert.deepEqual(live.liveTraces, ['relayedD861'])
})

test('a transient receipt failure does not verify the entry and does not erase it', async () => {
  const chain = chainOf([...proven])
  await scan(chain, { activity: ['direct'] })
  assert.deepEqual(kv.fields(), [H('direct')])
  const down = await scan(chain, { activity: [], receiptDown: new Set(['direct']) })
  assert.equal(down.a.verifiedSwapTxCount, 0)
  assert.deepEqual(down.a.verifiedSwapManifest?.replayResults.manifest_receipt_unavailable, 1)
  assert.deepEqual(kv.fields(), [H('direct')])
  const back = await scan(chain, { activity: [] })
  assert.equal(back.a.verifiedSwapTxCount, 1)
})

test('no manifest dependency / KV not configured / KV failing: selection identical to the current-activity selector', async () => {
  const chain = chainOf([...proven, ...noise(25)])
  const activity = ['direct', ...noise(25).map(([name]) => name)]
  const legacy = selectRobinhoodPnlV1Candidates(activity.map((name) => ({ txHash: H(name), timestampMs: chain.get(H(name))!.tx.ts * 1000, hasSwapLog: name === 'direct' }))).selected.map((c) => c.txHash)
  const none = await scan(chain, { activity, manifest: false })
  assert.deepEqual(none.a.candidateSelection!.selectedCandidates.map((c) => c.txHash), legacy)
  assert.equal(none.a.verifiedSwapManifest, undefined)
  __setRobinhoodVerifiedSwapManifestKvForTest(null)
  const unconfigured = await scan(chain, { activity })
  assert.deepEqual(unconfigured.a.candidateSelection!.selectedCandidates.map((c) => c.txHash), legacy)
  assert.equal(unconfigured.a.verifiedSwapManifest?.readReason, 'kv_not_configured')
  assert.equal(unconfigured.a.verifiedSwapManifest?.writeReason, 'kv_not_configured')
  __setRobinhoodVerifiedSwapManifestKvForTest(kv)
  kv.failReads = true
  kv.failWrites = true
  const failing = await scan(chain, { activity })
  assert.deepEqual(failing.a.candidateSelection!.selectedCandidates.map((c) => c.txHash), legacy)
  assert.equal(failing.a.verifiedSwapManifest?.readReason, 'manifest_lookup_failed')
  assert.equal(failing.a.verifiedSwapManifest?.writeFailed, true)
  assert.equal(failing.a.verifiedSwapTxCount, 1)
})

test('concurrent additive writes never drop entries; a stale scan cannot erase newer ones; firstVerifiedAt is kept', async () => {
  await recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('old'), blockNumber: 10, timestampMs: null }], [], 100)
  const known = (await readRobinhoodVerifiedSwapManifest(WALLET)).entries
  // two scans that both read the same (stale) manifest write different new hashes at the same time
  await Promise.all([
    recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('x'), blockNumber: 20, timestampMs: null }], known, 200),
    recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('y'), blockNumber: 30, timestampMs: null }, { txHash: H('old'), blockNumber: 10, timestampMs: null }], known, 300),
  ])
  assert.deepEqual(kv.fields(), [H('old'), H('x'), H('y')].sort())
  // a much older scan that only knew [] re-records `x`: still additive, nothing else disappears
  await recordRobinhoodVerifiedSwaps(WALLET, [{ txHash: H('x'), blockNumber: 20, timestampMs: null }], [], 50)
  assert.deepEqual(kv.fields(), [H('old'), H('x'), H('y')].sort())
  const read = await readRobinhoodVerifiedSwapManifest(WALLET)
  const old = read.entries.find((e) => e.txHash === H('old'))!
  assert.deepEqual([old.firstVerifiedAt, old.lastVerifiedAt], [100, 300])
  assert.deepEqual(read.entries.map((e) => e.blockNumber), [30, 20, 10])
})

test('reader ignores malformed / mismatched fields; writer is bounded by the entry cap', async () => {
  kv.store.set(robinhoodVerifiedSwapManifestKey(WALLET), new Map<string, unknown>([
    [H('good'), JSON.stringify({ txHash: H('good'), blockNumber: 5, timestampMs: null, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 1 })],
    [H('mismatch'), JSON.stringify({ txHash: H('other'), blockNumber: 5, timestampMs: null, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 1 })],
    [H('verifiedFlag'), JSON.stringify({ txHash: H('verifiedFlag'), blockNumber: 5, timestampMs: null, firstVerifiedAt: 1, lastVerifiedAt: 1, proofVersion: 2 })],
    ['not-a-hash', JSON.stringify({})],
  ]))
  const read = await readRobinhoodVerifiedSwapManifest(WALLET)
  assert.deepEqual(read.entries.map((e) => e.txHash), [H('good')])
  assert.equal(read.invalidEntries, 3)
  const many = Array.from({ length: 70 }, (_, i) => ({ txHash: H(`many${i}`), blockNumber: i, timestampMs: null }))
  const w = await recordRobinhoodVerifiedSwaps(WALLET, many, read.entries, 1)
  assert.equal(w.written, 63)
  assert.equal(w.skippedOverCap, 7)
})
