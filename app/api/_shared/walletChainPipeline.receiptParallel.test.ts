// Quote-leg receipt recovery: wallet-sent candidates are ranked before receive-only ones; the same cap of
// 10 receipts is fetched at most 3 at a time under one shared deadline, each transaction once, and the
// results are applied in rank order whatever order the responses arrive in.
//   npx tsx --test app/api/_shared/walletChainPipeline.receiptParallel.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { recoverQuoteLegsForBundles, rankQuoteLegRecoveryBundles } from './walletChainPipeline'
import type { RawTxBundle } from '@/src/modules/swapNormalizer/types'

const WALLET = '0x1111111111111111111111111111111111111111'
const ROUTER = '0x2222222222222222222222222222222222222222'
const TOKEN = (i: number) => `0x${(0x3000 + i).toString(16).padStart(40, '0')}`
const DISTRIBUTOR = '0x5555555555555555555555555555555555555555'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
const sellBundle = (i: number): RawTxBundle => ({ chain: 'base', txHash: `0xsell${String(i).padStart(2, '0')}`, timestamp: 1000 + i, transfers: [{ logIndex: 1, contract: TOKEN(i), from: WALLET, to: ROUTER, amountRaw: '1000' }] })
const airdropBundle = (i: number): RawTxBundle => ({ chain: 'base', txHash: `0xdrop${String(i).padStart(2, '0')}`, timestamp: 2000 + i, transfers: [{ logIndex: 1, contract: TOKEN(99), from: DISTRIBUTOR, to: WALLET, amountRaw: '5' }] })

let originalFetch: typeof fetch
let originalBaseRpcUrl: string | undefined
beforeEach(() => { originalFetch = globalThis.fetch; originalBaseRpcUrl = process.env.BASE_RPC_URL; process.env.BASE_RPC_URL = 'https://example-test-rpc.invalid' })
afterEach(() => { globalThis.fetch = originalFetch; if (originalBaseRpcUrl === undefined) delete process.env.BASE_RPC_URL; else process.env.BASE_RPC_URL = originalBaseRpcUrl })

function stubReceipts(opts: { delayMs?: (tx: string) => number } = {}) {
  const requested: string[] = []
  let active = 0, peak = 0
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const tx = JSON.parse(String(init?.body)).params[0] as string
    requested.push(tx)
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, opts.delayMs?.(tx) ?? 10))
    active--
    const logs = [{ address: WETH_BASE, topics: [TRANSFER_TOPIC0, pad(ROUTER), pad(WALLET)], data: '0x' + (1e15).toString(16), logIndex: '0x9' }]
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: '0x1', logs } }) }
  }) as unknown as typeof fetch
  return { requested, peak: () => peak }
}

describe('receipt candidate ranking', () => {
  it('wallet-sent candidates come before receive-only ones, even when airdrops are more frequent', () => {
    const bundles = [...Array.from({ length: 30 }, (_, i) => airdropBundle(i)), sellBundle(1)]
    const ranked = rankQuoteLegRecoveryBundles(bundles, WALLET, 'base')
    assert.equal(ranked[0].txHash, '0xsell01')
  })
})

describe('bounded parallel receipt fetching', () => {
  it('fetches the same 10 receipts as before, at most 3 in flight, and recovers each quote leg', async () => {
    const f = stubReceipts()
    const bundles = Array.from({ length: 14 }, (_, i) => sellBundle(i))
    const { audit } = await recoverQuoteLegsForBundles(bundles, WALLET, 'base')
    assert.equal(f.requested.length, 10)
    assert.ok(f.peak() <= 3, `peak in flight ${f.peak()}`)
    assert.equal(audit.receiptsFetched, 10)
    assert.equal(audit.quoteLegsRecovered, 10)
    assert.equal(audit.rejectionReasons.receipt_budget_exhausted, 4)
    assert.equal(typeof audit.receiptFetchElapsedMs, 'number')
  })

  it('a duplicated transaction is fetched once', async () => {
    const f = stubReceipts()
    const one = sellBundle(1)
    await recoverQuoteLegsForBundles([one, { ...one }], WALLET, 'base')
    assert.equal(f.requested.length, 1)
  })

  it('results do not depend on response order', async () => {
    const bundles = Array.from({ length: 6 }, (_, i) => sellBundle(i))
    stubReceipts({ delayMs: (tx) => 5 + (parseInt(tx.slice(-2), 10) % 3) * 15 })
    const a = await recoverQuoteLegsForBundles(bundles, WALLET, 'base')
    stubReceipts({ delayMs: (tx) => 50 - (parseInt(tx.slice(-2), 10) % 3) * 15 })
    const b = await recoverQuoteLegsForBundles(bundles, WALLET, 'base')
    const { receiptFetchElapsedMs: _ea, ...auditA } = a.audit
    const { receiptFetchElapsedMs: _eb, ...auditB } = b.audit
    assert.deepEqual(JSON.stringify(a.bundles), JSON.stringify(b.bundles))
    assert.deepEqual(auditA, auditB)
  })

  it('a hanging provider cannot push the stage past the shared deadline; unstarted receipts are reported, not guessed', async () => {
    let started = 0
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      started++
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    const bundles = Array.from({ length: 10 }, (_, i) => sellBundle(i))
    const t0 = Date.now()
    const { audit } = await recoverQuoteLegsForBundles(bundles, WALLET, 'base', undefined, { deadlineMs: 300 })
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 600, `stage took ${elapsed}ms against a 300ms deadline`)
    assert.equal(started, 3, 'only the first concurrent batch started before the deadline')
    assert.equal(audit.quoteLegsRecovered, 0)
    assert.equal(audit.rejectionReasons.receipt_deadline_exceeded, 7)
    assert.equal(audit.receiptsFetched, 3, 'the three timed-out requests are counted as fetched attempts')
  })
})
