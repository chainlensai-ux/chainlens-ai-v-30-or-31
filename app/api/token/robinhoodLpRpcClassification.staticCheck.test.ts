// ROBINHOOD LP SAFETY FIX, DISCLOSED: reported live — a Robinhood-chain token scan (0xZAPS,
// Uniswap primary pool) kept showing "Model Open Check"/"Open Check"/"Partial Proof" even after
// ALCHEMY_ROBINHOOD_RPC_URL and ENABLE_ROBINHOOD_CHAIN were both configured and redeployed.
//
// Root cause traced by reading the RPC pool-model-classification block in GET(): classifyPoolByRpc
// (a generic on-chain token0/token1/totalSupply-vs-slot0/liquidity probe that needs only a valid
// pool address, no dex metadata) was gated behind `_dsFbPoolSynthesized` — true ONLY when
// GeckoTerminal returned ZERO pools for the token and a DexScreener-fallback pool was synthesized
// in its place. A token whose pool WAS found as a normal canonical GeckoTerminal/DexScreener pool,
// but whose dexId string didn't match classifyPoolModel's known-DEX regex patterns (which is what
// happens for Robinhood Chain — its GT/DexScreener dex metadata isn't consistently labeled the way
// Base/ETH pools are), left poolType stuck at "unknown" forever: the RPC probe — the one thing that
// could actually resolve it — was never attempted, regardless of whether the RPC was configured.
//
// Fixed by widening the gate to run classifyPoolByRpc for ANY primary pool with poolType==='unknown'
// and a valid contract address, not just a synthesized fallback pool. This test asserts the widened
// gate is live and the old synthesized-only restriction is gone, using the same "read the real
// source, assert on it directly" convention as src/pipeline/ingestionSerialization.staticCheck.test.ts
// (app/api/token/route.ts is 8000+ lines with deep provider/RPC dependencies a fixture test can't
// reach).
//
// Run directly with:
//   npx tsx --test app/api/token/robinhoodLpRpcClassification.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')

describe('RPC pool-model classification runs for any unknown-type primary pool, not just a synthesized DexScreener fallback', () => {
  it('classifyPoolByRpc is invoked with a guard that does not require _dsFbPoolSynthesized', () => {
    const callIndex = src.indexOf('await classifyPoolByRpc(chain,')
    assert.notEqual(callIndex, -1, 'classifyPoolByRpc must still be called')
    // Walk backward to the nearest enclosing "if (" that gates this call site.
    const before = src.slice(0, callIndex)
    const lastIfIndex = before.lastIndexOf('if (chain ===')
    assert.notEqual(lastIfIndex, -1, 'must find the chain-support gate immediately enclosing the RPC classification call')
    const gateClause = src.slice(lastIfIndex, callIndex)
    assert.doesNotMatch(gateClause, /_dsFbPoolSynthesized/, 'the RPC classification gate must no longer require _dsFbPoolSynthesized — that was the coverage gap that left Robinhood-chain (and any chain) canonical pools with unknown poolType stuck at "Model Open Check" even with a fully configured RPC')
    assert.match(gateClause, /chain === 'robinhood'/, 'robinhood must remain one of the chains this RPC classification runs for')
  })

  it('the inner unknown-poolType + valid-address guard is still present (this is what limits the widened gate to genuinely unresolved cases)', () => {
    assert.match(src, /poolType === 'unknown' && _rpcProbePool\.address && \/\^0x\[a-f0-9\]\{40\}\$\/\.test\(_rpcProbePool\.address\)/, 'the RPC probe must still only fire for a pool whose type is unresolved and whose address is a valid 20-byte contract address')
  })

  it('a successful RPC classification still mutates the same pool object that lpPool/lpPoolType read from (normalizedPools[0])', () => {
    const callIndex = src.indexOf('await classifyPoolByRpc(chain,')
    const nearby = src.slice(callIndex, callIndex + 500)
    assert.match(nearby, /_rpcProbePool\.poolType = _rpcCls\.poolType/, 'a confirmed RPC model must be written back onto normalizedPools[0] so downstream lpPool/lpPoolType/computeDisplayLpModel see it')
  })
})

console.log('robinhoodLpRpcClassification.staticCheck.test.ts: source assertions passed')
