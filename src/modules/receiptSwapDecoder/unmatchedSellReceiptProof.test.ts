// Targeted receipt proof for unmatched sells when canonical promotion is off: only missing txHashes,
// Base only, capped, and only proofs the decoder actually establishes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fillUnmatchedSellReceiptProofs, classifyNoSwapReceipt, MAX_UNMATCHED_SELL_RECEIPT_FETCHES } from './unmatchedSellReceiptProof'
import type { ReceiptFetcher } from './receiptAcquisition'
import type { PoolValidator } from './poolValidator'

const WALLET = '0x4dbb3835744b2976560e0259cb218cab89abef96'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = (addr: string) => `0x${addr.replace(/^0x/, '').padStart(64, '0')}`
const transferLog = { logIndex: 0, address: '0x' + 'aa'.repeat(20), topics: [TRANSFER_TOPIC, pad(WALLET), pad('0x' + 'bb'.repeat(20))], data: pad('0x1') }
const validator = {} as PoolValidator
let n = 0
const uniqueTx = () => `0x${(Date.now() * 1000 + (n += 1)).toString(16).padStart(64, 'f')}`

test('fills only missing Base txHashes; a single wallet→other Transfer receipt becomes one_way_transfer_only', async () => {
  const plain = uniqueTx(), known = uniqueTx(), empty = uniqueTx(), ethTx = uniqueTx()
  const calls: string[] = []
  const fetchReceipt: ReceiptFetcher = async (_c, tx) => { calls.push(tx); return tx === plain ? { status: 'ok', logs: [transferLog] } : { status: 'ok', logs: [] } }
  const proofs = new Map([[known, 'exact_swap']])
  const audit = await fillUnmatchedSellReceiptProofs({
    sells: [{ chain: 'base', txHash: plain }, { chain: 'base', txHash: known }, { chain: 'base', txHash: empty }, { chain: 'eth', txHash: ethTx }, { chain: 'base', txHash: plain.toUpperCase().replace('0X', '0x') }],
    walletAddress: WALLET, receiptProofByTxHash: proofs, fetchReceipt, validator,
  })
  assert.deepEqual(calls.sort(), [plain, empty].sort(), 'never re-fetches a known proof, a duplicate, or a non-Base tx')
  assert.equal(proofs.get(plain), 'one_way_transfer_only')
  assert.equal(proofs.get(known), 'exact_swap', 'existing proof untouched')
  assert.equal(proofs.has(empty), false, 'no logs proves nothing')
  assert.deepEqual(audit.proofsAdded, { one_way_transfer_only: 1 })
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

// Uniswap V4 PoolManager Swap topic — not one the decoder recognises.
const V4_SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
const POOL_MANAGER = '0x' + '99'.repeat(20)

test('no recognised Swap event is not proof of a plain transfer: V4-shaped and wallet-credited receipts are transfer_with_unrecognised_events', async () => {
  const v4 = uniqueTx(), credited = uniqueTx(), oneWay = uniqueTx()
  const logsByTx: Record<string, unknown[]> = {
    // Wallet sends the token to the PoolManager, which emits a V4 Swap and pays nothing back in logs (native ETH payout).
    [v4]: [
      { logIndex: 0, address: '0x' + 'aa'.repeat(20), topics: [TRANSFER_TOPIC, pad(WALLET), pad(POOL_MANAGER)], data: pad('0x4c4b40') },
      { logIndex: 1, address: POOL_MANAGER, topics: [V4_SWAP_TOPIC, pad('0x' + '12'.repeat(32)), pad('0x' + '77'.repeat(20))], data: '0x' + '00'.repeat(192) },
    ],
    // Transfers only, but the wallet receives a token back (an RFQ-style fill).
    [credited]: [
      { logIndex: 0, address: '0x' + 'aa'.repeat(20), topics: [TRANSFER_TOPIC, pad(WALLET), pad('0x' + 'cc'.repeat(20))], data: pad('0x4c4b40') },
      { logIndex: 1, address: '0x4200000000000000000000000000000000000006', topics: [TRANSFER_TOPIC, pad('0x' + 'cc'.repeat(20)), pad(WALLET)], data: pad('0x1') },
    ],
    [oneWay]: [transferLog],
  }
  const fetchReceipt: ReceiptFetcher = async (_c, tx) => ({ status: 'ok', logs: logsByTx[tx] as never })
  const proofs = new Map<string, string>()
  await fillUnmatchedSellReceiptProofs({
    sells: [v4, credited, oneWay].map((txHash) => ({ chain: 'base', txHash })),
    walletAddress: WALLET, receiptProofByTxHash: proofs, fetchReceipt, validator,
  })
  assert.equal(proofs.get(v4), 'transfer_with_unrecognised_events')
  assert.equal(proofs.get(credited), 'transfer_with_unrecognised_events')
  assert.equal(proofs.get(oneWay), 'one_way_transfer_only')
})

test('classifyNoSwapReceipt: every log must be a 3-topic ERC-20 Transfer sent by the wallet, crediting it nothing', () => {
  const out = (to: string) => ({ logIndex: 0, address: '0x' + 'aa'.repeat(20), topics: [TRANSFER_TOPIC, pad(WALLET), pad(to)], data: pad('0x1') })
  assert.equal(classifyNoSwapReceipt([out('0x' + 'bb'.repeat(20))], WALLET.toUpperCase().replace('0X', '0x')), 'one_way_transfer_only')
  assert.equal(classifyNoSwapReceipt([out(WALLET)], WALLET), 'transfer_with_unrecognised_events', 'self-transfer credits the wallet')
  const erc721 = { ...out('0x' + 'bb'.repeat(20)), topics: [TRANSFER_TOPIC, pad(WALLET), pad('0x' + 'bb'.repeat(20)), pad('0x5')] }
  assert.equal(classifyNoSwapReceipt([erc721], WALLET), 'transfer_with_unrecognised_events', 'ERC-721 Transfer is not an ERC-20 transfer')
  const notFromWallet = { ...out('0x' + 'bb'.repeat(20)), topics: [TRANSFER_TOPIC, pad('0x' + 'dd'.repeat(20)), pad('0x' + 'bb'.repeat(20))] }
  assert.equal(classifyNoSwapReceipt([notFromWallet], WALLET), 'transfer_with_unrecognised_events', 'the wallet must be a sender')
  assert.equal(classifyNoSwapReceipt([], WALLET), 'transfer_with_unrecognised_events')
})
