import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildClarkWhaleIntelligenceUi, parseClarkWhaleIntelligenceUi, rankClarkWhaleFlowRows, type ClarkWhaleFlowRow } from '../lib/clarkWhaleUi'
import { getBaseStablecoinShortcut, priceWhaleMovement, whaleUsdUnavailableCopy } from '../lib/server/whaleUsdPricing'

const movement = {
  id: 'movement-1',
  chain_id: 8453,
  token_address: '0x1111111111111111111111111111111111111111',
  token_symbol: 'TEST',
  amount_token: 10,
}

test('stored transaction USD is verified before any market fallback', () => {
  const result = priceWhaleMovement({ ...movement, amount_usd: 125 }, { priceUsd: 20, sourceUsed: 'dexscreener_current', sourcesTried: ['dexscreener_current'] })
  assert.equal(result.amountUsd, 125)
  assert.equal(result.audit.finalUsdStatus, 'verified')
  assert.equal(result.audit.priceSourceUsed, 'stored_tx_usd')
  assert.deepEqual(result.audit.priceSourceTried, ['stored_tx_usd'])
})

test('transaction-time token price wins over current market price', () => {
  const result = priceWhaleMovement({ ...movement, token_price_usd_at_tx: 4 }, { priceUsd: 9, sourceUsed: 'geckoterminal_current', sourcesTried: ['dexscreener_current', 'geckoterminal_current'] })
  assert.equal(result.amountUsd, 40)
  assert.equal(result.audit.finalUsdStatus, 'estimated')
  assert.equal(result.audit.priceSourceUsed, 'token_price_at_tx')
})

test('current market price produces an estimated value with provider receipt', () => {
  const result = priceWhaleMovement(movement, { priceUsd: 3, sourceUsed: 'dexscreener_current', sourcesTried: ['dexscreener_current'] })
  assert.equal(result.amountUsd, 30)
  assert.equal(result.audit.finalUsdStatus, 'estimated')
  assert.equal(result.audit.priceSourceUsed, 'dexscreener_current')
})

test('missing values are never rendered as zero and include an exact reason', () => {
  const result = priceWhaleMovement(movement, { priceUsd: null, sourceUsed: null, sourcesTried: ['dexscreener_current', 'geckoterminal_current'], providerFailed: true })
  assert.equal(result.amountUsd, null)
  assert.equal(result.audit.finalUsdStatus, 'unavailable')
  assert.equal(result.audit.failureReason, 'provider failed')
  assert.equal(whaleUsdUnavailableCopy(result.audit), 'USD unavailable: provider failed')
})

test('a real zero-token movement remains explicit zero', () => {
  const result = priceWhaleMovement({ ...movement, amount_token: 0, amount_usd: 0 }, null)
  assert.equal(result.amountUsd, 0)
  assert.equal(result.audit.finalUsdStatus, 'zero')
})

test('missing normalized amount distinguishes missing decimals', () => {
  const result = priceWhaleMovement({ ...movement, amount_token: null, amount_raw: '1000000', token_decimals: null }, null)
  assert.equal(result.audit.failureReason, 'decimals missing')
})

test('Base USDC amount uses the address-verified stablecoin shortcut', () => {
  const quote = getBaseStablecoinShortcut({ tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC' })
  const result = priceWhaleMovement({ ...movement, token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', token_symbol: 'USDC', amount_token: 925 }, quote)
  assert.equal(result.amountUsd, 925)
  assert.equal(result.audit.stablecoinShortcutUsed, true)
  assert.equal(result.audit.priceSource, 'stablecoin_address_shortcut')
})

test('a token address with a spoofed stablecoin symbol does not get the $1 shortcut', () => {
  assert.equal(getBaseStablecoinShortcut({ tokenAddress: movement.token_address, symbol: 'USDC' }), null)
})

test('native ETH amount uses its resolved market quote', () => {
  const result = priceWhaleMovement({ ...movement, token_address: null, token_symbol: 'ETH', amount_token: 1.86 }, { priceUsd: 3_000, sourceUsed: 'coingecko_current', sourcesTried: ['coingecko_current'] })
  assert.equal(result.amountUsd, 5_580)
  assert.equal(result.audit.currentPriceAttempted, true)
})

test('missing market price has an exact reason and never becomes zero', () => {
  const result = priceWhaleMovement(movement, { priceUsd: null, sourceUsed: null, sourcesTried: ['dexscreener_current', 'geckoterminal_current'] })
  assert.equal(result.amountUsd, null)
  assert.equal(result.audit.failureReason, 'price missing')
  assert.equal(whaleUsdUnavailableCopy(result.audit), 'USD unavailable: price missing')
})

test('stale or substantially unpriced feed recommends sync', () => {
  const row = (status: ClarkWhaleFlowRow['usdStatus'], id: string): ClarkWhaleFlowRow => ({
    id, token: 'TEST', tokenAddress: movement.token_address, chain: 'Base', walletLabel: 'Whale',
    walletAddress: movement.token_address, txCount: 1, usdValue: status === 'unavailable' ? null : 10,
    usdStatus: status, usdReason: status === 'unavailable' ? 'price missing' : null,
    confidence: 'Medium', lastSeen: '2026-09-03T00:00:00.000Z',
  })
  const stale = buildClarkWhaleIntelligenceUi({ kind: 'flow', summary: '2 buys', lastSyncedAt: null, flowRows: [row('verified', '1')] }, Date.parse('2026-09-03T00:20:00.000Z'))
  assert.equal(stale.syncRecommended, true)
  const incomplete = buildClarkWhaleIntelligenceUi({ kind: 'flow', summary: '2 buys', lastSyncedAt: '2026-09-03T00:19:00.000Z', flowRows: [row('unavailable', '1'), row('verified', '2')] }, Date.parse('2026-09-03T00:20:00.000Z'))
  assert.equal(incomplete.incomplete, true)
  assert.equal(incomplete.syncRecommended, true)
  assert.ok(parseClarkWhaleIntelligenceUi(incomplete))
})

test('Clark whale rows rank by USD value, then transaction count', () => {
  const row = (id: string, usdValue: number | null, txCount: number): ClarkWhaleFlowRow => ({
    id, token: 'TEST', tokenAddress: movement.token_address, chain: 'Base', walletLabel: 'Whale',
    walletAddress: movement.token_address, txCount, usdValue, usdStatus: usdValue == null ? 'unavailable' : 'estimated',
    usdReason: usdValue == null ? 'price missing' : null, confidence: 'Medium', lastSeen: null,
  })
  assert.deepEqual(rankClarkWhaleFlowRows([row('missing', null, 99), row('small', 10, 2), row('large', 100, 1), row('small-more', 10, 3)]).map(item => item.id), ['large', 'small-more', 'small', 'missing'])
})

test('Whale Alerts renders wallet/token copy actions and passes value audit to Clark', () => {
  const source = readFileSync(new URL('../app/terminal/whale-alerts/page.tsx', import.meta.url), 'utf8')
  assert.match(source, /<AddressCopyButton address=\{alert\.wallet_address\} label="wallet address"/)
  assert.match(source, /<AddressCopyButton address=\{alert\.token_address\} label="token contract"/)
  assert.match(source, /Value audit: \$\{JSON\.stringify/)
  assert.doesNotMatch(source, /Value unverified|USD value unavailable/)
})
