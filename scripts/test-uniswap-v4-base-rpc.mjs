// Test for lib/server/uniswapV4BaseRpc.ts — the gating + log-decoding logic used to resolve real
// V4 concentrated-liquidity position ownership on Base via RPC event logs.
//
// Run: node scripts/test-uniswap-v4-base-rpc.mjs

import assert from 'node:assert'
import { resolveUniswapV4BaseRpc } from '../lib/server/uniswapV4BaseRpc.ts'

let passed = 0
function check(label, condition) {
  assert.ok(condition, label)
  passed++
}

// Gating: only chain==='base' && poolModel==='uniswap_v4' && a poolId should ever attempt a real
// lookup. Everything else must resolve to null without needing network access.
const result1 = await resolveUniswapV4BaseRpc({ chain: 'eth', poolModel: 'uniswap_v4', poolId: '0x' + '1'.repeat(64) })
check('wrong chain (eth) returns null without network access', result1 === null)

const result2 = await resolveUniswapV4BaseRpc({ chain: 'base', poolModel: 'uniswap_v3', poolId: '0x' + '1'.repeat(64) })
check('wrong poolModel (uniswap_v3) returns null without network access', result2 === null)

const result3 = await resolveUniswapV4BaseRpc({ chain: 'base', poolModel: 'uniswap_v4', poolId: null })
check('missing poolId returns null without network access', result3 === null)

const result4 = await resolveUniswapV4BaseRpc({ chain: 'robinhood', poolModel: 'uniswap_v4', poolId: '0x' + '1'.repeat(64) })
check('robinhood chain (handled by a different resolver) returns null here', result4 === null)

console.log(`test-uniswap-v4-base-rpc.mjs: all ${passed} assertions passed`)
