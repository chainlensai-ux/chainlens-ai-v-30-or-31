// TESTS — walletSnapshotAlchemyBudget: the real, enforced request-scoped Alchemy budget for
// lib/server/walletSnapshot.ts (the dev-wallet / token-intelligence surface — see this module's
// own header for why it is scoped separately from the PnL pipeline's own provider budget).

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  budgetedAlchemyCall,
  getWalletSnapshotAlchemyCostDiagnostics,
  __resetWalletSnapshotAlchemyBudgetForTest,
  MAX_ALCHEMY_CALLS_PER_SCAN,
  MAX_ALCHEMY_CU_PER_SCAN,
} from './walletSnapshotAlchemyBudget'
import { estimatedCuForMethod } from './alchemyCallBudget'

const URL_BASE = 'https://base-mainnet.g.alchemy.com/v2/test-key'

beforeEach(() => __resetWalletSnapshotAlchemyBudgetForTest())

test('a fresh budget reports zero of everything', () => {
  const d = getWalletSnapshotAlchemyCostDiagnostics()
  assert.equal(d.callsUsed, 0)
  assert.equal(d.estimatedCu, 0)
  assert.equal(d.cappedCalls, 0)
  assert.equal(d.requestCacheHits, 0)
  assert.equal(d.singleflightHits, 0)
  assert.deepEqual(d.callsByMethod, {})
})

test('a real call is made exactly once and its result is returned', async () => {
  let invocations = 0
  const result = await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ fromAddress: '0xabc' }], async () => {
    invocations += 1
    return { transfers: [{ hash: '0x1' }] }
  })
  assert.equal(invocations, 1)
  assert.deepEqual(result, { transfers: [{ hash: '0x1' }] })
  assert.equal(getWalletSnapshotAlchemyCostDiagnostics().callsUsed, 1)
})

// ---------------------------------------------------------------------------------------------
// HARD ASSERTION: large pagination cannot exceed the configured budget
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: 200+ paginated requests cannot exceed the configured call budget', async () => {
  // A cheap method (eth_chainId, 0 CU per the published cost table) so the CALL cap is what binds
  // here — the CU cap's independent binding, for an expensive method, is proven separately below.
  let realInvocations = 0
  let granted = 0
  for (let i = 0; i < 250; i++) {
    // Each page has a distinct param — a genuinely new, non-duplicate request every time, exactly
    // like real alchemy_getAssetTransfers pagination (a fresh pageKey per page).
    const result = await budgetedAlchemyCall(URL_BASE, 'eth_chainId', [{ pageKey: `page-${i}` }], async () => {
      realInvocations += 1
      return { transfers: [], pageKey: i < 249 ? `page-${i + 1}` : undefined }
    })
    if (result !== null) granted += 1
  }

  assert.equal(realInvocations, MAX_ALCHEMY_CALLS_PER_SCAN, 'real network invocations must never exceed the call cap')
  assert.equal(granted, MAX_ALCHEMY_CALLS_PER_SCAN)
  const d = getWalletSnapshotAlchemyCostDiagnostics()
  assert.equal(d.callsUsed, MAX_ALCHEMY_CALLS_PER_SCAN)
  assert.equal(d.cappedCalls, 250 - MAX_ALCHEMY_CALLS_PER_SCAN)
  assert.ok(d.estimatedCu <= MAX_ALCHEMY_CU_PER_SCAN)
})

test('HARD ASSERTION: 200+ paginated alchemy_getAssetTransfers requests cannot exceed the configured CU budget', async () => {
  let realInvocations = 0
  let granted = 0
  for (let i = 0; i < 250; i++) {
    const result = await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ pageKey: `page-${i}` }], async () => {
      realInvocations += 1
      return { transfers: [], pageKey: `page-${i + 1}` }
    })
    if (result !== null) granted += 1
  }
  assert.ok(realInvocations < 250, 'the budget must bind well before 250 real paginated calls')
  assert.equal(realInvocations, granted)
  const d = getWalletSnapshotAlchemyCostDiagnostics()
  assert.ok(d.estimatedCu <= MAX_ALCHEMY_CU_PER_SCAN, 'estimated CU must never exceed the hard ceiling')
  assert.ok(d.cappedCalls > 0, 'expected the budget to have actually refused calls across 250 requests')
})

test('HARD ASSERTION: the CU cap binds independently and stops an expensive-method loop before the call cap would', async () => {
  const perCall = estimatedCuForMethod('alchemy_getAssetTransfers')
  let realInvocations = 0
  for (let i = 0; i < MAX_ALCHEMY_CALLS_PER_SCAN; i++) {
    await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ pageKey: `page-${i}` }], async () => {
      realInvocations += 1
      return { transfers: [] }
    })
  }
  assert.ok(realInvocations < MAX_ALCHEMY_CALLS_PER_SCAN,
    `expected the CU cap (${MAX_ALCHEMY_CU_PER_SCAN}) to bind before the call cap (${MAX_ALCHEMY_CALLS_PER_SCAN}) for a ${perCall}-CU method`)
  assert.ok(realInvocations * perCall <= MAX_ALCHEMY_CU_PER_SCAN)
})

test('HARD ASSERTION: no provider call is made after budget refusal', async () => {
  for (let i = 0; i < MAX_ALCHEMY_CALLS_PER_SCAN; i++) {
    await budgetedAlchemyCall(URL_BASE, 'eth_chainId', [`unique-${i}`], async () => 'ok')
  }
  const callsAtCap = getWalletSnapshotAlchemyCostDiagnostics().callsUsed

  let invokedAfterCap = false
  for (let i = 0; i < 10; i++) {
    const result = await budgetedAlchemyCall(URL_BASE, 'eth_chainId', [`unique-after-${i}`], async () => {
      invokedAfterCap = true
      return 'ok'
    })
    assert.equal(result, null, 'a refused call must fail closed to null, matching alchemyRpc\'s own "no result" contract')
  }
  assert.equal(invokedAfterCap, false, 'the real fetcher must never be invoked once the budget is exhausted')
  assert.equal(getWalletSnapshotAlchemyCostDiagnostics().callsUsed, callsAtCap, 'a refused call must never increment the spent total')
})

// ---------------------------------------------------------------------------------------------
// Settled-result reuse / duplicate-call prevention (the proven fetchAlchemyPnlEvents duplicate)
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: identical requests reuse the settled result — proven fetchAlchemyPnlEvents duplicate scenario', async () => {
  // Simulates the real, proven duplicate: two structurally independent call sites
  // (the GoldRush-partial fallback and the full-recovery buy-timeline fallback) requesting the
  // exact same alchemy_getAssetTransfers params for the same wallet.
  let realInvocations = 0
  const params = [{ fromBlock: '0x0', category: ['erc20'], maxCount: '0x7d', order: 'desc', fromAddress: '0xWALLET' }]
  const fetcher = async () => { realInvocations += 1; return { transfers: [{ hash: '0xreal' }] } }

  const first = await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, fetcher)
  const second = await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, fetcher)

  assert.equal(realInvocations, 1, 'the second, identical call must reuse the first\'s settled result, never re-fetch')
  assert.deepEqual(second, first)
  const d = getWalletSnapshotAlchemyCostDiagnostics()
  assert.equal(d.callsUsed, 1)
  assert.equal(d.requestCacheHits, 1)
})

test('concurrent identical requests are coalesced via singleflight, not settled reuse', async () => {
  let realInvocations = 0
  let resolveFetch: (value: { ok: true }) => void
  const fetcher = () => new Promise<{ ok: true }>((resolve) => { realInvocations += 1; resolveFetch = resolve })

  const params = [{ fromAddress: '0xconcurrent' }]
  const p1 = budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, fetcher)
  const p2 = budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, fetcher)

  resolveFetch!({ ok: true })
  const [r1, r2] = await Promise.all([p1, p2])

  assert.equal(realInvocations, 1, 'two concurrent identical requests must share one real call')
  assert.deepEqual(r1, r2)
  assert.equal(getWalletSnapshotAlchemyCostDiagnostics().singleflightHits, 1)
})

test('different arguments are never treated as duplicates', async () => {
  let realInvocations = 0
  const fetcher = async () => { realInvocations += 1; return { ok: true } }

  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ fromAddress: '0xaaa' }], fetcher)
  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ fromAddress: '0xbbb' }], fetcher)
  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ toAddress: '0xaaa' }], fetcher)

  assert.equal(realInvocations, 3, 'genuinely distinct requests must each make their own real call')
})

// ---------------------------------------------------------------------------------------------
// Fail-closed / no-retries semantics
// ---------------------------------------------------------------------------------------------

test('a thrown fetcher error propagates and is never memoized as a fake result', async () => {
  let invocations = 0
  const failingFetcher = async () => { invocations += 1; throw new Error('network_error') }
  const params = [{ fromAddress: '0xerr' }]

  await assert.rejects(() => budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, failingFetcher))
  assert.equal(invocations, 1)

  // A later duplicate request gets its own fresh real attempt — never permanently stuck behind a
  // memoized failure (matches this codebase's "never cache a transient error as negative" convention).
  await assert.rejects(() => budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, failingFetcher))
  assert.equal(invocations, 2, 'a thrown error must never be memoized — a later identical request retries fresh')
})

test('a genuine null result IS memoized, same as any other settled result', async () => {
  let invocations = 0
  const fetcher = async () => { invocations += 1; return null }
  const params = [{ fromAddress: '0xnull' }]

  const first = await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, fetcher)
  const second = await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, fetcher)

  assert.equal(first, null)
  assert.equal(second, null)
  assert.equal(invocations, 1, 'a genuine null answer is a real settled result, reused like any other')
})

test('reset restores a clean slate for the next request, including the settled-result cache', async () => {
  const params = [{ fromAddress: '0xreset' }]
  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, async () => ({ transfers: [] }))
  assert.equal(getWalletSnapshotAlchemyCostDiagnostics().callsUsed, 1)

  __resetWalletSnapshotAlchemyBudgetForTest()
  assert.equal(getWalletSnapshotAlchemyCostDiagnostics().callsUsed, 0)

  // The settled-result cache must also be cleared — a DIFFERENT wallet's request must never reuse
  // a memoized result across the reset boundary.
  let invocations = 0
  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', params, async () => { invocations += 1; return { transfers: [] } })
  assert.equal(invocations, 1, 'a fresh request after reset must make a genuine new call, never reuse the prior request\'s cache')
})

test('callsByMethod attributes real spend to the correct method', async () => {
  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ a: 1 }], async () => 'x')
  await budgetedAlchemyCall(URL_BASE, 'alchemy_getAssetTransfers', [{ a: 2 }], async () => 'x')
  await budgetedAlchemyCall(URL_BASE, 'eth_getTransactionReceipt', [{ a: 3 }], async () => 'x')

  const d = getWalletSnapshotAlchemyCostDiagnostics()
  assert.equal(d.callsByMethod.alchemy_getAssetTransfers, 2)
  assert.equal(d.callsByMethod.eth_getTransactionReceipt, 1)
})
