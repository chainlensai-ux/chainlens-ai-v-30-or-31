//   npx tsx --test lib/walletAddressInput.heavyWallet.test.ts
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { walletScanErrorBanner } from './walletAddressInput'

it('an old HEAVY_WALLET_FAST_FAIL result reads as plain English, not a raw code', () => {
  const text = walletScanErrorBanner('HEAVY_WALLET_FAST_FAIL')
  assert.doesNotMatch(text, /HEAVY_WALLET_FAST_FAIL/)
  assert.match(text, /too much history/)
})
