// Production follow-up after 625f4761: target the 9 blocked 1clawAI closed lots.
// Run directly with:
//   npx tsx --test src/pipeline/priceLotsForWallet.blockedLots.test.ts

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runBlockedLotFixture, CLAW, WALLET, ETH_USD_SELL_DAY } from './priceLotsForWallet.blockedLots.fixture.ts'
import { classifyReceiptQuoteEvidence, internalTransfersFromBlockscout, internalTransfersFromCallTrace, TRANSFER_TOPIC0, WETH_DEPOSIT_TOPIC0, WETH_WITHDRAWAL_TOPIC0, SWAP_TOPIC0S, LIQUIDITY_TOPIC0S, type ReceiptQuoteTx } from '../lib/receiptQuoteRecovery.ts'
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

  it('receipts alone never verify an unwrap payout: 4/13, every sell is native_unwrap_recipient_unverified', async () => {
    const run = await runBlockedLotFixture({ receiptLane: true, sellTraces: 'unavailable' })
    assert.equal(run.verifiedLots, 4)
    const a = run.lookups.receiptQuoteRecoveryAudit
    assert.equal(a.classificationCounts.native_unwrap_recipient_unverified, 6)
    assert.equal(a.classificationCounts.native_eth_received_via_router_unwrap_verified, undefined)
    assert.deepEqual(a.lotsCompletedByClass, { completion_ready: 0, missing_both: 0 })
    for (const tx of ['0xclawsell1', '0xclawsell2', '0xclawsell3']) assert.ok(!run.verifiedClawLotTxs.has(tx), tx)
  })

  it('with trace-proven wallet payouts: 5 more lots (9/13); the other 4 stay unavailable with exact reasons', async () => {
    const run = await runBlockedLotFixture({ receiptLane: true, sellTraces: 'proven_to_wallet' })
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
      native_eth_received_via_router_unwrap_verified: 6,
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
    assert.equal(sell1.forensics?.traceSource, 'debug_trace_call_tracer')
    assert.equal(sell1.forensics?.pathAttribution, 'single_target_path')
    assert.deepEqual(sell1.historicalMarketAttempts.every((r) => r === 'none'), true)
    for (const tx of ['0xclawsell1', '0xclawsell2', '0xclawsell3', '0xclawsell4', '0xclawsell5']) assert.ok(run.verifiedClawLotTxs.has(tx), tx)
    for (const tx of ['0xclawsell6', '0xclawsell7', '0xclawsell8', '0xclawsell9']) assert.ok(!run.verifiedClawLotTxs.has(tx), tx)
  })

  it('completion-ready sides are spent first: a 3-tx budget completes exactly the 3 single-side lots', async () => {
    const run = await runBlockedLotFixture({ receiptLane: true, maxTxs: 3, sellTraces: 'proven_to_wallet' })
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
    const run = await runBlockedLotFixture({ receiptLane: true, coinPaprikaFetchImpl: paprika, sellTraces: 'proven_to_wallet' })
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
  const POOL2 = `0x${'3'.repeat(40)}`
  const ROUTER = `0x${'7'.repeat(40)}`
  const OUTSIDER = `0x${'2'.repeat(40)}`
  const FEE = `0x${'8'.repeat(40)}`
  const OTHER = `0x${'4'.repeat(40)}`
  const SWAP = Object.keys(SWAP_TOPIC0S)[0]
  const raw = BigInt(10) ** BigInt(21)
  const ONE_ETH = BigInt(10) ** BigInt(18)
  const exitBase = { chain: 'base' as const, walletAddress: WALLET, targetToken: CLAW, side: 'exit' as const, targetAmount: 1000, targetDecimals: 18 }
  const entryBase = { ...exitBase, side: 'entry' as const }
  const transfer = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [TRANSFER_TOPIC0, topic(from), topic(to)], data: word(v) })
  const swapLog = (pool: string) => ({ address: pool, topics: [SWAP], data: '0x' })
  const sellLogs = (wethRaw: bigint, routerReceivedRaw = wethRaw) => [
    transfer(CLAW, WALLET, POOL, raw),
    swapLog(POOL),
    transfer(WETH, POOL, ROUTER, routerReceivedRaw),
    { address: WETH, topics: [WETH_WITHDRAWAL_TOPIC0, topic(ROUTER)], data: word(wethRaw) },
  ]
  type Logs = Extract<ReceiptQuoteTx, { status: 'ok' }>['logs']
  type Internal = Extract<ReceiptQuoteTx, { status: 'ok' }>['internalTransfers']
  const tx = (logs: Logs, opts: { from?: string; valueWei?: string; internal?: Internal } = {}): ReceiptQuoteTx => ({
    status: 'ok', from: opts.from ?? WALLET, to: ROUTER, valueWei: opts.valueWei ?? '0', input: '0x', logs,
    internalTransfers: opts.internal === undefined ? null : opts.internal,
  })
  const payout = (to: string, v: bigint) => ({ from: ROUTER, to, valueWei: v.toString() })

  it('WETH unwrap -> ETH internally sent to the scanned wallet -> accepted', () => {
    const r = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { internal: [{ from: WETH, to: ROUTER, valueWei: ONE_ETH.toString() }, payout(WALLET, ONE_ETH)] }) })
    assert.equal(r.classification, 'native_eth_received_via_router_unwrap_verified')
    assert.equal(r.quote?.quantity, 1)
    assert.equal(r.forensics?.walletNativeReceivedWei, ONE_ETH.toString())
  })
  it('WETH unwrap -> ETH sent to another address -> rejected', () => {
    const r = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { internal: [payout(OUTSIDER, ONE_ETH)] }) })
    assert.equal(r.classification, 'native_unwrap_recipient_not_wallet')
    assert.equal(r.quote, null)
  })
  it('WETH unwrap with no trace evidence -> rejected', () => {
    const r = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH)) })
    assert.equal(r.classification, 'native_unwrap_recipient_unverified')
    assert.equal(r.quote, null)
  })
  it('split native payout: accepted only when every unwrapped wei is accounted for; the wallet gets its own share', () => {
    const fee = ONE_ETH / BigInt(100)
    const exact = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { internal: [payout(WALLET, ONE_ETH - fee), payout(FEE, fee)] }) })
    assert.equal(exact.classification, 'native_eth_received_via_router_unwrap_verified')
    assert.equal(exact.quote?.quantity, 0.99, 'net proceeds the wallet actually received, never the gross unwrap')
    const unaccounted = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { internal: [payout(WALLET, ONE_ETH - fee)] }) })
    assert.equal(unaccounted.classification, 'native_payout_attribution_ambiguous')
    const otherSource = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { internal: [payout(WALLET, ONE_ETH), { from: OUTSIDER, to: WALLET, valueWei: '5' }] }) })
    assert.equal(otherSource.classification, 'native_payout_attribution_ambiguous')
  })
  it('target sell + an unrelated unwrap path in the same tx -> rejected', () => {
    const logs = [
      ...sellLogs(ONE_ETH * BigInt(2), ONE_ETH),
      transfer(OTHER, OUTSIDER, POOL2, BigInt(7)),
      swapLog(POOL2),
      transfer(WETH, POOL2, ROUTER, ONE_ETH),
    ]
    const r = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(logs, { internal: [payout(WALLET, ONE_ETH * BigInt(2))] }) })
    assert.equal(r.classification, 'unrelated_swap_path_in_tx')
    assert.deepEqual(r.forensics?.distinctPoolEmitters, [POOL2, POOL].sort())
  })
  const buyLogs = (wrapped: bigint) => [
    { address: WETH, topics: [WETH_DEPOSIT_TOPIC0, topic(ROUTER)], data: word(wrapped) },
    transfer(WETH, ROUTER, POOL, wrapped),
    swapLog(POOL),
    transfer(CLAW, POOL, WALLET, raw),
  ]
  it('single exact tx.value -> target swap -> accepted', () => {
    const r = classifyReceiptQuoteEvidence({ ...entryBase, tx: tx(buyLogs(ONE_ETH), { valueWei: ONE_ETH.toString() }) })
    assert.equal(r.classification, 'native_eth_paid_via_tx_value')
    assert.equal(r.forensics?.pathAttribution, 'single_target_path')
    assert.equal(r.quote?.quantity, 1)
  })
  it('tx.value funds two swap paths -> rejected', () => {
    const half = ONE_ETH / BigInt(2)
    const logs = [
      { address: WETH, topics: [WETH_DEPOSIT_TOPIC0, topic(ROUTER)], data: word(ONE_ETH) },
      transfer(WETH, ROUTER, POOL, half), swapLog(POOL), transfer(CLAW, POOL, WALLET, raw),
      transfer(WETH, ROUTER, POOL2, half), swapLog(POOL2), transfer(OTHER, POOL2, ROUTER, BigInt(9)),
    ]
    const r = classifyReceiptQuoteEvidence({ ...entryBase, tx: tx(logs, { valueWei: ONE_ETH.toString() }) })
    assert.equal(r.classification, 'unrelated_outputs_in_tx')
    assert.deepEqual(r.forensics?.unrelatedOutputs, [{ address: ROUTER, token: OTHER, netRaw: '9' }])
  })
  it('a token entering the path from an outside address is rejected', () => {
    const logs = [...buyLogs(ONE_ETH), transfer(WETH, OUTSIDER, ROUTER, BigInt(3)), transfer(WETH, ROUTER, POOL, BigInt(3))]
    assert.equal(classifyReceiptQuoteEvidence({ ...entryBase, tx: tx(logs, { valueWei: ONE_ETH.toString() }) }).classification, 'unrelated_token_flow_in_tx')
  })
  it('unwrap of WETH that never arrived in this tx is rejected (the router would end net-negative on WETH)', () => {
    const r = classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH, ONE_ETH / BigInt(2)), { internal: [payout(WALLET, ONE_ETH)] }) })
    assert.equal(r.classification, 'unrelated_outputs_in_tx')
    assert.equal(r.quote, null)
  })
  it('a transaction the wallet did not send is rejected', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { from: POOL }) }).classification, 'transaction_not_sent_by_wallet')
  })
  it('native value spent on an exit is unaccounted', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(sellLogs(ONE_ETH), { valueWei: '5' }) }).classification, 'native_spend_on_exit_unaccounted')
  })
  it('liquidity events are never priced as a swap', () => {
    const logs = [...sellLogs(ONE_ETH), { address: POOL, topics: [[...LIQUIDITY_TOPIC0S][1]], data: '0x' }]
    assert.equal(classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(logs) }).classification, 'liquidity_or_staking_activity')
  })
  it('a target amount the receipt does not reproduce is rejected', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...exitBase, targetAmount: 999, tx: tx(sellLogs(ONE_ETH)) }).classification, 'target_leg_not_reproduced_by_receipt')
  })
  it('no swap event means no execution price', () => {
    const logs = sellLogs(ONE_ETH).filter((l) => !SWAP_TOPIC0S[l.topics[0]])
    assert.equal(classifyReceiptQuoteEvidence({ ...exitBase, tx: tx(logs) }).classification, 'non_swap_contract_interaction')
  })
  it('an unavailable receipt fails closed', () => {
    assert.equal(classifyReceiptQuoteEvidence({ ...exitBase, tx: { status: 'unavailable' } }).classification, 'receipt_unavailable')
  })
})

describe('internal-transfer trace parsing', () => {
  it('callTracer: nested executed value calls only; the top-level tx.value and reverted frames are excluded', () => {
    const transfers = internalTransfersFromCallTrace({
      type: 'CALL', from: WALLET, to: '0xr', value: '0x5',
      calls: [
        { type: 'CALL', from: '0xweth', to: '0xr', value: '0xde0b6b3a7640000' },
        { type: 'CALL', from: '0xr', to: WALLET, value: '0xde0b6b3a7640000' },
        { type: 'CALL', from: '0xr', to: '0xx', value: '0x1', error: 'execution reverted', calls: [{ type: 'CALL', from: '0xx', to: '0xy', value: '0x1' }] },
        { type: 'DELEGATECALL', from: '0xr', to: '0xlib', value: '0x1' },
      ],
    })
    assert.deepEqual(transfers, [
      { from: '0xweth', to: '0xr', valueWei: '1000000000000000000' },
      { from: '0xr', to: WALLET, valueWei: '1000000000000000000' },
    ])
  })
  it('Blockscout: paginated (incomplete) evidence is no evidence; failed internal txs are skipped', () => {
    assert.equal(internalTransfersFromBlockscout({ items: [], next_page_params: { index: 50 } }), null)
    assert.deepEqual(internalTransfersFromBlockscout({
      items: [
        { from: { hash: '0xR' }, to: { hash: WALLET }, value: '7', success: true, type: 'call' },
        { from: { hash: '0xR' }, to: { hash: '0xother' }, value: '9', success: false, type: 'call' },
      ],
      next_page_params: null,
    }), [{ from: '0xr', to: WALLET, valueWei: '7' }])
  })
})
