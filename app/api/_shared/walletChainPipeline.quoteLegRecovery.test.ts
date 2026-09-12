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
import { recoverQuoteLegsForBundles, rankQuoteLegRecoveryBundles } from './walletChainPipeline'
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
    assert.equal(recoveredLeg?.decimals, 18)
    assert.equal(recoveredLeg?.to.toLowerCase(), WALLET)
    assert.equal(audit.oneLegTxCount, 1)
    assert.equal(audit.candidateSwapTxs, 1)
    assert.equal(audit.receiptsFetched, 1)
    assert.equal(audit.quoteLegsRecovered, 1)
    assert.equal(audit.nativeQuoteLegsRecovered, 1)
    assert.equal(audit.stableQuoteLegsRecovered, 0)
  })

  it('recovered Base USDC quote legs carry canonical decimals=6, never undefined/18', async () => {
    const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => receiptResponse([
        { address: USDC_BASE, topics: [TRANSFER_TOPIC0, pad(ROUTER), pad(WALLET)], data: '0x' + Number(2996415).toString(16), logIndex: '0x3' },
      ]),
    })) as unknown as typeof fetch

    const bundle: RawTxBundle = { chain: 'base', txHash: '0xsell-usdc', timestamp: 1000, transfers: [{ logIndex: 1, contract: MEMECOIN, from: WALLET, to: ROUTER, amountRaw: '1000' }] }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'base')
    const recoveredLeg = bundles[0].transfers?.[1]
    assert.equal(recoveredLeg?.contract.toLowerCase(), USDC_BASE)
    assert.equal(recoveredLeg?.decimals, 6)
    assert.equal(recoveredLeg?.amountRaw, '2996415')
    assert.equal(audit.stableQuoteLegsRecovered, 1)
  })

  it('a genuine airdrop (single incoming transfer, no counter-leg anywhere in the receipt) is never fabricated into a swap', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => receiptResponse([]), // real receipt, but no Transfer log at all
    })) as unknown as typeof fetch

    const bundle: RawTxBundle = { chain: 'base', txHash: '0xairdrop1', timestamp: 1000, transfers: [{ logIndex: 1, contract: MEMECOIN, from: ROUTER, to: WALLET, amountRaw: '5000' }] }
    const { bundles, audit } = await recoverQuoteLegsForBundles([bundle], WALLET, 'base')

    assert.equal(bundles[0].transfers?.length, 1, 'no leg was fabricated for a real airdrop with no quote counterpart')
    assert.equal(audit.quoteLegsRecovered, 0)
    // Wallet Scanner audit, Item 6, DISCLOSED: an EMPTY receipt (no wallet-facing Transfer log of
    // any kind) is now distinguished from "some transfer exists but isn't a recognized quote asset"
    // — this module has no way to tell "genuine airdrop" apart from "raw native-ETH settlement, no
    // log to prove it" here, so it honestly reports the more specific native_trace_unavailable
    // reason rather than the generic no_quote_transfer_in_receipt.
    assert.equal(audit.rejectionReasons.native_trace_unavailable, 1)
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

  it('Item 3: rankQuoteLegRecoveryBundles spends the scarce slots on the token that dominates one-leg candidates, never on singleton distractors listed first', () => {
    const dominant = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const distractors: RawTxBundle[] = Array.from({ length: 12 }, (_, i) => ({
      chain: 'base',
      txHash: `0xdist${i.toString(16).padStart(2, '0')}`,
      timestamp: 1000 + i,
      transfers: [{ logIndex: 1, contract: `0x${(i + 1).toString(16).padStart(40, '0')}`, from: WALLET, to: ROUTER, amountRaw: '1000' }],
    }))
    const majors: RawTxBundle[] = Array.from({ length: 12 }, (_, i) => ({
      chain: 'base',
      txHash: `0xdom${i.toString(16).padStart(2, '0')}`,
      timestamp: 2000 + i,
      transfers: [{ logIndex: 1, contract: dominant, from: WALLET, to: ROUTER, amountRaw: '1000' }],
    }))
    const ranked = rankQuoteLegRecoveryBundles([...distractors, ...majors], WALLET, 'base')
    const firstTenContracts = ranked.slice(0, 10).map((b) => b.transfers?.[0]?.contract.toLowerCase())
    assert.deepEqual(firstTenContracts, Array(10).fill(dominant), 'the first 10 fetch slots must be the dominant one-leg token')
    assert.equal(ranked.length, 24)
  })

  it('Item 3: recoverQuoteLegsForBundles fetches the dominant token even when singleton distractors are listed first, without raising the 10-receipt cap or reordering FIFO output', async () => {
    const fetched: string[] = []
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { params?: string[] } : null
      const txHash = body?.params?.[0]
      if (typeof txHash === 'string') fetched.push(txHash)
      return { ok: true, json: async () => receiptResponse([]) }
    }) as unknown as typeof fetch

    const dominant = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const distractors: RawTxBundle[] = Array.from({ length: 12 }, (_, i) => ({
      chain: 'base',
      txHash: `0xdist${i.toString(16).padStart(2, '0')}`,
      timestamp: 1000 + i,
      transfers: [{ logIndex: 1, contract: `0x${(i + 1).toString(16).padStart(40, '0')}`, from: WALLET, to: ROUTER, amountRaw: '1000' }],
    }))
    const majors: RawTxBundle[] = Array.from({ length: 8 }, (_, i) => ({
      chain: 'base',
      txHash: `0xdom${i.toString(16).padStart(2, '0')}`,
      timestamp: 2000 + i,
      transfers: [{ logIndex: 1, contract: dominant, from: WALLET, to: ROUTER, amountRaw: '1000' }],
    }))
    const input = [...distractors, ...majors]
    const { bundles, audit } = await recoverQuoteLegsForBundles(input, WALLET, 'base')

    assert.equal(audit.candidateSwapTxs, 20)
    assert.equal(audit.receiptsFetched, 10, 'cap is unchanged at 10')
    assert.equal(audit.rejectionReasons.receipt_budget_exhausted, 10)
    const dominantFetched = fetched.filter((h) => h.startsWith('0xdom')).length
    assert.equal(dominantFetched, 8, 'every dominant-token one-leg tx must be fetched before leftover budget hits distractors')
    assert.deepEqual(bundles.map((b) => b.txHash), input.map((b) => b.txHash), 'output order must match input so FIFO event order never moves')
  })
})
