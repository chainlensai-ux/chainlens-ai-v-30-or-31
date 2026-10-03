// Production follow-up after 625f4761: target the 9 blocked 1clawAI closed lots.
// Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.blockedLots.test.ts

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runBlockedLotFixture, CLAW, WALLET, ETH_USD_SELL_DAY } from './priceLotsForWallet.blockedLots.fixture.ts'
import { classifyReceiptQuoteEvidence, TRANSFER_TOPIC0, WETH_WITHDRAWAL_TOPIC0, SWAP_TOPIC0S, LIQUIDITY_TOPIC0S, type ReceiptQuoteTx } from '../lib/receiptQuoteRecovery.ts'
import { clearCoinPaprikaCachesForTests } from '../../lib/server/coinPaprikaHistorical'

const priorKey = process.env.COINPAPRIKA_API_KEY
afterEach(() => {
  clearCoinPaprikaCachesForTests()
  if (priorKey === undefined) delete process.env.COINPAPRIKA_API_KEY; else process.env.COINPAPRIKA_API_KEY = priorKey
})

describe('blocked 1clawAI lots — production-shaped 13-lot fixture', () => {
  it('before: reproduces the live scan (4/13, same-tx completes 0, 3 lots with the other side missing)', async () => {
    const run = await runBlockedLotFixture({ receiptLane: false })
    assert.equal(run.closedLots, 13)
    assert.equal(run.verifiedLots, 4)
    assert.equal(run.coveragePct, 30.77)
    assert.equal(run.sameTxLotsCompleted, 0)
    const audit = run.lookups.closedLotMissingPriceAudit
    assert.equal(audit.sameTxSidesCompletingAClosedLot, 0)
    assert.equal(audit.sameTxSidesOnClosedLotWithOtherSideMissing, 3)
    assert.equal(audit.sameTxSidesNotOnAnyClosedLot, 5)
    assert.deepEqual(Object.keys(audit.missingSideReasonCounts), ['no_opposite_leg_in_transaction'])
    assert.equal(run.receiptCalls, 0)
  })

  it('blocked-lot plan is built before pricing, single-missing-side lots first', async () => {
    const run = await runBlockedLotFixture({ receiptLane: false })
    const plan = run.lookups.blockedLotPlan
    assert.equal(plan.length, 9)
    assert.ok(plan.every((l) => l.token.toLowerCase() === CLAW))
    // Accepted evidence covers nothing on these lots, so before pricing every side is open.
    assert.ok(plan.every((l) => l.missingEntry && l.missingExit && !l.otherSideAlreadyVerified))
    assert.deepEqual(Object.keys(plan[0]).sort(), ['entryTimestamp', 'entryTx', 'exitTimestamp', 'exitTx', 'lotId', 'missingEntry', 'missingExit', 'otherSideAlreadyVerified', 'token'])
  })

  it('after: receipt evidence completes 5 more lots (9/13); the other 4 stay unavailable with exact reasons', async () => {
    const run = await runBlockedLotFixture({ receiptLane: true })
    assert.equal(run.verifiedLots, 9)
    assert.equal(run.coveragePct, 69.23)
    const a = run.lookups.receiptQuoteRecoveryAudit
    assert.equal(a.completionReadyLotsBefore, 3)
    assert.equal(a.missingBothSidesLotsBefore, 6)
    assert.equal(a.txsFetched, 12, 'bounded by the default per-scan cap')
    assert.deepEqual(a.callsSpentByClass, { completion_ready: 3, missing_both: 9 })
    assert.deepEqual(a.lotsCompletedByClass, { completion_ready: 3, missing_both: 2 })
    assert.equal(a.lotsCompletedViaNativeQuote, 5)
    assert.deepEqual(a.classificationCounts, {
      native_eth_received_via_router_unwrap: 6,
      native_eth_paid_via_tx_value: 3,
      true_plain_token_transfer: 1,
      multicall_unrelated_wallet_assets: 1,
      native_refund_unaccounted: 1,
      not_fetched_budget: 3,
    })
    // Exact derivation: 0.12 WETH unwrapped × ETH/USD for the sell day, never a current price.
    const sell1 = a.sides.find((s) => s.txHash === '0xclawsell1')!
    assert.equal(sell1.class, 'completion_ready')
    assert.equal(sell1.quoteQuantity, 0.12)
    assert.equal(sell1.quoteUsdPrice, ETH_USD_SELL_DAY)
    assert.equal(sell1.quoteValueUsd, 0.12 * ETH_USD_SELL_DAY)
    assert.equal(sell1.forensics?.routerAddress, `0x${'7'.repeat(40)}`)
    assert.equal(sell1.forensics?.inputSelector, '0x3593564c')
    assert.deepEqual(sell1.historicalMarketAttempts.every((r) => r === 'none'), true)
    for (const tx of ['0xclawsell1', '0xclawsell2', '0xclawsell3', '0xclawsell4', '0xclawsell5']) assert.ok(run.verifiedClawLotTxs.has(tx), tx)
    for (const tx of ['0xclawsell6', '0xclawsell7', '0xclawsell8', '0xclawsell9']) assert.ok(!run.verifiedClawLotTxs.has(tx), tx)
  })

  it('completion-ready sides are spent first: a 3-tx budget completes exactly the 3 single-side lots', async () => {
    const run = await runBlockedLotFixture({ receiptLane: true, maxTxs: 3 })
    assert.equal(run.verifiedLots, 7, 'crosses the 50% threshold with the minimum spend')
    assert.deepEqual(run.lookups.receiptQuoteRecoveryAudit.callsSpentByClass, { completion_ready: 3, missing_both: 0 })
  })

  it('CoinPaprika daily sample stays partial unless a same-day exact execution corroborates it within 5%', async () => {
    process.env.COINPAPRIKA_API_KEY = 'test'
    const paprika = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/contracts/')) return Response.json({ id: 'claw-1clawai', platform_id: 'base-base', contract_address: CLAW })
      // Sell day: 0.60 vs executions ~0.40-0.53 → far outside tolerance. Buy day: 0.40 vs 0.39 → 2.6%.
      const close = url.includes('start=2026-04-02') ? 0.6 : 0.4
      const day = url.includes('start=2026-04-02') ? '2026-04-02' : '2026-04-01'
      return Response.json([{ time_open: `${day}T00:00:00Z`, close }])
    }) as typeof fetch
    const run = await runBlockedLotFixture({ receiptLane: true, coinPaprikaFetchImpl: paprika })
    const corroboration = run.warnings.find((w) => w.tag === '[coinpaprika-partial-evidence-audit]')!.payload as { rows: Array<{ txHash: string; side: string; outcome: string; deviationPct: number | null }> }
    const byTx = new Map(corroboration.rows.map((r) => [`${r.txHash}:${r.side}`, r]))
    assert.equal(byTx.get('0xclawsell7:exit')?.outcome, 'deviation_exceeds_tolerance')
    assert.equal(byTx.get('0xclawbuy6:entry')?.outcome, 'plain_transfer_not_a_trade')
    assert.equal(byTx.get('0xclawbuy8:entry')?.outcome, 'corroborated_applied')
    assert.ok((byTx.get('0xclawbuy8:entry')?.deviationPct ?? 100) <= 5)
    // No uncorroborated daily sample ever completes a lot: lots 7–9 still lack a verified exit.
    for (const tx of ['0xclawsell6', '0xclawsell7', '0xclawsell8', '0xclawsell9']) assert.ok(!run.verifiedClawLotTxs.has(tx), tx)
  })
})

describe('classifyReceiptQuoteEvidence — fail-closed rules', () => {
  const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`
  const WETH = '0x4200000000000000000000000000000000000006'
  const POOL = `0x${'5'.repeat(40)}`
  const ROUTER = `0x${'7'.repeat(40)}`
  const raw = BigInt(10) ** BigInt(21)
  const base = { chain: 'base' as const, walletAddress: WALLET, targetToken: CLAW, side: 'exit' as const, targetAmount: 1000, targetDecimals: 18 }
  const sellLogs = (wethRaw: bigint, routerReceivedRaw = wethRaw) => [
    { address: CLAW, topics: [TRANSFER_TOPIC0, topic(WALLET), topic(POOL)], data: word(raw) },
    { address: POOL, topics: [Object.keys(SWAP_TOPIC0S)[0]], data: '0x' },
    { address: WETH, topics: [TRANSFER_TOPIC0, topic(POOL), topic(ROUTER)], data: word(routerReceivedRaw) },
    { address: WETH, topics: [WETH_WITHDRAWAL_TOPIC0, topic(ROUTER)], data: word(wethRaw) },
  ]
  const tx = (logs: ReceiptQuoteTx extends infer T ? T extends { logs: infer L } ? L : never : never, from = WALLET, valueWei = '0'): ReceiptQuoteTx => ({ status: 'ok', from, to: ROUTER, valueWei, input: '0x', logs })
  const ONE_ETH = BigInt(10) ** BigInt(18)

  it('router unwrap backed by swap output is recovered', () => {
    const r = classifyReceiptQuoteEvidence({ ...base, tx: tx(sellLogs(ONE_ETH)) })
    assert.equal(r.classification, 'native_eth_received_via_router_unwrap')
    assert.equal(r.quote?.quantity, 1)
  })
  it('unwrap of WETH that never arrived in this tx is rejected', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...base, tx: tx(sellLogs(ONE_ETH, ONE_ETH / BigInt(2))) }).classification, 'unwrap_not_backed_by_swap_output')
  })
  it('a transaction the wallet did not send is rejected', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...base, tx: tx(sellLogs(ONE_ETH), POOL) }).classification, 'transaction_not_sent_by_wallet')
  })
  it('native value spent on an exit is unaccounted', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...base, tx: tx(sellLogs(ONE_ETH), WALLET, '5') }).classification, 'native_spend_on_exit_unaccounted')
  })
  it('liquidity events are never priced as a swap', () => {
    const logs = [...sellLogs(ONE_ETH), { address: POOL, topics: [[...LIQUIDITY_TOPIC0S][1]], data: '0x' }]
    assert.equal(classifyReceiptQuoteEvidence({ ...base, tx: tx(logs) }).classification, 'liquidity_or_staking_activity')
  })
  it('a target amount the receipt does not reproduce is rejected', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...base, targetAmount: 999, tx: tx(sellLogs(ONE_ETH)) }).classification, 'target_leg_not_reproduced_by_receipt')
  })
  it('no swap event means no execution price', () => {
    const logs = sellLogs(ONE_ETH).filter((l) => !SWAP_TOPIC0S[l.topics[0]])
    assert.equal(classifyReceiptQuoteEvidence({ ...base, tx: tx(logs) }).classification, 'non_swap_contract_interaction')
  })
  it('an unavailable receipt fails closed', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...base, tx: { status: 'unavailable' } }).classification, 'receipt_unavailable')
  })
})
