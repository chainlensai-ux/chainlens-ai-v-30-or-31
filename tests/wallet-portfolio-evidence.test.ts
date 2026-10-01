// Wallet Scanner $0 bug: holdings that exist but cannot be priced (or a holdings provider that did not answer)
// are UNKNOWN value — never $0.00. Explicit portfolio evidence (lib/walletScan/portfolioEvidence.ts), hardened
// Robinhood pricing (all DexScreener pairs, exact token identity, verified ETH/USD for native ETH), canonical
// merge rules, one display string for every surface, and cache that never freezes an unpriced holding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ev from '../lib/walletScan/portfolioEvidence.ts'
import * as rh from '../lib/server/robinhoodWalletScanner.ts'
import * as merged from '../app/frontend/lib/mergedWalletView.ts'
import * as readBuilder from '../app/frontend/lib/walletReadBuilder.ts'
import { fmtUsd } from '../app/frontend/lib/holdingsHeuristics.ts'
import { fetchAllHoldingsWithEvidence, __resetNegativeBalanceCacheForTest } from '../lib/engine/modules/holdings/fetchHoldings.ts'

// Robinhood Chain availability is read from the environment at CALL time (lib/server/robinhoodChainConfig.ts).
process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.ALCHEMY_ROBINHOOD_RPC_URL = 'https://robinhood.example/rpc'
process.env.GOLDRUSH_API_KEY = 'test-goldrush-key'

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const WALLET = '0x1111111111111111111111111111111111111111'
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NOW = 1_800_000_000_000

type Pair = Record<string, unknown>
// Robinhood RPC + GoldRush balances_v2 + DexScreener, routed by URL; records every call.
function mockProviders(o: { nativeHex?: string; balances?: unknown[] | null; dexPairs?: Record<string, Pair[]> }) {
  const calls: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url)
    if (url.startsWith('https://robinhood.example/rpc')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string }
      if (body.method === 'eth_getBalance') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: o.nativeHex ?? '0x0' }), { status: 200 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), { status: 200 })
    }
    if (url.includes('balances_v2')) {
      if (o.balances === null) return new Response('err', { status: 500 })
      return new Response(JSON.stringify({ data: { items: o.balances ?? [] } }), { status: 200 })
    }
    if (url.includes('api.dexscreener.com/latest/dex/tokens/')) {
      const addr = url.split('/').pop()!.toLowerCase()
      return new Response(JSON.stringify({ pairs: o.dexPairs?.[addr] ?? [] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as rh.FetchImpl
  return { fetchImpl, calls, ds: () => calls.filter((c) => c.includes('dexscreener')).length }
}
const tokenRow = (address: string, quoteRate: number | null, balance = '2000000000000000000') => ({ contract_address: address, contract_ticker_symbol: 'TKN', contract_name: 'Token', contract_decimals: 18, balance, quote_rate: quoteRate })
const dsPair = (chainId: string, base: string, quote: string, priceUsd: string | number, liq: number, vol = 0, pairAddress = `0xpair${liq}`) => ({ chainId, pairAddress, dexId: 'uniswap', baseToken: { address: base }, quoteToken: { address: quote }, priceUsd, liquidity: { usd: liq }, volume: { h24: vol } })
const noEth = async () => null
const deps = (fetchImpl: rh.FetchImpl, extra: Partial<rh.RobinhoodHoldingsDeps> = {}): rh.RobinhoodHoldingsDeps => ({ fetchImpl, ethUsdLatest: noEth, now: () => NOW, ...extra })
const resp = (holdings: rh.RobinhoodWalletHoldingsResult) => ({ ok: true, wallet: WALLET, chainSlug: 'robinhood' as const, chainId: 4663, holdings, activity: { status: 'ok', items: [], skippedSwapLogs: 0, verifiedSwapCount: 0, blockscoutEvidence: { blockscoutAttempted: false, blockscoutSucceeded: false, blockscoutFallbackUsed: false, blockscoutStatus: 'not_attempted', blockscoutError: null, blockscoutVerifiedSwap: false }, reason: null }, pnl: {} }) as never

test('production case: Robinhood holdings exist but none priced + Base/ETH no verified data => "Value unavailable", never $0.00', async () => {
  rh.resetRobinhoodPriceRetryState()
  const p = mockProviders({ nativeHex: '0x0', balances: [tokenRow(TOKEN, null)], dexPairs: {} })
  const h = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(p.fetchImpl))
  assert.equal(h.portfolioTotalUsd, null)
  assert.deepEqual([h.portfolioEvidence!.status, h.pricingSummary!.holdingsCount, h.pricingSummary!.pricedCount, h.pricingSummary!.unpricedCount], ['unavailable', 1, 0, 1])
  assert.equal(h.holdings[0].pricingDebug!.failureReason, 'dexscreener_no_pairs')
  // EVM lane: the holdings provider did not answer (old code: buildPortfolio([]) -> 0).
  const evm = ev.evidenceFromHoldings({ holdingsComplete: false, values: [] })
  assert.equal(evm.status, 'unavailable')
  const m = merged.computeMergedTotalValueUsd(0, resp(h), null, evm)
  assert.deepEqual([m.totalValueUsd, m.evidence!.status], [null, 'unavailable'])
  assert.equal(merged.mergedTotalText(m, fmtUsd), 'Value unavailable')
  // Even an EVM lane that is a verified zero cannot turn Robinhood's unknown into $0.00.
  const m2 = merged.computeMergedTotalValueUsd(0, resp(h), null, ev.evidenceFromHoldings({ holdingsComplete: true, values: [] }))
  assert.deepEqual([m2.totalValueUsd, merged.mergedTotalText(m2, fmtUsd)], [null, 'Value unavailable'])
  // Older reports with no EVM evidence: the legacy guard still refuses $0.00 when Robinhood proves unpriced holdings.
  const legacy = merged.computeMergedTotalValueUsd(0, resp(h))
  assert.deepEqual([legacy.totalValueUsd, merged.mergedTotalText(legacy, fmtUsd)], [null, 'Value unavailable'])
})

test('zero holdings with a verified complete scan => $0.00 (verified zero)', () => {
  const evm = ev.evidenceFromHoldings({ holdingsComplete: true, values: [] })
  const rhLane = ev.evidenceFromHoldings({ holdingsComplete: true, values: [] })
  const m = ev.mergePortfolioEvidence([evm, rhLane])
  assert.deepEqual([m.status, m.valueUsd, ev.portfolioDisplayValueUsd(m)], ['verified_zero', 0, 0])
  assert.equal(ev.portfolioValueText(m, fmtUsd), '$0.00')
  // Provider unavailable is never zero.
  assert.equal(ev.portfolioValueText(ev.evidenceFromHoldings({ holdingsComplete: false, values: [] }), fmtUsd), 'Value unavailable')
})

test('one priced + one unpriced => partial known subtotal, shown with "Partial"; merge rules', () => {
  const lane = ev.evidenceFromHoldings({ holdingsComplete: true, values: [125.5, null] })
  assert.deepEqual([lane.status, lane.valueUsd, lane.pricedSubtotalUsd, lane.pricedHoldings, lane.unpricedHoldings], ['partial', null, 125.5, 1, 1])
  assert.equal(ev.portfolioValueText(lane, fmtUsd), '$125.50 · Partial')
  const verified = ev.evidenceFromHoldings({ holdingsComplete: true, values: [100] })
  // verified + verified => sum; verified + partial => known subtotal, partial; unknown + unknown => unavailable.
  assert.deepEqual([ev.mergePortfolioEvidence([verified, ev.evidenceFromHoldings({ holdingsComplete: true, values: [20] })]).status, ev.mergePortfolioEvidence([verified, ev.evidenceFromHoldings({ holdingsComplete: true, values: [20] })]).valueUsd], ['verified', 120])
  const vp = ev.mergePortfolioEvidence([verified, lane])
  assert.deepEqual([vp.status, vp.pricedSubtotalUsd, vp.valueUsd], ['partial', 225.5, null])
  const unknown = ev.mergePortfolioEvidence([ev.evidenceFromHoldings({ holdingsComplete: false, values: [] }), ev.evidenceFromHoldings({ holdingsComplete: true, values: [null] })])
  assert.deepEqual([unknown.status, ev.portfolioDisplayValueUsd(unknown)], ['unavailable', null])
  // EVM: immaterial unpriced dust/spam stays excluded (verified); a potentially material one makes it partial.
  assert.equal(ev.evidenceFromHoldings({ holdingsComplete: true, values: [50, null, null], materialUnpriced: 0 }).status, 'verified')
  assert.equal(ev.evidenceFromHoldings({ holdingsComplete: true, values: [50, null, null], materialUnpriced: 1 }).status, 'partial')
})

test('GoldRush quote_rate prices the holding directly (no DexScreener call)', async () => {
  rh.resetRobinhoodPriceRetryState()
  const p = mockProviders({ balances: [tokenRow(TOKEN, 3)] })
  const h = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(p.fetchImpl))
  assert.deepEqual([h.holdings[0].priceUsd, h.holdings[0].priceSource, h.holdings[0].valueUsd, p.ds()], [3, 'goldrush', 6, 0])
  assert.equal(h.holdings[0].pricingDebug!.goldrushQuoteRate, 3)
  assert.deepEqual([h.portfolioEvidence!.status, h.portfolioTotalUsd, h.status], ['verified', 6, 'ok'])
})

test('GoldRush null + several DexScreener pairs: strongest VALID Robinhood pair for THIS token wins (not array order)', async () => {
  rh.resetRobinhoodPriceRetryState()
  const pairs = [
    dsPair('robinhood', TOKEN, OTHER, '0', 9_000_000, 0, '0xbadprice'), // first, highest liquidity — but non-positive price
    dsPair('base', TOKEN, OTHER, '99', 50_000_000, 0, '0xwrongchain'), // wrong chain
    dsPair('robinhood', OTHER, TOKEN, '42', 40_000_000, 0, '0xwrongtoken'), // TOKEN is the QUOTE: priceUsd is OTHER's price
    dsPair('robinhood', TOKEN, OTHER, 'abc', 30_000_000, 0, '0xmalformed'), // malformed price
    dsPair('robinhood', TOKEN, OTHER, '1.10', 200_000, 5_000, '0xsmall'),
    dsPair('robinhood', TOKEN.toUpperCase().replace('0X', '0x'), OTHER, '1.25', 800_000, 1_000, '0xbest'), // EVM address case-insensitive
  ]
  const p = mockProviders({ balances: [tokenRow(TOKEN, null)], dexPairs: { [TOKEN]: pairs } })
  const h = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(p.fetchImpl))
  const t = h.holdings[0]
  assert.deepEqual([t.priceUsd, t.priceSource, t.valueUsd], [1.25, 'dexscreener', 2.5])
  assert.deepEqual([t.pricingDebug!.dexscreenerPairsReturned, t.pricingDebug!.dexscreenerValidPairs, t.pricingDebug!.selectedPair!.pairAddress, t.pricingDebug!.selectedPair!.liquidityUsd], [6, 4, '0xbest', 800_000])
  // Pure selector: wrong-chain and wrong-token pairs alone => no price, never another token's.
  assert.equal(rh.selectRobinhoodDexscreenerPair([dsPair('base', TOKEN, OTHER, '5', 1e6)], TOKEN), null, 'wrong chain rejected')
  assert.equal(rh.selectRobinhoodDexscreenerPair([dsPair('robinhood', OTHER, TOKEN, '5', 1e6)], TOKEN), null, 'wrong token (quote side) rejected')
  // First pair bad, later pair valid => the valid price is used.
  assert.equal(rh.selectRobinhoodDexscreenerPair([dsPair('robinhood', TOKEN, OTHER, '-1', 1e9), dsPair('robinhood', TOKEN, OTHER, '0.5', 10)], TOKEN)!.priceUsd, 0.5)
  // Ties on liquidity broken by 24h volume.
  assert.equal(rh.selectRobinhoodDexscreenerPair([dsPair('robinhood', TOKEN, OTHER, '1', 100, 5, '0xa'), dsPair('robinhood', TOKEN, OTHER, '2', 100, 50, '0xb')], TOKEN)!.priceUsd, 2)
  assert.match(read('lib/server/robinhoodWalletScanner.ts'), /dexScreenerPairIsRequestedPricedToken\(p, contract, ROBINHOOD_CHAIN_SLUG\)/, 'same identity rule as Token Scanner / Clark')
})

test('native ETH: GoldRush rate first; else the existing verified ETH/USD series (fresh point only); never a symbol lookup', async () => {
  rh.resetRobinhoodPriceRetryState()
  const twoEth = '0x1bc16d674ec80000'
  const withRate = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(mockProviders({ nativeHex: twoEth, balances: [{ native_token: true, quote_rate: 3000 }] }).fetchImpl))
  assert.deepEqual([withRate.native!.priceSource, withRate.native!.valueUsd], ['goldrush', 6000])
  const p = mockProviders({ nativeHex: twoEth, balances: [] })
  const viaSeries = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(p.fetchImpl, { ethUsdLatest: async () => ({ priceUsd: 3100, atMs: NOW - 5 * 60_000 }) }))
  assert.deepEqual([viaSeries.native!.priceSource, viaSeries.native!.valueUsd, viaSeries.native!.pricingDebug!.ethUsdPoint!.ageSec], ['eth_usd_series', 6200, 300])
  assert.equal(p.ds(), 0, 'native ETH never queries DexScreener')
  assert.deepEqual([viaSeries.portfolioEvidence!.status, viaSeries.portfolioTotalUsd], ['verified', 6200])
  const stale = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(mockProviders({ nativeHex: twoEth, balances: [] }).fetchImpl, { ethUsdLatest: async () => ({ priceUsd: 3100, atMs: NOW - 2 * 3_600_000 }) }))
  assert.deepEqual([stale.native!.valueUsd, stale.native!.pricingDebug!.failureReason, stale.portfolioEvidence!.status], [null, 'eth_usd_point_stale', 'unavailable'])
  const src = read('lib/server/robinhoodWalletScanner.ts')
  assert.match(src, /const s = await fetchCoingeckoEthUsdRecent\(5_000\)/, 'default = the shared verified ETH/USD series')
  assert.doesNotMatch(src, /dexscreener\.com\/latest\/dex\/tokens\/WETH/)
})

test('canonical merge: hero / Portfolio Intelligence / CORTEX / watchlist / worker read the SAME evidence and agree', () => {
  const evm = ev.evidenceFromHoldings({ holdingsComplete: true, values: [1000] })
  const rhLane = ev.evidenceFromHoldings({ holdingsComplete: true, values: [250, null] })
  const holdings = { status: 'partial', wallet: WALLET, chainSlug: 'robinhood', chainId: 4663, native: null, holdings: [], portfolioTotalUsd: 250, unpricedTokenCount: 1, reason: 'some_holdings_unpriced', fromCache: false, portfolioEvidence: rhLane } as unknown as rh.RobinhoodWalletHoldingsResult
  const m = merged.computeMergedTotalValueUsd(1000, resp(holdings), null, evm)
  assert.deepEqual([m.evidence!.status, m.totalValueUsd, m.robinhoodIncluded, m.robinhoodValueUsd], ['partial', 1250, true, 250])
  // CORTEX key signal = the same string the hero/card render.
  const signals = readBuilder.buildKeySignals({ chainsScanned: ['base'], robinhoodIncluded: true, totalValueUsd: m.totalValueUsd, portfolioEvidence: m.evidence, topChain: null, pricedTokenCount: 2, lastActiveMs: null, buyCount: null, sellCount: null, rotationStyle: null })
  assert.equal(signals.find((s) => s.label === 'Portfolio value')!.value, merged.mergedTotalText(m, fmtUsd))
  assert.equal(merged.mergedTotalText(m, fmtUsd), '$1,250.00 · Partial')
  // Worker canonical total = the display value of the same merge.
  assert.equal(ev.portfolioDisplayValueUsd(ev.mergePortfolioEvidence([evm, rhLane])), m.totalValueUsd)
  // Wiring: every surface passes the EVM evidence; renders through the one text helper.
  const page = read('app/terminal/wallet-scanner/page.tsx')
  assert.equal((page.match(/computeMergedTotalValueUsd\(stats\.totalValueUsd, robinhood(Result)?, deriveCanonicalMergeOverride\(report\), deriveEvmPortfolioEvidence\(report\)\)/g) ?? []).length, 2, 'watchlist + CORTEX')
  assert.match(page, /portfolioEvidence: merged\.evidence,/)
  assert.match(read('app/frontend/components/WalletProfileHeader.tsx'), /\{mergedTotalText\(merged, fmtUsdFull\)\}/)
  assert.match(read('app/frontend/components/PortfolioIntelligenceCard.tsx'), /value=\{mergedTotalText\(merged, fmtUsd\)\}/)
  const worker = read('workers/walletScanV2.ts')
  assert.match(worker, /const canonicalTotalValueUsd = portfolioDisplayValueUsd\(canonicalPortfolioEvidence\)/)
  assert.doesNotMatch(worker, /\(evmTotalValueUsd \?\? 0\) \+ \(robinhoodTotalValueUsd \?\? 0\)/, 'no unknown-as-zero sum')
  assert.match(worker, /evmPortfolioEvidence,/)
  // A timed-out fast snapshot does not discard the core pipeline's real V1 total: it stays a partial known subtotal.
  assert.match(worker, /evmPortfolioEvidence\.status === 'unavailable' && snapshotTimedOutEmpty && evmTotalFromV1 != null && evmTotalFromV1 > 0/)
  assert.match(worker, /const canonicalPortfolioEvidence = mergePortfolioEvidence\(\[evmLaneEvidence, robinhoodLaneEvidence\]\)/)
})

test('cache: a cached UNPRICED holding is re-priced when evidence appears (bounded retry), not frozen for the cache TTL', async () => {
  rh.resetRobinhoodPriceRetryState()
  const first = mockProviders({ balances: [tokenRow(TOKEN, null)], dexPairs: {} })
  const cached = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(first.fetchImpl))
  assert.equal(cached.portfolioEvidence!.status, 'unavailable')
  const cachedEntry = { ...cached, chainSlug: 'robinhood' as const, wallet: WALLET }
  // Price evidence now exists: the cache hit re-prices (no balances re-read) and the value appears.
  const later = mockProviders({ dexPairs: { [TOKEN]: [dsPair('robinhood', TOKEN, OTHER, '2', 500_000)] } })
  const repriced = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(later.fetchImpl, { cached: cachedEntry }))
  assert.deepEqual([repriced.fromCache, repriced.holdings[0].priceUsd, repriced.portfolioTotalUsd, repriced.portfolioEvidence!.status, repriced.pricingSummary!.repricedFromCache], [true, 2, 4, 'verified', true])
  assert.equal(later.calls.filter((c) => c.includes('balances_v2')).length, 0, 'holdings discovery stays cached')
  // Still no evidence: one bounded retry, then the miss is remembered for a short window (no hammering).
  rh.resetRobinhoodPriceRetryState()
  const none = mockProviders({ dexPairs: {} })
  await rh.resolveRobinhoodWalletHoldings(WALLET, deps(none.fetchImpl, { cached: cachedEntry }))
  await rh.resolveRobinhoodWalletHoldings(WALLET, deps(none.fetchImpl, { cached: cachedEntry }))
  assert.equal(none.ds(), 1, 'second request inside the retry window makes no new price call')
  const afterWindow = await rh.resolveRobinhoodWalletHoldings(WALLET, deps(none.fetchImpl, { cached: cachedEntry, now: () => NOW + 20_000 }))
  assert.equal(none.ds(), 2, 'after the window it is attempted again')
  assert.equal(afterWindow.portfolioEvidence!.status, 'unavailable')
  assert.match(read('lib/server/robinhoodWalletScanner.ts'), /if \(!result\.fromCache \|\| result\.pricingSummary\?\.repricedFromCache\) await setTokenCache\(key/, 'repriced result is written back')
})

test('EVM holdings: a provider failure is never cached or reported as a confirmed-empty wallet', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('fail', { status: 500 })) as typeof fetch
  try {
    __resetNegativeBalanceCacheForTest()
    const a = await fetchAllHoldingsWithEvidence('0x2222222222222222222222222222222222222222', [8453])
    assert.deepEqual([a.holdings.length, a.complete, a.chains[0].providerStatus], [0, false, 'provider_unavailable'])
    const b = await fetchAllHoldingsWithEvidence('0x2222222222222222222222222222222222222222', [8453])
    assert.notEqual(b.chains[0].providerStatus, 'confirmed_empty_cached', 'the failure was not negative-cached as empty')
    assert.equal(ev.evidenceFromHoldings({ holdingsComplete: a.complete, values: [] }).status, 'unavailable')
  } finally {
    globalThis.fetch = realFetch
  }
})
