// TEMPORARY diagnostic script — not part of the application, not imported by anything, safe to
// delete at any time. Run with: npx tsx testPricingEngine.ts
//
// Exercises the real multi-provider pricing engine (src/modules/pricingAtTimeEngine/sources/
// multiProviderPriceSource.ts) end-to-end against real tokens/timestamps. No fabrication: every
// result printed below is exactly what getPriceAtTime() returned — if a provider had no real
// answer, this prints `null` honestly, it never substitutes a guessed number.
//
// NOTE on the memecoin address: no specific address was provided when this script was written, so
// MEMECOIN_ADDRESS_BASE below is a placeholder — TOSHI on Base, a real, well-known token contract,
// NOT verified live from this sandbox (outbound network access to block explorers/RPC providers is
// blocked by this sandbox's own network policy, so its correctness could not be confirmed here).
// Replace it with your own address before trusting result #2; the script logs a warning about this
// every run so it's never silently mistaken for a verified address.

import { getPriceAtTime } from './src/modules/pricingAtTimeEngine/sources/multiProviderPriceSource'
import type { SupportedChain } from './src/modules/providerFetchWindow/types'

const WETH_BASE = '0x4200000000000000000000000000000000000006'

// Placeholder — see header note. Replace with a real address you want to test.
const MEMECOIN_ADDRESS_BASE = '0xAC1Bd2486aaf3B5C0fc3Fd868558b082a531B2B4'

const now = Date.now()
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000

type TestCase = {
  label: string
  chain: SupportedChain
  tokenAddress: string
  timestamp: number
}

const TEST_CASES: TestCase[] = [
  { label: 'WETH on Base — 2 weeks ago', chain: 'base', tokenAddress: WETH_BASE, timestamp: now - TWO_WEEKS_MS },
  { label: 'WETH on Base — 2 days ago', chain: 'base', tokenAddress: WETH_BASE, timestamp: now - TWO_DAYS_MS },
  { label: 'WETH on Base — 5 minutes ago', chain: 'base', tokenAddress: WETH_BASE, timestamp: now - FIVE_MINUTES_MS },
  { label: 'Memecoin on Base — 2 weeks ago', chain: 'base', tokenAddress: MEMECOIN_ADDRESS_BASE, timestamp: now - TWO_WEEKS_MS },
  { label: 'Memecoin on Base — 2 days ago', chain: 'base', tokenAddress: MEMECOIN_ADDRESS_BASE, timestamp: now - TWO_DAYS_MS },
  { label: 'Memecoin on Base — 5 minutes ago', chain: 'base', tokenAddress: MEMECOIN_ADDRESS_BASE, timestamp: now - FIVE_MINUTES_MS },
]

async function main() {
  console.warn(
    `[testPricingEngine] MEMECOIN_ADDRESS_BASE (${MEMECOIN_ADDRESS_BASE}) is an unverified placeholder — ` +
      'replace it with a real address you want to test; this sandbox could not verify it live (network policy blocks outbound calls).',
  )
  console.warn('[testPricingEngine] env check', {
    hasCoingeckoKey: Boolean(process.env.COINGECKO_API_KEY),
    hasAlchemyBaseKey: Boolean(process.env.ALCHEMY_BASE_RPC_URL ?? process.env.ALCHEMY_BASE_KEY),
  })

  for (const test of TEST_CASES) {
    const result = await getPriceAtTime({
      chain: test.chain,
      tokenAddress: test.tokenAddress,
      timestamp: test.timestamp,
    })

    console.log('\n=================================================================')
    console.log(`Test: ${test.label}`)
    console.log('-----------------------------------------------------------------')
    console.log('chain:       ', test.chain)
    console.log('tokenAddress:', test.tokenAddress)
    console.log('timestamp:   ', test.timestamp, `(${new Date(test.timestamp).toISOString()})`)
    console.log('priceUsd:    ', result.priceUsd) // null printed exactly as-is — never substituted
    console.log('source:      ', result.source)
    console.log('debug:       ', JSON.stringify(result.debug, null, 2))
  }
}

main().catch((err) => {
  console.error('[testPricingEngine] fatal error', err)
  process.exit(1)
})
