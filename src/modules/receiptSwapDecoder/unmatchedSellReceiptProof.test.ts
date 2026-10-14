// Targeted receipt proof for unmatched sells when canonical promotion is off: only missing txHashes,
// Base only, capped, and only proofs the decoder actually establishes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillUnmatchedSellReceiptProofs, MAX_UNMATCHED_SELL_RECEIPT_FETCHES } from './unmatchedSellReceiptProof'
import type { ReceiptFetcher } from './receiptAcquisition'
import type { PoolValidator } from './poolValidator'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = (addr: string) => `0x${addr.replace(/^0x/, '').padStart(64, '0')}`
const transferLog = { logIndex: 0, address: '0x' + 'aa'.repeat(20), topics: [TRANSFER_TOPIC, pad(WALLET), pad('0x' + 'bb'.repeat(20))], data: pad('0x1') }
const validator = {} as PoolValidator
let n = 0
const uniqueTx = () => `0x${(Date.now() * 1000 + (n += 1)).toString(16).padStart(64, 'f')}`

test('fills only missing Base txHashes; a plain-transfer receipt becomes plain_transfer_no_swap_event', async () => {
  const plain = uniqueTx(), known = uniqueTx(), empty = uniqueTx(), ethTx = uniqueTx()
  const calls: string[] = []
  const fetchReceipt: ReceiptFetcher = async (_c, tx) => { calls.push(tx); return tx === plain ? { status: 'ok', logs: [transferLog] } : { status: 'ok', logs: [] } }
  const proofs = new Map([[known, 'exact_swap']])
  const audit = await fillUnmatchedSellReceiptProofs({
    sells: [{ chain: 'base', txHash: plain }, { chain: 'base', txHash: known }, { chain: 'base', txHash: empty }, { chain: 'eth', txHash: ethTx }, { chain: 'base', txHash: plain.toUpperCase().replace('0X', '0x') }],
    walletAddress: WALLET, receiptProofByTxHash: proofs, fetchReceipt, validator,
  })
  assert.deepEqual(calls.sort(), [plain, empty].sort(), 'never re-fetches a known proof, a duplicate, or a non-Base tx')
  assert.equal(proofs.get(plain), 'plain_transfer_no_swap_event')
  assert.equal(proofs.get(known), 'exact_swap', 'existing proof untouched')
  assert.equal(proofs.has(empty), false, 'no logs proves nothing')
  assert.deepEqual(audit.proofsAdded, { plain_transfer_no_swap_event: 1 })
})

test('capped at 20 and a hung or failing receipt adds nothing', async () => {
  const sells = Array.from({ length: 25 }, () => ({ chain: 'base', txHash: uniqueTx() }))
  let calls = 0
  const fetchReceipt: ReceiptFetcher = async (_c, tx) => {
    calls += 1
    if (tx === sells[0]!.txHash) return new Promise(() => {})
    if (tx === sells[1]!.txHash) throw new Error('rpc down')
    return { status: 'timeout' }
  }
  const proofs = new Map<string, string>()
  const audit = await fillUnmatchedSellReceiptProofs({ sells, walletAddress: WALLET, receiptProofByTxHash: proofs, fetchReceipt, validator, timeoutMs: 20 })
  assert.equal(calls, MAX_UNMATCHED_SELL_RECEIPT_FETCHES)
  assert.deepEqual([audit.attempted, audit.skippedByCap, proofs.size], [20, 5, 0])
})
