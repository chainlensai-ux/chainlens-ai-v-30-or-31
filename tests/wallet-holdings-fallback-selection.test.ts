// Wallet Scanner current-holdings fallback selection — regression tests.
//
// Production evidence: GoldRush balances failed (transient http_503), Alchemy supplied 108 holdings with no
// symbol/price and ASSUMED decimals, and the DexScreener fallback reported
//   fallbackEligible 103 / fallbackBudget 30 / budgetedForLookup 0 / materialFallbackCandidates 0
// — every unknown holding was suppressed as "quantity-only spam", so nothing was priced. These tests pin the
// fix: bounded material → activity → exploratory lanes inside the unchanged 30-lookup cap, on-chain decimals
// before valuing an assumed-decimals row, exact DexScreener pair identity, unknown-vs-zero portfolio
// semantics, and GoldRush 5xx as a transient (never billing/auth, never "empty") failure.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  priceHoldings,
  selectFallbackKeys,
  exploratorySuspicion,
  FALLBACK_EXPLORATORY_RESERVED_SLOTS,
} from '@/lib/engine/modules/pricing/fetchPricing'
import type { ChainHolding } from '@/lib/engine/modules/holdings/types'
import { evidenceFromHoldings, portfolioValueText } from '@/lib/walletScan/portfolioEvidence'
import { fetchDexscreenerPriceDetailed } from '@/src/modules/pricingAtTimeEngine/sources/dexscreener'
import { classifyGoldrushHttpFailure, fetchGoldrushHoldings } from '@/src/modules/holdings/utils'
import { fetchChainBalancesWithEvidence, __resetNegativeBalanceCacheForTest } from '@/lib/engine/modules/holdings/fetchHoldings'
import { fetchDexscreenerPriceShared, resetDexscreenerRequestCache, getDexscreenerRequestDiagnostics } from '@/src/lib/dexscreenerRequestCache'
import {
  buildAlchemyOnly108Holdings,
  fixturePriceFn,
  fixtureDecimalsFn,
  REAL_FALLBACK_TOKENS,
  BASE_USDC,
  BASE_CHAIN_ID,
} from './fixtures/alchemyOnly108Holdings'
import { __resetCurrentPriceCacheForTest } from '@/lib/pricing/currentPriceResolver'

// The canonical current-price cache is process-wide; each test starts from an empty cache.
beforeEach(() => __resetCurrentPriceCacheForTest())

const BUDGET = 30
const fmt = (v: number) => `$${v.toFixed(2)}`

function holding(overrides: Partial<ChainHolding>): ChainHolding {
  return { chainId: BASE_CHAIN_ID, tokenAddress: '0xtoken', symbol: 'TOKEN', decimals: 18, quantity: '10', lastActivityAt: null, classification: 'other', ...overrides }
}

function silence<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn
  console.warn = () => {}
  return fn().finally(() => { console.warn = warn })
}

function evidenceOf(out: Awaited<ReturnType<typeof priceHoldings>>, holdingsComplete: boolean) {
  return evidenceFromHoldings({
    holdingsComplete,
    values: out.pricedHoldings.map((p) => (typeof p.valueUsd === 'number' && Number.isFinite(p.valueUsd) ? p.valueUsd : null)),
    materialUnpriced: out.pricedHoldings.length > 0 ? (out.potentiallyMaterialUnpricedCount ?? null) : null,
  })
}

describe('108-holding Alchemy-only fixture (the production shape)', () => {
  it('before: 103 eligible / 0 selected; after: bounded selection prices every resolvable holding', async () => {
    const calls: string[] = []
    const out = await silence(() => priceHoldings(buildAlchemyOnly108Holdings(), fixturePriceFn(calls), { decimalsFn: fixtureDecimalsFn }))
    const audit = out.fallbackAudit!
    assert.equal(audit.holdingsTotal, 108)
    assert.ok(audit.budgetedForLookup > 0, 'the fallback must spend some of its budget')
    assert.ok(audit.budgetedForLookup <= BUDGET)
    assert.equal(calls.length, audit.budgetedForLookup)
    assert.ok(audit.selected.exploratory <= FALLBACK_EXPLORATORY_RESERVED_SLOTS, 'no-signal holdings only get the small reserved slice')
    // Every genuinely resolvable holding (2 canonical stablecoins + 3 fallback-only tokens) is priced.
    assert.equal(audit.pricedCount, 5)
    for (const t of REAL_FALLBACK_TOKENS) {
      const p = out.pricedHoldings.find((h) => h.tokenAddress === t.address)!
      const expectedQty = Number(t.raw) / 10 ** t.realDecimals
      assert.equal(p.decimals, t.realDecimals, 'valued from on-chain decimals, never the assumed 18')
      assert.ok(Math.abs(Number(p.quantity) - expectedQty) < 1e-9 * expectedQty)
      assert.ok(Math.abs((p.valueUsd ?? 0) - expectedQty * t.priceUsd) < 1e-6 * expectedQty * t.priceUsd)
    }
  })

  it('a valuable token discoverable ONLY via the fallback gets priced (not suppressed as quantity-only spam)', async () => {
    const t = REAL_FALLBACK_TOKENS[0]
    const out = await silence(() => priceHoldings(buildAlchemyOnly108Holdings(), fixturePriceFn(), { decimalsFn: fixtureDecimalsFn }))
    const row = out.fallbackAudit!.rows.find((r) => r.tokenAddress === t.address)!
    assert.equal(row.fallbackLane, 'exploratory')
    assert.equal(row.selectedForFallback, true)
    assert.equal(row.priceSource, 'dexscreener')
    assert.equal(row.decimalsSource, 'onchain_verified')
    assert.ok((row.valueUsd ?? 0) > 3000)
  })

  it('a canonical stablecoin with no provider price (Alchemy, assumed decimals) is priced in the cheap pass — never dropped as dust, never a lookup', async () => {
    const calls: string[] = []
    const out = await silence(() => priceHoldings(buildAlchemyOnly108Holdings(), fixturePriceFn(calls), { decimalsFn: fixtureDecimalsFn }))
    const row = out.fallbackAudit!.rows.find((r) => r.tokenAddress === BASE_USDC)!
    assert.equal(row.assetClass, 'verified_stablecoin')
    assert.equal(row.priceSource, 'canonical_stable')
    assert.equal(row.selectedForFallback, false, 'resolved before the lane selector — no budget used')
    assert.ok(!calls.includes(`${BASE_CHAIN_ID}:${BASE_USDC}`))
    assert.equal(row.uiBalance, '1250', 'still valued from on-chain-verified decimals')
    assert.equal(row.valueUsd, 1250)
  })

  it('every current holding carries the full debug record', async () => {
    const out = await silence(() => priceHoldings(buildAlchemyOnly108Holdings(), fixturePriceFn(), { decimalsFn: fixtureDecimalsFn }))
    const rows = out.fallbackAudit!.rows
    assert.equal(rows.length, 108)
    const fields = ['chainId', 'tokenAddress', 'rawQuantity', 'decimals', 'decimalsSource', 'uiBalance', 'providerPriceUsd', 'providerValueUsd',
      'transferRecency', 'currentActivitySignal', 'assetClass', 'knownMetadata', 'materialitySignal', 'spamDustReason',
      'fallbackEligible', 'fallbackLane', 'fallbackRank', 'selectedForFallback', 'skipReason']
    for (const r of rows) for (const f of fields) assert.ok(f in r, `missing ${f}`)
    // Unselected one-unit airdrops are reported as spam-suppressed, with the reason.
    const junk = rows.find((r) => r.rawQuantity === '1000000000000000000' && !r.selectedForFallback)!
    assert.equal(junk.spamDustReason, 'round_airdrop_amount')
    assert.equal(junk.skipReason, 'quantity_only_spam_suppressed')
  })
})

describe('lane selection inside the fixed budget', () => {
  it('100+ unpriced holdings with zero material signals still select a bounded exploratory slice', async () => {
    const calls: string[] = []
    const holdings = Array.from({ length: 140 }, (_, i) => holding({ tokenAddress: `0x${i.toString(16).padStart(40, '0')}`, symbol: `T${i}`, quantity: String(100 + i * 1.37) }))
    const out = await silence(() => priceHoldings(holdings, fixturePriceFn(calls)))
    assert.equal(out.fallbackAudit!.candidates.material, 0)
    assert.equal(calls.length, FALLBACK_EXPLORATORY_RESERVED_SLOTS)
  })

  it('a recent-transfer token is selected ahead of no-signal junk', async () => {
    const calls: string[] = []
    const junk = Array.from({ length: 40 }, (_, i) => holding({ tokenAddress: `0x0${i.toString(16).padStart(39, '0')}`, symbol: `J${i}`, quantity: '1' }))
    const active = holding({ tokenAddress: '0xffff000000000000000000000000000000000001', symbol: 'ACT', quantity: '12.5', lastActivityAt: '2026-09-30T12:00:00Z' })
    await silence(() => priceHoldings([...junk, active], fixturePriceFn(calls)))
    assert.equal(calls[0], `${BASE_CHAIN_ID}:${active.tokenAddress}`)
  })

  it('one-unit spam never consumes the whole budget, and real (non-round) unknowns rank ahead of it', async () => {
    const calls: string[] = []
    const spam = Array.from({ length: 200 }, (_, i) => holding({ tokenAddress: `0x00${i.toString(16).padStart(38, '0')}`, symbol: '?', quantity: '1', amountRaw: '1000000000000000000', decimalsVerified: false }))
    const real = REAL_FALLBACK_TOKENS.map((t) => holding({ tokenAddress: t.address, symbol: '?', quantity: String(Number(t.raw) / 1e18), amountRaw: t.raw, decimalsVerified: false }))
    const out = await silence(() => priceHoldings([...spam, ...real], fixturePriceFn(calls), { decimalsFn: fixtureDecimalsFn }))
    assert.ok(calls.length <= FALLBACK_EXPLORATORY_RESERVED_SLOTS)
    for (const t of REAL_FALLBACK_TOKENS) assert.ok(calls.includes(`${BASE_CHAIN_ID}:${t.address}`), 'real unknowns are explored before round-number junk')
    assert.equal(out.fallbackAudit!.pricedCount, 3)
  })

  it('fallback calls never exceed the budget, in default or opt-in exploratory mode', async () => {
    const material = Array.from({ length: 50 }, (_, i) => holding({ tokenAddress: `0xa${i.toString(16).padStart(39, '0')}`, providerValueUsd: 5 + i }))
    const unknown = Array.from({ length: 50 }, (_, i) => holding({ tokenAddress: `0xb${i.toString(16).padStart(39, '0')}`, quantity: String(3.3 + i) }))
    for (const allowExploratorySpamLookup of [false, true]) {
      const calls: string[] = []
      const out = await silence(() => priceHoldings([...material, ...unknown], fixturePriceFn(calls), { allowExploratorySpamLookup }))
      assert.equal(calls.length, BUDGET)
      assert.equal(out.fallbackAudit!.selected.exploratory, FALLBACK_EXPLORATORY_RESERVED_SLOTS, 'the reserved slice is never taken by material candidates')
      assert.equal(out.fallbackAudit!.selected.material, BUDGET - FALLBACK_EXPLORATORY_RESERVED_SLOTS)
    }
  })

  it('unused reserved slots go back to material candidates; the cap holds', () => {
    const keys = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`)
    const sel = selectFallbackKeys({ rankedKeysByLane: { material: keys('m', 40), activity: [], exploratory: keys('x', 3) }, budget: 30, exploratoryReserved: 8, allowExploratorySpamLookup: false })
    assert.equal(sel.material.length, 27)
    assert.equal(sel.exploratory.length, 3)
  })

  it('duplicates: the same token twice costs one lookup; the same address on two chains is two tokens', async () => {
    const calls: string[] = []
    const a = '0x1111111111111111111111111111111111111111'
    await silence(() => priceHoldings([
      holding({ tokenAddress: a, quantity: '5', providerValueUsd: 9 }),
      holding({ tokenAddress: a.toUpperCase().replace('0X', '0x'), quantity: '6', providerValueUsd: 9 }),
      holding({ chainId: 1, tokenAddress: a, quantity: '7', providerValueUsd: 9 }),
    ], fixturePriceFn(calls)))
    assert.deepEqual([...calls].sort(), [`1:${a}`, `8453:${a}`])
  })

  it('selection is deterministic regardless of input order', async () => {
    const holdings = buildAlchemyOnly108Holdings()
    const first: string[] = []
    const second: string[] = []
    await silence(() => priceHoldings(holdings, fixturePriceFn(first), { decimalsFn: fixtureDecimalsFn }))
    __resetCurrentPriceCacheForTest() // selection determinism, not cache reuse, is under test
    await silence(() => priceHoldings([...holdings].reverse(), fixturePriceFn(second), { decimalsFn: fixtureDecimalsFn }))
    assert.deepEqual([...first].sort(), [...second].sort())
  })

  it('a priced assumed-decimals holding whose on-chain decimals cannot be read stays unpriced — never valued from 18', async () => {
    const t = REAL_FALLBACK_TOKENS[1]
    const out = await silence(() => priceHoldings(
      [holding({ tokenAddress: t.address, symbol: '?', quantity: String(Number(t.raw) / 1e18), amountRaw: t.raw, decimalsVerified: false })],
      fixturePriceFn(),
      { decimalsFn: async () => null },
    ))
    assert.equal(out.pricedHoldings[0].priceUsd, null)
    assert.equal(out.fallbackAudit!.rows[0].skipReason, 'decimals_unverified')
  })

  it('junk signals rank lower but never exclude, and a symbol is never proof of value', () => {
    assert.equal(exploratorySuspicion(holding({ amountRaw: '1000000000000000000' })), 'round_airdrop_amount')
    assert.equal(exploratorySuspicion(holding({ decimals: 0, quantity: '3' })), 'nft_like_zero_decimals')
    assert.equal(exploratorySuspicion(holding({ quantity: '900000000000000' })), 'astronomical_unit_count')
    assert.equal(exploratorySuspicion(holding({ symbol: 'claim at site.com' })), 'advertising_symbol')
    assert.equal(exploratorySuspicion(holding({ symbol: 'USDC', amountRaw: '4213557912083344519021' })), null)
  })
})

describe('reserved exploratory slots — clean discovery floor, junk never displaces material (pure)', () => {
  const keys = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, '0')}`)
  const select = (material: string[], exploratory: string[], suspicious: string[] = [], activity: string[] = []) =>
    selectFallbackKeys({
      rankedKeysByLane: { material, activity, exploratory },
      suspiciousExploratoryKeys: new Set(suspicious),
      budget: BUDGET,
      exploratoryReserved: FALLBACK_EXPLORATORY_RESERVED_SLOTS,
      allowExploratorySpamLookup: false,
    })
  const total = (r: ReturnType<typeof select>) => r.material.length + r.activity.length + r.exploratory.length

  it('30 material + 0 exploratory → 30 material', () => {
    const r = select(keys('m', 30), [])
    assert.equal(r.material.length, 30)
    assert.equal(r.exploratory.length, 0)
  })

  it('30 material + 3 clean exploratory → 27 material + 3 exploratory', () => {
    const r = select(keys('m', 30), keys('c', 3))
    assert.equal(r.material.length, 27)
    assert.equal(r.exploratory.length, 3)
  })

  it('30 material + 100 clean exploratory → 22 material + the full 8-slot discovery floor', () => {
    const r = select(keys('m', 30), keys('c', 100))
    assert.equal(r.material.length, BUDGET - FALLBACK_EXPLORATORY_RESERVED_SLOTS)
    assert.equal(r.exploratory.length, FALLBACK_EXPLORATORY_RESERVED_SLOTS)
    assert.equal(total(r), BUDGET)
  })

  it('30 material + only suspicious junk → 30 material, junk displaces nothing', () => {
    const junk = keys('j', 100)
    const r = select(keys('m', 30), junk, junk)
    assert.equal(r.material.length, 30)
    assert.equal(r.exploratory.length, 0)
  })

  it('junk still gets discovery from capacity material left unused (bounded by the reserved size)', () => {
    const junk = keys('j', 100)
    const r = select(keys('m', 5), junk, junk)
    assert.equal(r.material.length, 5)
    assert.equal(r.exploratory.length, FALLBACK_EXPLORATORY_RESERVED_SLOTS)
  })

  it('clean unknowns are explored before junk; junk only fills what clean left', () => {
    const clean = keys('c', 3)
    const junk = keys('j', 50)
    const r = select(keys('m', 40), [...clean, ...junk], junk)
    assert.equal(r.material.length, 27, 'only the 3 clean unknowns hold slots ahead of material')
    assert.deepEqual(r.exploratory, clean)
  })

  it('activity outranks exploratory when activity evidence exists; the global budget always holds', () => {
    const r = select(keys('m', 10), keys('c', 100), [], keys('a', 30))
    assert.equal(r.material.length, 10)
    assert.equal(r.activity.length, 12)
    assert.equal(r.exploratory.length, FALLBACK_EXPLORATORY_RESERVED_SLOTS)
    assert.equal(total(r), BUDGET)
  })

  it('same input twice → identical selected keys', () => {
    const run = () => select(keys('m', 25), [...keys('c', 4), ...keys('j', 20)], keys('j', 20))
    assert.deepEqual(run(), run())
  })

  it('end-to-end: 30 material + 100 junk unknowns spends all 30 calls on material', async () => {
    const calls: string[] = []
    const material = Array.from({ length: 30 }, (_, i) => holding({ tokenAddress: `0xa${i.toString(16).padStart(39, '0')}`, providerValueUsd: 5 + i }))
    const junk = Array.from({ length: 100 }, (_, i) => holding({ tokenAddress: `0xb${i.toString(16).padStart(39, '0')}`, symbol: '?', quantity: '1', amountRaw: '1000000000000000000', decimalsVerified: false }))
    const out = await silence(() => priceHoldings([...junk, ...material], fixturePriceFn(calls)))
    assert.equal(calls.length, BUDGET)
    assert.equal(out.fallbackAudit!.selected.material, 30)
    assert.deepEqual(out.fallbackAudit!.exploratoryCandidates, { clean: 0, suspicious: 100 })
  })
})

describe('activity lane honesty', () => {
  it('reports the activity lane as unavailable when no holding carries activity evidence (production today)', async () => {
    const out = await silence(() => priceHoldings(buildAlchemyOnly108Holdings(), fixturePriceFn(), { decimalsFn: fixtureDecimalsFn }))
    assert.deepEqual(out.fallbackAudit!.activityLane, { status: 'unavailable', reason: 'no_per_token_activity_evidence_at_pricing_time' })
    assert.equal(out.fallbackAudit!.candidates.activity, 0)
  })

  it('reports it active only when real evidence is supplied — and an activity-backed holding then outranks exploratory', async () => {
    const calls: string[] = []
    const active = holding({ tokenAddress: '0xffff000000000000000000000000000000000002', quantity: '4.5', lastActivityAt: '2026-10-01T00:00:00Z' })
    const unknown = Array.from({ length: 20 }, (_, i) => holding({ tokenAddress: `0x0${i.toString(16).padStart(39, '0')}`, quantity: String(7.1 + i) }))
    const out = await silence(() => priceHoldings([...unknown, active], fixturePriceFn(calls)))
    assert.equal(out.fallbackAudit!.activityLane.status, 'active')
    assert.equal(calls[0], `${BASE_CHAIN_ID}:${active.tokenAddress}`)
  })

  it('the only production producer of ChainHolding.lastActivityAt sets null (no fabricated activity)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('lib/engine/modules/holdings/fetchHoldings.ts', 'utf8')
    assert.match(src, /lastActivityAt: null,/)
  })
})

describe('DexScreener fallback pair identity', () => {
  const TOKEN = '0x7a1f3c09be3b5c1e0d8f2a4b6c9e1d3f5a7b9c01'
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })
  function serve(pairs: unknown[]) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ pairs }), { status: 200 })) as typeof fetch
  }
  const pair = (o: Record<string, unknown>) => ({ chainId: 'base', pairAddress: '0xp', dexId: 'uniswap', priceUsd: '1.5', liquidity: { usd: 50_000 }, volume: { h24: 1_000 }, baseToken: { address: TOKEN, symbol: 'TOK' }, quoteToken: { address: '0xq', symbol: 'WETH' }, ...o })

  it('rejects a wrong-chain pair', async () => {
    serve([pair({ chainId: 'ethereum', priceUsd: '9' })])
    const r = await fetchDexscreenerPriceDetailed(TOKEN, 'base', Date.now())
    assert.equal(r.priceUsd, null)
  })

  it('rejects a wrong-token pair (the token is only the quote side)', async () => {
    serve([pair({ baseToken: { address: '0xother', symbol: 'OTH' }, quoteToken: { address: TOKEN, symbol: 'TOK' }, priceUsd: '42' })])
    const r = await fetchDexscreenerPriceDetailed(TOKEN, 'base', Date.now())
    assert.equal(r.priceUsd, null)
  })

  it('selects the strongest valid market: liquidity, then volume — ignoring malformed and non-positive prices', async () => {
    serve([
      pair({ pairAddress: '0xbad0', priceUsd: '0', liquidity: { usd: 9_000_000 } }),
      pair({ pairAddress: '0xbadx', priceUsd: 'abc', liquidity: { usd: 8_000_000 } }),
      pair({ pairAddress: '0xwrongchain', chainId: 'arbitrum', priceUsd: '7', liquidity: { usd: 7_000_000 } }),
      pair({ pairAddress: '0xlowvol', priceUsd: '1.10', liquidity: { usd: 200_000 }, volume: { h24: 10 } }),
      pair({ pairAddress: '0xhighvol', priceUsd: '1.12', liquidity: { usd: 200_000 }, volume: { h24: 90_000 } }),
      pair({ pairAddress: '0xsmall', priceUsd: '1.40', liquidity: { usd: 5_000 } }),
    ])
    const r = await fetchDexscreenerPriceDetailed(TOKEN, 'base', Date.now())
    assert.equal(r.pairAddress, '0xhighvol')
    assert.equal(r.priceUsd, 1.12)
  })

  it('cached lookups cost zero: one live call per token per request', async () => {
    let live = 0
    globalThis.fetch = (async () => { live += 1; return new Response(JSON.stringify({ pairs: [pair({})] }), { status: 200 }) }) as typeof fetch
    resetDexscreenerRequestCache()
    await fetchDexscreenerPriceShared(TOKEN, 'base', Date.now(), 'holdings')
    await fetchDexscreenerPriceShared(TOKEN, 'base', Date.now(), 'holdings')
    assert.equal(live, 1)
    assert.equal(getDexscreenerRequestDiagnostics().dexCacheHitsByCaller.holdings, 1)
    resetDexscreenerRequestCache()
  })
})

describe('portfolio semantics are preserved (unknown is never $0)', () => {
  it('all fallback failures → "Value unavailable", never $0.00', async () => {
    // Without the two canonical stablecoins (which the cheap pass prices at $1 from the registry alone).
    const holdings = buildAlchemyOnly108Holdings().filter((h) => !['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'].includes(h.tokenAddress))
    const out = await silence(() => priceHoldings(holdings, async () => null, { decimalsFn: fixtureDecimalsFn }))
    assert.equal(out.fallbackAudit!.pricedCount, 0)
    for (const complete of [false, true]) {
      const e = evidenceOf(out, complete)
      assert.equal(e.status, 'unavailable')
      assert.equal(portfolioValueText(e, fmt), 'Value unavailable')
    }
  })

  it('one successful fallback plus remaining unknowns → partial subtotal', async () => {
    const t = REAL_FALLBACK_TOKENS[2]
    const only = async (chainId: number, addr: string) => (chainId === BASE_CHAIN_ID && addr.toLowerCase() === t.address ? t.priceUsd : null)
    const out = await silence(() => priceHoldings(buildAlchemyOnly108Holdings(), only, { decimalsFn: fixtureDecimalsFn }))
    assert.equal(out.fallbackAudit!.pricedCount, 3, 'the fallback-priced token + the 2 canonical stablecoins')
    const expected = (Number(t.raw) / 1e18) * t.priceUsd + 1250 + 310.5
    // Alchemy-only (GoldRush failed): incomplete holdings → partial.
    const e = evidenceOf(out, false)
    assert.equal(e.status, 'partial')
    assert.ok(Math.abs((e.pricedSubtotalUsd ?? 0) - expected) < 1e-6)
    assert.match(portfolioValueText(e, fmt), /· Partial$/)
    // Even if the holdings list were complete, the unpriced unknown rows keep it partial.
    assert.ok((out.potentiallyMaterialUnpricedCount ?? 0) > 0)
    assert.equal(evidenceOf(out, true).status, 'partial')
  })

  it('a complete empty wallet is still the only $0.00', () => {
    assert.equal(portfolioValueText(evidenceFromHoldings({ holdingsComplete: true, values: [] }), fmt), '$0.00')
    assert.equal(portfolioValueText(evidenceFromHoldings({ holdingsComplete: false, values: [] }), fmt), 'Value unavailable')
  })
})

describe('GoldRush failures are classified, and a 503 stays transient', () => {
  const realFetch = globalThis.fetch
  const savedEnv = { ...process.env }
  beforeEach(() => {
    process.env.GOLDRUSH_API_KEY = 'test-goldrush'
    process.env.ALCHEMY_BASE_KEY = 'test-alchemy'
    __resetNegativeBalanceCacheForTest()
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    process.env = { ...savedEnv }
    __resetNegativeBalanceCacheForTest()
  })

  it('401/403 auth, 402 billing, 429 rate limit, 5xx transient', () => {
    assert.equal(classifyGoldrushHttpFailure(401), 'auth_config')
    assert.equal(classifyGoldrushHttpFailure(403), 'auth_config')
    assert.equal(classifyGoldrushHttpFailure(402), 'billing')
    assert.equal(classifyGoldrushHttpFailure(429), 'rate_limited')
    assert.equal(classifyGoldrushHttpFailure(503), 'transient_provider')
    assert.equal(classifyGoldrushHttpFailure(500), 'transient_provider')
    assert.equal(classifyGoldrushHttpFailure(404), 'request_rejected')
  })

  it('a GoldRush 503 is a transient failure — not billing/auth — and Alchemy carries the scan without a negative cache', async () => {
    let goldrushCalls = 0
    let alchemyCalls = 0
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('covalenthq')) { goldrushCalls += 1; return new Response('unavailable', { status: 503 }) }
      alchemyCalls += 1
      return new Response(JSON.stringify({ result: { tokenBalances: [] } }), { status: 200 })
    }) as typeof fetch

    const gr = await fetchGoldrushHoldings('base', '0x000000000000000000000000000000000000dEaD')
    assert.equal(gr.ok, false)
    assert.deepEqual(gr.failure, { kind: 'transient_provider', httpStatus: 503 })

    const first = await silence(() => fetchChainBalancesWithEvidence('0x000000000000000000000000000000000000dEaD', BASE_CHAIN_ID))
    assert.equal(first.evidence.providerStatus, 'partial')
    assert.equal(first.evidence.nativeBalanceCovered, false)
    assert.equal(first.evidence.goldrushFailureKind, 'transient_provider')
    assert.equal(first.evidence.goldrushHttpStatus, 503)
    // Not remembered as a confirmed-empty wallet: the next call asks the providers again.
    const before = goldrushCalls + alchemyCalls
    const second = await silence(() => fetchChainBalancesWithEvidence('0x000000000000000000000000000000000000dEaD', BASE_CHAIN_ID))
    assert.notEqual(second.evidence.providerStatus, 'confirmed_empty_cached')
    assert.ok(goldrushCalls + alchemyCalls > before)
  })

  it('Alchemy rows are marked as assumed-decimals, and the evidence is incomplete while GoldRush is down', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('covalenthq')) return new Response('', { status: 503 })
      return new Response(JSON.stringify({ result: { tokenBalances: [{ contractAddress: BASE_USDC, tokenBalance: '0x' + (1_250_000_000).toString(16) }] } }), { status: 200 })
    }) as typeof fetch
    const r = await silence(() => fetchChainBalancesWithEvidence('0x000000000000000000000000000000000000dEaD', BASE_CHAIN_ID))
    assert.equal(r.holdings.length, 1)
    assert.equal(r.holdings[0].decimalsVerified, false)
    assert.equal(r.holdings[0].metadataSource, 'alchemy')
    assert.equal(r.evidence.nativeBalanceCovered, false)
  })
})
