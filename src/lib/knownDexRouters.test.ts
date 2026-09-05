// Tests for src/lib/knownDexRouters.ts — the shared verified router registry (Wallet Scanner audit,
// Priority 1: "Create ONE shared verified router source" unifying walletSnapshot.ts's own
// KNOWN_DEX_ROUTERS/EXTENDED_DEX_ROUTERS, swapNormalizer/routers.ts, and pipeline/index.ts's
// previously-independent KNOWN_DEX_ROUTER_ADDRESSES copy).
//
// Run directly with:
//   npx tsx --test src/lib/knownDexRouters.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KNOWN_DEX_ROUTERS, KNOWN_DEX_ROUTER_ADDRESSES, isKnownDexRouter, knownDexRouterProtocol } from './knownDexRouters'

// Every address the task's Priority 1 explicitly requires coverage for ("Must cover existing
// verified entries such as: Uniswap Universal Router, SwapRouter02, Base Universal Router, 1inch,
// 0x, Paraswap, Permit2, LI.FI, Aerodrome/Slipstream, AlienBase, Virtuals, Balancer, Curve").
const REQUIRED_ADDRESSES: Array<[string, string]> = [
  ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d', 'Uniswap V2 Router02'],
  ['0xe592427a0aece92de3edee1f18e0157c05861564', 'Uniswap V3 Router'],
  ['0x2626664c2603336e57b271c5c0b26f421741e481', 'Uniswap V3 SwapRouter02'],
  ['0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', 'Uniswap Universal Router (ETH)'],
  ['0x198ef79f1f515f02dfe9e3115ed9fc07183f02fc', 'Uniswap Universal Router (Base)'],
  ['0x1111111254eeb25477b68fb85ed929f73a960582', '1inch v5'],
  ['0x111111125421ca6dc452d289314280a0f8842a65', '1inch v6'],
  ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Exchange Proxy'],
  ['0x216b4b4ba9f3e719726886d34a177484278bfcae', 'Paraswap'],
  ['0x000000000022d473030f116ddee9f6b43ac78ba9', 'Permit2'],
  ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', 'LI.FI Diamond'],
  ['0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', 'Aerodrome'],
  ['0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5', 'Aerodrome Slipstream'],
  ['0x8c1a3cf8f83074169fe5d7ad50b978e1cd6b37c7', 'AlienBase'],
  ['0xf8dd39c71a278fe9f4377d009d7627ef140f809e', 'Virtuals'],
  ['0xba12222222228d8ba445958a75a0704d566bf2c8', 'Balancer'],
  ['0x99a58482bd75cbab83b27ec03ca68ff489b5788f', 'Curve'],
]

describe('knownDexRouters — the single shared verified registry', () => {
  for (const [address, label] of REQUIRED_ADDRESSES) {
    it(`recognizes ${label} (${address}) as a known router`, () => {
      assert.equal(isKnownDexRouter(address), true, `${label} must be a known router`)
      assert.equal(isKnownDexRouter(address.toUpperCase()), true, 'lookup must be case-insensitive')
      assert.ok(knownDexRouterProtocol(address), `${label} must resolve a protocol label`)
    })
  }

  it('never fabricates a match for an unrecognized address', () => {
    assert.equal(isKnownDexRouter('0x0000000000000000000000000000000000000001'), false)
    assert.equal(knownDexRouterProtocol('0x0000000000000000000000000000000000000001'), null)
  })

  it('handles null/undefined/empty input honestly, never throws', () => {
    assert.equal(isKnownDexRouter(null), false)
    assert.equal(isKnownDexRouter(undefined), false)
    assert.equal(isKnownDexRouter(''), false)
  })

  it('KNOWN_DEX_ROUTER_ADDRESSES is derived from the exact same keys as KNOWN_DEX_ROUTERS', () => {
    assert.deepEqual([...KNOWN_DEX_ROUTER_ADDRESSES].sort(), Object.keys(KNOWN_DEX_ROUTERS).sort())
  })

  it('every address is stored lowercase (case-insensitive lookup depends on this)', () => {
    for (const address of Object.keys(KNOWN_DEX_ROUTERS)) {
      assert.equal(address, address.toLowerCase(), `${address} must be stored lowercase`)
    }
  })
})
