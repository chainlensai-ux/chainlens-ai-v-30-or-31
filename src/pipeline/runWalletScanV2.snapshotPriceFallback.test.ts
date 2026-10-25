import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCanonicalCurrentPriceLookup } from './runWalletScanV2'
import { snapshotPricesFromHoldings } from '../../workers/walletScanV2'

const WETH = '0x4200000000000000000000000000000000000006'
const LINK = '0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196'

test('a token the core pass could not price falls back to the portfolio snapshot price; its own price still wins', async () => {
  const snapshot = Promise.resolve(snapshotPricesFromHoldings([
    { chainId: 8453, tokenAddress: WETH.toUpperCase().replace('0X', '0x'), priceUsd: 3900, priceSource: 'dexscreener' },
    { chainId: 8453, tokenAddress: LINK, priceUsd: 14, priceSource: 'geckoterminal' },
    { chainId: 8453, tokenAddress: '0xdead', priceUsd: null },
    { chainId: 4663, tokenAddress: '0xrh', priceUsd: 1 },
  ]))
  const lookup = buildCanonicalCurrentPriceLookup([], [{ chain: 'base', contract: LINK, priceUsd: 15, source: 'dexscreener' } as never], snapshot)
  await snapshot
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(lookup(WETH, 'base'), { priceUsd: 3900, source: 'portfolio_snapshot:dexscreener' })
  assert.equal(lookup(LINK, 'base')!.priceUsd, 15, 'the core pass price is preferred')
  assert.equal(lookup('0xdead', 'base'), null)
})

test('without a snapshot (route scans) the lookup is unchanged', () => {
  const lookup = buildCanonicalCurrentPriceLookup([], [])
  assert.equal(lookup(WETH, 'base'), null)
})
