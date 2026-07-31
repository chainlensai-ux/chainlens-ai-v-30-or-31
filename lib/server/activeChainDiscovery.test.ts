import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverActiveChains } from './activeChainDiscovery'

const WALLET = '0x1111111111111111111111111111111111111111'

test('wallet active on Base only: activeChains is exactly [base], everything else skipped', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base'] })
  assert.deepEqual(result.activeChains, ['base'])
  assert.ok(!result.skippedInactiveChains.includes('base'))
  assert.ok(result.skippedInactiveChains.includes('eth'))
  assert.ok(result.skippedInactiveChains.includes('polygon'))
  assert.deepEqual(result.evidenceSources, ['provider_activity'])
})

test('wallet active on Base + ETH: both surfaced, deterministically ordered, others skipped', () => {
  // Deliberately unordered input -- ETH before Base -- to prove output ordering is canonical, not
  // input-order-dependent.
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['eth', 'base'] })
  assert.deepEqual(result.activeChains, ['base', 'eth'])
  assert.ok(!result.skippedInactiveChains.includes('base'))
  assert.ok(!result.skippedInactiveChains.includes('eth'))
  assert.ok(result.skippedInactiveChains.includes('arbitrum'))
})

test('cached active-chain reuse: a previously-proven-active chain is never dropped even without fresh evidence for it', () => {
  const result = discoverActiveChains({
    walletAddress: WALLET,
    activityChains: ['base'],
    cachedActiveChains: ['arbitrum'], // proven active before, not re-surfaced by this request's fresh evidence
  })
  assert.ok(result.activeChains.includes('base'))
  assert.ok(result.activeChains.includes('arbitrum'))
  assert.ok(result.evidenceSources.includes('cached_active'))
})

test('cached active-chain reuse: a chain both fresh evidence AND the cache agree on is not double-counted in evidenceSources', () => {
  const result = discoverActiveChains({
    walletAddress: WALLET,
    activityChains: ['base'],
    cachedActiveChains: ['base'],
  })
  assert.deepEqual(result.activeChains, ['base'])
  assert.equal(result.evidenceSources.includes('cached_active'), false)
})

test('explicit Full Deep Scan: every supported chain is active, none skipped, regardless of any other evidence', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, fullDeepScan: true, activityChains: ['base'] })
  assert.deepEqual(result.activeChains, result.candidateChains)
  assert.deepEqual(result.skippedInactiveChains, [])
  assert.deepEqual(result.evidenceSources, ['full_deep_scan'])
})

test('no evidence: falls back to Base + Ethereum ONLY, never all supported chains', () => {
  const result = discoverActiveChains({ walletAddress: WALLET })
  assert.deepEqual(result.activeChains, ['base', 'eth'])
  assert.deepEqual(result.evidenceSources, ['fallback_base_eth'])
  assert.ok(result.candidateChains.length > 2, 'candidateChains must still list every supported chain, only activeChains is narrowed')
})

test('deterministic chain ordering: activeChains always follows the canonical ALCHEMY_SUPPORTED_CHAINS order, never input order', () => {
  const a = discoverActiveChains({ walletAddress: WALLET, activityChains: ['arbitrum', 'base', 'polygon'] })
  const b = discoverActiveChains({ walletAddress: WALLET, activityChains: ['polygon', 'arbitrum', 'base'] })
  assert.deepEqual(a.activeChains, b.activeChains)
  assert.deepEqual(a.candidateChains, b.candidateChains)
})

test('holdings evidence alone is sufficient to mark a chain active', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, holdingsChains: ['bnb'] })
  assert.deepEqual(result.activeChains, ['bnb'])
  assert.deepEqual(result.evidenceSources, ['holdings'])
})

test('explicit user-selected chain is always included even with no other evidence', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, explicitChain: 'polygon' })
  assert.deepEqual(result.activeChains, ['polygon'])
  assert.deepEqual(result.evidenceSources, ['explicit_chain'])
})

test('an unsupported explicit chain is silently ignored, never added, never crashes', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, explicitChain: 'scroll' })
  assert.deepEqual(result.activeChains, ['base', 'eth']) // falls back, since no valid evidence exists
  assert.equal(result.evidenceSources.includes('explicit_chain'), false)
})

test('unsupported chains in activity/holdings evidence are filtered out, never treated as active', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base', 'linea', 'zksync'] })
  assert.deepEqual(result.activeChains, ['base'])
})

test('candidateChains always lists every supported chain regardless of activity -- "every chain considered"', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base'] })
  assert.ok(result.candidateChains.includes('polygon'))
  assert.ok(result.candidateChains.includes('bnb'))
  assert.ok(result.candidateChains.includes('hyperevm'))
})

test('skippedInactiveChains + activeChains together always equal candidateChains, no overlap', () => {
  const result = discoverActiveChains({ walletAddress: WALLET, activityChains: ['base', 'eth'] })
  const union = new Set([...result.activeChains, ...result.skippedInactiveChains])
  assert.equal(union.size, result.candidateChains.length)
  for (const c of result.activeChains) assert.ok(!result.skippedInactiveChains.includes(c))
})
