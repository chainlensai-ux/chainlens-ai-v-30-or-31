// ROBINHOOD LP SAFETY FIX, DISCLOSED: reported live — a Robinhood-chain token scan (0xZAPS,
// Uniswap primary pool) kept showing "Model Open Check"/"Open Check"/"Partial Proof" even after
// ALCHEMY_ROBINHOOD_RPC_URL and ENABLE_ROBINHOOD_CHAIN were both configured and redeployed.
//
// Root cause: classifyPoolByRpc was gated behind `_dsFbPoolSynthesized`. Route now gates via
// shouldProbePoolModelByRpc (unknown poolType, or Robinhood unversioned-DEX v2 default).
// This file asserts the route still calls the helper (not the old synthesized-only gate) and
// that the helper itself covers the unresolved cases — without brittle inline-regex coupling
// to a superseded route expression.
//
// Run: npx tsx --test app/api/token/robinhoodLpRpcClassification.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { shouldProbePoolModelByRpc } from '../../../lib/lpSafetyResolution.ts'

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')
const POOL = '0x' + '11'.repeat(20)

describe('RPC pool-model classification runs for any unknown-type primary pool, not just a synthesized DexScreener fallback', () => {
  it('classifyPoolByRpc is invoked with a guard that does not require _dsFbPoolSynthesized', () => {
    const callIndex = src.indexOf('await classifyPoolByRpc(chain,')
    assert.notEqual(callIndex, -1, 'classifyPoolByRpc must still be called')
    const before = src.slice(0, callIndex)
    const lastIfIndex = before.lastIndexOf('if (chain ===')
    assert.notEqual(lastIfIndex, -1, 'must find the chain-support gate immediately enclosing the RPC classification call')
    const gateClause = src.slice(lastIfIndex, callIndex)
    assert.doesNotMatch(gateClause, /_dsFbPoolSynthesized/, 'the RPC classification gate must no longer require _dsFbPoolSynthesized')
    assert.match(gateClause, /chain === 'robinhood'/, 'robinhood must remain one of the chains this RPC classification runs for')
  })

  it('route gates the probe through shouldProbePoolModelByRpc (not a superseded inline unknown-only expression)', () => {
    assert.match(
      src,
      /shouldProbePoolModelByRpc\(\{ chain, poolType: _rpcProbePool\.poolType, address: _rpcProbePool\.address, dexId: _rpcProbePool\.dexId, dexName: _rpcProbePool\.dexName \}\)/,
      'route must call shouldProbePoolModelByRpc with the primary pool fields',
    )
    assert.doesNotMatch(
      src,
      /poolType === 'unknown' && _rpcProbePool\.address && \/\^0x\[a-f0-9\]\{40\}\$\/\.test\(_rpcProbePool\.address\)/,
      'superseded inline unknown+address gate must stay removed — coverage lives in the helper',
    )
  })

  it('helper probes unknown poolType with a valid contract address on every supported chain', () => {
    for (const chain of ['eth', 'base', 'bnb', 'robinhood', 'polygon'] as const) {
      assert.equal(
        shouldProbePoolModelByRpc({ chain, poolType: 'unknown', address: POOL, dexId: null }),
        true,
        `${chain}: unknown + valid address must probe`,
      )
    }
  })

  it('helper refuses invalid addresses and does not probe resolved non-Robinhood v2', () => {
    assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'unknown', address: null }), false)
    assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'unknown', address: '0x' + 'ab'.repeat(32) }), false)
    assert.equal(shouldProbePoolModelByRpc({ chain: 'base', poolType: 'v2', address: POOL, dexId: 'uniswap' }), false)
    assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'concentrated', address: POOL, dexId: 'uniswap' }), false)
  })

  it('helper still probes Robinhood unversioned-DEX v2 defaults (bare uniswap label)', () => {
    assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: POOL, dexId: 'uniswap' }), true)
    assert.equal(shouldProbePoolModelByRpc({ chain: 'robinhood', poolType: 'v2', address: POOL, dexId: 'uniswap-v2' }), false)
  })

  it('a successful RPC classification still mutates the same pool object that lpPool/lpPoolType read from (normalizedPools[0])', () => {
    const callIndex = src.indexOf('await classifyPoolByRpc(chain,')
    const nearby = src.slice(callIndex, callIndex + 500)
    assert.match(nearby, /_rpcProbePool\.poolType = _rpcCls\.poolType/, 'a confirmed RPC model must be written back onto normalizedPools[0]')
  })
})

console.log('robinhoodLpRpcClassification.staticCheck.test.ts: source + helper assertions registered')
