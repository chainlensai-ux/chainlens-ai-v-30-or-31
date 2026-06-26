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

  // Never guesses a position-manager address for a protocol/chain this codebase hasn't verified
  // — confidence must drop to "low" with a null address rather than fabricating one.
  {
    const slipstream = resolveConcentratedProtocol('base', 'aerodrome-slipstream', 'contract')
    assert.equal(slipstream.protocol, 'slipstream')
    assert.equal(slipstream.positionManager, null, 'never guesses an unverified Slipstream position-manager address')
    assert.equal(slipstream.confidence, 'low')

    const v4 = resolveConcentratedProtocol('base', 'uniswap_v4', 'pool_id')
    assert.equal(v4.protocol, 'uniswap_v4')
    assert.equal(v4.positionManager, null)
    assert.equal(v4.confidence, 'low')
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
    assert.ok(r.reason.includes('could not be fully resolved'))
  }

  console.log('test-concentrated-protocol-resolver.mjs: all assertions passed')
}

main().catch((err) => { console.error(err); process.exit(1) })
