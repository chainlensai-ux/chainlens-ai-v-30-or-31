// In-flight reuse: a repeat scan of the same wallet/mode by the same user joins the live job instead
// of starting a second full worker run; other users, other modes and finished/stalled jobs never do.
// Every change to the in-flight slot is atomic (SET NX / compare-and-set), so racing requests can
// never both start a scan or both consume quota. Concurrency is driven by barriers, not sleeps.
//   npx tsx --test app/api/wallet-scan/walletScanInFlightReuse.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearWalletScanTestAuth, installWalletScanTestAuth, walletScanTestAuthHeaders } from './walletScanTestAuth'
import { kv } from '@/lib/server/kv'
import { snapshotDailyScan } from '@/lib/scanQuota'
import {
  WALLET_SCAN_JOINABLE_HEARTBEAT_MS, WALLET_SCAN_RESERVE_LEASE_MS, WALLET_SCAN_WATCHDOG_MS,
  confirmWalletScanInFlight, isReusableWalletScanJob, releaseWalletScanInFlight, reserveWalletScanInFlight,
  walletScanInFlightKey, walletScanJobKey,
  type WalletScanJobMetadata,
} from '@/src/modules/walletScanQueue'

const WALLET = '0xd40e93db1160cd9a6bef2f9fd8e81b9beddeb811'
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const original = { get: kv.get, set: kv.set, setIfAbsent: kv.setIfAbsent, compareAndSet: kv.compareAndSet }
type Stored = { value: unknown }
type Hooks = {
  beforeCompareAndSet?: (key: string, expected: string) => Promise<void> | void
  afterSetIfAbsent?: (key: string, won: boolean) => Promise<void> | void
}
let store: Map<string, Stored>
let hooks: Hooks
// Same semantics as lib/server/kv.ts against Redis: setIfAbsent is SET NX, compareAndSet swaps only
// while the key still holds exactly `expected` — both atomic (no await between check and write).
function memoryKv(): Map<string, Stored> {
  const m = new Map<string, Stored>()
  hooks = {}
  kv.get = async <T = unknown>(key: string | null) => ((key === null ? undefined : m.get(key)?.value) as T | undefined) ?? null
  kv.set = async (key: string, value: unknown) => { m.set(key, { value }); return 'OK' }
  kv.setIfAbsent = async (key: string, value: unknown) => {
    const won = !m.has(key)
    if (won) m.set(key, { value })
    await hooks.afterSetIfAbsent?.(key, won)
    return won
  }
  kv.compareAndSet = async (key: string, expected: string, next: string | null) => {
    await hooks.beforeCompareAndSet?.(key, expected)
    if (m.get(key)?.value !== expected) return false
    if (next === null) m.delete(key)
    else m.set(key, { value: next })
    return true
  }
  return m
}
function barrier(parties: number) {
  let arrived = 0
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { arrive: async () => { arrived += 1; if (arrived >= parties) open(); await opened } }
}
const lease = (jobId: string, leaseUntil: number) => JSON.stringify({ jobId, leaseUntil })
const job = (over: Partial<WalletScanJobMetadata>): WalletScanJobMetadata => ({
  jobId: 'j1', userId: 'user-a', wallet: WALLET, status: 'running', createdAt: 1_000_000, updatedAt: 1_000_000, scanMode: 'deep', heartbeatAt: 1_000_000, ...over,
})
const jobRecordIds = () => [...store.keys()].filter((k) => k.startsWith('walletScanJob:')).map((k) => k.slice('walletScanJob:'.length))
const slotKey = () => walletScanInFlightKey('user-a', WALLET, 'deep')
// A fake clock whose sleep advances time instantly: deterministic waits.
function fakeClock(start = 5_000_000) {
  let t = start
  return { now: () => t, sleep: async (ms: number) => { t += ms }, advance: (ms: number) => { t += ms } }
}

// Each request gets its own IP unless one is given, so the per-IP rate limit never interferes.
let ipSeq = 0
async function postScan(scanMode: 'normal' | 'deep' = 'deep', wallet = WALLET, ip?: string) {
  const { POST } = await import('./route')
  const res = await POST(new Request('http://localhost/api/wallet-scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip ?? `10.0.0.${++ipSeq}`, ...walletScanTestAuthHeaders },
    body: JSON.stringify({ walletAddress: wallet, chains: ['base', 'eth'], scanMode }),
  }))
  return { status: res.status, body: await res.json() as { jobId?: string; status?: string; reused?: boolean; scanQuota?: { remaining: number | null; used?: number }; error?: { category?: string } } }
}
const quotaUsed = async (ip: string) => (await snapshotDailyScan('free', ip)).used

describe('isReusableWalletScanJob (pure)', () => {
  const now = 1_010_000
  it('joins only a live job of the same user, wallet and mode', () => {
    assert.equal(isReusableWalletScanJob(job({}), 'user-a', WALLET.toUpperCase().replace('0X', '0x'), 'deep', now), true)
    assert.equal(isReusableWalletScanJob(job({ status: 'queued', createdAt: now - 1_000 }), 'user-a', WALLET, 'deep', now), true)
    assert.equal(isReusableWalletScanJob(job({}), 'user-b', WALLET, 'deep', now), false, 'never another user’s job')
    assert.equal(isReusableWalletScanJob(job({}), 'user-a', WALLET, 'normal', now), false, 'never a different mode')
    assert.equal(isReusableWalletScanJob(job({}), 'user-a', '0x0000000000000000000000000000000000000001', 'deep', now), false)
    assert.equal(isReusableWalletScanJob(job({ heavyWalletFollowUp: true }), 'user-a', WALLET, 'deep', now), false)
  })
  it('never joins a finished, failed or stalled job', () => {
    assert.equal(isReusableWalletScanJob(job({ status: 'done' }), 'user-a', WALLET, 'deep', now), false)
    assert.equal(isReusableWalletScanJob(job({ status: 'failed' }), 'user-a', WALLET, 'deep', now), false)
    assert.equal(isReusableWalletScanJob(job({ heartbeatAt: 1_000_000 }), 'user-a', WALLET, 'deep', 1_000_000 + WALLET_SCAN_WATCHDOG_MS + 1), false)
    assert.equal(isReusableWalletScanJob(null, 'user-a', WALLET, 'deep', now), false)
  })
  it('a running job whose worker missed two heartbeats is not joined, even before the 90s watchdog fails it', () => {
    const t = 1_000_000 + WALLET_SCAN_JOINABLE_HEARTBEAT_MS
    assert.equal(isReusableWalletScanJob(job({}), 'user-a', WALLET, 'deep', t), true)
    assert.equal(isReusableWalletScanJob(job({}), 'user-a', WALLET, 'deep', t + 1), false)
  })
})

describe('reserveWalletScanInFlight — atomic lease transitions', () => {
  beforeEach(() => { process.env.KV_REST_API_URL = 'https://x.upstash.io'; process.env.KV_REST_API_TOKEN = 't'; store = memoryKv() })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original) })

  it('the key isolates user, normalized wallet and mode', () => {
    assert.equal(walletScanInFlightKey('user-a', WALLET.toUpperCase().replace('0X', '0x'), 'deep'), slotKey())
    assert.notEqual(walletScanInFlightKey('user-b', WALLET, 'deep'), slotKey())
    assert.notEqual(walletScanInFlightKey('user-a', WALLET, 'normal'), slotKey())
  })

  it('(1) two simultaneous rescans replacing the same stale job produce exactly one replacement', async () => {
    const clock = fakeClock()
    store.set(slotKey(), { value: lease('old', 0) })
    store.set(walletScanJobKey('old'), { value: job({ jobId: 'old', status: 'done' }) })
    // Both requests read and evaluate the stale holder before either attempts the swap.
    const bothRead = barrier(2)
    hooks.beforeCompareAndSet = async (_key, expected) => { if (expected === lease('old', 0)) await bothRead.arrive() }
    const [a, b] = await Promise.all([
      reserveWalletScanInFlight('user-a', WALLET, 'deep', 'new-a', clock),
      reserveWalletScanInFlight('user-a', WALLET, 'deep', 'new-b', clock),
    ])
    const owners = [a, b].filter((r) => r.kind === 'owner')
    assert.equal(owners.length, 1, 'exactly one request wins the replacement')
    const winner = owners[0] as Extract<typeof a, { kind: 'owner' }>
    const loser = a.kind === 'owner' ? b : a
    assert.equal(loser.kind, 'join')
    assert.equal((loser as { jobId: string }).jobId, winner.jobId, 'the loser joins the winner')
    assert.equal(JSON.parse(store.get(slotKey())!.value as string).jobId, winner.jobId)
  })

  it('(2) an owner that takes longer than 3s to write its job record is joined, never replaced', async () => {
    const clock = fakeClock()
    const owner = await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'slow-owner', clock)
    assert.equal(owner.kind, 'owner')
    clock.advance(10_000) // well past the 3s record wait, still inside the lease
    const second = await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'impatient', clock)
    assert.deepEqual(second, { kind: 'join', jobId: 'slow-owner', status: 'queued', pending: true })
    assert.equal(JSON.parse(store.get(slotKey())!.value as string).jobId, 'slow-owner', 'slot untouched')
    assert.deepEqual(jobRecordIds(), [], 'the waiting request created no job')
    // The slow owner can still confirm and continue.
    assert.ok(await confirmWalletScanInFlight(owner as Extract<typeof owner, { kind: 'owner' }>, clock.now()))
  })

  it('an owner whose lease expired without ever enqueueing is replaced', async () => {
    const clock = fakeClock()
    await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'ghost', clock)
    clock.advance(WALLET_SCAN_RESERVE_LEASE_MS + 1)
    const next = await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'next', clock)
    assert.equal(next.kind, 'owner')
    assert.equal(JSON.parse(store.get(slotKey())!.value as string).jobId, 'next')
  })

  it('(3) a superseded owner cannot confirm, and its release cannot free the new owner’s slot', async () => {
    const clock = fakeClock()
    const first = await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'first', clock)
    assert.equal(first.kind, 'owner')
    clock.advance(WALLET_SCAN_RESERVE_LEASE_MS + 1)
    const second = await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'second', clock)
    assert.equal(second.kind, 'owner')
    assert.equal(await confirmWalletScanInFlight(first as Extract<typeof first, { kind: 'owner' }>, clock.now()), null, 'superseded: must not enqueue')
    await releaseWalletScanInFlight(first)
    assert.equal(JSON.parse(store.get(slotKey())!.value as string).jobId, 'second')
  })

  it('a live joinable job is joined; a finished one is replaced', async () => {
    const clock = fakeClock()
    store.set(slotKey(), { value: lease('live', 0) })
    store.set(walletScanJobKey('live'), { value: job({ jobId: 'live', heartbeatAt: clock.now() - 5_000 }) })
    assert.deepEqual(await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'x', clock), { kind: 'join', jobId: 'live', status: 'running', pending: false })
    store.set(walletScanJobKey('live'), { value: job({ jobId: 'live', status: 'done' }) })
    assert.equal((await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'y', clock)).kind, 'owner')
  })

  it('a heartbeat on the live key keeps a running job joinable', async () => {
    const clock = fakeClock()
    store.set(slotKey(), { value: lease('busy', 0) })
    store.set(walletScanJobKey('busy'), { value: job({ jobId: 'busy', heartbeatAt: clock.now() - 60_000 }) })
    store.set(`walletScanJobLive:busy`, { value: { heartbeatAt: clock.now() - 2_000 } })
    assert.equal((await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'z', clock)).kind, 'join')
  })

  it('release frees only this request’s own reservation', async () => {
    const mine = await reserveWalletScanInFlight('user-a', WALLET, 'deep', 'holder')
    await releaseWalletScanInFlight({ kind: 'owner', key: slotKey(), jobId: 'someone-else', raw: lease('someone-else', 1) })
    assert.ok(store.has(slotKey()))
    await releaseWalletScanInFlight(mine)
    assert.equal(store.has(slotKey()), false)
  })
})

describe('POST /api/wallet-scan — in-flight reuse', () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = 'https://x.upstash.io'
    process.env.KV_REST_API_TOKEN = 't'
    process.env.WALLET_SCAN_WORKER_SECRET = 'secret'
    process.env.WALLET_SCAN_WORKER_BASE_URL = 'https://worker.test'
    globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch
    store = memoryKv()
    installWalletScanTestAuth('user-a')
  })
  afterEach(() => { process.env = { ...originalEnv }; Object.assign(kv, original); globalThis.fetch = originalFetch; clearWalletScanTestAuth() })

  it('a second scan while the first is live returns the same job instead of starting another', async () => {
    const first = await postScan()
    assert.equal(first.status, 200)
    assert.ok(first.body.jobId)
    const second = await postScan()
    assert.equal(second.status, 200)
    assert.equal(second.body.jobId, first.body.jobId)
    assert.equal(second.body.reused, true)
    assert.equal(jobRecordIds().length, 1, 'exactly one job record, so exactly one worker run')
  })

  it('two simultaneous first scans of the same wallet create one job', async () => {
    const [a, b] = await Promise.all([postScan(), postScan()])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.body.jobId, b.body.jobId, 'the second request joins the first')
    assert.equal(jobRecordIds().length, 1)
  })

  it('(1)+(4) two simultaneous rescans replacing a finished job start one job and charge quota once', async () => {
    const ip = '10.8.0.1'
    store.set(slotKey(), { value: lease('old', 0) })
    store.set(walletScanJobKey('old'), { value: job({ jobId: 'old', status: 'done' }) })
    const bothRead = barrier(2)
    hooks.beforeCompareAndSet = async (_key, expected) => { if (expected === lease('old', 0)) await bothRead.arrive() }
    const before = await quotaUsed(ip)
    const [a, b] = await Promise.all([postScan('deep', WALLET, ip), postScan('deep', WALLET, ip)])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.body.jobId, b.body.jobId)
    assert.deepEqual(jobRecordIds().filter((id) => id !== 'old'), [a.body.jobId], 'exactly one replacement job')
    assert.equal(await quotaUsed(ip) - before, 1, 'deep-scan quota charged exactly once')
  })

  it('(3) a request superseded right after reserving never consumes quota or enqueues', async () => {
    const ip = '10.8.0.2'
    // The moment this request wins the NX, another request takes the slot over (as if its lease had
    // expired) and has already enqueued its job.
    hooks.afterSetIfAbsent = (key, won) => {
      if (!won || key !== slotKey()) return
      store.set(key, { value: lease('usurper', Date.now() + 60_000) })
      store.set(walletScanJobKey('usurper'), { value: job({ jobId: 'usurper', status: 'queued', createdAt: Date.now(), heartbeatAt: undefined }) })
      hooks.afterSetIfAbsent = undefined
    }
    const before = await quotaUsed(ip)
    const res = await postScan('deep', WALLET, ip)
    assert.equal(res.status, 200)
    assert.equal(res.body.jobId, 'usurper', 'joins the job that owns the slot')
    assert.equal(res.body.reused, true)
    assert.deepEqual(jobRecordIds(), ['usurper'], 'the superseded request enqueued nothing')
    assert.equal(await quotaUsed(ip), before, 'and consumed no quota')
  })

  it('joining a live scan does not consume another deep-scan quota unit', async () => {
    const ip = '10.9.0.1'
    await postScan('deep', WALLET, ip)
    const afterFirst = await quotaUsed(ip)
    const second = await postScan('deep', WALLET, ip)
    assert.equal(second.body.reused, true)
    assert.equal(await quotaUsed(ip), afterFirst)
  })

  it('a quota-refused scan frees its in-flight slot instead of leaving a job id that never runs', async () => {
    let refused: string | null = null
    for (let i = 1; i <= 50 && !refused; i++) {
      const w = `0x${i.toString(16).padStart(40, '0')}`
      const r = await postScan('deep', w, '10.9.0.2')
      if (r.status === 429) { assert.equal(r.body.error?.category, 'scan_limit'); refused = w }
    }
    assert.ok(refused, 'the free plan quota is eventually refused')
    assert.equal(store.has(walletScanInFlightKey('user-a', refused, 'deep')), false)
  })

  it('a different user never joins another user’s job', async () => {
    const first = await postScan()
    installWalletScanTestAuth('user-b')
    const other = await postScan()
    assert.notEqual(other.body.jobId, first.body.jobId)
    assert.notEqual(other.body.reused, true)
  })

  it('a different scan mode starts its own job', async () => {
    const deep = await postScan('deep')
    const normal = await postScan('normal')
    assert.notEqual(normal.body.jobId, deep.body.jobId)
  })

  it('once the job is done, a rescan starts a fresh job', async () => {
    const first = await postScan()
    const rec = store.get(walletScanJobKey(first.body.jobId!))!.value as WalletScanJobMetadata
    store.set(walletScanJobKey(first.body.jobId!), { value: { ...rec, status: 'done' } })
    const second = await postScan()
    assert.notEqual(second.body.jobId, first.body.jobId)
    assert.equal(JSON.parse(store.get(slotKey())!.value as string).jobId, second.body.jobId)
  })

  it('a stalled job is not joined', async () => {
    const first = await postScan()
    const rec = store.get(walletScanJobKey(first.body.jobId!))!.value as WalletScanJobMetadata
    store.set(walletScanJobKey(first.body.jobId!), { value: { ...rec, status: 'running', heartbeatAt: Date.now() - WALLET_SCAN_WATCHDOG_MS - 5_000 } })
    const second = await postScan()
    assert.notEqual(second.body.jobId, first.body.jobId)
  })
})
