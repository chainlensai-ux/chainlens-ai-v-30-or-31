// LP fee income: payouts are proven fee-only transaction by transaction, only tokens the wallet got
// solely as fees count, and only sales with proven proceeds are added up. Shapes and amounts are the
// real DGUY creator wallet's on Base: a keeper calls a fee locker holding Uniswap V3 position
// #5996787 (DGUY/AMZNc), and the wallet later sold AMZNc for native ETH with a 0.25% fee leg.
//   npx tsx --test src/lib/lpFeeIncome.test.ts
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetLpFeeIncomeCacheForTest, buildLpFeeIncome, classifyLpFeePayout, splitSellFeeLegs, walletBoundaryProceeds,
  NPM_COLLECT_TOPIC0, NPM_DECREASE_LIQUIDITY_TOPIC0, V3_POOL_BURN_TOPIC0, V3_POOL_COLLECT_TOPIC0, type LpFeeIncomeDeps,
} from './lpFeeIncome'
import { TRANSFER_TOPIC0, type ReceiptQuoteLog, type ReceiptQuoteTx } from './receiptQuoteRecovery'
import { buildLpFeeIncomeView } from '../../app/frontend/lib/liquidityProviderView'
import type { NormalizedEvent } from '../modules/normalization/types'

const WALLET = '0x404a2e936be3c9faccb4a59c764c1d14f6add1af'
const KEEPER = '0xb86cc1d5000000000000000000000000000000aa'
const LOCKER = '0x71d1d363176723f85d98b8b430df33cde89f0a7f'
const PROTOCOL = '0xfbc9ee130f1cfeeb192b18cf1202865d757fa680'
const POOL = '0x4be684f77419999aa3e1162d25d9ae6ff64c05a0'
const NPM = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1'
const AMZN = '0xb200000000000000000000d9192b6b456483c2e8' // token0 (lower address)
const DGUY = '0xe34356dcd3d7bb991248f322e4ec31b5d60bc54e' // token1
const ROUTER = '0x20f6ee51340adeed01a59b0e65cb3703f3dc860c'
const FEE_TAKER = '0xcd6b980000000000000000000000000000000001'
const TOKEN_ID = BigInt(5996787)

const t = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
const w = (...v: Array<bigint | string>) => `0x${v.map((x) => (typeof x === 'string' ? x.slice(2).padStart(64, '0') : x.toString(16).padStart(64, '0'))).join('')}`
const transfer = (token: string, from: string, to: string, amount: bigint): ReceiptQuoteLog => ({ address: token, topics: [TRANSFER_TOPIC0, t(from), t(to)], data: w(amount) })

// The real payout's shape: pool → locker (amount0, amount1), locker → protocol and wallet.
function payout(amzn: bigint, dguy: bigint, overrides: Partial<Extract<ReceiptQuoteTx, { status: 'ok' }>> = {}): Extract<ReceiptQuoteTx, { status: 'ok' }> {
  const walletAmzn = (amzn * BigInt(7)) / BigInt(10)
  const walletDguy = (dguy * BigInt(7)) / BigInt(10)
  return {
    status: 'ok', from: KEEPER, to: PROTOCOL, valueWei: '0', input: '0xa4520aee',
    logs: [
      { address: POOL, topics: [V3_POOL_BURN_TOPIC0, t(NPM), t('0x0'), t('0x0')], data: w(BigInt(0), BigInt(0), BigInt(0)) },
      transfer(AMZN, POOL, LOCKER, amzn),
      transfer(DGUY, POOL, LOCKER, dguy),
      { address: POOL, topics: [V3_POOL_COLLECT_TOPIC0, t(NPM), t('0x0'), t('0x0')], data: w(LOCKER, amzn, dguy) },
      { address: NPM, topics: [NPM_COLLECT_TOPIC0, w(TOKEN_ID)], data: w(LOCKER, amzn, dguy) },
      transfer(AMZN, LOCKER, PROTOCOL, amzn - walletAmzn),
      transfer(DGUY, LOCKER, PROTOCOL, dguy - walletDguy),
      transfer(AMZN, LOCKER, WALLET, walletAmzn),
      transfer(DGUY, LOCKER, WALLET, walletDguy),
    ],
    ...overrides,
  }
}

test('the real payout shape is proven fee-only, with position, pool, payer and both tokens', () => {
  const proof = classifyLpFeePayout('base', WALLET, payout(BigInt(378204365), BigInt('10303000000000000000000000')))
  assert.equal(proof.proven, true)
  if (!proof.proven) return
  assert.equal(proof.tokenId, '5996787')
  assert.equal(proof.pool, POOL)
  assert.equal(proof.recipient, LOCKER)
  assert.deepEqual(proof.poolTokens, [AMZN, DGUY])
  assert.deepEqual(proof.received.map((r) => r.token), [AMZN, DGUY])
})

test('anything other than a pure fee collect paid out by someone else is rejected', () => {
  const base = payout(BigInt(1000), BigInt(2000))
  const reason = (tx: ReceiptQuoteTx) => { const p = classifyLpFeePayout('base', WALLET, tx); return p.proven ? null : p.reason }
  assert.equal(reason({ ...base, from: WALLET }), 'signed_by_wallet')
  assert.equal(reason({ ...base, logs: [...base.logs, transfer(DGUY, WALLET, ROUTER, BigInt(1))] }), 'wallet_sent_tokens')
  assert.equal(reason({ ...base, logs: base.logs.map((l) => (l.topics[0] === V3_POOL_BURN_TOPIC0 ? { ...l, data: w(BigInt(5), BigInt(1), BigInt(1)) } : l)) }), 'non_zero_burn')
  // A look-alike Collect from a contract that is not the canonical position manager.
  assert.equal(reason({ ...base, logs: base.logs.map((l) => (l.address === NPM ? { ...l, address: '0x1111111111111111111111111111111111111111' } : l)) }), 'no_position_manager_collect')
  // The payer received the token from somewhere other than the pool.
  assert.equal(reason({ ...base, logs: [...base.logs, transfer(AMZN, KEEPER, LOCKER, BigInt(5))] }), 'token_not_from_fee_payout')
  assert.equal(reason({ ...base, logs: [...base.logs, { address: POOL, topics: ['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'], data: '0x' }] }), 'swap_or_liquidity_change_in_tx')
})

// ─── end to end ────────────────────────────────────────────────────────────────────────────────────
let n = 0
function evt(o: Partial<NormalizedEvent> & Pick<NormalizedEvent, 'txHash' | 'direction' | 'contract' | 'amount'>): NormalizedEvent {
  n += 1
  return { provider: 'alchemy', chain: 'base', timestamp: new Date(Date.UTC(2026, 8, 14) + n * 3_600_000).toISOString(), fromAddress: LOCKER, toAddress: WALLET, symbol: o.contract === AMZN ? 'AMZNc' : 'DGUY', tokenDecimals: o.contract === AMZN ? 8 : 18, amountRaw: null, ...o }
}
const hash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`
const SALE = hash(900)

function world(opts: { decreased?: boolean; extraAmznBuy?: boolean; budget?: number } = {}) {
  const payouts = [hash(1), hash(2), hash(3)]
  const amounts = [BigInt(678204365), BigInt(47940000), BigInt(17470000)]
  const events: NormalizedEvent[] = payouts.flatMap((h, i) => [
    evt({ txHash: h, direction: 'inbound', contract: AMZN, amount: Number((amounts[i] * BigInt(7)) / BigInt(10)) / 1e8, amountRaw: ((amounts[i] * BigInt(7)) / BigInt(10)).toString() }),
    evt({ txHash: h, direction: 'inbound', contract: DGUY, amount: 1, amountRaw: ((BigInt(10) ** BigInt(21) * BigInt(7)) / BigInt(10)).toString() }),
  ])
  // Sale: 4.94323489 AMZNc to the router plus a 0.25% fee leg, paid out as 0.51228649 ETH.
  events.push(evt({ txHash: SALE, direction: 'outbound', contract: AMZN, amount: 0.01238906, amountRaw: '1238906', fromAddress: WALLET, toAddress: FEE_TAKER }))
  events.push(evt({ txHash: SALE, direction: 'outbound', contract: AMZN, amount: 4.94323489, amountRaw: '494323489', fromAddress: WALLET, toAddress: ROUTER }))
  if (opts.extraAmznBuy) events.push(evt({ txHash: hash(500), direction: 'inbound', contract: AMZN, amount: 1, amountRaw: '100000000', fromAddress: ROUTER }))
  // Duplicate copies, as the pipeline passes normalized and canonical events together.
  events.push(...events.slice(0, 2))

  const txs = new Map<string, ReceiptQuoteTx>(payouts.map((h, i) => [h, payout(amounts[i], BigInt(10) ** BigInt(21))]))
  txs.set(SALE, {
    status: 'ok', from: WALLET, to: ROUTER, valueWei: '0', input: '0x46ec278a',
    logs: [
      transfer(AMZN, WALLET, FEE_TAKER, BigInt(1238906)),
      transfer(AMZN, WALLET, ROUTER, BigInt(494323489)),
      transfer('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xd03bc8c7f2faedce2aac81bf0444aea08ea06e9b', ROUTER, BigInt(1230151644)),
    ],
  })
  const calls: string[] = []
  let budget = opts.budget ?? Infinity
  const rpc = async (body: unknown) => {
    const req = body as { method: string; params: Array<{ address: string; topics: Array<string | null> }> }
    const { address, topics } = req.params[0]
    if (topics[0] === NPM_DECREASE_LIQUIDITY_TOPIC0) return { result: opts.decreased ? [{ transactionHash: hash(77), topics, data: '0x' }] : [] }
    if (topics[0] === NPM_COLLECT_TOPIC0) return { result: payouts.map((h, i) => ({ transactionHash: h, topics, data: w(LOCKER, amounts[i], BigInt(10) ** BigInt(21)) })) }
    if (topics[0] === TRANSFER_TOPIC0) {
      return { result: payouts.map((h, i) => ({ transactionHash: h, topics: [TRANSFER_TOPIC0, t(POOL), t(LOCKER)], data: w(address === AMZN ? amounts[i] : BigInt(10) ** BigInt(21)) })) }
    }
    return { result: null }
  }
  const deps: LpFeeIncomeDeps = {
    chain: 'base', walletAddress: WALLET, events,
    rpc,
    consume: (method) => { calls.push(method); return budget-- > 0 },
    fetchTx: async (_chain, txHash) => txs.get(txHash) ?? { status: 'missing' },
    fetchInternalTransfers: async (_chain, txHash) => ({ transfers: txHash === SALE ? [{ from: ROUTER, to: WALLET, valueWei: '512286490000000000' }] : [], source: 'debug_trace_call_tracer', attempts: [] }),
    nativeUsdAt: async () => 2500,
  }
  return { deps, calls }
}

beforeEach(() => __resetLpFeeIncomeCacheForTest())

test('fee-only payouts are proven from one receipt and three log queries; the sale is priced from the ETH received', async () => {
  const { deps, calls } = world()
  const s = await buildLpFeeIncome(deps)
  assert.equal(s.status, 'proven')
  assert.equal(s.payoutTxsProven, 3)
  assert.equal(s.calls.receipts, 1, 'one sample receipt for the payer, not one per payout')
  assert.equal(s.calls.positionHistory, 4, 'never-decreased check, the collects, and one transfer query per pool token')
  const amzn = s.tokens.find((x) => x.token === AMZN)!
  assert.equal(amzn.salesProven, 1)
  assert.ok(Math.abs(amzn.soldAmount - 4.95562395) < 1e-9, 'the fee leg counts as sold')
  assert.ok(Math.abs(s.realizedFeeIncomeNative! - 0.51228649) < 1e-12)
  assert.ok(Math.abs(s.realizedFeeIncomeUsd! - 0.51228649 * 2500) < 1e-6)
  assert.equal(s.sellFeeLegs, 1)
  assert.ok(!s.tokens.some((x) => x.token === DGUY && x.salesProven > 0))
  assert.ok(calls.every((m) => ['eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'debug_traceTransaction'].includes(m)))
})

test('a position that ever had liquidity withdrawn proves nothing (owed principal is collected with fees)', async () => {
  const s = await buildLpFeeIncome(world({ decreased: true }).deps)
  assert.equal(s.payoutTxsProven, 0)
  assert.equal(s.payoutRejections.position_had_liquidity_withdrawn, 3)
  assert.equal(s.realizedFeeIncomeUsd, null)
})

test('a token also acquired another way is not fee income, even if some of it came from fees', async () => {
  const s = await buildLpFeeIncome(world({ extraAmznBuy: true }).deps)
  assert.equal(s.payoutTxsProven, 3)
  assert.ok(!s.tokens.some((x) => x.token === AMZN))
  assert.equal(s.realizedFeeIncomeUsd, null)
})

test('the provider budget is respected: a refused call is never made and leaves payouts unchecked', async () => {
  const { deps } = world({ budget: 1 })
  const s = await buildLpFeeIncome(deps)
  assert.equal(s.payoutTxsProven, 0)
  assert.equal(s.calls.receipts, 0)
  assert.equal(s.payoutTxsUnchecked, 3)
})

test('wallet-boundary proceeds: only the sold token out, only native ETH in, with a trace', () => {
  const sale = (logs: ReceiptQuoteLog[], extra: Partial<Extract<ReceiptQuoteTx, { status: 'ok' }>> = {}) => ({ status: 'ok' as const, from: WALLET, to: ROUTER, valueWei: '0', input: '0x', logs, internalTransfers: [{ from: ROUTER, to: WALLET, valueWei: '1000000000000000000' }], ...extra })
  assert.deepEqual(walletBoundaryProceeds('base', sale([transfer(AMZN, WALLET, ROUTER, BigInt(5))]), WALLET, AMZN), { kind: 'native', token: 'native', quantity: 1 })
  assert.equal(walletBoundaryProceeds('base', sale([transfer(AMZN, WALLET, ROUTER, BigInt(5)), transfer(DGUY, WALLET, ROUTER, BigInt(5))]), WALLET, AMZN), null, 'a second asset out')
  assert.equal(walletBoundaryProceeds('base', sale([transfer(AMZN, WALLET, ROUTER, BigInt(5)), transfer(DGUY, ROUTER, WALLET, BigInt(5))]), WALLET, AMZN), null, 'a token in')
  assert.equal(walletBoundaryProceeds('base', sale([transfer(AMZN, WALLET, ROUTER, BigInt(5))], { internalTransfers: null }), WALLET, AMZN), null, 'no trace')
  assert.equal(walletBoundaryProceeds('base', sale([transfer(AMZN, WALLET, ROUTER, BigInt(5))], { from: KEEPER }), WALLET, AMZN), null, 'not signed by the wallet')
  assert.equal(walletBoundaryProceeds('base', sale([transfer(AMZN, WALLET, ROUTER, BigInt(5))], { valueWei: '1' }), WALLET, AMZN), null, 'ETH attached')
})

test('a fee leg is set aside only when small, not to the router, and nothing comes back from it', () => {
  const tx = (fee: bigint, feeTo = FEE_TAKER, extra: ReceiptQuoteLog[] = []) => ({ status: 'ok' as const, from: WALLET, to: ROUTER, valueWei: '0', input: '0x', logs: [transfer(AMZN, WALLET, feeTo, fee), transfer(AMZN, WALLET, ROUTER, BigInt(494323489)), ...extra] })
  assert.equal(splitSellFeeLegs(tx(BigInt(1238906)), WALLET, AMZN)?.mainRaw, BigInt(494323489))
  assert.equal(splitSellFeeLegs(tx(BigInt(100_000_000)), WALLET, AMZN), null, 'over 1% is a second action')
  assert.equal(splitSellFeeLegs(tx(BigInt(1238906), ROUTER), WALLET, AMZN), null)
  assert.equal(splitSellFeeLegs(tx(BigInt(1238906), FEE_TAKER, [transfer(DGUY, FEE_TAKER, WALLET, BigInt(1))]), WALLET, AMZN), null)
})

test('card copy: realized fee income is labelled as separate from trading PnL', async () => {
  const s = await buildLpFeeIncome(world().deps)
  const view = buildLpFeeIncomeView(s)!
  assert.equal(view.salesProven, 1)
  assert.match(view.note, /From 1 sale of AMZNc this wallet received only as LP fees \(3 fee payouts proven on-chain\), counted at \$0 cost and kept separate from trading PnL\./)
  assert.equal(buildLpFeeIncomeView({ ...s, realizedFeeIncomeUsd: null }), null)
})

test('a sale larger than the fee inventory seen arriving is not counted as fee income', async () => {
  const { deps } = world()
  const s = await buildLpFeeIncome({ ...deps, events: deps.events.map((e) => (e.direction === 'outbound' && e.toAddress === ROUTER ? { ...e, amount: 40, amountRaw: '4000000000' } : e)) })
  assert.equal(s.tokens.find((x) => x.token === AMZN)?.salesUnproven, 1)
  assert.equal(s.realizedFeeIncomeUsd, null)
})

test('ETH/USD for every proven sale day is requested once, in one batch, before pricing', async () => {
  const { deps } = world()
  const primed: number[][] = []
  let reads = 0
  const s = await buildLpFeeIncome({ ...deps, primeNativeUsd: async (days) => { primed.push(days) }, nativeUsdAt: async () => { reads += 1; return reads === 1 ? 2500 : null } })
  assert.equal(primed.length, 1)
  assert.equal(primed[0].length, 1)
  assert.equal(s.tokens[0].salesProven, 1)
})

test('a sale whose day has no ETH/USD price fails closed and says why', async () => {
  const { deps } = world()
  const s = await buildLpFeeIncome({ ...deps, nativeUsdAt: async () => null })
  assert.equal(s.realizedFeeIncomeUsd, null)
  assert.equal(s.saleRejections.native_price_unavailable, 1)
})
