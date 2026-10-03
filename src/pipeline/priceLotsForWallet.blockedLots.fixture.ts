// Production-shaped fixture for the 1clawAI blocked-lot follow-up: 13 closed lots, 4 verified via
// accepted evidence (other tokens), 9 blocked 1clawAI lots whose normalized activity has no usable
// opposite leg for at least one side. Receipts are built from the exact event layout a Base router
// swap emits (Transfer / WETH Deposit / WETH Withdrawal / pair Swap). Nothing is inferred from a
// symbol; ETH/USD comes from the seeded historical resolver bucket for each trade day.

import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { isCanonicalVerifiedPublishedLot } from '../lib/canonicalVerifiedLot'
import { lotIdentityVersion, buildAcceptedEvidenceEnvelope, writeAcceptedEvidence, type AcceptedEvidenceKvLike } from '../lib/acceptedEvidenceStore.ts'
import { __resetNativePriceResolverForTest, __seedAcceptedNativePriceForTest } from '../modules/nativePriceResolver/index.ts'
import { NATIVE_ASSET_ADDRESS } from '../modules/providerFetchWindow/utils.ts'
import { TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type ReceiptQuoteLog, type ReceiptQuoteTx } from '../lib/receiptQuoteRecovery.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

export const CLAW = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
export const WALLET = `0x${'9'.repeat(40)}`
const ROUTER = `0x${'7'.repeat(40)}`
const POOL = `0x${'5'.repeat(40)}`
const FRIEND = `0x${'6'.repeat(40)}`
const OTHER_TOKEN = `0x${'4'.repeat(40)}`
const WETH = '0x4200000000000000000000000000000000000006'
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
export const ETH_USD_BUY_DAY = 3000
export const ETH_USD_SELL_DAY = 3300
const BUY_DAY = '2026-04-01'
const SELL_DAY = '2026-04-02'
const CLAW_AMOUNT = 1000
const CLAW_RAW = BigInt(CLAW_AMOUNT) * BigInt(10) ** BigInt(18)

const wei = (eth: number) => BigInt(Math.round(eth * 1e6)) * BigInt(10) ** BigInt(12)
const topic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const transfer = (token: string, from: string, to: string, raw: bigint): ReceiptQuoteLog => ({ address: token, topics: [TRANSFER_TOPIC0, topic(from), topic(to)], data: word(raw) })
const deposit = (dst: string, raw: bigint): ReceiptQuoteLog => ({ address: WETH, topics: [WETH_DEPOSIT_TOPIC0, topic(dst)], data: word(raw) })
const withdrawal = (src: string, raw: bigint): ReceiptQuoteLog => ({ address: WETH, topics: [WETH_WITHDRAWAL_TOPIC0, topic(src)], data: word(raw) })
const swap = (): ReceiptQuoteLog => ({ address: POOL, topics: [V2_SWAP, topic(ROUTER), topic(ROUTER)], data: `0x${'0'.repeat(256)}` })
const okTx = (from: string, valueWei: bigint, logs: ReceiptQuoteLog[]): ReceiptQuoteTx => ({ status: 'ok', from, to: ROUTER, valueWei: valueWei.toString(), input: '0x3593564c0000', logs })
// How much internal-transfer trace evidence the sell receipts carry:
//   'unavailable'       — receipts only (what f9a98df1's fixture had): the unwrap recipient is unproven.
//   'proven_to_wallet'  — a callTracer trace shows WETH -> router -> scanned wallet for the full amount.
export type SellTraceEvidence = 'unavailable' | 'proven_to_wallet'
let sellTraceEvidence: SellTraceEvidence = 'unavailable'

// Router buy paid with native ETH via tx.value: wrap -> pool -> wallet receives CLAW.
const nativeBuy = (eth: number, depositEth = eth) => okTx(WALLET, wei(eth), [deposit(ROUTER, wei(depositEth)), transfer(WETH, ROUTER, POOL, wei(depositEth)), swap(), transfer(CLAW, POOL, WALLET, CLAW_RAW)])
// Router sell paid out as native ETH: wallet -> pool CLAW, pool -> router WETH, router unwraps.
const nativeSell = (eth: number, extra: ReceiptQuoteLog[] = []): ReceiptQuoteTx => ({
  ...okTx(WALLET, BigInt(0), [transfer(CLAW, WALLET, POOL, CLAW_RAW), swap(), transfer(WETH, POOL, ROUTER, wei(eth)), withdrawal(ROUTER, wei(eth)), ...extra]),
  ...(sellTraceEvidence === 'proven_to_wallet'
    ? { internalTransfers: [{ from: WETH, to: ROUTER, valueWei: wei(eth).toString() }, { from: ROUTER, to: WALLET, valueWei: wei(eth).toString() }], traceSource: 'debug_trace_call_tracer' as const }
    : { internalTransfers: null, traceSource: null }),
})

export type BlockedLotKind =
  | 'completion_ready_native_unwrap_exit'
  | 'missing_both_native_value_and_unwrap'
  | 'plain_transfer_in_entry'
  | 'multicall_exit'
  | 'refund_unaccounted_entry'
  | 'receipt_unavailable'

export const BLOCKED_LOT_KINDS: BlockedLotKind[] = [
  'completion_ready_native_unwrap_exit', 'completion_ready_native_unwrap_exit', 'completion_ready_native_unwrap_exit',
  'missing_both_native_value_and_unwrap', 'missing_both_native_value_and_unwrap',
  'plain_transfer_in_entry',
  'multicall_exit',
  'refund_unaccounted_entry',
  'receipt_unavailable',
]

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    provider: 'alchemy', chain: 'base', txHash: '0x', timestamp: `${BUY_DAY}T00:00:00.000Z`,
    fromAddress: POOL, toAddress: WALLET, contract: CLAW, symbol: '1clawAI',
    amount: CLAW_AMOUNT, amountRaw: CLAW_RAW.toString(), tokenDecimals: 18, direction: 'inbound', ...o,
  }
}

export function buildBlockedLotFixture(traces: SellTraceEvidence = 'unavailable') {
  sellTraceEvidence = traces
  const events: NormalizedEvent[] = []
  const receipts = new Map<string, ReceiptQuoteTx>()
  const lots: Array<{ kind: BlockedLotKind; buyTx: string; sellTx: string }> = []

  // 4 lots already verified by accepted evidence (other tokens, prior scans).
  for (let i = 0; i < 4; i++) {
    const token = `0x${(0xc000 + i).toString(16).padStart(40, '0')}`
    events.push(
      ev({ txHash: `0xverbuy${i}`, contract: token, symbol: `V${i}`, timestamp: `2026-03-0${i + 1}T00:00:00.000Z` }),
      ev({ txHash: `0xversell${i}`, contract: token, symbol: `V${i}`, direction: 'outbound', fromAddress: WALLET, toAddress: POOL, timestamp: `2026-03-0${i + 1}T06:00:00.000Z` }),
    )
  }

  BLOCKED_LOT_KINDS.forEach((kind, index) => {
    const hour = String(index + 1).padStart(2, '0')
    const buyTx = `0xclawbuy${index + 1}`
    const sellTx = `0xclawsell${index + 1}`
    const buyEth = 0.1 + index * 0.01
    const sellEth = 0.12 + index * 0.01
    events.push(
      ev({ txHash: buyTx, timestamp: `${BUY_DAY}T${hour}:00:00.000Z`, fromAddress: kind === 'plain_transfer_in_entry' ? FRIEND : POOL }),
      ev({ txHash: sellTx, timestamp: `${SELL_DAY}T${hour}:00:00.000Z`, direction: 'outbound', fromAddress: WALLET, toAddress: POOL }),
    )
    lots.push({ kind, buyTx, sellTx })
    switch (kind) {
      case 'completion_ready_native_unwrap_exit':
        // GoldRush synthesized this buy's tx.value leg, so the same-tx lane already prices the entry.
        events.push(ev({ txHash: buyTx, timestamp: `${BUY_DAY}T${hour}:00:00.000Z`, contract: NATIVE_ASSET_ADDRESS, symbol: 'ETH', amount: buyEth, amountRaw: wei(buyEth).toString(), direction: 'outbound', fromAddress: WALLET, toAddress: ROUTER }))
        receipts.set(sellTx, nativeSell(sellEth))
        break
      case 'missing_both_native_value_and_unwrap':
        receipts.set(buyTx, nativeBuy(buyEth))
        receipts.set(sellTx, nativeSell(sellEth))
        break
      case 'plain_transfer_in_entry':
        receipts.set(buyTx, { status: 'ok', from: FRIEND, to: CLAW, valueWei: '0', input: '0xa9059cbb', logs: [transfer(CLAW, FRIEND, WALLET, CLAW_RAW)] })
        receipts.set(sellTx, nativeSell(sellEth))
        break
      case 'multicall_exit':
        receipts.set(buyTx, nativeBuy(buyEth))
        receipts.set(sellTx, nativeSell(sellEth, [transfer(OTHER_TOKEN, POOL, WALLET, BigInt(5))]))
        break
      case 'refund_unaccounted_entry':
        receipts.set(buyTx, nativeBuy(0.2, 0.15))
        receipts.set(sellTx, nativeSell(sellEth))
        break
      case 'receipt_unavailable':
        break
    }
  })

  // Open positions (never sold) bought with native ETH: the same-tx lane prices these, but they can
  // never complete a closed lot — the production "27 not on any closed lot" shape.
  for (let j = 0; j < 5; j++) {
    const tx = `0xopenbuy${j}`
    events.push(
      ev({ txHash: tx, contract: `0x${(0xd000 + j).toString(16).padStart(40, '0')}`, symbol: `O${j}`, amount: 10, amountRaw: (BigInt(10) * BigInt(10) ** BigInt(18)).toString() }),
      ev({ txHash: tx, contract: NATIVE_ASSET_ADDRESS, symbol: 'ETH', amount: 0.05, amountRaw: wei(0.05).toString(), direction: 'outbound', fromAddress: WALLET, toAddress: ROUTER }),
    )
  }
  return { events, receipts, lots }
}

function fakeKv(): AcceptedEvidenceKvLike {
  const store = new Map<string, unknown>()
  return {
    get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown) => { store.set(key, value); return 'OK' },
  }
}

export async function runBlockedLotFixture(options: { receiptLane: boolean; maxTxs?: number; coinPaprikaFetchImpl?: typeof fetch; sellTraces?: SellTraceEvidence } = { receiptLane: true }) {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(Date.parse(`${BUY_DAY}T12:00:00Z`), ETH_USD_BUY_DAY, 'coingecko_native_coin_history')
  __seedAcceptedNativePriceForTest(Date.parse(`${SELL_DAY}T12:00:00Z`), ETH_USD_SELL_DAY, 'coingecko_native_coin_history')
  const { events, receipts, lots } = buildBlockedLotFixture(options.sellTraces ?? 'unavailable')
  const kv = fakeKv()
  const now = Date.parse('2026-04-05T00:00:00Z')
  for (let i = 0; i < 4; i++) {
    const buy = events.find((e) => e.txHash === `0xverbuy${i}`)!
    const sell = events.find((e) => e.txHash === `0xversell${i}`)!
    const version = lotIdentityVersion({ chain: buy.chain, token: buy.contract, openedTxHash: buy.txHash, closedTxHash: sell.txHash, openedAt: Date.parse(buy.timestamp), closedAt: Date.parse(sell.timestamp), amount: buy.amount })
    for (const [side, e, value] of [['entry', buy, 500], ['exit', sell, 550]] as const) {
      const identity = { chain: e.chain, token: e.contract, txHash: e.txHash, side, timestamp: Date.parse(e.timestamp), lotIdentityVersion: version }
      await writeAcceptedEvidence(kv, buildAcceptedEvidenceEnvelope({ identity, priceUsd: value, valueUsd: value, source: 'test', evidenceType: 'chain-aware-historical', providerTimestampBucket: null, now }))
    }
  }
  let receiptCalls = 0
  let historicalCalls = 0
  const nullSource: PriceSourceFn = () => { historicalCalls += 1; return null }
  const warnings: Array<{ tag: string; payload: unknown }> = []
  const originalWarn = console.warn
  console.warn = (tag: unknown, payload?: unknown) => { warnings.push({ tag: String(tag), payload }) }
  const priorPaprika = process.env.COINPAPRIKA_HISTORICAL_ENABLED
  if (!options.coinPaprikaFetchImpl) process.env.COINPAPRIKA_HISTORICAL_ENABLED = 'false'
  let lookups
  try {
    lookups = await priceLotsForWallet({
      normalizedEvents: events,
      recoveredEvents: [],
      priceSources: { primary: nullSource, fallback: nullSource },
      acceptedEvidenceKv: kv,
      now: () => now,
      coinPaprikaFetchImpl: options.coinPaprikaFetchImpl,
      receiptQuoteRecovery: options.receiptLane
        ? { walletAddress: WALLET, maxTxs: options.maxTxs, fetchTx: async (_chain, txHash) => { receiptCalls += 1; return receipts.get(txHash) ?? { status: 'unavailable' } } }
        : undefined,
    })
  } finally {
    console.warn = originalWarn
    if (priorPaprika === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED
    else process.env.COINPAPRIKA_HISTORICAL_ENABLED = priorPaprika
  }
  const sells = events.filter((e) => e.direction === 'outbound')
  const { matchedLots } = matchLotsFIFO(buildLots(events, [], lookups.priceUsdLookup), sells, lookups.priceUsdLookup)
  const verified = matchedLots.filter((l) => isCanonicalVerifiedPublishedLot(l))
  const coverage = warnings.find((w) => w.tag === '[historical-quote-leg-coverage]')?.payload as Record<string, number> | undefined
  return {
    lots, lookups, matchedLots, warnings,
    closedLots: matchedLots.length,
    verifiedLots: verified.length,
    coveragePct: Math.round((verified.length / matchedLots.length) * 10000) / 100,
    verifiedClawLotTxs: new Set(verified.filter((l) => l.token.toLowerCase() === CLAW).map((l) => l.closedTxHash)),
    sameTxLotsCompleted: coverage?.actualLotsCompletedByQuote ?? null,
    receiptCalls,
    historicalCalls,
  }
}
