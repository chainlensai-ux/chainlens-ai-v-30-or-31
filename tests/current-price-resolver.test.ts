// Canonical current-price resolver — source ladder, identity, pool math, multihop, cache.
// Pure: every source is injected (no network), except the adapter tests that mock global fetch.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCurrentPriceResolver,
  selectGeckoTerminalPool,
  readCurrentPriceCache,
  recordCurrentPrice,
  __resetCurrentPriceCacheForTest,
  CURRENT_PRICE_TTL_LIQUID_MS,
  V4_NATIVE_CURRENCY,
  type CurrentPriceResolverDeps,
  type GeckoTerminalPool,
  type OnchainPoolState,
} from '@/lib/pricing/currentPriceResolver'
import { v2PriceInQuote, sqrtPriceX96ToPriceInQuote } from '@/lib/pricing/poolMath'
import { dexscreenerSource } from '@/lib/pricing/currentPriceSources'
import { GeckoTerminalClient } from '@/src/modules/fallbackPricing/geckoTerminalClient'
import { resetDexscreenerRequestCache } from '@/src/lib/dexscreenerRequestCache'
import { priceHoldings, DEFAULT_EXPENSIVE_BUDGET } from '@/lib/engine/modules/pricing/fetchPricing'
import { createOnchainPoolSource, v4PoolId } from '@/lib/pricing/onchainPoolSource'
import { encodeAbiParameters, keccak256 } from 'viem'
import { evidenceFromHoldings, portfolioValueText, portfolioCoverageText } from '@/lib/walletScan/portfolioEvidence'

const BASE = 8453
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const WETH = '0x4200000000000000000000000000000000000006'
const T = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'
const ALL = { dexscreener: true, geckoterminal: true, onchain: true }
const ETH_USD = 3000

const sqrtX96 = (rawToken1PerToken0: number) => BigInt(Math.round(Math.sqrt(rawToken1PerToken0) * 2 ** 96))
const near = (a: number | null, b: number, rel = 1e-6) => assert.ok(a != null && Math.abs(a - b) <= Math.abs(b) * rel, `${a} ≉ ${b}`)

type Calls = { ds: number; gt: number; pools: string[]; eth: number }
function deps(over: Partial<CurrentPriceResolverDeps> & { pools?: Record<string, OnchainPoolState[]>; decimals?: Record<string, number>; gtPools?: GeckoTerminalPool[]; ethUsd?: number | null } = {}, calls: Calls = { ds: 0, gt: 0, pools: [], eth: 0 }): CurrentPriceResolverDeps {
  const decimals: Record<string, number> = { [USDC]: 6, [WETH]: 18, [T]: 18, [B]: 18, [C]: 18, ...(over.decimals ?? {}) }
  return {
    dexscreener: over.dexscreener ?? (async () => { calls.ds += 1; return { priceUsd: null, reason: 'no_matching_pair' } }),
    geckoterminal: over.geckoterminal ?? (async () => { calls.gt += 1; return { network: 'base', pools: over.gtPools ?? [], reason: (over.gtPools ?? []).length ? null : 'no_pool_found' } }),
    onchain: over.onchain ?? {
      listPools: async (_c, token) => { calls.pools.push(token); return over.pools?.[token.toLowerCase()] ?? [] },
      decimals: async (_c, token) => decimals[token.toLowerCase()] ?? null,
    },
    ethUsd: over.ethUsd === null ? (async () => null) : (async () => { calls.eth += 1; return { priceUsd: over.ethUsd ?? ETH_USD, observedAt: Date.now(), source: 'test' } }),
    now: over.now,
  }
}

beforeEach(() => __resetCurrentPriceCacheForTest())

describe('A–C cheap ladder', () => {
  it('canonical USDC resolves at $1 with no DexScreener call', async () => {
    const calls: Calls = { ds: 0, gt: 0, pools: [], eth: 0 }
    const r = createCurrentPriceResolver(deps({}, calls))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: USDC.toUpperCase().replace('0X', '0x') })
    assert.equal(res.evidence.source, 'canonical_stable')
    assert.equal(res.evidence.priceUsd, 1)
    assert.equal(calls.ds, 0)
  })

  it('a fake USDC (non-canonical address) is never treated as a stablecoin', async () => {
    const calls: Calls = { ds: 0, gt: 0, pools: [], eth: 0 }
    const r = createCurrentPriceResolver(deps({}, calls))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: '0x9999999999999999999999999999999999999999' })
    assert.equal(res.evidence.status, 'unavailable')
    assert.notEqual(res.evidence.source, 'canonical_stable')
    assert.equal(calls.ds, 1, 'falls through to market sources, never $1 by ticker')
  })

  it('canonical WETH uses the verified ETH/USD anchor', async () => {
    const r = createCurrentPriceResolver(deps())
    const res = await r.resolveCheap({ chainId: BASE, tokenAddress: WETH })
    assert.equal(res.evidence.source, 'canonical_native')
    assert.equal(res.evidence.priceUsd, ETH_USD)
  })

  it('a provider price wins over every market source', async () => {
    const calls: Calls = { ds: 0, gt: 0, pools: [], eth: 0 }
    const r = createCurrentPriceResolver(deps({ dexscreener: async () => { calls.ds += 1; return { priceUsd: 9, reason: null } } }, calls))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T, providerPriceUsd: 1.23 })
    assert.equal(res.evidence.source, 'provider')
    assert.equal(res.evidence.priceUsd, 1.23)
    assert.equal(calls.ds, 0)
  })

  it('a cache hit avoids the network; a stale entry is rejected', async () => {
    let t = 1_000_000
    const calls: Calls = { ds: 0, gt: 0, pools: [], eth: 0 }
    const r = createCurrentPriceResolver(deps({ now: () => t, dexscreener: async () => { calls.ds += 1; return { priceUsd: 2, reason: null, liquidityUsd: 500_000 } } }, calls))
    await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(calls.ds, 1)
    const hit = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(hit.evidence.source, 'shared_cache')
    assert.equal(hit.evidence.originalSource, 'dexscreener')
    assert.equal(calls.ds, 1, 'cache hit costs zero calls')
    t += CURRENT_PRICE_TTL_LIQUID_MS + 1
    const again = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(again.attempts.cache, 'stale')
    assert.equal(calls.ds, 2, 'a stale entry is never served')
  })

  it('the cache is chain-strict', () => {
    recordCurrentPrice(BASE, T, { priceUsd: 2, status: 'verified', source: 'dexscreener', route: [T, 'USD'], poolAddress: null, liquidityUsd: 1e6, observedAt: 0, confidence: 'high', reason: null })
    assert.equal(readCurrentPriceCache(1, T).state, 'miss')
    assert.equal(readCurrentPriceCache(BASE, T).state, 'hit')
  })

  it('a failure is only a very short negative cache, and never suppresses later pricing', async () => {
    let t = 5_000_000
    let price: number | null = null
    const r = createCurrentPriceResolver(deps({ now: () => t, geckoterminal: null, onchain: null, dexscreener: async () => ({ priceUsd: price, reason: price ? null : 'no_matching_pair' }) }))
    assert.equal((await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })).evidence.status, 'unavailable')
    price = 4
    t += 16_000
    assert.equal((await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })).evidence.priceUsd, 4)
  })
})

describe('D–E indexed markets', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch; resetDexscreenerRequestCache() })
  const dsPair = (o: Record<string, unknown>) => ({ chainId: 'base', pairAddress: '0xp', priceUsd: '2', liquidity: { usd: 80_000 }, volume: { h24: 1 }, baseToken: { address: T }, quoteToken: { address: WETH }, ...o })

  it('DexScreener: wrong chain and wrong token side are rejected; the strongest valid pool wins', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ pairs: [
      dsPair({ pairAddress: '0xwrongchain', chainId: 'ethereum', priceUsd: '99', liquidity: { usd: 9e9 } }),
      dsPair({ pairAddress: '0xquoteside', baseToken: { address: B }, quoteToken: { address: T }, priceUsd: '77', liquidity: { usd: 9e9 } }),
      dsPair({ pairAddress: '0xweak', priceUsd: '1.9', liquidity: { usd: 20_000 } }),
      dsPair({ pairAddress: '0xstrong', priceUsd: '2.05', liquidity: { usd: 400_000 } }),
    ] }), { status: 200 })) as typeof fetch
    resetDexscreenerRequestCache()
    const r = createCurrentPriceResolver({ dexscreener: dexscreenerSource })
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T }, { dexscreener: true, geckoterminal: false, onchain: false })
    assert.equal(res.evidence.source, 'dexscreener')
    assert.equal(res.evidence.poolAddress, '0xstrong')
    assert.equal(res.evidence.priceUsd, 2.05)
  })

  it('GeckoTerminal: wrong token and wrong network are rejected; the token\'s own side is used', () => {
    const pool = (o: Partial<GeckoTerminalPool>): GeckoTerminalPool => ({ poolAddress: '0xp', dexId: 'uniswap', network: 'base', baseTokenAddress: T, quoteTokenAddress: WETH, basePriceUsd: 2, quotePriceUsd: 3000, reserveUsd: 50_000, volume24hUsd: 10, ...o })
    assert.equal(selectGeckoTerminalPool([pool({ baseTokenAddress: B })], T, 'base').pool, null, 'wrong token')
    assert.equal(selectGeckoTerminalPool([pool({ network: 'eth' })], T, 'base').pool, null, 'wrong network')
    const quoteSide = selectGeckoTerminalPool([pool({ poolAddress: '0xq', baseTokenAddress: B, quoteTokenAddress: T, basePriceUsd: 77, quotePriceUsd: 2.1 })], T, 'base')
    assert.equal(quoteSide.priceUsd, 2.1, 'the quote token\'s OWN price, never the base token\'s')
    const best = selectGeckoTerminalPool([pool({ poolAddress: '0xa', reserveUsd: 10_000 }), pool({ poolAddress: '0xb', reserveUsd: 90_000, basePriceUsd: 2.2 }), pool({ poolAddress: '0xc', reserveUsd: 1e9, basePriceUsd: 0 })], T, 'base')
    assert.equal(best.pool?.poolAddress, '0xb')
  })

  it('GeckoTerminal client: ids are parsed strictly and a cross-network token is not this chain\'s market', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [
      { id: `base_0xpool1`, attributes: { address: '0xpool1', base_token_price_usd: '2.5', quote_token_price_usd: '3000', reserve_in_usd: '50000' }, relationships: { base_token: { data: { id: `base_${T}` } }, quote_token: { data: { id: `base_${WETH}` } } } },
      { id: `base_0xpool2`, attributes: { address: '0xpool2', base_token_price_usd: '9', reserve_in_usd: '900000' }, relationships: { base_token: { data: { id: `eth_${T}` } }, quote_token: { data: { id: `base_${WETH}` } } } },
    ] }), { status: 200 })) as typeof fetch
    const client = new GeckoTerminalClient('base')
    assert.deepEqual(await client.getTokenPriceUsdDetailed(T), { priceUsd: 2.5, reason: null })
  })
})

describe('F direct on-chain pool pricing', () => {
  it('V2 reserve ratio', async () => {
    near(v2PriceInQuote(BigInt(100_000) * BigInt(1e18), BigInt(250_000) * BigInt(1e6), { tokenIsToken0: true, tokenDecimals: 18, quoteDecimals: 6 }), 2.5)
    const pool: OnchainPoolState = { kind: 'v2', poolAddress: '0xv2', token0: T, token1: USDC, reserve0: BigInt(100_000) * BigInt(1e18), reserve1: BigInt(250_000) * BigInt(1e6) }
    const r = createCurrentPriceResolver(deps({ pools: { [T]: [pool] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.source, 'onchain_v2')
    near(res.evidence.priceUsd, 2.5)
    assert.equal(res.evidence.confidence, 'high')
  })

  it('V3 sqrtPriceX96', async () => {
    const sqrt = sqrtX96(2.5 * 10 ** (6 - 18)) // T (token0, 18d) priced 2.5 USDC (token1, 6d)
    near(sqrtPriceX96ToPriceInQuote(sqrt, { tokenIsToken0: true, tokenDecimals: 18, quoteDecimals: 6 }), 2.5)
    const pool: OnchainPoolState = { kind: 'v3', poolAddress: '0xv3', token0: T, token1: USDC, sqrtPriceX96: sqrt, liquidity: BigInt(10) ** BigInt(20), quoteBalanceRaw: BigInt(300_000) * BigInt(1e6) }
    const r = createCurrentPriceResolver(deps({ pools: { [T]: [pool] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.source, 'onchain_v3')
    near(res.evidence.priceUsd, 2.5)
  })

  it('V4 pool state against native ETH', async () => {
    // currency0 = native ETH, currency1 = T. 1 T = 0.001 ETH → 1000 T per ETH.
    const sqrt = sqrtX96(1000)
    const L = BigInt(Math.round(50e18 * Math.sqrt(1000))) // ≈ 50 ETH virtual reserve
    const pool: OnchainPoolState = { kind: 'v4', poolAddress: '0xpoolid', token0: V4_NATIVE_CURRENCY, token1: T, sqrtPriceX96: sqrt, liquidity: L }
    const r = createCurrentPriceResolver(deps({ pools: { [T]: [pool] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.source, 'onchain_v4')
    near(res.evidence.priceUsd, 3)
  })

  it('an unpriced quote asset leaves the token unpriced', async () => {
    const pool: OnchainPoolState = { kind: 'v2', poolAddress: '0xv2', token0: T, token1: WETH, reserve0: BigInt(1e24), reserve1: BigInt(1e21) }
    const r = createCurrentPriceResolver(deps({ ethUsd: null, pools: { [T]: [pool] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.status, 'unavailable')
    assert.equal(res.attempts.onchain?.reason, 'quote_asset_unpriced')
  })

  it('zero liquidity and malformed pool state are rejected', async () => {
    const zero: OnchainPoolState = { kind: 'v3', poolAddress: '0xz', token0: T, token1: USDC, sqrtPriceX96: sqrtX96(2.5e-12), liquidity: BigInt(0) }
    const malformed: OnchainPoolState = { kind: 'v2', poolAddress: '0xm', token0: T, token1: USDC, reserve0: null, reserve1: null }
    for (const [pool, reason] of [[zero, 'zero_liquidity'], [malformed, 'malformed_pool_state']] as const) {
      __resetCurrentPriceCacheForTest()
      const r = createCurrentPriceResolver(deps({ pools: { [T]: [pool] } }))
      const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
      assert.equal(res.evidence.priceUsd, null)
      assert.equal(res.attempts.onchain?.reason, reason)
    }
  })

  it('a thin pool below the liquidity floor is rejected', async () => {
    const pool: OnchainPoolState = { kind: 'v2', poolAddress: '0xthin', token0: T, token1: USDC, reserve0: BigInt(1000) * BigInt(1e18), reserve1: BigInt(2500) * BigInt(1e6) }
    const r = createCurrentPriceResolver(deps({ pools: { [T]: [pool] } }))
    assert.equal((await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })).attempts.onchain?.reason, 'liquidity_below_minimum')
  })

  it('one-hop WETH route', async () => {
    // 1,000,000 T : 100 WETH → 0.0001 ETH = $0.30
    const pool: OnchainPoolState = { kind: 'v2', poolAddress: '0xtw', token0: T, token1: WETH, reserve0: BigInt(1e24), reserve1: BigInt(1e20) }
    const r = createCurrentPriceResolver(deps({ pools: { [T]: [pool] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    near(res.evidence.priceUsd, 0.3)
    assert.deepEqual(res.evidence.route, [T, WETH, 'USD'])
  })
})

describe('G bounded multihop', () => {
  // GeckoTerminal lists a T/B pool too thin to price, which supplies B as the intermediate.
  const gtThin: GeckoTerminalPool[] = [{ poolAddress: '0xgt', dexId: 'x', network: 'base', baseTokenAddress: T, quoteTokenAddress: B, basePriceUsd: 1, quotePriceUsd: 1, reserveUsd: 10, volume24hUsd: 0 }]
  const tb: OnchainPoolState = { kind: 'v2', poolAddress: '0xtb', token0: T, token1: B, reserve0: BigInt(1e24), reserve1: BigInt(5e23) } // 1 T = 0.5 B
  const bw: OnchainPoolState = { kind: 'v2', poolAddress: '0xbw', token0: B, token1: WETH, reserve0: BigInt(1e24), reserve1: BigInt(1e21) } // 1 B = 0.001 WETH = $3

  it('two-hop route T → B → WETH → USD (medium confidence)', async () => {
    const r = createCurrentPriceResolver(deps({ gtPools: gtThin, pools: { [T]: [tb], [B]: [bw] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.source, 'multihop')
    near(res.evidence.priceUsd, 1.5)
    assert.deepEqual(res.evidence.route, [T, B, WETH, 'USD'])
    assert.equal(res.evidence.confidence, 'medium')
  })

  it('a circular route is rejected', async () => {
    const bt: OnchainPoolState = { kind: 'v2', poolAddress: '0xbt', token0: T, token1: B, reserve0: BigInt(1e24), reserve1: BigInt(1e24) }
    const r = createCurrentPriceResolver(deps({ gtPools: gtThin, pools: { [T]: [tb], [B]: [bt] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.priceUsd, null)
    assert.equal(res.attempts.multihop?.reason, 'circular_route')
  })

  it('a route exceeding the hop cap (T → B → C → WETH) is rejected', async () => {
    const bc: OnchainPoolState = { kind: 'v2', poolAddress: '0xbc', token0: B, token1: C, reserve0: BigInt(1e24), reserve1: BigInt(1e24) }
    const r = createCurrentPriceResolver(deps({ gtPools: gtThin, pools: { [T]: [tb], [B]: [bc] } }))
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })
    assert.equal(res.evidence.priceUsd, null)
    assert.equal(res.attempts.multihop?.reason, 'route_exceeds_hop_cap')
  })

  it('fewer hops win, and the same input always picks the same route', async () => {
    const tw: OnchainPoolState = { kind: 'v2', poolAddress: '0xtw', token0: T, token1: WETH, reserve0: BigInt(1e24), reserve1: BigInt(1e21) }
    const run = async () => {
      __resetCurrentPriceCacheForTest()
      const r = createCurrentPriceResolver(deps({ gtPools: gtThin, pools: { [T]: [tb, tw], [B]: [bw] } }))
      return (await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T })).evidence
    }
    const a = await run()
    const b = await run()
    assert.equal(a.source, 'onchain_v2', 'the direct one-hop route beats the two-hop route')
    assert.deepEqual({ ...a, observedAt: 0 }, { ...b, observedAt: 0 })
  })

  it('no fabricated price when every source fails', async () => {
    const r = createCurrentPriceResolver(deps())
    const res = await r.resolveCurrentTokenPrice({ chainId: BASE, tokenAddress: T }, ALL)
    assert.equal(res.evidence.status, 'unavailable')
    assert.equal(res.evidence.priceUsd, null)
    assert.equal(res.evidence.confidence, null)
  })
})

describe('Wallet Scanner integration — cheap paths are free, expensive calls stay capped', () => {
  const silence = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const warn = console.warn
    console.warn = () => {}
    try { return await fn() } finally { console.warn = warn }
  }
  const tok = (i: number) => `0x${(0xabc000 + i).toString(16).padStart(40, '0')}`
  const holding = (tokenAddress: string, over: Record<string, unknown> = {}) => ({ chainId: BASE, tokenAddress, symbol: 'TKN', decimals: 18, quantity: '12.5', lastActivityAt: null, classification: 'other' as const, ...over })

  it('cache hits and canonical stablecoins spend zero expensive calls', async () => {
    for (let i = 0; i < 40; i += 1) recordCurrentPrice(BASE, tok(i), { priceUsd: 2, status: 'verified', source: 'dexscreener', route: [tok(i), 'USD'], poolAddress: null, liquidityUsd: 1e6, observedAt: Date.now(), confidence: 'high', reason: null })
    let calls = 0
    const out = await silence(() => priceHoldings([...Array.from({ length: 40 }, (_, i) => holding(tok(i))), holding(USDC, { decimals: 6, quantity: '100' })], async () => { calls += 1; return null }))
    assert.equal(calls, 0)
    assert.equal(out.fallbackAudit!.sourceCounts.cache, 40)
    assert.equal(out.fallbackAudit!.sourceCounts.canonical, 1)
    assert.equal(out.fallbackAudit!.expensive.callsUsed, 0)
    assert.equal(out.fallbackAudit!.avoidedExpensiveLookups, 41)
    assert.equal(out.priceStatus, 'ok')
  })

  it('DexScreener → GeckoTerminal → on-chain phases are each capped, in rank order', async () => {
    const seen = { ds: 0, gt: 0, oc: 0 }
    const holdings = Array.from({ length: 80 }, (_, i) => holding(tok(i)))
    const out = await silence(() => priceHoldings(holdings, async () => { seen.ds += 1; return null }, {
      allowExploratorySpamLookup: true,
      resolverDeps: {
        geckoterminal: async () => { seen.gt += 1; return { network: 'base', pools: [], reason: 'no_pool_found' } },
        onchain: { listPools: async () => { seen.oc += 1; return [] }, decimals: async () => 18 },
      },
    }))
    assert.equal(seen.ds, DEFAULT_EXPENSIVE_BUDGET.dexscreener)
    assert.equal(seen.gt, DEFAULT_EXPENSIVE_BUDGET.geckoterminal)
    assert.equal(seen.oc, DEFAULT_EXPENSIVE_BUDGET.onchain)
    const e = out.fallbackAudit!.expensive
    assert.deepEqual(e.remaining, { dexscreener: 0, geckoterminal: 0, onchain: 0 })
    assert.equal(out.fallbackAudit!.sourceCounts.unresolved, 80)
  })

  it('junk-flagged rows get one DexScreener look but never escalate to GeckoTerminal or on-chain', async () => {
    const seen = { gt: 0, oc: 0 }
    const junk = Array.from({ length: 20 }, (_, i) => holding(tok(i), { symbol: '?', amountRaw: '1000000000000000000', decimalsVerified: false }))
    await silence(() => priceHoldings(junk, async () => null, {
      resolverDeps: {
        geckoterminal: async () => { seen.gt += 1; return { network: 'base', pools: [], reason: 'no_pool_found' } },
        onchain: { listPools: async () => { seen.oc += 1; return [] }, decimals: async () => 18 },
      },
    }))
    assert.deepEqual(seen, { gt: 0, oc: 0 })
  })

  it('a token DexScreener misses is priced by GeckoTerminal, another by an on-chain pool — with debug evidence', async () => {
    const gtTok = tok(1)
    const ocTok = tok(2)
    const gtPool: GeckoTerminalPool = { poolAddress: '0xgtpool', dexId: 'aerodrome', network: 'base', baseTokenAddress: gtTok, quoteTokenAddress: WETH, basePriceUsd: 0.42, quotePriceUsd: 3000, reserveUsd: 120_000, volume24hUsd: 5_000 }
    const ocPool: OnchainPoolState = { kind: 'v2', poolAddress: '0xocpool', token0: WETH, token1: ocTok, reserve0: BigInt(1e20), reserve1: BigInt(1e24) }
    const out = await silence(() => priceHoldings([holding(gtTok, { providerValueUsd: 50 }), holding(ocTok, { providerValueUsd: 40 })], async () => null, {
      resolverDeps: {
        geckoterminal: async (_c, t) => ({ network: 'base', pools: t === gtTok ? [gtPool] : [], reason: null }),
        onchain: { listPools: async (_c, t) => (t === ocTok ? [ocPool] : []), decimals: async () => 18 },
        ethUsd: async () => ({ priceUsd: 3000, observedAt: Date.now(), source: 'test' }),
      },
    }))
    const rows = new Map(out.fallbackAudit!.rows.map((r) => [r.tokenAddress, r]))
    assert.equal(rows.get(gtTok)!.priceSource, 'geckoterminal')
    assert.equal(rows.get(gtTok)!.pricing!.dexscreener!.attempted, true)
    assert.equal(rows.get(gtTok)!.pricing!.poolAddress, '0xgtpool')
    assert.equal(rows.get(ocTok)!.priceSource, 'onchain_v2')
    near(rows.get(ocTok)!.priceUsd, 0.3)
    assert.deepEqual(rows.get(ocTok)!.pricing!.route, [ocTok, WETH, 'USD'])
    assert.equal(out.fallbackAudit!.sourceCounts.geckoterminal, 1)
    assert.equal(out.fallbackAudit!.sourceCounts.onchain, 1)
  })

  it('the same input gives the same route and result', async () => {
    const run = async () => {
      __resetCurrentPriceCacheForTest()
      const pools: OnchainPoolState[] = [
        { kind: 'v2', poolAddress: '0xa', token0: tok(3), token1: WETH, reserve0: BigInt(1e24), reserve1: BigInt(1e20) },
        { kind: 'v2', poolAddress: '0xb', token0: tok(3), token1: USDC, reserve0: BigInt(1e24), reserve1: BigInt(300_000) * BigInt(1e6) },
      ]
      const out = await silence(() => priceHoldings([holding(tok(3), { providerValueUsd: 9 })], async () => null, {
        resolverDeps: { onchain: { listPools: async () => pools, decimals: async (_c, t) => (t === USDC ? 6 : 18) }, ethUsd: async () => ({ priceUsd: 3000, observedAt: 0, source: 't' }) },
      }))
      const r = out.fallbackAudit!.rows[0]
      return { price: r.priceUsd, pool: r.pricing!.poolAddress, route: r.pricing!.route }
    }
    assert.deepEqual(await run(), await run())
  })
})

describe('portfolio semantics through the resolver', () => {
  it('all priced → verified; some → Partial; none → Value unavailable; verified empty → $0.00', async () => {
    const fmt = (v: number) => `$${v.toFixed(2)}`
    const all = evidenceFromHoldings({ holdingsComplete: true, values: [10, 20] })
    assert.equal(portfolioValueText(all, fmt), '$30.00')
    assert.equal(portfolioCoverageText(all), null, 'no coverage line on a fully verified total')
    const some = evidenceFromHoldings({ holdingsComplete: true, values: [10, null] })
    assert.equal(portfolioValueText(some, fmt), '$10.00 · Partial')
    assert.equal(portfolioCoverageText(some), '1/2 holdings priced')
    const none = evidenceFromHoldings({ holdingsComplete: true, values: [null, null] })
    assert.equal(portfolioValueText(none, fmt), 'Value unavailable')
    assert.equal(portfolioValueText(evidenceFromHoldings({ holdingsComplete: true, values: [] }), fmt), '$0.00')
  })
})

describe('on-chain pool reader (fake RPC client)', () => {
  // A fake multicall: answers by function name; `world` is the chain state.
  function fakeClient(world: { pairs: Record<string, string>; pools: Record<string, { token0: string; token1: string; reserves?: [bigint, bigint]; slot0?: bigint; liquidity?: bigint }>; v4: Record<string, bigint> }) {
    return {
      multicall: async ({ contracts }: { contracts: Array<{ address: string; functionName: string; args: unknown[] }> }) => contracts.map((c) => {
        const ok = (result: unknown) => ({ status: 'success', result })
        if (c.functionName === 'getPair') return ok(world.pairs[`v2:${(c.args as string[]).join(':')}`] ?? '0x0000000000000000000000000000000000000000')
        if (c.functionName === 'getPool') return ok(world.pairs[`v3:${(c.args as unknown[]).join(':')}`] ?? '0x0000000000000000000000000000000000000000')
        if (c.functionName === 'extsload') return ok(`0x${(world.v4[String(c.args[0])] ?? BigInt(0)).toString(16).padStart(64, '0')}`)
        const pool = world.pools[c.address.toLowerCase()]
        if (!pool) return { status: 'failure', error: new Error('no contract') }
        if (c.functionName === 'token0') return ok(pool.token0)
        if (c.functionName === 'token1') return ok(pool.token1)
        if (c.functionName === 'getReserves') return ok([...(pool.reserves ?? [BigInt(0), BigInt(0)]), 0])
        if (c.functionName === 'slot0') return ok([pool.slot0 ?? BigInt(0), 0, 0, 0, 0, 0, true])
        if (c.functionName === 'liquidity') return ok(pool.liquidity ?? BigInt(0))
        if (c.functionName === 'balanceOf') return ok(BigInt(0))
        return { status: 'failure', error: new Error('unknown') }
      }),
    }
  }

  it('reads a V2 pair and verifies its identity; a factory answer for the wrong pair is discarded', async () => {
    const good = '0x00000000000000000000000000000000000000aa'
    const wrong = '0x00000000000000000000000000000000000000bb'
    const client = fakeClient({
      pairs: { [`v2:${T}:${WETH}`]: good, [`v2:${T}:${USDC}`]: wrong },
      pools: {
        [good]: { token0: T, token1: WETH, reserves: [BigInt(1e24), BigInt(1e20)] },
        [wrong]: { token0: B, token1: USDC, reserves: [BigInt(1), BigInt(1)] }, // not T's pool
      },
      v4: {},
    })
    const src = createOnchainPoolSource(() => client as never, async () => 18)
    const pools = await src.listPools(BASE, T, [WETH, USDC])
    assert.equal(pools.length, 1)
    assert.equal(pools[0].poolAddress, good)
    assert.equal(pools[0].kind, 'v2')
  })

  it('finds a hookless V4 pool by its poolId and reads slot0 + liquidity from the PoolManager', async () => {
    const id = v4PoolId(T, V4_NATIVE_CURRENCY, 3000, 60)
    const stateSlot = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, BigInt(6)])))
    const slotHex = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`
    const sqrt = sqrtX96(1000)
    const client = fakeClient({ pairs: {}, pools: {}, v4: { [slotHex(stateSlot)]: sqrt, [slotHex(stateSlot + BigInt(3))]: BigInt(123456789) } })
    const src = createOnchainPoolSource(() => client as never, async () => 18)
    const pools = await src.listPools(BASE, T, [V4_NATIVE_CURRENCY])
    assert.equal(pools.length, 1)
    assert.deepEqual({ kind: pools[0].kind, poolAddress: pools[0].poolAddress, token0: pools[0].token0, token1: pools[0].token1, sqrt: pools[0].sqrtPriceX96, liq: pools[0].liquidity },
      { kind: 'v4', poolAddress: id, token0: V4_NATIVE_CURRENCY, token1: T, sqrt, liq: BigInt(123456789) })
  })

  it('no RPC configured → no pools, never a throw', async () => {
    const src = createOnchainPoolSource(() => null, async () => 18)
    assert.deepEqual(await src.listPools(BASE, T, [WETH]), [])
  })
})
