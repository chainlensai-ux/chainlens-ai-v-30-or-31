// Receipt quote lane: a side carrying only a market estimate is re-proven from its own transaction,
// and payouts proven to be LP fees no longer take a receipt slot ahead of real trades.
//   npx tsx --test src/pipeline/priceLotsForWallet.estimateUpgrade.test.ts
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { __resetNativePriceResolverForTest, __seedAcceptedNativePriceForTest } from '../modules/nativePriceResolver/index.ts'
import { TRANSFER_TOPIC0, WETH_WITHDRAWAL_TOPIC0, type InternalNativeTransfer, type ReceiptQuoteLog, type ReceiptQuoteTx } from '../lib/receiptQuoteRecovery.ts'
import type { NormalizedEvent } from '../modules/normalization/types'
import type { PriceSourceFn } from '../modules/pricingAtTimeEngine/types'

const WALLET = `0x${'9'.repeat(40)}`
const ROUTER = `0x${'7'.repeat(40)}`
const POOL = `0x${'5'.repeat(40)}`
const PAYER = `0x${'6'.repeat(40)}`
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const TOKEN = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
const SELL_DAY = '2026-04-02'
const ETH_USD = 3300
const RAW = (BigInt(1000) * BigInt(10) ** BigInt(18)).toString()

const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`
const wei = (eth: number) => BigInt(Math.round(eth * 1e6)) * BigInt(10) ** BigInt(12)
const transfer = (token: string, from: string, to: string, raw: bigint): ReceiptQuoteLog => ({ address: token, topics: [TRANSFER_TOPIC0, topic(from), topic(to)], data: word(raw) })

function ev(o: Partial<NormalizedEvent>): NormalizedEvent {
  return { provider: 'alchemy', chain: 'base', txHash: '0x', timestamp: '2026-04-01T00:00:00.000Z', fromAddress: POOL, toAddress: WALLET, contract: TOKEN, symbol: 'CLAW', amount: 1000, amountRaw: RAW, tokenDecimals: 18, direction: 'inbound', ...o }
}
// Buy paid with USDC by the wallet (transaction-priced entry), sold for native ETH through a router
// unwrap the event provider never shows — so the exit only has the provider's market estimate.
function trade(buyTx: string, sellTx: string): NormalizedEvent[] {
  return [
    ev({ txHash: buyTx }),
    ev({ txHash: buyTx, contract: USDC, symbol: 'USDC', amount: 400, amountRaw: '400000000', tokenDecimals: 6, direction: 'outbound', fromAddress: WALLET, toAddress: POOL }),
    ev({ txHash: sellTx, timestamp: `${SELL_DAY}T00:00:00.000Z`, direction: 'outbound', fromAddress: WALLET, toAddress: POOL }),
  ]
}
const nativeSell = (eth: number, token = TOKEN): ReceiptQuoteTx => ({
  status: 'ok', from: WALLET, to: ROUTER, valueWei: '0', input: '0x3593564c0000',
  logs: [transfer(token, WALLET, POOL, BigInt(RAW)), { address: POOL, topics: [V2_SWAP, topic(ROUTER), topic(ROUTER)], data: `0x${'0'.repeat(256)}` }, transfer(WETH, POOL, ROUTER, wei(eth)), { address: WETH, topics: [WETH_WITHDRAWAL_TOPIC0, topic(ROUTER)], data: word(wei(eth)) }],
})
const payoutTrace = (eth: number): InternalNativeTransfer[] => [{ from: WETH, to: ROUTER, valueWei: wei(eth).toString() }, { from: ROUTER, to: WALLET, valueWei: wei(eth).toString() }]

// Market estimate for TOKEN: $0.50 per unit on every day.
const estimate: PriceSourceFn = (token, chain) => (chain === 'base' && token.toLowerCase() === TOKEN ? 0.5 : null)

async function run(opts: { events: NormalizedEvent[]; receipts: Map<string, ReceiptQuoteTx>; traces: Map<string, InternalNativeTransfer[]>; maxTxs?: number; defer?: string[] }) {
  const fetched: string[] = []
  const lookups = await priceLotsForWallet({
    normalizedEvents: opts.events,
    recoveredEvents: [],
    priceSources: { primary: estimate, fallback: estimate },
    receiptQuoteRecovery: {
      walletAddress: WALLET,
      maxTxs: opts.maxTxs,
      fetchTx: async (_chain, txHash) => { fetched.push(txHash); return opts.receipts.get(txHash) ?? { status: 'unavailable' } },
      fetchInternalTransfers: async (_chain, txHash) => {
        const transfers = opts.traces.get(txHash) ?? null
        return { transfers, source: transfers ? 'debug_trace_call_tracer' : null, attempts: [{ source: 'debug_trace', outcome: transfers ? 'ok' : 'unsupported' }] }
      },
      deferEntryTxHashes: new Set(opts.defer ?? []),
    },
  })
  return { lookups, fetched, audit: lookups.receiptQuoteRecoveryAudit }
}

beforeEach(() => {
  __resetNativePriceResolverForTest()
  __seedAcceptedNativePriceForTest(Date.parse(`${SELL_DAY}T12:00:00Z`), ETH_USD, 'coingecko_native_coin_history')
})

describe('receipt quote lane — estimate upgrades', () => {
  it('a sale priced only by a market estimate is re-proven from the ETH its own transaction paid the wallet', async () => {
    const events = trade('0xbuy1', '0xsell1')
    const { lookups, audit } = await run({ events, receipts: new Map([['0xsell1', nativeSell(0.2)]]), traces: new Map([['0xsell1', payoutTrace(0.2)]]) })
    assert.equal(audit.estimateUpgrades.candidates, 1)
    assert.equal(audit.estimateUpgrades.applied, 1)
    assert.ok(Math.abs(lookups.priceUsdLookup(events[2])! - 0.2 * ETH_USD) < 1e-6, 'exact proceeds, not 1000 x $0.50')
    assert.equal(lookups.sidePricingBasisLookup('base', '0xsell1', 'exit'), 'transaction')
    assert.equal(lookups.sidePricingBasisLookup('base', '0xbuy1', 'entry'), 'transaction')
    assert.deepEqual(audit.callsSpentByClass, { completion_ready: 0, missing_both: 0 }, 'upgrades are counted separately')
  })

  it('an upgrade that cannot be proven leaves the estimate exactly as it was', async () => {
    const events = trade('0xbuy1', '0xsell1')
    const { lookups, audit } = await run({ events, receipts: new Map([['0xsell1', nativeSell(0.2)]]), traces: new Map() })
    assert.equal(audit.estimateUpgrades.applied, 0)
    assert.equal(lookups.priceUsdLookup(events[2]), 500)
    assert.equal(lookups.sidePricingBasisLookup('base', '0xsell1', 'exit'), 'estimate')
  })

  it('a side already proven from its own transaction is never re-fetched', async () => {
    const events = trade('0xbuy1', '0xsell1')
    const { fetched } = await run({ events, receipts: new Map([['0xsell1', nativeSell(0.2)]]), traces: new Map([['0xsell1', payoutTrace(0.2)]]) })
    assert.deepEqual(fetched, ['0xsell1'], 'the USDC-priced buy is not a candidate')
  })
})

describe('receipt quote lane — proven LP fee payouts are deferred', () => {
  // Lot A opens from a proven fee payout and is sold; lot B (another token) is an ordinary trade. The
  // payout entry carries only a market estimate, so without the proof it competes for a slot.
  const TOKEN_B = '0x00000000000000000000000000000000000000b2'
  function world() {
    return [
      ev({ txHash: '0xpayout', fromAddress: PAYER }),
      ev({ txHash: '0xsellA', timestamp: `${SELL_DAY}T00:00:00.000Z`, direction: 'outbound', fromAddress: WALLET, toAddress: POOL }),
      ...trade('0xbuyB', '0xsellB').map((e) => (e.contract === TOKEN ? { ...e, contract: TOKEN_B } : e)),
    ]
  }

  it('the payout entry goes to the back of the queue, so real trades get the slots', async () => {
    const { audit, fetched } = await run({ events: world(), receipts: new Map(), traces: new Map(), maxTxs: 1, defer: ['0xpayout'] })
    assert.equal(audit.feePayoutEntriesDeferred, 1)
    assert.equal(audit.sides.at(-1)?.txHash, '0xpayout')
    assert.ok(!fetched.includes('0xpayout'))
    assert.equal(fetched.length, 1)
  })
})

describe('receipt quote lane — receipt-proven unpriceable sides are remembered', () => {
  // Lot P: a token gifted to the wallet (plain transfer in) and sold for USDC; lot V: a USDC buy sold
  // for native ETH, its sale unpriced (no market price for the token). One receipt slot per scan.
  const GIFT = '0x00000000000000000000000000000000000000c3'
  const TOKEN_V = '0x00000000000000000000000000000000000000d4'
  const events = [
    ev({ txHash: '0xgift', contract: GIFT, fromAddress: PAYER }),
    ev({ txHash: '0xsellP', contract: GIFT, timestamp: `${SELL_DAY}T00:00:00.000Z`, direction: 'outbound', fromAddress: WALLET, toAddress: POOL }),
    ev({ txHash: '0xsellP', contract: USDC, symbol: 'USDC', amount: 90, amountRaw: '90000000', tokenDecimals: 6, timestamp: `${SELL_DAY}T00:00:00.000Z`, fromAddress: POOL }),
    ...trade('0xbuyV', '0xsellV').map((e) => (e.contract === TOKEN ? { ...e, contract: TOKEN_V } : e)),
  ]
  const receipts = new Map<string, ReceiptQuoteTx>([
    ['0xgift', { status: 'ok', from: PAYER, to: GIFT, valueWei: '0', input: '0xa9059cbb', logs: [transfer(GIFT, PAYER, WALLET, BigInt(RAW))] }],
    ['0xsellV', nativeSell(0.2, TOKEN_V)],
  ])
  const traces = new Map([['0xsellV', payoutTrace(0.2)]])

  it('the second scan skips the proven plain transfer (keeping its classification) and prices the sale instead', async () => {
    const store = new Map<string, string>()
    const memory = { load: async () => new Map(store), save: async (entries: Array<[string, string]>) => { for (const [k, v] of entries) store.set(k, v) } }
    const runWith = async () => {
      const fetched: string[] = []
      const lookups = await priceLotsForWallet({
        normalizedEvents: events, recoveredEvents: [], priceSources: { primary: estimate, fallback: estimate },
        receiptQuoteRecovery: {
          walletAddress: WALLET, maxTxs: 1, knownUnpriceableSides: memory,
          fetchTx: async (_c, txHash) => { fetched.push(txHash); return receipts.get(txHash) ?? { status: 'unavailable' } },
          fetchInternalTransfers: async (_c, txHash) => ({ transfers: traces.get(txHash) ?? null, source: 'debug_trace_call_tracer', attempts: [{ source: 'debug_trace', outcome: 'ok' }] }),
        },
      })
      return { fetched, audit: lookups.receiptQuoteRecoveryAudit }
    }
    const first = await runWith()
    assert.deepEqual(first.fetched, ['0xgift'])
    assert.equal(first.audit.newlyProvenUnpriceable, 1)
    assert.equal(first.audit.sidesRecoveredByClass.completion_ready, 0)

    const second = await runWith()
    assert.deepEqual(second.fetched, ['0xsellV'])
    assert.equal(second.audit.knownUnpriceableDeferred, 1)
    assert.equal(second.audit.sidesRecoveredByClass.completion_ready, 1)
    const gift = second.audit.sides.find((r) => r.txHash === '0xgift')!
    assert.equal(gift.fetched, false)
    assert.equal(gift.classification, 'true_plain_token_transfer', 'still blocks a daily sample from pricing the gift')
  })

  it('a remembered value that is not a permanent outcome is ignored', async () => {
    const memory = { load: async () => new Map([['base:0xgift:entry:' + GIFT, 'receipt_unavailable']]), save: async () => undefined }
    const lookups = await priceLotsForWallet({
      normalizedEvents: events, recoveredEvents: [], priceSources: { primary: estimate, fallback: estimate },
      receiptQuoteRecovery: { walletAddress: WALLET, maxTxs: 1, knownUnpriceableSides: memory, fetchTx: async (_c, txHash) => receipts.get(txHash) ?? { status: 'unavailable' } },
    })
    assert.equal(lookups.receiptQuoteRecoveryAudit.knownUnpriceableDeferred, 0)
  })
})

describe('receipt quote lane — fully priced estimate lots are re-proven first', () => {
  it('an estimate on a lot that already counts is proven before an unpriced side elsewhere', async () => {
    const GIFT = '0x00000000000000000000000000000000000000c3'
    const events = [
      ev({ txHash: '0xgift', contract: GIFT, fromAddress: PAYER }),
      ev({ txHash: '0xsellP', contract: GIFT, timestamp: `${SELL_DAY}T00:00:00.000Z`, direction: 'outbound', fromAddress: WALLET, toAddress: POOL }),
      ev({ txHash: '0xsellP', contract: USDC, symbol: 'USDC', amount: 90, amountRaw: '90000000', tokenDecimals: 6, timestamp: `${SELL_DAY}T00:00:00.000Z`, fromAddress: POOL }),
      ...trade('0xbuyU', '0xsellU'),
    ]
    const { fetched, audit } = await run({ events, receipts: new Map([['0xsellU', nativeSell(0.2)]]), traces: new Map([['0xsellU', payoutTrace(0.2)]]), maxTxs: 1 })
    assert.deepEqual(fetched, ['0xsellU'])
    assert.equal(audit.estimateUpgrades.applied, 1)
  })
})
