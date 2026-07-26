// Regression test for the confirmed production root cause of "transactionsInSwapLookup: 423,
// requirementsWithValidOppositeLeg: 0" — a native-ETH-funded swap (e.g. router.swapExactETHForTokens
// with msg.value > 0) has NO ERC20 Transfer log for its ETH leg, so GoldRush's `transfers` resource
// (ERC20-log-derived only) never reports it: every such transaction's swap-leg group had exactly the
// ONE inbound ERC20 leg (the token received) and zero opposite legs, no matter how the matching logic
// was written. This was a genuine ingestion gap, not a matching bug.
//
// Fix, DISCLOSED: the SAME already-fetched Covalent transaction object (no new HTTP request) also
// carries top-level `value`/`from_address`/`to_address` fields describing exactly this native
// transfer. fetchGoldrushRawEvents now synthesizes one RawProviderEvent from those fields whenever
// `value` is a real positive amount, using a canonical native-asset pseudo-address so it passes
// normalization's isValidContract check.
//
// Run with:
//   npx tsx --test src/modules/providerFetchWindow/nativeValueSynthesis.test.ts

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchGoldrushRawEvents, NATIVE_ASSET_ADDRESS } from './utils'
import { normalizeEvents } from '../normalization/index'
import { groupSwapLegsByTransaction } from '../quoteLegPricing/index'

const originalFetch = global.fetch
const originalApiKey = process.env.GOLDRUSH_API_KEY

afterEach(() => {
  global.fetch = originalFetch
  process.env.GOLDRUSH_API_KEY = originalApiKey
})

const WALLET = '0x00000000000000000000000000000000000abc'
const MEME_TOKEN = '0x0000000000000000000000000000000000000001'

function mockCovalentResponse(): void {
  process.env.GOLDRUSH_API_KEY = 'test-key'
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          items: [
            {
              tx_hash: '0xnativebuy',
              block_signed_at: new Date().toISOString(),
              // Native ETH sent directly from the wallet to the router — msg.value, no ERC20 log.
              from_address: WALLET,
              to_address: '0xrouter000000000000000000000000000000000',
              value: '1000000000000000000', // 1 ETH, wei
              transfers: [
                {
                  from_address: '0xpool0000000000000000000000000000000000',
                  to_address: WALLET,
                  contract_address: MEME_TOKEN,
                  contract_ticker_symbol: 'MEME',
                  delta: '1000000000000000000000', // 1000 MEME (18 decimals)
                  contract_decimals: 18,
                },
              ],
            },
          ],
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch
}

describe('fetchGoldrushRawEvents — native-value synthesis from the already-fetched tx object', () => {
  it('produces both the native ETH leg and the ERC20 leg for a native-funded swap, zero additional HTTP requests', async () => {
    mockCovalentResponse()
    let fetchCallCount = 0
    const wrapped = global.fetch
    global.fetch = (async (...args: Parameters<typeof fetch>) => { fetchCallCount += 1; return wrapped(...args) }) as unknown as typeof fetch

    const result = await fetchGoldrushRawEvents('base', WALLET, 90)
    assert.equal(result.ok, true)
    assert.equal(fetchCallCount, 1, 'exactly the one already-existing HTTP request — no additional provider call')
    assert.equal(result.events.length, 2, 'both the synthesized native leg and the real ERC20 leg must be present')

    const nativeLeg = result.events.find((e) => e.contract === NATIVE_ASSET_ADDRESS)
    assert.ok(nativeLeg, 'a native-asset event must be synthesized from tx.value/from_address/to_address')
    assert.equal(nativeLeg?.symbol, 'ETH')
    assert.equal(nativeLeg?.fromAddress, WALLET.toLowerCase())
    assert.equal(nativeLeg?.amountRaw, '1000000000000000000')

    const tokenLeg = result.events.find((e) => e.contract === MEME_TOKEN.toLowerCase())
    assert.ok(tokenLeg, 'the real ERC20 leg must still be present, unchanged')
  })

  it('end-to-end: normalizeEvents + groupSwapLegsByTransaction now produce a real 2-leg swap group with a valid opposite leg', async () => {
    mockCovalentResponse()
    const raw = await fetchGoldrushRawEvents('base', WALLET, 90)
    const { normalizedEvents } = normalizeEvents(raw.events, WALLET)
    assert.equal(normalizedEvents.length, 2, 'both legs survive normalization (the native leg now has a valid pseudo-contract address)')

    const buyLeg = normalizedEvents.find((e) => e.contract === MEME_TOKEN.toLowerCase())
    const nativeLeg = normalizedEvents.find((e) => e.contract === NATIVE_ASSET_ADDRESS)
    assert.equal(buyLeg?.direction, 'inbound')
    assert.equal(nativeLeg?.direction, 'outbound', 'the wallet directly sent this native value — a real, non-"unknown" direction')

    const groups = groupSwapLegsByTransaction(normalizedEvents)
    const group = groups.get('base:0xnativebuy')
    assert.ok(group)
    assert.equal(group!.length, 2, 'the swap-leg group now has 2+ legs — this was 1 (single-leg) before the fix, matching the confirmed production distribution')
  })
})
