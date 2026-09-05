import assert from 'node:assert/strict'
import { resolveConcentratedProtocol, attemptConcentratedPositionProof } from '../lib/server/lpProof.ts'

async function main() {
  // ── Stage 1: protocol resolver returns a verified manager only when one is actually known ──
  {
    const eth = resolveConcentratedProtocol('eth', 'uniswap_v3', 'contract')
    assert.equal(eth.protocol, 'uniswap_v3')
    assert.equal(eth.positionManager, '0xc36442b4a4522e871399cd717abdd847ab11fe88')
    assert.equal(eth.confidence, 'high')

    const base = resolveConcentratedProtocol('base', 'uniswap_v3', 'contract')
    assert.equal(base.positionManager, '0x03a520b32c04bf3beef7beb72e919cf822ed34f1')
    assert.equal(base.confidence, 'high')
  }

  // Verified position-manager addresses for Slipstream / Uniswap V4 / Pancake V3.
  {
    const slipstream = resolveConcentratedProtocol('base', 'aerodrome-slipstream', 'contract')
    assert.equal(slipstream.protocol, 'slipstream')
    assert.equal(slipstream.positionManager, '0x827922686190790b37229fd06084350e74485b72')
    assert.equal(slipstream.confidence, 'high')

    const v4 = resolveConcentratedProtocol('base', 'uniswap_v4', 'pool_id')
    assert.equal(v4.protocol, 'uniswap_v4')
    assert.equal(v4.positionManager, '0x7c5f5a4bbd8fd63184577525326123b519429bdc')
    assert.equal(v4.confidence, 'high')

    const pancake = resolveConcentratedProtocol('bnb', 'pancakeswap_v3', 'contract')
    assert.equal(pancake.positionManager, '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364')
    const uniBnb = resolveConcentratedProtocol('bnb', 'uniswap_v3', 'contract')
    assert.equal(uniBnb.positionManager, '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613')
    assert.notEqual(pancake.positionManager, uniBnb.positionManager, 'BNB Uniswap V3 and Pancake V3 use distinct managers')
  }

  // ── attemptConcentratedPositionProof now reuses the resolver to populate positionManager ──
  {
    const r = await attemptConcentratedPositionProof('eth', '0x' + '1'.repeat(40), null, 'contract', 'uniswap_v3')
    assert.equal(r.poolModel, 'uniswap_v3')
    // positionManager is populated from the same verified address as resolveConcentratedProtocol,
    // never a guessed/fabricated one.
    assert.equal(r.positionManager, '0xc36442b4a4522e871399cd717abdd847ab11fe88')
  }

  // ── Stage 7: public reasoning never leaks backend implementation language ──
  {
    const r = await attemptConcentratedPositionProof('eth', null, '0x' + 'd'.repeat(64), 'pool_id', 'uniswap_v4')
    assert.ok(!/subgraph|indexer|provider path|nft/i.test(r.reason), 'reason avoids backend jargon')
    assert.ok(/position index unavailable|owner unavailable|could not be fully resolved/i.test(r.reason), 'reason is a concrete unavailable message')
    assert.notEqual(r.status, 'not_supported', 'V4 resolver was attempted so status is not generic not_supported')
  }

  console.log('test-concentrated-protocol-resolver.mjs: all assertions passed')
}

main().catch((err) => { console.error(err); process.exit(1) })
