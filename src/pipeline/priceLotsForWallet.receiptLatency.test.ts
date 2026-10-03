// Receipt quote recovery latency / call-budget hardening (follow-up to 035614f2).
// Uses the REAL receipt fetcher and internal-transfer tracer against a fake network, so call counts,
// probe memory, deadlines and concurrency are measured, not mocked away. Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.receiptLatency.test.ts

import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBlockedLotFixture, runBlockedLotFixture } from './priceLotsForWallet.blockedLots.fixture.ts'
import { __resetReceiptQuoteTxCacheForTest, createInternalTransferTracer, createReceiptQuoteTxFetcher } from '../lib/receiptQuoteRecovery.ts'

type TraceMode = 'ok' | 'unsupported' | 'hang' | 'error' | 'timeout_first'
type BlockscoutMode = 'ok' | 'hang' | 'paginated' | 'error'

function fakeNetwork(opts: { trace: TraceMode; blockscout: BlockscoutMode; delayMs?: number }) {
  const { receipts, traces } = buildBlockedLotFixture()
  const calls = { receipt: 0, trace: 0, blockscout: 0 }
  const delay = opts.delayMs ?? 5
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const signal = init?.signal ?? undefined
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
    })
    if (url.includes('/internal-transactions')) {
      calls.blockscout += 1
      const txHash = url.split('/transactions/')[1].split('/')[0]
      if (opts.blockscout === 'hang') await wait(1e9)
      await wait(delay)
      if (opts.blockscout === 'error') return new Response('busy', { status: 503 })
      const items = (traces.get(txHash) ?? []).map((t) => ({ from: { hash: t.from }, to: { hash: t.to }, value: t.valueWei, success: true, type: 'call' }))
      return Response.json({ items, next_page_params: opts.blockscout === 'paginated' ? { index: 50 } : null })
    }
    const body = JSON.parse(String(init?.body))
    if (Array.isArray(body)) {
      calls.receipt += 1
      await wait(delay)
      const r = receipts.get(body[0].params[0])
      if (!r || r.status !== 'ok') return Response.json([{ id: 1, result: null }, { id: 2, result: null }])
      return Response.json([
        { id: 1, result: { status: '0x1', logs: r.logs } },
        { id: 2, result: { from: r.from, to: r.to, value: `0x${BigInt(r.valueWei).toString(16)}`, input: r.input } },
      ])
    }
    calls.trace += 1
    const txHash = body.params[0]
    if (opts.trace === 'hang' || (opts.trace === 'timeout_first' && calls.trace === 1)) await wait(1e9)
    await wait(delay)
    if (opts.trace === 'unsupported') return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'the method debug_traceTransaction does not exist/is not available' } })
    if (opts.trace === 'error') return new Response('bad gateway', { status: 502 })
    const transfers = traces.get(txHash) ?? []
    return Response.json({ jsonrpc: '2.0', id: 1, result: { type: 'CALL', from: '0xwallet', to: '0xrouter', value: '0x0', calls: transfers.map((t) => ({ type: 'CALL', from: t.from, to: t.to, value: `0x${BigInt(t.valueWei).toString(16)}` })) } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

async function run(opts: { trace: TraceMode; blockscout: BlockscoutMode; delayMs?: number; deadlineMs?: number; concurrency?: number; traceTimeoutMs?: number; maxTxs?: number }) {
  const net = fakeNetwork(opts)
  const rpcUrlFor = () => 'https://rpc.test'
  const started = performance.now()
  const result = await runBlockedLotFixture({
    receiptLane: true,
    maxTxs: opts.maxTxs,
    recovery: {
      fetchTx: createReceiptQuoteTxFetcher({ fetchImpl: net.fetchImpl, rpcUrlFor, timeoutMs: 2000 }),
      fetchInternalTransfers: createInternalTransferTracer({ fetchImpl: net.fetchImpl, rpcUrlFor, blockscoutBaseFor: () => 'https://bs.test', traceTimeoutMs: opts.traceTimeoutMs ?? 2000, blockscoutTimeoutMs: 2000 }),
      deadlineMs: opts.deadlineMs ?? 5000,
      concurrency: opts.concurrency,
    },
  })
  const audit = result.lookups.receiptQuoteRecoveryAudit
  return { result, audit, source: audit.sourceAudit, calls: net.calls, wallMs: Math.round(performance.now() - started) }
}

beforeEach(() => __resetReceiptQuoteTxCacheForTest())

describe('receipt quote recovery — latency and call budget', () => {
  it('tracing supported: no Blockscout call; traces only the 6 unwrap sells that pass every receipt check', async () => {
    const { result, source, calls, audit } = await run({ trace: 'ok', blockscout: 'ok' })
    assert.equal(result.verifiedLots, 9)
    assert.equal(calls.blockscout, 0)
    assert.equal(source.blockscoutCalls, 0)
    assert.equal(source.traceCalls, 6)
    assert.equal(calls.receipt, 12, 'one read per distinct admitted transaction')
    assert.equal(source.receiptCalls, 12)
    // Never traced: buys (no unwrap) and the multicall sell rejected by receipt checks.
    for (const side of audit.sides) {
      if (side.side === 'entry') assert.equal(side.traceAttempts.length, 0, side.txHash)
    }
    assert.equal(audit.sides.find((s) => s.txHash === '0xclawsell7')!.traceAttempts.length, 0, 'rejected multicall is never traced')
  })

  it('tracing explicitly unsupported: exactly one probe, later candidates go straight to Blockscout', async () => {
    const { result, source, calls } = await run({ trace: 'unsupported', blockscout: 'ok' })
    assert.equal(calls.trace, 1)
    assert.equal(source.traceCalls, 1)
    assert.equal(source.traceUnsupportedAfterFirstProbe, true)
    assert.equal(calls.blockscout, 6)
    assert.equal(result.verifiedLots, 9, 'Blockscout-indexed internal transfers still prove the payout')
  })

  it('a trace timeout does not disable tracing for the rest of the scan', async () => {
    const { source, calls, audit } = await run({ trace: 'timeout_first', blockscout: 'error', traceTimeoutMs: 60 })
    assert.equal(source.traceTimeouts, 1)
    assert.equal(source.traceUnsupportedAfterFirstProbe, false)
    assert.equal(calls.trace, 6, 'every later candidate still tries debug_trace')
    assert.equal(audit.sides.find((s) => s.txHash === '0xclawsell1')!.classification, 'native_unwrap_recipient_unverified', 'the timed-out candidate fails closed')
  })

  it('Blockscout pagination is still rejected (incomplete evidence is no evidence)', async () => {
    const { result, audit } = await run({ trace: 'unsupported', blockscout: 'paginated' })
    assert.equal(result.verifiedLots, 4)
    const sell = audit.sides.find((s) => s.txHash === '0xclawsell1')!
    assert.deepEqual(sell.traceAttempts.map((a) => a.outcome), ['unsupported', 'incomplete'], 'the probe candidate also falls through to Blockscout')
    const later = audit.sides.find((s) => s.txHash === '0xclawsell2')!
    assert.deepEqual(later.traceAttempts.map((a) => a.outcome), ['skipped_unsupported', 'incomplete'])
  })

  it('the scan-wide deadline stops further work and never waits on hanging providers', async () => {
    const { result, source, wallMs } = await run({ trace: 'hang', blockscout: 'hang', deadlineMs: 300, traceTimeoutMs: 60_000 })
    assert.ok(source.totalRecoveryMs < 1000, `lane took ${source.totalRecoveryMs}ms`)
    assert.ok(wallMs < 5000, `whole pricing pass took ${wallMs}ms`)
    assert.ok(source.candidatesSkippedByDeadline > 0)
    assert.equal(result.verifiedLots, 4, 'nothing unproven is priced')
  })

  it('concurrency does not change results; completion-ready lots still run first', async () => {
    const serial = await run({ trace: 'ok', blockscout: 'ok', concurrency: 1 })
    __resetReceiptQuoteTxCacheForTest()
    const parallel = await run({ trace: 'ok', blockscout: 'ok', concurrency: 3, delayMs: 15 })
    const shape = (r: typeof serial) => r.audit.sides.map((s) => [s.txHash, s.side, s.class, s.classification, s.applied])
    assert.deepEqual(shape(parallel), shape(serial))
    assert.equal(parallel.result.verifiedLots, serial.result.verifiedLots)
    const budget = await run({ trace: 'ok', blockscout: 'ok', concurrency: 3, maxTxs: 3 })
    assert.deepEqual(budget.audit.callsSpentByClass, { completion_ready: 3, missing_both: 0 })
    assert.equal(budget.result.verifiedLots, 7)
  })

  it('a transaction is fetched once even when requested concurrently (singleflight + process cache)', async () => {
    const net = fakeNetwork({ trace: 'ok', blockscout: 'ok', delayMs: 20 })
    const fetchTx = createReceiptQuoteTxFetcher({ fetchImpl: net.fetchImpl, rpcUrlFor: () => 'https://rpc.test' })
    const [a, b] = await Promise.all([fetchTx('base', '0xclawsell1'), fetchTx('base', '0xclawsell1')])
    const c = await fetchTx('base', '0xclawsell1')
    assert.equal(net.calls.receipt, 1)
    assert.equal(a.status, 'ok')
    assert.deepEqual([a.cacheHit ?? false, b.cacheHit ?? false].sort(), [false, true])
    assert.equal(c.cacheHit, true)
  })

  it('latency report: happy path, unsupported+Blockscout, both unavailable, 12-candidate worst case', async () => {
    const happy = await run({ trace: 'ok', blockscout: 'ok', delayMs: 50 })
    __resetReceiptQuoteTxCacheForTest()
    const fallback = await run({ trace: 'unsupported', blockscout: 'ok', delayMs: 50 })
    __resetReceiptQuoteTxCacheForTest()
    const bothDown = await run({ trace: 'error', blockscout: 'error', delayMs: 50 })
    __resetReceiptQuoteTxCacheForTest()
    const worst = await run({ trace: 'hang', blockscout: 'hang', delayMs: 50, deadlineMs: 500, traceTimeoutMs: 60_000 })
    const row = (name: string, r: Awaited<ReturnType<typeof run>>) => ({
      name, verified: r.result.verifiedLots, laneMs: r.source.totalRecoveryMs,
      receipt: r.calls.receipt, trace: r.calls.trace, blockscout: r.calls.blockscout, skippedByDeadline: r.source.candidatesSkippedByDeadline,
    })
    const report = [row('happy', happy), row('trace_unsupported_blockscout_ok', fallback), row('both_unavailable', bothDown), row('worst_case_12_hanging', worst)]
    console.log(JSON.stringify(report))
    assert.ok(worst.source.totalRecoveryMs < 1500)
    assert.equal(bothDown.result.verifiedLots, 4)
    assert.equal(happy.result.verifiedLots, 9)
  })
})
