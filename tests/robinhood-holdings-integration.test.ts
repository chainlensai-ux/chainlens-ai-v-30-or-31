import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRobinhoodWalletHoldings, type FetchImpl } from '../lib/server/robinhoodWalletScanner.ts'
import type { BlockscoutAddressTokenBalance } from '../lib/server/robinhoodBlockscoutEvidence.ts'
import { getBlockscoutAddressTokenBalances, __resetRobinhoodBlockscoutRateLimitForTest, blockscoutLaneRemaining } from '../lib/server/robinhoodBlockscoutEvidence.ts'

process.env.ENABLE_ROBINHOOD_CHAIN = 'true'
process.env.ALCHEMY_ROBINHOOD_RPC_URL = 'https://robinhood.example/rpc'
process.env.GOLDRUSH_API_KEY = 'test-goldrush'

const wallet = '0xf5f78000639614f204a18bfa6eb0435bf9b9b4b1'
const token = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const row = (n: number, value = '1000000000000000000', extra: Partial<BlockscoutAddressTokenBalance> = {}): BlockscoutAddressTokenBalance => ({
  value, token: { address_hash: token(n), decimals: '18', symbol: `T${n}`, name: `Token ${n}`, type: 'ERC-20' }, ...extra,
})
const pair = (address: string, price: string, liquidity: number) => ({ chainId: 'robinhood', pairAddress: token(999), dexId: 'uniswap',
  baseToken: { address }, quoteToken: { address: token(998) }, priceUsd: price, liquidity: { usd: liquidity }, volume: { h24: 20_000 } })

function providers(goldrush: unknown[], pairs: Record<string, unknown[]> = {}) {
  const calls: string[] = []
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push(url)
    if (url === 'https://robinhood.example/rpc') {
      const request = JSON.parse(String(init?.body)) as { method: string }
      assert.equal(request.method, 'eth_getBalance')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }))
    }
    if (url.includes('/balances_v2/')) return new Response(JSON.stringify({ data: { items: goldrush } }))
    if (url.includes('api.dexscreener.com/latest/dex/tokens/')) return new Response(JSON.stringify({ pairs: pairs[url.split('/').pop()!.toLowerCase()] ?? [] }))
    return new Response('missing', { status: 404 })
  }
  return { fetchImpl, calls }
}

test('current Blockscout ERC-20 balances enter the existing Robinhood pricing and portfolio merge path', async () => {
  const p = providers([{ native_token: true, quote_rate: 3000 }], { [token(1)]: [pair(token(1), '25', 100_000)] })
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => [row(1)], ethUsdLatest: async () => null })
  assert.equal(result.native?.valueUsd, 3000)
  assert.equal(result.holdings[0].chainId, 4663)
  assert.equal(result.holdings[0].tokenAddress, token(1))
  assert.equal(result.holdings[0].rawBalance, '1000000000000000000')
  assert.equal(result.holdings[0].normalizedQuantity, 1)
  assert.equal(result.holdings[0].balanceEvidenceSource, 'blockscout_current_token_balances')
  assert.equal(result.holdings[0].priceSource, 'dexscreener')
  assert.equal(result.portfolioTotalUsd, 3025)
  assert.equal(result.holdingsIntegrationAudit?.supportedValueUsd, 25)
  assert.equal(result.holdingsIntegrationAudit?.nativeBalanceIncluded, true)
  assert.equal(result.holdingsIntegrationAudit?.pricedErc20Count, 1)
  assert.equal(result.holdingsIntegrationAudit?.topHoldings[0].tokenAddress, token(1))
})

test('GoldRush and Blockscout current balances dedupe by chain and lowercase contract, native is counted once', async () => {
  const p = providers([{ native_token: true, quote_rate: 3000 }, { contract_address: token(1).toUpperCase().replace('0X', '0x'), balance: '2000000000000000000', contract_decimals: 18, quote_rate: 4, contract_ticker_symbol: 'ONE' }])
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => [row(1), row(2, '0')], ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 1)
  assert.equal(result.holdings[0].balanceEvidenceSource, 'goldrush_balances_v2')
  assert.equal(result.holdings[0].valueUsd, 8)
  assert.equal(result.portfolioTotalUsd, 3008)
  assert.equal(result.holdingsIntegrationAudit?.duplicateRowsRemoved, 1)
  assert.equal(result.holdingsIntegrationAudit?.excludedZeroBalance, 1)
})

test('explorer USD is ignored; illiquid, invalid, NFT and unpriced balances cannot inflate supported value', async () => {
  const p = providers([{ native_token: true, quote_rate: 3000 }], {
    [token(1)]: [pair(token(1), '1000000', 100)],
    [token(2)]: [],
  })
  const balances: BlockscoutAddressTokenBalance[] = [
    { ...row(1), token: { ...row(1).token, exchange_rate: '999999999' } as BlockscoutAddressTokenBalance['token'] },
    row(2), row(3, '100', { token: { address_hash: 'bad', decimals: '18', type: 'ERC-20' } }),
    row(4, '100', { token: { address_hash: token(4), decimals: '0', type: 'ERC-721' } }),
  ]
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => balances, ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 2)
  assert.equal(result.holdings.every((holding) => holding.valueUsd == null), true)
  assert.equal(result.portfolioTotalUsd, 3000)
  assert.equal(result.portfolioEvidence?.status, 'partial')
  assert.equal(result.holdingsIntegrationAudit?.supportedValueUsd, null)
  assert.equal(result.holdingsIntegrationAudit?.unpricedErc20Count, 2)
  assert.equal(result.holdingsIntegrationAudit?.excludedInvalidToken, 2)
  assert.equal(result.holdings[0].pricingDebug?.failureReason, 'insufficient_verified_liquidity')
})

test('reported-wallet-shaped 43 current balances are counted without trusting the explorer portfolio total', async () => {
  const balances = Array.from({ length: 43 }, (_, index) => row(index + 1))
  const p = providers([{ native_token: true, quote_rate: 3000 }], { [token(43)]: [pair(token(43), '20', 100_000)] })
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => balances, ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 43)
  assert.equal(result.holdingsIntegrationAudit?.providerRows, 43)
  assert.equal(result.holdingsIntegrationAudit?.pricedErc20Count, 1)
  assert.equal(result.holdingsIntegrationAudit?.unpricedErc20Count, 42)
  assert.equal(result.portfolioTotalUsd, 3020)
  assert.equal(result.portfolioEvidence?.status, 'partial')
  assert.equal(p.calls.filter((call) => call.includes('dexscreener.com')).length, 43)
})

test('production balance adapter reads the current-balance endpoint in its own bounded lane', async () => {
  process.env.BLOCKSCOUT_API_KEY = 'test-key'
  __resetRobinhoodBlockscoutRateLimitForTest()
  const address = token(71)
  const seen: string[] = []
  const fetchImpl: FetchImpl = async (url) => {
    seen.push(url)
    return new Response(JSON.stringify([row(1)]), { headers: { 'content-type': 'application/json' } })
  }
  const result = await getBlockscoutAddressTokenBalances(address, fetchImpl)
  assert.deepEqual(result.data, [row(1)])
  assert.equal(seen[0], `https://robinhoodchain.blockscout.com/api/v2/addresses/${address}/token-balances`)
  assert.equal(blockscoutLaneRemaining('holdings'), 1)
  assert.equal(blockscoutLaneRemaining('activity'), 4)
})

test('missing current balance evidence never reconstructs holdings from transfers or creates a zero-valued token', async () => {
  const p = providers([{ native_token: true, quote_rate: 3000 }])
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => null, ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 0)
  assert.equal(result.portfolioTotalUsd, 3000)
  assert.equal(result.holdingsIntegrationAudit?.providerRows, 0)
  assert.equal(p.calls.some((call) => call.includes('token-transfers')), false)
})

test('GoldRush spam flag and exact-token metadata conflict fail closed', async () => {
  const p = providers([{ contract_address: token(1), balance: '1000000000000000000', contract_decimals: 18, quote_rate: 100_000, is_spam: true }])
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => [
    row(2, '1000000000000000000', { token: { address: token(2), address_hash: token(3), type: 'ERC-20', decimals: '18' } }),
  ], ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 1)
  assert.equal(result.holdings[0].valueUsd, null)
  assert.equal(result.holdings[0].pricingDebug?.failureReason, 'provider_spam_flag')
  assert.equal(result.holdingsIntegrationAudit?.excludedInvalidToken, 1)
  assert.equal(result.holdingsIntegrationAudit?.supportedValueUsd, null)
})

test('unknown token decimals remain unpriced, never a zero-quantity priced holding', async () => {
  const p = providers([], { [token(1)]: [pair(token(1), '50', 100_000)] })
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => [
    row(1, '1000000000000000000', { token: { address_hash: token(1), type: 'ERC-20' } }),
  ], ethUsdLatest: async () => null })
  assert.equal(result.holdings[0].normalizedQuantity, null)
  assert.equal(result.holdings[0].priceUsd, null)
  assert.equal(result.holdings[0].valueUsd, null)
  assert.equal(result.holdings[0].pricingDebug?.failureReason, 'invalid_metadata_decimals_or_quantity')
  assert.equal(p.calls.some((call) => call.includes('dexscreener.com')), false)
})

test('fallback pricing has a hard 50-token cap and leaves overflow unpriced', async () => {
  const balances = Array.from({ length: 52 }, (_, index) => row(index + 1))
  const p = providers([])
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => balances, ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 52)
  assert.equal(p.calls.filter((call) => call.includes('dexscreener.com')).length, 50)
  assert.equal(result.holdings[51].pricingDebug?.failureReason, 'fallback_pricing_budget')
  assert.equal(result.holdingsIntegrationAudit?.unpricedErc20Count, 52)
})

test('fallback balance intake is capped and discloses incomplete coverage', async () => {
  const balances = Array.from({ length: 201 }, (_, index) => row(index + 1))
  const p = providers([])
  const result = await resolveRobinhoodWalletHoldings(wallet, { fetchImpl: p.fetchImpl, blockscoutBalances: async () => balances, ethUsdLatest: async () => null })
  assert.equal(result.holdings.length, 200)
  assert.equal(result.holdingsIntegrationAudit?.providerRows, 201)
  assert.equal(result.holdingsIntegrationAudit?.balanceRowsTruncated, 1)
  assert.equal(result.holdingsIntegrationAudit?.balanceCoverageComplete, false)
  assert.equal(result.reason, 'balance_row_cap')
})
