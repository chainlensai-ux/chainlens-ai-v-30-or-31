import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildActiveChainDiscoveryLogRecord, ACTIVE_CHAIN_DISCOVERY_LOG_LABEL } from './activeChainDiscoveryLog'
import { discoverActiveChains } from './activeChainDiscovery'

const WALLET = '0x1111111111111111111111111111111111111111'

test('label is the exact expected string', () => {
  assert.equal(ACTIVE_CHAIN_DISCOVERY_LOG_LABEL, '[pipeline] active chain discovery pre-scan')
})

test('every field is a flat scalar, never an array or object', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base'] })
  const record = buildActiveChainDiscoveryLogRecord('/api/wallet-profile', result)
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(Array.isArray(value), true, key)
    assert.notEqual(typeof value, 'object', key)
    assert.ok(['string', 'number'].includes(typeof value), key)
  }
})

test('never logs the raw wallet address -- only a short hash', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base'] })
  const record = buildActiveChainDiscoveryLogRecord('/api/wallet-profile', result)
  assert.notEqual(record.walletAddressHash, WALLET)
  assert.notEqual(record.walletAddressHash, WALLET.toLowerCase())
  assert.ok(record.walletAddressHash.length <= 8)
})

test('ethGetBalanceCallsBefore is the full candidate count, ethGetBalanceCallsAfter is the narrowed active count', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base'] })
  const record = buildActiveChainDiscoveryLogRecord('/api/wallet-profile', result)
  assert.equal(record.ethGetBalanceCallsBefore, result.candidateChains.length)
  assert.equal(record.ethGetBalanceCallsAfter, 1)
  assert.ok(record.ethGetBalanceCallsAfter < record.ethGetBalanceCallsBefore)
})

test('full deep scan: before and after call counts are equal -- no reduction, by design', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, fullDeepScan: true })
  const record = buildActiveChainDiscoveryLogRecord('/api/wallet-profile', result)
  assert.equal(record.ethGetBalanceCallsBefore, record.ethGetBalanceCallsAfter)
})

test('chain lists and evidence source are comma-joined, flat strings, never [Array]', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base', 'eth'] })
  const record = buildActiveChainDiscoveryLogRecord('/api/wallet-profile', result)
  assert.equal(record.activeChains, 'base,eth')
  assert.equal(record.evidenceSource, 'provider_activity')
})

test('the same wallet always hashes to the same value (stable for cross-log correlation)', () => {
  const r1 = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base'] })
  const r2 = discoverActiveChains({ walletAddress: WALLET, activityChains: ['eth'] })
  const rec1 = buildActiveChainDiscoveryLogRecord('/api/a', r1)
  const rec2 = buildActiveChainDiscoveryLogRecord('/api/b', r2)
  assert.equal(rec1.walletAddressHash, rec2.walletAddressHash)
})
