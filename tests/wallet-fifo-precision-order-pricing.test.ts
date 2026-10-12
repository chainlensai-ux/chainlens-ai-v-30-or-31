// Wallet-scanner FIFO / pricing audit fixes:
//  1. exact raw amounts: a full exit of large 18-decimal buys leaves no phantom dust "unmatched sell";
//  2. Robinhood sub-second order: a sell never closes a lot opened by a later block in the same second;
//  3. token↔token swaps priced only from daily token prices are estimates (never verified), and the GoldRush
//     Robinhood price lookup falls back from 'robinhood-mainnet' to '4663'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRobinhoodPnlV1Fifo, priceRobinhoodSwaps, goldrushRobinhoodTokenHistoricalUsd, RH_NATIVE,
  type RhVerifiedSwap, type RhPriceEvidence,
} from '../lib/server/robinhoodPnlV1.ts'
import { robinhoodVerifiedSwapFifoAudit } from '../lib/server/robinhoodVerifiedSwapFifoAudit.ts'
import { buildLots, matchLotsFIFO } from '../src/modules/fifoEngine/index.ts'
import type { NormalizedEvent } from '../src/modules/normalization/types.ts'

const W = '0x9d69b5ffb22608d8003508b9c6bd9f6b458d4184'
const T = '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5'
const U = '0xedbf91223639800bcd5756815caf908df3b890be'
const E18 = BigInt(10) ** BigInt(18)
const swap = (txHash: string, ts: number, block: number, inputToken: string, outputToken: string, inputRaw: bigint, outputRaw: bigint): RhVerifiedSwap => ({
  txHash, blockNumber: block, firstLogIndex: 0, timestampSec: ts, inputToken, outputToken, inputRaw, outputRaw, inputDecimals: 18, outputDecimals: 18, hops: [], intermediary: null,
})
const priced = (s: RhVerifiedSwap): RhPriceEvidence => ({ swapTxHash: s.txHash, inputToken: s.inputToken, outputToken: s.outputToken, inputAmount: 1, outputAmount: 1, inputPriceUsd: 1, outputPriceUsd: 1, inputSource: 'x', outputSource: 'x', bothLegsVerified: true, rejectionReason: null })

// ── 1. exact raw amounts ────────────────────────────────────────────────────────────────────────────
test('a full exit of two large 18-decimal buys closes exactly, with no dust unmatched sell (200 cases)', () => {
  for (let k = 0; k < 200; k++) {
    const a = BigInt('182346336691191146625479') + BigInt(k) * BigInt(7919) * BigInt(10) ** BigInt(12) + BigInt(k * k)
    const b = BigInt('91656553487138517358840') + BigInt(k) * BigInt(104729)
    const s = [swap('0x1', 1000, 1, RH_NATIVE, T, E18 / BigInt(100), a), swap('0x2', 1100, 2, RH_NATIVE, T, E18 / BigInt(100), b), swap('0x3', 2000, 3, T, RH_NATIVE, a + b, E18 / BigInt(50))]
    const { fifo } = buildRobinhoodPnlV1Fifo(W, s, s.map(priced))
    assert.equal(fifo.unmatchedSells, 0, `case ${k}`)
    assert.equal(fifo.matchedLots.length, 2, `case ${k}`)
  }
})

const ev = (txHash: string, ts: string, direction: 'inbound' | 'outbound', amount: number, amountRaw: string | null, tokenDecimals = 18): NormalizedEvent => ({
  provider: 'alchemy', chain: 'base', txHash, timestamp: ts, fromAddress: direction === 'inbound' ? '0xpool' : W, toAddress: direction === 'inbound' ? W : '0xpool',
  contract: T, symbol: 'T', amount, amountRaw, tokenDecimals, direction,
} as unknown as NormalizedEvent)

test('shared engine: raw amounts are used only when they agree with the float amount at the token decimals', () => {
  const a = BigInt('182346336691191146625479'), b = BigInt('91656553487138517358840')
  const f = (x: bigint) => Number(x) / 1e18
  const buys = [ev('0xa', '2026-01-01T00:00:00Z', 'inbound', f(a), a.toString()), ev('0xb', '2026-01-02T00:00:00Z', 'inbound', f(b), b.toString())]
  const sell = ev('0xc', '2026-01-03T00:00:00Z', 'outbound', f(a + b), (a + b).toString())
  const exact = matchLotsFIFO(buildLots(buys, []), [sell])
  assert.deepEqual([exact.unmatchedSells, exact.remainingOpenLots.length], [0, 0])
  // A raw string at a different scale (disagrees with the amount) is ignored: float path, unchanged behaviour.
  const wrongScale = ev('0xc', '2026-01-03T00:00:00Z', 'outbound', f(a + b), ((a + b) * BigInt(1000)).toString())
  const fallback = matchLotsFIFO(buildLots(buys, []), [wrongScale])
  assert.equal(fallback.matchedLots.length, 2, 'still matched on the float amount')
  // No raw at all: float path.
  assert.equal(matchLotsFIFO(buildLots(buys, []), [ev('0xc', '2026-01-03T00:00:00Z', 'outbound', 1, null)]).matchedLots.length, 1)
})

// ── 2. Robinhood sub-second order ───────────────────────────────────────────────────────────────────
test('same second: a sell in block 10 never closes a lot opened by a buy in block 12', () => {
  const sell = swap('0x0a', 1000, 10, T, RH_NATIVE, E18, E18 / BigInt(50))
  const buy = swap('0x0b', 1000, 12, RH_NATIVE, T, E18 / BigInt(100), E18)
  const { fifo } = buildRobinhoodPnlV1Fifo(W, [sell, buy], [priced(sell), priced(buy)])
  assert.deepEqual([fifo.matchedLots.length, fifo.unmatchedSells], [0, 1])
  const audit = robinhoodVerifiedSwapFifoAudit({ chain: 'robinhood', isQuote: (t) => t === RH_NATIVE, canonicalSwaps: [sell, buy], extraSwaps: [], evidence: [priced(sell), priced(buy)], matchedLots: fifo.matchedLots })
  assert.deepEqual([audit.summary.definiteFifoDefect, audit.rows.find((r) => r.side === 'sell')!.exactFifoBlocker], [false, 'buy_after_sell'])
})

test('same second: a buy in block 10 followed by a sell in block 12 still closes the lot', () => {
  const buy = swap('0x0b', 1000, 10, RH_NATIVE, T, E18 / BigInt(100), E18)
  const sell = swap('0x0a', 1000, 12, T, RH_NATIVE, E18, E18 / BigInt(50))
  const { fifo } = buildRobinhoodPnlV1Fifo(W, [sell, buy], [priced(sell), priced(buy)])
  assert.deepEqual([fifo.matchedLots.length, fifo.unmatchedSells, fifo.matchedLots[0].evidenceQuality], [1, 0, 'verified'])
})

// ── 3. daily-price estimates + chain-path fallback ──────────────────────────────────────────────────
const ctxWith = (tokenHistoricalUsd: (t: string, ts: number) => Promise<{ priceUsd: number; source: string } | null>) => ({
  deps: { tokenHistoricalUsd, ethUsdRange: async () => null, now: Date.now },
  rpc: null, deadlineAt: Date.now() + 60_000, priceSidesUsed: 0,
  m: { historicalPriceCalls: 0, cacheHits: 0 },
}) as unknown as Parameters<typeof priceRobinhoodSwaps>[0]

test('token↔token swap priced only by daily token prices is an estimate: not verified, lot unpriced, estimate reported', async () => {
  const daily = async (t: string) => ({ priceUsd: t === T ? 2 : 0.5, source: 'goldrush_historical_exact_token_day' })
  const buy = swap('0x1b', 1_790_000_000, 1, U, T, E18 * BigInt(4), E18)            // 4 U → 1 T
  const sell = swap('0x1c', 1_790_086_400, 2, T, U, E18, E18 * BigInt(10))          // 1 T → 10 U
  const evidence = await priceRobinhoodSwaps(ctxWith(daily), [buy, sell])
  for (const e of evidence) {
    assert.equal(e.bothLegsVerified, false)
    assert.match(e.rejectionReason ?? '', /daily_provider_price_estimate_only/)
    assert.ok(e.dailyEstimate)
  }
  const { fifo, estimated } = buildRobinhoodPnlV1Fifo(W, [buy, sell], evidence)
  const tLot = fifo.matchedLots.find((l) => l.token === T)!
  assert.equal(tLot.evidenceQuality, 'unpriced', 'never a verified lot')
  assert.ok(estimated.closedLots >= 1)
  assert.equal(typeof estimated.realizedPnlUsd, 'number')
})

test('a swap with an ETH leg keeps exact execution pricing and stays verified (unchanged)', async () => {
  const ctx = ctxWith(async () => null)
  ;(ctx as unknown as { deps: Record<string, unknown> }).deps.ethUsdAt = async (ts: number) => ({ priceUsd: 2600, provider: 'p', endpoint: null, pointMs: ts * 1000, gapMs: 0, maxAllowedGapMs: 86_400_000 })
  const [e] = await priceRobinhoodSwaps(ctx, [swap('0x2b', 1_790_000_000, 1, RH_NATIVE, T, E18 / BigInt(100), E18)])
  assert.deepEqual([e.bothLegsVerified, e.dailyEstimate, e.outputSource], [true, undefined, 'v4_exact_swap_execution'])
})

test("GoldRush historical token price: 'robinhood-mainnet' miss falls back to '4663'; a hit never makes a second call", async () => {
  const prev = process.env.GOLDRUSH_API_KEY
  process.env.GOLDRUSH_API_KEY = 'k'
  try {
    const ts = 1_790_000_000
    const day = new Date(ts * 1000).toISOString().slice(0, 10)
    const body = { data: [{ contract_address: T, items: [{ date: day, price: 1.25 }] }] }
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return url.includes('/robinhood-mainnet/') ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => body }
    }) as unknown as Parameters<typeof goldrushRobinhoodTokenHistoricalUsd>[0]
    const hit = await goldrushRobinhoodTokenHistoricalUsd(fetchImpl)(T, ts)
    assert.equal(hit?.priceUsd, 1.25)
    assert.deepEqual(calls.map((u) => u.includes('/4663/') ? '4663' : 'robinhood-mainnet'), ['robinhood-mainnet', '4663'])
    const calls2: string[] = []
    const okFirst = (async (url: string) => { calls2.push(url); return { ok: true, status: 200, json: async () => body } }) as unknown as Parameters<typeof goldrushRobinhoodTokenHistoricalUsd>[0]
    assert.equal((await goldrushRobinhoodTokenHistoricalUsd(okFirst)(T, ts))?.priceUsd, 1.25)
    assert.equal(calls2.length, 1)
  } finally {
    if (prev === undefined) delete process.env.GOLDRUSH_API_KEY; else process.env.GOLDRUSH_API_KEY = prev
  }
})
