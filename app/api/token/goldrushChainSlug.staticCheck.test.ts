// GOLDRUSH-CHAIN-SLUG FIX, DISCLOSED: found while chasing a live report of BNB token scans
// intermittently coming back with no market/holder data at all after a chain-detection fix that
// correctly routed the scan to BNB. fetchGoldRush() built its Covalent/GoldRush URL with the bare
// ChainKey ('eth'|'base'|'bnb'|'robinhood') instead of GoldRush's real chain_name slug (e.g.
// 'bsc-mainnet') — every other GoldRush/Covalent call site in this file routes through
// COVALENT_CHAIN_SLUG for exactly this reason (see fetchTokenMetadata's own GOLDRUSH-CHAIN-SLUG FIX
// comment, an earlier round of the same bug class), but this one call site was missed. This almost
// certainly 404'd/failed silently on every chain, wrapped in try/catch and further wrapped in
// fetchGoldRushWithHostFallback's own try/catch, so it never surfaced as an error — it just quietly
// returned null every time, which is a bigger loss for BNB/Robinhood than for eth/base since some
// downstream fields have no non-GoldRush fallback source.
//
// This test asserts the fix directly on source, following this file's established
// "read the real source, assert on it" convention for a route too large/provider-dependent for a
// fixture test to reach.
//
// Run directly with:
//   npx tsx --test app/api/token/goldrushChainSlug.staticCheck.test.ts

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')

describe('fetchGoldRush resolves a real GoldRush chain_name slug before building its request URL', () => {
  it('no longer interpolates the bare ChainKey directly into the GoldRush URL path', () => {
    assert.doesNotMatch(src, /`https:\/\/\$\{host\}\/v1\/\$\{chain\}\/tokens\/\$\{contract\}\/`/, 'fetchGoldRush must not build its URL from the bare ChainKey — GoldRush does not recognize "eth"/"base"/"bnb"/"robinhood" as chain_name slugs')
  })

  it('routes through COVALENT_CHAIN_SLUG like every other GoldRush call site in this file', () => {
    const fnStart = src.indexOf('async function fetchGoldRush(chain: ChainKey, contract: string): Promise<any> {')
    assert.notEqual(fnStart, -1, 'fetchGoldRush must still exist with this signature')
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    assert.match(fnBody, /const covalentChain = \(chain === 'eth' \|\| chain === 'base' \|\| chain === 'bnb' \|\| chain === 'robinhood'\) \? COVALENT_CHAIN_SLUG\[chain\] : null/, 'fetchGoldRush must resolve the real GoldRush chain slug via COVALENT_CHAIN_SLUG before using it')
    assert.match(fnBody, /if \(!covalentChain\) return null/, 'an unsupported chain must return null honestly rather than sending a request with an invalid slug')
    assert.match(fnBody, /`https:\/\/\$\{host\}\/v1\/\$\{covalentChain\}\/tokens\/\$\{contract\}\/`/, 'the request URL must use the resolved covalentChain slug, not the raw ChainKey')
  })
})
