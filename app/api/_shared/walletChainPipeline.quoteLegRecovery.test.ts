// WALLET SCANNER PNL EVIDENCE FIX, DISCLOSED — integration test for recoverQuoteLegsForBundles
// (walletChainPipeline.ts), stubbing the real eth_getTransactionReceipt network call so the full
// candidate-identification -> receipt-fetch -> log-decode -> bundle-splice chain can be exercised
// without a live RPC. Complements the pure-logic tests in
// src/modules/swapNormalizer/quoteLegRecovery.test.ts (which this function's internals reuse).
//
// Run directly with:
//   npx tsx --test app/api/_shared/walletChainPipeline.quoteLegRecovery.test.ts

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { recoverQuoteLegsForBundles } from './walletChainPipeline'
import type { RawTxBundle } from '@/src/modules/swapNormalizer/types'

const WALLET = '0x1111111111111111111111111111111111111111'
const ROUTER = '0x2222222222222222222222222222222222222222'
const MEMECOIN = '0x3333333333333333333333333333333333333333'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function pad(addr: string): string {
  return `0x${'0'.repeat(24)}${addr.replace(/^0x/, '').toLowerCase()}`
}

function receiptResponse(logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>) {
  return { jsonrpc: '2.0', id: 1, result: { status: '0x1', logs } }
}

let originalFetch: typeof fetch
let originalBaseRpcUrl: string | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalBaseRpcUrl = process.env.BASE_RPC_URL
  process.env.BASE_RPC_URL = 'https://example-test-rpc.invalid'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalBaseRpcUrl === undefined) delete process.env.BASE_RPC_URL
  else process.env.BASE_RPC_URL = originalBaseRpcUrl
})

describe('recoverQuoteLegsForBundles', () => {
  it('recovers a real WETH quote leg for a one-leg SELL and splices it additively (existing leg untouched)', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => receiptResponse([
        { address: WETH_BASE, topics: [TRANSFER_TOPIC0, pad(ROUTER), pad(WALLET)], data: '0x' + (500000000000000).toString(16), logIndex: '0x3' },
      ]),
    })) as unknown as typeof fetch

    const bundle: RawTxBundle = { chain: 'base', txHash: '0xsell1', timestamp: 1000, transfers: [{ logIndex: 1, contract: MEMECOIN, from: WALLET, to: ROUTER, amountRaw: '1000' }] }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'base')

    assert.equal(bundles.length, 1)
    assert.equal(bundles[0].transfers?.length, 2, 'the recovered leg must be ADDED, never replacing the existing one')
    assert.equal(bundles[0].transfers?.[0].contract, MEMECOIN, 'the original leg is untouched')
    const recoveredLeg = bundles[0].transfers?.[1]
    assert.equal(recoveredLeg?.contract.toLowerCase(), WETH_BASE)
    assert.equal(recoveredLeg?.to.toLowerCase(), WALLET)
    assert.equal(audit.oneLegTxCount, 1)
    assert.equal(audit.candidateSwapTxs, 1)
    assert.equal(audit.receiptsFetched, 1)
    assert.equal(audit.quoteLegsRecovered, 1)
    assert.equal(audit.nativeQuoteLegsRecovered, 1)
    assert.equal(audit.stableQuoteLegsRecovered, 0)
  })

  it('a genuine airdrop (single incoming transfer, no counter-leg anywhere in the receipt) is never fabricated into a swap', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => receiptResponse([]), // real receipt, but no quote-asset Transfer log at all
    })) as unknown as typeof fetch

    const bundle: RawTxBundle = { chain: 'base', txHash: '0xairdrop1', timestamp: 1000, transfers: [{ logIndex: 1, contract: MEMECOIN, from: ROUTER, to: WALLET, amountRaw: '5000' }] }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'base')

    assert.equal(bundles[0].transfers?.length, 1, 'no leg was fabricated for a real airdrop with no quote counterpart')
    assert.equal(audit.quoteLegsRecovered, 0)
    assert.equal(audit.rejectionReasons.no_quote_transfer_in_receipt, 1)
  })

  it('a two-leg bundle (both sides already known — e.g. a normal token-to-token swap) is never touched — nothing to recover', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => { fetchCalled = true; return { ok: true, json: async () => receiptResponse([]) } }) as unknown as typeof fetch

    const bundle: RawTxBundle = {
      chain: 'base', txHash: '0xswap1', timestamp: 1000,
      transfers: [
        { logIndex: 1, contract: MEMECOIN, from: WALLET, to: ROUTER, amountRaw: '1000' },
        { logIndex: 2, contract: WETH_BASE, from: ROUTER, to: WALLET, amountRaw: '500' },
      ],
    }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'base')

    assert.equal(fetchCalled, false, 'no receipt fetch should be attempted when both legs are already known')
    assert.equal(bundles[0].transfers?.length, 2)
    assert.equal(audit.oneLegTxCount, 0)
  })

  it('a receipt fetch failure (e.g. RPC not configured/timeout) is recorded honestly and never blocks the other bundles', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => null })) as unknown as typeof fetch

    const bundle: RawTxBundle = { chain: 'base', txHash: '0xfail1', timestamp: 1000, transfers: [{ logIndex: 1, contract: MEMECOIN, from: WALLET, to: ROUTER, amountRaw: '1000' }] }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'base')

    assert.equal(bundles[0].transfers?.length, 1)
    assert.equal(audit.receiptsFetched, 1)
    assert.ok(Object.keys(audit.rejectionReasons).some((k) => k.startsWith('receipt_error')))
  })

  it('respects the local receipt-fetch budget cap — candidates beyond the cap are honestly counted, never fetched', async () => {
    let fetchCount = 0
    globalThis.fetch = (async () => { fetchCount += 1; return { ok: true, json: async () => receiptResponse([]) } }) as unknown as typeof fetch

    const bundles: RawTxBundle[] = Array.from({ length: 15 }, (_, i) => ({
      chain: 'base', txHash: `0xtx${i}`, timestamp: 1000 + i,
      transfers: [{ logIndex: 1, contract: MEMECOIN, from: WALLET, to: ROUTER, amountRaw: '1000' }],
    }))
    const { audit } = await recoverQuoteLegsForBundles(bundles, WALLET, 'base')

    assert.equal(audit.candidateSwapTxs, 15)
    assert.ok(fetchCount <= 10, `expected at most 10 receipt fetches, got ${fetchCount}`)
    assert.equal(audit.rejectionReasons.receipt_budget_exhausted, 5)
  })

  it('a non-eth/base chain (e.g. arbitrum) is left completely untouched — recovery is out of scope for chains the receipt fetcher does not cover', async () => {
    let fetchCalled = false
    globalThis.fetch = (async () => { fetchCalled = true; return { ok: true, json: async () => receiptResponse([]) } }) as unknown as typeof fetch

    const bundle: RawTxBundle = { chain: 'arbitrum', txHash: '0xarb1', timestamp: 1000, transfers: [{ logIndex: 1, contract: MEMECOIN, from: WALLET, to: ROUTER, amountRaw: '1000' }] }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'arbitrum')

    assert.equal(fetchCalled, false)
    assert.equal(bundles[0].transfers?.length, 1)
    assert.equal(audit.oneLegTxCount, 0)
  })
})
