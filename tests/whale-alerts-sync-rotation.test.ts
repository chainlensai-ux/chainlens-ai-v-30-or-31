// Whale Alerts round 2: stalest-first rotation, contract/infra wallet skip, BUY/SELL/EXIT
// classification, severity from real USD, post-grouping filters, honest one-liners.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectWalletBatch } from '../lib/server/whaleWalletOrder'
import { __resetWalletKindCacheForTest, classifyCode, classifyWallets, KNOWN_INFRA_ADDRESSES } from '../lib/server/whaleWalletKind'
import { classifyTrade, matchesTradeFilters, severityFromPricedUsd } from '../lib/server/whaleTradeClassify'
import { __resetExitCacheForTest, balanceOfCalldata, checkZeroBalances } from '../lib/server/whaleExitCheck'
import { describeWhaleAction, whaleRowReason } from '../lib/whaleAlertAction'

const w = (id: string, last: string | null) => ({ address: id, last_scanned_at: last })

// ── Rotation ─────────────────────────────────────────────────────────────────
test('stalest-first: never-scanned wallets, then oldest scans; ties keep table order', () => {
  const wallets = [w('a', '2026-10-14T10:00:00Z'), w('b', null), w('c', '2026-10-13T00:00:00Z'), w('d', null), w('e', '2026-10-15T00:00:00Z')]
  assert.deepEqual(selectWalletBatch(wallets, { offset: 0, limit: 3, stalestFirst: true }).map(x => x.address), ['b', 'd', 'c'])
})

test('repeated batches rotate through ALL 152 wallets with no rescans (stamping each batch)', () => {
  let wallets = Array.from({ length: 152 }, (_, i) => w(`w${i}`, null))
  const seen = new Set<string>()
  let clock = Date.parse('2026-10-15T00:00:00Z')
  for (let batch = 0; batch < 16; batch += 1) {
    const picked = selectWalletBatch(wallets, { offset: batch * 10, limit: 10, stalestFirst: true })
    for (const p of picked) { assert.ok(!seen.has(p.address), `rescanned ${p.address}`); seen.add(p.address) }
    clock += 60_000
    const stamped = new Set(picked.map(p => p.address))
    wallets = wallets.map(x => stamped.has(x.address) ? { ...x, last_scanned_at: new Date(clock).toISOString() } : x)
  }
  assert.equal(seen.size, 152)
})

test('a wallet that failed (not stamped) is first in the next batch', () => {
  const wallets = [w('ok1', '2026-10-15T00:01:00Z'), w('failed', '2026-10-01T00:00:00Z'), w('ok2', '2026-10-15T00:01:00Z')]
  assert.equal(selectWalletBatch(wallets, { offset: 0, limit: 1, stalestFirst: true })[0]!.address, 'failed')
})

test('without last_scanned_at the previous offset slicing is used unchanged', () => {
  const wallets = ['a', 'b', 'c', 'd'].map(id => w(id, null))
  assert.deepEqual(selectWalletBatch(wallets, { offset: 2, limit: 10, stalestFirst: false }).map(x => x.address), ['c', 'd'])
})

// ── Contract / infra wallets ─────────────────────────────────────────────────
test('eth_getCode: empty code and EIP-7702 delegation are people; bytecode is a contract; junk is unknown', () => {
  assert.equal(classifyCode('0x'), 'eoa')
  assert.equal(classifyCode('0xef0100' + '11'.repeat(20)), 'eoa')
  assert.equal(classifyCode('0x6080604052'), 'contract')
  assert.equal(classifyCode(undefined), 'unknown')
})

test('classifyWallets: infra from the known list without RPC, contracts by code, RPC failure = scan anyway', async () => {
  __resetWalletKindCacheForTest()
  const router = [...KNOWN_INFRA_ADDRESSES.keys()].find(a => a.startsWith('0x1111111111166b'))!
  const eoa = '0x' + 'a'.repeat(40), contract = '0x' + 'b'.repeat(40)
  let calls = 0
  const fakeFetch = async (_url: string, init: RequestInit) => {
    calls += 1
    const body = JSON.parse(String(init.body)) as Array<{ id: number; params: [string] }>
    return new Response(JSON.stringify(body.map(r => ({ id: r.id, result: r.params[0] === contract ? '0x6080' : '0x' }))))
  }
  const kinds = await classifyWallets([router, eoa, contract], fakeFetch)
  assert.deepEqual([kinds.get(router), kinds.get(eoa), kinds.get(contract), calls], ['infra', 'eoa', 'contract', 1])
  await classifyWallets([eoa, contract], fakeFetch)
  assert.equal(calls, 1, 'cached for a day')
  __resetWalletKindCacheForTest()
  const failed = await classifyWallets([eoa], async () => { throw new Error('rpc down') })
  assert.equal(failed.get(eoa), 'unknown')
})

// ── Classification ───────────────────────────────────────────────────────────
const leg = (side: 'buy' | 'sell', sym: string, addr = '0x' + sym.toLowerCase().padEnd(40, '0').slice(0, 40)) => ({ side, token_symbol: sym, token_address: addr })

test('BUY = paid base asset for a token; SELL = sent a token for base assets; SWAP = token→token', () => {
  assert.equal(classifyTrade([leg('sell', 'USDC'), leg('buy', 'AERO')]).kind, 'buy')
  assert.equal(classifyTrade([leg('sell', 'ETH'), leg('buy', 'DEGEN')]).token?.token_symbol, 'DEGEN')
  assert.equal(classifyTrade([leg('sell', 'AERO'), leg('buy', 'WETH')]).kind, 'sell')
  assert.equal(classifyTrade([leg('sell', 'AERO'), leg('buy', 'DEGEN')]).kind, 'swap')
  assert.equal(classifyTrade([leg('sell', 'USDC'), leg('buy', 'WETH')]).kind, 'swap', 'base→base is not a buy')
})

test('one-direction rows are transfers (IN/OUT), never BUY/SELL', () => {
  assert.equal(classifyTrade([leg('buy', 'AERO')]).kind, 'in')
  assert.equal(classifyTrade([leg('sell', 'AERO')]).kind, 'out')
  assert.equal(classifyTrade([leg('buy', 'USDC'), leg('buy', 'AERO')]).kind, 'in')
})

test('EXIT needs proof: balanceOf now returns exactly 0; non-zero or failed lookup stays SELL', async () => {
  __resetExitCacheForTest()
  const wallet = '0x' + '1'.repeat(40), sold = '0x' + '2'.repeat(40), kept = '0x' + '3'.repeat(40)
  assert.equal(balanceOfCalldata(wallet), '0x70a08231' + '0'.repeat(24) + '1'.repeat(40))
  const fakeFetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Array<{ id: number; params: [{ to: string }] }>
    return new Response(JSON.stringify(body.map(r => ({ id: r.id, result: r.params[0].to === sold ? '0x' + '0'.repeat(64) : '0x0de0b6b3a7640000' }))))
  }
  const zero = await checkZeroBalances([{ wallet, token: sold }, { wallet, token: kept }], fakeFetch)
  assert.deepEqual([zero.get(`${wallet}:${sold}`), zero.get(`${wallet}:${kept}`)], [true, false])
  __resetExitCacheForTest()
  const failed = await checkZeroBalances([{ wallet, token: sold }], async () => { throw new Error('down') })
  assert.equal(failed.has(`${wallet}:${sold}`), false)
})

test('severity comes only from a real priced USD value', () => {
  assert.deepEqual([25_000, 10_000, 5_000, 1_000, 999, 0, -1, null, Number.NaN].map(severityFromPricedUsd),
    ['major', 'large', 'medium', 'small', null, null, null, null, null])
})

test('filters apply to the classified row (type = action, side = exposure, severity)', () => {
  const buy = { trade_kind: 'buy' as const, severity: 'large' }
  const exit = { trade_kind: 'exit' as const, severity: null }
  const received = { trade_kind: 'in' as const, severity: 'small' }
  assert.equal(matchesTradeFilters(buy, { type: 'buy' }), true)
  assert.equal(matchesTradeFilters(exit, { type: 'buy' }), false)
  assert.equal(matchesTradeFilters(exit, { side: 'sell' }), true)
  assert.equal(matchesTradeFilters(received, { side: 'buy' }), true)
  assert.equal(matchesTradeFilters(buy, { severity: 'major' }), false)
  assert.equal(matchesTradeFilters(buy, { type: 'token_transfer' }), true, 'legacy type value ignored')
})

// ── Wording ──────────────────────────────────────────────────────────────────
test('row wording follows the classification and the one-liner is never empty or invented', () => {
  assert.deepEqual(describeWhaleAction({ trade_kind: 'buy' }), { kind: 'buy', verb: 'bought', chip: 'BUY' })
  assert.equal(describeWhaleAction({ trade_kind: 'exit' }).chip, 'EXIT')
  assert.equal(whaleRowReason({ trade_kind: 'exit', trade_token_symbol: 'AERO' }), 'Sold AERO — wallet now holds none')
  assert.equal(whaleRowReason({ trade_kind: 'in', token_symbol: 'DEGEN', repeats: 3 }), 'Received DEGEN · 3× within 5 min')
  assert.equal(whaleRowReason({ side: 'sell', token_symbol: 'WIRE' }), 'Sent WIRE')
  assert.equal(whaleRowReason({}), 'Moved token')
  assert.equal(whaleRowReason({ token_risk_label: 'Likely spam airdrop token — no USD value', trade_kind: 'in' }), 'Likely spam airdrop token — no USD value')
  for (const r of [{ trade_kind: 'buy' }, { trade_kind: 'swap', token_symbol: 'A / B' }, {}]) assert.ok(whaleRowReason(r).length > 0)
})
