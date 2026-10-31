// Portfolio page: no invented value history, no fixed ETH price, PnL tiles labelled for what they are,
// and the linked wallet is used while the browser wallet has not reconnected (unless disconnected).
//   npx tsx --test tests/portfolio-page-honesty.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../app/terminal/portfolio/page.tsx', import.meta.url), 'utf8')

test('no synthesized value history: no sine/cosine noise, no range toggles, no dated hover values', () => {
  assert.doesNotMatch(page, /Math\.(sin|cos)\(/)
  assert.doesNotMatch(page, /'24H', '7D', '30D', '90D', 'ALL'/)
  assert.match(page, /Portfolio value history is not tracked, so no chart over time is shown\./)
})

test('ETH equivalent uses the scan\'s own ETH price, never a constant', () => {
  assert.doesNotMatch(page, /totalValue \/ 2600/)
  assert.match(page, /totalValue \/ ethPriceUsd/)
})

test('PnL tiles: realized is shown in USD as realized (not 24h), unrealized from the view model, no realized/value ratio', () => {
  assert.doesNotMatch(page, /label: '24H PnL'/)
  assert.match(page, /label: 'Realized PnL'/)
  assert.match(page, /\['Unrealized PnL', unrealizedPnL != null/)
  assert.doesNotMatch(page, /pnlPct/)
})

// readLinkedWalletAddress reads ConnectWallet's own localStorage keys.
function withLocalStorage(entries: Record<string, string>, run: () => void) {
  const store = new Map(Object.entries(entries))
  const g = globalThis as unknown as { window?: unknown }
  const prior = g.window
  g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 } }
  try { run() } finally { g.window = prior }
}

test('linked wallet: returned for the account, newest of device/account; null after a manual disconnect', async () => {
  const { readLinkedWalletAddress } = await import('../components/ConnectWallet')
  const saved = (address: string, updatedAt: string) => JSON.stringify({ address, connectorId: 'injected', updatedAt })
  withLocalStorage({
    chainlens_wallet_linked: saved('0x1111111111111111111111111111111111111111', '2026-10-01T00:00:00Z'),
    'chainlens_wallet_linked:user-1': saved('0x6022000000000000000000000000000000ae26', '2026-10-30T00:00:00Z'),
  }, () => {
    assert.equal(readLinkedWalletAddress('user-1'), '0x6022000000000000000000000000000000ae26')
    assert.equal(readLinkedWalletAddress(null), '0x1111111111111111111111111111111111111111')
  })
  withLocalStorage({
    'chainlens_wallet_linked:user-1': saved('0x6022000000000000000000000000000000ae26', '2026-10-30T00:00:00Z'),
    'chainlens_wallet_manual_disconnect:user-1': '1',
  }, () => assert.equal(readLinkedWalletAddress('user-1'), null))
  withLocalStorage({}, () => assert.equal(readLinkedWalletAddress('user-1'), null))
})

test('proven PnL: realized total adds only realized parts; unrealized is listed apart and marked partial', () => {
  assert.match(page, /const realizedParts = pnlParts\.filter\(\(p\) => p\.kind === 'realized'\)/)
  assert.match(page, /const totalPnL = hasPnl \? realizedParts\.reduce/)
  assert.match(page, /Proven parts only · not full wallet/)
  assert.match(page, /unrealizedPart\?\.status === 'Partial' \? ' · partial'/)
  const adapter = readFileSync(new URL('../app/frontend/lib/portfolioViewModelAdapter.ts', import.meta.url), 'utf8')
  // The Base/ETH sample is only used when there is no full-wallet figure, so the two never add up twice.
  assert.match(adapter, /if \(combinedUsd != null && combinedStatus\) \{[\s\S]*?\} else if \(sampleUsd != null/)
  assert.match(adapter, /pnlViewModel\.robinhoodBox\.status === 'Verified'/)
})
