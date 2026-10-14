// Whale Alerts audit regressions: alert identity/dedupe, webhook decoding, cron coverage, feed
// value filters and the row action wording. Persistence is covered in whale-alert-persist.test.ts,
// USD pricing in whale-usd-pricing.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  alertOwnerForWallet, BASE_WETH_ADDRESS, dedupeMovementLegs, movementKey, NATIVE_ETH_SENTINEL, pricingAddressFor,
} from '../lib/server/whaleAlertIdentity'
import { buildWebhookCandidates, SUPPORTED_WEBHOOK_NETWORKS } from '../lib/server/whaleWebhookCandidates'
import { cronNextOffset, cronRotationStart } from '../lib/server/whaleCronRotation'
import { filterByValueRange, parseValueRange, passesQualityFloor } from '../lib/server/whaleFeedFilters'
import { createLatestRequestGate, describeWhaleAction } from '../lib/whaleAlertAction'

const WALLET = '0x57f7dca134fdd36e5d73460f51ed1b12c11a0065'
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const leg = (over: Record<string, unknown> = {}) => ({
  tx_hash: '0xtx1', wallet_address: WALLET, token_address: TOKEN_A, alert_type: 'token_transfer', side: 'buy',
  token_symbol: 'AAA', amount_token: 10, owner_user_id: null, ...over,
})

// ── Identity / dedupe ────────────────────────────────────────────────────────
test('system wallet alerts are shared whoever synced; private wallet alerts stay private', () => {
  assert.equal(alertOwnerForWallet({ user_id: null }), null)
  assert.equal(alertOwnerForWallet({}), null)
  assert.equal(alertOwnerForWallet({ user_id: 'user-1' }), 'user-1')
})

test('reprocessing / per-owner copies of the same movement collapse to one visible leg', () => {
  const shared = leg()
  const perUserCopy = leg({ owner_user_id: 'user-1', wallet_address: WALLET.toUpperCase().replace('0X', '0x') })
  const { rows, removed } = dedupeMovementLegs([shared, perUserCopy])
  assert.deepEqual([rows.length, removed], [1, 1])
  assert.equal(rows[0], shared, 'first (newest) occurrence wins')
})

test('distinct legs in the same tx are never merged (other token, other side, other wallet)', () => {
  const rows = [
    leg(),
    leg({ token_address: TOKEN_B, token_symbol: 'BBB' }),
    leg({ side: 'sell' }),
    leg({ wallet_address: '0x1111111111111111111111111111111111111111' }),
  ]
  assert.equal(dedupeMovementLegs(rows).rows.length, 4)
  assert.equal(new Set(rows.map(movementKey)).size, 4)
})

test('same ticker, different contracts stay separate alerts', () => {
  const rows = [leg({ token_symbol: 'USDC', token_address: TOKEN_A }), leg({ token_symbol: 'USDC', token_address: TOKEN_B })]
  assert.equal(dedupeMovementLegs(rows).rows.length, 2)
})

test('rows without a tx hash have no on-chain identity and are kept', () => {
  assert.equal(dedupeMovementLegs([leg({ tx_hash: null }), leg({ tx_hash: null })]).rows.length, 2)
})

test('native ETH sentinel prices as WETH; real token addresses are used as-is', () => {
  assert.equal(pricingAddressFor(NATIVE_ETH_SENTINEL, 'ETH'), BASE_WETH_ADDRESS)
  assert.equal(pricingAddressFor(TOKEN_A.toUpperCase().replace('0X', '0x'), 'AAA'), TOKEN_A)
  assert.equal(pricingAddressFor(null, 'weth'), BASE_WETH_ADDRESS)
  assert.equal(pricingAddressFor('not-an-address', 'AAA'), null)
})

// ── Alchemy webhook decoding ─────────────────────────────────────────────────
const wallets = [{ address: WALLET, label: 'Legacy Base Whale' }]
const at = '2026-10-14T00:00:00.000Z'

test('webhook: both legs of a swap in one tx become two candidates (was: second leg dropped)', () => {
  const r = buildWebhookCandidates([
    { hash: '0xswap', fromAddress: WALLET, toAddress: '0xpool', asset: 'USDC', value: 5000, category: 'token', rawContract: { address: TOKEN_A, rawValue: '0x1' } },
    { hash: '0xswap', fromAddress: '0xpool', toAddress: WALLET, asset: 'AERO', value: 4000, category: 'token', rawContract: { address: TOKEN_B, rawValue: '0x1' } },
  ], wallets, at)
  assert.equal(r.candidates.length, 2)
  assert.deepEqual(r.candidates.map(c => [c.side, c.token_address]), [['sell', TOKEN_A], ['buy', TOKEN_B]])
})

test('webhook: a repeated delivery of the same leg in one payload yields one candidate', () => {
  const item = { hash: '0xdup', fromAddress: '0xpool', toAddress: WALLET, asset: 'AERO', value: 10, category: 'token', rawContract: { address: TOKEN_B } }
  const r = buildWebhookCandidates([item, item], wallets, at)
  assert.deepEqual([r.candidates.length, r.duplicateSkipped], [1, 1])
})

test('webhook: identity matches the sync producer (stored wallet address, native ETH sentinel, lowercase contract)', () => {
  const r = buildWebhookCandidates([
    { hash: '0xeth', fromAddress: WALLET.toUpperCase().replace('0X', '0x'), toAddress: '0xcex', asset: 'ETH', value: 2, category: 'external', rawContract: { address: null } },
    { hash: '0xtok', fromAddress: '0xpool', toAddress: WALLET, asset: 'aero', value: 1, category: 'token', rawContract: { address: TOKEN_B.toUpperCase().replace('0X', '0x') } },
  ], wallets, at)
  assert.equal(r.candidates[0]!.wallet_address, WALLET)
  assert.equal(r.candidates[0]!.token_address, NATIVE_ETH_SENTINEL)
  assert.equal(r.candidates[1]!.token_address, TOKEN_B)
  assert.ok(r.candidates.every(c => c.owner_user_id === null && c.chain === 'base' && c.amount_usd === null), 'no fabricated USD')
})

test('webhook: malformed / non-qualifying activity fails safe (no hash, approval, zero, internal, dust, untracked)', () => {
  const r = buildWebhookCandidates([
    null, {}, { hash: '' },
    { hash: '0x1', fromAddress: WALLET, toAddress: '0xx', category: 'approval', rawContract: { address: TOKEN_A } },
    { hash: '0x2', fromAddress: WALLET, toAddress: '0xx', value: 0, category: 'token', rawContract: { address: TOKEN_A } },
    { hash: '0x3', fromAddress: WALLET, toAddress: '0xx', value: 5, category: 'internal' },
    { hash: '0x4', fromAddress: WALLET, toAddress: '0xx', value: 0.001, asset: 'ETH', category: 'external' },
    { hash: '0x5', fromAddress: '0xnot', toAddress: '0xtracked', value: 5, asset: 'AERO', category: 'token', rawContract: { address: TOKEN_B } },
  ], wallets, at)
  assert.equal(r.candidates.length, 0)
  assert.equal(r.earlySkipped, 8)
})

test('webhook: only Base mainnet payloads are stored as chain base', () => {
  assert.ok(SUPPORTED_WEBHOOK_NETWORKS.has('BASE_MAINNET'))
  assert.ok(!SUPPORTED_WEBHOOK_NETWORKS.has('ETH_MAINNET'))
})

// ── Cron coverage ────────────────────────────────────────────────────────────
test('cron rotation covers every system wallet over consecutive days (was: always offset 0)', () => {
  const total = 68, perRun = 20, day = 24 * 60 * 60 * 1000
  const covered = new Set<number>()
  for (let d = 0; d < 4; d += 1) {
    const start = cronRotationStart(1_700_000_000_000 + d * day, total, perRun)
    assert.ok(start >= 0 && start < total)
    for (let i = 0; i < perRun; i += 1) covered.add((start + i) % total)
  }
  assert.equal(covered.size, total)
  assert.equal(cronRotationStart(Date.now(), 0), 0)
})

test('cron offsets wrap once and stop before revisiting the start (no wallet scanned twice per run)', () => {
  assert.deepEqual(cronNextOffset(50, 60, false), { offset: 60, wrapped: false })
  assert.deepEqual(cronNextOffset(50, null, false), { offset: 0, wrapped: true })
  assert.deepEqual(cronNextOffset(50, 40, true), { offset: 40, wrapped: true })
  assert.equal(cronNextOffset(50, 50, true), null)
  assert.equal(cronNextOffset(50, null, true), null)
  assert.equal(cronNextOffset(0, null, false), null)
})

// ── Feed value filters (thresholds) ──────────────────────────────────────────
test('value range: min inclusive, max exclusive; unpriced rows never qualify for a USD range', () => {
  const range = parseValueRange('1000-5000')
  assert.deepEqual(range, { min: 1000, max: 5000 })
  const rows = [999.99, 1000, 4999.99, 5000, null].map(amount_usd => ({ amount_usd, token_symbol: 'AAA' }))
  const out = filterByValueRange(rows, range)
  assert.deepEqual(out.rows.map(r => r.amount_usd), [1000, 4999.99])
  assert.equal(out.hiddenByFilter, 3)
  assert.deepEqual(parseValueRange('10000+'), { min: 10000, max: null })
  assert.equal(parseValueRange('garbage'), null, 'invalid input falls back to the default floor')
})

test('quality floor: $100 boundary, zero/negative USD never passes, unpriced kept as unverified', () => {
  assert.equal(passesQualityFloor({ amount_usd: 100 }), true)
  assert.equal(passesQualityFloor({ amount_usd: 99.99 }), false)
  assert.equal(passesQualityFloor({ amount_usd: 0 }), false)
  assert.equal(passesQualityFloor({ amount_usd: -5 }), false)
  assert.equal(passesQualityFloor({ amount_usd: null, token_symbol: 'USDC', amount_token: 99 }), false)
  assert.equal(passesQualityFloor({ amount_usd: null, token_symbol: 'AAA', amount_token: 1 }), true)
})

// ── Row wording / client request ordering ────────────────────────────────────
test('a one-direction transfer is "received"/"sent", never "bought"/"sold"/"swapped"', () => {
  assert.equal(describeWhaleAction({ side: 'buy', token_symbol: 'AERO' }).verb, 'received')
  assert.equal(describeWhaleAction({ side: 'sell', token_symbol: 'AERO' }).verb, 'sent')
  assert.equal(describeWhaleAction({ side: 'buy', token_symbol: 'AERO / DEGEN', legs: 2 }).verb, 'received', 'two inflows are not a swap')
  assert.deepEqual(describeWhaleAction({ side: null, token_symbol: 'USDC / AERO', legs: 2 }), { kind: 'swap', verb: 'swapped', chip: 'SWAP' })
  assert.equal(describeWhaleAction({ side: null, token_symbol: 'AERO' }).verb, 'moved')
})

test('overlapping feed requests: an older response can never replace a newer one', () => {
  const gate = createLatestRequestGate()
  const older = gate.next()
  const newer = gate.next()
  assert.equal(gate.isLatest(older), false)
  assert.equal(gate.isLatest(newer), true)
})
