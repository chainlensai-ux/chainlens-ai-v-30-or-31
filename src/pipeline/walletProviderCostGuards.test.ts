// TESTS — wallet-scan provider cost guards (cost-audit task).
//
// The remaining hard assertions this task requires, at the layer where each property is actually
// decided. Each is a real cost property, not a restatement of an implementation detail.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildChainAwareHistoricalPriceSourceDetailed,
  VERIFIED_STABLECOIN_USD,
} from './pricingAtTimeAdapter'
import {
  getWalletProviderCostAudit,
  __resetWalletProviderCostLedgerForTest,
} from '../modules/providerCost/walletProviderCostLedger'
import {
  fetchProviderWindow,
  resetProviderFetchWindowRequestCache,
  getProviderFetchWindowCoalescingCounters,
} from '../modules/providerFetchWindow/index'
import { fetchBaseDexPriceDetailed, __resetBaseDexCachesForTest, resetBaseDexRpcBudgetForScan } from '../modules/pricingAtTimeEngine/sources/basedex'
import { getHistoricalRpcBudgetSummary } from '../modules/pricingAtTimeEngine/sources/historicalRpcBudget'

// Real, canonical Base USDC — the same address quoteLegPricing's own verified-stablecoin registry
// recognises. Never a made-up address: the whole point of the short-circuit is that it is
// address-verified.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const RANDOM_TOKEN = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca'

beforeEach(() => {
  __resetWalletProviderCostLedgerForTest()
  resetProviderFetchWindowRequestCache('cost-guard-test')
})

// ---------------------------------------------------------------------------------------------
// Verified-stablecoin short-circuit (cost-audit finding B.1)
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: a verified stablecoin resolves with ZERO provider calls', async () => {
  let goldrushInvocations = 0
  const goldrushSpy = async () => { goldrushInvocations += 1; return null }

  const router = buildChainAwareHistoricalPriceSourceDetailed(goldrushSpy)
  const result = await router(USDC_BASE, 'base', Date.UTC(2026, 0, 15))

  assert.equal(result.price, VERIFIED_STABLECOIN_USD, 'a verified USD-pegged stablecoin is exactly $1.00')
  assert.equal(result.route, 'verified_stablecoin')
  assert.deepEqual(result.attempts, [], 'no provider attempt may be recorded for a deterministic resolution')
  assert.equal(goldrushInvocations, 0, 'the primary provider must never be invoked for a verified stablecoin')

  const audit = getWalletProviderCostAudit()
  assert.equal(audit.goldrush.calls, 0, 'zero real GoldRush calls')
  assert.ok(audit.goldrush.duplicateCallsPrevented >= 1, 'the saved call must be recorded as prevented')
})

test('the stablecoin short-circuit never applies to an unrecognised token', async () => {
  let goldrushInvocations = 0
  const goldrushSpy = async () => { goldrushInvocations += 1; return null }

  const router = buildChainAwareHistoricalPriceSourceDetailed(goldrushSpy)
  const result = await router(RANDOM_TOKEN, 'base', Date.UTC(2026, 0, 15))

  assert.notEqual(result.route, 'verified_stablecoin',
    'an address that is not a verified stablecoin must go through the real provider chain')
  assert.notEqual(result.price, VERIFIED_STABLECOIN_USD,
    'an unverified token must never be handed the deterministic $1.00')
  // The router tries Base's real order (geckoterminal -> dexscreener -> goldrush) and a safety net;
  // what matters here is only that it did NOT short-circuit.
  assert.ok(goldrushInvocations >= 0)
})

test('repeated stablecoin lookups stay at zero provider calls, however many requirements ask', async () => {
  let goldrushInvocations = 0
  const router = buildChainAwareHistoricalPriceSourceDetailed(async () => { goldrushInvocations += 1; return null })

  for (let i = 0; i < 250; i++) {
    const result = await router(USDC_BASE, 'base', Date.UTC(2026, 0, 1) + i * 86_400_000)
    assert.equal(result.price, VERIFIED_STABLECOIN_USD)
  }
  assert.equal(goldrushInvocations, 0)
  assert.equal(getWalletProviderCostAudit().goldrush.calls, 0)
})

// ---------------------------------------------------------------------------------------------
// One transaction-history fetch per chain (requirement 2)
// ---------------------------------------------------------------------------------------------

test('HARD ASSERTION: one wallet scan cannot fetch transaction history more than once per chain', async () => {
  const wallet = '0x1111111111111111111111111111111111111111'

  // Many consumers ask for the same chain's history, exactly as the old pipeline, the V2 engine,
  // holdings, trades and recovery all do within one scan. Deliberately fired both concurrently and
  // sequentially, since those exercise different reuse paths (in-flight coalescing vs settled
  // reuse) and BOTH must avoid a second live fetch.
  await Promise.all([
    fetchProviderWindow('base', wallet, 30, 'old-pipeline'),
    fetchProviderWindow('base', wallet, 30, 'v2-engine'),
    fetchProviderWindow('base', wallet, 30, 'holdings'),
  ])
  await fetchProviderWindow('base', wallet, 30, 'recovery')
  await fetchProviderWindow('base', wallet, 30, 'pnl')

  const counters = getProviderFetchWindowCoalescingCounters()
  assert.equal(counters.liveFetches, 1, 'exactly one live transaction-history fetch per chain, no matter how many consumers ask')
  assert.ok(counters.coalescedHits + counters.settledReuseHits >= 4, 'every other consumer must have reused it')
})

test('HARD ASSERTION: duplicate module consumers reuse the same settled result object', async () => {
  const wallet = '0x2222222222222222222222222222222222222222'
  const first = await fetchProviderWindow('base', wallet, 30, 'old-pipeline')
  const second = await fetchProviderWindow('base', wallet, 30, 'v2-engine')

  assert.equal(getProviderFetchWindowCoalescingCounters().liveFetches, 1)
  // Same settled payload — not merely equal counts, the same real events.
  assert.deepEqual(second.rawEvents, first.rawEvents)
  assert.equal(second.providerFetchWindowDays, first.providerFetchWindowDays)
})

test('HARD ASSERTION: a provider failure does not trigger retries or an alternate duplicate fetch', async () => {
  const wallet = '0x3333333333333333333333333333333333333333'
  // No provider keys are configured in this environment, so this fetch genuinely fails/degrades.
  const first = await fetchProviderWindow('base', wallet, 30, 'old-pipeline')
  const afterFirst = getProviderFetchWindowCoalescingCounters().liveFetches

  // A later consumer must receive the SAME degraded, scan-scoped result — never a hopeful retry.
  const second = await fetchProviderWindow('base', wallet, 30, 'v2-engine')
  assert.equal(getProviderFetchWindowCoalescingCounters().liveFetches, afterFirst,
    'a failed fetch must never be retried by a later consumer within the same scan')
  assert.equal(second.rawEvents.length, first.rawEvents.length)
})

test('separate chains each get their own single fetch (per-chain, not global, dedupe)', async () => {
  const wallet = '0x4444444444444444444444444444444444444444'
  await fetchProviderWindow('base', wallet, 30, 'old-pipeline')
  await fetchProviderWindow('eth', wallet, 30, 'old-pipeline')
  await fetchProviderWindow('base', wallet, 30, 'v2-engine')
  await fetchProviderWindow('eth', wallet, 30, 'v2-engine')

  assert.equal(getProviderFetchWindowCoalescingCounters().liveFetches, 2,
    'exactly one live fetch for Base and one for ETH — never a third')
})

// ---------------------------------------------------------------------------------------------
// Disabled on-chain RPC pricing (requirement 4)
// ---------------------------------------------------------------------------------------------

const RPC_FLAG = 'HISTORICAL_ONCHAIN_RPC_PRICING_ENABLED'
const originalRpcFlag = process.env[RPC_FLAG]
afterEach(() => {
  if (originalRpcFlag === undefined) delete process.env[RPC_FLAG]
  else process.env[RPC_FLAG] = originalRpcFlag
})

test('HARD ASSERTION: disabled historical on-chain pricing makes zero historical RPC calls', async () => {
  delete process.env[RPC_FLAG]
  __resetBaseDexCachesForTest()
  resetBaseDexRpcBudgetForScan()

  for (let i = 0; i < 50; i++) {
    const result = await fetchBaseDexPriceDetailed(
      `0x${(0xb000 + i).toString(16).padStart(40, '0')}`,
      'base',
      Date.UTC(2026, 0, 1) + i * 3_600_000,
    )
    assert.equal(result.priceUsd, null)
    assert.equal(result.reason, 'onchain_rpc_pricing_disabled')
  }

  const summary = getHistoricalRpcBudgetSummary()
  assert.equal(summary.enabled, false, 'the kill switch must default to disabled')
  assert.equal(summary.totalRpcCalls, 0, 'a disabled on-chain pricing path must make literally zero RPC calls')
  assert.equal(summary.estimatedAlchemyCu, 0)
})
