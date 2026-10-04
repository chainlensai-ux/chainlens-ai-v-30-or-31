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

function dd4229(opts: { hookFeeOnEth?: bigint; flip?: boolean; postTargetSwap?: boolean } = {}) {
  const xIn = units('1250000')
  const ethOut = units('0.67')
  const fee = opts.hookFeeOnEth ?? BigInt(0)
  const h1 = hop(1, TOKEN_753F, xIn, NATIVE_CURRENCY, ethOut, opts.flip)
  const h2 = hop(2, NATIVE_CURRENCY, ethOut - fee, MID, units('5000'), opts.flip)
  const h3 = hop(3, MID, units('5000'), CLAW, DD_TARGET, opts.flip)
  // Production shape: after the wallet's route completes, the token's tax holder swaps its CLAW back
  // to WETH through V4 in the same tx (an off-path swap the decoder must exclude, not consume).
  const swapBack = hop(4, CLAW, units('9000000'), WETH, units('0.011'), opts.flip)
  const tail = opts.postTargetSwap
    ? [transfer(CLAW, `0x${'6'.repeat(40)}`, PM, units('9000000')), swapBack.log, transfer(WETH, PM, FEE_RECIPIENT, units('0.011'))]
    : []
  return {
    tx: okTx([transfer(TOKEN_753F, WALLET, PM, xIn), h1.log, h2.log, h3.log, transfer(CLAW, PM, WALLET, DD_TARGET), ...tail]),
    keys: new Map(opts.postTargetSwap ? [h1.key, h2.key, h3.key, swapBack.key] : [h1.key, h2.key, h3.key]),
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
      chain: 'base', side: extra.side ?? 'entry', target: CLAW, wallet: WALLET, quoteToken: TOKEN_753F,
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
    assert.equal(r.intermediary!.raw, ethToTarget.toString())
    assert.deepEqual(r.fees.map((f) => [f.kind, f.currency, f.raw]), [['protocol_fee_on_target_path', NATIVE_CURRENCY, units('0.002').toString()]])
  })
  it('a large leftover between hops could fund another action: rejected', () => {
    const { tx, keys } = dd4229({ hookFeeOnEth: units('0.3') })
    assert.equal(decode(tx, keys).status, 'unrelated_second_economic_action')
  })
  it('an extra swap not on the wallet route is excluded with its reason; the selected path is unchanged', () => {
    const { tx, keys } = dd4229()
    if (tx.status !== 'ok') return
    const stray = hop(99, MID, units('1'), TOKEN_67A7, units('2'))
    keys.set(stray.key[0], stray.key[1])
    const logs = [...tx.logs.slice(0, 4), stray.log, ...tx.logs.slice(4)]
    const r = decode({ ...tx, logs }, keys)
    assert.equal(r.status, 'route_proven')
    assert.deepEqual(r.selection.selectedPathHopIndexes, [0, 1, 2])
    assert.deepEqual(r.selection.excludedV4HopIndexes, [3])
    assert.match(r.selection.excludedV4HopReasons[0], /^#3: off-path swap of a currency the path produced/)
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
    const r = decodeV4RouteQuote({ chain: 'base', side: 'entry', target: CLAW, wallet: WALLET, quoteToken: TOKEN_753F, walletInRaw: units('10'), walletOutRaw: DD_TARGET, logs: tx.logs, poolKeys: new Map([h1.key, h2.key]), swapTopic0s: new Set(Object.keys(SWAP_TOPIC0S)) })
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
  it('6. production shape (with the post-target tax swap-back): one receipt read, 4 pool-key reads, 0 provider calls; all 5 lots complete', async () => {
    __resetNativePriceResolverForTest()
    __seedAcceptedNativePriceForTest(Date.parse(BUY_TS), ETH_USD, 'coingecko_native_coin_history')
    const { tx, keys } = dd4229({ postTargetSwap: true })
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
    assert.equal(keyCalls, 4)
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

describe('control flow after 6f2d83c6: V4 token-to-token candidates reach the quote lanes', () => {
  // Bot-router shape: the wallet pays the router, the router keeps a small fee and settles the rest
  // into the PoolManager. The transfer-net model flags the router (it keeps a balance AND spends), which
  // is exactly how production rejected these as unrelated_second_economic_action before the V4 lane ran.
  function routerFeeEntry(feeBps: bigint) {
    const xPaid = units('1250000')
    const fee = (xPaid * feeBps) / BigInt(10_000)
    const h1 = hop(51, TOKEN_753F, xPaid - fee, NATIVE_CURRENCY, units('0.67'))
    const h2 = hop(52, NATIVE_CURRENCY, units('0.67'), MID, units('5000'))
    const h3 = hop(53, MID, units('5000'), CLAW, DD_TARGET)
    return {
      tx: okTx([transfer(TOKEN_753F, WALLET, ROUTER, xPaid), transfer(TOKEN_753F, ROUTER, PM, xPaid - fee), h1.log, h2.log, h3.log, transfer(CLAW, PM, WALLET, DD_TARGET)]),
      keys: new Map([h1.key, h2.key, h3.key]),
    }
  }

  it('before pool keys: a token-to-token candidate asks for them instead of being rejected (the production bug)', () => {
    const { tx } = routerFeeEntry(BigInt(50))
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 565818131.2763674, tx })
    assert.equal(r.forensics?.pathAttribution, 'unrelated_second_economic_action', 'the generic transfer model still flags the router')
    assert.equal(r.classification, 'token_to_token_swap_no_canonical_quote')
    assert.equal(r.needsV4PoolKeys?.length, 3)
    assert.equal(r.forensics?.tokenToTokenCandidate, true)
    assert.equal(r.forensics?.quoteTokenAddress, TOKEN_753F)
    assert.equal(r.forensics?.quoteTokenAmount, 1250000)
    assert.equal(r.forensics?.quoteLaneAttempted, true)
    assert.equal(r.forensics?.v4RouteSkipReason, 'pool_keys_pending')
  })

  it('with pool keys: the V4 route proves the path; a 0.5% router fee is protocol_fee_on_target_path', () => {
    const { tx, keys } = routerFeeEntry(BigInt(50))
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 565818131.2763674, tx, v4PoolKeys: keys })
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.deepEqual(r.quote, { kind: 'native', token: 'native', quantity: 0.67 })
    assert.equal(r.forensics?.v4RouteAttempted, true)
    assert.ok(r.forensics?.v4Route?.fees.some((f) => f.kind === 'protocol_fee_on_target_path' && f.currency === TOKEN_753F))
  })

  it('a 5% retained amount is still a genuine second economic action, with a precise skip reason', () => {
    const { tx, keys } = routerFeeEntry(BigInt(500))
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 565818131.2763674, tx, v4PoolKeys: keys })
    assert.equal(r.classification, 'unrelated_second_economic_action')
    assert.equal(r.quote, null)
    assert.match(r.forensics!.v4RouteSkipReason!, /^unrelated_second_economic_action/)
    assert.equal(r.forensics?.historicalQuoteTokenPriceSkipReason, 'path_not_attributed_by_transfers_or_v4_route')
  })

  it('a non-V4 token-to-token swap with a retained balance is not overridden (no global weakening)', () => {
    const { tx } = routerFeeEntry(BigInt(50))
    if (tx.status !== 'ok') return
    // A V2-style Swap from a reachable path node: the route is not all-V4, so no override applies.
    const v2Swap = { address: PM, topics: [Object.keys(SWAP_TOPIC0S)[0]], data: '0x' }
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 565818131.2763674, tx: { ...tx, logs: [...tx.logs, v2Swap] } })
    assert.equal(r.classification, 'unrelated_second_economic_action')
    assert.match(r.forensics!.quoteLaneSkipReason!, /^path_not_attributed/)
    assert.equal(r.forensics?.v4RouteSkipReason, 'non_v4_swap_in_tx')
  })

  it('0xe61a USDbC entry with a router-kept fee: V4 proves the exact wallet outflow funds the target swap -> $385.592909', () => {
    const fee = units('0.963982', 6)
    const settled = E61_USDBC - fee
    const h1 = hop(61, USDBC, settled, NATIVE_CURRENCY, units('0.115'))
    const h2 = hop(62, NATIVE_CURRENCY, units('0.115'), MID, units('810'))
    const h3 = hop(63, MID, units('810'), CLAW, A99_TARGET)
    const tx = okTx([transfer(USDBC, WALLET, ROUTER, E61_USDBC), transfer(USDBC, ROUTER, PM, settled), h1.log, h2.log, h3.log, transfer(CLAW, PM, WALLET, A99_TARGET)])
    const pending = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 98746705.02925444, tx })
    assert.equal(pending.forensics?.pathAttribution, 'unrelated_second_economic_action')
    assert.equal(pending.needsV4PoolKeys?.length, 3)
    const r = classifyReceiptQuoteEvidence({ ...base, side: 'entry', targetAmount: 98746705.02925444, tx, v4PoolKeys: new Map([h1.key, h2.key, h3.key]) })
    assert.equal(r.classification, 'quote_leg_omitted_from_provider_activity')
    assert.deepEqual(r.quote, { kind: 'stable', token: USDBC, quantity: 385.592909 })
  })

  it('USDbC is one exact-address stable for both holdings pricing and receipt recovery', async () => {
    const { isCanonicalStable } = await import('../../lib/pricing/currentPriceResolver')
    const { isVerifiedStablecoinAddress } = await import('../modules/quoteLegPricing/index')
    assert.equal(isCanonicalStable(8453, USDBC), true)
    assert.equal(isVerifiedStablecoinAddress('base', USDBC), true)
    assert.equal(isVerifiedStablecoinAddress('base', USDBC.toUpperCase().replace('0X', '0x')), true)
  })

  it('lane: the token-to-token candidate resolves pool keys (v4PoolKeysResolved > 0)', async () => {
    const { tx, keys } = routerFeeEntry(BigInt(50))
    const lanes = await import('./priceLotsForWallet.ts')
    const buyTx = '0xdd4229cccae1f56f4782ffd8de227b45b17b190a9b391f2e42661601fed435fa'
    const ts = '2026-09-20T10:00:00.000Z'
    __resetNativePriceResolverForTest()
    __seedAcceptedNativePriceForTest(Date.parse(ts), 3300, 'coingecko_native_coin_history')
    const ev = (o: Partial<NormalizedEvent>): NormalizedEvent => ({ provider: 'alchemy', chain: 'base', txHash: buyTx, timestamp: ts, fromAddress: PM, toAddress: WALLET, contract: CLAW, symbol: '1clawAI', amount: 565818131.2763674, amountRaw: DD_TARGET.toString(), tokenDecimals: 18, direction: 'inbound', ...o })
    const events = [
      ev({}),
      ev({ txHash: '0xsellx', timestamp: '2026-09-21T10:00:00.000Z', direction: 'outbound', fromAddress: WALLET, toAddress: PM }),
      ev({ txHash: '0xsellx', timestamp: '2026-09-21T10:00:00.000Z', contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', amount: 2500, amountRaw: '2500000000', tokenDecimals: 6, direction: 'unknown', fromAddress: PM, toAddress: ROUTER }),
    ]
    const prior = process.env.COINPAPRIKA_HISTORICAL_ENABLED
    process.env.COINPAPRIKA_HISTORICAL_ENABLED = 'false'
    const originalWarn = console.warn
    console.warn = () => undefined
    let result
    try {
      result = await lanes.priceLotsForWallet({
        normalizedEvents: events, recoveredEvents: [], priceSources: { primary: () => null, fallback: () => null },
        receiptQuoteRecovery: {
          walletAddress: WALLET,
          fetchTx: async () => tx,
          resolveV4PoolKeys: async (_c, ids) => new Map(ids.map((id) => [id, keys.get(id)!])),
          quoteTokenHistoricalPrice: () => null,
        },
      })
    } finally {
      console.warn = originalWarn
      if (prior === undefined) delete process.env.COINPAPRIKA_HISTORICAL_ENABLED; else process.env.COINPAPRIKA_HISTORICAL_ENABLED = prior
    }
    const a = result.receiptQuoteRecoveryAudit
    assert.equal(a.sourceAudit.v4PoolKeysResolved, 3)
    assert.equal(a.lotsCompletedViaV4RouteQuote, 1)
    const row = a.sides.find((s) => s.txHash === buyTx)!
    assert.equal(row.classification, 'token_to_token_quote_via_v4_route')
    assert.equal(row.forensics?.quoteLaneAttempted, true)
  })
})

describe('connected route extraction (production shapes after f3828c8f)', () => {
  const TAX_HOLDER = `0x${'6'.repeat(40)}`
  const OUTSIDER = `0x${'2'.repeat(40)}`
  const OTHER = '0x4444444444444444444444444444444444444444'
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const classify = (side: 'entry' | 'exit', targetAmount: number, tx: ReceiptQuoteTx, keys: Map<string, V4PoolCurrencies>) =>
    classifyReceiptQuoteEvidence({ ...base, side, targetAmount, tx, v4PoolKeys: keys })

  // 0xdd4229: 0x753f -> WETH -> 1clawAI, then the token's tax swap-back 1clawAI -> WETH funded by its
  // own tax holder, paid out to a fee recipient.
  function dd4229WithPostTargetSwap(opts: { swapBackOutputToWallet?: boolean } = {}) {
    const xIn = units('1250000')
    const h1 = hop(71, TOKEN_753F, xIn, WETH, units('0.67'))
    const h2 = hop(72, WETH, units('0.67'), CLAW, DD_TARGET)
    const h3 = hop(73, CLAW, units('9000000'), WETH, units('0.011'))
    return {
      tx: okTx([
        transfer(TOKEN_753F, WALLET, PM, xIn), h1.log, h2.log, transfer(CLAW, PM, WALLET, DD_TARGET),
        transfer(CLAW, TAX_HOLDER, PM, units('9000000')), h3.log,
        transfer(WETH, PM, opts.swapBackOutputToWallet ? WALLET : FEE_RECIPIENT, units('0.011')),
      ]),
      keys: new Map([h1.key, h2.key, h3.key]),
    }
  }

  it('1. target reached before a later tax swap-back: path [0,1] selected, swap-back excluded with its reason', () => {
    const { tx, keys } = dd4229WithPostTargetSwap()
    const r = classify('entry', 565818131.2763674, tx, keys)
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.deepEqual(r.quote, { kind: 'native', token: WETH, quantity: 0.67 })
    const sel = r.forensics!.v4Route!.selection
    assert.equal(sel.v4SwapCount, 3)
    assert.equal(sel.candidatePathCount, 1)
    assert.deepEqual(sel.selectedPathHopIndexes, [0, 1])
    assert.deepEqual(sel.selectedPathCurrencies, [TOKEN_753F, WETH, CLAW])
    assert.deepEqual(sel.excludedV4HopIndexes, [2])
    assert.match(sel.excludedV4HopReasons[0], /^#2: off-path swap of a currency the path produced/)
    assert.equal(sel.selectedPathInputRaw, units('1250000').toString())
    assert.equal(sel.selectedPathOutputRaw, DD_TARGET.toString())
  })

  it('   …but if that later swap pays WETH to the wallet, value returns to the wallet: rejected', () => {
    const { tx, keys } = dd4229WithPostTargetSwap({ swapBackOutputToWallet: true })
    assert.notEqual(classify('entry', 565818131.2763674, tx, keys).classification, 'token_to_token_quote_via_v4_route')
  })

  it('2. an extra independent V4 swap after the target is excluded as independent', () => {
    const xIn = units('1250000')
    const h1 = hop(81, TOKEN_753F, xIn, WETH, units('0.67'))
    const h2 = hop(82, WETH, units('0.67'), CLAW, DD_TARGET)
    const h3 = hop(83, OTHER, units('50'), WETH, units('0.02'))
    const tx = okTx([
      transfer(TOKEN_753F, WALLET, PM, xIn), h1.log, h2.log, transfer(CLAW, PM, WALLET, DD_TARGET),
      transfer(OTHER, OUTSIDER, PM, units('50')), h3.log, transfer(WETH, PM, OUTSIDER, units('0.02')),
    ])
    const r = classify('entry', 565818131.2763674, tx, new Map([h1.key, h2.key, h3.key]))
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.match(r.forensics!.v4Route!.selection.excludedV4HopReasons[0], /^#2: independent swap/)
  })

  it('3. two connected paths that both satisfy the wallet trade are ambiguous: rejected', () => {
    const xIn = units('1250000')
    const a1 = hop(91, TOKEN_753F, xIn, WETH, units('0.67'))
    const a2 = hop(92, WETH, units('0.67'), CLAW, DD_TARGET)
    const b1 = hop(93, TOKEN_753F, xIn, WETH, units('0.67'))
    const b2 = hop(94, WETH, units('0.67'), CLAW, DD_TARGET)
    const tx = okTx([transfer(TOKEN_753F, WALLET, PM, xIn), a1.log, a2.log, b1.log, b2.log, transfer(CLAW, PM, WALLET, DD_TARGET)])
    const r = classify('entry', 565818131.2763674, tx, new Map([a1.key, a2.key, b1.key, b2.key]))
    assert.notEqual(r.classification, 'token_to_token_quote_via_v4_route')
    assert.equal(r.forensics?.v4Route?.status, 'ambiguous_route')
    assert.ok(r.forensics!.v4Route!.selection.ambiguousPathCount > 1)
  })

  it('4. outside capital funding the candidate route is rejected', () => {
    const xIn = units('1250000')
    const extra = units('200000')
    const h1 = hop(101, TOKEN_753F, xIn + extra, WETH, units('0.78'))
    const h2 = hop(102, WETH, units('0.78'), CLAW, DD_TARGET)
    const tx = okTx([transfer(TOKEN_753F, WALLET, PM, xIn), transfer(TOKEN_753F, OUTSIDER, PM, extra), h1.log, h2.log, transfer(CLAW, PM, WALLET, DD_TARGET)])
    const r = classify('entry', 565818131.2763674, tx, new Map([h1.key, h2.key]))
    assert.equal(r.classification, 'unrelated_second_economic_action')
    assert.match(r.forensics!.v4RouteSkipReason!, /no connected path reproduces the wallet trade/)
  })

  it('5. 0xe61a: USDbC -> USDC -> 1clawAI beside an unconnected swap; exact $385.592909 stable quote', () => {
    const h1 = hop(111, USDBC, E61_USDBC, USDC, units('385.5', 6))
    const hx = hop(112, OTHER, units('50'), WETH, units('0.02'))
    const h2 = hop(113, USDC, units('385.5', 6), CLAW, A99_TARGET)
    const tx = okTx([
      transfer(USDBC, WALLET, PM, E61_USDBC), h1.log,
      transfer(OTHER, OUTSIDER, PM, units('50')), hx.log, transfer(WETH, PM, OUTSIDER, units('0.02')),
      h2.log, transfer(CLAW, PM, WALLET, A99_TARGET),
    ])
    const r = classify('entry', 98746705.02925444, tx, new Map([h1.key, hx.key, h2.key]))
    assert.equal(r.classification, 'quote_leg_omitted_from_provider_activity')
    assert.deepEqual(r.quote, { kind: 'stable', token: USDBC, quantity: 385.592909 })
    assert.deepEqual(r.forensics!.v4Route!.selection.selectedPathHopIndexes, [0, 2])
    assert.deepEqual(r.forensics!.v4Route!.selection.excludedV4HopIndexes, [1])
  })

  it('7. exit with an extra post-target swap: 1clawAI -> WETH -> 0x67a7 selected, later swap excluded', () => {
    const h1 = hop(121, CLAW, A99_TARGET, WETH, units('0.11'))
    const h2 = hop(122, WETH, units('0.11'), TOKEN_67A7, A99_RECEIVED)
    const h3 = hop(123, TOKEN_67A7, units('1000'), WETH, units('0.0001'))
    const tx = okTx([
      transfer(CLAW, WALLET, PM, A99_TARGET), h1.log, h2.log, transfer(TOKEN_67A7, PM, WALLET, A99_RECEIVED),
      transfer(TOKEN_67A7, OUTSIDER, PM, units('1000')), h3.log, transfer(WETH, PM, OUTSIDER, units('0.0001')),
    ])
    const r = classify('exit', 98746705.02925444, tx, new Map([h1.key, h2.key, h3.key]))
    assert.equal(r.classification, 'token_to_token_quote_via_v4_route')
    assert.deepEqual(r.quote, { kind: 'native', token: WETH, quantity: 0.11 })
    assert.deepEqual(r.forensics!.v4Route!.selection.selectedPathHopIndexes, [0, 1])
  })

  it('   an excluded swap that produces the wallet output currency is rejected', () => {
    const h1 = hop(131, CLAW, A99_TARGET, WETH, units('0.11'))
    const h2 = hop(132, WETH, units('0.11'), TOKEN_67A7, A99_RECEIVED)
    const h3 = hop(133, OTHER, units('5'), TOKEN_67A7, units('1000'))
    const tx = okTx([
      transfer(CLAW, WALLET, PM, A99_TARGET), h1.log, h2.log, transfer(TOKEN_67A7, PM, WALLET, A99_RECEIVED),
      transfer(OTHER, OUTSIDER, PM, units('5')), h3.log, transfer(TOKEN_67A7, PM, OUTSIDER, units('1000')),
    ])
    const r = classify('exit', 98746705.02925444, tx, new Map([h1.key, h2.key, h3.key]))
    assert.equal(r.classification, 'unrelated_second_economic_action')
    assert.match(r.forensics!.v4Route!.selection.excludedV4HopReasons[0], /produces the wallet output currency/)
  })
})
