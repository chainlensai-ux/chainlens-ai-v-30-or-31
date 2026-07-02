// TEMPORARY diagnostic script — NOT part of the real runtime test harness this directory hosts
// (runTests.ts / wallets.ts / utils.ts, run via `npx tsx src/runtimeTests/runTests.ts`). This file
// is not imported by runTests.ts and does not run as part of that suite; it's a standalone script
// for exercising resolvePriceForEntry directly. Safe to delete at any time.
//
// Run with: npx tsx src/runtimeTests/testPricingEngine.ts
//
// "primary: dexscreener, fallback: coingecko" is expressed as real PriceSourceFn function
// references (fetchDexscreenerPrice / fetchCoingeckoPrice), not string names — resolvePriceForEntry
// (src/modules/pricingAtTimeEngine/utils.ts) takes PriceSources = {primary: PriceSourceFn,
// fallback: PriceSourceFn} and was kept exactly as-is (not modified to accept string identifiers),
// so this script honors that real contract rather than inventing a parallel string-based router.

import { resolvePriceForEntry } from '../modules/pricingAtTimeEngine/utils'
import { fetchDexscreenerPrice } from '../modules/pricingAtTimeEngine/sources/dexscreener'
import { fetchCoingeckoPrice } from '../modules/pricingAtTimeEngine/sources/coingecko'

const WETH_BASE = '0x4200000000000000000000000000000000000006'

async function main() {
  console.warn('[testPricingEngine] env check', {
    hasCoingeckoKey: Boolean(process.env.COINGECKO_API_KEY),
  })

  const priceSources = {
    primary: fetchDexscreenerPrice,
    fallback: fetchCoingeckoPrice,
  }

  const token = WETH_BASE
  const chain = 'base'
  const timestamp = Date.now() - 2 * 24 * 60 * 60 * 1000 // 2 days ago

  const result = await resolvePriceForEntry(token, chain, timestamp, priceSources)

  console.log('token:    ', token)
  console.log('chain:    ', chain)
  console.log('timestamp:', timestamp, `(${new Date(timestamp).toISOString()})`)
  console.log('price:    ', result.price) // null printed exactly as-is — never substituted
  console.log('source:   ', result.source) // 'primary' | 'fallback' | 'failed'
}

main().catch((err) => {
  console.error('[testPricingEngine] fatal error', err)
  process.exit(1)
})
