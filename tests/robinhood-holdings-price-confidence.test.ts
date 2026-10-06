// Robinhood holdings: the portfolio price-confidence gate. Deceptive / thin-market ERC-20 prices must not inflate
// the supported value; rejected prices become UNPRICED (never $0); raw rows are kept; no address special-cases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRobinhoodWalletHoldings, applyRobinhoodPortfolioPriceConfidence, isRobinhoodNativeSymbolImpersonation,
  ROBINHOOD_PRICE_CONFIDENCE, resetRobinhoodPriceRetryState, type FetchImpl, type RobinhoodTokenHolding, type RobinhoodWalletHoldingsResult,
} from '../lib/server/robinhoodWalletScanner.ts'
import type { BlockscoutAddressTokenBalance } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { CHAIN_ASSET_REGISTRY } from '../lib/server/chainAssetRegistry.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.ALCHEMY_ROBINHOOD_RPC_URL = 'https://robinhood.example/rpc'
process.env.GOLDRUSH_API_KEY = 'test-goldrush'

const WALLET = '0x69d43a4398c6c9e5952e25bca046d9a451e95eee'
const PLAGUE = '0x077e4a54885a3f2da5a743a753df3191c43b9401'
const FAKE_ETH = '0x02865c612393ceb2482fdc08fb30fce113305d12'
const ROO = '0x1000000000000000000000000000000000000001'
const SWAPPY = '0x1000000000000000000000000000000000000002'
const GOOD = '0x1000000000000000000000000000000000000003'
const WETH = CHAIN_ASSET_REGISTRY.robinhood.wrappedNative!.address.toLowerCase()
const E18 = BigInt(10) ** BigInt(18)
const raw = (units: number) => (BigInt(Math.round(units * 1e6)) * E18 / BigInt(1e6)).toString()
const bs = (address: string, units: number, symbol: string, name: string, extra: Record<string, unknown> = {}): BlockscoutAddressTokenBalance =>
  ({ value: raw(units), token: { address_hash: address, decimals: '18', symbol, name, type: 'ERC-20', ...extra } as BlockscoutAddressTokenBalance['token'] })
const pair = (address: string, price: number, liquidity: number, volume = 5_000) => ({
  chainId: 'robinhood', pairAddress: `0x${'9'.repeat(40)}`, dexId: 'uniswap', baseToken: { address }, quoteToken: { address: WETH },
  priceUsd: String(price), liquidity: { usd: liquidity }, volume: { h24: volume },
})

function providers(goldrush: unknown[], pairs: Record<string, unknown[]>) {
  const fetchImpl: FetchImpl = async (url) => {
    if (url === 'https://robinhood.example/rpc') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + (BigInt(5) * E18 / BigInt(10)).toString(16) })) // 0.5 ETH
    if (url.includes('/balances_v2/')) return new Response(JSON.stringify({ data: { items: goldrush } }))
    if (url.includes('api.dexscreener.com/latest/dex/tokens/')) return new Response(JSON.stringify({ pairs: pairs[url.split('/').pop()!.toLowerCase()] ?? [] }))
    return new Response('missing', { status: 404 })
  }
  return fetchImpl
}

// Production 0x69d43… shape (DexScreener-priced, liquidity above the old $10k floor but thin for the position).
const productionBalances = (): BlockscoutAddressTokenBalance[] => [
  bs(PLAGUE, 102, 'PLAGUE', 'Plague'),
  bs(FAKE_ETH, 51, 'ETH', 'Ethereum'),
  bs(ROO, 12_000, 'ROO', 'Roo'),
  bs(SWAPPY, 40_000, 'SWAPPY', 'Swappy'),
  bs(GOOD, 3_000, 'GOOD', 'Good'),
]
const productionPairs = (plagueLiquidity = 22_000): Record<string, unknown[]> => ({
  [PLAGUE]: [pair(PLAGUE, 2713.32, plagueLiquidity)],
  [FAKE_ETH]: [pair(FAKE_ETH, 2699.76, 31_000)],
  [ROO]: [pair(ROO, 0.12, 180_000)],
  [SWAPPY]: [pair(SWAPPY, 0.025, 60_000)],
  [GOOD]: [pair(GOOD, 0.4, 45_000)],
})

async function scan(balances = productionBalances(), pairs = productionPairs(), goldrush: unknown[] = [{ native_token: true, quote_rate: 2700 }]) {
  const lines: any[] = []
  const w = console.warn
  console.warn = (tag: unknown, body: unknown) => { if (tag === '[robinhood-holdings-price-confidence-audit]') lines.push(body) }
  try {
    const r = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl: providers(goldrush, pairs), blockscoutBalances: async () => balances, ethUsdLatest: async () => null })
    return { r, rows: lines.filter((l) => !l.summary), summary: lines.find((l) => l.summary)?.summary }
  } finally { console.warn = w }
}
const by = (r: RobinhoodWalletHoldingsResult, a: string) => r.holdings.find((h) => h.address === a)!

test('production 0x69d43…: PLAGUE and the ERC-20 "ETH" no longer inflate supported value; ROO / SWAPPY / GOOD stay priced', async () => {
  const { r, rows, summary } = await scan()
  const plague = by(r, PLAGUE)
  assert.deepEqual([plague.priceUsd, plague.valueUsd, plague.priceSource, plague.excludedFromValueReason], [null, null, null, 'insufficient_portfolio_price_confidence'])
  assert.equal(plague.rawBalance, raw(102)) // raw row kept
  assert.equal(plague.pricingDebug?.candidatePriceUsd, 2713.32)
  assert.ok(Math.abs(plague.pricingDebug!.candidateValueUsd! - 276_758.64) < 0.01)
  const fake = by(r, FAKE_ETH)
  assert.deepEqual([fake.priceUsd, fake.valueUsd, fake.excludedFromValueReason], [null, null, 'native_symbol_impersonation'])
  assert.equal(fake.rawBalance, raw(51))
  for (const [a, v] of [[ROO, 1_440], [SWAPPY, 1_000], [GOOD, 1_200]] as const) {
    const h = by(r, a)
    assert.equal(h.priceSource, 'dexscreener')
    assert.ok(Math.abs(h.valueUsd! - v) < 1e-6, `${h.symbol} ${h.valueUsd}`)
    assert.equal(h.excludedFromValueReason, null)
  }
  // Native ETH lane is untouched: 0.5 ETH at the GoldRush native quote.
  assert.equal(r.native?.valueUsd, 1_350)
  assert.ok(Math.abs(r.holdingsIntegrationAudit!.supportedValueUsd! - 3_640) < 1e-6)
  assert.ok(Math.abs(r.portfolioTotalUsd! - (3_640 + 1_350)) < 1e-6)
  assert.equal(r.portfolioEvidence?.status, 'partial') // rejected = unpriced, never $0
  assert.equal(r.unpricedTokenCount, 2)
  // Audit rows + summary
  const a = rows.find((x) => x.tokenAddress === PLAGUE)
  assert.deepEqual([a.priceSource, a.liquidityUsd, a.independentPriceConfirmed, a.portfolioPriceConfidence, a.includedInSupportedValue, a.rejectionReason, a.nearNativeEthPrice, a.disproportionateWalletValue],
    ['dexscreener', 22_000, false, 'rejected', false, 'insufficient_portfolio_price_confidence', true, true])
  const e = rows.find((x) => x.tokenAddress === FAKE_ETH)
  assert.deepEqual([e.nativeSymbolImpersonation, e.rejectionReason, e.includedInSupportedValue], [true, 'native_symbol_impersonation', false])
  assert.ok(Math.abs(summary.candidateSupportedValueUsd - (276_758.64 + 137_687.76 + 3_640)) < 0.01)
  assert.ok(Math.abs(summary.acceptedSupportedValueUsd - 3_640) < 1e-6)
  assert.ok(Math.abs(summary.rejectedValueUsd - (276_758.64 + 137_687.76)) < 0.01)
  assert.deepEqual([summary.highValueFallbackCount, summary.highValueFallbackRejectedCount, summary.nativeImpersonatorCount], [1, 1, 1])
  assert.deepEqual(r.holdingsIntegrationAudit?.priceConfidence, summary)
})

test('the gate is evidence-based, not address-based: genuinely deep liquidity lets the same high-value position count', async () => {
  const need = Math.max(ROBINHOOD_PRICE_CONFIDENCE.minLiquidityUsd, 276_758.64 * ROBINHOOD_PRICE_CONFIDENCE.minLiquidityToPosition)
  const { r } = await scan(productionBalances(), productionPairs(Math.ceil(need)))
  const plague = by(r, PLAGUE)
  assert.equal(plague.priceUsd, 2713.32) // never lowered or clamped
  assert.ok(Math.abs(plague.valueUsd! - 276_758.64) < 0.01)
  const below = await scan(productionBalances(), productionPairs(Math.floor(need) - 1))
  assert.equal(by(below.r, PLAGUE).valueUsd, null)
})

test('independent confirmation of the exact contract price also satisfies the high-value gate', () => {
  const h: RobinhoodTokenHolding = { address: PLAGUE, symbol: 'PLAGUE', name: 'Plague', decimals: 18, rawBalance: raw(102), uiBalance: 102, priceUsd: 2713.32, priceSource: 'dexscreener', valueUsd: 276_758.64,
    pricingDebug: { goldrushQuoteRate: null, dexscreenerPairsReturned: 1, dexscreenerValidPairs: 1, selectedPair: { pairAddress: null, dexId: null, liquidityUsd: 22_000, volume24hUsd: 1, priceUsd: 2713.32 }, resolvedPriceUsd: 2713.32, priceSource: 'dexscreener', failureReason: null } }
  assert.equal(applyRobinhoodPortfolioPriceConfidence([h], { independentPriceUsd: () => 2700 }).holdings[0].valueUsd, 276_758.64)
  assert.equal(applyRobinhoodPortfolioPriceConfidence([h], { independentPriceUsd: () => 1000 }).holdings[0].valueUsd, null) // disagreeing source is no confirmation
  assert.equal(applyRobinhoodPortfolioPriceConfidence([h]).holdings[0].excludedFromValueReason, 'insufficient_portfolio_price_confidence')
})

test('native-symbol impersonation: any ETH / Ethereum / WETH / Wrapped Ether ERC-20 except the verified canonical WETH', async () => {
  for (const [symbol, name] of [['ETH', 'Token'], ['weth', 'x'], ['X', 'Ethereum'], ['WETH', 'Wrapped Ether'], ['Y', 'Wrapped Ether']]) {
    assert.equal(isRobinhoodNativeSymbolImpersonation({ address: FAKE_ETH, symbol, name }), true, `${symbol}/${name}`)
  }
  assert.equal(isRobinhoodNativeSymbolImpersonation({ address: WETH, symbol: 'WETH', name: 'Wrapped Ether' }), false)
  assert.equal(isRobinhoodNativeSymbolImpersonation({ address: ROO, symbol: 'ETHX', name: 'Roo ETH Index' }), false)
  // Even a provider quote cannot make an impersonator count; a small impersonator is excluded too.
  const { r } = await scan([bs(FAKE_ETH, 0.01, 'ETH', 'Ethereum')], {}, [{ native_token: true, quote_rate: 2700 },
    { contract_address: FAKE_ETH, balance: raw(0.01), contract_decimals: 18, quote_rate: 2699, contract_ticker_symbol: 'ETH', contract_name: 'Ethereum' }])
  assert.equal(by(r, FAKE_ETH).excludedFromValueReason, 'native_symbol_impersonation')
  assert.equal(by(r, FAKE_ETH).valueUsd, null)
  // The canonical wrapped native keeps normal pricing.
  const weth = await scan([bs(WETH, 2, 'WETH', 'Wrapped Ether')], { [WETH]: [pair(WETH, 2700, 2_000_000)] })
  assert.equal(by(weth.r, WETH).valueUsd, 5_400)
})

test('a high unit price alone is not rejected (only flagged); GoldRush-quoted high values are not gated', async () => {
  const PRICY = '0x1000000000000000000000000000000000000004'
  const { r, rows } = await scan([bs(PRICY, 0.5, 'PRICY', 'Pricy')], { [PRICY]: [pair(PRICY, 2650, 30_000)] })
  assert.equal(by(r, PRICY).valueUsd, 1_325)
  assert.equal(rows[0].nearNativeEthPrice, true)
  assert.equal(rows[0].includedInSupportedValue, true)
  const BIG = '0x1000000000000000000000000000000000000005'
  const gr = await scan([], {}, [{ native_token: true, quote_rate: 2700 }, { contract_address: BIG, balance: raw(100), contract_decimals: 18, quote_rate: 500, contract_ticker_symbol: 'BIG', contract_name: 'Big' }])
  assert.equal(by(gr.r, BIG).valueUsd, 50_000)
  assert.equal(gr.rows[0].portfolioPriceConfidence, 'verified_provider_quote')
})

test('provider spam evidence from either balance provider excludes the exact contract (before pricing)', async () => {
  const scamBs = await scan([bs(ROO, 12_000, 'ROO', 'Roo', { reputation: 'scam' })], productionPairs())
  assert.equal(by(scamBs.r, ROO).excludedFromValueReason, 'provider_spam_flag')
  assert.equal(by(scamBs.r, ROO).valueUsd, null)
  const spamGr = await scan([bs(GOOD, 3_000, 'GOOD', 'Good')], productionPairs(), [{ native_token: true, quote_rate: 2700 },
    { contract_address: GOOD, balance: raw(3_000), contract_decimals: 18, quote_rate: null, is_spam: true, contract_ticker_symbol: 'GOOD' }])
  assert.equal(by(spamGr.r, GOOD).excludedFromValueReason, 'provider_spam_flag')
  // symbol alone is never spam evidence (other than native impersonation)
  const ok = await scan([bs(SWAPPY, 40_000, 'FREE-AIRDROP', 'Claim now')], productionPairs())
  assert.equal(by(ok.r, SWAPPY).valueUsd, 1_000)
})

test('a cached result priced before the gate existed is corrected on the cache path', async () => {
  const fresh = await scan()
  const stale: RobinhoodWalletHoldingsResult = {
    ...fresh.r,
    holdings: fresh.r.holdings.map((h) => h.address === PLAGUE
      ? { ...h, priceUsd: 2713.32, priceSource: 'dexscreener', valueUsd: 276_758.64, excludedFromValueReason: null, pricingDebug: { ...h.pricingDebug!, resolvedPriceUsd: 2713.32, priceSource: 'dexscreener', failureReason: null, candidatePriceUsd: undefined, candidateValueUsd: undefined } }
      : h),
  }
  const w = console.warn
  console.warn = () => {}
  try {
    const r = await resolveRobinhoodWalletHoldings(WALLET, { fetchImpl: providers([], productionPairs()), cached: stale as never, ethUsdLatest: async () => null })
    assert.equal(by(r, PLAGUE).valueUsd, null)
    assert.equal(by(r, PLAGUE).excludedFromValueReason, 'insufficient_portfolio_price_confidence')
    assert.ok(Math.abs(r.holdingsIntegrationAudit!.supportedValueUsd! - 3_640) < 1e-6)
    assert.equal(r.fromCache, true)
  } finally { console.warn = w }
})

// ── Cache policy: the confidence rejection is a re-evaluable market condition; other exclusions are permanent ──
test('cache: a confidence rejection is re-evaluated after PRICE_RETRY_MS (and not before); spam / impersonation stay rejected', async () => {
  resetRobinhoodPriceRetryState()
  const BIG = '0x1000000000000000000000000000000000000006'
  const SPAM = '0x1000000000000000000000000000000000000007'
  const market = { liquidity: 20_000 }
  const dsCalls: string[] = []
  const fetchImpl: FetchImpl = async (url) => {
    if (url === 'https://robinhood.example/rpc') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0' }))
    if (url.includes('/balances_v2/')) return new Response(JSON.stringify({ data: { items: [{ native_token: true, quote_rate: 2700 }, { contract_address: SPAM, balance: raw(10), contract_decimals: 18, is_spam: true, contract_ticker_symbol: 'SPAM' }] } }))
    if (url.includes('api.dexscreener.com/latest/dex/tokens/')) {
      const a = url.split('/').pop()!.toLowerCase()
      dsCalls.push(a)
      const price: Record<string, number> = { [BIG]: 100, [FAKE_ETH]: 2700, [SPAM]: 50_000 }
      return new Response(JSON.stringify({ pairs: price[a] ? [pair(a, price[a], a === BIG ? market.liquidity : 5_000_000)] : [] }))
    }
    return new Response('missing', { status: 404 })
  }
  let clock = 1_000_000
  const deps = { fetchImpl, now: () => clock, ethUsdLatest: async () => null }
  const quiet = async <T>(fn: () => Promise<T>) => { const w = console.warn; console.warn = () => {}; try { return await fn() } finally { console.warn = w } }
  const balances = [bs(BIG, 1_000, 'BIG', 'Big'), bs(FAKE_ETH, 51, 'ETH', 'Ethereum'), bs(SPAM, 10, 'SPAM', 'Spam')]
  // 1. first scan: $100k position, liquidity $20k → rejected
  let r = await quiet(() => resolveRobinhoodWalletHoldings(WALLET, { ...deps, blockscoutBalances: async () => balances }))
  assert.equal(by(r, BIG).excludedFromValueReason, 'insufficient_portfolio_price_confidence')
  assert.equal(by(r, BIG).valueUsd, null)
  // cached repricing while the market is unchanged: re-queried once (due), rejected again, miss recorded
  clock += 1_000
  dsCalls.length = 0
  r = await quiet(() => resolveRobinhoodWalletHoldings(WALLET, { ...deps, cached: r as never }))
  assert.deepEqual(dsCalls, [BIG]) // spam and impersonation rows are never re-priced
  assert.equal(by(r, BIG).excludedFromValueReason, 'insufficient_portfolio_price_confidence')
  // 3. cached scan before the retry interval → no extra provider call, even if the market changed
  market.liquidity = 60_000
  clock += 5_000
  dsCalls.length = 0
  r = await quiet(() => resolveRobinhoodWalletHoldings(WALLET, { ...deps, cached: r as never }))
  assert.deepEqual(dsCalls, [])
  assert.equal(by(r, BIG).valueUsd, null)
  // 2. cached scan after PRICE_RETRY_MS: liquidity $60k ≥ max($50k, 25% of $100k) → accepted under current policy
  clock += 15_000
  r = await quiet(() => resolveRobinhoodWalletHoldings(WALLET, { ...deps, cached: r as never }))
  assert.deepEqual(dsCalls, [BIG])
  assert.equal(by(r, BIG).excludedFromValueReason, null)
  assert.equal(by(r, BIG).priceUsd, 100)
  assert.equal(by(r, BIG).valueUsd, 100_000)
  assert.equal(r.holdingsIntegrationAudit?.supportedValueUsd, 100_000)
  // 4/5. permanent exclusions stay rejected on cache (never re-priced, never counted)
  assert.equal(by(r, FAKE_ETH).excludedFromValueReason, 'native_symbol_impersonation')
  assert.equal(by(r, FAKE_ETH).valueUsd, null)
  assert.equal(by(r, SPAM).excludedFromValueReason, 'provider_spam_flag')
  assert.equal(by(r, SPAM).valueUsd, null)
  clock += 60_000
  dsCalls.length = 0
  r = await quiet(() => resolveRobinhoodWalletHoldings(WALLET, { ...deps, cached: r as never }))
  assert.deepEqual(dsCalls, [])
  assert.equal(by(r, FAKE_ETH).excludedFromValueReason, 'native_symbol_impersonation')
  assert.equal(by(r, SPAM).excludedFromValueReason, 'provider_spam_flag')
  resetRobinhoodPriceRetryState()
})
