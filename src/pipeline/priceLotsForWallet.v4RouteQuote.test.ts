// Token-to-token receipt quotes through exact Uniswap V4 routes, modeled on the 4 production 1clawAI
// receipts rejected after 391907b8. Confirmed from production: the target amounts, the USDbC amount,
// 3 V4 Swap events per tx, the wallet-side token directions. Modeled (not in the forensic summary):
// the full addresses behind the 0x753f…/0x67a7… prefixes, the per-hop amounts, and which canonical
// intermediary the route passes through. Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.v4RouteQuote.test.ts

import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyReceiptQuoteEvidence, SWAP_TOPIC0S, TRANSFER_TOPIC0, type ReceiptQuoteTx } from '../lib/receiptQuoteRecovery.ts'
import { createV4PoolKeyResolver, decodeV4RouteQuote, NATIVE_CURRENCY, V4_POOL_MANAGERS, V4_SWAP_TOPIC0, V4_INITIALIZE_TOPIC0, __resetV4PoolKeyCacheForTest, type V4PoolCurrencies } from '../lib/v4RouteQuote.ts'
import { priceLotsForWallet } from './priceLotsForWallet.ts'
import { buildLots, matchLotsFIFO } from '../modules/fifoEngine/index'
import { isCanonicalVerifiedPublishedLot } from '../lib/canonicalVerifiedLot'
import { __resetNativePriceResolverForTest, __seedAcceptedNativePriceForTest } from '../modules/nativePriceResolver/index.ts'
import type { NormalizedEvent } from '../modules/normalization/types'

const CLAW = '0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3'
const WALLET = `0x${'9'.repeat(40)}`
const ROUTER = `0x${'7'.repeat(40)}`
const FEE_RECIPIENT = `0x${'8'.repeat(40)}`
const PM = V4_POOL_MANAGERS.base!
const TOKEN_753F = '0x753f2af0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' // modeled full address (prefix from production)
const TOKEN_67A7 = '0x67a7ca08bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' // modeled full address (prefix from production)
const MID = '0x3333333333333333333333333333333333333333' // a non-canonical hop token (e.g. a launchpad pair token)
const WETH = '0x4200000000000000000000000000000000000006'
const USDBC = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'
const E18 = BigInt(10) ** BigInt(18)
const units = (whole: string, decimals = 18) => {
  const [i, f = ''] = whole.split('.')
  return BigInt(i) * BigInt(10) ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals))
}

const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
const word = (v: bigint) => `${(v < BigInt(0) ? BigInt(2) ** BigInt(256) + v : v).toString(16).padStart(64, '0')}`
const poolIdFor = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const transfer = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [TRANSFER_TOPIC0, topic(from), topic(to)], data: `0x${word(v)}` })
// V4 Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee); deltas from the swapper's view
// (negative = paid into the pool) unless `flip` models the opposite reporting convention.
const v4Swap = (poolId: string, amount0: bigint, amount1: bigint, flip = false) => ({
  address: PM,
  topics: [V4_SWAP_TOPIC0, poolId, topic(ROUTER)],
  data: `0x${word(flip ? -amount0 : amount0)}${word(flip ? -amount1 : amount1)}${word(E18)}${word(E18)}${word(BigInt(0))}${word(BigInt(3000))}`,
})
const ordered = (a: string, b: string): [string, string] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a])
// One hop: `inToken` paid (inRaw), `outToken` received (outRaw), with the pool's own currency order.
function hop(n: number, inToken: string, inRaw: bigint, outToken: string, outRaw: bigint, flip = false) {
  const [c0, c1] = ordered(inToken, outToken)
  const a0 = c0 === inToken ? -inRaw : outRaw
  const a1 = c1 === inToken ? -inRaw : outRaw
  return { log: v4Swap(poolIdFor(n), a0, a1, flip), key: [poolIdFor(n), { currency0: c0, currency1: c1 }] as [string, V4PoolCurrencies] }
}
const okTx = (logs: Array<{ address: string; topics: string[]; data: string }>): ReceiptQuoteTx => ({ status: 'ok', from: WALLET, to: ROUTER, valueWei: '0', input: '0x3593564c', logs })

// ---- production-shaped receipts ----------------------------------------------------------------
const DD_TARGET = units('565818131.2763674')
const E03_TARGET = units('106506954.99913405')
const A99_TARGET = units('98746705.02925444')
const A99_RECEIVED = units('98517952.49812987')
const E61_USDBC = units('385.592909', 6)

function dd4229(opts: { hookFeeOnEth?: bigint; flip?: boolean } = {}) {
  const xIn = units('1250000')
  const ethOut = units('0.67')
  const fee = opts.hookFeeOnEth ?? BigInt(0)
  const h1 = hop(1, TOKEN_753F, xIn, NATIVE_CURRENCY, ethOut, opts.flip)
  const h2 = hop(2, NATIVE_CURRENCY, ethOut - fee, MID, units('5000'), opts.flip)
  const h3 = hop(3, MID, units('5000'), CLAW, DD_TARGET, opts.flip)
  return {
    tx: okTx([transfer(TOKEN_753F, WALLET, PM, xIn), h1.log, h2.log, h3.log, transfer(CLAW, PM, WALLET, DD_TARGET)]),
    keys: new Map([h1.key, h2.key, h3.key]),
    ethToTarget: ethOut - fee,
  }
}
function e03e40() {
  const xIn = units('42000')
  const h1 = hop(11, TOKEN_67A7, xIn, MID, units('900'))
  const h2 = hop(12, MID, units('900'), WETH, units('0.125'))
  const h3 = hop(13, WETH, units('0.125'), CLAW, E03_TARGET)
  return { tx: okTx([transfer(TOKEN_67A7, WALLET, PM, xIn), h1.log, h2.log, h3.log, transfer(CLAW, PM, WALLET, E03_TARGET)]), keys: new Map([h1.key, h2.key, h3.key]) }
}
function a99ff4() {
  const h1 = hop(21, CLAW, A99_TARGET, NATIVE_CURRENCY, units('0.11'))
  const h2 = hop(22, NATIVE_CURRENCY, units('0.11'), MID, units('800'))
  const h3 = hop(23, MID, units('800'), TOKEN_67A7, A99_RECEIVED)
  return { tx: okTx([transfer(CLAW, WALLET, PM, A99_TARGET), h1.log, h2.log, h3.log, transfer(TOKEN_67A7, PM, WALLET, A99_RECEIVED)]), keys: new Map([h1.key, h2.key, h3.key]) }
}
function e61a30(retainedFee: bigint) {
  // Wallet pays USDbC to the router; the router keeps a fee and settles the rest into the PoolManager.
  const settled = E61_USDBC - retainedFee
  return okTx([
    transfer(USDBC, WALLET, ROUTER, E61_USDBC),
    ...(retainedFee > BigInt(0) ? [transfer(USDBC, ROUTER, FEE_RECIPIENT, retainedFee)] : []),
    transfer(USDBC, ROUTER, PM, settled),
    hop(31, USDBC, settled, NATIVE_CURRENCY, units('0.115')).log,
    hop(32, NATIVE_CURRENCY, units('0.115'), MID, units('810')).log,
    hop(33, MID, units('810'), CLAW, A99_TARGET).log,
    transfer(CLAW, PM, WALLET, A99_TARGET),
  ])
}

const base = { chain: 'base' as const, walletAddress: WALLET, targetToken: CLAW, targetDecimals: 18 }

beforeEach(() => __resetV4PoolKeyCacheForTest())

describe('token-to-token V4 route quotes — production receipt shapes', () => {
  it('0xdd4229 entry: X -> ETH -> MID -> 1clawAI is one proven route; quote = ETH entering the target side', () => {
    const { tx, keys } = dd4229()
    const pending = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 565818131.2763674, tx })
    assert.equal(pending.classification, 'token_to_token_swap_no_canonical_quote')
    assert.deepEqual(pending.needsV4PoolKeys?.length, 3)
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 565818131.2763674, tx, v4PoolKeys: keys })
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.deepEqual(r.quote, { kind: 'native', token: 'native', quantity: 0.67 })
    assert.equal(r.forensics?.v4Route?.hops.length, 3)
  })

  it('0x03e40c entry: route through canonical WETH is proven; quote = WETH entering the final hop', () => {
    const { tx, keys } = e03e40()
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 106506954.99913405, tx, v4PoolKeys: keys })
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.deepEqual(r.quote, { kind: 'native', token: WETH, quantity: 0.125 })
  })

  it('0xa99ff4 exit: 1clawAI -> ETH -> MID -> 0x67a7; quote = ETH produced from the target', () => {
    const { tx, keys } = a99ff4()
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'exit', targetAmount: 98746705.02925444, tx, v4PoolKeys: keys })
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.deepEqual(r.quote, { kind: 'native', token: 'native', quantity: 0.11 })
  })

  it('0xe61a30 entry: USDbC (address-verified) funds the target path; a bounded router fee is protocol_fee_on_target_path', () => {
    const fee = units('0.963982', 6) // 0.25%
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 98746705.02925444, tx: e61a30(fee) })
    assert.equal(r.classification, 'quote_leg_omitted_from_provider_activity')
    assert.deepEqual(r.quote, { kind: 'stable', token: USDBC, quantity: 385.592909 })
    assert.deepEqual(r.forensics?.pathFees, [{ kind: 'protocol_fee_on_target_path', address: FEE_RECIPIENT, token: USDBC, raw: fee.toString() }])
  })

  it('0xe61a30 with a retained amount far above a fee stays unverified (unrelated_second_economic_action)', () => {
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 98746705.02925444, tx: e61a30(units('100', 6)) })
    assert.equal(r.classification, 'unrelated_second_economic_action')
    assert.equal(r.quote, null)
  })
})

describe('V4 route decoder — fail closed', () => {
  const decode = (tx: ReceiptQuoteTx, keys: Map<string, V4PoolCurrencies>, extra: { side?: 'entry' | 'exit' } = {}) => {
    if (tx.status !== 'ok') throw new Error('fixture')
    return decodeV4RouteQuote({
      chain: 'base', side: extra.side ?? 'entry', target: CLAW, quoteToken: TOKEN_753F,
      walletInRaw: units('1250000'), walletOutRaw: DD_TARGET, logs: tx.logs, poolKeys: keys, swapTopic0s: new Set(Object.keys(SWAP_TOPIC0S)),
    })
  }
  it('is independent of the delta sign convention', () => {
    const { tx, keys } = dd4229({ flip: true })
    const r = decode(tx, keys)
    assert.equal(r.status, 'route_proven')
  })
  it('an unproven pool key fails closed', () => {
    const { tx, keys } = dd4229()
    keys.delete(poolIdFor(2))
    assert.equal(decode(tx, keys).status, 'pool_key_unproven')
  })
  it('a bounded hook fee between hops is recorded; the quote is the ETH actually passed toward the target', () => {
    const { tx, keys, ethToTarget } = dd4229({ hookFeeOnEth: units('0.002') })
    const r = decode(tx, keys)
    assert.equal(r.status, 'route_proven')
    if (r.status !== 'route_proven') return
    assert.equal(r.intermediary.raw, ethToTarget.toString())
    assert.deepEqual(r.fees.map((f) => [f.kind, f.currency, f.raw]), [['protocol_fee_on_target_path', NATIVE_CURRENCY, units('0.002').toString()]])
  })
  it('a large leftover between hops could fund another action: rejected', () => {
    const { tx, keys } = dd4229({ hookFeeOnEth: units('0.3') })
    assert.equal(decode(tx, keys).status, 'unrelated_second_economic_action')
  })
  it('a swap that does not chain into the route is rejected', () => {
    const { tx, keys } = dd4229()
    if (tx.status !== 'ok') return
    const stray = hop(99, MID, units('1'), TOKEN_67A7, units('2'))
    keys.set(stray.key[0], stray.key[1])
    const logs = [...tx.logs.slice(0, 4), stray.log, ...tx.logs.slice(4)]
    assert.equal(decode({ ...tx, logs }, keys).status, 'route_does_not_chain')
  })
  it('a token outside the route moving in the tx is a second economic action', () => {
    const { tx, keys } = dd4229()
    if (tx.status !== 'ok') return
    assert.equal(decode({ ...tx, logs: [...tx.logs, transfer(TOKEN_67A7, ROUTER, FEE_RECIPIENT, BigInt(5))] }, keys).status, 'unrelated_second_economic_action')
  })
  it('a route with no canonical intermediary is not priced', () => {
    const h1 = hop(41, TOKEN_753F, units('10'), MID, units('20'))
    const h2 = hop(42, MID, units('20'), CLAW, DD_TARGET)
    const tx = okTx([transfer(TOKEN_753F, WALLET, PM, units('10')), h1.log, h2.log, transfer(CLAW, PM, WALLET, DD_TARGET)])
    if (tx.status !== 'ok') return
    const r = decodeV4RouteQuote({ chain: 'base', side: 'entry', target: CLAW, quoteToken: TOKEN_753F, walletInRaw: units('10'), walletOutRaw: DD_TARGET, logs: tx.logs, poolKeys: new Map([h1.key, h2.key]), swapTopic0s: new Set(Object.keys(SWAP_TOPIC0S)) })
    assert.equal(r.status, 'no_canonical_intermediary_on_route')
  })
})

describe('pool key proof', () => {
  it('reads Initialize once per pool (process cache) and only trusts the canonical PoolManager', async () => {
    let calls = 0
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1
      const id = JSON.parse(String(init?.body)).params[0].topics[1]
      const log = { address: id === poolIdFor(2) ? '0xdeadbeef00000000000000000000000000000000' : PM, topics: [V4_INITIALIZE_TOPIC0, id, topic(NATIVE_CURRENCY), topic(MID)], data: '0x' }
      return Response.json({ jsonrpc: '2.0', id: 1, result: [log] })
    }) as typeof fetch
    const resolve = createV4PoolKeyResolver({ fetchImpl, rpcUrlFor: () => 'https://rpc.test' })
    const first = await resolve('base', [poolIdFor(1), poolIdFor(2)])
    assert.deepEqual(first.get(poolIdFor(1)), { currency0: NATIVE_CURRENCY, currency1: MID })
    assert.equal(first.has(poolIdFor(2)), false, 'an Initialize from another contract is not proof')
    await resolve('base', [poolIdFor(1)])
    assert.equal(calls, 2, 'pool 1 served from cache on the second scan')
  })
})

describe('lane: 0xdd4229 entry shared by 5 lot fragments is hydrated once', () => {
  const ETH_USD = 3300
  const BUY_TS = '2026-09-20T10:00:00.000Z'
  const ev = (o: Partial<NormalizedEvent>): NormalizedEvent => ({
    provider: 'alchemy', chain: 'base', txHash: '0x', timestamp: BUY_TS, fromAddress: PM, toAddress: WALLET,
    contract: CLAW, symbol: '1clawAI', amount: 0, amountRaw: '0', tokenDecimals: 18, direction: 'inbound', ...o,
  })
  it('one receipt read, 3 pool-key reads, 0 provider calls; all 5 lots complete', async () => {
    __resetNativePriceResolverForTest()
    __seedAcceptedNativePriceForTest(Date.parse(BUY_TS), ETH_USD, 'coingecko_native_coin_history')
    const { tx, keys } = dd4229()
    const buyTx = '0xdd4229cccae1f56f4782ffd8de227b45b17b190a9b391f2e42661601fed435fa'
    const events: NormalizedEvent[] = [
      ev({ txHash: buyTx, amount: 565818131.2763674, amountRaw: DD_TARGET.toString() }),
      ev({ txHash: buyTx, contract: TOKEN_753F, symbol: 'X', amount: 1250000, amountRaw: units('1250000').toString(), direction: 'outbound', fromAddress: WALLET, toAddress: PM }),
    ]
    // 5 sells that split the position (5 lot fragments), each with a same-tx USDC quote.
    const fifth = DD_TARGET / BigInt(5)
    for (let i = 0; i < 5; i++) {
      const sellTx = `0xsellfrag${i}`
      const ts = `2026-09-2${1 + i}T10:00:00.000Z`
      events.push(
        ev({ txHash: sellTx, timestamp: ts, amount: Number(fifth) / 1e18, amountRaw: fifth.toString(), direction: 'outbound', fromAddress: WALLET, toAddress: PM }),
        ev({ txHash: sellTx, timestamp: ts, contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', amount: 500, amountRaw: '500000000', tokenDecimals: 6, direction: 'unknown', fromAddress: PM, toAddress: ROUTER }),
      )
    }
    let receiptCalls = 0
    let keyCalls = 0
    let providerCalls = 0
    const prior = process.env.COINPAPRIKA_HISTORICAL_ENABLED
    process.env.COINPAPRIKA_HISTORICAL_ENABLED = 'false'
    const originalWarn = console.warn
    console.warn = () => undefined
    let lookups
    try {
      lookups = await priceLotsForWallet({
        normalizedEvents: events, recoveredEvents: [],
        priceSources: { primary: () => null, fallback: () => null },
        receiptQuoteRecovery: {
          walletAddress: WALLET,
          fetchTx: async (_c, hash) => { receiptCalls += 1; return hash === buyTx ? tx : { status: 'unavailable' } },
          resolveV4PoolKeys: async (_c, ids) => { keyCalls += ids.length; return new Map(ids.map((id) => [id, keys.get(id)!])) },
          quoteTokenHistoricalPrice: () => { providerCalls += 1; return null },
        },
      })
    } finally {
      console.warn = originalWarn
      if (prior === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED; else process.env.COINPAPRIKA_HISTORICAL_ENABLED = prior
    }
    const sells = events.filter((e) => e.direction === 'outbound')
    const { matchedLots } = matchLotsFIFO(buildLots(events, [], lookups.priceUsdLookup), sells, lookups.priceUsdLookup)
    const clawLots = matchedLots.filter((l) => l.token.toLowerCase() === CLAW)
    assert.equal(clawLots.length, 5)
    assert.equal(clawLots.filter((l) => isCanonicalVerifiedPublishedLot(l)).length, 5)
    assert.equal(receiptCalls, 1)
    assert.equal(keyCalls, 3)
    assert.equal(providerCalls, 0, 'the V4 route proved the quote; the provider tier was never needed')
    const a = lookups.receiptQuoteRecoveryAudit
    assert.equal(a.lotsCompletedViaV4RouteQuote, 5)
    const row = a.sides.find((s) => s.txHash === buyTx)!
    assert.equal(row.lotIds.length, 5)
    assert.equal(row.quoteValueUsd, 0.67 * ETH_USD)
    // FIFO allocates the one hydrated entry total across the fragments.
    const totalCost = clawLots.reduce((sum, l) => sum + (l.costBasisUsd ?? 0), 0)
    assert.ok(Math.abs(totalCost - 0.67 * ETH_USD) < 1e-6, `allocated ${totalCost}`)
  })
})
