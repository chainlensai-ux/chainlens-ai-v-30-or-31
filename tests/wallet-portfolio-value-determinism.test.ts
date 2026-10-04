// Wallet Scanner — repeated-scan portfolio-value determinism (regression tests).
//
// Production evidence: wallet 0x343f…70b9 lost ~$900 between two deep scans. The dominant holding, ClawBank
// (0x1633…eb07, 99,999,999.57 units, ~$866.90, 94% of value), had no provider price, so it was priced by the
// fallback in one scan and not in the next. Root cause, reproduced below with mocked inputs:
//   1. selection: with no provider value / activity signal it competed for the 8 exploratory slots on RAW UNIT
//      COUNT, so it was not even looked up whenever other unknowns held more units;
//   2. no memory: the illiquid current-price cache lasts 30s, so a transient lookup failure (http_429) on a
//      later scan simply dropped it;
//   3. semantics: known decimals + no local estimate meant it was not "potentially material", so the lane
//      read `verified` at ~$165 — a lost price presented as a complete total.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { priceHoldings, decideStaleVerifiedReuse, PRIOR_MATERIAL_MIN_USD } from '@/lib/engine/modules/pricing/fetchPricing'
import type { ChainHolding } from '@/lib/engine/modules/holdings/types'
import { evidenceFromHoldings, mergePortfolioEvidence, portfolioCoverageText, portfolioValueText } from '@/lib/walletScan/portfolioEvidence'
import { __resetCurrentPriceCacheForTest, readCurrentPriceCache } from '@/lib/pricing/currentPriceResolver'
import {
  classifyPriceFailureReason,
  createLastVerifiedPriceStore,
  STALE_VERIFIED_PRICE_MAX_AGE_MS,
  awaitLastVerifiedWrites,
  type LastVerifiedPrice,
  type LastVerifiedPriceL2,
} from '@/lib/pricing/lastVerifiedPrice'
import {
  buildPortfolioValueDiscontinuityAudit,
  buildValuationSnapshot,
  createValuationSnapshotStore,
  shouldReplaceValuationSnapshot,
} from '@/lib/walletScan/valuationSnapshot'
import { fetchDexscreenerPriceShared, getDexscreenerRequestDiagnostics, resetDexscreenerRequestCache, runInDexscreenerRequestScope } from '@/src/lib/dexscreenerRequestCache'
import { kv } from '@/lib/server/kv'
import { walletScanJobKey, publishWalletScanPartialSnapshot, updateWalletScanJobProgress, type WalletScanJobMetadata } from '@/src/modules/walletScanQueue'
import { publishFinal } from '@/src/modules/walletScanWorker'

const WALLET = '0x343f5a0bd465f8ffec69cf2e90152c80397470b9'
const CLAW = '0x16332535e2c27da578bc2e82beb09ce9d3c8eb07'
const CLAW_QTY = '99999999.57247376'
const CLAW_PRICE = 0.000008669
const CLAW_VALUE = Number(CLAW_QTY) * CLAW_PRICE // ≈ $866.90
const fmt = (v: number) => `$${v.toFixed(2)}`
const T0 = 1_760_000_000_000

beforeEach(() => __resetCurrentPriceCacheForTest())

function clawHolding(overrides: Partial<ChainHolding> = {}): ChainHolding {
  return { chainId: 8453, tokenAddress: CLAW, symbol: 'CLAWBANK', decimals: 18, quantity: CLAW_QTY, amountRaw: '99999999572473760000000000', lastActivityAt: null, classification: 'other', ...overrides } as ChainHolding
}

/** 30 provider-priced holdings ($165), ClawBank, and `unknowns` clean unknown tokens holding MORE units than ClawBank. */
function wallet(opts: { unknowns?: number; spam?: number; claw?: Partial<ChainHolding> | null } = {}): ChainHolding[] {
  const hs: ChainHolding[] = []
  if (opts.claw !== null) hs.push(clawHolding(opts.claw ?? {}))
  for (let i = 0; i < 30; i += 1) {
    hs.push({ chainId: 8453, tokenAddress: `0xa${String(i).padStart(39, '0')}`, symbol: `P${i}`, decimals: 18, quantity: '1', lastActivityAt: null, classification: 'other', providerPriceUsd: 5.5, providerValueUsd: 5.5 } as ChainHolding)
  }
  for (let i = 0; i < (opts.unknowns ?? 0); i += 1) {
    hs.push({ chainId: 8453, tokenAddress: `0xb${String(i).padStart(39, '0')}`, symbol: `U${i}`, decimals: 18, quantity: String(2e8 + i * 1e6 + 0.123), amountRaw: `${2e8 + i}123456789123`, lastActivityAt: null, classification: 'other' } as ChainHolding)
  }
  for (let i = 0; i < (opts.spam ?? 0); i += 1) {
    hs.push({ chainId: 8453, tokenAddress: `0xc${String(i).padStart(39, '0')}`, symbol: `CLAIM AT x${i}.com`, decimals: 18, quantity: '1000000000000000', amountRaw: '1000000000000000000000000000000000', lastActivityAt: null, classification: 'other' } as ChainHolding)
  }
  return hs
}

type ClawBehaviour = 'ok' | 'transient' | 'no_market'

function priceFnFor(behaviour: ClawBehaviour, calls: string[]) {
  return async (_chainId: number, token: string): Promise<number | null> => {
    calls.push(token)
    if (token !== CLAW) return null
    if (behaviour === 'transient') throw new Error('http_429')
    return behaviour === 'ok' ? CLAW_PRICE : null // null → DexScreener answered: no price for this token
  }
}

function silence<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn
  console.warn = () => {}
  return fn().finally(() => { console.warn = warn })
}

type Clock = { t: number }

async function scan(holdings: ChainHolding[], behaviour: ClawBehaviour, store: ReturnType<typeof createLastVerifiedPriceStore> | null, clock: Clock, extra: { allowExploratorySpamLookup?: boolean; expensiveBudget?: { dexscreener?: number; geckoterminal?: number; onchain?: number } } = {}) {
  __resetCurrentPriceCacheForTest() // a later scan: the 30s current-price cache has expired
  const calls: string[] = []
  const out = await silence(() => priceHoldings(holdings, priceFnFor(behaviour, calls), {
    decimalsFn: async () => 18,
    lastVerifiedStore: store,
    now: () => clock.t,
    resolverDeps: { now: () => clock.t },
    ...extra,
  }))
  const evidence = evidenceFromHoldings({
    holdingsComplete: true,
    values: out.pricedHoldings.map((p) => p.valueUsd ?? null),
    materialUnpriced: out.potentiallyMaterialUnpricedCount ?? null,
    staleVerifiedValues: out.pricedHoldings.filter((p) => p.valueUsd == null && p.priceStatus === 'stale_verified').map((p) => p.staleVerifiedValueUsd as number),
  })
  const claw = out.pricedHoldings.find((p) => p.tokenAddress === CLAW) ?? null
  return { out, evidence, claw, calls }
}

function memoryL2(): LastVerifiedPriceL2 & { sets: LastVerifiedPrice[] } {
  const m = new Map<string, LastVerifiedPrice>()
  const sets: LastVerifiedPrice[] = []
  return {
    sets,
    async mget(keys) { return keys.map((k) => m.get(k) ?? null) },
    async set(key, value) { sets.push(value); m.set(key, value) },
  }
}

const near = (a: number | null | undefined, b: number) => assert.ok(a != null && Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`)

describe('root cause, reproduced (no last-verified memory = the old behaviour)', () => {
  it('a transient failure on the dominant token used to read as a VERIFIED ~$165 total — now a lost material price is never verified', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    await scan(wallet(), 'ok', store, clock)
    clock.t += 60_000
    const b = await scan(wallet(), 'no_market', store, clock)
    assert.notEqual(b.evidence.status, 'verified', 'a previously-material holding that lost its price keeps the lane Partial')
    assert.equal(b.evidence.reason, 'some_holdings_unpriced')
  })

  it('without memory, ClawBank is not even looked up when 470 unknowns hold more units (8 exploratory slots)', async () => {
    const r = await scan(wallet({ unknowns: 470 }), 'ok', null, { t: T0 })
    assert.equal(r.calls.includes(CLAW), false)
    assert.equal(r.claw?.priceStatus, 'unavailable')
    assert.equal(r.claw?.priceFailureReason, 'not_looked_up_budget')
  })
})

describe('repeated-scan determinism', () => {
  it('1. identical inputs give an identical total', async () => {
    const a = await scan(wallet({ unknowns: 50 }), 'ok', null, { t: T0 })
    const b = await scan(wallet({ unknowns: 50 }), 'ok', null, { t: T0 })
    assert.equal(a.out.totalValueUsd, b.out.totalValueUsd)
    assert.deepEqual(a.evidence, b.evidence)
    assert.deepEqual(a.calls.slice().sort(), b.calls.slice().sort())
  })

  it('2. the dominant token priced fresh twice gives the same value, verified both times', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    // Scan A: the holdings provider returned fewer competing unknowns; scan B: 470 of them.
    const a = await scan(wallet(), 'ok', store, clock)
    clock.t += 5 * 60_000
    const b = await scan(wallet({ unknowns: 470 }), 'ok', store, clock)
    near(a.claw?.valueUsd, CLAW_VALUE)
    near(b.claw?.valueUsd, CLAW_VALUE)
    assert.equal(a.claw?.priceStatus, 'verified')
    assert.equal(b.claw?.priceStatus, 'verified')
    assert.equal(a.out.totalValueUsd, b.out.totalValueUsd)
    assert.equal(b.claw?.priceObservedAt, clock.t, 'a fresh lookup carries its own observation time')
  })

  it('3. a transient failure after a recent verified price → stale_verified (never 0, never fresh), lane Partial with the disclosed copy', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    await scan(wallet(), 'ok', store, clock)
    clock.t += 5 * 60_000
    const b = await scan(wallet({ unknowns: 470 }), 'transient', store, clock)
    assert.ok(b.calls.includes(CLAW), 'looked up again (prior-material lane)')
    assert.equal(b.claw?.priceStatus, 'stale_verified')
    assert.equal(b.claw?.valueStatus, 'stale_verified')
    assert.equal(b.claw?.priceUsd, null, 'priceUsd / valueUsd stay fresh-only (PnL inputs unchanged)')
    assert.equal(b.claw?.valueUsd, null)
    near(b.claw?.staleVerifiedValueUsd, CLAW_VALUE)
    assert.equal(b.claw?.priceSource, 'dexscreener')
    assert.match(b.claw?.priceFailureReason ?? '', /^error:http_429$/)
    near(b.out.totalValueUsd, 165) // fresh-only engine total
    const pe = b.out.portfolioPricingEvidence!
    assert.deepEqual({ fresh: pe.freshPricedCount, stale: pe.staleVerifiedPricedCount, unpriced: pe.unpricedCount }, { fresh: 30, stale: 1, unpriced: 470 })
    near(pe.freshSubtotalUsd, 165)
    near(pe.staleSupportedSubtotalUsd, CLAW_VALUE)
    assert.equal(b.evidence.status, 'partial')
    assert.equal(b.evidence.reason, 'stale_verified_price_used')
    near(b.evidence.pricedSubtotalUsd, 165 + CLAW_VALUE)
    assert.equal(portfolioValueText(b.evidence, fmt), `${fmt(165 + CLAW_VALUE)} · Partial`)
    assert.equal(portfolioCoverageText(b.evidence), '30 fresh priced · 1 recent verified price · 470 unpriced')
    // The canonical merge keeps the stale disclosure.
    const merged = mergePortfolioEvidence([b.evidence, null])
    assert.equal(merged.staleVerifiedHoldings, 1)
    near(merged.pricedSubtotalUsd, 165 + CLAW_VALUE)
  })

  it('4. a permanent / no-market failure gives no stale reuse (and too-old or decimals-changed priors are refused too)', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    await scan(wallet(), 'ok', store, clock)
    clock.t += 5 * 60_000
    const b = await scan(wallet(), 'no_market', store, clock)
    assert.equal(b.claw?.priceStatus, 'unavailable')
    assert.equal(b.claw?.staleVerifiedValueUsd, null)
    assert.equal(b.claw?.priceFailureReason, 'no_price')
    assert.equal(b.evidence.status, 'partial', 'unknown, not a verified smaller total')
    near(b.evidence.pricedSubtotalUsd, 165)
    near(b.out.portfolioPricingEvidence?.dominantUnpricedValuePreviouslyUsd, CLAW_VALUE)

    // Too old: transient failure, but the prior observation is past the conservative reuse window.
    clock.t = T0 + STALE_VERIFIED_PRICE_MAX_AGE_MS + 1
    const old = await scan(wallet(), 'transient', store, clock)
    assert.equal(old.claw?.priceStatus, 'unavailable')

    // Pure rule table.
    const prior: LastVerifiedPrice = { v: 'v1', chainId: 8453, tokenAddress: CLAW, priceUsd: CLAW_PRICE, source: 'dexscreener', observedAt: T0, confidence: 'high', decimals: 18 }
    const attempts = (reason: string) => ({ cache: null, dexscreener: { attempted: true, ok: false, reason }, geckoterminal: null, onchain: null, multihop: null })
    const at = T0 + 60_000
    assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: attempts('http_429'), lookedUp: true }).reuse, true)
    assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: attempts('fetch_error:timeout'), lookedUp: true }).reuse, true)
    for (const permanent of ['no_matching_pair', 'no_pair_meets_minimum_liquidity', 'zero_liquidity', 'pool_does_not_contain_token', 'decimals_unverified']) {
      assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: attempts(permanent), lookedUp: true }).reuse, false, permanent)
    }
    assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 6, attempts: attempts('http_429'), lookedUp: true }).reason, 'decimals_identity_unverified')
    assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: null, attempts: attempts('http_429'), lookedUp: true }).reuse, false)
    assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: null, negativeCached: true, negativeCacheReason: 'no_matching_pair', lookedUp: false }).reuse, false)
    assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: null, negativeCached: true, negativeCacheReason: 'http_503', lookedUp: false }).reuse, true)
    // Real transient evidence from an ATTEMPTED path still allows reuse.
    for (const transient of ['http_500', 'http_503', 'fetch_error:ETIMEDOUT', 'error:timeout', 'dexscreener_shared_historical_budget_exhausted']) {
      assert.equal(decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: attempts(transient), lookedUp: true }).reuse, true, transient)
    }
    // A budget skip is NOT failure evidence: nothing was looked up.
    const skipped = decideStaleVerifiedReuse({ prior, now: at, currentDecimals: 18, attempts: null, lookedUp: false })
    assert.equal(skipped.reuse, false)
    assert.equal(skipped.reason, 'not_looked_up_no_fresh_attempt')
    assert.equal(classifyPriceFailureReason('not_looked_up_budget'), 'not_attempted')
    assert.equal(classifyPriceFailureReason('some_new_reason'), 'unknown', 'unrecognised reasons are never treated as transient')
  })

  it('5. unchanged balance + lost price → valuation_evidence_lost (not asset_value_dropped), with every audit field', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    const a = await scan(wallet(), 'ok', store, clock)
    const previous = buildValuationSnapshot(WALLET, T0, a.out.pricedHoldings)
    clock.t += 5 * 60_000
    const b = await scan(wallet(), 'no_market', store, clock)
    const audit = buildPortfolioValueDiscontinuityAudit(previous, b.out.pricedHoldings, clock.t)
    assert.equal(audit.length, 1)
    const d = audit[0]
    assert.equal(d.classification, 'valuation_evidence_lost')
    assert.equal(d.token, CLAW)
    assert.equal(d.chain, 8453)
    assert.equal(d.previousBalance, Number(CLAW_QTY))
    assert.equal(d.currentBalance, Number(CLAW_QTY))
    assert.equal(d.previousPrice, CLAW_PRICE)
    assert.equal(d.currentPrice, null)
    near(d.previousValueUsd, CLAW_VALUE)
    assert.equal(d.currentValueUsd, null)
    assert.equal(d.balanceChanged, false)
    assert.equal(d.priceEvidenceChanged, true)
    assert.equal(d.previousPriceSource, 'dexscreener')
    assert.equal(d.currentPriceSource, null)
    assert.equal(d.priceFailureReason, 'no_price')
    assert.equal(d.priorPriceAgeMs, 5 * 60_000)
    near(d.subtotalDeltaUsd, -CLAW_VALUE)

    // With a stale_verified reuse it is still lost FRESH evidence — labelled as such, value preserved.
    const c = await scan(wallet(), 'transient', store, clock)
    const staleAudit = buildPortfolioValueDiscontinuityAudit(previous, c.out.pricedHoldings, clock.t)
    assert.equal(staleAudit[0].classification, 'valuation_evidence_lost')
    assert.equal(staleAudit[0].currentPriceSource, 'stale_verified:dexscreener')
    near(staleAudit[0].currentValueUsd, CLAW_VALUE)
    near(staleAudit[0].subtotalDeltaUsd, 0)
  })

  it('6. a dominant prior-value token keeps material lookup priority (looked up despite 470 bigger-balance unknowns)', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    await scan(wallet(), 'ok', store, clock) // first scan: few competitors, priced
    clock.t += 5 * 60_000
    const b = await scan(wallet({ unknowns: 470 }), 'ok', store, clock)
    assert.ok(b.calls.includes(CLAW))
    assert.equal(b.out.fallbackAudit?.budgetedForLookup, b.calls.length)
    assert.ok(b.calls.length <= 30, 'total provider budget unchanged')
    near(b.claw?.valueUsd, CLAW_VALUE)
    assert.ok(CLAW_VALUE >= PRIOR_MATERIAL_MIN_USD)
  })

  it('7. spam cannot displace it, even with the exploratory spam lookup opted in', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    await scan(wallet(), 'ok', store, clock)
    clock.t += 5 * 60_000
    const b = await scan(wallet({ unknowns: 100, spam: 600 }), 'ok', store, clock, { allowExploratorySpamLookup: true })
    assert.ok(b.calls.includes(CLAW))
    assert.ok(b.calls.length <= 30)
    assert.equal(b.calls[0] === CLAW || b.calls.indexOf(CLAW) < 22, true, 'selected inside the material lane')
  })

  it('9. a reuse never refreshes any observedAt (last-verified record, current-price cache, L2)', async () => {
    const clock = { t: T0 }
    const l2 = memoryL2()
    const store = createLastVerifiedPriceStore({ l2, now: () => clock.t })
    const a = await scan(wallet(), 'ok', store, clock)
    await store.flush()
    const observedA = a.claw!.priceObservedAt
    assert.equal(observedA, T0)
    const writesAfterA = l2.sets.filter((s) => s.tokenAddress === CLAW).length
    assert.equal(writesAfterA, 1)
    clock.t += 10 * 60_000
    const b = await scan(wallet(), 'transient', store, clock)
    await store.flush()
    assert.equal(b.claw?.priceStatus, 'stale_verified')
    assert.equal(b.claw?.priceObservedAt, observedA, 'the reused price keeps its original observation time')
    assert.equal(store.get(8453, CLAW)?.observedAt, observedA)
    assert.equal(l2.sets.filter((s) => s.tokenAddress === CLAW).length, writesAfterA, 'no write-back of a reused price')
    assert.notEqual(readCurrentPriceCache(8453, CLAW).state, 'hit', 'a reuse is never cached as a current price')
    // A second process reading the same L2 sees the original observation too.
    const other = createLastVerifiedPriceStore({ l2, now: () => clock.t })
    await other.prefetch([{ chainId: 8453, tokenAddress: CLAW }])
    assert.equal(other.get(8453, CLAW)?.observedAt, observedA)
  })

  it('10. a real balance going to zero removes the value (no stale value, audit says balance_removed)', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    const a = await scan(wallet(), 'ok', store, clock)
    const previous = buildValuationSnapshot(WALLET, T0, a.out.pricedHoldings)
    clock.t += 5 * 60_000
    for (const holdings of [wallet({ claw: { quantity: '0', amountRaw: '0' } }), wallet({ claw: null })]) {
      const b = await scan(holdings, 'transient', store, clock)
      assert.equal(b.out.pricedHoldings.some((p) => p.tokenAddress === CLAW && (p.staleVerifiedValueUsd != null || p.valueUsd != null)), false)
      near(b.evidence.pricedSubtotalUsd, 165)
      assert.equal(b.evidence.staleVerifiedHoldings, undefined)
      const audit = buildPortfolioValueDiscontinuityAudit(previous, b.out.pricedHoldings, clock.t)
      assert.equal(audit[0].classification, 'balance_removed')
    }
  })
})

describe('8. overwrite order: an older response can never replace a newer final one', () => {
  const originalEnv = { ...process.env }
  const originalGet = kv.get
  const originalSet = kv.set

  function installMemoryKv(delayFirstGetMs = 0) {
    process.env.KV_REST_API_URL = 'https://settled-iad1-example.upstash.io'
    process.env.KV_REST_API_TOKEN = 'test-token'
    const store = new Map<string, unknown>()
    let gets = 0
    kv.get = (async (key: string) => {
      gets += 1
      const value = store.get(key) ?? null
      if (gets === 1 && delayFirstGetMs > 0) await new Promise((r) => setTimeout(r, delayFirstGetMs))
      return value
    }) as typeof kv.get
    kv.set = (async (key: string, value: unknown) => { store.set(key, value); return 'OK' }) as typeof kv.set
    return store
  }
  const restore = () => { process.env = { ...originalEnv }; kv.get = originalGet; kv.set = originalSet }
  const running = (jobId: string): WalletScanJobMetadata => ({ userId: 'u', jobId, wallet: WALLET, status: 'running', createdAt: 1, updatedAt: 1 })
  const partial = (publishedAtElapsedMs: number) => ({ portfolioTotalValueUsd: 165, holdingsCount: 501, topHoldings: [], activeChainIds: [8453], publishedAtElapsedMs })

  it('an in-flight partial-snapshot write that read the running job cannot land over publishFinal', async () => {
    const store = installMemoryKv(20)
    try {
      store.set(walletScanJobKey('job-race-1'), running('job-race-1'))
      const late = publishWalletScanPartialSnapshot('job-race-1', partial(900)) // reads 'running', then stalls
      const fin = publishFinal('job-race-1', { userId: 'u', status: 'done', startedAt: 1, finishedAt: 2, durationMs: 1, pipelineDiagnostics: null }, { success: true })
      await Promise.all([late, fin])
      const job = store.get(walletScanJobKey('job-race-1')) as { status: string; partial?: unknown }
      assert.equal(job.status, 'done')
      assert.equal(job.partial, undefined)
      // Writes after finalization are refused outright.
      await updateWalletScanJobProgress('job-race-1', { stage: 'finalizing', label: 'late', elapsedMs: 1 })
      await publishWalletScanPartialSnapshot('job-race-1', partial(950))
      assert.equal((store.get(walletScanJobKey('job-race-1')) as { status: string }).status, 'done')
    } finally {
      restore()
    }
  })

  it('a partial snapshot never replaces a newer one, and never writes over a terminal job', async () => {
    const store = installMemoryKv()
    try {
      store.set(walletScanJobKey('job-race-2'), running('job-race-2'))
      await publishWalletScanPartialSnapshot('job-race-2', partial(900))
      await publishWalletScanPartialSnapshot('job-race-2', partial(400))
      assert.equal((store.get(walletScanJobKey('job-race-2')) as { partial: { publishedAtElapsedMs: number } }).partial.publishedAtElapsedMs, 900)
      store.set(walletScanJobKey('job-race-3'), { ...running('job-race-3'), status: 'done' })
      await publishWalletScanPartialSnapshot('job-race-3', partial(100))
      assert.equal((store.get(walletScanJobKey('job-race-3')) as { partial?: unknown }).partial, undefined)
    } finally {
      restore()
    }
  })

  it('valuation snapshots are monotonic by scan start: a late older scan never replaces a newer one', async () => {
    const snapshotStore = createValuationSnapshotStore(null)
    const newer = buildValuationSnapshot(WALLET, T0 + 1000, [])
    const older = buildValuationSnapshot(WALLET, T0, [])
    assert.equal(await snapshotStore.write(newer), true)
    assert.equal(await snapshotStore.write(older), false)
    assert.equal((await snapshotStore.read(WALLET))?.scanStartedAt, T0 + 1000)
    assert.equal(shouldReplaceValuationSnapshot(newer, older), false)
  })
})

describe('repeated jobs never share request-scoped DexScreener state', () => {
  it('each job scope has its own cache and counters; a reset in one does not touch another', async () => {
    resetDexscreenerRequestCache()
    let aDiag: ReturnType<typeof getDexscreenerRequestDiagnostics> | null = null
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const jobA = runInDexscreenerRequestScope(async () => {
      resetDexscreenerRequestCache()
      // A 'stale'-bucket lookup resolves locally (no network) and is cached in A's scope only.
      await fetchDexscreenerPriceShared(CLAW, 'base', 0, 'historical')
      await gate
      aDiag = getDexscreenerRequestDiagnostics()
    })
    await runInDexscreenerRequestScope(async () => {
      resetDexscreenerRequestCache() // job B starting must not wipe job A
      assert.equal(getDexscreenerRequestDiagnostics().dexUniqueTokens, 0, "B never sees A's entries")
    })
    release()
    await jobA
    assert.equal(aDiag!.dexUniqueTokens, 1)
    assert.equal(getDexscreenerRequestDiagnostics().dexUniqueTokens, 0, 'the process-level state is untouched by scoped jobs')
  })
})

describe('hardening: budget skips and last-verified durability', () => {
  it('recent prior verified price, same balance/decimals, NOT selected for lookup → unavailable, not stale_verified', async () => {
    const clock = { t: T0 }
    const store = createLastVerifiedPriceStore({ now: () => clock.t })
    await scan(wallet(), 'ok', store, clock)
    clock.t += 5 * 60_000
    // Zero DexScreener budget this scan: ClawBank is ranked but never looked up.
    const b = await scan(wallet(), 'ok', store, clock, { expensiveBudget: { dexscreener: 0 } })
    assert.equal(b.calls.includes(CLAW), false, 'no fresh lookup happened')
    assert.equal(b.claw?.priceStatus, 'unavailable')
    assert.equal(b.claw?.valueStatus, 'unavailable')
    assert.equal(b.claw?.staleVerifiedValueUsd, null)
    assert.equal(b.claw?.priceFailureReason, 'not_looked_up_budget')
    assert.equal(b.evidence.status, 'partial')
    assert.equal(b.evidence.staleVerifiedHoldings, undefined)
    near(b.evidence.pricedSubtotalUsd, 165)
  })

  it('record → flush → new store (empty L1) → L2 prefetch recovers the same original observedAt', async () => {
    const clock = { t: T0 }
    const l2 = memoryL2()
    const store = createLastVerifiedPriceStore({ l2, now: () => clock.t })
    const a = await scan(wallet(), 'ok', store, clock)
    const summary = await a.out.flushLastVerifiedWrites!()
    // ClawBank + the 30 provider-priced holdings (each ≥ $1).
    assert.deepEqual(summary, { queued: 31, persisted: 31, failed: 0, pending: 0 })
    clock.t += 20 * 60_000
    const fresh = createLastVerifiedPriceStore({ l2, now: () => clock.t })
    assert.equal(fresh.get(8453, CLAW), null, 'L1 empty')
    await fresh.prefetch([{ chainId: 8453, tokenAddress: CLAW }])
    assert.equal(fresh.get(8453, CLAW)?.observedAt, T0)
    assert.equal(fresh.get(8453, CLAW)?.priceUsd, CLAW_PRICE)
  })

  it('a failed (or hanging) KV write does not fail the scan, and the flush is bounded', async () => {
    const clock = { t: T0 }
    const rejecting: LastVerifiedPriceL2 = { async mget(keys) { return keys.map(() => null) }, async set() { throw new Error('kv_timeout') } }
    const a = await scan(wallet(), 'ok', createLastVerifiedPriceStore({ l2: rejecting, now: () => clock.t }), clock)
    near(a.claw?.valueUsd, CLAW_VALUE)
    assert.deepEqual(await a.out.flushLastVerifiedWrites!(), { queued: 31, persisted: 0, failed: 31, pending: 0 })

    const throwingSync: LastVerifiedPriceL2 = { async mget() { throw new Error('kv_circuit_open') }, set() { throw new Error('kv_circuit_open') } }
    __resetCurrentPriceCacheForTest()
    const b = await scan(wallet(), 'ok', createLastVerifiedPriceStore({ l2: throwingSync, now: () => clock.t }), clock)
    near(b.claw?.valueUsd, CLAW_VALUE)
    assert.equal((await b.out.flushLastVerifiedWrites!()).failed, 31)

    const hanging: LastVerifiedPriceL2 = { async mget(keys) { return keys.map(() => null) }, set: () => new Promise<void>(() => {}) }
    const c = await scan(wallet(), 'ok', createLastVerifiedPriceStore({ l2: hanging, now: () => clock.t }), clock)
    const started = Date.now()
    const hung = await c.out.flushLastVerifiedWrites!(50)
    assert.ok(Date.now() - started < 1_000, 'never blocks indefinitely')
    assert.deepEqual(hung, { queued: 31, persisted: 0, failed: 0, pending: 31 })
  })

  it("a scan's flush awaits only its own writes, never another scan's", async () => {
    const clock = { t: T0 }
    let releaseOther!: () => void
    const shared: LastVerifiedPriceL2 = {
      async mget(keys) { return keys.map(() => null) },
      set: (key) => (key.includes('0xdead') ? new Promise<void>((r) => { releaseOther = r }) : Promise.resolve()),
    }
    const store = createLastVerifiedPriceStore({ l2: shared, now: () => clock.t })
    const otherScanWrite = store.record({ chainId: 8453, tokenAddress: '0xdead000000000000000000000000000000000000', priceUsd: 1, source: 'dexscreener', observedAt: T0, confidence: 'high', decimals: 18 })
    const a = await scan(wallet(), 'ok', store, clock)
    assert.deepEqual(await a.out.flushLastVerifiedWrites!(200), { queued: 31, persisted: 31, failed: 0, pending: 0 })
    releaseOther()
    assert.equal(await otherScanWrite, 'persisted')
    assert.deepEqual(await awaitLastVerifiedWrites([]), { queued: 0, persisted: 0, failed: 0, pending: 0 })
  })

  it('an older or equal observation never replaces a newer record (L1 or via L2)', async () => {
    const clock = { t: T0 + 10 * 60_000 }
    const l2 = memoryL2()
    const store = createLastVerifiedPriceStore({ l2, now: () => clock.t })
    const base = { chainId: 8453, tokenAddress: CLAW, source: 'dexscreener', confidence: 'high' as const, decimals: 18 }
    assert.equal(await store.record({ ...base, priceUsd: 2, observedAt: T0 + 5 * 60_000 }), 'persisted')
    assert.equal(await store.record({ ...base, priceUsd: 1, observedAt: T0 }), 'skipped', 'older')
    assert.equal(await store.record({ ...base, priceUsd: 3, observedAt: T0 + 5 * 60_000 }), 'skipped', 'equal')
    assert.equal(store.get(8453, CLAW)?.priceUsd, 2)
    assert.equal(l2.sets.length, 1)
    // Another process: learns the newer record from L2, then refuses its own older observation.
    const other = createLastVerifiedPriceStore({ l2, now: () => clock.t })
    await other.prefetch([{ chainId: 8453, tokenAddress: CLAW }])
    assert.equal(await other.record({ ...base, priceUsd: 1, observedAt: T0 + 60_000 }), 'skipped')
    assert.equal(l2.sets.length, 1)
    assert.equal(other.get(8453, CLAW)?.observedAt, T0 + 5 * 60_000)
  })
})
