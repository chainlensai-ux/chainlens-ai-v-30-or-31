import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attemptConcentratedPositionProof, resolveConcentratedProtocol, type ConcentratedOwnerLookupResult } from '../lib/server/lpProof'
import { resolvePositionManager } from '../lib/server/concentratedLpPositions'
const pool = '0x' + 'b'.repeat(40)
const owner = '0x' + 'a'.repeat(40)

test('pool-id identity prevents a V3 metadata label from choosing a V3 manager for a V4 pool', () => {
  for (const chain of ['base', 'eth', 'bnb', 'robinhood'] as const) {
    const v3 = resolveConcentratedProtocol(chain, 'uniswap_v3', 'contract')
    const v4 = resolveConcentratedProtocol(chain, 'uniswap_v3', 'pool_id')
    assert.equal(v3.protocol, 'uniswap_v3')
    assert.equal(v4.protocol, 'uniswap_v4')
    assert.notEqual(v3.positionManager, v4.positionManager)
  }
  assert.notEqual(resolvePositionManager(56, 'uniswap_v3'), resolvePositionManager(56, 'pancakeswap_v3'))
  assert.notEqual(resolvePositionManager(8453, 'slipstream'), resolvePositionManager(8453, 'uniswap_v3'))
})

test('bounded owner candidates cannot become whole-pool ownership or restore a historical proof', async () => {
  const lookup: ConcentratedOwnerLookupResult = { records: [{ address: owner, liquidityRaw: '100', ownerType: 'wallet' }], attempted: true, providerUsed: 'the_graph_uniswap_v3', positionsFound: 1, activePositionsFound: 1, failureReason: null }
  const prior = await attemptConcentratedPositionProof('robinhood', pool, null, 'contract', 'uniswap_v3', async () => lookup.records)
  assert.equal(prior.status, 'verified') // Explicit full-proof fixture, never the bounded production resolver.
  const now = await attemptConcentratedPositionProof('robinhood', pool, null, 'contract', 'uniswap_v3', async () => lookup)
  assert.equal(now.status, 'partial')
  assert.equal(now.ownershipStatus, 'ownership_open_check')
  assert.equal(now.topPositionOwner, null)
  assert.equal(now.topPositionSharePercent, null)
  assert.equal(now.topSampledOwnerShareOfSamplePercent, 100)
  assert.notEqual(now.ownershipDebug.source, 'verified_cache_restored')
})

test('manager custody and locker custody without withdrawal proof remain unverified', async () => {
  for (const ownerType of ['protocol', 'locker'] as const) {
    const proof = await attemptConcentratedPositionProof('robinhood', '0x' + (ownerType === 'protocol' ? 'c' : 'd').repeat(40), null, 'contract', 'uniswap_v3', async () => [{ address: owner, ownerType, liquidityRaw: '100' }])
    assert.equal(proof.status, 'partial')
    assert.equal(proof.ownershipStatus, 'ownership_open_check')
  }
})

test('unsafe activity resolvers are absent from the scanner dispatcher and V4 proof overrides V3 copy', () => {
  const route = readFileSync('app/api/token/route.ts', 'utf8')
  const dispatcher = route.slice(route.indexOf('const resolveConcentratedPositionOwners:'), route.indexOf('// Local LP model/migration'))
  assert.doesNotMatch(dispatcher, /await resolveUniswapV4PositionOwners|await resolveUniswapV4RobinhoodRpc|await resolveAerodromeSlipstreamPoolRpc/)
  const ui = readFileSync('app/terminal/token-scanner/page.tsx', 'utf8')
  assert.match(ui, /canonicalConcentratedProof\?\.poolModel !== 'uniswap_v4'/)
})
