import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySegment, chunkKeyFor, compareWithScan, completeRange, dirtyChunks, emptyHistory, mergeTransfers, segmentCoverage,
  type FetchedSegment, type StoredHistory, type StoredTransfer, type StreamKey,
} from '../src/modules/storedHistory/core'
import { fetchStreamSegment, type FetchLike } from '../src/modules/storedHistory/fetch'
import { createMemoryHistoryStore } from '../src/modules/storedHistory/store'
import { runStoredHistoryShadowChain, storedHistoryMode } from '../src/modules/storedHistory'

const W = '0x00000000000000000000000000000000000000aa'
const X = '0x00000000000000000000000000000000000000bb'
const TOKEN = '0x00000000000000000000000000000000000000cc'
const tsOf = (block: number) => new Date(Date.UTC(2025, 0, 1) + block * 60_000).toISOString()

function tr(uid: string, block: number, stream: StreamKey, over: Partial<StoredTransfer> = {}): StoredTransfer {
  const fromW = stream === 'from'
  return { uid, block, ts: tsOf(block), hash: `0x${uid}`, from: fromW ? W : X, to: fromW ? X : W, contract: TOKEN, asset: 'TKN', category: stream === 'toInternal' ? 'internal' : 'erc20', amountRaw: '100', decimals: 18, stream, ...over }
}
const seg = (s: Partial<FetchedSegment> & Pick<FetchedSegment, 'mode' | 'fromBlock' | 'toBlock'>): FetchedSegment => ({ stream: 'from', transfers: [], exhausted: false, ...s })

// ── Coverage rules ─────────────────────────────────────────────────────────────────────────────────
test('segment coverage: a stopped read never claims its partial far-end block', () => {
  assert.deepEqual(segmentCoverage(seg({ mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true })), { from: 0, to: 100 })
  // desc stopped early: lowest block seen (40) may be partial -> claim from 41.
  assert.deepEqual(segmentCoverage(seg({ mode: 'initial', fromBlock: 0, toBlock: 100, transfers: [tr('a', 90, 'from'), tr('b', 40, 'from')] })), { from: 41, to: 100 })
  // asc stopped early: highest block seen (70) may be partial -> claim up to 69.
  assert.deepEqual(segmentCoverage(seg({ mode: 'incremental', fromBlock: 50, toBlock: 100, transfers: [tr('a', 55, 'from'), tr('b', 70, 'from')] })), { from: 50, to: 69 })
  assert.equal(segmentCoverage(seg({ mode: 'initial', fromBlock: 0, toBlock: 100 })), null, 'nothing read, nothing claimed')
  assert.equal(segmentCoverage(seg({ mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true, unsupported: true })), null)
})

test('initial read: genesis only when the read reached block 0 with no further page', () => {
  const h0 = emptyHistory('base', W)
  const full = applySegment(h0, seg({ mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true, transfers: [tr('a', 10, 'from')] }))
  assert.deepEqual(full.cursors.from, { oldest: 0, newest: 100, genesis: true })
  const part = applySegment(h0, seg({ mode: 'initial', fromBlock: 0, toBlock: 100, transfers: [tr('a', 90, 'from'), tr('b', 60, 'from')] }))
  assert.deepEqual(part.cursors.from, { oldest: 61, newest: 100, genesis: false })
  assert.equal(part.transfers.length, 2, 'rows of the partial block are kept (unclaimed) for the next read to complete')
})

test('incremental: contiguous read extends newest and REPLACES the re-read range (reorg)', () => {
  let h = applySegment(emptyHistory('base', W), seg({ mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true, transfers: [tr('a', 10, 'from'), tr('reorged', 95, 'from')] }))
  // Re-read from 80: block 95's transfer is gone (reorg), a new one at 120.
  h = applySegment(h, seg({ mode: 'incremental', fromBlock: 80, toBlock: 130, exhausted: true, transfers: [tr('new', 120, 'from')] }))
  assert.deepEqual(h.cursors.from, { oldest: 0, newest: 130, genesis: true })
  assert.deepEqual(h.transfers.map((t) => t.uid), ['a', 'new'], 'the reorged-out transfer is removed')
  // A 'to' row in the same range is NOT removed by a 'from' re-read.
  let g = applySegment(emptyHistory('base', W), seg({ stream: 'to', mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true, transfers: [tr('in', 95, 'to')] }))
  g = applySegment(g, seg({ stream: 'from', mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true }))
  g = applySegment(g, seg({ stream: 'from', mode: 'incremental', fromBlock: 80, toBlock: 130, exhausted: true }))
  assert.deepEqual(g.transfers.map((t) => t.uid), ['in'])
})

test('incremental: a read that does not touch the stored newest block never extends (no silent gap)', () => {
  const h = applySegment(emptyHistory('base', W), seg({ mode: 'initial', fromBlock: 0, toBlock: 100, exhausted: true }))
  const gap = applySegment(h, seg({ mode: 'incremental', fromBlock: 150, toBlock: 200, exhausted: true, transfers: [tr('late', 180, 'from')] }))
  assert.deepEqual(gap.cursors.from, { oldest: 0, newest: 100, genesis: true })
  assert.equal(gap.transfers.length, 1, 'rows kept, range not claimed')
  const touching = applySegment(h, seg({ mode: 'incremental', fromBlock: 101, toBlock: 200, exhausted: true }))
  assert.equal(touching.cursors.from.newest, 200)
})

test('backfill: extends oldest only when contiguous; genesis only at block 0', () => {
  const h = applySegment(emptyHistory('base', W), seg({ mode: 'initial', fromBlock: 0, toBlock: 100, transfers: [tr('a', 90, 'from'), tr('b', 60, 'from')] }))
  assert.equal(h.cursors.from.oldest, 61)
  const more = applySegment(h, seg({ mode: 'backfill', fromBlock: 0, toBlock: 61, transfers: [tr('b', 60, 'from'), tr('c', 30, 'from')] }))
  assert.deepEqual(more.cursors.from, { oldest: 31, newest: 100, genesis: false })
  assert.equal(more.transfers.length, 3, 'boundary block re-read is deduplicated by uid')
  const done = applySegment(more, seg({ mode: 'backfill', fromBlock: 0, toBlock: 31, exhausted: true, transfers: [tr('d', 5, 'from')] }))
  assert.deepEqual(done.cursors.from, { oldest: 0, newest: 100, genesis: true })
  const notContiguous = applySegment(h, seg({ mode: 'backfill', fromBlock: 0, toBlock: 40, exhausted: true }))
  assert.equal(notContiguous.cursors.from.oldest, 61)
  assert.equal(notContiguous.cursors.from.genesis, false)
})

test('a stream without a cursor can only be started by an initial (head-anchored) read', () => {
  const h = applySegment(emptyHistory('base', W), seg({ mode: 'backfill', fromBlock: 0, toBlock: 100, exhausted: true, transfers: [tr('a', 50, 'from')] }))
  assert.deepEqual(h.cursors.from, { oldest: null, newest: null, genesis: false })
})

test('complete range = intersection of the required streams; null until both exist', () => {
  let h = applySegment(emptyHistory('base', W), seg({ stream: 'from', mode: 'initial', fromBlock: 0, toBlock: 100, transfers: [tr('a', 40, 'from')] }))
  assert.equal(completeRange(h), null)
  h = applySegment(h, seg({ stream: 'to', mode: 'initial', fromBlock: 0, toBlock: 90, transfers: [tr('b', 20, 'to')] }))
  assert.deepEqual(completeRange(h), { oldest: 41, newest: 90, genesis: false })
  h = applySegment(h, seg({ stream: 'toInternal', mode: 'initial', fromBlock: 0, toBlock: 90, exhausted: true, unsupported: true }))
  assert.equal(h.cursors.toInternal.unsupported, true)
  assert.deepEqual(completeRange(h), { oldest: 41, newest: 90, genesis: false }, 'an unsupported optional stream never blocks')
})

test('merge dedupes by uid; dirty chunks are only the months that changed', () => {
  const a = [tr('a', 10, 'from'), tr('b', 50_000, 'from')]
  const m = mergeTransfers(a, [tr('a', 10, 'from', { amountRaw: '200' }), tr('c', 20, 'from')])
  assert.deepEqual(m.map((t) => [t.uid, t.amountRaw]), [['a', '200'], ['c', '100'], ['b', '100']])
  assert.equal(chunkKeyFor(tr('x', 0, 'from')), '2025-01')
  assert.deepEqual(dirtyChunks(a, m), ['2025-01'], 'February row unchanged')
})

test('shadow comparison: matches inside the common window, reports scan transfers missing from the store', () => {
  let h = applySegment(emptyHistory('base', W), seg({ mode: 'initial', fromBlock: 0, toBlock: 1000, exhausted: true, transfers: [tr('a', 200, 'from'), tr('b', 400, 'from')] }))
  h = applySegment(h, seg({ stream: 'to', mode: 'initial', fromBlock: 0, toBlock: 1000, exhausted: true }))
  const ev = (t: StoredTransfer) => ({ txHash: t.hash, contract: t.contract, fromAddress: t.from, toAddress: t.to, amountRaw: t.amountRaw, timestamp: t.ts })
  const missing = tr('m', 300, 'from')
  const r = compareWithScan({ history: h, scanEvents: [ev(h.transfers[0]), ev(h.transfers[1]), ev(missing)], scanCoveredFromMs: 0, storeCoveredFromMs: 0, storeCoveredToMs: Date.parse(tsOf(1000)), nowMs: Date.parse(tsOf(2000)), edgeMarginMs: 0 })
  assert.deepEqual([r.scanTransfers, r.matched, r.missingFromStore, r.extraInStore], [3, 2, 1, 0])
  assert.deepEqual(r.sampleMissing, ['0xm'])
})

// ── Fake Alchemy chain ─────────────────────────────────────────────────────────────────────────────
type ChainRow = { uid: string; block: number; from: string; to: string; category: 'erc20' | 'external' | 'internal'; value: string }
function fakeAlchemy(opts: { rows: ChainRow[]; head: number; pageSize?: number; internalUnsupported?: boolean; fail429After?: number }) {
  const state = { calls: 0, transfersCalls: 0 }
  const fetchImpl: FetchLike = async (_url, init) => {
    state.calls += 1
    const body = JSON.parse(init.body) as { method: string; params: Array<Record<string, unknown>> }
    if (body.method === 'eth_blockNumber') return { ok: true, status: 200, json: async () => ({ result: `0x${opts.head.toString(16)}` }) }
    state.transfersCalls += 1
    if (opts.fail429After != null && state.transfersCalls > opts.fail429After) return { ok: false, status: 429, json: async () => ({}) }
    const p = body.params[0]
    const cats = p.category as string[]
    if (cats.includes('internal') && opts.internalUnsupported) return { ok: true, status: 200, json: async () => ({ error: { code: -32602, message: 'internal category is not supported on this network' } }) }
    const from = Number.parseInt(p.fromBlock as string, 16)
    const to = Number.parseInt(p.toBlock as string, 16)
    const dir = p.fromAddress ? { key: 'from' as const, addr: p.fromAddress as string } : { key: 'to' as const, addr: p.toAddress as string }
    let list = opts.rows.filter((r) => r.block >= from && r.block <= Math.min(to, opts.head) && cats.includes(r.category) && r[dir.key] === dir.addr)
    list = list.sort((a, b) => a.block - b.block || (a.uid < b.uid ? -1 : 1))
    if (p.order === 'desc') list.reverse()
    const offset = p.pageKey ? Number(p.pageKey) : 0
    const size = opts.pageSize ?? 3
    const page = list.slice(offset, offset + size)
    const pageKey = offset + size < list.length ? String(offset + size) : undefined
    return {
      ok: true, status: 200,
      json: async () => ({ result: {
        transfers: page.map((r) => ({ uniqueId: r.uid, blockNum: `0x${r.block.toString(16)}`, hash: `0x${r.uid}`, from: r.from, to: r.to, category: r.category, asset: 'TKN', rawContract: { address: r.category === 'erc20' ? TOKEN : null, value: `0x${BigInt(r.value).toString(16)}`, decimal: '0x12' }, metadata: { blockTimestamp: tsOf(r.block) } })),
        ...(pageKey ? { pageKey } : {}),
      } }),
    }
  }
  return { fetchImpl, state }
}

function walletRows(n: number, maxBlock: number): ChainRow[] {
  const rows: ChainRow[] = []
  for (let i = 0; i < n; i++) {
    const block = Math.floor((i * maxBlock) / n) + (i % 3) // several rows share blocks
    const out = i % 2 === 0
    rows.push({ uid: `u${i}`, block, from: out ? W : X, to: out ? X : W, category: i % 5 === 0 ? 'external' : 'erc20', value: String(100 + i) })
    if (i % 7 === 0) rows.push({ uid: `int${i}`, block, from: TOKEN, to: W, category: 'internal', value: String(5 + i) })
  }
  rows.push({ uid: 'other', block: 50, from: X, to: TOKEN, category: 'erc20', value: '1' }) // not the wallet's
  return rows
}

test('end to end: repeated shadow runs converge to EXACTLY the wallet\'s full history, then follow new blocks and reorgs', async () => {
  const store = createMemoryHistoryStore()
  let rows = walletRows(60, 900)
  let head = 1000
  const run = async () => {
    const f = fakeAlchemy({ rows, head })
    const r = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: f.fetchImpl, pagesPerStream: 2, reorgBlocks: 30 })
    assert.equal(r.status, 'updated', r.status)
    return r
  }
  // Small pages (3 rows) and 2 pages per stream: history needs several scans to reach genesis.
  let runs = 0
  for (; runs < 20; runs++) {
    const r = await run()
    if (r.genesis) break
  }
  assert.ok(runs > 1 && runs < 20, `converged after ${runs + 1} runs`)
  const expected = (rs: ChainRow[]) => rs.filter((r) => r.from === W || r.to === W).map((r) => r.uid).sort()
  let h = store.dump('base', W)!
  assert.deepEqual(h.transfers.map((t) => t.uid).sort(), expected(rows), 'every wallet transfer exactly once, none of anyone else\'s')
  assert.deepEqual(completeRange(h), { oldest: 0, newest: 1000, genesis: true })

  // A transfer lands near the head and is stored...
  rows = rows.concat([{ uid: 'recent', block: 985, from: W, to: X, category: 'erc20', value: '9' }])
  await run()
  assert.ok(store.dump('base', W)!.transfers.some((t) => t.uid === 'recent'))
  // ...then a reorg (within the margin) drops it, while new activity arrives at the head.
  rows = rows.filter((r) => r.uid !== 'recent').concat([{ uid: 'fresh1', block: 1050, from: W, to: X, category: 'erc20', value: '7' }, { uid: 'fresh2', block: 1080, from: X, to: W, category: 'erc20', value: '8' }])
  head = 1100
  await run()
  h = store.dump('base', W)!
  assert.deepEqual(h.transfers.map((t) => t.uid).sort(), expected(rows), 'new transfers added, reorged transfer removed')
  assert.deepEqual(completeRange(h), { oldest: 0, newest: 1100, genesis: true })
})

test('rate limit mid-run: progress is kept, nothing unproven is claimed, the next run continues', async () => {
  const store = createMemoryHistoryStore()
  const rows = walletRows(40, 900)
  const limited = fakeAlchemy({ rows, head: 1000, fail429After: 3 })
  const r1 = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: limited.fetchImpl, pagesPerStream: 4 })
  assert.equal(r1.status, 'updated')
  const h1 = store.dump('base', W)!
  // Whatever is claimed must be truly complete.
  for (const k of ['from', 'to'] as const) {
    const c = h1.cursors[k]
    if (c.oldest == null) continue
    const truth = rows.filter((x) => (k === 'from' ? x.from === W : x.to === W) && x.category !== 'internal' && x.block >= c.oldest! && x.block <= c.newest!).map((x) => x.uid).sort()
    const stored = h1.transfers.filter((t) => t.stream === k && t.block >= c.oldest! && t.block <= c.newest!).map((t) => t.uid).sort()
    assert.deepEqual(stored, truth, `${k}: claimed range is complete`)
  }
  for (let i = 0; i < 20; i++) {
    const f = fakeAlchemy({ rows, head: 1000 })
    const r = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: f.fetchImpl, pagesPerStream: 4 })
    if (r.genesis) break
  }
  assert.deepEqual(store.dump('base', W)!.transfers.map((t) => t.uid).sort(), rows.filter((r) => r.from === W || r.to === W).map((r) => r.uid).sort())
})

test('internal category unsupported on a chain: marked once, never retried, never blocks', async () => {
  const store = createMemoryHistoryStore()
  const f = fakeAlchemy({ rows: walletRows(10, 100), head: 200, internalUnsupported: true, pageSize: 50 })
  const r = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: f.fetchImpl })
  assert.equal(r.streams.toInternal?.unsupported, true)
  assert.equal(r.genesis, true)
  const calls = f.state.transfersCalls
  const f2 = fakeAlchemy({ rows: walletRows(10, 100), head: 200, internalUnsupported: true, pageSize: 50 })
  await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: f2.fetchImpl })
  assert.equal(f2.state.transfersCalls, 2, `only from/to incremental reads, no internal retry (first run used ${calls})`)
})

test('lease: a second writer is locked out; a stale revision is a conflict', async () => {
  const store = createMemoryHistoryStore()
  const now = Date.now()
  const a = await store.acquire('base', W, now)
  assert.ok(a)
  assert.equal(await store.acquire('base', W, now + 1000), null)
  const h = await store.load(a!)
  assert.equal(await store.save(a!, { ...h, rev: h.rev + 5 }, h, now), 'conflict')
  assert.equal(await store.save(a!, h, { ...h, transfers: [tr('a', 1, 'from')] }, now), 'saved')
  await store.release(a!)
  const b = await store.acquire('base', W, now + 2000)
  assert.ok(b)
  const r = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: fakeAlchemy({ rows: [], head: 10 }).fetchImpl })
  assert.equal(r.status, 'locked', 'while b holds the lease, a shadow run does nothing')
})

test('fetcher: a malformed row discards its page and stops; claims only earlier pages', async () => {
  let call = 0
  const fetchImpl: FetchLike = async () => {
    call += 1
    const good = { uniqueId: `g${call}`, blockNum: `0x${(100 - call).toString(16)}`, hash: '0x1', from: W, to: X, category: 'erc20', rawContract: { address: TOKEN, value: '0x1', decimal: '0x12' }, metadata: { blockTimestamp: tsOf(1) } }
    const rows = call === 2 ? [good, { hash: '0xbad' }] : [good]
    return { ok: true, status: 200, json: async () => ({ result: { transfers: rows, pageKey: 'next' } }) }
  }
  const r = await fetchStreamSegment({ url: 'u', wallet: W, stream: 'from', mode: 'initial', fromBlock: 0, toBlock: 100, maxPages: 5, deadlineMs: Date.now() + 60_000, fetchImpl })
  assert.equal(r.stopReason, 'error')
  assert.equal(r.error, 'malformed_row')
  assert.deepEqual(r.transfers.map((t) => t.uid), ['g1'])
})

test('mode flag: off unless WALLET_STORED_HISTORY=shadow', () => {
  assert.equal(storedHistoryMode({}), 'off')
  assert.equal(storedHistoryMode({ WALLET_STORED_HISTORY: '1' }), 'off')
  assert.equal(storedHistoryMode({ WALLET_STORED_HISTORY: 'shadow' }), 'shadow')
  const h: StoredHistory = emptyHistory('base', W.toUpperCase())
  assert.equal(h.wallet, W)
})

test('shadow comparison end to end: a converged history matches the scan\'s own fetch (0 missing)', async () => {
  const store = createMemoryHistoryStore()
  const rows = walletRows(30, 900)
  for (let i = 0; i < 20; i++) {
    const r = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: null, url: 'https://alchemy.test', fetchImpl: fakeAlchemy({ rows, head: 1000 }).fetchImpl, reorgBlocks: 30 })
    if (r.genesis) break
  }
  // What the scanner's own Alchemy fetch would have returned for this wallet.
  const scanEvents = rows.filter((r) => r.from === W || r.to === W).map((r) => ({
    txHash: `0x${r.uid}`, contract: r.category === 'erc20' ? TOKEN : null, fromAddress: r.from, toAddress: r.to, amountRaw: r.value, timestamp: tsOf(r.block),
  }))
  const r = await runStoredHistoryShadowChain({ chain: 'base', wallet: W, store, deadlineMs: Date.now() + 60_000, scan: { events: scanEvents, coveredFromMs: 0 }, url: 'https://alchemy.test', fetchImpl: fakeAlchemy({ rows, head: 1000 }).fetchImpl, reorgBlocks: 30, now: () => Date.parse(tsOf(5000)) })
  assert.ok(r.comparison && r.comparison.scanTransfers > 10, JSON.stringify(r.comparison))
  assert.equal(r.comparison!.missingFromStore, 0)
  assert.equal(r.comparison!.matched, r.comparison!.scanTransfers)
})
