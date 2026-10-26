// P0 cost safety: Helius credit accounting and the Solana deep-check budget.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  fetchHeliusCreatorTrace, fetchHeliusWalletFundingTrace, fetchHeliusCreatorRecentLaunches,
  HELIUS_CREATOR_TRACE_MAX_CREDITS, SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS, SOLANA_DEEP_CREATOR_CHECK_MAX_CREDITS,
} from '../lib/server/solanaProviders.ts'
import {
  HELIUS_CREDIT_BUDGET_EXHAUSTED, HELIUS_ENHANCED_MAX_CONCURRENT, HeliusCreditLedger, withHeliusEnhancedSlot,
  __heliusEnhancedInFlightForTest, type HeliusDeepCache,
} from '../lib/server/solana/heliusCredits.ts'
import {
  SOLANA_DEEP_DAILY_CREDITS, SOLANA_DEEP_LOCK_TTL_SECONDS, createMemoryDeepBudgetStore, reserveSolanaDeepCheck,
  snapshotSolanaDeepBudget, solanaDeepCheckKindFromBody, __setDeepBudgetStoreForTest, type DeepBudgetStore,
} from '../lib/server/solanaDeepCheckBudget.ts'
import { scanSolanaTokenBeta } from '../lib/server/solanaTokenScannerBeta.ts'

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const CREATOR = 'Creator1111111111111111111111111111111111'
const FUNDER = 'Funder11111111111111111111111111111111111'
const FUNDER2 = 'Funder22222222222222222222222222222222222'

function withHelius<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { e: process.env.ENABLE_HELIUS_SOLANA, k: process.env.HELIUS_API_KEY }
  process.env.ENABLE_HELIUS_SOLANA = 'true'
  process.env.HELIUS_API_KEY = 'test-key-never-logged'
  return fn().finally(() => {
    if (prev.e === undefined) delete process.env.ENABLE_HELIUS_SOLANA; else process.env.ENABLE_HELIUS_SOLANA = prev.e
    if (prev.k === undefined) delete process.env.HELIUS_API_KEY; else process.env.HELIUS_API_KEY = prev.k
  })
}

type Counts = { sigCalls: number; enhancedCalls: number; enhancedSignatures: number }

/** Helius stub: per-address signature pages and per-first-signature Enhanced parses; counts billed requests. */
function heliusStub(opts: {
  sigPages?: Record<string, Array<Array<{ signature: string; blockTime?: number }>>>
  enhanced?: Record<string, unknown[]>
  counts: Counts
}) {
  const pages = Object.fromEntries(Object.entries(opts.sigPages ?? {}).map(([k, v]) => [k, [...v]]))
  return async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('api.helius.xyz/v0/transactions')) {
      opts.counts.enhancedCalls += 1
      const sigs = JSON.parse(String(init?.body)).transactions as string[]
      opts.counts.enhancedSignatures += sigs.length
      return new Response(JSON.stringify(opts.enhanced?.[sigs[0]] ?? []), { status: 200 })
    }
    if (u.includes('helius-rpc.com')) {
      const body = JSON.parse(String(init?.body))
      if (body.method === 'getSignaturesForAddress') {
        opts.counts.sigCalls += 1
        const page = pages[body.params[0]]?.shift() ?? []
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: page }), { status: 200 })
      }
    }
    throw new Error(`unexpected fetch ${u}`)
  }
}
const newCounts = (): Counts => ({ sigCalls: 0, enhancedCalls: 0, enhancedSignatures: 0 })
const billed = (c: Counts) => c.sigCalls * 1 + c.enhancedCalls * 100

// ── Credit accounting ────────────────────────────────────────────────────────────────────────────
test('creator trace bills 1 credit per signature page + 100 per Enhanced call (was reported as pages + 1)', async () => {
  await withHelius(async () => {
    const counts = newCounts()
    const r = await fetchHeliusCreatorTrace(MINT, heliusStub({
      counts,
      sigPages: { [MINT]: [[{ signature: 'genesis', blockTime: 1_700_000_000 }]] },
      enhanced: { genesis: [{ feePayer: CREATOR, source: 'PUMP_FUN' }] },
    }) as typeof fetch)
    assert.equal(r.success, true)
    assert.equal(counts.enhancedCalls, 1)
    assert.equal(r.estimatedCredits, 101)
    assert.equal(r.estimatedCredits, billed(counts))
  })
})

test('creator trace worst case (5 full pages + Enhanced) is exactly the documented 105-credit cap', async () => {
  await withHelius(async () => {
    const counts = newCounts()
    const full = (p: number) => Array.from({ length: 1000 }, (_, i) => ({ signature: `s${p}_${i}`, blockTime: 1_700_000_000 - i }))
    const r = await fetchHeliusCreatorTrace(MINT, heliusStub({
      counts,
      sigPages: { [MINT]: [full(1), full(2), full(3), full(4), full(5)] },
      enhanced: { s5_999: [{ feePayer: CREATOR }] },
    }) as typeof fetch)
    assert.equal(counts.sigCalls, 5)
    assert.equal(r.reachedGenesis, false)
    assert.equal(r.estimatedCredits, HELIUS_CREATOR_TRACE_MAX_CREDITS)
    assert.equal(HELIUS_CREATOR_TRACE_MAX_CREDITS, 105)
  })
})

test('recent-launch sample parses 25 signatures in ONE Enhanced call and is billed as one call', async () => {
  await withHelius(async () => {
    const counts = newCounts()
    const sigs = Array.from({ length: 100 }, (_, i) => ({ signature: `c${i}` }))
    const r = await fetchHeliusCreatorRecentLaunches(CREATOR, MINT, heliusStub({ counts, sigPages: { [CREATOR]: [sigs] }, enhanced: { c0: [] } }) as typeof fetch)
    assert.equal(r.success, true)
    assert.equal(counts.enhancedCalls, 1)
    assert.equal(counts.enhancedSignatures, 25)
    assert.equal(r.estimatedCredits, 101)
  })
})

test('funding trace reports its billed credits (previously unreported)', async () => {
  await withHelius(async () => {
    const counts = newCounts()
    const r = await fetchHeliusWalletFundingTrace(CREATOR, heliusStub({
      counts,
      sigPages: { [CREATOR]: [[{ signature: 'w0' }]] },
      enhanced: { w0: [{ nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 10_000_000 }] }] },
    }) as typeof fetch)
    assert.equal(r.resolved.fundingWallet, FUNDER)
    assert.equal(r.estimatedCredits, 101)
  })
})

// ── Per-scan cap ─────────────────────────────────────────────────────────────────────────────────
test('a ledger that cannot afford the Enhanced call never sends it and reports budget exhausted', async () => {
  await withHelius(async () => {
    const counts = newCounts()
    const ledger = new HeliusCreditLedger(HELIUS_CREATOR_TRACE_MAX_CREDITS - 101) // 4 credits: pages only
    const r = await fetchHeliusCreatorTrace(MINT, heliusStub({
      counts, sigPages: { [MINT]: [[{ signature: 'genesis' }]] }, enhanced: { genesis: [{ feePayer: CREATOR }] },
    }) as typeof fetch, { ledger })
    assert.equal(counts.enhancedCalls, 0)
    assert.equal(r.success, false)
    assert.equal(r.enhancedTransactionsUsed, false)
    assert.equal(r.errorReason, HELIUS_CREDIT_BUDGET_EXHAUSTED)
    assert.equal(r.resolved.likelyCreatorWallet, null, 'no creator is fabricated when the parse was not paid for')
    assert.equal(ledger.usage().refused.enhanced_transactions, 1)
    assert.ok(ledger.spentCredits <= ledger.capCredits)
  })
})

test('an exhausted ledger sends nothing at all', async () => {
  await withHelius(async () => {
    const counts = newCounts()
    const r = await fetchHeliusCreatorTrace(MINT, heliusStub({ counts }) as typeof fetch, { ledger: new HeliusCreditLedger(0) })
    assert.equal(counts.sigCalls + counts.enhancedCalls, 0)
    assert.equal(r.errorReason, HELIUS_CREDIT_BUDGET_EXHAUSTED)
    assert.equal(r.estimatedCredits, 0)
  })
})

test('full Deep Cluster Check bills within the reserved 416 credits and reports exact usage', async () => {
  const prev = process.env.ENABLE_SOLANA_BETA
  process.env.ENABLE_SOLANA_BETA = 'true'
  try {
    await withHelius(async () => {
      const counts = newCounts()
      const helius = heliusStub({
        counts,
        sigPages: {
          [MINT]: [[{ signature: 'mint_genesis' }]],
          [CREATOR]: [[{ signature: 'creator_genesis' }], Array.from({ length: 30 }, (_, i) => ({ signature: `recent${i}` }))],
          [FUNDER]: [[{ signature: 'funder_genesis' }]],
        },
        enhanced: {
          mint_genesis: [{ feePayer: CREATOR, source: 'PUMP_FUN' }],
          creator_genesis: [{ nativeTransfers: [{ fromUserAccount: FUNDER, toUserAccount: CREATOR, amount: 5_000_000 }] }],
          funder_genesis: [{ nativeTransfers: [{ fromUserAccount: FUNDER2, toUserAccount: FUNDER, amount: 50_000_000_000 }] }],
          recent0: [],
        },
      })
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        if (u.includes('helius')) {
          const body = u.includes('helius-rpc.com') ? JSON.parse(String(init?.body)) : null
          // The normal scan's own lightweight activity call (limit 10) and DAS holder pages are not deep reads.
          if (body?.method === 'getSignaturesForAddress' && body.params[1]?.limit === 10) return new Response(JSON.stringify({ result: [] }))
          if (body?.method === 'getTokenAccounts') return new Response(JSON.stringify({ result: { token_accounts: [] } }))
          return helius(url, init)
        }
        if (u.includes('dexscreener')) return new Response(JSON.stringify({ pairs: [] }))
        const body = JSON.parse(String(init?.body ?? '{}'))
        const results: Record<string, unknown> = {
          getAccountInfo: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000', mintAuthority: null, freezeAuthority: null } } } } },
          getTokenSupply: { value: { amount: '1000000000', decimals: 6, uiAmountString: '1000' } },
          getTokenLargestAccounts: { value: [] },
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: results[body.method] ?? null }))
      }) as typeof fetch
      const ledger = new HeliusCreditLedger(SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS)
      const r = await scanSolanaTokenBeta(MINT, { rpcUrl: 'https://stub', fetchImpl, deep: true, deepCluster: true, heliusDeep: { ledger } })
      assert.ok(!('status' in r), 'scan succeeds')
      assert.equal(counts.enhancedCalls, 4, 'creator + funding hop 1 + recent launches + funding hop 2')
      assert.equal(ledger.spentCredits, billed(counts))
      assert.ok(ledger.spentCredits <= SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS)
      if (!('status' in r)) {
        assert.equal(r.heliusDeepCredits?.spentCredits, billed(counts))
        assert.equal(r.heliusDeepCredits?.calls.enhanced_transactions, 4)
      }
    })
  } finally {
    if (prev === undefined) delete process.env.ENABLE_SOLANA_BETA; else process.env.ENABLE_SOLANA_BETA = prev
  }
})

test('worst-case constants: Deep Creator 105, Deep Cluster 416', () => {
  assert.equal(SOLANA_DEEP_CREATOR_CHECK_MAX_CREDITS, 105)
  assert.equal(SOLANA_DEEP_CLUSTER_CHECK_MAX_CREDITS, 416)
})

// ── Cache ────────────────────────────────────────────────────────────────────────────────────────
function memoryCache(): HeliusDeepCache & { size(): number } {
  const m = new Map<string, unknown>()
  return {
    async get<T>(k: string) { return (m.get(k) as T) ?? null },
    async set<T>(k: string, v: T) { m.set(k, structuredClone(v)) },
    size: () => m.size,
  }
}

test('a creator trace that reached genesis is cached; the repeat costs 0 credits and 0 requests', async () => {
  await withHelius(async () => {
    const cache = memoryCache()
    const c1 = newCounts()
    const stub = { sigPages: { [MINT]: [[{ signature: 'genesis' }]] }, enhanced: { genesis: [{ feePayer: CREATOR }] } }
    const first = await fetchHeliusCreatorTrace(MINT, heliusStub({ ...stub, counts: c1 }) as typeof fetch, { ledger: new HeliusCreditLedger(500), cache })
    assert.equal(first.estimatedCredits, 101)
    const c2 = newCounts()
    const ledger = new HeliusCreditLedger(500)
    const second = await fetchHeliusCreatorTrace(MINT, heliusStub({ ...stub, counts: c2 }) as typeof fetch, { ledger, cache })
    assert.equal(c2.sigCalls + c2.enhancedCalls, 0)
    assert.equal(second.cached, true)
    assert.equal(second.estimatedCredits, 0)
    assert.equal(ledger.spentCredits, 0)
    assert.equal(second.resolved.likelyCreatorWallet, CREATOR)
  })
})

test('a capped (not-genesis) trace is never cached, so a later read can still find an earlier transaction', async () => {
  await withHelius(async () => {
    const cache = memoryCache()
    const full = (p: number) => Array.from({ length: 1000 }, (_, i) => ({ signature: `s${p}_${i}` }))
    await fetchHeliusCreatorTrace(MINT, heliusStub({
      counts: newCounts(), sigPages: { [MINT]: [full(1), full(2), full(3), full(4), full(5)] }, enhanced: { s5_999: [{ feePayer: CREATOR }] },
    }) as typeof fetch, { ledger: new HeliusCreditLedger(500), cache })
    assert.equal(cache.size(), 0)
  })
})

// ── Enhanced concurrency ─────────────────────────────────────────────────────────────────────────
test(`no more than ${HELIUS_ENHANCED_MAX_CONCURRENT} Enhanced requests run at once per instance`, async () => {
  let peak = 0
  let active = 0
  const job = () => withHeliusEnhancedSlot(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
  })
  await Promise.all(Array.from({ length: 8 }, job))
  assert.equal(peak, HELIUS_ENHANCED_MAX_CONCURRENT)
  assert.equal(__heliusEnhancedInFlightForTest(), 0)
})

// ── Per-user / global budget ─────────────────────────────────────────────────────────────────────
function freshStore(nowRef: { t: number }): DeepBudgetStore {
  const s = createMemoryDeepBudgetStore(() => nowRef.t)
  __setDeepBudgetStoreForTest(s)
  return s
}
const DAY0 = Date.UTC(2026, 9, 26, 12)

test('Free: 2 Deep Cluster Checks per day, the third is refused with an explicit reason', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  for (let i = 0; i < 2; i++) {
    const r = await reserveSolanaDeepCheck({ plan: 'free', userId: 'u1', kind: 'cluster', now: () => clock.t })
    assert.equal(r.ok, true)
    if (r.ok) {
      r.reservation.ledger.tryCharge('enhanced_transactions') // simulate real spend so nothing is refunded
      for (let k = 0; k < 4; k++) r.reservation.ledger.tryCharge('enhanced_transactions')
      for (let k = 0; k < 16; k++) r.reservation.ledger.tryCharge('standard_rpc')
      await r.reservation.settle()
    }
  }
  const third = await reserveSolanaDeepCheck({ plan: 'free', userId: 'u1', kind: 'cluster', now: () => clock.t })
  assert.equal(third.ok, false)
  if (!third.ok) {
    assert.equal(third.reason, 'user_daily_limit')
    assert.equal(third.snapshot?.clusterChecksRemaining, 0)
  }
})

test('unused credits are refunded: cached / cheap deep checks do not use up the daily budget', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  for (let i = 0; i < 10; i++) {
    const r = await reserveSolanaDeepCheck({ plan: 'free', userId: 'u2', kind: 'cluster', now: () => clock.t })
    assert.equal(r.ok, true, `check ${i + 1} allowed`)
    if (r.ok) assert.deepEqual(await r.reservation.settle(), { reservedCredits: 416, spentCredits: 0, refundedCredits: 416 })
  }
  const snap = await snapshotSolanaDeepBudget('free', 'u2', { now: () => clock.t })
  assert.equal(snap?.usedCredits, 0)
})

test('parallel deep checks from one user: exactly one runs, the rest get in_progress', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveSolanaDeepCheck({ plan: 'elite', userId: 'u3', kind: 'cluster', now: () => clock.t })))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(results.filter((r) => !r.ok && r.reason === 'in_progress').length, 4)
  const winner = results.find((r) => r.ok)
  if (winner?.ok) await winner.reservation.settle()
  const after = await reserveSolanaDeepCheck({ plan: 'elite', userId: 'u3', kind: 'cluster', now: () => clock.t })
  assert.equal(after.ok, true, 'lock released after settle')
  if (after.ok) await after.reservation.settle()
})

test('global daily cap holds under concurrent users', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  const env = { HELIUS_DEEP_DAILY_CREDIT_CAP: String(416 * 2) }
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => reserveSolanaDeepCheck({ plan: 'elite', userId: `g${i}`, kind: 'cluster', now: () => clock.t, env })))
  assert.equal(results.filter((r) => r.ok).length, 2)
  assert.equal(results.filter((r) => !r.ok && r.reason === 'global_daily_limit').length, 4)
  // Refused users' own counters were rolled back.
  for (const [i, r] of results.entries()) {
    if (!r.ok) assert.equal((await snapshotSolanaDeepBudget('elite', `g${i}`, { now: () => clock.t }))?.usedCredits, 0)
  }
})

test('settle is idempotent and never refunds twice', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  const r = await reserveSolanaDeepCheck({ plan: 'pro', userId: 'u4', kind: 'creator', now: () => clock.t })
  assert.ok(r.ok)
  if (!r.ok) return
  r.reservation.ledger.tryCharge('enhanced_transactions')
  const a = await r.reservation.settle()
  const b = await r.reservation.settle()
  assert.deepEqual(a, b)
  assert.equal((await snapshotSolanaDeepBudget('pro', 'u4', { now: () => clock.t }))?.usedCredits, 100)
})

test('recovery: an exhausted user can run deep checks again after 00:00 UTC', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  for (let i = 0; i < 2; i++) {
    const r = await reserveSolanaDeepCheck({ plan: 'free', userId: 'u5', kind: 'cluster', now: () => clock.t })
    if (r.ok) { while (r.reservation.ledger.tryCharge('enhanced_transactions')); await r.reservation.settle() }
  }
  assert.equal((await reserveSolanaDeepCheck({ plan: 'free', userId: 'u5', kind: 'cluster', now: () => clock.t })).ok, false)
  clock.t = Date.UTC(2026, 9, 27, 0, 0, 1)
  const next = await reserveSolanaDeepCheck({ plan: 'free', userId: 'u5', kind: 'cluster', now: () => clock.t })
  assert.equal(next.ok, true)
  if (next.ok) await next.reservation.settle()
})

test('recovery: a lock left by a crashed request expires after its TTL', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  freshStore(clock)
  const crashed = await reserveSolanaDeepCheck({ plan: 'pro', userId: 'u6', kind: 'creator', now: () => clock.t })
  assert.ok(crashed.ok) // never settled
  assert.equal((await reserveSolanaDeepCheck({ plan: 'pro', userId: 'u6', kind: 'creator', now: () => clock.t })).ok, false)
  clock.t += (SOLANA_DEEP_LOCK_TTL_SECONDS + 1) * 1000
  const later = await reserveSolanaDeepCheck({ plan: 'pro', userId: 'u6', kind: 'creator', now: () => clock.t })
  assert.equal(later.ok, true)
  if (later.ok) await later.reservation.settle()
})

test('fails closed: a budget-store error refuses the deep check and rolls back partial charges', async (t) => {
  t.after(() => __setDeepBudgetStoreForTest(null))
  const clock = { t: DAY0 }
  const inner = createMemoryDeepBudgetStore(() => clock.t)
  let incrCalls = 0
  __setDeepBudgetStoreForTest({
    ...inner,
    async incrBy(key, by, ttl) {
      incrCalls += 1
      if (incrCalls === 2) throw new Error('kv down') // user counter charged, global counter fails
      return inner.incrBy(key, by, ttl)
    },
  })
  const r = await reserveSolanaDeepCheck({ plan: 'pro', userId: 'u7', kind: 'cluster', now: () => clock.t })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, 'budget_unavailable')
  assert.equal((await snapshotSolanaDeepBudget('pro', 'u7', { now: () => clock.t, store: inner }))?.usedCredits, 0)
  assert.equal(await inner.setNx('solana-deep:lock:u7', 'x', 10), true, 'lock was released')
})

test('fails closed on a Vercel deployment without shared KV (no per-instance bypass)', async () => {
  const prev = { v: process.env.VERCEL_ENV, u: process.env.KV_REST_API_URL, k: process.env.KV_REST_API_TOKEN }
  process.env.VERCEL_ENV = 'production'
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  try {
    const r = await reserveSolanaDeepCheck({ plan: 'elite', userId: 'u8', kind: 'creator' })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'budget_unavailable')
  } finally {
    if (prev.v === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prev.v
    if (prev.u !== undefined) process.env.KV_REST_API_URL = prev.u
    if (prev.k !== undefined) process.env.KV_REST_API_TOKEN = prev.k
  }
})

test('every plan has a finite daily deep budget (no unlimited expensive deep scans)', () => {
  for (const plan of ['free', 'pro', 'elite'] as const) {
    assert.ok(Number.isFinite(SOLANA_DEEP_DAILY_CREDITS[plan]) && SOLANA_DEEP_DAILY_CREDITS[plan] > 0)
  }
  assert.ok(SOLANA_DEEP_DAILY_CREDITS.free < SOLANA_DEEP_DAILY_CREDITS.pro && SOLANA_DEEP_DAILY_CREDITS.pro < SOLANA_DEEP_DAILY_CREDITS.elite)
})

test('deep-check detection matches the route flags exactly', () => {
  assert.equal(solanaDeepCheckKindFromBody({ chain: 'solana', deepCluster: true }), 'cluster')
  assert.equal(solanaDeepCheckKindFromBody({ chain: 'SOLANA', deepDev: true }), 'creator')
  assert.equal(solanaDeepCheckKindFromBody({ chain: 'solana', deepDev: true, deepCluster: true }), 'cluster')
  assert.equal(solanaDeepCheckKindFromBody({ chain: 'solana', deepDev: 'true' }), null, 'route only honours boolean true')
  assert.equal(solanaDeepCheckKindFromBody({ chain: 'base', deepDev: true }), null, 'EVM untouched')
  assert.equal(solanaDeepCheckKindFromBody({ chain: 'solana' }), null)
  assert.equal(solanaDeepCheckKindFromBody(null), null)
})

// ── Route wiring (single enforcement point) ──────────────────────────────────────────────────────
test('token route reserves the deep budget before the token-scan credit and before any scan work', () => {
  const src = readFileSync(new URL('../app/api/token/route.ts', import.meta.url), 'utf8')
  const gate = src.indexOf('reserveSolanaDeepCheck({')
  const quota = src.indexOf('consumeTokenScan(_requestPlan')
  const scan = src.indexOf('await scanSolanaTokenBeta(')
  const auth = src.indexOf('requireAuthenticatedUser(req)')
  assert.ok(auth > 0 && gate > auth, 'gate runs after authentication')
  assert.ok(gate < quota, 'gate runs before the token-scan credit is debited')
  assert.ok(gate < scan, 'gate runs before the Solana scan')
  assert.match(src, /heliusDeep: \{ ledger: _deepReservation\.ledger/, 'scan is capped by the reserved ledger')
  assert.match(src, /finally \{\s*if \(solanaDeepHold\.reservation\)/, 'reservation is settled on every exit path')
  assert.equal((src.match(/scanSolanaTokenBeta\(/g) ?? []).length, 1, 'one Solana scan call site')
})

test('Enhanced Transactions are only reachable through the budgeted provider functions', () => {
  const src = readFileSync(new URL('../lib/server/solanaProviders.ts', import.meta.url), 'utf8')
  const calls = src.match(/fetchImpl\(`https:\/\/api\.helius\.xyz\/v0\/transactions/g) ?? []
  const slotted = src.match(/withHeliusEnhancedSlot\(\(\) => fetchImpl\(`https:\/\/api\.helius\.xyz\/v0\/transactions/g) ?? []
  assert.equal(calls.length, 3)
  assert.equal(slotted.length, 3, 'every Enhanced call is concurrency-limited')
  assert.equal((src.match(/tryCharge\('enhanced_transactions'\)/g) ?? []).length, 3, 'every Enhanced call is charged first')
})

test('Clark falls back to a standard scan when a deep check is refused', () => {
  const src = readFileSync(new URL('../app/api/clark/route.ts', import.meta.url), 'utf8')
  assert.match(src, /refusal\?\.category === "solana_deep_limit"\) solRes = await fetchSolanaScan\(false\)/)
})
