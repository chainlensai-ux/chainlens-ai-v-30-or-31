// Robinhood Radar: cards were "Unverified" because (1) the holder count only came from GoldRush and (2) no
// buy/sell check ever ran for Robinhood; the feed was thin because a V4 pool was dropped whenever its token
// had more than one DexScreener pair, even when DexScreener reported the exact same PoolId.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseBlockscoutHolderCount, fetchRadarHolderCount, robinhoodPoolTypeFromDexId, robinhoodSimToRadarHoneypot, robinhoodRadarHoneypot,
} from '../lib/server/robinhoodRadarEvidence'
import { getRadarSimulationDisplay } from '../lib/baseRadarSimulation'
import { selectDexScreenerMarketCapRescuePair } from '../lib/baseRadarValuation'
import { buildRadarFeedDisplayModel, getRadarMomentum, resolveRadarCardStatus } from '../lib/baseRadarFeedStatus'
import type { HolderCountResult } from '../lib/server/goldrushHolderCount'

const TOKEN = '0x1111111111111111111111111111111111111111'
const POOL = '0x2222222222222222222222222222222222222222'
const V4_ID = `0x${'ab'.repeat(32)}`

test('Blockscout holder count parsing: string or number, never negative / fractional / missing', () => {
  assert.equal(parseBlockscoutHolderCount({ holders_count: '1234' }), 1234)
  assert.equal(parseBlockscoutHolderCount({ holders: 57 }), 57)
  assert.equal(parseBlockscoutHolderCount({ holders_count: '0' }), 0)
  for (const bad of [null, {}, { holders_count: '' }, { holders_count: '-3' }, { holders_count: '1.5' }, { holders_count: 'n/a' }]) {
    assert.equal(parseBlockscoutHolderCount(bad as never), null)
  }
})

test('Robinhood holder count: Blockscout first (exact, uncapped); GoldRush only when Blockscout has no answer; Base unchanged', async () => {
  const goldrushCalls: string[] = []
  const goldrush = async (c: string, chain: 'base' | 'robinhood'): Promise<HolderCountResult> => { goldrushCalls.push(`${chain}:${c}`); return { count: 100, reason: 'ok', chainPathUsed: 'robinhood-mainnet', isCapped: true } }

  const hit = await fetchRadarHolderCount(TOKEN, 'robinhood', { blockscout: async () => ({ data: { holders_count: '412' } }), goldrush })
  assert.deepEqual([hit.count, hit.reason, hit.chainPathUsed, hit.isCapped, goldrushCalls.length], [412, 'ok', 'blockscout', false, 0])

  const miss = await fetchRadarHolderCount(TOKEN, 'robinhood', { blockscout: async () => ({ data: null }), goldrush })
  assert.deepEqual([miss.count, miss.chainPathUsed, goldrushCalls.length], [100, 'robinhood-mainnet', 1])

  const thrown = await fetchRadarHolderCount(TOKEN, 'robinhood', { blockscout: async () => { throw new Error('down') }, goldrush })
  assert.equal(thrown.count, 100)

  let blockscoutCalled = false
  await fetchRadarHolderCount(TOKEN, 'base', { blockscout: async () => { blockscoutCalled = true; return { data: { holders_count: 9 } } }, goldrush })
  assert.equal(blockscoutCalled, false, 'Base never asks the Robinhood explorer')
})

test('pool type from GeckoTerminal dex id', () => {
  assert.equal(robinhoodPoolTypeFromDexId('uniswap-v4-robinhood'), 'v4')
  assert.equal(robinhoodPoolTypeFromDexId('uniswap-v3-robinhood'), 'v3')
  assert.equal(robinhoodPoolTypeFromDexId('uniswap-v2-robinhood'), 'v2')
  assert.equal(robinhoodPoolTypeFromDexId('some-dex'), null)
  assert.equal(robinhoodPoolTypeFromDexId(null), null)
})

test('simulation mapping: sellable passes with real taxes; blocked is a honeypot; unsupported/timeout/unavailable stay open checks', () => {
  const sellable = robinhoodSimToRadarHoneypot({ honeypotStatus: 'sellable', buyTaxPct: 1.2, sellTaxPct: 3.4 })
  const shown = getRadarSimulationDisplay({ contract: TOKEN, liquidityUsd: 50_000, pairAddress: POOL, honeypot: sellable })
  assert.deepEqual([shown.status, shown.buyTax, shown.sellTax, shown.isHoneypot], ['passed', 1.2, 3.4, false])

  const blocked = robinhoodSimToRadarHoneypot({ honeypotStatus: 'blocked', buyTaxPct: 0, sellTaxPct: null })
  assert.deepEqual([blocked.isHoneypot, blocked.simulationSuccess], [true, true])

  const reasons = (['unsupported', 'timeout', 'unavailable'] as const).map((s) => {
    const hp = robinhoodSimToRadarHoneypot({ honeypotStatus: s, buyTaxPct: null, sellTaxPct: null })
    const d = getRadarSimulationDisplay({ contract: TOKEN, liquidityUsd: 50_000, pairAddress: POOL, honeypot: hp })
    assert.equal(d.status, 'open_check')
    return d.reason
  })
  assert.deepEqual(reasons, ['unsupported_pool_model', 'timeout_after_retry', 'provider_unavailable'])
})

test('radar sell check: V4 never simulated; V2/V3 simulate the exact pool; a throwing simulator is an open check', async () => {
  const calls: Array<{ poolAddress: string | null; poolType?: string | null; tokenAddress: string }> = []
  const simulate = (async (input: { poolAddress: string | null; poolType?: string | null; tokenAddress: string }) => {
    calls.push(input)
    return { result: { honeypotStatus: 'sellable', buyTaxPct: 0, sellTaxPct: 0 }, audit: {} }
  }) as never

  const v4 = await robinhoodRadarHoneypot({ contract: TOKEN, poolAddress: V4_ID, dexId: 'uniswap-v4-robinhood' }, simulate)
  assert.deepEqual([v4.failureReason, calls.length], ['unsupported_pool_model', 0])

  const v2 = await robinhoodRadarHoneypot({ contract: TOKEN, poolAddress: POOL, dexId: 'uniswap-v2-robinhood' }, simulate)
  assert.deepEqual([v2.simulationSuccess, v2.isHoneypot], [true, false])
  assert.deepEqual([calls[0].poolAddress, calls[0].poolType, calls[0].tokenAddress], [POOL, 'v2', TOKEN])

  const broken = await robinhoodRadarHoneypot({ contract: TOKEN, poolAddress: POOL, dexId: null }, (async () => { throw new Error('rpc') }) as never)
  assert.equal(broken.failureReason, 'provider_unavailable')
})

test('card status: holder-verified + passed Robinhood sell check is no longer capped at UNVERIFIED', () => {
  const base = { liquidityUsd: 180_000, volume24h: 140_000, ageMinutes: 300 }
  const hp = robinhoodSimToRadarHoneypot({ honeypotStatus: 'sellable', buyTaxPct: 0, sellTaxPct: 0 })
  const sim = getRadarSimulationDisplay({ contract: TOKEN, liquidityUsd: base.liquidityUsd, pairAddress: POOL, honeypot: hp })
  const verified = { ...base, holderVerified: true, simulationStatus: sim.status, honeypot: hp }
  const status = resolveRadarCardStatus(verified, buildRadarFeedDisplayModel(verified), getRadarMomentum(base.volume24h, base.liquidityUsd).level)
  assert.notEqual(status, 'UNVERIFIED')

  const holderMissing = { ...verified, holderVerified: false }
  assert.equal(resolveRadarCardStatus(holderMissing, buildRadarFeedDisplayModel(holderMissing), 'HIGH'), 'UNVERIFIED', 'missing holder evidence still caps')
})

test('V4 pool identity: DexScreener reporting the same PoolId selects this pool even among several live pairs', () => {
  const pairs = [
    { chainId: 'robinhood', pairAddress: `0x${'cd'.repeat(32)}`, liquidity: { usd: 900_000 }, marketCap: 5_000_000, quoteToken: { address: '0xq' } },
    { chainId: 'robinhood', pairAddress: V4_ID.toUpperCase().replace('0X', '0x'), liquidity: { usd: 120_000 }, marketCap: 4_900_000, quoteToken: { address: '0xq' } },
  ]
  const r = selectDexScreenerMarketCapRescuePair({ pairs, chain: 'robinhood', primaryPoolAddress: V4_ID, primaryQuoteTokenAddress: '0xq' })
  assert.equal(r.sortedPairCount, 2)
  assert.equal(r.selectedPairAddress?.toLowerCase(), V4_ID)
  assert.equal(r.selectedLiquidityUsd, 120_000, 'this pool’s own liquidity, never the larger pair’s')

  const src = readFileSync(new URL('../app/api/radar/route.ts', import.meta.url), 'utf8')
  assert.match(src, /rescue\?\.sortedPairCount === 1 \|\| v4ExactPoolIdMatch/)
  assert.match(src, /\/\^0x\[0-9a-fA-F\]\{64\}\$\/\.test\(primaryPoolAddress\)/)
})

test('route wiring: Robinhood holder counts, feed sell check on the exact pool, drawer reuses the same pool', () => {
  const route = readFileSync(new URL('../app/api/radar/route.ts', import.meta.url), 'utf8')
  assert.match(route, /const fetchBaseHolderCount = fetchRadarHolderCount/)
  assert.match(route, /if \(chain === 'robinhood'\) return robinhoodRadarHoneypot\(/)
  assert.match(route, /getCachedHoneypot\(t\.contract, requestedChain, false, \{ address: t\.pairAddress \?\? null, dexId: t\.poolDexId \?\? null \}\)/)
  const sim = readFileSync(new URL('../app/api/radar/simulation/route.ts', import.meta.url), 'utf8')
  assert.match(sim, /chain\.toLowerCase\(\) === 'robinhood'[\s\S]{0,200}robinhoodRadarHoneypot\(/)
  const drawer = readFileSync(new URL('../app/terminal/base-radar/ProjectOverviewDrawer.tsx', import.meta.url), 'utf8')
  assert.match(drawer, /poolAddress=\$\{encodeURIComponent\(rhPool\.poolAddress\)\}/)
})
